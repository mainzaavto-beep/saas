# Реклама Ozon по товарам (per-SKU) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать рекламный расход Ozon в разрезе товар×день из Performance API и включить вычет рекламы в прибыль отдельного товара на обеих площадках (решение владельца 2026-08-21).

**Architecture:** Новый сборщик `ozon_sku_ad` (async-отчёт groupBy=DATE → ZIP → CSV на кампанию) → сырая таблица `tenant.ozon_daily_sku_ad` → пересчёт `tenant.ozon_daily_metrics.ad_*` по product_id → канон `ozProfitProduct`/`wbProfitProduct` вычитает реальный расход товара при товарном фильтре. Кабинетная прибыль (P&L/Обзор) не меняется.

**Tech Stack:** Python (worker, requests/psycopg через db_pg), PostgreSQL (tenant.*), Node/ESM (канон lib/, сторожа scripts/), Next.js (панель).

**Спека:** `docs/superpowers/specs/2026-08-21-ozon-sku-ads-design.md` (коммиты e927070 + правка «на обеих площадках»).

## Global Constraints

- Правки сборщиков = мгновенный деплой (плановый тик подхватит файл) — сборщик НЕ добавлять в `MAIN_COLLECTORS` (`worker/run_saas_collect.sh:42`) до задачи 7 (после шлюза владельца).
- Панель деплоится ТОЛЬКО `npm run build && systemctl restart saas-web`; НИКОГДА `next dev` в /opt/agents/saas.
- БД: читать под `saas_ro` (`psql -h localhost -U saas_ro -d saas`); BYPASSRLS → в каждом запросе явный `WHERE cabinet_id = …`. Запись — только миграция (задача 1, `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`) и идемпотентные прогоны сборщика.
- OAuth Performance API: ТОЛЬКО JSON-тело `{client_id, client_secret, grant_type: "client_credentials"}` — basic auth даёт 401 (грабля 2026-08-02).
- Скачивание готового отчёта — с заголовком `Authorization: Bearer <token>` (без него 401 — доказано пробой 2026-08-21).
- Окно `/api/client/statistics`: чанки дат ≤60 дней (ровно 62 → HTTP 400); кампаний в одном отчёте ≤10; между HTTP-запросами пауза ≥2 с; 429 → пауза 65 с и один повтор.
- Строки CSV `Всего`/`Итого`/`Корректировка` в данные не пишутся; сумма «Корректировка» печатается в лог (видимый счётчик, не молча).
- Числа CSV: запятая-десятичная, возможны пробелы и NBSP (`\xa0`); даты `дд.мм.гггг` → `YYYY-MM-DD`.
- Все сторожа после каждой задачи: `node scripts/check-profit-canon.mjs` (оба кабинета 1, 1008), `node scripts/profit-snapshot.mjs --verify` — ALL PASS. Тексты в панели и комментарии — по-русски.
- Расхождение цифр = наш баг, пока не доказано обратное (AGENTS.md).

---

### Task 1: Миграция 043 — таблица tenant.ozon_daily_sku_ad

**Files:**
- Create: `db/migrations/043_ozon_sku_ad.sql`

**Interfaces:**
- Produces: таблица `tenant.ozon_daily_sku_ad` (cabinet_id BIGINT, date DATE, campaign_id BIGINT, sku TEXT, product_id BIGINT NULL, spend NUMERIC(14,2), views BIGINT, clicks BIGINT, ordered_units BIGINT, ordered_amount NUMERIC(14,2), updated_at TEXT; PK (cabinet_id, date, campaign_id, sku)); RLS `tenant_iso` + `panel_local_ro_cab1`; гранты `saas_app` (rw), `panel_local_ro` (select). `saas_ro` получает SELECT автоматически (ALTER DEFAULT PRIVILEGES из db/ops/saas_ro_role.sql).

- [ ] **Step 1: Прочитать шаблон** — `db/migrations/041_ozon_order_costs_shadow.sql` целиком (идемпотентный образец: CREATE TABLE IF NOT EXISTS + DO $$-блоки политик + гранты) и `039_ozon_campaign_ad.sql` (стиль docstring-шапки).

- [ ] **Step 2: Написать миграцию** `db/migrations/043_ozon_sku_ad.sql`:

```sql
-- 043: tenant.ozon_daily_sku_ad — рекламный расход Ozon в разрезе
-- кампания × день × sku. Источник: Performance API POST /api/client/statistics
-- (groupBy=DATE, async) → ZIP → CSV на кампанию; доказано живой пробой
-- 2026-08-21 (сверка с tenant.ozon_daily_campaign_ad Δ=0.00 на закрытых днях).
-- sku здесь = tenant.ozon_products.fbo_sku (строка!); product_id — резолв
-- на момент записи (NULL, если товара нет в каталоге — архив и т.п.).
-- Дополняет ozon_daily_campaign_ad товарным разрезом; кампанийная таблица
-- остаётся источником кабинетного итога (P&L) — она полнее: строки
-- «Корректировка» и кампании без товарной разбивки не имеют sku.
-- Идемпотентна (CREATE IF NOT EXISTS + DO $$ для политик RLS).
-- Спека: docs/superpowers/specs/2026-08-21-ozon-sku-ads-design.md.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.ozon_daily_sku_ad (
    cabinet_id     BIGINT NOT NULL,
    date           DATE NOT NULL,
    campaign_id    BIGINT NOT NULL,
    sku            TEXT NOT NULL,
    product_id     BIGINT,
    spend          NUMERIC(14,2) NOT NULL DEFAULT 0,
    views          BIGINT,
    clicks         BIGINT,
    ordered_units  BIGINT,
    ordered_amount NUMERIC(14,2),
    updated_at     TEXT,
    PRIMARY KEY (cabinet_id, date, campaign_id, sku)
);

CREATE INDEX IF NOT EXISTS ozon_daily_sku_ad_product_idx
    ON tenant.ozon_daily_sku_ad (cabinet_id, product_id, date);

ALTER TABLE tenant.ozon_daily_sku_ad ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='ozon_daily_sku_ad' AND policyname='tenant_iso_ozon_daily_sku_ad') THEN
        CREATE POLICY tenant_iso_ozon_daily_sku_ad ON tenant.ozon_daily_sku_ad
        USING (cabinet_id = current_setting('app.cabinet_id', true)::bigint);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='ozon_daily_sku_ad' AND policyname='panel_local_ro_cab1') THEN
        CREATE POLICY panel_local_ro_cab1 ON tenant.ozon_daily_sku_ad
        FOR SELECT TO panel_local_ro
        USING (cabinet_id = 1);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ozon_daily_sku_ad TO saas_app;
-- panel_local_ro_cab1 без базового GRANT SELECT бесполезна (RLS не заменяет
-- табличную привилегию) — как в 041.
GRANT SELECT ON tenant.ozon_daily_sku_ad TO panel_local_ro;

COMMIT;
```

⚠️ Перед записью файла сверить форму `tenant_iso`-политики с реальной в 041 (имя/USING-выражение могут отличаться — копировать оттуда 1:1, подставив имя таблицы). Если в 041 политика создаётся иначе (например, отдельные FOR SELECT/ALL), повторить точно.

- [ ] **Step 3: Применить миграцию** (идемпотентная структурная миграция — разрешена стандартным протоколом):

Run: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f db/migrations/043_ozon_sku_ad.sql`
Expected: COMMIT без ошибок.

- [ ] **Step 4: Проверить** под saas_ro:

Run: `psql -h localhost -U saas_ro -d saas -Atc "SELECT count(*) FROM tenant.ozon_daily_sku_ad" -Atc "SELECT policyname FROM pg_policies WHERE schemaname='tenant' AND tablename='ozon_daily_sku_ad' ORDER BY 1"`
Expected: `0` и две политики (`panel_local_ro_cab1`, `tenant_iso_ozon_daily_sku_ad`).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/043_ozon_sku_ad.sql
git commit -m "feat(db): tenant.ozon_daily_sku_ad — реклама Ozon по товарам (миграция 043)"
```

---

### Task 2: db_pg.py — запись сырого слоя и пересчёт товарных метрик

**Files:**
- Modify: `worker/db_pg.py` (добавить две функции рядом с `upsert_ozon_cabinet_costs_many`, ~строка 1090)

**Interfaces:**
- Consumes: `get_connection()`, `_cabinet_id()`, паттерн `upsert_ozon_cabinet_costs_many` (worker/db_pg.py:1057-1090).
- Produces:
  - `upsert_ozon_sku_ad_many(rows, date_from, date_to) -> int` — rows: список dict с ключами `date, campaign_id, sku, product_id, spend, views, clicks, ordered_units, ordered_amount`; транзакционно DELETE окна `[date_from, date_to]` + INSERT всех rows.
  - `recompute_ozon_daily_ad(date_from, date_to) -> int` — пересчёт `tenant.ozon_daily_metrics.ad_spend/ad_views/ad_clicks/ad_orders` из `ozon_daily_sku_ad` по (product_id, date) внутри окна; возвращает число (product_id, date)-пар.

- [ ] **Step 1: Написать `upsert_ozon_sku_ad_many`** (по образцу `upsert_ozon_cabinet_costs_many` — DELETE+INSERT в одной транзакции):

```python
_OZ_SKU_AD_COLS = ["date", "campaign_id", "sku", "product_id", "spend",
                   "views", "clicks", "ordered_units", "ordered_amount"]


def upsert_ozon_sku_ad_many(rows, date_from, date_to):
    """Batch DELETE+INSERT рекламы Ozon товар×день×кампания
    (tenant.ozon_daily_sku_ad, миграция 043). Источник — async-отчёт
    Performance API groupBy=DATE (сборщик ozon_sku_ad). Идемпотентность
    пересборки окна ТРЕБУЕТ DELETE перед INSERT: кампания, переставшая
    отдаваться отчётом (расход обнулён/пересчитан Озоном), должна исчезнуть
    из окна, а не остаться от прошлого прогона. DELETE и INSERT — одна
    транзакция (get_connection коммитит на выходе): упавший прогон не
    оставляет дыру вместо данных."""
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    all_cols = ["cabinet_id"] + _OZ_SKU_AD_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _OZ_SKU_AD_COLS[1:] + ["updated_at"])
    sql = (f"INSERT INTO tenant.ozon_daily_sku_ad ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, date, campaign_id, sku) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _OZ_SKU_AD_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            if date_from and date_to:
                cur.execute(
                    "DELETE FROM tenant.ozon_daily_sku_ad "
                    "WHERE cabinet_id = %s AND date >= %s AND date <= %s",
                    [cid, date_from, date_to],
                )
            if batch:
                cur.executemany(sql, batch)
    return len(rows)
```

- [ ] **Step 2: Написать `recompute_ozon_daily_ad`**:

```python
def recompute_ozon_daily_ad(date_from, date_to):
    """Пересчёт товарных рекламных метрик tenant.ozon_daily_metrics
    (ad_spend/ad_views/ad_clicks/ad_orders) SQL-суммой из
    tenant.ozon_daily_sku_ad по (product_id, date) внутри окна. Колонки
    ad_* в ozon_daily_metrics никем больше не пишутся (ozon_metrics пишет
    только clicks/orders/cart — проверено grep 2026-08-21), владелец
    колонок — этот пересчёт. Сначала NULL-им ad_* всего окна (товар,
    выпавший из рекламы после пересборки, не должен возить старый расход),
    затем upsert свежих сумм; upsert, НЕ update-only — день с рекламой без
    заказов создаёт свою строку сам (грабля ozon_efficiency 2026-08-17).
    product_id IS NULL (не отрезолвленный sku) в товарные метрики не
    попадает — расход остаётся видимым в сыром слое и в кабинетном итоге."""
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE tenant.ozon_daily_metrics SET ad_spend=NULL, ad_views=NULL, "
                "ad_clicks=NULL, ad_orders=NULL, updated_at=%s "
                "WHERE cabinet_id = %s AND date >= %s AND date <= %s AND ad_spend IS NOT NULL",
                [now, cid, date_from, date_to],
            )
            cur.execute(
                "SELECT product_id, date::text AS d, SUM(spend) AS spend, "
                "SUM(views) AS views, SUM(clicks) AS clicks, SUM(ordered_units) AS ord "
                "FROM tenant.ozon_daily_sku_ad "
                "WHERE cabinet_id = %s AND product_id IS NOT NULL "
                "AND date >= %s AND date <= %s "
                "GROUP BY product_id, date",
                [cid, date_from, date_to],
            )
            sums = cur.fetchall()
            for r in sums:
                cur.execute(
                    "INSERT INTO tenant.ozon_daily_metrics "
                    "(cabinet_id, product_id, date, ad_spend, ad_views, ad_clicks, ad_orders, updated_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (cabinet_id, product_id, date) DO UPDATE SET "
                    "ad_spend=EXCLUDED.ad_spend, ad_views=EXCLUDED.ad_views, "
                    "ad_clicks=EXCLUDED.ad_clicks, ad_orders=EXCLUDED.ad_orders, "
                    "updated_at=EXCLUDED.updated_at",
                    [cid, r["product_id"], r["d"], r["spend"], r["views"], r["clicks"], r["ord"], now],
                )
    return len(sums)
```

⚠️ Перед записью сверить фактические имена/типы колонок `tenant.ozon_daily_metrics` (`psql … -Atc "SELECT column_name FROM information_schema.columns WHERE table_schema='tenant' AND table_name='ozon_daily_metrics'"`) — состав: cabinet_id, product_id, date, orders, clicks, cart, rating, price, revenue, ad_views, ad_clicks, ad_orders, ad_spend, updated_at. Если `updated_at` отсутствует в PK-upsert существующего `upsert_ozon_daily` (db_pg.py:1111-1126) — повторить его форму.

- [ ] **Step 3: Синтаксис**: `python3 -m py_compile worker/db_pg.py` → без ошибок.

- [ ] **Step 4: Commit**

```bash
git add worker/db_pg.py
git commit -m "feat(worker): запись ozon_daily_sku_ad + пересчёт товарных ad-метрик Ozon"
```

---

### Task 3: Сборщик worker/collectors/ozon_sku_ad.py

**Files:**
- Create: `worker/collectors/ozon_sku_ad.py`
- Modify: `worker/orchestrator.py:135-151` (список `OZON_COLLECTORS` — добавить `"ozon_sku_ad"` ПОСЛЕ `"ozon_efficiency"`; в `MAIN_COLLECTORS` run_saas_collect.sh НЕ добавлять — это задача 7)

**Interfaces:**
- Consumes: `db_pg.upsert_ozon_sku_ad_many`, `db_pg.recompute_ozon_daily_ad`, `db_pg.query`, `db_pg.init` (задача 2); env `OZON_PERF_CLIENT_ID/SECRET` (кладёт оркестратор, `_env_for_shop`); env `WB_SaaS_CABINET_ID` (читает db_pg).
- Produces: CLI `python3 worker/collectors/ozon_sku_ad.py [since] [to]` (ISO-даты, по умолчанию окно 14 дней, cap до вчера); exit 0 = ok, exit 3 = partial (какой-то чанк не собрался — окно НЕ записано).

- [ ] **Step 1: Написать сборщик** (полный файл; структура и грабли — по образцу `ozon_efficiency.py`, парсинг CSV — по пробе 2026-08-21):

```python
"""
SaaS-сборщик РЕКЛАМЫ OZON ПО ТОВАРАМ → tenant.ozon_daily_sku_ad (+ пересчёт
tenant.ozon_daily_metrics.ad_* по product_id).

Источник: Performance API, async-отчёт POST /api/client/statistics с
groupBy=DATE → poll → download ZIP (CSV на кампанию, строки день×sku,
колонка «Расход, ₽, с НДС»). Доказано живой пробой 2026-08-21: суммы по
(кампания, день) сходятся с tenant.ozon_daily_campaign_ad до копейки на
закрытых днях; расходятся законно: текущий день (растёт), ретро-ревизии
(лечится lookback-окном), строки «Корректировка» без даты/sku (остаются
только в кампанийном итоге).

⚠️ Скачивание готового отчёта ТРЕБУЕТ Authorization: Bearer — без него 401.
⚠️ OAuth: JSON-тело (basic auth = 401, грабля 2026-08-02).
⚠️ Окно дат ≤60 дней, кампаний в отчёте ≤10, паузы ≥2с, 429 → 65с.
Без perf-creds — мягкий skip (как ozon_efficiency).
Кампании берём из tenant.ozon_daily_campaign_ad (их ведёт ozon_efficiency) —
отдельного похода в /api/client/campaign не нужно, и мы заведомо запрашиваем
только кампании, у которых в окне был расход.
"""
import os
import io
import re
import csv
import sys
import time
import zipfile
import requests
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

HOST = "https://api-performance.ozon.ru"
CHUNK_DAYS = 60          # >61 дня — HTTP 400 (грабля ozon_efficiency)
CHUNK_CAMPAIGNS = 10     # лимит кампаний на один async-отчёт
SLEEP = 2.0              # пауза между HTTP-запросами
SLEEP_429 = 65.0
POLL_SLEEP = 5.0
POLL_MAX = 60            # ~5 минут на отчёт
_TOTAL_ROWS = ("всего", "итого")
_CORRECTION = "корректировка"
_DATE_DMY = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")


class PartialError(Exception):
    """Чанк не собрался — окно писать нельзя (иначе DELETE снесёт больше,
    чем INSERT вернёт). Прогон завершается exit 3, данные окна не трогаются."""


def _num(s):
    try:
        return float(str(s or "0").replace("\xa0", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return 0.0


def _norm_date(s):
    m = _DATE_DMY.match((s or "").strip())
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def _request(method, url, token, *, body=None, params=None, stream_bytes=False):
    """HTTP с паузой и одним повтором на 429. Возвращает Response.
    Ошибки != 200 после повтора → PartialError (не пишем окно молча)."""
    for attempt in (1, 2):
        time.sleep(SLEEP)
        if method == "get":
            r = requests.get(url, headers={"Authorization": f"Bearer {token}"},
                             params=params, timeout=120)
        else:
            r = requests.post(url, headers={"Authorization": f"Bearer {token}"},
                              json=body or {}, timeout=120)
        if r.status_code == 429 and attempt == 1:
            print(f"  429 на {url[-40:]} — пауза {SLEEP_429}с", flush=True)
            time.sleep(SLEEP_429)
            continue
        return r
    return r


def _token():
    perf_id = os.environ.get("OZON_PERF_CLIENT_ID")
    perf_secret = os.environ.get("OZON_PERF_CLIENT_SECRET")
    if not (perf_id and perf_secret):
        return None
    tr = requests.post(HOST + "/api/client/token",
                       json={"client_id": perf_id, "client_secret": perf_secret,
                             "grant_type": "client_credentials"}, timeout=30)
    if tr.status_code != 200:
        print(f"  Performance token HTTP {tr.status_code}: {tr.text[:120]}", flush=True)
        return None
    return tr.json().get("access_token")


def _campaigns_in_window(since_s, to_s):
    rows = db_pg.query(
        "SELECT DISTINCT campaign_id FROM tenant.ozon_daily_campaign_ad "
        "WHERE date >= %s AND date <= %s AND spend > 0 ORDER BY campaign_id",
        (since_s, to_s))
    return [str(r["campaign_id"]) for r in rows]


def _fetch_report(token, campaign_ids, since_s, to_s):
    """create → poll → download → список членов ZIP [(имя, текст)].
    Любой сбой → PartialError."""
    r = _request("post", HOST + "/api/client/statistics", token,
                 body={"campaigns": campaign_ids, "dateFrom": since_s,
                       "dateTo": to_s, "groupBy": "DATE"})
    if r.status_code != 200:
        raise PartialError(f"create HTTP {r.status_code}: {r.text[:120]}")
    uuid = (r.json() or {}).get("UUID")
    if not uuid:
        raise PartialError(f"create без UUID: {r.text[:120]}")
    link = None
    for _ in range(POLL_MAX):
        time.sleep(POLL_SLEEP)
        p = _request("get", f"{HOST}/api/client/statistics/{uuid}", token)
        if p.status_code != 200:
            raise PartialError(f"poll HTTP {p.status_code}")
        data = p.json() or {}
        state = (data.get("state") or "").upper()
        if state == "OK":
            link = data.get("link")
            break
        if state in ("ERROR", "FAILED"):
            raise PartialError(f"отчёт {uuid} state={state}")
    if not link:
        raise PartialError(f"отчёт {uuid} не готов за {POLL_MAX * POLL_SLEEP:.0f}с")
    d = _request("get", link if link.startswith("http") else HOST + link, token)
    if d.status_code != 200:
        raise PartialError(f"download HTTP {d.status_code}")
    content = d.content
    if content[:2] != b"PK":
        # Один CSV без архива (одна кампания) — API так тоже умеет.
        return [("single.csv", content.decode("utf-8-sig", errors="replace"))]
    zf = zipfile.ZipFile(io.BytesIO(content))
    return [(n, zf.read(n).decode("utf-8-sig", errors="replace")) for n in zf.namelist()]


def _parse_member(name, text, sku_to_pid, counters):
    """CSV одной кампании → строки для upsert. campaign_id — из имени файла."""
    m = re.match(r"^(\d+)_", name)
    if not m:
        counters["bad_member"] += 1
        return []
    campaign_id = int(m.group(1))
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    hdr_i = None
    for i, row in enumerate(rows[:5]):
        low = [c.strip().lower() for c in row]
        if "sku" in low and any("расход" in c for c in low):
            hdr_i = i
            break
    if hdr_i is None:
        counters["no_header"] += 1
        return []
    headers = [c.strip().lower() for c in rows[hdr_i]]
    def col(pred):
        for i, h in enumerate(headers):
            if pred(h):
                return i
        return None
    day_i = col(lambda h: h in ("день", "дата"))
    sku_i = col(lambda h: h == "sku")
    spend_i = col(lambda h: "расход" in h)
    views_i = col(lambda h: h == "показы")
    clicks_i = col(lambda h: h == "клики")
    sold_i = col(lambda h: h.startswith("продано товаров") and "модели" not in h)
    osum_i = col(lambda h: h.startswith("заказано на сумму"))
    if day_i is None or sku_i is None or spend_i is None:
        counters["no_header"] += 1
        return []
    out = []
    for row in rows[hdr_i + 1:]:
        if len(row) <= max(day_i, sku_i, spend_i):
            continue
        first = (row[0] or "").strip().lower()
        if first.startswith(_CORRECTION):
            counters["correction_sum"] += _num(row[spend_i])
            continue
        if any(first.startswith(t) for t in _TOTAL_ROWS):
            continue
        d = _norm_date(row[day_i])
        if not d:
            continue
        sku = (row[sku_i] or "").strip()
        if not sku:
            continue
        pid = sku_to_pid.get(sku)
        if pid is None:
            counters["unresolved_sku"] += 1
        out.append({
            "date": d, "campaign_id": campaign_id, "sku": sku, "product_id": pid,
            "spend": _num(row[spend_i]),
            "views": int(_num(row[views_i])) if views_i is not None and views_i < len(row) else None,
            "clicks": int(_num(row[clicks_i])) if clicks_i is not None and clicks_i < len(row) else None,
            "ordered_units": int(_num(row[sold_i])) if sold_i is not None and sold_i < len(row) else None,
            "ordered_amount": _num(row[osum_i]) if osum_i is not None and osum_i < len(row) else None,
        })
    return out


def _sku_map():
    rows = db_pg.query(
        "SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL", ())
    return {str(r["fbo_sku"]): r["product_id"] for r in rows}


def collect(since=None, to=None):
    print("[ozon_sku_ad] реклама Ozon по товарам", flush=True)
    db_pg.init()
    yesterday = datetime.now() - timedelta(days=1)
    if to is None or to > yesterday:
        to = yesterday          # текущий день не пишем — растёт внутри дня
    if since is None:
        since = datetime.now() - timedelta(days=14)
    token = _token()
    if not token:
        print("  Performance credentials нет/токен не получен — skip "
              "(товарная реклама не обновится в этом прогоне)", flush=True)
        return 0
    sku_to_pid = _sku_map()
    all_rows = []
    counters = {"bad_member": 0, "no_header": 0, "unresolved_sku": 0, "correction_sum": 0.0}
    win_start = since
    while win_start <= to:
        win_end = min(win_start + timedelta(days=CHUNK_DAYS - 1), to)
        s, e = win_start.strftime("%Y-%m-%d"), win_end.strftime("%Y-%m-%d")
        campaigns = _campaigns_in_window(s, e)
        print(f"  окно {s}..{e}: кампаний со spend>0: {len(campaigns)}", flush=True)
        for i in range(0, len(campaigns), CHUNK_CAMPAIGNS):
            chunk = campaigns[i:i + CHUNK_CAMPAIGNS]
            members = _fetch_report(token, chunk, s, e)
            for name, text in members:
                all_rows.extend(_parse_member(name, text, sku_to_pid, counters))
        win_start = win_end + timedelta(days=1)
    since_s, to_s = since.strftime("%Y-%m-%d"), to.strftime("%Y-%m-%d")
    n = db_pg.upsert_ozon_sku_ad_many(all_rows, since_s, to_s)
    m = db_pg.recompute_ozon_daily_ad(since_s, to_s)
    # Видимые счётчики — не молчим (урок «молчаливое падение очистки»).
    if counters["unresolved_sku"]:
        print(f"  ⚠️ sku без товара в каталоге: {counters['unresolved_sku']} строк "
              f"(spend остаётся в сыром слое и кабинетном итоге)", flush=True)
    if counters["no_header"] or counters["bad_member"]:
        print(f"  ⚠️ членов ZIP без разбора: no_header={counters['no_header']} "
              f"bad_member={counters['bad_member']}", flush=True)
    if counters["correction_sum"]:
        print(f"  «Корректировка» (без даты/sku, в товары не пишется): "
              f"{counters['correction_sum']:.2f} ₽", flush=True)
    print(f"[ozon_sku_ad] записано строк {n}, товар-дней пересчитано {m}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        collect(datetime.fromisoformat(s) if s else None,
                datetime.fromisoformat(t) if t else None)
    except PartialError as e:
        print(f"[ozon_sku_ad] PARTIAL: {e} — окно НЕ записано", flush=True)
        sys.exit(3)
```

- [ ] **Step 2: Синтаксис**: `python3 -m py_compile worker/collectors/ozon_sku_ad.py` → без ошибок.

- [ ] **Step 3: Регистрация в оркестраторе** — в `worker/orchestrator.py`, список `OZON_COLLECTORS` (строки 135-151): добавить `"ozon_sku_ad",` строкой сразу после `"ozon_efficiency",` с комментарием `# товарная реклама (миграция 043); в расписании (MAIN_COLLECTORS) — после шлюза владельца`. `GUARD_DEPS` НЕ трогать (зависимость от кампанийной таблицы мягкая — при пустом окне сборщик просто запросит 0 кампаний). ⚠️ В `worker/run_saas_collect.sh` НИЧЕГО не менять в этой задаче.

- [ ] **Step 4: Commit**

```bash
git add worker/collectors/ozon_sku_ad.py worker/orchestrator.py
git commit -m "feat(worker): сборщик ozon_sku_ad — реклама Ozon товар×день из Performance API"
```

---

### Task 4: Прогон на кабинете 1 + сторож check-ozon-sku-ad.mjs

**Files:**
- Create: `scripts/check-ozon-sku-ad.mjs`
- Modify: `deploy/systemd/saas-ozon-recon.service:30-43` (добавить вызов нового чека)

**Interfaces:**
- Consumes: `readonlyPgConfig()` из `scripts/lib/pgpass.mjs` (образец: `scripts/check-wb-return-cogs.mjs:36-55`); данные задачи 3.
- Produces: `node scripts/check-ozon-sku-ad.mjs [--cabinet N]` — exit 0 PASS / 1 FAIL.

- [ ] **Step 1: Ручной прогон сборщика на кабинете 1** (окно 14 дней). Сборщик запускается только с кредами кабинета из оркестратора; команду для запуска строит контролёр по образцу onboarding/backfill-прогона оркестратора (тот же механизм, которым 2026-08-21 гонялся полный прогон кабинета 1). Если классификатор заблокирует запуск — отдать команду владельцу через `!` и дождаться (НЕ обходить).

Expected (stdout): `окно …: кампаний со spend>0: N` (N≥3 для каб.1), `записано строк …`, `товар-дней пересчитано …`, без `PARTIAL`.

- [ ] **Step 2: SQL-сверка результата** (под saas_ro, явный cabinet_id):

```bash
psql -h localhost -U saas_ro -d saas -Atc "
SELECT s.campaign_id, s.date, round(s.sku_sum,2), round(c.spend,2), round(s.sku_sum - c.spend,2)
FROM (SELECT campaign_id, date, SUM(spend) AS sku_sum
      FROM tenant.ozon_daily_sku_ad WHERE cabinet_id=1 GROUP BY 1,2) s
JOIN tenant.ozon_daily_campaign_ad c
  ON c.cabinet_id=1 AND c.campaign_id=s.campaign_id AND c.date=s.date
ORDER BY abs(s.sku_sum - c.spend) DESC LIMIT 10"
```
Expected: |Δ| в пределах допуска (корректировки/ревизии), большинство строк 0.00. Также `SELECT count(*) FROM tenant.ozon_daily_metrics WHERE cabinet_id=1 AND ad_spend IS NOT NULL` > 0.

- [ ] **Step 3: Написать сторож** `scripts/check-ozon-sku-ad.mjs` (подключение/CLI/вывод — скопировать каркас из `check-wb-return-cogs.mjs`; кабинеты по умолчанию 1 и 1008). Два чека за 4 последние ЗАКРЫТЫЕ ISO-недели (понедельник-воскресенье, не включая текущую):

```
Check 1 (кампания×день): Σ ozon_daily_sku_ad.spend ПРОТИВ ozon_daily_campaign_ad.spend
  по каждой паре (campaign_id, date), где есть хоть одна из сторон.
  Допуск: |Δ| <= max(0.01 * campaign_ad.spend, 50) — корректировки и кампании
  без товарной разбивки живут только в кампанийной таблице, поэтому
  sku_sum <= campaign.spend + допуск; sku_sum ЗАМЕТНО БОЛЬШЕ кампании — всегда FAIL.
Check 2 (день, товарный слой): Σ ozon_daily_metrics.ad_spend по товарам за день
  <= Σ ozon_daily_campaign_ad.spend за день + допуск (тот же max(1%, 50₽)).
PASS/FAIL печатать по строкам с цифрами (как в остальных чеках), exit 1 при любом FAIL.
```
Каждый SQL — с явным `WHERE cabinet_id = $1` (saas_ro BYPASSRLS).

- [ ] **Step 4: Прогнать сторож**: `node scripts/check-ozon-sku-ad.mjs --cabinet 1` → PASS (кабинет 1008 до бэкфилла задачи 5 даст «нет данных» — это должен быть PASS с пометкой «нет строк — сборщик ещё не гонялся», не FAIL).

- [ ] **Step 5: Добавить чек в `deploy/systemd/saas-ozon-recon.service`** рядом с существующими вызовами (строки 30-43), той же формой (`set +e`, вклад в общий rc): `/usr/bin/node scripts/check-ozon-sku-ad.mjs`. Затем `systemctl daemon-reload`.

- [ ] **Step 6: Общие сторожа**: `node scripts/check-profit-canon.mjs` (оба кабинета) и `node scripts/profit-snapshot.mjs --verify` → ALL PASS (канон ещё не менялся — падения здесь означали бы, что сбор данных что-то задел; это баг).

- [ ] **Step 7: Commit**

```bash
git add scripts/check-ozon-sku-ad.mjs deploy/systemd/saas-ozon-recon.service
git commit -m "feat(recon): сторож рекламы Ozon по товарам + прогон каб.1"
```

---

### Task 5: Бэкфилл истории (кабинеты 1 и 1008)

**Files:** нет новых (прогоны существующего кода).

- [ ] **Step 1: Определить глубину истории**: `psql -h localhost -U saas_ro -d saas -Atc "SELECT cabinet_id, min(date), max(date) FROM tenant.ozon_daily_campaign_ad GROUP BY 1"` — бэкфилл от min(date) каждого кабинета (кампании раньше этой даты неизвестны и не запросить).

- [ ] **Step 2: Прогоны сборщика** на кабинетах 1 и 1008 от min(date) до вчера (сборщик сам порежет на окна ≤60 дней; запуск — тем же механизмом, что задача 4 Step 1; 1009 в паузе ключей — не трогать). Если старые окна Performance API не отдаёт (create/поll вернёт ошибку) — сборщик выйдет с PARTIAL: перезапустить с более поздней даты начала, зафиксировать фактическую глубину в отчёте задачи.

Expected: оба прогона без PARTIAL (или с зафиксированной фактической глубиной), счётчики `unresolved_sku`/«Корректировка» в логе осмысленные.

- [ ] **Step 3: Сторожа после бэкфилла**: `node scripts/check-ozon-sku-ad.mjs --cabinet 1` и `--cabinet 1008` → PASS; `node scripts/profit-snapshot.mjs --verify` → PASS (прибыль ещё не должна сдвинуться — канон не менялся).

- [ ] **Step 4: Зафиксировать в отчёте задачи**: фактическая глубина истории по кабинетам, суммарный spend в `ozon_daily_sku_ad` за июль-2026 кабинета 1 против `ozon_daily_campaign_ad` (одно число к другому, % покрытия товарной разбивкой).

---

### Task 6: Канон обеих площадок + дельта для шлюза владельца

**Files:**
- Modify: `lib/ozonMetrics.js` (~строки 110-146 `ozAdSpend` + 255-260 `ozProfitProduct` + устаревшие комментарии 111-119, 182-192)
- Modify: `lib/wbMetrics.js` (~строки 292-314 `wbAdTotal` + 437-446 `wbProfitProduct`)
- Modify: `scripts/check-profit-canon.mjs` (инвариант №5 обеих площадок: ~строки 55-73, 100-105, 320-330, 517-523)
- Create: `/tmp/claude-0/…/scratchpad/sku-ads-delta.mjs` (одноразовый дельта-скрипт, в git НЕ коммитится)

**Interfaces:**
- Consumes: `daily_metrics.ad_spend` (Ozon — задача 5; WB — уже есть), сигнатуры канона.
- Produces: `ozProfitProduct(db, taxMode, period, productId).ads` = реальный расход товара (было 0); симметрично WB. Сигнатуры функций НЕ меняются.

- [ ] **Step 1: Ozon** — в `lib/ozonMetrics.js` добавить в `ozAdSpend` третий режим (по товару) и переключить `ozProfitProduct`:

```js
// В ozAdSpend({ from, to, groupByProduct, productId }): если productId != null —
export async function ozAdSpend(db, { from, to, groupByProduct = false, productId = null } = {}) {
  if (productId != null) {
    const r = await db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(ad_spend),0) FROM daily_metrics
                 WHERE date >= ? AND date <= ? AND product_id = ?
                 AND ad_spend IS NOT NULL) AS s`
      )
      .get(from, to.slice(0, 10), productId);
    return round2((r && r.s) || 0);
  }
  // …остальные две ветки без изменений…
}
```

В `ozProfitProduct` (строка 257):
```js
  const ads = productId == null
    ? await ozAdSpend(db, { from, to })
    : await ozAdSpend(db, { from, to, productId });
```
Обновить комментарии: блок 111-119 («Пер-товарного расхода у Ozon НЕТ» → есть с 2026-08-21, источник `ozon_daily_sku_ad` → `daily_metrics.ad_spend`, миграция 043) и блок 182-192 (ads при товарном фильтре = реальный расход товара; Σ ads(товар) ≤ ads(кабинета) на корректировки и кампании без товарной разбивки — «нераспределённый остаток» вычитается только на кабинете).

- [ ] **Step 2: WB** — симметрично в `lib/wbMetrics.js`: в `wbAdTotal` добавить режим `nmId` (тот же SQL с `nm_id = ?`), в `wbProfitProduct` (строка 439):
```js
  const ads = nmId == null
    ? await wbAdTotal(db, { from, to })
    : await wbAdTotal(db, { from, to, nmId });
```
(налоговая база `expenses` в обеих функциях уже включает `ads` — не трогать; под usn_income налог от расходов не зависит).

- [ ] **Step 3: check-profit-canon.mjs, инвариант №5 обеих площадок** — новая формула (и докстроки строк 55-73 / 100-105 переписать под неё):

```
Σ profit(товар) − (ads(кабинет) − Σ ads(товар)) = profit(без фильтра), допуск прежний.
```
В коде: суммировать `profitProduct(pid).ads` по товарам в тот же проход, где суммируется profit; строка результата должна печатать все три числа (Σ profit, Σ ads по товарам, ads кабинета).

- [ ] **Step 4: Прогнать сторожа НА НОВОМ КОДЕ** (check-скрипты читают lib/ прямо из репо — деплой панели не нужен): `node scripts/check-profit-canon.mjs` для кабинетов 1 и 1008 → ALL PASS. Это главная проверка новой формулы до деплоя.

- [ ] **Step 5: Дельта-скрипт для шлюза** — одноразовый `sku-ads-delta.mjs` в scratchpad (подключение к БД скопировать из check-profit-canon.mjs). Для кабинета 1, периоды июль-2026 и август-2026 (по вчера), каждая площадка отдельно:
  - Σ ads(товар) за период — ровно настолько уменьшится Σ прибыли по товарам;
  - топ-10 товаров по рекламе: name, adSpend, profit ДО (ads=0) и ПОСЛЕ;
  - контрольное: pnl-прибыль кабинета (канон Cabinet) ДО и ПОСЛЕ — обязана совпасть до копейки (кабинетная формула не менялась).

- [ ] **Step 6: СТОП — шлюз владельца.** Показать владельцу дельту (таблицы из Step 5) и дождаться явного «да». БЕЗ одобрения задачу 7 не начинать, панель не деплоить, коммит канона не пушить в расписание. Коммит в master сделать можно (панель живёт на build-артефакте, репозиторий не деплоит сам):

```bash
git add lib/ozonMetrics.js lib/wbMetrics.js scripts/check-profit-canon.mjs
git commit -m "feat(canon): реклама вычитается из прибыли товара на обеих площадках"
```

---

### Task 7: После «да» владельца — деплой панели, Сводка, расписание, доки

**Files:**
- Modify: `app/cabinets/[id]/summary/SummaryPage.jsx` (~строки 191-235 `filteredTotals`, 294-315 плитки, ~472-479 tfoot)
- Modify: `worker/run_saas_collect.sh:42` (`MAIN_COLLECTORS`)
- Modify: `docs/metrics-contract.md`

**Interfaces:**
- Consumes: item.profit из products-summary теперь включает рекламу товара; item.adSpend — реальный расход; totals.adSpend — кабинетный.

- [ ] **Step 1: Сводка — пересчёт итогов** (`filteredTotals`, строки 204-235): добавить в аккумулятор `ft.adSpend += i.adSpend || 0;`, и заменить вычет (строки 228-229):

```js
    const fullAd = data?.totals?.adSpend || 0;
    // item.profit теперь ВКЛЮЧАЕТ рекламу самого товара (канон 2026-08-21).
    // Без фильтра доводим до серверного totals.profit, вычитая только
    // НЕРАСПРЕДЕЛЁННУЮ часть кабинетной рекламы (корректировки + кампании
    // без товарной разбивки): fullAd − Σ item.adSpend.
    if (!hasProductFilter) ft.profit = round2(ft.profit - Math.max(0, round2(fullAd - ft.adSpend)));
```
Комментарий блока 185-203 переписать под новую композицию.

- [ ] **Step 2: Тултипы** (строки 294-315 и tfoot ~472-479) — заменить тексты:
  - Плитка «Прибыль»: с фильтром — `"По выбранным товарам, включая их рекламу; нераспределённая кабинетная реклама (корректировки, кампании без товарной разбивки) не вычитается"`; без фильтра — `"Вкл. вычет всей рекламы кабинета за период (реклама товаров — в их прибыли, остаток — кабинетный)"`.
  - Плитка «Реклама, ₽»: `"Вся реклама кабинета за период; товарная часть видна в колонке «Реклама, ₽» таблицы"`.
  - tfoot рекламной ячейки — аналогично плитке.
  - Плитку «ДРР (общий)» не менять.

- [ ] **Step 3: Деплой панели**: `npm run build && systemctl restart saas-web`. Smoke: `node scripts/profit-snapshot.mjs --verify` → ALL PASS (шлюзовые pnl-числа кабинета обязаны не сдвинуться); `node scripts/check-profit-canon.mjs` оба кабинета → PASS; глазами (curl или браузер владельца) — Сводка кабинета 1: у Ozon-товаров ненулевая «Реклама, ₽» и ДРР.

- [ ] **Step 4: Включить сборщик в расписание** — `worker/run_saas_collect.sh:42`: добавить `,ozon_sku_ad` в конец `MAIN_COLLECTORS` (урок: регистрация = orchestrator И run_saas_collect.sh — вторая половина именно здесь).

- [ ] **Step 5: docs/metrics-contract.md** — новый подраздел «Реклама по товарам»: источник Ozon (`ozon_daily_sku_ad` → `daily_metrics.ad_spend`, миграция 043, отчёт Performance groupBy=DATE), формула прибыли товара обеих площадок (ads вычитается с 2026-08-21, решение владельца), инвариант Σ ads(товар) ≤ ads(кабинета) и почему (корректировки, нетоварные кампании), политика окна (14 дней lookback, текущий день не пишется).

- [ ] **Step 6: Commit**

```bash
git add app/cabinets/[id]/summary/SummaryPage.jsx worker/run_saas_collect.sh docs/metrics-contract.md
git commit -m "feat(panel): реклама в прибыли товара + ozon_sku_ad в расписании"
```

---

## Self-review (выполнено при написании)

- Покрытие спеки: сборщик (T3), таблица+политики (T1), пересчёт товарных метрик (T2), lookback/бэкфилл (T3/T5), канон обеих площадок + инвариант №5 (T6), Сводка/тултипы (T7), сторож+recon (T4), контракт (T7), шлюз владельца (T6 Step 6), расписание в конце (T7 Step 4). Непокрытых требований спеки нет.
- Типы согласованы: `sku` TEXT (fbo_sku), `product_id` BIGINT NULL; сигнатуры канона не меняются, добавлены только опции `productId`/`nmId`.
- Плейсхолдеров нет; единственные «уточнить по месту» — форма tenant_iso-политики (копия из 041) и фактические колонки ozon_daily_metrics (проверка перед правкой) — оба шага содержат команду проверки.
