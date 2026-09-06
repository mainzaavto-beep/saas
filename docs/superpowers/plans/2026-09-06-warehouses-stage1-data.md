# Склады 2.0 — этап 1 «Данные»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать в БД всё, что нужно этапам 2–4: склады продавца WB/Ozon, их FBS-остатки, штрихкоды WB, `warehouse_id` у FBS-заданий WB, поставки Ozon на FBO, и дать владельцу привязать склад МП к месту хранения.

**Architecture:** Новые Python-сборщики по образцу `wb_supplies`/`ozon_stocks` пишут в новые tenant-таблицы через `worker/db_pg.py`; регистрация в `orchestrator.py` **и** `run_saas_collect.sh`. Панель: расширение существующего API/UI «📍 Места» на `/inventory`. Проверка — живой API кабинета #1 в режиме `SAAS_PROBE` и sql-сторож.

**Tech Stack:** Python 3 (requests, psycopg3) в `/opt/agents/data-presenter-agent/.venv/bin/python`; PostgreSQL 16 с RLS; Next.js 14 (App Router), React; node:test для lib.

**Spec:** `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md` (разделы 1, 2, 6, этап 1 раздела 7).

## Global Constraints

- Все пробы, прогоны сборщиков и ручные проверки в БД — **только кабинет #1** (`--cabinet 1`). Кабинет #1008 и прочие — боевые клиенты, не трогать.
- Чтение БД: `psql -h localhost -U saas_ro -d saas -Atc "…"` (под `saas_ro` RLS не скоупит — всегда `WHERE cabinet_id = 1`). Запись/миграции: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`.
- Регистрация сборщика = **и** список `WB_COLLECTORS`/`OZON_COLLECTORS` в `worker/orchestrator.py`, **и** нужная переменная режима в `worker/run_saas_collect.sh`. Одного без другого недостаточно.
- Мягкая деградация: API недоступен → сборщик печатает `ПРОПУСК`, возвращает 0, `exit 0`. Не роняет прогон.
- Каждая новая tenant-таблица: RLS-политика `tenant_iso_<table>` для `saas_app` + `panel_local_ro_cab1` для `panel_local_ro`; GRANT'ы как в миграции 049.
- Прогон сборщика: `cd /opt/agents/saas && /opt/agents/data-presenter-agent/.venv/bin/python worker/run_orchestrator.py` **не** подходит для одиночного (он `--all`). Одиночный прогон: см. команду `ORCH` ниже.
- `npm run build && systemctl restart saas-web` только в конце (задача 13); `next dev` в каталоге прода запрещён.
- Коммиты: `git add` только явным списком файлов. Никаких `git add -A`/`git add .`.

Команда одиночного прогона сборщика (далее `ORCH`), env берётся как в `run_saas_collect.sh`:

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && \
SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas \
/opt/agents/data-presenter-agent/.venv/bin/python -m worker.orchestrator \
  --cabinet 1 --collectors <имя> --date-from 2026-09-04 --date-to 2026-09-06 --run-kind manual
```

Проба без записи в БД: та же команда с префиксом `SAAS_PROBE=1` (задача 2 пробрасывает переменную в subprocess).

## Что вскрыл осмотр 06.09 (влияет на задачи)

| Факт | Следствие |
|---|---|
| `wb_daily_stock` кабинета #1 с 01.09 — одна строка «Склад WB», `warehouse_id=-999999` | Вариант 1 спеки §2.2 (FBS в stocks-report) не работает; берём marketplace-api `POST /api/v3/stocks/{warehouseId}` по штрихкодам (задача 6) |
| Штрихкоды в `wb_orders` есть лишь у 65 из 151 артикулов | Нужна `tenant.wb_barcodes` из Content API `sizes[].skus`, заполняет `wb_catalog` (задача 3) |
| `ozon_orders` FBS: `warehouse_id` заполнен 3/3 с 01.08 | Правка сборщика по §2.5 не нужна, только сторож (задача 12) |
| Лента `/api/v3/orders` WB тем короче, чем дальше `dateFrom` (90 д → 0 заданий, проба 05.09) | Бэкфилл `warehouse_id` заданий — только окно 30 дн; старые задания остаются с NULL (честно) |
| `SAFE_INHERIT` в оркестраторе не пропускает произвольные env в subprocess | Флаг пробы `SAAS_PROBE` пробрасывается явно, как `SAAS_RUN_KIND` (задача 2) |
| В `stock_ff_locations` кабинета #1 два места: «ФФ Руслан» (ff), «Склад Пушкино» (stock) | Есть на чём проверить привязку (задача 11) |

## File Structure

| Файл | Ответственность |
|---|---|
| `db/migrations/052_warehouses_stage1.sql` | Все DDL этапа 1 (идемпотентно) |
| `worker/orchestrator.py` | Проброс `SAAS_PROBE`; регистрация новых сборщиков |
| `worker/run_saas_collect.sh` | Режимы `references`/`stocks`/`main` знают новые сборщики |
| `worker/collectors/_probe.py` | Хелпер режима пробы: `is_probe()`, `dump(label, obj, n=3)` |
| `worker/collectors/wb_catalog.py` | + разбор `sizes[].skus` → `wb_barcodes` |
| `worker/collectors/ozon_client.py` | + `warehouse_list`, `stocks_by_warehouse_fbs`, `iter_supply_order_ids`, `supply_order_get`, `supply_order_bundle_items` |
| `worker/collectors/wb_seller_warehouses.py` | `/api/v3/warehouses` → `mp_seller_warehouses` (wb) |
| `worker/collectors/ozon_seller_warehouses.py` | `/v1/warehouse/list` → `mp_seller_warehouses` (ozon) |
| `worker/collectors/wb_fbs_stocks.py` | `/api/v3/stocks/{wid}` → `mp_fbs_daily_stock` (wb); режим `SAAS_PROBE=verify` — сверка с БД |
| `worker/collectors/ozon_fbs_stocks.py` | `stocks-by-warehouse/fbs` → `mp_fbs_daily_stock` (ozon); режим `verify` |
| `worker/collectors/ozon_supply_orders.py` | supply-order list/get/bundle → `ozon_supply_orders(+items)` |
| `worker/db_pg.py` | upsert'ы новых таблиц; `warehouse_id` в карте `wb_fbs_tasks` |
| `lib/locationsLink.js` | Чистая валидация тела `locations/update` (тестируется node:test) |
| `app/api/cabinets/[id]/inventory/route.js` | GET: новые поля мест + `sellerWarehouses`; POST `locations` op `update` |
| `app/cabinets/[id]/inventory/InventoryPage.jsx` | `LocationsManager`: привязка складов, город, активность, список непривязанных |
| `scripts/test-wb-barcodes-parse.py`, `scripts/test-ozon-client-warehouses.py`, `scripts/test-fbs-stocks-parse.py`, `scripts/test-ozon-supply-orders-parse.py` | Синтетические тесты чистых функций (без сети/БД, стиль `test-ozon-accruals-pagination.py`) |
| `lib/__tests__/locationsLink.test.mjs` | node:test для валидации |
| `scripts/check-warehouses-stage1.sql` | SQL-сторож этапа (все `ok=t`) |
| `AGENTS.md`, спека §2.2 | Результаты проб, новые таблицы/сборщики |

---

### Task 1: Миграция 052 — схема этапа 1

**Files:**
- Create: `db/migrations/052_warehouses_stage1.sql`

**Interfaces:**
- Produces: таблицы `tenant.mp_seller_warehouses`, `tenant.mp_fbs_daily_stock`, `tenant.wb_barcodes`, `tenant.ozon_supply_orders`, `tenant.ozon_supply_order_items`; колонки `stock_ff_locations.{wb_warehouse_id, ozon_warehouse_id, city, is_active}`, `wb_fbs_tasks.warehouse_id`.

- [ ] **Step 1: Написать миграцию**

```sql
-- 052_warehouses_stage1.sql — Склады 2.0, этап 1 «Данные»
-- (спека docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md, §1–2).
-- Места хранения привязываются к складам продавца WB/Ozon; справочник этих
-- складов и их FBS-остатки собираются с МП; штрихкоды WB нужны для
-- marketplace-api /api/v3/stocks; warehouse_id у FBS-заданий — для авто-списания
-- (этап 2); поставки Ozon на FBO — для этапа 3. Идемпотентно.
BEGIN;

-- 1.1 места хранения ↔ склады продавца на МП
ALTER TABLE tenant.stock_ff_locations ADD COLUMN IF NOT EXISTS wb_warehouse_id   BIGINT;
ALTER TABLE tenant.stock_ff_locations ADD COLUMN IF NOT EXISTS ozon_warehouse_id BIGINT;
ALTER TABLE tenant.stock_ff_locations ADD COLUMN IF NOT EXISTS city              TEXT;
ALTER TABLE tenant.stock_ff_locations ADD COLUMN IF NOT EXISTS is_active         BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS stock_ff_locations_wb_wh_uq
    ON tenant.stock_ff_locations (cabinet_id, wb_warehouse_id) WHERE wb_warehouse_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_ff_locations_ozon_wh_uq
    ON tenant.stock_ff_locations (cabinet_id, ozon_warehouse_id) WHERE ozon_warehouse_id IS NOT NULL;

-- 1.2 справочник складов продавца (WB /api/v3/warehouses, Ozon /v1/warehouse/list)
CREATE TABLE IF NOT EXISTS tenant.mp_seller_warehouses (
    cabinet_id    BIGINT  NOT NULL,
    platform      TEXT    NOT NULL CHECK (platform IN ('wb','ozon')),
    warehouse_id  BIGINT  NOT NULL,
    name          TEXT    NOT NULL,
    kind          TEXT,                                   -- wb: deliveryType; ozon: fbs|rfbs
    is_active     BOOLEAN NOT NULL DEFAULT true,          -- false, если склад пропал из ответа МП
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, platform, warehouse_id)
);

-- 2.1 дневной снимок FBS-остатков складов продавца
CREATE TABLE IF NOT EXISTS tenant.mp_fbs_daily_stock (
    cabinet_id   BIGINT  NOT NULL,
    platform     TEXT    NOT NULL CHECK (platform IN ('wb','ozon')),
    warehouse_id BIGINT  NOT NULL,
    sku_key      BIGINT  NOT NULL,                        -- wb: nm_id; ozon: product_id
    date         DATE    NOT NULL,
    present      INTEGER,
    reserved     INTEGER,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, platform, warehouse_id, sku_key, date)
);
CREATE INDEX IF NOT EXISTS mp_fbs_daily_stock_date_idx ON tenant.mp_fbs_daily_stock (cabinet_id, date);

-- 2.2 штрихкоды WB (Content API cards sizes[].skus) — ключ /api/v3/stocks
CREATE TABLE IF NOT EXISTS tenant.wb_barcodes (
    cabinet_id BIGINT NOT NULL,
    barcode    TEXT   NOT NULL,
    nm_id      BIGINT NOT NULL,
    chrt_id    BIGINT,
    tech_size  TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, barcode)
);
CREATE INDEX IF NOT EXISTS wb_barcodes_nm_idx ON tenant.wb_barcodes (cabinet_id, nm_id);

-- 2.5 склад продавца у FBS-задания (marketplace-api /api/v3/orders → warehouseId)
ALTER TABLE tenant.wb_fbs_tasks ADD COLUMN IF NOT EXISTS warehouse_id BIGINT;

-- 2.6 поставки Ozon на FBO (/v2/supply-order/list + /get + /v1/supply-order/bundle)
CREATE TABLE IF NOT EXISTS tenant.ozon_supply_orders (
    cabinet_id          BIGINT NOT NULL,
    order_id            BIGINT NOT NULL,
    number              TEXT,
    state               TEXT,
    created_at          TIMESTAMPTZ,
    timeslot_from       TIMESTAMPTZ,
    timeslot_to         TIMESTAMPTZ,
    dest_warehouse_id   BIGINT,
    dest_warehouse_name TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, order_id)
);
CREATE TABLE IF NOT EXISTS tenant.ozon_supply_order_items (
    cabinet_id   BIGINT  NOT NULL,
    order_id     BIGINT  NOT NULL,
    sku          BIGINT  NOT NULL,
    product_id   BIGINT,
    qty_declared INTEGER,
    qty_accepted INTEGER,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, order_id, sku)
);

-- RLS + гранты для всех новых таблиц (образец: миграция 049)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['mp_seller_warehouses','mp_fbs_daily_stock','wb_barcodes',
                           'ozon_supply_orders','ozon_supply_order_items'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='tenant_iso_'||t) THEN
      EXECUTE format($p$CREATE POLICY %I ON tenant.%I FOR ALL TO saas_app
                       USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                       WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)$p$, 'tenant_iso_'||t, t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='panel_local_ro_cab1') THEN
      EXECUTE format('CREATE POLICY panel_local_ro_cab1 ON tenant.%I FOR SELECT TO panel_local_ro USING (cabinet_id = 1)', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.%I TO saas_app', t);
    EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
  END LOOP;
END $$;

COMMIT;
```

- [ ] **Step 2: Применить на проде и проверить идемпотентность (дважды)**

Run:
```bash
cd /opt/agents/saas && for i in 1 2; do PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/052_warehouses_stage1.sql; done
```
Expected: оба раза `BEGIN … COMMIT` без ошибок.

- [ ] **Step 3: Проверить схему**

Run:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT table_name FROM information_schema.tables WHERE table_schema='tenant' AND table_name IN ('mp_seller_warehouses','mp_fbs_daily_stock','wb_barcodes','ozon_supply_orders','ozon_supply_order_items') ORDER BY 1; SELECT column_name FROM information_schema.columns WHERE table_schema='tenant' AND table_name='stock_ff_locations' AND column_name IN ('wb_warehouse_id','ozon_warehouse_id','city','is_active'); SELECT COUNT(*) FROM pg_policies WHERE schemaname='tenant' AND tablename IN ('mp_seller_warehouses','mp_fbs_daily_stock','wb_barcodes','ozon_supply_orders','ozon_supply_order_items')"
```
Expected: 5 таблиц, 4 колонки, `10` политик.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/052_warehouses_stage1.sql
git commit -m "feat(warehouses): миграция 052 — склады продавца, FBS-остатки, штрихкоды WB, поставки Ozon"
```

---

### Task 2: Режим пробы `SAAS_PROBE` в оркестраторе

**Files:**
- Modify: `worker/orchestrator.py:376-382` (функция `_env_for_shop`, рядом с `SAAS_RUN_KIND`)
- Create: `worker/collectors/_probe.py`

**Interfaces:**
- Produces: `_probe.is_probe() -> bool` (`SAAS_PROBE` непустой), `_probe.mode() -> str` (`''`, `'1'` или `'verify'`), `_probe.dump(label, obj, n=3)` печатает первые `n` элементов списка (или сам объект) как JSON с `ensure_ascii=False`.

- [ ] **Step 1: Хелпер**

```python
# worker/collectors/_probe.py
"""Режим пробы сборщиков: SAAS_PROBE=1 — печатать сырой ответ API и НЕ писать в БД;
SAAS_PROBE=verify — сверить ответ API с БД (реализуют сборщики остатков).
Переменную пробрасывает orchestrator._env_for_shop (whitelist SAFE_INHERIT её не
пропускает). Живая проба = только кабинет #1."""
import json
import os


def mode() -> str:
    return (os.getenv("SAAS_PROBE") or "").strip().lower()


def is_probe() -> bool:
    return mode() != ""


def dump(label, obj, n=3):
    sample = obj[:n] if isinstance(obj, list) else obj
    total = f" (всего {len(obj)})" if isinstance(obj, list) else ""
    print(f"[probe] {label}{total}: {json.dumps(sample, ensure_ascii=False, default=str)[:4000]}", flush=True)
```

- [ ] **Step 2: Проброс в env subprocess'а**

В `_env_for_shop` после строки `env["SAAS_RUN_KIND"] = RUN_KIND` добавить:

```python
    # Режим пробы (задача 2 плана «Склады 2.0, этап 1»): SAAS_PROBE=1|verify —
    # сборщик печатает сырой ответ / сверяет с БД и НЕ пишет. Не секрет,
    # whitelist SAFE_INHERIT не трогаем — пробрасываем явно, как SAAS_RUN_KIND.
    if os.environ.get("SAAS_PROBE"):
        env["SAAS_PROBE"] = os.environ["SAAS_PROBE"]
```

- [ ] **Step 3: Проверить, что переменная доходит**

Run:
```bash
cd /opt/agents/saas && /opt/agents/data-presenter-agent/.venv/bin/python -c "
import os; os.environ['SAAS_PROBE']='1'
import worker.orchestrator as o
env,_ = o._env_for_shop({'mp_code':'wb','api_creds':{'wb':{'token':'x'}},'api_creds_enc':None})
print(env.get('SAAS_PROBE'))"
```
Expected: `1`.

- [ ] **Step 4: Commit**

```bash
git add worker/orchestrator.py worker/collectors/_probe.py
git commit -m "feat(worker): режим пробы SAAS_PROBE для сборщиков (без записи в БД)"
```

---

### Task 3: Штрихкоды WB из карточек → `wb_barcodes`

**Files:**
- Modify: `worker/collectors/wb_catalog.py` (функции `fetch_all_cards`, `collect`)
- Modify: `worker/db_pg.py` (после `upsert_article`)
- Create: `scripts/test-wb-barcodes-parse.py`

**Interfaces:**
- Produces: `wb_catalog.parse_card_barcodes(card: dict) -> list[dict]` (`{"barcode","nm_id","chrt_id","tech_size"}`), `db_pg.upsert_wb_barcodes_many(rows) -> int`.

- [ ] **Step 1: Тест разбора**

```python
#!/usr/bin/env python3
"""Разбор штрихкодов из карточки Content API (sizes[].skus). Без сети и БД."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import wb_catalog as m

card = {"nmID": 111, "sizes": [
    {"chrtID": 1, "techSize": "0", "skus": ["2000000000012", "2000000000029"]},
    {"chrtID": 2, "techSize": "M", "skus": []},
    {"chrtID": 3},
]}
rows = m.parse_card_barcodes(card)
assert rows == [
    {"barcode": "2000000000012", "nm_id": 111, "chrt_id": 1, "tech_size": "0"},
    {"barcode": "2000000000029", "nm_id": 111, "chrt_id": 1, "tech_size": "0"},
], rows
assert m.parse_card_barcodes({"nmID": 5}) == []
assert m.parse_card_barcodes({"nmID": 5, "sizes": None}) == []
print("OK: 3 проверки")
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-wb-barcodes-parse.py`
Expected: `AttributeError: module 'wb_catalog' has no attribute 'parse_card_barcodes'`.

- [ ] **Step 3: Реализация**

В `wb_catalog.py` добавить функцию (перед `fetch_all_cards`):

```python
def parse_card_barcodes(card: dict) -> list[dict]:
    """Штрихкоды карточки: sizes[].skus (Content API v2). Один nm_id → много
    штрихкодов (размеры/цвета). Нужны marketplace-api /api/v3/stocks/{warehouseId}
    (FBS-остатки складов продавца, план «Склады 2.0, этап 1», задача 6)."""
    nm = card.get("nmID")
    out = []
    for s in card.get("sizes") or []:
        for bc in s.get("skus") or []:
            if bc:
                out.append({"barcode": str(bc), "nm_id": nm,
                            "chrt_id": s.get("chrtID"), "tech_size": s.get("techSize")})
    return out
```

В `fetch_all_cards` в словарь `result.append({...})` добавить ключ `"barcodes": parse_card_barcodes(c),`.

В `collect()` после цикла `upsert_article` добавить:

```python
    barcodes = [b for c in cards for b in c.get("barcodes") or []]
    n_bc = db_pg.upsert_wb_barcodes_many(barcodes)
    print(f"[wb_catalog] штрихкодов {n_bc} → tenant.wb_barcodes", flush=True)
```

В `db_pg.py` после `upsert_article`:

```python
def upsert_wb_barcodes_many(rows):
    """Штрихкоды карточек WB (Content API sizes[].skus) → tenant.wb_barcodes.
    Ключ /api/v3/stocks/{warehouseId} (FBS-остатки складов продавца)."""
    return _batch_upsert("wb_barcodes", ["barcode"], ["barcode", "nm_id", "chrt_id", "tech_size"], rows)
```

- [ ] **Step 4: Тест проходит**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-wb-barcodes-parse.py`
Expected: `OK: 3 проверки`.

- [ ] **Step 5: Живой прогон каталога на кабинете #1 и проверка покрытия**

Run: `ORCH` с `--collectors wb_catalog`, затем:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT COUNT(*) AS barcodes, COUNT(DISTINCT nm_id) AS nm_with_bc, (SELECT COUNT(*) FROM tenant.wb_articles WHERE cabinet_id=1) AS articles FROM tenant.wb_barcodes WHERE cabinet_id=1"
```
Expected: `nm_with_bc` ≥ 140 из 151 (карточки без размеров/штрихкодов возможны, но их единицы). Если `nm_with_bc` < 100 — остановиться и посмотреть сырой ответ (`SAAS_PROBE=1` пока не поддерживается в `wb_catalog`; напечатать `cards[0]["sizes"]` временным `print` и убрать).

- [ ] **Step 6: Commit**

```bash
git add worker/collectors/wb_catalog.py worker/db_pg.py scripts/test-wb-barcodes-parse.py
git commit -m "feat(wb_catalog): штрихкоды карточек → tenant.wb_barcodes"
```

---

### Task 4: Методы Ozon-клиента: склады продавца, FBS-остатки, заказы на поставку

**Files:**
- Modify: `worker/collectors/ozon_client.py` (после `cluster_list`, раздел «СПРАВОЧНИКИ»)
- Create: `scripts/test-ozon-client-warehouses.py`

**Interfaces:**
- Produces:
  - `OzonClient.warehouse_list() -> list[dict]` — `/v1/warehouse/list`;
  - `OzonClient.stocks_by_warehouse_fbs(skus: list[int], chunk=100) -> list[dict]` — `/v1/product/info/stocks-by-warehouse/fbs`, склейка пачек;
  - `OzonClient.iter_supply_order_ids(limit=100) -> Iterator[int]` — `/v2/supply-order/list`, курсор `last_supply_order_id`;
  - `OzonClient.supply_order_get(order_ids: list[int]) -> dict` — `/v2/supply-order/get` (пачки ≤ 50, склейка `orders` и `warehouses`);
  - `OzonClient.supply_order_bundle_items(bundle_ids: list[str]) -> list[dict]` — `/v1/supply-order/bundle`, пагинация `last_id`/`has_next`.

- [ ] **Step 1: Тест (фейковый `_post`, стиль `test-ozon-accruals-pagination.py`)**

```python
#!/usr/bin/env python3
"""Методы OzonClient для складов продавца / FBS-остатков / заказов на поставку.
Без сети и БД: _post подменяется, проверяются пачки и курсоры."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import ozon_client as oc

oc.time.sleep = lambda s: None


def make_client(handler):
    cli = oc.OzonClient.__new__(oc.OzonClient)
    cli.host = "test"
    calls = []
    def fake_post(host, path, body=None, *a, **k):
        calls.append((path, dict(body or {})))
        return handler(path, body or {}, len(calls))
    cli._post = fake_post
    return cli, calls

ok = 0

# 1) warehouse_list: список складов без обёртки
cli, calls = make_client(lambda p, b, n: [{"warehouse_id": 1, "name": "A", "is_rfbs": False}])
assert cli.warehouse_list() == [{"warehouse_id": 1, "name": "A", "is_rfbs": False}]
assert calls[0][0] == "/v1/warehouse/list"
ok += 1

# 2) stocks_by_warehouse_fbs: 250 sku → 3 пачки по 100, результат склеен
def h2(p, b, n):
    assert p == "/v1/product/info/stocks-by-warehouse/fbs", p
    return [{"sku": s, "present": 1, "reserved": 0, "warehouse_id": 7} for s in b["sku"]]
cli, calls = make_client(h2)
res = cli.stocks_by_warehouse_fbs(list(range(250)))
assert len(res) == 250 and [len(c[1]["sku"]) for c in calls] == [100, 100, 50], calls
assert all(isinstance(s, str) for s in calls[0][1]["sku"]), "sku в теле — строки"
ok += 1

# 3) iter_supply_order_ids: две страницы по курсору last_supply_order_id
pages = [
    {"supply_order_id": [10, 11], "last_supply_order_id": 11},
    {"supply_order_id": [12], "last_supply_order_id": 12},
    {"supply_order_id": [], "last_supply_order_id": 12},
]
cli, calls = make_client(lambda p, b, n: pages[n - 1])
ids = list(cli.iter_supply_order_ids(limit=2))
assert ids == [10, 11, 12], ids
assert calls[0][1]["paging"]["from_supply_order_id"] == 0
assert calls[1][1]["paging"]["from_supply_order_id"] == 11, calls[1]
ok += 1

# 4) supply_order_get: 120 id → 3 запроса по 50, orders и warehouses склеены
def h4(p, b, n):
    assert p == "/v2/supply-order/get"
    return {"orders": [{"supply_order_id": i} for i in b["order_ids"]],
            "warehouses": [{"warehouse_id": 100 + n, "name": f"w{n}"}]}
cli, calls = make_client(h4)
res = cli.supply_order_get(list(range(120)))
assert len(res["orders"]) == 120 and len(res["warehouses"]) == 3, res
assert [len(c[1]["order_ids"]) for c in calls] == [50, 50, 20]
ok += 1

# 5) supply_order_bundle_items: пагинация has_next/last_id
pages5 = [
    {"items": [{"sku": 1, "quantity": 5}], "has_next": True, "last_id": "x"},
    {"items": [{"sku": 2, "quantity": 3}], "has_next": False, "last_id": ""},
]
cli, calls = make_client(lambda p, b, n: pages5[n - 1])
items = cli.supply_order_bundle_items(["b1"])
assert [i["sku"] for i in items] == [1, 2], items
assert "last_id" not in calls[0][1] and calls[1][1]["last_id"] == "x", calls
ok += 1

print(f"OK: {ok} проверок")
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-ozon-client-warehouses.py`
Expected: `AttributeError: 'OzonClient' object has no attribute 'warehouse_list'`.

- [ ] **Step 3: Реализация (в класс `OzonClient`, после `cluster_list`)**

```python
    # --- СКЛАДЫ ПРОДАВЦА / FBS-ОСТАТКИ / ЗАКАЗЫ НА ПОСТАВКУ (план «Склады 2.0», этап 1) ---

    def warehouse_list(self) -> list:
        """Склады продавца (FBS/rFBS): POST /v1/warehouse/list, тело пустое.
        _request снимает обёртку result → список {warehouse_id, name, is_rfbs, status, ...}."""
        res = self._post(self.host, "/v1/warehouse/list", {})
        return res if isinstance(res, list) else (res or {}).get("result") or []

    def stocks_by_warehouse_fbs(self, skus: list, chunk: int = 100) -> list:
        """FBS-остатки по складам продавца: POST /v1/product/info/stocks-by-warehouse/fbs,
        тело {sku:[str]}. Пачки по chunk (лимит эндпоинта уточняется пробой, при 400 —
        уменьшить). Ответ: [{sku, present, reserved, warehouse_id, warehouse_name, product_id}]."""
        out = []
        for i in range(0, len(skus), chunk):
            if i:
                time.sleep(REQUEST_PAUSE_SEC)
            part = [str(s) for s in skus[i:i + chunk]]
            res = self._post(self.host, "/v1/product/info/stocks-by-warehouse/fbs", {"sku": part})
            rows = res if isinstance(res, list) else (res or {}).get("result") or []
            out.extend(rows)
        return out

    def iter_supply_order_ids(self, limit: int = 100) -> Iterator[int]:
        """Заказы на поставку FBO: POST /v2/supply-order/list, курсор
        paging.from_supply_order_id ← last_supply_order_id. Все состояния."""
        cursor = 0
        while True:
            res = self._post(self.host, "/v2/supply-order/list", {
                "filter": {"states": []},
                "paging": {"from_supply_order_id": cursor, "limit": limit},
            }) or {}
            ids = res.get("supply_order_id") or []
            for i in ids:
                yield int(i)
            last = res.get("last_supply_order_id")
            if not ids or not last or int(last) == cursor:
                break
            cursor = int(last)
            time.sleep(REQUEST_PAUSE_SEC)

    def supply_order_get(self, order_ids: list, chunk: int = 50) -> dict:
        """POST /v2/supply-order/get по пачкам ≤ chunk. Возвращает {orders: [...], warehouses: [...]}
        со склейкой всех пачек."""
        orders, warehouses = [], []
        for i in range(0, len(order_ids), chunk):
            if i:
                time.sleep(REQUEST_PAUSE_SEC)
            res = self._post(self.host, "/v2/supply-order/get",
                             {"order_ids": [int(x) for x in order_ids[i:i + chunk]]}) or {}
            orders.extend(res.get("orders") or [])
            warehouses.extend(res.get("warehouses") or [])
        return {"orders": orders, "warehouses": warehouses}

    def supply_order_bundle_items(self, bundle_ids: list, limit: int = 100) -> list:
        """Состав поставки: POST /v1/supply-order/bundle, пагинация last_id/has_next.
        Ответ: items [{sku, quantity, offer_id, ...}]."""
        out, last_id = [], None
        while True:
            body = {"bundle_ids": list(bundle_ids), "limit": limit}
            if last_id:
                body["last_id"] = last_id
            res = self._post(self.host, "/v1/supply-order/bundle", body) or {}
            out.extend(res.get("items") or [])
            if not res.get("has_next") or not res.get("last_id"):
                break
            last_id = res["last_id"]
            time.sleep(REQUEST_PAUSE_SEC)
        return out
```

- [ ] **Step 4: Тест проходит**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-ozon-client-warehouses.py`
Expected: `OK: 5 проверок`.

- [ ] **Step 5: Commit**

```bash
git add worker/collectors/ozon_client.py scripts/test-ozon-client-warehouses.py
git commit -m "feat(ozon_client): склады продавца, FBS-остатки по складам, заказы на поставку"
```

---

### Task 5: Сборщики справочника складов продавца → `mp_seller_warehouses`

**Files:**
- Create: `worker/collectors/wb_seller_warehouses.py`, `worker/collectors/ozon_seller_warehouses.py`
- Modify: `worker/db_pg.py` (после `upsert_wb_fbs_tasks_many`), `worker/orchestrator.py:170-205` (списки), `worker/run_saas_collect.sh:63` (`REFERENCES_COLLECTORS`)

**Interfaces:**
- Consumes: `OzonClient.warehouse_list()` (задача 4), `_probe` (задача 2).
- Produces: `db_pg.upsert_mp_seller_warehouses(platform, rows) -> int` (rows: `{"warehouse_id","name","kind"}`; склады платформы, отсутствующие в `rows`, получают `is_active=false`); `db_pg.seller_warehouse_ids(platform) -> list[int]` (активные).

- [ ] **Step 1: db_pg**

```python
# --- mp_seller_warehouses (склады продавца WB/Ozon, план «Склады 2.0», этап 1) ---
def upsert_mp_seller_warehouses(platform, rows):
    """rows: [{warehouse_id, name, kind}]. Присутствующие → is_active=true,
    last_seen_at=now(); отсутствующие в ответе МП склады той же платформы → is_active=false
    (склад удалён/скрыт в кабинете). first_seen_at не затирается."""
    cid = _cabinet_id()
    ids = [int(r["warehouse_id"]) for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO tenant.mp_seller_warehouses "
                "(cabinet_id, platform, warehouse_id, name, kind, is_active, last_seen_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, true, now(), now()) "
                "ON CONFLICT (cabinet_id, platform, warehouse_id) DO UPDATE SET "
                "name=EXCLUDED.name, kind=EXCLUDED.kind, is_active=true, last_seen_at=now(), updated_at=now()",
                [[cid, platform, int(r["warehouse_id"]), r.get("name") or str(r["warehouse_id"]), r.get("kind")]
                 for r in rows])
            cur.execute(
                "UPDATE tenant.mp_seller_warehouses SET is_active=false, updated_at=now() "
                "WHERE cabinet_id=%s AND platform=%s AND is_active AND NOT (warehouse_id = ANY(%s))",
                (cid, platform, ids))
    return len(rows)


def seller_warehouse_ids(platform):
    rows = query("SELECT warehouse_id FROM tenant.mp_seller_warehouses "
                 "WHERE platform=%s AND is_active ORDER BY warehouse_id", (platform,))
    return [int(r["warehouse_id"]) for r in rows]
```

- [ ] **Step 2: Сборщик WB**

```python
"""
SaaS-сборщик СКЛАДОВ ПРОДАВЦА WB → tenant.mp_seller_warehouses (platform='wb').

marketplace-api GET /api/v3/warehouses → [{id, officeId, name, cargoType, deliveryType}]
(10 складов у кабинета #1, проба 27.08.2026). Нужен привязке «склад МП → место
хранения» (спека «Склады 2.0» §1.2) и сборщику wb_fbs_stocks. Почти статичен —
тик references (weekly) + онбординг. Аргументы дат игнорируются.
SAAS_PROBE=1 — печатает ответ и не пишет.
"""
import os
import sys
import time
from datetime import datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe

WB_TOKEN = os.getenv("WB_TOKEN")
WAREHOUSES_URL = "https://marketplace-api.wildberries.ru/api/v3/warehouses"
MAX_ATTEMPTS = 4


def _get(url):
    """GET с ретраями на 429/5xx; None при недоступности (не роняем прогон)."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(url, headers={"Authorization": WB_TOKEN}, timeout=60)
        except requests.RequestException as e:
            print(f"  сеть ({attempt}/{MAX_ATTEMPTS}): {e}", flush=True)
            time.sleep(2 * attempt)
            continue
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "10") or 10)
            time.sleep(min(wait, 60))
            continue
        if resp.status_code >= 500:
            time.sleep(2 * attempt)
            continue
        print(f"  ОШИБКА {resp.status_code}: {resp.text[:200]}", flush=True)
        return None
    return None


def parse_warehouses(data) -> list[dict]:
    """[{id, name, deliveryType}] → [{warehouse_id, name, kind}]."""
    out = []
    for w in data or []:
        if w.get("id") is None:
            continue
        out.append({"warehouse_id": int(w["id"]), "name": w.get("name") or str(w["id"]),
                    "kind": str(w.get("deliveryType")) if w.get("deliveryType") is not None else None})
    return out


def collect():
    print(f"[wb_seller_warehouses] склады продавца WB ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_seller_warehouses] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    data = _get(WAREHOUSES_URL)
    if data is None:
        print("[wb_seller_warehouses] ПРОПУСК: API недоступен (exit 0)", flush=True)
        return 0
    if _probe.is_probe():
        _probe.dump("GET /api/v3/warehouses", data, n=10)
        return 0
    db_pg.init()
    rows = parse_warehouses(data)
    written = db_pg.upsert_mp_seller_warehouses("wb", rows)
    print(f"[wb_seller_warehouses] складов {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 3: Сборщик Ozon**

```python
"""
SaaS-сборщик СКЛАДОВ ПРОДАВЦА Ozon → tenant.mp_seller_warehouses (platform='ozon').

POST /v1/warehouse/list → [{warehouse_id, name, is_rfbs, status, ...}]. kind:
'rfbs' если is_rfbs, иначе 'fbs'. Тик references (weekly) + онбординг. Аргументы
дат игнорируются. SAAS_PROBE=1 — печатает ответ и не пишет.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe
from ozon_client import OzonClient, OzonError


def parse_warehouses(data) -> list[dict]:
    out = []
    for w in data or []:
        if w.get("warehouse_id") is None:
            continue
        out.append({"warehouse_id": int(w["warehouse_id"]),
                    "name": w.get("name") or str(w["warehouse_id"]),
                    "kind": "rfbs" if w.get("is_rfbs") else "fbs"})
    return out


def collect():
    print(f"[ozon_seller_warehouses] склады продавца Ozon ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    cli = OzonClient()
    try:
        data = cli.warehouse_list()
    except OzonError as e:
        print(f"[ozon_seller_warehouses] ПРОПУСК: Ozon API недоступен ({e}) (exit 0)", flush=True)
        return 0
    if _probe.is_probe():
        _probe.dump("POST /v1/warehouse/list", data, n=10)
        return 0
    db_pg.init()
    rows = parse_warehouses(data)
    written = db_pg.upsert_mp_seller_warehouses("ozon", rows)
    print(f"[ozon_seller_warehouses] складов {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 4: Регистрация**

`worker/orchestrator.py`: в `WB_COLLECTORS` после `"wb_references",` добавить `"wb_seller_warehouses",  # склады продавца → tenant.mp_seller_warehouses (references + онбординг)`; в `OZON_COLLECTORS` после `"ozon_references",` добавить `"ozon_seller_warehouses",`.

`worker/run_saas_collect.sh`: `REFERENCES_COLLECTORS="wb_references,ozon_references,wb_seller_warehouses,ozon_seller_warehouses"`.

- [ ] **Step 5: Проба, затем боевой прогон на кабинете #1**

Run: `SAAS_PROBE=1 ORCH --collectors wb_seller_warehouses,ozon_seller_warehouses`
Expected: в логе `[probe] GET /api/v3/warehouses (всего 10): [...]` и `[probe] POST /v1/warehouse/list (...)`. Если у Ozon поля называются иначе (нет `warehouse_id`/`name`/`is_rfbs`) — поправить `parse_warehouses` по дампу.

Run: `ORCH --collectors wb_seller_warehouses,ozon_seller_warehouses`, затем:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT platform, COUNT(*), COUNT(*) FILTER (WHERE is_active) FROM tenant.mp_seller_warehouses WHERE cabinet_id=1 GROUP BY 1"
```
Expected: `wb|10|10` (по пробе 27.08) и `ozon|N|N`, N ≥ 1.

- [ ] **Step 6: Commit**

```bash
git add worker/collectors/wb_seller_warehouses.py worker/collectors/ozon_seller_warehouses.py worker/db_pg.py worker/orchestrator.py worker/run_saas_collect.sh
git commit -m "feat(warehouses): справочник складов продавца WB/Ozon → tenant.mp_seller_warehouses"
```

---

### Task 6: Сборщик FBS-остатков WB → `mp_fbs_daily_stock`

**Files:**
- Create: `worker/collectors/wb_fbs_stocks.py`, `scripts/test-fbs-stocks-parse.py`
- Modify: `worker/db_pg.py`, `worker/orchestrator.py` (`WB_COLLECTORS`), `worker/run_saas_collect.sh:56` (`STOCKS_COLLECTORS`)

**Interfaces:**
- Consumes: `db_pg.seller_warehouse_ids("wb")` (задача 5), `tenant.wb_barcodes` (задача 3), `_probe`.
- Produces: `wb_fbs_stocks.aggregate(warehouse_id, stocks, barcode2nm, today) -> list[dict]` (строки `{"platform","warehouse_id","sku_key","date","present","reserved"}`), `db_pg.upsert_mp_fbs_stock_many(rows) -> int`, `db_pg.wb_barcode_map() -> dict[str,int]` (штрихкод → nm_id из `wb_barcodes` ∪ `wb_orders`).

- [ ] **Step 1: Тест агрегации**

```python
#!/usr/bin/env python3
"""Агрегация FBS-остатков WB/Ozon в строки mp_fbs_daily_stock. Без сети и БД."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import wb_fbs_stocks as wb

bc = {"200001": 11, "200002": 11, "200003": 22}
rows = wb.aggregate(500, [{"sku": "200001", "amount": 3}, {"sku": "200002", "amount": 2},
                          {"sku": "200003", "amount": 0}, {"sku": "999", "amount": 9}], bc, "2026-09-06")
assert sorted(rows, key=lambda r: r["sku_key"]) == [
    {"platform": "wb", "warehouse_id": 500, "sku_key": 11, "date": "2026-09-06", "present": 5, "reserved": None},
    {"platform": "wb", "warehouse_id": 500, "sku_key": 22, "date": "2026-09-06", "present": 0, "reserved": None},
], rows
assert wb.aggregate(500, [], bc, "2026-09-06") == []
print("OK: wb 2 проверки")

try:
    import ozon_fbs_stocks as oz
except ImportError:
    oz = None
if oz:
    sku2pid = {700: 1001, 701: 1002}
    rows = oz.rows_from_result([
        {"sku": 700, "warehouse_id": 5, "present": 4, "reserved": 1},
        {"sku": "701", "warehouse_id": 5, "present": 0, "reserved": 0},
        {"sku": 702, "warehouse_id": 5, "present": 9, "reserved": 0},   # нет в каталоге
        {"sku": 700, "warehouse_id": None, "present": 1},                # без склада
    ], sku2pid, "2026-09-06")
    assert rows == [
        {"platform": "ozon", "warehouse_id": 5, "sku_key": 1001, "date": "2026-09-06", "present": 4, "reserved": 1},
        {"platform": "ozon", "warehouse_id": 5, "sku_key": 1002, "date": "2026-09-06", "present": 0, "reserved": 0},
    ], rows
    print("OK: ozon 1 проверка")
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-fbs-stocks-parse.py`
Expected: `ModuleNotFoundError: No module named 'wb_fbs_stocks'`.

- [ ] **Step 3: db_pg**

```python
# --- mp_fbs_daily_stock (FBS-остатки складов продавца, план «Склады 2.0», этап 1) ---
_MP_FBS_STOCK_COLS = ["platform", "warehouse_id", "sku_key", "date", "present", "reserved"]


def upsert_mp_fbs_stock_many(rows):
    return _batch_upsert("mp_fbs_daily_stock", ["platform", "warehouse_id", "sku_key", "date"],
                         _MP_FBS_STOCK_COLS, rows)


def wb_barcode_map():
    """штрихкод → nm_id: карточки (wb_barcodes) ∪ заказы (wb_orders.barcode, на случай
    карточек без размеров). Карточки приоритетнее."""
    m = {}
    for r in query("SELECT DISTINCT barcode, nm_id FROM tenant.wb_orders "
                   "WHERE barcode IS NOT NULL AND nm_id IS NOT NULL"):
        m[str(r["barcode"])] = int(r["nm_id"])
    for r in query("SELECT barcode, nm_id FROM tenant.wb_barcodes"):
        m[str(r["barcode"])] = int(r["nm_id"])
    return m


def mp_fbs_stock_today(platform, date):
    """(warehouse_id, sku_key) → present за дату — для SAAS_PROBE=verify."""
    return {(int(r["warehouse_id"]), int(r["sku_key"])): r["present"]
            for r in query("SELECT warehouse_id, sku_key, present FROM tenant.mp_fbs_daily_stock "
                           "WHERE platform=%s AND date=%s", (platform, date))}
```

- [ ] **Step 4: Сборщик**

```python
"""
SaaS-сборщик FBS-ОСТАТКОВ складов продавца WB → tenant.mp_fbs_daily_stock (platform='wb').

Почему не stocks-report: с 01.09.2026 stocks-report/wb-warehouses отдаёт кабинету #1
одну строку «Склад WB» (warehouse_id=-999999) — WB скрыл разбивку по складам,
складов продавца там нет (осмотр 06.09). Поэтому marketplace-api:
  POST /api/v3/stocks/{warehouseId}  body {skus:[штрихкоды]} (≤1000 за запрос)
  → {stocks:[{sku, amount}]}. Штрихкод → nm_id по tenant.wb_barcodes ∪ wb_orders,
суммируем по nm_id (размеры/цвета). Склады — активные tenant.mp_seller_warehouses
(wb_seller_warehouses, тик references). Тик stocks (08:00), снимок «на сейчас».

SAAS_PROBE=1 — печатает ответ первого склада, не пишет.
SAAS_PROBE=verify — сверяет ответ API с сегодняшним снимком в БД (Δ по строкам),
exit 1 при расхождении (сторож §6 спеки). Мягкая деградация как у wb_stocks.
"""
import os
import sys
import time
from datetime import date, datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe

WB_TOKEN = os.getenv("WB_TOKEN")
STOCKS_URL = "https://marketplace-api.wildberries.ru/api/v3/stocks/{wid}"
CHUNK = 1000
MAX_ATTEMPTS = 4


def _post(url, body):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.post(url, headers={"Authorization": WB_TOKEN}, json=body, timeout=60)
        except requests.RequestException as e:
            print(f"  сеть ({attempt}/{MAX_ATTEMPTS}): {e}", flush=True)
            time.sleep(2 * attempt)
            continue
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "10") or 10)
            time.sleep(min(wait, 60))
            continue
        if resp.status_code >= 500:
            time.sleep(2 * attempt)
            continue
        print(f"  ОШИБКА {resp.status_code}: {resp.text[:200]}", flush=True)
        return None
    return None


def fetch_warehouse_stocks(wid, barcodes):
    """Все пачки одного склада. None — если хоть одна пачка недоступна."""
    out = []
    for i in range(0, len(barcodes), CHUNK):
        data = _post(STOCKS_URL.format(wid=wid), {"skus": barcodes[i:i + CHUNK]})
        if data is None:
            return None
        out.extend(data.get("stocks") or [])
        time.sleep(0.3)
    return out


def aggregate(warehouse_id, stocks, barcode2nm, today):
    """[{sku, amount}] → строки mp_fbs_daily_stock, сумма amount по nm_id.
    Штрихкоды, которых нет в карте, пропускаются (лог — в collect)."""
    acc = {}
    for s in stocks or []:
        nm = barcode2nm.get(str(s.get("sku")))
        if nm is None:
            continue
        acc[nm] = acc.get(nm, 0) + int(s.get("amount") or 0)
    return [{"platform": "wb", "warehouse_id": int(warehouse_id), "sku_key": nm, "date": today,
             "present": qty, "reserved": None} for nm, qty in acc.items()]


def collect():
    today = date.today().isoformat()
    print(f"[wb_fbs_stocks] FBS-остатки складов продавца на {today} ({datetime.now():%H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_fbs_stocks] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    db_pg.init()
    wids = db_pg.seller_warehouse_ids("wb")
    if not wids:
        print("[wb_fbs_stocks] ПРОПУСК: нет складов продавца (сначала wb_seller_warehouses)", flush=True)
        return 0
    bc = db_pg.wb_barcode_map()
    barcodes = sorted(bc)
    if not barcodes:
        print("[wb_fbs_stocks] ПРОПУСК: нет штрихкодов (сначала wb_catalog)", flush=True)
        return 0
    rows, unknown = [], 0
    for wid in wids:
        stocks = fetch_warehouse_stocks(wid, barcodes)
        if stocks is None:
            print(f"[wb_fbs_stocks] ПРОПУСК: API недоступен на складе {wid}, снимок не записан (exit 0)", flush=True)
            return 0
        if _probe.mode() == "1":
            _probe.dump(f"POST /api/v3/stocks/{wid}", stocks, n=5)
            return 0
        unknown += sum(1 for s in stocks if str(s.get("sku")) not in bc)
        rows.extend(aggregate(wid, stocks, bc, today))
    if _probe.mode() == "verify":
        db_rows = db_pg.mp_fbs_stock_today("wb", today)
        api = {(r["warehouse_id"], r["sku_key"]): r["present"] for r in rows}
        diff = [(k, api.get(k), db_rows.get(k)) for k in set(api) | set(db_rows) if api.get(k) != db_rows.get(k)]
        print(f"[wb_fbs_stocks] verify: api={len(api)} db={len(db_rows)} Δ={len(diff)} {diff[:10]}", flush=True)
        sys.exit(1 if diff else 0)
    n = db_pg.upsert_mp_fbs_stock_many(rows)
    print(f"[wb_fbs_stocks] складов {len(wids)}, строк {n}"
          + (f", неизвестных штрихкодов {unknown}" if unknown else ""), flush=True)
    print(f"##OBS rows={n}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 5: Тест проходит (часть wb)**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-fbs-stocks-parse.py`
Expected: `OK: wb 2 проверки` (часть ozon пропускается до задачи 7).

- [ ] **Step 6: Регистрация**

`orchestrator.py` `WB_COLLECTORS`: после `"wb_stocks",` добавить `"wb_fbs_stocks",   # FBS-остатки складов продавца → tenant.mp_fbs_daily_stock (тик stocks)`.
`run_saas_collect.sh`: `STOCKS_COLLECTORS="wb_stocks,ozon_stocks,wb_fbs_stocks"` (ozon добавится в задаче 7).

- [ ] **Step 7: Проба → прогон → сверка с живым API**

Run: `SAAS_PROBE=1 ORCH --collectors wb_fbs_stocks` — ожидается `[probe] POST /api/v3/stocks/<id> (всего N): [{"sku": "...", "amount": ...}]`. Если тело ответа другое (не `stocks[].sku/amount`) — поправить `aggregate` и фикстуру теста по дампу.

Run: `ORCH --collectors wb_fbs_stocks`, затем `SAAS_PROBE=verify ORCH --collectors wb_fbs_stocks`.
Expected: `verify: … Δ=0`, код возврата сборщика 0. Проверка в БД:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT warehouse_id, COUNT(*), SUM(present) FROM tenant.mp_fbs_daily_stock WHERE cabinet_id=1 AND platform='wb' AND date=current_date GROUP BY 1 ORDER BY 3 DESC"
```
Expected: строки по складам продавца; хотя бы у одного `SUM(present) > 0` (у кабинета #1 FBS работает с 28.07). Если везде нули — сверить с ЛК WB, а не считать успехом.

- [ ] **Step 8: Commit**

```bash
git add worker/collectors/wb_fbs_stocks.py worker/db_pg.py worker/orchestrator.py worker/run_saas_collect.sh scripts/test-fbs-stocks-parse.py
git commit -m "feat(warehouses): FBS-остатки складов продавца WB → tenant.mp_fbs_daily_stock"
```

---

### Task 7: Сборщик FBS-остатков Ozon → `mp_fbs_daily_stock`

**Files:**
- Create: `worker/collectors/ozon_fbs_stocks.py`
- Modify: `worker/orchestrator.py` (`OZON_COLLECTORS`), `worker/run_saas_collect.sh` (`STOCKS_COLLECTORS`)

**Interfaces:**
- Consumes: `OzonClient.stocks_by_warehouse_fbs(skus)` (задача 4), `db_pg.upsert_mp_fbs_stock_many`, `db_pg.mp_fbs_stock_today` (задача 6), `_probe`.
- Produces: `ozon_fbs_stocks.rows_from_result(result, sku2pid, today) -> list[dict]` (контракт в тесте задачи 6).

- [ ] **Step 1: Сборщик**

```python
"""
SaaS-сборщик FBS-ОСТАТКОВ складов продавца Ozon → tenant.mp_fbs_daily_stock (platform='ozon').

POST /v1/product/info/stocks-by-warehouse/fbs {sku:[...]} → [{sku, warehouse_id,
warehouse_name, present, reserved, product_id}]. sku = ozon_products.fbo_sku
(с 2024 у Ozon единый sku для FBO/FBS). Пачки по 100 (OzonClient). Тик stocks (08:00).
SAAS_PROBE=1 — дамп без записи; SAAS_PROBE=verify — сверка с сегодняшним снимком, exit 1 при Δ.
Мягкая деградация как у ozon_stocks.
"""
import os
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe
from ozon_client import OzonClient, OzonError


def rows_from_result(result, sku2pid, today):
    """Строки снимка: только sku из каталога и с warehouse_id."""
    out = []
    for r in result or []:
        sku, wid = r.get("sku"), r.get("warehouse_id")
        if sku is None or wid is None:
            continue
        pid = sku2pid.get(int(sku))
        if pid is None:
            continue
        out.append({"platform": "ozon", "warehouse_id": int(wid), "sku_key": pid, "date": today,
                    "present": int(r.get("present") or 0), "reserved": int(r.get("reserved") or 0)})
    return out


def collect():
    today = date.today().isoformat()
    print(f"[ozon_fbs_stocks] FBS-остатки складов продавца на {today} ({datetime.now():%H:%M})", flush=True)
    db_pg.init()
    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        sku2pid[int(r["fbo_sku"])] = int(r["product_id"])
    if not sku2pid:
        print("[ozon_fbs_stocks] ПРОПУСК: нет sku в каталоге (сначала ozon_catalog)", flush=True)
        return 0
    cli = OzonClient()
    try:
        result = cli.stocks_by_warehouse_fbs(sorted(sku2pid))
    except OzonError as e:
        print(f"[ozon_fbs_stocks] ПРОПУСК: Ozon API недоступен ({e}), снимок не записан (exit 0)", flush=True)
        return 0
    if _probe.mode() == "1":
        _probe.dump("POST /v1/product/info/stocks-by-warehouse/fbs", result, n=5)
        return 0
    rows = rows_from_result(result, sku2pid, today)
    if _probe.mode() == "verify":
        db_rows = db_pg.mp_fbs_stock_today("ozon", today)
        api = {(r["warehouse_id"], r["sku_key"]): r["present"] for r in rows}
        diff = [(k, api.get(k), db_rows.get(k)) for k in set(api) | set(db_rows) if api.get(k) != db_rows.get(k)]
        print(f"[ozon_fbs_stocks] verify: api={len(api)} db={len(db_rows)} Δ={len(diff)} {diff[:10]}", flush=True)
        sys.exit(1 if diff else 0)
    n = db_pg.upsert_mp_fbs_stock_many(rows)
    print(f"[ozon_fbs_stocks] строк {n} (ответ API {len(result)})", flush=True)
    print(f"##OBS rows={n}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 2: Тест проходит целиком**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-fbs-stocks-parse.py`
Expected: `OK: wb 2 проверки` и `OK: ozon 1 проверка`.

- [ ] **Step 3: Регистрация**

`orchestrator.py` `OZON_COLLECTORS`: после `"ozon_stocks",` добавить `"ozon_fbs_stocks",  # FBS-остатки складов продавца (тик stocks)`.
`run_saas_collect.sh`: `STOCKS_COLLECTORS="wb_stocks,ozon_stocks,wb_fbs_stocks,ozon_fbs_stocks"`.

- [ ] **Step 4: Проба → прогон → сверка**

Run: `SAAS_PROBE=1 ORCH --collectors ozon_fbs_stocks`. Если API отвечает 400 на пачку 100 — уменьшить `chunk` в вызове (`cli.stocks_by_warehouse_fbs(skus, chunk=50)`) и зафиксировать лимит в докстринге. Если поля не `sku/warehouse_id/present/reserved` — поправить `rows_from_result` и фикстуру.

Run: `ORCH --collectors ozon_fbs_stocks`, затем `SAAS_PROBE=verify ORCH --collectors ozon_fbs_stocks`.
Expected: `Δ=0`. В БД: `SELECT warehouse_id, COUNT(*), SUM(present) FROM tenant.mp_fbs_daily_stock WHERE cabinet_id=1 AND platform='ozon' AND date=current_date GROUP BY 1` — склады из `mp_seller_warehouses` (ozon), проверить что `warehouse_id` совпадают с ними:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT COUNT(*) FROM (SELECT DISTINCT warehouse_id FROM tenant.mp_fbs_daily_stock WHERE cabinet_id=1 AND platform='ozon') s WHERE NOT EXISTS (SELECT 1 FROM tenant.mp_seller_warehouses w WHERE w.cabinet_id=1 AND w.platform='ozon' AND w.warehouse_id=s.warehouse_id)"
```
Expected: `0` (все склады снимка есть в справочнике).

- [ ] **Step 5: Commit**

```bash
git add worker/collectors/ozon_fbs_stocks.py worker/orchestrator.py worker/run_saas_collect.sh scripts/test-fbs-stocks-parse.py
git commit -m "feat(warehouses): FBS-остатки складов продавца Ozon → tenant.mp_fbs_daily_stock"
```

---

### Task 8: `warehouse_id` у FBS-заданий WB

**Files:**
- Modify: `worker/db_pg.py:868-872` (`_WB_FBS_TASKS_MAP`)

**Interfaces:**
- Produces: колонка `wb_fbs_tasks.warehouse_id` заполняется лентой `/api/v3/orders` (поле `warehouseId`).

- [ ] **Step 1: Добавить в карту**

```python
_WB_FBS_TASKS_MAP = [
    ("rid", "rid"), ("supply_id", "supplyId"),
    ("created_at", "createdAt"), ("nm_id", "nmId"),
    ("order_id", "id"),   # ключ POST /api/v3/orders/status (миграция 051)
    ("warehouse_id", "warehouseId"),  # склад продавца (миграция 052) — авто-списание FBS, этап 2
]
```

- [ ] **Step 2: Прогон ленты и проверка заполнения**

Run: `ORCH --collectors wb_fbs_tasks`, затем:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT COUNT(*), COUNT(warehouse_id), COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days'), COUNT(warehouse_id) FILTER (WHERE created_at >= now() - interval '30 days') FROM tenant.wb_fbs_tasks WHERE cabinet_id=1"
```
Expected: третье и четвёртое числа равны (100 % заданий за 30 дней с `warehouse_id`). Старые задания вне ленты остаются NULL — это ожидаемо (лента WB укорачивается с ростом `dateFrom`, проба 05.09). Дополнительно: `warehouse_id` заданий ⊂ `mp_seller_warehouses` (wb):
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT COUNT(DISTINCT t.warehouse_id) FROM tenant.wb_fbs_tasks t WHERE t.cabinet_id=1 AND t.warehouse_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenant.mp_seller_warehouses w WHERE w.cabinet_id=1 AND w.platform='wb' AND w.warehouse_id=t.warehouse_id)"
```
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add worker/db_pg.py
git commit -m "feat(wb_fbs_tasks): warehouse_id задания (склад продавца) для авто-списания FBS"
```

---

### Task 9: Сборщик поставок Ozon на FBO → `ozon_supply_orders`

**Files:**
- Create: `worker/collectors/ozon_supply_orders.py`, `scripts/test-ozon-supply-orders-parse.py`
- Modify: `worker/db_pg.py`, `worker/orchestrator.py` (`OZON_COLLECTORS`), `worker/run_saas_collect.sh:53` (`MAIN_COLLECTORS`)

**Interfaces:**
- Consumes: `OzonClient.iter_supply_order_ids`, `supply_order_get`, `supply_order_bundle_items` (задача 4), `_probe`.
- Produces: `ozon_supply_orders.parse_orders(get_res: dict) -> (orders: list[dict], bundles: dict[order_id, list[str]])`; `ozon_supply_orders.parse_items(order_id, items, sku2pid) -> list[dict]`; `db_pg.upsert_ozon_supply_orders_many(rows)`, `db_pg.upsert_ozon_supply_order_items_many(rows)`.

- [ ] **Step 1: Тест разбора**

```python
#!/usr/bin/env python3
"""Разбор ответа /v2/supply-order/get и /v1/supply-order/bundle. Без сети и БД.
Форма ответа — по документации Ozon; после живой пробы (задача 9, шаг 6) фикстура
выравнивается по реальному дампу."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import ozon_supply_orders as m

get_res = {
    "orders": [{
        "supply_order_id": 501, "supply_order_number": "SO-501", "state": "ORDER_STATE_COMPLETED",
        "creation_date": "2026-08-30T10:00:00Z",
        "timeslot": {"timeslot": {"from": "2026-09-02T09:00:00Z", "to": "2026-09-02T12:00:00Z"}},
        "supplies": [{"supply_id": 1, "bundle_id": "b-1", "storage_warehouse_id": 77}],
    }, {
        "supply_order_id": 502, "supply_order_number": "SO-502", "state": "ORDER_STATE_DATA_FILLING",
        "creation_date": "2026-09-05T10:00:00Z", "timeslot": None, "supplies": [],
    }],
    "warehouses": [{"warehouse_id": 77, "name": "ХОРУГВИНО_РФЦ"}],
}
orders, bundles = m.parse_orders(get_res)
assert orders == [
    {"order_id": 501, "number": "SO-501", "state": "ORDER_STATE_COMPLETED",
     "created_at": "2026-08-30T10:00:00Z", "timeslot_from": "2026-09-02T09:00:00Z",
     "timeslot_to": "2026-09-02T12:00:00Z", "dest_warehouse_id": 77, "dest_warehouse_name": "ХОРУГВИНО_РФЦ"},
    {"order_id": 502, "number": "SO-502", "state": "ORDER_STATE_DATA_FILLING",
     "created_at": "2026-09-05T10:00:00Z", "timeslot_from": None, "timeslot_to": None,
     "dest_warehouse_id": None, "dest_warehouse_name": None},
], orders
assert bundles == {501: ["b-1"]}, bundles

items = m.parse_items(501, [{"sku": 700, "quantity": 12}, {"sku": "701", "quantity": 3},
                            {"sku": 999, "quantity": 1}], {700: 1001, 701: 1002})
assert items == [
    {"order_id": 501, "sku": 700, "product_id": 1001, "qty_declared": 12, "qty_accepted": None},
    {"order_id": 501, "sku": 701, "product_id": 1002, "qty_declared": 3, "qty_accepted": None},
    {"order_id": 501, "sku": 999, "product_id": None, "qty_declared": 1, "qty_accepted": None},
], items
print("OK: 3 проверки")
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-ozon-supply-orders-parse.py`
Expected: `ModuleNotFoundError: No module named 'ozon_supply_orders'`.

- [ ] **Step 3: db_pg**

```python
# --- ozon_supply_orders (заказы на поставку FBO, план «Склады 2.0», этап 1) ---
_OZ_SUPPLY_ORDER_COLS = ["order_id", "number", "state", "created_at", "timeslot_from", "timeslot_to",
                         "dest_warehouse_id", "dest_warehouse_name"]
_OZ_SUPPLY_ITEM_COLS = ["order_id", "sku", "product_id", "qty_declared", "qty_accepted"]


def upsert_ozon_supply_orders_many(rows):
    return _batch_upsert("ozon_supply_orders", ["order_id"], _OZ_SUPPLY_ORDER_COLS, rows)


def upsert_ozon_supply_order_items_many(rows):
    return _batch_upsert("ozon_supply_order_items", ["order_id", "sku"], _OZ_SUPPLY_ITEM_COLS, rows)
```

- [ ] **Step 4: Сборщик**

```python
"""
SaaS-сборщик ЗАКАЗОВ НА ПОСТАВКУ Ozon (FBO) → tenant.ozon_supply_orders (+_items).

/v2/supply-order/list (курсор last_supply_order_id, все состояния) →
/v2/supply-order/get (пачки ≤50: orders[] + warehouses[]) →
/v1/supply-order/bundle (состав по bundle_id поставок). Нужно этапу 3 «Поставки»
(связь документа отгрузки с фактом приёмки). qty_accepted пока NULL: эндпоинт
принятого количества уточняется пробой (см. AGENTS.md после задачи 9).
Тик main. Аргументы дат игнорируются — тянем весь список (сотни строк).
SAAS_PROBE=1 — дамп list/get/bundle без записи.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe
from ozon_client import OzonClient, OzonError


def parse_orders(get_res):
    """orders[] + warehouses[] → (строки ozon_supply_orders, {order_id: [bundle_id,…]})."""
    wh = {int(w["warehouse_id"]): w.get("name") for w in get_res.get("warehouses") or []
          if w.get("warehouse_id") is not None}
    orders, bundles = [], {}
    for o in get_res.get("orders") or []:
        oid = o.get("supply_order_id")
        if oid is None:
            continue
        oid = int(oid)
        ts = ((o.get("timeslot") or {}).get("timeslot") or {}) if isinstance(o.get("timeslot"), dict) else {}
        supplies = o.get("supplies") or []
        dest = next((s.get("storage_warehouse_id") for s in supplies if s.get("storage_warehouse_id")), None)
        orders.append({
            "order_id": oid, "number": o.get("supply_order_number"), "state": o.get("state"),
            "created_at": o.get("creation_date"),
            "timeslot_from": ts.get("from"), "timeslot_to": ts.get("to"),
            "dest_warehouse_id": int(dest) if dest is not None else None,
            "dest_warehouse_name": wh.get(int(dest)) if dest is not None else None,
        })
        b = [s["bundle_id"] for s in supplies if s.get("bundle_id")]
        if b:
            bundles[oid] = b
    return orders, bundles


def parse_items(order_id, items, sku2pid):
    out = []
    for it in items or []:
        if it.get("sku") is None:
            continue
        sku = int(it["sku"])
        out.append({"order_id": int(order_id), "sku": sku, "product_id": sku2pid.get(sku),
                    "qty_declared": int(it.get("quantity") or 0), "qty_accepted": None})
    return out


def collect():
    print(f"[ozon_supply_orders] заказы на поставку FBO ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    cli = OzonClient()
    try:
        ids = list(cli.iter_supply_order_ids())
        if _probe.is_probe():
            _probe.dump("/v2/supply-order/list ids", ids, n=20)
            ids = ids[:5]
        get_res = cli.supply_order_get(ids) if ids else {"orders": [], "warehouses": []}
        if _probe.is_probe():
            _probe.dump("/v2/supply-order/get", get_res.get("orders") or [], n=2)
            _probe.dump("/v2/supply-order/get warehouses", get_res.get("warehouses") or [], n=5)
        orders, bundles = parse_orders(get_res)
        sku2pid = {int(r["fbo_sku"]): int(r["product_id"]) for r in
                   db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL")}
        items = []
        for oid, bids in bundles.items():
            raw = cli.supply_order_bundle_items(bids)
            if _probe.is_probe():
                _probe.dump(f"/v1/supply-order/bundle {oid}", raw, n=3)
                break
            items.extend(parse_items(oid, raw, sku2pid))
    except OzonError as e:
        print(f"[ozon_supply_orders] ПРОПУСК: Ozon API недоступен ({e}) (exit 0)", flush=True)
        return 0
    if _probe.is_probe():
        return 0
    n_o = db_pg.upsert_ozon_supply_orders_many(orders)
    n_i = db_pg.upsert_ozon_supply_order_items_many(items)
    print(f"[ozon_supply_orders] заказов {n_o}, позиций {n_i}", flush=True)
    print(f"##OBS rows={n_o}", flush=True)
    return n_o


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 5: Тест проходит**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-ozon-supply-orders-parse.py`
Expected: `OK: 3 проверки`.

- [ ] **Step 6: Живая проба и выравнивание карты полей**

Run: `SAAS_PROBE=1 ORCH --collectors ozon_supply_orders`.
Сравнить дамп с ожиданиями `parse_orders`/`parse_items`: `supply_order_id`, `supply_order_number`, `state`, `creation_date`, `timeslot.timeslot.from/to`, `supplies[].bundle_id`, `supplies[].storage_warehouse_id`, `warehouses[].warehouse_id/name`, `items[].sku/quantity`. Каждое отличие — правка функции разбора **и** фикстуры теста; тест снова зелёный. Если в дампе `get` есть поле с принятым количеством (например `accepted_quantity` в составе) — заполнить `qty_accepted` из него и добавить проверку в тест; если нет — оставить NULL и записать в AGENTS.md: «принятое количество Ozon: эндпоинт не найден, этап 3 берёт из отчёта приёмки руками».

- [ ] **Step 7: Регистрация и прогон**

`orchestrator.py` `OZON_COLLECTORS`: после `"ozon_seller_warehouses",` добавить `"ozon_supply_orders",  # заказы на поставку FBO → tenant.ozon_supply_orders (тик main)`.
`run_saas_collect.sh` `MAIN_COLLECTORS`: дописать в конец `,ozon_supply_orders`.

Run: `ORCH --collectors ozon_supply_orders`, затем:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT COUNT(*), COUNT(dest_warehouse_id), MIN(created_at)::date, MAX(created_at)::date FROM tenant.ozon_supply_orders WHERE cabinet_id=1; SELECT COUNT(*), COUNT(product_id) FROM tenant.ozon_supply_order_items WHERE cabinet_id=1"
```
Expected: заказов > 0 (кабинет #1 возит на FBO), позиций > 0, `COUNT(product_id)` = `COUNT(*)` или близко (sku без карточки — единицы). Сверить число заказов за 90 дней с ЛК Ozon «Поставки → Заказы» — записать оба числа в AGENTS.md.

- [ ] **Step 8: Commit**

```bash
git add worker/collectors/ozon_supply_orders.py worker/db_pg.py worker/orchestrator.py worker/run_saas_collect.sh scripts/test-ozon-supply-orders-parse.py
git commit -m "feat(warehouses): заказы на поставку Ozon FBO → tenant.ozon_supply_orders"
```

---

### Task 10: API мест: новые поля, справочник складов, op `update`

**Files:**
- Create: `lib/locationsLink.js`, `lib/__tests__/locationsLink.test.mjs`
- Modify: `app/api/cabinets/[id]/inventory/route.js:42-45` (GET locations), `:183-221` (POST locations)

**Interfaces:**
- Produces: `normalizeLocationUpdate(body) -> { ok: true, sets: string[], vals: any[] } | { ok: false, error: string }` — принимает `wb_warehouse_id`, `ozon_warehouse_id` (число или null), `city` (строка или null), `is_active` (bool); GET `/inventory` отдаёт `locations[]` с полями `wb_warehouse_id, ozon_warehouse_id, city, is_active` и новый массив `sellerWarehouses[] {platform, warehouse_id, name, kind, is_active, location_id}`; POST `{action:"locations", op:"update", id, …}`; при нарушении уникальности — 409 `{error:"склад уже привязан к другому месту"}`.

- [ ] **Step 1: Тест валидации**

```js
// lib/__tests__/locationsLink.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocationUpdate } from "../locationsLink.js";

test("привязка складов и город", () => {
  const r = normalizeLocationUpdate({ wb_warehouse_id: "123", ozon_warehouse_id: null, city: " Казань " });
  assert.deepEqual(r, { ok: true, sets: ["wb_warehouse_id = $1", "ozon_warehouse_id = $2", "city = $3"], vals: [123, null, "Казань"] });
});

test("is_active и пустой город → null", () => {
  const r = normalizeLocationUpdate({ is_active: false, city: "" });
  assert.deepEqual(r, { ok: true, sets: ["city = $1", "is_active = $2"], vals: [null, false] });
});

test("нет известных полей → ошибка", () => {
  assert.deepEqual(normalizeLocationUpdate({ name: "x" }), { ok: false, error: "nothing to update" });
});

test("нечисловой склад → ошибка", () => {
  assert.deepEqual(normalizeLocationUpdate({ wb_warehouse_id: "abc" }), { ok: false, error: "wb_warehouse_id must be a number or null" });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /opt/agents/saas && node --test lib/__tests__/locationsLink.test.mjs`
Expected: `Cannot find module '…/lib/locationsLink.js'`.

- [ ] **Step 3: Реализация**

```js
// lib/locationsLink.js — валидация правки места хранения (привязка складов МП,
// город, активность). Чистая функция: тело запроса → SET-фрагменты для UPDATE
// tenant.stock_ff_locations. Спека «Склады 2.0» §1.1.
const ID_FIELDS = ["wb_warehouse_id", "ozon_warehouse_id"];

export function normalizeLocationUpdate(body) {
  const sets = [];
  const vals = [];
  const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  for (const f of ID_FIELDS) {
    if (!(f in body)) continue;
    const raw = body[f];
    if (raw === null || raw === "") { push(f, null); continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${f} must be a number or null` };
    push(f, n);
  }
  if ("city" in body) {
    const c = String(body.city ?? "").trim();
    push("city", c || null);
  }
  if ("is_active" in body) push("is_active", Boolean(body.is_active));
  if (!sets.length) return { ok: false, error: "nothing to update" };
  return { ok: true, sets, vals };
}
```

В `route.js` GET — заменить запрос мест:

```js
  const locations = await tenantQuery(
    `SELECT id, name, address, loc_type, wb_warehouse_id, ozon_warehouse_id, city, is_active
     FROM tenant.stock_ff_locations ORDER BY loc_type, name`
  );
  // Склады продавца на МП (mp_seller_warehouses, тик references) + к какому месту привязан.
  const sellerWarehouses = await tenantQuery(
    `SELECT w.platform, w.warehouse_id, w.name, w.kind, w.is_active,
            l.id AS location_id
     FROM tenant.mp_seller_warehouses w
     LEFT JOIN tenant.stock_ff_locations l
       ON l.cabinet_id = w.cabinet_id
      AND ((w.platform = 'wb' AND l.wb_warehouse_id = w.warehouse_id)
        OR (w.platform = 'ozon' AND l.ozon_warehouse_id = w.warehouse_id))
     ORDER BY w.platform, w.name`
  );
```
и в `NextResponse.json({ items, totals, locations, shipments })` добавить `sellerWarehouses`.

В POST-блоке `locations` перед `if (op === "delete")` добавить:

```js
    if (op === "update") {
      const lid = Number(b.id);
      if (!lid) return NextResponse.json({ error: "id required" }, { status: 400 });
      const n = normalizeLocationUpdate(b);
      if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
      try {
        await tenantQuery(
          `UPDATE tenant.stock_ff_locations SET ${n.sets.join(", ")} WHERE id = $${n.vals.length + 1}`,
          [...n.vals, lid]
        );
      } catch (e) {
        if (String(e?.code) === "23505") {
          return NextResponse.json({ error: "склад уже привязан к другому месту" }, { status: 409 });
        }
        throw e;
      }
      return NextResponse.json({ ok: true });
    }
```
Импорт вверху файла: `import { normalizeLocationUpdate } from "@/lib/locationsLink.js";`. Проверить, что `tenantQuery` пробрасывает ошибку psycopg-стиля с `code` (в `lib/db.js` ошибки `pg` содержат `code`; если обёртка их заворачивает — искать `23505` в `e.message`).

- [ ] **Step 4: Тест проходит**

Run: `node --test lib/__tests__/locationsLink.test.mjs`
Expected: `# pass 4`.

- [ ] **Step 5: Commit**

```bash
git add lib/locationsLink.js lib/__tests__/locationsLink.test.mjs "app/api/cabinets/[id]/inventory/route.js"
git commit -m "feat(inventory): привязка мест хранения к складам продавца WB/Ozon (API)"
```

---

### Task 11: UI «📍 Места»: привязка складов, город, активность

**Files:**
- Modify: `app/cabinets/[id]/inventory/InventoryPage.jsx:811-905` (`LocationsManager`), `:67` (чтение `sellerWarehouses` из `data`)

**Interfaces:**
- Consumes: GET `sellerWarehouses[]`, POST `locations/update` (задача 10).

- [ ] **Step 1: Прокинуть справочник**

Рядом с `const locations = data?.locations || [];` добавить `const sellerWarehouses = data?.sellerWarehouses || [];` и передать в `<LocationsManager … sellerWarehouses={sellerWarehouses} />`.

- [ ] **Step 2: Форма привязки в строке места**

В `LocationsManager({ cabinetId, locations, reload, sellerWarehouses })` добавить функцию:

```jsx
  async function updateLoc(l, patch) {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "locations", op: "update", id: l.id, ...patch }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "update failed");
      reload();
    } catch (e) { alert("Не сохранилось: " + e.message); }
  }
  const whOptions = (platform, l) => sellerWarehouses
    .filter((w) => w.platform === platform && (w.is_active || w.location_id === l.id))
    .map((w) => (
      <option key={w.warehouse_id} value={w.warehouse_id}
        disabled={w.location_id != null && w.location_id !== l.id}>
        {w.name}{w.location_id != null && w.location_id !== l.id ? " (занят)" : ""}
      </option>
    ));
```

В разметке строки места (внутри `locations.map`) после `{l.address && …}` добавить:

```jsx
            <select value={l.wb_warehouse_id ?? ""} onChange={(e) => updateLoc(l, { wb_warehouse_id: e.target.value || null })}
              style={{ ...inputStyle, width: 170, padding: "3px 6px", fontSize: 12 }} title="Склад продавца WB">
              <option value="">WB: не привязан</option>{whOptions("wb", l)}
            </select>
            <select value={l.ozon_warehouse_id ?? ""} onChange={(e) => updateLoc(l, { ozon_warehouse_id: e.target.value || null })}
              style={{ ...inputStyle, width: 170, padding: "3px 6px", fontSize: 12 }} title="Склад продавца Ozon">
              <option value="">Ozon: не привязан</option>{whOptions("ozon", l)}
            </select>
            <input defaultValue={l.city || ""} placeholder="город"
              onBlur={(e) => { if ((e.target.value.trim() || null) !== (l.city || null)) updateLoc(l, { city: e.target.value }); }}
              style={{ ...inputStyle, width: 110, padding: "3px 6px", fontSize: 12 }} />
            <label style={{ fontSize: 11, color: C.muted, display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={l.is_active !== false} onChange={(e) => updateLoc(l, { is_active: e.target.checked })} /> активно
            </label>
```

Под списком мест — блок непривязанных складов:

```jsx
      {sellerWarehouses.some((w) => w.is_active && w.location_id == null) && (
        <div style={{ marginTop: 10, fontSize: 12, color: C.neg }}>
          Не привязаны к месту: {sellerWarehouses.filter((w) => w.is_active && w.location_id == null)
            .map((w) => `${w.platform.toUpperCase()} · ${w.name}`).join(", ")}
        </div>
      )}
```

- [ ] **Step 3: Сборка и ручная проверка**

Run: `cd /opt/agents/saas && npm run build 2>&1 | tail -5` — без ошибок. **Не** рестартовать `saas-web` здесь (деплой — задача 13). Проверка логики через API после деплоя: см. задачу 13 шаг 3.

- [ ] **Step 4: Commit**

```bash
git add "app/cabinets/[id]/inventory/InventoryPage.jsx"
git commit -m "feat(inventory): UI привязки мест к складам продавца, город, активность"
```

---

### Task 12: SQL-сторож этапа 1

**Files:**
- Create: `scripts/check-warehouses-stage1.sql`

- [ ] **Step 1: Сторож**

```sql
-- Смоук-сторож «Склады 2.0», этап 1 «Данные». Запуск:
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage1.sql
-- Все проверки должны отдать ok=t (кабинет #1; под saas_ro RLS не скоупит — WHERE явно).

-- 1. Справочник складов продавца: обе площадки
SELECT 'seller_warehouses' AS check,
       COUNT(*) FILTER (WHERE platform='wb' AND is_active) > 0
       AND COUNT(*) FILTER (WHERE platform='ozon' AND is_active) > 0 AS ok,
       COUNT(*) FILTER (WHERE platform='wb') AS wb, COUNT(*) FILTER (WHERE platform='ozon') AS ozon
FROM tenant.mp_seller_warehouses WHERE cabinet_id=1;

-- 2. Штрихкоды WB покрывают каталог
SELECT 'wb_barcodes' AS check,
       COUNT(DISTINCT b.nm_id)::float / GREATEST((SELECT COUNT(*) FROM tenant.wb_articles WHERE cabinet_id=1),1) > 0.9 AS ok,
       COUNT(DISTINCT b.nm_id) AS nm_with_bc,
       (SELECT COUNT(*) FROM tenant.wb_articles WHERE cabinet_id=1) AS articles
FROM tenant.wb_barcodes b WHERE b.cabinet_id=1;

-- 3. Снимок FBS-остатков за сегодня есть по обеим площадкам, склады из справочника
SELECT 'fbs_stock_today' AS check,
       COUNT(*) FILTER (WHERE s.platform='wb') > 0 AND COUNT(*) FILTER (WHERE s.platform='ozon') > 0
       AND COUNT(*) FILTER (WHERE w.warehouse_id IS NULL) = 0 AS ok,
       COUNT(*) FILTER (WHERE s.platform='wb') AS wb_rows, COUNT(*) FILTER (WHERE s.platform='ozon') AS ozon_rows,
       COUNT(*) FILTER (WHERE w.warehouse_id IS NULL) AS orphan_wh
FROM tenant.mp_fbs_daily_stock s
LEFT JOIN tenant.mp_seller_warehouses w
  ON w.cabinet_id=s.cabinet_id AND w.platform=s.platform AND w.warehouse_id=s.warehouse_id
WHERE s.cabinet_id=1 AND s.date=current_date;

-- 4. warehouse_id у FBS-заданий WB за 30 дней = 100 %
SELECT 'fbs_tasks_warehouse' AS check,
       COUNT(*) = COUNT(warehouse_id) AS ok, COUNT(*) AS tasks_30d, COUNT(warehouse_id) AS with_wh
FROM tenant.wb_fbs_tasks WHERE cabinet_id=1 AND created_at >= now() - interval '30 days';

-- 5. FBS-постинги Ozon несут warehouse_id (спека §2.5, проверено 06.09 — правка не нужна)
SELECT 'ozon_fbs_warehouse' AS check,
       COUNT(*) = COUNT(warehouse_id) AS ok, COUNT(*) AS fbs, COUNT(warehouse_id) AS with_wh
FROM tenant.ozon_orders WHERE cabinet_id=1 AND scheme='fbs' AND order_dt >= '2026-08-01';

-- 6. Поставки Ozon на FBO собраны с составом
SELECT 'ozon_supply_orders' AS check,
       COUNT(DISTINCT o.order_id) > 0 AND COUNT(i.sku) > 0 AS ok,
       COUNT(DISTINCT o.order_id) AS orders, COUNT(i.sku) AS items
FROM tenant.ozon_supply_orders o
LEFT JOIN tenant.ozon_supply_order_items i ON i.cabinet_id=o.cabinet_id AND i.order_id=o.order_id
WHERE o.cabinet_id=1;

-- 7. Места: уникальность привязки соблюдена (индексы), есть хотя бы одно активное место
SELECT 'locations' AS check,
       COUNT(*) FILTER (WHERE is_active) > 0 AS ok,
       COUNT(*) AS places, COUNT(wb_warehouse_id) AS wb_linked, COUNT(ozon_warehouse_id) AS ozon_linked
FROM tenant.stock_ff_locations WHERE cabinet_id=1;
```

- [ ] **Step 2: Прогнать**

Run: `psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage1.sql`
Expected: 7 строк, все `ok=t`. Проверка 3 требует, чтобы сегодняшние прогоны задач 6–7 отработали; если день сменился — перегнать `ORCH --collectors wb_fbs_stocks,ozon_fbs_stocks`.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-warehouses-stage1.sql
git commit -m "test(warehouses): sql-сторож этапа 1 «Данные»"
```

---

### Task 13: Документация, деплой, первый плановый тик

**Files:**
- Modify: `AGENTS.md` (раздел «Маршрут „Закупки → Склад/ФФ“» — после него новый подраздел), `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md` (§2.2 результат пробы, §2.5)

- [ ] **Step 1: AGENTS.md — подраздел «Склады 2.0, этап 1 (2026-09-06)»**

Добавить после блока «Что НЕ ведётся» маршрута закупок:

```markdown
### 🆕 Склады 2.0 — этап 1 «Данные» (с 2026-09-06)

Спека `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md`, план
`docs/superpowers/plans/2026-09-06-warehouses-stage1-data.md`. Миграция 052.

| Таблица | Сборщик / источник | Тик |
|---|---|---|
| `tenant.mp_seller_warehouses` | `wb_seller_warehouses` (`/api/v3/warehouses`), `ozon_seller_warehouses` (`/v1/warehouse/list`) | references (Mon 06:00) + онбординг |
| `tenant.mp_fbs_daily_stock` | `wb_fbs_stocks` (`POST /api/v3/stocks/{wid}` по штрихкодам), `ozon_fbs_stocks` (`/v1/product/info/stocks-by-warehouse/fbs`) | stocks (08:00) |
| `tenant.wb_barcodes` | `wb_catalog` (Content API `sizes[].skus`) | main |
| `tenant.wb_fbs_tasks.warehouse_id` | `wb_fbs_tasks` (`warehouseId`) | main |
| `tenant.ozon_supply_orders(+_items)` | `ozon_supply_orders` (`/v2/supply-order/list`+`get`, `/v1/supply-order/bundle`) | main |
| `tenant.stock_ff_locations.{wb_warehouse_id, ozon_warehouse_id, city, is_active}` | панель, «📍 Места» на `/inventory` (`locations` op `update`) | — |

- **Почему FBS-остатки WB не из stocks-report:** с 01.09.2026 stocks-report отдаёт одну строку
  «Склад WB» (`warehouse_id=-999999`) — WB скрыл разбивку по складам. marketplace-api по
  штрихкодам работает (проба <дата>, Δ с БД = 0).
- **Режим пробы сборщиков:** `SAAS_PROBE=1` — дамп ответа без записи; `SAAS_PROBE=verify`
  (только `*_fbs_stocks`) — сверка API↔БД, exit 1 при Δ. Пробрасывается оркестратором явно.
- **Сторож:** `scripts/check-warehouses-stage1.sql` (7 проверок, все `ok=t`).
- Принятое количество в поставках Ozon: <результат задачи 9 шаг 6>.
- Сверка поставок Ozon с ЛК за 90 дней: <панель N / ЛК M>.
```
Заполнить `<…>` реальными значениями из задач 6, 7, 9.

- [ ] **Step 2: Спека — зафиксировать результаты проб**

В §2.2 после списка кандидатов заменить «Результат пробы фиксируется…» на абзац: какой вариант выбран (2, marketplace-api), почему (stocks-report без разбивки), таблица `wb_barcodes` как источник ключей. В §2.5 второй пункт заменить на «Проверено 06.09: `warehouse_id` у FBS-постингов заполнен, правка не нужна; сторож — проверка 5 `check-warehouses-stage1.sql`».

- [ ] **Step 3: Деплой панели и проверка API**

Run:
```bash
cd /opt/agents/saas && npm run build 2>&1 | tail -3 && systemctl restart saas-web && sleep 3 && systemctl is-active saas-web
```
Expected: `active`. Затем владелец (или сессия под его логином) на `/cabinets/1/inventory` → «📍 Места»: у «ФФ Руслан» выбрать склад WB и склад Ozon, ввести город. Проверка:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT id, name, wb_warehouse_id, ozon_warehouse_id, city, is_active FROM tenant.stock_ff_locations WHERE cabinet_id=1 ORDER BY id"
```
Expected: у выбранного места заполнены оба id и город. Повторная попытка привязать тот же склад к «Склад Пушкино» → в UI alert «склад уже привязан к другому месту».

- [ ] **Step 4: systemd не меняется — убедиться, что таймеры подхватят новые сборщики**

Run: `systemctl list-timers 'saas-*' --all | grep -E 'stocks|references|worker'` и `grep -n "wb_fbs_stocks\|ozon_fbs_stocks\|seller_warehouses\|ozon_supply_orders" worker/run_saas_collect.sh`.
Expected: три таймера активны; четыре grep-совпадения в трёх переменных (`MAIN_COLLECTORS`, `STOCKS_COLLECTORS`, `REFERENCES_COLLECTORS`).

- [ ] **Step 5: Чек-лист следующего дня** (в память сессии, не в репозиторий): после тика `saas-stocks` 07.09 08:00 — `check-warehouses-stage1.sql` проверка 3 `ok=t` за новую дату; в `jobs.collector_runs` строки `wb_fbs_stocks`/`ozon_fbs_stocks` со статусом `ok`.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md
git commit -m "docs(warehouses): этап 1 «Данные» — таблицы, сборщики, результаты проб"
```

---

## Self-review

**Покрытие спеки (этап 1):** §1.1 колонки + уникальность → задача 1, 10, 11; §1.2 справочник + сборщик → 1, 5; §1.3 (не делаем) — ничего; §2.1 таблица → 1; §2.2 WB (вариант 2 после осмотра) → 3, 6; §2.3 Ozon → 4, 7; §2.4 деградация → в каждом сборщике; §2.5 `wb_fbs_tasks.warehouse_id` → 1, 8; Ozon FBS `warehouse_id` → сторож 12; §2.6 поставки Ozon → 1, 4, 9; §6 этап 1 (сверка с живым API Δ=0, справочник = список МП, 100 % `warehouse_id` за 30 дн, поставки = ЛК) → 6, 7, 5, 8, 9, 12; §7 «форма привязки в „📍 Места“» → 10, 11.

**Плейсхолдеры:** в AGENTS.md задачи 13 угловые скобки `<…>` — сознательные места для значений из задач 6/7/9, шаг явно требует их заполнить.

**Согласованность имён:** `upsert_mp_seller_warehouses(platform, rows)` (5) ← используют 5; `seller_warehouse_ids("wb")` (5) ← 6; `wb_barcode_map()`, `upsert_mp_fbs_stock_many`, `mp_fbs_stock_today` (6) ← 6, 7; `stocks_by_warehouse_fbs`, `iter_supply_order_ids`, `supply_order_get`, `supply_order_bundle_items`, `warehouse_list` (4) ← 5, 7, 9; `_probe.mode()/is_probe()/dump()` (2) ← 5–9; `normalizeLocationUpdate` (10) ← 10; `sellerWarehouses` (10) ← 11. Тест задачи 6 импортирует `ozon_fbs_stocks` через `try/except` до появления модуля в задаче 7.
