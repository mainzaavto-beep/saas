"""
orchestrator.py — SaaS-воркер: читает активные кабинеты из PG, выставляет env
(токен + cabinet_id), запускает сборщики per-cabinet per-shop.

Принцип (из разведки #241/#242): WB_TOKEN читается сборщиками на верхнем уровне
модуля при import → один Python-процесс = один tenant. Поэтому воркер для
каждого кабинета запускает ОТДЕЛЬНЫЙ subprocess с правильно выставленным env.

Три режима:
  daily        — все активные кабинеты, сборщики «за вчера/сегодня» (--all)
  onetime      — один конкретный кабинет (cabinet_id=N), для initial resync / теста
                 (передаётся --cabinet N [--collectors wb_catalog,wb_orders,...])
  drain-queue  — прогон onboarding-jobs из jobs.collect_jobs (backfill за 75 дней):
                 берёт queued job → running → гоняет сборщики → done/failed.
                 Вызывается таймером saas-backfill 4×/день.

Креды читаются из auth.shops (per-МП, per-юрлицо) — туда их кладёт онбординг.
Fallback (обратная совместимость): если у кабинета нет shops, но есть
api_creds_enc на самом кабинете (напр. cabinet_id=1 из _init_owner.py) —
используются они.

Env (читает из Machine/.env): SAAS_DB_* для подключения к PG как postgres
(superuser) — чтобы читать auth.shops.api_creds_enc (auth.* без RLS). Сами
сборщики под saas_app.

Координация: боевые Планировщик/сборщики НЕ трогаются. Это отдельный SaaS-воркер.
"""
import os
import sys
import json
import time
import argparse
import subprocess
import psycopg
from psycopg.rows import dict_row

# Воркер подключается как postgres (читает api_creds — auth.* без RLS).
# Сборщики внутри subprocess подключаются как saas_app (RLS изоляция).
PG_SUPER = {
    "host": os.environ.get("SAAS_DB_HOST", "localhost"),
    "port": os.environ.get("SAAS_DB_PORT", "5432"),
    "dbname": os.environ.get("SAAS_DB", "saas"),
    "user": "postgres",
    "password": os.environ.get("POSTGRES_PASSWORD", ""),
}

# Путь к Python интерпретатору.
PY = sys.executable

# Списки SaaS-сборщиков по маркетплейсу (модули в worker/collectors/). Порядок важен:
# catalog → orders → finance → order_costs + cabinet_costs (зависят от finance) → metrics → prices → stocks.
# ⚠️ Принцип SaaS: НИКАКИХ Google Sheets — все данные только в PostgreSQL.
WB_COLLECTORS = [
    "wb_catalog",
    "wb_orders",
    "wb_finance",
    "wb_order_costs",
    "wb_cabinet_costs",
    "wb_metrics",
    "wb_ads",
    "wb_prices",
    "wb_stocks",
    "wb_references",   # справочник складов + тарифы → shared.* (таймер saas-references, weekly)
]
OZON_COLLECTORS = [
    "ozon_catalog",
    "ozon_orders",
    "ozon_sales",
    "ozon_finance",
    "ozon_order_costs",
    "ozon_metrics",
    "ozon_stocks",
    "ozon_efficiency",
]

# Для --collectors (явный список, любой набор). По умолчанию — все WB (как раньше).
DEFAULT_COLLECTORS = WB_COLLECTORS

# Пауза между onboarding-jobs в drain-режиме (rate-limit для очереди клиентов).
DRAIN_PAUSE_SEC = 8


def _collectors_for_marketplaces(mps):
    """Выбрать сборщики по подключённым МП кабинета."""
    out = []
    if "wb" in mps:
        out += WB_COLLECTORS
    if "ozon" in mps:
        out += OZON_COLLECTORS
    return out


def _collectors_for_mp(mp, pool):
    """Фильтр списка сборщиков по mp_code конкретного магазина."""
    valid = set(WB_COLLECTORS) if mp == "wb" else (
        set(OZON_COLLECTORS) if mp == "ozon" else set())
    return [c for c in pool if c in valid]


def _group_cabinets(rows):
    """Сгруппировать плоские строки JOIN'а cabinets×shops в кабинеты со списком shops.
    Реализует fallback: нет shops, но есть cabinet-level creds → виртуальные shops
    по marketplaces (обратная совместимость с _init_owner.py / cabinet_id=1)."""
    cabs = {}
    for r in rows:
        cid = r["cabinet_id"]
        if cid not in cabs:
            cabs[cid] = {
                "cabinet_id": cid,
                "display_name": r["display_name"],
                "marketplaces": r["marketplaces"] or [],
                # cabinet-level creds (для legacy-кабинетов без shops).
                "api_creds": r.get("c_api_creds"),
                "api_creds_enc": r.get("c_api_creds_enc"),
                "shops": [],
            }
        if r.get("shop_id") is not None:
            cabs[cid]["shops"].append({
                "shop_id": r["shop_id"],
                "mp_code": r["mp_code"],
                "api_creds": r.get("s_api_creds"),
                "api_creds_enc": r.get("s_api_creds_enc"),
            })
    # Fallback для legacy-кабинетов (напр. cabinet_id=1 из _init_owner.py), где
    # креды лежат на самом кабинете, а не на shops. Два случая:
    #  (а) shops нет вообще → создаём виртуальные shops из marketplaces;
    #  (б) shops есть, но без своих кредов (мигрированы из cabinet_marketplaces) →
    #      каждый shop наследует кабинетные creds как fallback.
    for cab in cabs.values():
        has_cab_creds = bool(cab["api_creds_enc"] or cab["api_creds"])
        if not cab["shops"] and has_cab_creds:
            for mp in cab["marketplaces"]:
                cab["shops"].append({
                    "shop_id": None,
                    "mp_code": mp,
                    "api_creds": cab["api_creds"],
                    "api_creds_enc": cab["api_creds_enc"],
                    "_legacy": True,
                })
        elif has_cab_creds:
            for s in cab["shops"]:
                if not (s.get("api_creds_enc") or s.get("api_creds")):
                    s["api_creds"] = cab["api_creds"]
                    s["api_creds_enc"] = cab["api_creds_enc"]
                    s["_legacy"] = True
    return list(cabs.values())


def _read_cabinets(active_only=True):
    """Прочитать кабинеты с shops (креды per-МП). active_only=False → включая provisioning."""
    with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
        sql = (
            "SELECT c.cabinet_id, c.display_name, c.marketplaces, "
            "       c.api_creds AS c_api_creds, c.api_creds_enc AS c_api_creds_enc, "
            "       s.shop_id, s.mp_code, "
            "       s.api_creds AS s_api_creds, s.api_creds_enc AS s_api_creds_enc "
            "FROM auth.cabinets c "
            "LEFT JOIN auth.shops s ON s.cabinet_id = c.cabinet_id AND s.is_active = true "
            "WHERE c.status = ANY(%s) "
            "ORDER BY c.cabinet_id, s.shop_id"
        )
        statuses = ["active"] if active_only else ["active", "provisioning"]
        with conn.cursor() as cur:
            cur.execute(sql, (statuses,))
            rows = cur.fetchall()
        return _group_cabinets(rows)


def _read_one_cabinet(cabinet_id):
    """Один кабинет по id (для onetime/drain-режима, без фильтра по статусу)."""
    with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT c.cabinet_id, c.display_name, c.marketplaces, "
                "       c.api_creds AS c_api_creds, c.api_creds_enc AS c_api_creds_enc, "
                "       s.shop_id, s.mp_code, "
                "       s.api_creds AS s_api_creds, s.api_creds_enc AS s_api_creds_enc "
                "FROM auth.cabinets c "
                "LEFT JOIN auth.shops s ON s.cabinet_id = c.cabinet_id AND s.is_active = true "
                "WHERE c.cabinet_id = %s "
                "ORDER BY s.shop_id",
                (cabinet_id,))
            rows = cur.fetchall()
    cabs = _group_cabinets(rows)
    return cabs[0] if cabs else None


def _decrypt_creds(enc, raw):
    """Расшифровать api_creds_enc через pgcrypto; fallback на plaintext api_creds.
    Возвращает {mp_code: {...}} — структуру кредов одного shop'а или кабинета."""
    enc_key = os.environ.get("SAAS_CRED_MASTER_KEY", "")
    if enc and enc_key:
        with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT pgp_sym_decrypt(%s::bytea, %s) AS plain", (enc, enc_key))
                row = cur.fetchone()
        return json.loads(row["plain"]) if row and row["plain"] else {}
    if isinstance(raw, dict):
        return raw
    return json.loads(raw or "{}")


def _env_for_shop(shop):
    """Сформировать env-словарь для subprocess одного shop'а: токен + cabinet_id + DB creds.
    Расшифровывает api_creds_enc (или fallback plaintext) через pgcrypto.

    🔒 БЕЗОПАСНОСТЬ (фикс 2026-07-10): НЕ наследуем os.environ целиком! Боевые токены
    (WB_TOKEN, OZON_*) лежат в Machine env — если их унаследовать, чужой кабинет
    получит доступ к боевому кабинету продавца. Whitelist: только системные vars,
    нужные для работы Python/сети + ЯВНО расшифрованные creds этого shop + DB creds."""
    creds = _decrypt_creds(shop.get("api_creds_enc"), shop.get("api_creds"))

    # Whitelist системных переменных (без боевых токенов WB_TOKEN/OZON_*).
    SAFE_INHERIT = {"PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR",
                    "NUMBER_OF_PROCESSORS", "OS", "PATHEXT", "PROCESSOR_ARCHITECTURE",
                    "HOME", "LANG", "LC_ALL", "VIRTUAL_ENV", "PYTHONPATH"}
    env = {k: v for k, v in os.environ.items() if k.upper() in SAFE_INHERIT}
    env["PYTHONIOENCODING"] = "utf-8"
    env["NO_PROXY"] = "*"

    # Креды shop хранятся как {mp_code: {...}} — берём именно mp_code этого shop.
    mp = shop["mp_code"]
    mp_creds = creds.get(mp) or {}

    if mp == "wb":
        tok = mp_creds.get("token")
        if tok:
            env["WB_TOKEN"] = tok
    elif mp == "ozon":
        if mp_creds.get("client_id"):
            env["OZON_CLIENT_ID"] = mp_creds["client_id"]
        if mp_creds.get("api_key"):
            env["OZON_API_KEY"] = mp_creds["api_key"]
        if mp_creds.get("perf_client_id"):
            env["OZON_PERF_CLIENT_ID"] = mp_creds["perf_client_id"]
        if mp_creds.get("perf_client_secret"):
            env["OZON_PERF_CLIENT_SECRET"] = mp_creds["perf_client_secret"]

    # cabinet_id (RLS-изоляция по кабинету; несколько shops одного кабинета пишут
    # в один cabinet_id — это корректно, они видят друг друга внутри проекта).
    env["SAAS_DB_HOST"] = os.environ.get("SAAS_DB_HOST", "localhost")
    env["SAAS_DB_PORT"] = os.environ.get("SAAS_DB_PORT", "5432")
    env["SAAS_DB"] = os.environ.get("SAAS_DB", "saas")
    env["SAAS_DB_USER"] = "saas_app"
    env["SAAS_DB_PASSWORD"] = os.environ.get("SAAS_APP_DB_PASSWORD", "")
    return env, mp


def _run_one(shop, cabinet, collectors, verbose, date_from, date_to):
    """Прогнать список сборщиков под один shop в отдельном subprocess'е (для каждого).
    env-injection: токен + cabinet_id выставляются ДО импорта сборщика.
    date_from/date_to (YYYY-MM-DD) — пробрасываются как argv в сборщики (backfill).
    Сборщики, не принимающие дат (catalog/stocks/prices), их игнорируют.
    Возвращает (ok_list, failed_list)."""
    cid = cabinet["cabinet_id"]
    env, mp = _env_for_shop(shop)
    env["WB_SaaS_CABINET_ID"] = str(cid)

    # Проверка: есть ли нужный токен для этого shop? Иначе сборщик упадёт с RuntimeError.
    if mp == "wb" and not env.get("WB_TOKEN"):
        print(f"    shop #{shop.get('shop_id')} {mp}: нет WB_TOKEN — пропуск", flush=True)
        return [], [f"{mp}:no_token"]
    if mp == "ozon" and not (env.get("OZON_CLIENT_ID") and env.get("OZON_API_KEY")):
        print(f"    shop #{shop.get('shop_id')} {mp}: нет OZON creds — пропуск", flush=True)
        return [], [f"{mp}:no_token"]

    shop_collectors = _collectors_for_mp(mp, collectors)
    if not shop_collectors:
        return [], []

    legacy = " (legacy cab-creds)" if shop.get("_legacy") else ""
    print(f"  -- shop #{shop.get('shop_id')} [{mp}]{legacy}: {shop_collectors}", flush=True)
    if date_from:
        print(f"     диапазон backfill: {date_from} .. {date_to or 'вчера'}", flush=True)

    ok, failed = [], []
    for coll in shop_collectors:
        cmd = [PY, "-m", f"worker.collectors.{coll}"]
        if date_from:
            cmd.append(date_from)
            if date_to:
                cmd.append(date_to)
        label = f"     [{coll}]"
        try:
            r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=3600)
            if r.returncode == 0:
                out = (r.stdout or "").strip().splitlines()
                last = out[-1] if out else "ok"
                print(f"{label} OK: {last}", flush=True)
                ok.append(coll)
            else:
                err = (r.stderr or r.stdout or "").strip().splitlines()
                print(f"{label} FAIL (exit {r.returncode}): {err[-1] if err else ''}", flush=True)
                if verbose and err:
                    for line in err[-5:]:
                        print(f"        {line}", flush=True)
                failed.append(coll)
        except subprocess.TimeoutExpired:
            print(f"{label} TIMEOUT (>3600s)", flush=True)
            failed.append(coll)
        except Exception as e:
            print(f"{label} ERROR: {e}", flush=True)
            failed.append(coll)
    return ok, failed


def run_cabinet(cabinet, collectors, verbose=False, date_from=None, date_to=None):
    """Запустить сборщики для всех shops кабинета. Возвращает список неудач."""
    cid = cabinet["cabinet_id"]
    name = cabinet.get("display_name") or f"#{cid}"
    shops = cabinet.get("shops") or []
    print(f"\n=== Кабинет #{cid} «{name}» shops={len(shops)} ===", flush=True)
    if not shops:
        print("  нет магазинов с кредами — пропуск", flush=True)
        return ["no_shops"]

    all_failed = []
    for shop in shops:
        ok, failed = _run_one(shop, cabinet, collectors, verbose, date_from, date_to)
        all_failed += failed
    print(f"  Итого #{cid}: failed={all_failed or 'нет'}", flush=True)
    return all_failed


# =====================================================================
#  drain-queue: прогон onboarding-jobs (backfill за 75 дней)
# =====================================================================

def drain_queue(verbose=False):
    """Прогнать onboarding-jobs (queued) — backfill за date_from..date_to из job.
    Берёт по одному job (FOR UPDATE SKIP LOCKED — безопасно при параллельных запусках),
    помечает running, гоняет сборщики, по успеху → done, по провалу → failed.
    Пауза DRAIN_PAUSE_SEC между jobs (rate-limit для очереди из нескольких клиентов)."""
    while True:
        # 1. Взять один queued job атомарно (с блокировкой строки).
        with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT job_id, cabinet_id, date_from, date_to "
                    "FROM jobs.collect_jobs "
                    "WHERE job_type = 'onboarding' AND status = 'queued' "
                    "ORDER BY job_id "
                    "FOR UPDATE SKIP LOCKED LIMIT 1")
                job = cur.fetchone()
                if not job:
                    break  # очередь пуста
                cur.execute(
                    "UPDATE jobs.collect_jobs SET status='running', started_at=now(), error=NULL "
                    "WHERE job_id=%s",
                    (job["job_id"],))
            conn.commit()

        jid = job["job_id"]
        cid = job["cabinet_id"]
        df = str(job["date_from"]) if job["date_from"] else None
        dt = str(job["date_to"]) if job["date_to"] else None
        print(f"\n>>> onboarding job #{jid} кабинет #{cid} backfill {df}..{dt}", flush=True)

        # 2. Загрузить кабинет (с shops) — без фильтра по статусу.
        cab = _read_one_cabinet(cid)
        err_msg = None
        if not cab:
            err_msg = f"кабинет #{cid} не найден"
            print(f"    {err_msg}", flush=True)
        else:
            mps = cab.get("marketplaces") or []
            collectors = _collectors_for_marketplaces(mps)
            if not collectors:
                err_msg = f"нет подключённых МП (marketplaces={mps})"
                print(f"    {err_msg}", flush=True)
            else:
                failed = run_cabinet(cab, collectors, verbose=verbose,
                                     date_from=df, date_to=dt)
                if failed:
                    err_msg = f"неудачные сборщики: {failed}"

        # 3. Финализировать job.
        with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                if err_msg:
                    cur.execute(
                        "UPDATE jobs.collect_jobs SET status='failed', finished_at=now(), error=%s "
                        "WHERE job_id=%s", (err_msg[:1000], jid))
                else:
                    cur.execute(
                        "UPDATE jobs.collect_jobs SET status='done', finished_at=now() "
                        "WHERE job_id=%s", (jid,))
            conn.commit()
        print(f"<<< job #{jid}: {'DONE' if not err_msg else 'FAILED'}", flush=True)

        # Пауза перед следующим job (rate-limit по IP для очереди клиентов).
        time.sleep(DRAIN_PAUSE_SEC)

    print("\n=== Очередь onboarding-jobs пуста ===", flush=True)


def main():
    ap = argparse.ArgumentParser(description="SaaS-воркер per-tenant сбора")
    ap.add_argument("--cabinet", type=int, help="Один кабинет (onetime/тест)")
    ap.add_argument("--collectors", default=",".join(DEFAULT_COLLECTORS),
                    help="Список сборщиков через запятую")
    ap.add_argument("--all", action="store_true", help="Все активные кабинеты (daily)")
    ap.add_argument("--drain-queue", dest="drain_queue", action="store_true",
                    help="Прогнать onboarding-jobs (backfill) из очереди")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--date-from", dest="date_from", help="Backfill с даты (YYYY-MM-DD)")
    ap.add_argument("--date-to", dest="date_to", help="Backfill по дату (YYYY-MM-DD, по умолч. вчера)")
    args = ap.parse_args()

    # Режим drain-queue: игнорируем --all/--cabinet, гоняем onboarding-jobs.
    if args.drain_queue:
        drain_queue(verbose=args.verbose)
        return

    explicit_collectors = args.collectors != ",".join(DEFAULT_COLLECTORS)
    collectors = [c.strip() for c in args.collectors.split(",") if c.strip()]

    if args.cabinet:
        # Один конкретный кабинет.
        cab = _read_one_cabinet(args.cabinet)
        if not cab:
            print(f"Кабинет #{args.cabinet} не найден", file=sys.stderr)
            sys.exit(1)
        cabinets = [cab]
    elif args.all:
        cabinets = _read_cabinets(active_only=True)
    else:
        ap.error("укажите --cabinet N, --all или --drain-queue")

    print(f"Воркер: {len(cabinets)} кабинет(ов)", flush=True)
    total_failed = {}
    for cab in cabinets:
        mps = cab.get("marketplaces") or []
        colls = collectors if explicit_collectors else _collectors_for_marketplaces(mps)
        if not colls:
            print(f"  #{cab['cabinet_id']}: нет подключённых МП, пропуск", flush=True)
            continue
        failed = run_cabinet(cab, colls, verbose=args.verbose,
                             date_from=args.date_from, date_to=args.date_to)
        if failed:
            total_failed[cab["cabinet_id"]] = failed

    if total_failed:
        print(f"\n=== НЕУДАЧИ: {total_failed} ===", flush=True)
        sys.exit(1)
    print("\n=== Все кабинеты обработаны ===", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
