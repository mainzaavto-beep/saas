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
import re
import sys
import json
import time
import argparse
import subprocess
import psycopg
from psycopg.rows import dict_row
from datetime import datetime, timezone

from worker import shop_auth
from worker.auth_errors import is_auth_error

# Воркер подключается как postgres (читает api_creds — auth.* без RLS).
# Сборщики внутри subprocess подключаются как saas_app (RLS изоляция).
PG_SUPER = {
    "host": os.environ.get("SAAS_DB_HOST", "localhost"),
    "port": os.environ.get("SAAS_DB_PORT", "5432"),
    "dbname": os.environ.get("SAAS_DB", "saas"),
    "user": "postgres",
    "password": os.environ.get("POSTGRES_PASSWORD", ""),
}

# Метка прогона для jobs.collector_runs; выставляется в main() из --run-kind.
RUN_KIND = "manual"

# Таймаут одного сборщика. Замер по журналу за 14 дней: самый долгий успешный
# прогон — wb_ads 5 мин 9 с, остальные до 20 с. Часовой лимит остался от
# отключённого wb_jem, который висел намертво. Значение вынесено в env, чтобы
# поднять без правки кода, если у крупного кабинета сбор окажется дольше.
COLLECTOR_TIMEOUT = int(os.environ.get("SAAS_COLLECTOR_TIMEOUT_SEC", "900"))

# Guard от затирания (спек п.3): order_costs И cabinet_costs агрегируют из
# своего источника безусловным DO UPDATE (db_pg.py:399-401). Если источник
# ЭТОГО прогона не-ok, пересчёт по дырявым данным затёр бы хорошие агрегаты —
# пропускаем.
# ⚠️ 2026-08-17 (задача 5 плана «переезд финансов Ozon на методы начислений»):
# ozon_order_costs переключён на tenant.ozon_accruals (worker/collectors/
# ozon_order_costs.py больше НЕ читает tenant.ozon_finance_report вообще) —
# зависимость guard'а обязана указывать на ozon_accruals, а не на ozon_finance,
# иначе partial/failed прогон ozon_accruals не остановил бы пересчёт
# ozon_order_costs по неполным начислениям (ozon_finance мог быть ok
# независимо от accruals). wb_* пока по-старому зависят от wb_finance.
GUARD_DEPS = {"wb_order_costs": "wb_finance", "ozon_order_costs": "ozon_accruals",
              "wb_cabinet_costs": "wb_finance"}

# Сборщики, которые продолжают работать даже когда магазин на паузе из-за
# сломанных ключей: у урезанного ключа ломается не всё. Проверено на кабинете
# 1009 — ozon_efficiency собирался успешно, пока остальные шесть ловили 403.
# Их результат состояние магазина не меняет (см. _run_one).
#
# ⚠️ Агрегирующие сборщики (ключи GUARD_DEPS) сюда попадать не должны: на паузе
# их источник — *_finance — не запускается, guard видит «статуса нет» и не
# срабатывает, а пересчёт по неполным данным затёр бы верные агрегаты. Это
# прямой путь к расхождению цифр в отчётах, поэтому такие сборщики
# отфильтровываются в _run_one принудительно, даже если их впишут в env.
PAUSE_EXEMPT_COLLECTORS = {
    c.strip() for c in os.environ.get("SAAS_PAUSE_EXEMPT", "ozon_efficiency").split(",") if c.strip()
}

# ── Контракт exit-кодов сборщиков ────────────────────────────────────
# 0 = ok · 3 = partial (собрано, но часть окон пропущена — см. wb_finance.py)
# · прочее = failed. Маппинг в _run_one.

_OBS_RE_ROWS = re.compile(r"\brows=(\d+)")
_OBS_RE_FROM = re.compile(r"\bfrom=(\d{4}-\d{2}-\d{2})")
_OBS_RE_TO = re.compile(r"\bto=(\d{4}-\d{2}-\d{2})")


def _parse_obs(stdout_text):
    """##OBS-маркер сборщика (спека наблюдаемости, компонент 3): последняя
    строка вида '##OBS rows=N [from=D to=D]' из stdout. Маркера нет (старый/
    сторонний сборщик) → (None, None, None) — это не ошибка."""
    rows = eff_from = eff_to = None
    for line in (stdout_text or "").splitlines():
        line = line.strip()
        if not line.startswith("##OBS"):
            continue
        m = _OBS_RE_ROWS.search(line)
        rows = int(m.group(1)) if m else None
        mf = _OBS_RE_FROM.search(line)
        mt = _OBS_RE_TO.search(line)
        eff_from = mf.group(1) if mf else None
        eff_to = mt.group(1) if mt else None
    return rows, eff_from, eff_to


def _record_run(cabinet_id, collector, status, *, error=None,
                date_from=None, date_to=None, started_at=None, finished_at=None,
                rows_written=None, eff_date_from=None, eff_date_to=None):
    """Строка прогона → jobs.collector_runs. Сбой записи НЕ роняет прогон,
    но печатается в stderr (правило «никаких молчаливых catch»). Возвращает
    id вставленной строки (нужен задаче 6) или None при сбое записи."""
    try:
        with psycopg.connect(**PG_SUPER) as conn:
            row = conn.execute(
                "INSERT INTO jobs.collector_runs "
                "(cabinet_id, collector, run_kind, date_from, date_to, status, "
                " error, started_at, finished_at, rows_written, eff_date_from, eff_date_to) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (cabinet_id, collector, RUN_KIND, date_from, date_to, status,
                 error, started_at or datetime.now(timezone.utc),
                 finished_at or datetime.now(timezone.utc),
                 rows_written, eff_date_from, eff_date_to)).fetchone()
            return row[0] if row else None
    except Exception as e:
        print(f"    [collector_runs] не записал ({collector}/{status}): {e}",
              file=sys.stderr, flush=True)
        return None


def _mark_blocked(run_ids):
    """Переклассифицировать уже записанные строки collector_runs в 'blocked'
    (задача 6 плана «наблюдаемость воркера»). Вызывается ПОСЛЕ цикла по
    сборщикам в _run_one, когда стало известно, какие из уже отработавших
    (и записанных как failed/skipped) сборщиков на самом деле упёрлись в
    отказ авторизации — контрольная попытка паузы, а не настоящий сбой
    сборки. Тот же паттерн, что у _record_run: сбой UPDATE не роняет прогон,
    только печатается в stderr."""
    if not run_ids:
        return
    try:
        with psycopg.connect(**PG_SUPER) as conn:
            conn.execute(
                "UPDATE jobs.collector_runs SET status = 'blocked' WHERE id = ANY(%s)",
                (run_ids,))
    except Exception as e:
        print(f"    [collector_runs] не переклассифицировал в blocked ({run_ids}): {e}",
              file=sys.stderr, flush=True)

# Путь к Python интерпретатору.
PY = sys.executable

# Списки SaaS-сборщиков по маркетплейсу (модули в worker/collectors/). Порядок важен:
# catalog → orders → finance → order_costs + cabinet_costs (зависят от finance) → metrics → prices → stocks.
# ⚠️ ИНВАРИАНТ GUARD'а: сборщик из значений GUARD_DEPS обязан идти РАНЬШЕ
# зависимого от него ключа (см. GUARD_DEPS в _run_one) — для wb_order_costs/
# wb_cabinet_costs это wb_finance, для ozon_order_costs — ozon_accruals
# (с задачи 5 плана «переезд финансов Ozon», 2026-08-17).
# ⚠️ Принцип SaaS: НИКАКИХ Google Sheets — все данные только в PostgreSQL.
WB_COLLECTORS = [
    "wb_catalog",
    "wb_orders",
    "wb_finance",
    "wb_order_costs",
    "wb_cabinet_costs",
    "wb_metrics",
    "wb_ads",
    # "wb_jem",        # «Портрет покупателя» (Джем) — ОТКЛЮЧЁН 2026-08-01: зависает
    #                  # намертво (см. run_saas_collect.sh:19-25), вешал onboarding
    #                  # нового кабинета на таймаут 1 час. Вернуть после фикса зависания.
    "wb_prices",
    "wb_stocks",
    "wb_references",   # справочник складов + тарифы → shared.* (таймер saas-references, weekly)
    "wb_supplies",     # поставки FBS → tenant.wb_supplies (лаг отгрузки на СЦ)
    "wb_fbs_tasks",    # FBS-задания → связка rid↔поставка (время до покупателя)
]
OZON_COLLECTORS = [
    "ozon_catalog",
    "ozon_orders",
    "ozon_sales",
    "ozon_finance",
    "ozon_accruals",    # начисления /v1/finance/accrual/by-day — источник прибыли
                        # (задача 3 плана «переезд финансов Ozon на методы начислений»,
                        # 2026-08-11), ни от чего не зависит. С задачи 5 (2026-08-17)
                        # ozon_order_costs ЧИТАЕТ ИСКЛЮЧИТЕЛЬНО его (ozon_finance больше
                        # не используется этим сборщиком) — см. GUARD_DEPS выше, порядок
                        # в этом списке обязан сохранять ozon_accruals ПЕРЕД ozon_order_costs.
    "ozon_order_costs",
    "ozon_metrics",
    "ozon_stocks",
    "ozon_efficiency",
    "ozon_sku_ad",     # товарная реклама (миграция 043); в расписании (MAIN_COLLECTORS) — после шлюза владельца
    "ozon_prices",     # дневной снимок цен → соинвест (миграция 030, спек 2026-08-02)
    "ozon_references", # справочник кластеров → shared.ozon_clusters (таймер saas-references)
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
    # Метка прогона (--run-kind) — сборщику, которому важно, КАКОЙ это тик:
    # ozon_sku_ad в ночном режиме 'skuad' обязан собирать, а не скипать по
    # дневному окну (догон таймера после простоя 06.09.2026 попал в окно и
    # ушёл вхолостую). Не секрет, whitelist SAFE_INHERIT не трогаем.
    env["SAAS_RUN_KIND"] = RUN_KIND
    return env, mp


def _run_one(shop, cabinet, collectors, verbose, date_from, date_to):
    """Прогнать список сборщиков под один shop в отдельном subprocess'е (для каждого).
    env-injection: токен + cabinet_id выставляются ДО импорта сборщика.
    date_from/date_to (YYYY-MM-DD) — пробрасываются как argv в сборщики (backfill).
    Сборщики, не принимающие дат (catalog/stocks/prices), их игнорируют.
    Возвращает (ok_list, failed_list, blocked_list). failed — настоящие сбои сборки
    (валят прогон, будят алерт). blocked — работа не выполнена не по вине сервиса:
    пауза по ключам, отсутствие кредов, отказ авторизации в сборщике (чинит клиент,
    прогон не роняет, но и готовой работой считать нельзя — см. drain_queue)."""
    cid = cabinet["cabinet_id"]
    env, mp = _env_for_shop(shop)
    env["WB_SaaS_CABINET_ID"] = str(cid)

    # Сначала — есть ли вообще сборщики для этого mp в данном прогоне (напр. metrics30m
    # содержит только wb_metrics_30m — ozon-магазин здесь ни при чём). Если нет, выходим
    # ДО проверки кредов, иначе получаем бессмысленный no_token на каждый холостой прогон.
    shop_collectors = _collectors_for_mp(mp, collectors)
    if not shop_collectors:
        return [], [], []

    # Магазин со сломанными ключами не должен тратить окно прогона: пока он в
    # паузе, сборщики не запускаем. Раз в сутки shop_auth.should_skip пропустит
    # одну контрольную попытку — вдруг чинил не клиент, а маркетплейс.
    #
    # Исключение (решение владельца 2026-08-08): урезанный ключ ломает не всё.
    # У кабинета 1009 ключ Ozon лишён роли для finance/orders/sales, но вызовы
    # ozon_efficiency ей не требуют — сборщик работал успешно, и пауза его
    # глушила, тихо теряя дневные снапшоты. Такие сборщики продолжают ходить
    # и на паузе. Их результат состояние магазина НЕ меняет: успех не снимает
    # паузу (иначе магазин каждый прогон возвращался бы к полному списку, и
    # шум, ради устранения которого всё делалось, вернулся бы), отказ её не
    # продлевает. Список правится переменной без правки кода.
    shop_id = shop.get("shop_id")
    state = shop_auth.load_state(shop_id) if shop_id else None
    paused = shop_auth.should_skip(state)
    if paused:
        since = state.get("auth_failed_at")
        # Агрегаты на паузе не пересчитываем никогда: их источник (*_finance) не
        # запускается, guard в этом прогоне не сработает, и пересчёт по неполным
        # данным затёр бы верные цифры. Фильтр стоит здесь, а не в env, чтобы
        # ошибка в SAAS_PAUSE_EXEMPT не стоила клиенту искажённой прибыли.
        exempt = [c for c in shop_collectors
                  if c in PAUSE_EXEMPT_COLLECTORS and c not in GUARD_DEPS]
        ignored = sorted(set(shop_collectors) & PAUSE_EXEMPT_COLLECTORS & set(GUARD_DEPS))
        if ignored:
            print(f"    shop #{shop_id} {mp}: {', '.join(ignored)} на паузе не запускаем — "
                  f"агрегат без свежего {GUARD_DEPS[ignored[0]]} затёр бы верные данные", flush=True)
        skipped_note = f"auth_paused: {state.get('auth_last_error') or 'отказ авторизации'}"
        if exempt:
            skipped_note += f" (кроме {', '.join(exempt)})"
        print(f"    shop #{shop_id} {mp}: ключи не работают, пауза (с {since}) — "
              f"{'частичный пропуск' if exempt else 'пропуск'}", flush=True)
        _record_run(cid, f"{mp}:credentials", "skipped", error=skipped_note)
        if not exempt:
            return [], [], [f"{mp}:auth_paused"]
        shop_collectors = exempt

    # Проверка: есть ли нужный токен для этого shop? Иначе сборщик упадёт с RuntimeError.
    if mp == "wb" and not env.get("WB_TOKEN"):
        print(f"    shop #{shop_id} {mp}: нет WB_TOKEN — пропуск", flush=True)
        _record_run(cid, "wb:credentials", "no_token", error=f"shop #{shop_id}: нет WB_TOKEN")
        if shop_id and not paused:
            shop_auth.mark_failure(shop_id, "нет сохранённого токена WB")
        return [], [], [f"{mp}:no_token"]
    if mp == "ozon" and not (env.get("OZON_CLIENT_ID") and env.get("OZON_API_KEY")):
        print(f"    shop #{shop_id} {mp}: нет OZON creds — пропуск", flush=True)
        _record_run(cid, "ozon:credentials", "no_token", error=f"shop #{shop_id}: нет OZON creds")
        if shop_id and not paused:
            shop_auth.mark_failure(shop_id, "нет сохранённых ключей Ozon")
        return [], [], [f"{mp}:no_token"]

    legacy = " (legacy cab-creds)" if shop.get("_legacy") else ""
    print(f"  -- shop #{shop.get('shop_id')} [{mp}]{legacy}: {shop_collectors}", flush=True)
    if date_from:
        print(f"     диапазон backfill: {date_from} .. {date_to or 'вчера'}", flush=True)

    ok, failed = [], []
    statuses = {}  # coll -> 'ok'|'partial'|'failed'|'timeout'|'skipped' (для guard'а)
    auth_error_texts = []      # тексты ошибок, похожих на отказ авторизации
    auth_failed_collectors = []  # какие сборщики упали именно по авторизации
    run_ids = {}  # coll -> id строки collector_runs (для переклассификации в blocked ниже)

    for coll in shop_collectors:
        dep = GUARD_DEPS.get(coll)
        if dep and statuses.get(dep) not in (None, "ok"):
            reason = f"{dep} status={statuses[dep]} — агрегат не пересчитан (guard от затирания)"
            print(f"     [{coll}] SKIP: {reason}", flush=True)
            statuses[coll] = "skipped"
            run_ids[coll] = _record_run(cid, coll, "skipped", error=reason,
                        date_from=date_from, date_to=date_to)
            if dep in auth_failed_collectors:
                # Зависимость упала именно по отказу авторизации (сломанные
                # ключи клиента, не наш сбой) — guard-пропуск наследует ту же
                # классификацию и ниже уедет в blocked вместе с ней. Порядок
                # WB_COLLECTORS/OZON_COLLECTORS гарантирует, что *_finance уже
                # отработал и попал в auth_failed_collectors ДО того, как мы
                # дошли до зависимого *_order_costs/*_cabinet_costs в этом же
                # цикле (см. инвариант у объявления списков выше).
                auth_failed_collectors.append(coll)
            else:
                # Настоящий сбой зависимости (сеть, 5xx, таймаут, partial) —
                # это реальная проблема сборки, оставляем в failed.
                failed.append(coll)
            continue
        cmd = [PY, "-m", f"worker.collectors.{coll}"]
        if date_from:
            cmd.append(date_from)
            if date_to:
                cmd.append(date_to)
        label = f"     [{coll}]"
        started = datetime.now(timezone.utc)
        try:
            r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=COLLECTOR_TIMEOUT)
            obs_rows, obs_from, obs_to = _parse_obs(r.stdout)
            if r.returncode == 0:
                out = (r.stdout or "").strip().splitlines()
                last = out[-1] if out else "ok"
                print(f"{label} OK: {last}", flush=True)
                ok.append(coll)
                statuses[coll] = "ok"
                _record_run(cid, coll, "ok",
                            date_from=date_from, date_to=date_to, started_at=started,
                            rows_written=obs_rows, eff_date_from=obs_from, eff_date_to=obs_to)
            elif r.returncode == 3:
                # Контракт exit-кодов: 3 = partial (часть окон пропущена, напр. 429).
                err = (r.stderr or r.stdout or "").strip().splitlines()
                print(f"{label} PARTIAL: {err[-1] if err else ''}", flush=True)
                failed.append(coll)
                statuses[coll] = "partial"
                _record_run(cid, coll, "partial", error=(err[-1] if err else None),
                            date_from=date_from, date_to=date_to, started_at=started,
                            rows_written=obs_rows, eff_date_from=obs_from, eff_date_to=obs_to)
            else:
                err = (r.stderr or r.stdout or "").strip().splitlines()
                print(f"{label} FAIL (exit {r.returncode}): {err[-1] if err else ''}", flush=True)
                if verbose and err:
                    for line in err[-5:]:
                        print(f"        {line}", flush=True)
                failed.append(coll)
                statuses[coll] = "failed"
                run_ids[coll] = _record_run(cid, coll, "failed",
                            error=(err[-1] if err else f"exit {r.returncode}"),
                            date_from=date_from, date_to=date_to, started_at=started,
                            rows_written=obs_rows, eff_date_from=obs_from, eff_date_to=obs_to)
                err_text = "\n".join(err[-3:]) if err else ""
                if is_auth_error(err_text):
                    # Храним ТОТ ЖЕ текст, по которому принято решение (может быть
                    # многострочным — traceback WB), а не последнюю строку: иначе
                    # повторная проверка ниже по auth_error_texts могла не совпасть
                    # с исходным совпадением и тихо сбросить состояние в ok.
                    auth_error_texts.append(err_text)
                    auth_failed_collectors.append(coll)
        except subprocess.TimeoutExpired:
            print(f"{label} TIMEOUT (>{COLLECTOR_TIMEOUT}s)", flush=True)
            failed.append(coll)
            statuses[coll] = "timeout"
            _record_run(cid, coll, "timeout", error=f"timeout >{COLLECTOR_TIMEOUT}s",
                        date_from=date_from, date_to=date_to, started_at=started)
        except Exception as e:
            print(f"{label} ERROR: {e}", flush=True)
            failed.append(coll)
            statuses[coll] = "failed"
            _record_run(cid, coll, "failed", error=str(e)[:500],
                        date_from=date_from, date_to=date_to, started_at=started)

    # Состояние ключей: отказ авторизации хотя бы в одном сборщике — засчитываем
    # неудачу, любой успех — сбрасываем. Сетевые сбои и 429 состояние не трогают:
    # маркетплейсы падают регулярно, останавливать из-за этого сбор нельзя.
    blocked = []
    if shop_id and paused:
        # Магазин уже на паузе, а отработали только сборщики-исключения. Их итог
        # состояние не меняет (см. комментарий у проверки паузы), но отказ по
        # авторизации остаётся проблемой клиента, а не сбоем сборки.
        auth_failed = [c for c in auth_failed_collectors]
        failed = [f for f in failed if f not in auth_failed]
        blocked = auth_failed + [f"{mp}:auth_paused"]
    elif shop_id:
        auth_errors_seen = [e for e in auth_error_texts if is_auth_error(e)]
        if auth_errors_seen:
            # Фильтр сработал по тому же тексту, что и первичная проверка выше.
            # Для БД берём последнюю непустую строку — короче и читаемее полного
            # traceback'а, но на классификацию она уже не влияет.
            lines = [l for l in auth_errors_seen[0].splitlines() if l.strip()]
            last_line = lines[-1] if lines else auth_errors_seen[0]
            new_state = shop_auth.mark_failure(shop_id, last_line)
            if new_state == "paused":
                print(f"    shop #{shop_id} {mp}: ключи не работают — магазин на паузе", flush=True)
            elif new_state == "disabled":
                print(f"    shop #{shop_id} {mp}: контрольные попытки паузы исчерпаны — "
                      f"сбор остановлен (disabled)", flush=True)
            # Отказ авторизации не считаем сбоем сборки (чинит его клиент), но и
            # успехом это не назовёшь — работа не выполнена, а «заблокирована».
            failed = [f for f in failed if f not in auth_failed_collectors]
            blocked = list(auth_failed_collectors)
        elif ok:
            shop_auth.mark_ok(shop_id)

    # Журнал: сборщики выше уже записаны как failed/skipped (в момент записи
    # ещё не знали финальную классификацию — она наступает только здесь, после
    # цикла). Тем, кто попал в blocked, переклассифицируем строку постфактум —
    # иначе контрольная попытка паузы, упавшая по битым ключам клиента,
    # выглядела бы в журнале настоящим сбоем сборки (см. _mark_blocked).
    blocked_ids = [run_ids[c] for c in blocked if run_ids.get(c) is not None]
    _mark_blocked(blocked_ids)
    return ok, failed, blocked


def run_cabinet(cabinet, collectors, verbose=False, date_from=None, date_to=None):
    """Запустить сборщики для всех shops кабинета.
    Возвращает (failed, blocked) — failed валит прогон (настоящие сбои сборки),
    blocked — работа не выполнена не по нашей вине (пауза/нет кредов/отказ
    авторизации): прогон не роняет, но и готовой работой (для drain_queue) не
    считается."""
    cid = cabinet["cabinet_id"]
    name = cabinet.get("display_name") or f"#{cid}"
    shops = cabinet.get("shops") or []
    print(f"\n=== Кабинет #{cid} «{name}» shops={len(shops)} ===", flush=True)
    if not shops:
        # Незавершённый онбординг (проект создан, магазин ещё не добавлен) —
        # это НЕ сбой сборки. С открытой регистрацией такое создаёт кто угодно,
        # включая брошенные попытки — не должно ронять прогон в failed и будить
        # OnFailure-алерт (см. фикс-волну 2026-08-06, находка №1). Статус skipped,
        # как у GUARD_DEPS-пропусков, чтобы /health красил жёлтым, а не красным.
        print("  нет магазинов с кредами — пропуск (незавершённый онбординг)", flush=True)
        _record_run(cid, "_cabinet", "skipped", error="no_shops")
        return [], []

    all_failed, all_blocked = [], []
    for shop in shops:
        ok, failed, blocked = _run_one(shop, cabinet, collectors, verbose, date_from, date_to)
        all_failed += failed
        all_blocked += blocked
    print(f"  Итого #{cid}: failed={all_failed or 'нет'} blocked={all_blocked or 'нет'}", flush=True)
    return all_failed, all_blocked


# =====================================================================
#  drain-queue: прогон onboarding-jobs (backfill за 75 дней)
# =====================================================================

def drain_queue(verbose=False):
    """Прогнать onboarding-jobs (queued) — backfill за date_from..date_to из job.
    Берёт по одному job (FOR UPDATE SKIP LOCKED — безопасно при параллельных запусках),
    помечает running, гоняет сборщики, по успеху → done, по провалу → failed.
    Заблокированный ключами job (пауза/нет кредов/отказ авторизации) — НЕ done и
    НЕ failed: возвращаем в queued, чтобы после починки ключей backfill подтянулся
    сам следующим прогоном. skip_ids не даёт этому же job'у зациклить ТЕКУЩИЙ
    прогон (иначе while True никогда не увидит пустую очередь).
    Пауза DRAIN_PAUSE_SEC между jobs (rate-limit для очереди из нескольких клиентов)."""
    skip_ids = []  # отложенные (blocked) в этом прогоне — не берём их снова сейчас
    while True:
        # 1. Взять один queued job атомарно (с блокировкой строки), кроме уже
        #    отложенных в этом прогоне.
        with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT job_id, cabinet_id, date_from, date_to "
                    "FROM jobs.collect_jobs "
                    "WHERE job_type = 'onboarding' AND status = 'queued' "
                    "  AND NOT (job_id = ANY(%s::bigint[])) "
                    "ORDER BY job_id "
                    "FOR UPDATE SKIP LOCKED LIMIT 1",
                    (skip_ids,))
                job = cur.fetchone()
                if not job:
                    break  # очередь пуста (с учётом отложенных)
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
        blocked_msg = None
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
                failed, blocked = run_cabinet(cab, collectors, verbose=verbose,
                                              date_from=df, date_to=dt)
                if failed:
                    err_msg = f"неудачные сборщики: {failed}"
                elif blocked:
                    blocked_msg = f"отложен: ключи магазина не работают ({blocked})"

        # 3. Финализировать job.
        with psycopg.connect(**PG_SUPER, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                if err_msg:
                    cur.execute(
                        "UPDATE jobs.collect_jobs SET status='failed', finished_at=now(), error=%s "
                        "WHERE job_id=%s", (err_msg[:1000], jid))
                elif blocked_msg:
                    # Не сбой сервиса и не готовая работа — job возвращаем в очередь
                    # (started_at сбрасываем, иначе он выглядит «зависшим running»).
                    cur.execute(
                        "UPDATE jobs.collect_jobs SET status='queued', started_at=NULL, error=%s "
                        "WHERE job_id=%s", (blocked_msg[:1000], jid))
                    skip_ids.append(jid)
                else:
                    cur.execute(
                        "UPDATE jobs.collect_jobs SET status='done', finished_at=now() "
                        "WHERE job_id=%s", (jid,))
            conn.commit()
        status_label = "FAILED" if err_msg else ("ОТЛОЖЕН" if blocked_msg else "DONE")
        print(f"<<< job #{jid}: {status_label}", flush=True)

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
    ap.add_argument("--run-kind", dest="run_kind", default="manual",
                    help="Метка прогона для jobs.collector_runs "
                         "(main|stocks|metrics30m|references|backfill|systemd|manual)")
    args = ap.parse_args()

    global RUN_KIND
    RUN_KIND = args.run_kind
    if args.drain_queue and RUN_KIND == "manual":
        RUN_KIND = "backfill"

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
        # Ретеншн журнала прогонов: 90 дней (спек 2026-08-02-worker-alerting).
        try:
            with psycopg.connect(**PG_SUPER) as conn:
                conn.execute("DELETE FROM jobs.collector_runs "
                             "WHERE started_at < now() - interval '90 days'")
        except Exception as e:
            print(f"[collector_runs] ретеншн не отработал: {e}", file=sys.stderr, flush=True)
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
        # blocked (пауза/нет кредов/отказ авторизации) на итоговый exit-код не
        # влияет — как и раньше, эту категорию алерт будить не должен.
        failed, _blocked = run_cabinet(cab, colls, verbose=args.verbose,
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
