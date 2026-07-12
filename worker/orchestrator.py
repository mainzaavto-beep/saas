"""
orchestrator.py — SaaS-воркер: читает активные кабинеты из PG, выставляет env
(токен + cabinet_id), запускает сборщики per-cabinet.

Принцип (из разведки #241/#242): WB_TOKEN читается сборщиками на верхнем уровне
модуля при import → один Python-процесс = один tenant. Поэтому воркер для
каждого кабинета запускает ОТДЕЛЬНЫЙ subprocess с правильно выставленным env.

Два режима:
  daily   — все активные кабинеты, сборщики «за вчера/сегодня»
  onetime — один конкретный кабинет (cabinet_id=N), для initial resync / теста
            (передаётся --cabinet N [--collectors wb_catalog,wb_orders,...])

Env (читает из Machine/.env): SAAS_DB_* для подключения к PG как postgres
(superuser) — чтобы читать auth.cabinets.api_creds (RLS на tenant.* не мешает:
auth.* без RLS). Сами сборщики под saas_app.

Координация: боевые Планировщик/сборщики НЕ трогаются. Это отдельный SaaS-воркер.
"""
import os
import sys
import json
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
# catalog → orders → finance → order_costs (зависит от finance) → metrics → prices → stocks.
# ⚠️ Принцип SaaS: НИКАКИХ Google Sheets — все данные только в PostgreSQL.
WB_COLLECTORS = [
    "wb_catalog",
    "wb_orders",
    "wb_finance",
    "wb_order_costs",
    "wb_metrics",
    "wb_prices",
    "wb_stocks",
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


def _collectors_for_marketplaces(mps):
    """Выбрать сборщики по подключённым МП кабинета."""
    out = []
    if "wb" in mps:
        out += WB_COLLECTORS
    if "ozon" in mps:
        out += OZON_COLLECTORS
    return out


def _read_cabinets(active_only=True):
    """Прочитать кабинеты с api_creds + api_creds_enc. active_only=False → включая provisioning."""
    with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
        sql = (
            "SELECT cabinet_id, display_name, marketplaces, api_creds, api_creds_enc "
            "FROM auth.cabinets WHERE status = ANY(%s)"
        )
        statuses = ["active"] if active_only else ["active", "provisioning"]
        with conn.cursor() as cur:
            cur.execute(sql, (statuses,))
            return cur.fetchall()


def _env_for_cabinet(cabinet):
    """Сформировать env-словарь для subprocess: токен + cabinet_id + DB creds.
    Расшифровывает api_creds_enc через pgcrypto (ключ из env SAAS_CRED_MASTER_KEY).
    Fallback: если api_creds_enc пуст — старый plaintext api_creds (обратная совместимость).

    🔒 БЕЗОПАСНОСТЬ (фикс 2026-07-10): НЕ наследуем os.environ целиком! Боевые токены
    (WB_TOKEN, OZON_*) лежат в Machine env — если их унаследовать, чужой кабинет
    получит доступ к боевому кабинету продавца. Whitelist: только системные vars,
    нужные для работы Python/сети + ЯВНО расшифрованные creds кабинета + DB creds."""
    enc_key = os.environ.get("SAAS_CRED_MASTER_KEY", "")
    enc = cabinet.get("api_creds_enc")
    if enc and enc_key:
        with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT pgp_sym_decrypt(%s::bytea, %s) AS plain", (enc, enc_key))
                row = cur.fetchone()
        creds = json.loads(row["plain"]) if row and row["plain"] else {}
    else:
        raw = cabinet.get("api_creds")
        creds = raw if isinstance(raw, dict) else json.loads(raw or "{}")

    # Whitelist системных переменных (без боевых токенов WB_TOKEN/OZON_*).
    SAFE_INHERIT = {"PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR",
                    "NUMBER_OF_PROCESSORS", "OS", "PATHEXT", "PROCESSOR_ARCHITECTURE"}
    env = {k: v for k, v in os.environ.items() if k.upper() in SAFE_INHERIT}
    env["PYTHONIOENCODING"] = "utf-8"
    env["NO_PROXY"] = "*"

    wb = creds.get("wb") or {}
    if wb.get("token"):
        env["WB_TOKEN"] = wb["token"]
    oz = creds.get("ozon") or {}
    if oz.get("client_id"):
        env["OZON_CLIENT_ID"] = oz["client_id"]
    if oz.get("api_key"):
        env["OZON_API_KEY"] = oz["api_key"]
    if oz.get("perf_client_id"):
        env["OZON_PERF_CLIENT_ID"] = oz["perf_client_id"]
    if oz.get("perf_client_secret"):
        env["OZON_PERF_CLIENT_SECRET"] = oz["perf_client_secret"]
    env["WB_SaaS_CABINET_ID"] = str(cabinet["cabinet_id"])
    env["SAAS_DB_HOST"] = os.environ.get("SAAS_DB_HOST", "localhost")
    env["SAAS_DB_PORT"] = os.environ.get("SAAS_DB_PORT", "5432")
    env["SAAS_DB"] = os.environ.get("SAAS_DB", "saas")
    env["SAAS_DB_USER"] = "saas_app"
    env["SAAS_DB_PASSWORD"] = os.environ.get("SAAS_APP_DB_PASSWORD", "")
    return env


def run_cabinet(cabinet, collectors, verbose=False, date_from=None, date_to=None):
    """Запустить список сборщиков под один кабинет в отдельном subprocess.
    env-injection: токен + cabinet_id выставляются ДО импорта сборщика.
    date_from/date_to (YYYY-MM-DD) — пробрасываются как argv в сборщики (backfill).
    Сборщики, не принимающие дат (catalog/stocks/prices), их игнорируют."""
    cid = cabinet["cabinet_id"]
    name = cabinet.get("display_name") or f"#{cid}"
    env = _env_for_cabinet(cabinet)
    mps = cabinet.get("marketplaces") or []
    print(f"\n=== Кабинет #{cid} «{name}» МП={mps} ===", flush=True)
    if date_from:
        print(f"  диапазон backfill: {date_from} .. {date_to or 'вчера'}", flush=True)

    ok, failed = [], []
    for coll in collectors:
        # Запускаем сборщик как модуль в subprocess. env уже содержит токен+cabinet_id.
        cmd = [PY, "-m", f"worker.collectors.{coll}"]
        # Проброс дат для backfill-сборщиков (orders/finance/order_costs/metrics/sales).
        if date_from:
            cmd.append(date_from)
            if date_to:
                cmd.append(date_to)
        label = f"  [{coll}]"
        try:
            r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=1800)
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
                        print(f"      {line}", flush=True)
                failed.append(coll)
        except subprocess.TimeoutExpired:
            print(f"{label} TIMEOUT (>1800s)", flush=True)
            failed.append(coll)
        except Exception as e:
            print(f"{label} ERROR: {e}", flush=True)
            failed.append(coll)
    print(f"  Итого #{cid}: ok={ok} failed={failed}", flush=True)
    return failed


def main():
    ap = argparse.ArgumentParser(description="SaaS-воркер per-tenant сбора")
    ap.add_argument("--cabinet", type=int, help="Один кабинет (onetime/тест)")
    ap.add_argument("--collectors", default=",".join(DEFAULT_COLLECTORS),
                    help="Список сборщиков через запятую")
    ap.add_argument("--all", action="store_true", help="Все активные кабинеты (daily)")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--date-from", dest="date_from", help="Backfill с даты (YYYY-MM-DD)")
    ap.add_argument("--date-to", dest="date_to", help="Backfill по дату (YYYY-MM-DD, по умолч. вчера)")
    args = ap.parse_args()
    explicit_collectors = args.collectors != ",".join(DEFAULT_COLLECTORS)
    collectors = [c.strip() for c in args.collectors.split(",") if c.strip()]

    if args.cabinet:
        # Один конкретный кабинет.
        with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT cabinet_id, display_name, marketplaces, api_creds, api_creds_enc "
                            "FROM auth.cabinets WHERE cabinet_id = %s", (args.cabinet,))
                cabinets = cur.fetchall()
        if not cabinets:
            print(f"Кабинет #{args.cabinet} не найден", file=sys.stderr)
            sys.exit(1)
    elif args.all:
        cabinets = _read_cabinets(active_only=True)
    else:
        ap.error("укажите --cabinet N или --all")

    print(f"Воркер: {len(cabinets)} кабинет(ов)", flush=True)
    total_failed = {}
    for cab in cabinets:
        # Если список сборщиков задан явно (--collectors) — используем его.
        # Иначе — выбираем по подключённым МП кабинета.
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
