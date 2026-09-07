# Склады 2.0 — этап 3 «Поставки»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полный цикл поставки на FBO: рекомендация «что, куда, с какого ФФ» по покрытию складов МП → документ отгрузки со статусами → связь с фактом приёмки МП и расхождение принятого с отправленным.

**Architecture:** Чистый планировщик `lib/supplyPlan.js` (скорость/покрытие/потребность, без БД) + адаптер данных `lib/supplyPlanData.js` (Ozon — по складам МП, WB — на уровне кабинета, пока WB не отдаёт разбивку). Документ `ff_shipment_docs` получает статусы `draft → shipped → accepted|partial|rejected`, место-источник, склад назначения по справочнику и связь с фактом: у Ozon — `ozon_supply_orders`, у WB — новый сборщик `wb_incomes` (приёмки FBO с количеством по артикулу). Списание с ФФ — при переходе в `shipped` через ledger этапа 2. Настройки порогов — `auth.cabinets.settings`.

**Tech Stack:** Python 3 (requests, psycopg3) в `/opt/agents/data-presenter-agent/.venv/bin/python`; PostgreSQL 16 с RLS; Next.js 14 App Router; node:test.

**Spec:** `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md` (раздел 4, §5.3 частично, §6 «Этап 3», этап 3 раздела 7).

## Global Constraints

- Живые прогоны, пробы и ручные проверки БД — только кабинет #1 (`--cabinet 1`). Чтение под `saas_ro` с `WHERE cabinet_id = 1`. Миграции применяет контроллер (`PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`).
- Регистрация сборщика = `WB_COLLECTORS` в `worker/orchestrator.py` **и** `MAIN_COLLECTORS` в `worker/run_saas_collect.sh`. Новый эндпоинт — сначала живая проба `SAAS_PROBE=1`.
- Изменение `ff_inventory.qty` — только через `lib/stockLedger.js` / `worker/stock_ledger.py` (инвариант этапа 2, grep-проверка в задаче 8).
- `withCabinet` коммитит транзакцию при возврате ответа и отдаёт 500 при throw → любая проверка, дающая 400, делается ДО первой записи (предпроверка с `FOR UPDATE`), как в этапе 2.
- Каждая новая tenant-таблица: RLS `tenant_iso_<table>` + `panel_local_ro_cab1` + GRANT (образец: миграция 054).
- `npm run build` — только как компиляционная проверка в задачах с JSX/роутами и при деплое; `saas-web` не перезапускать (контроллер); `next dev` запрещён.
- `git add` только явным списком.
- Тесты: JS — `node --test lib/__tests__/*.test.mjs`; Python — `scripts/test-*.py`.

Команда одиночного прогона сборщика (`ORCH`):

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && \
SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas \
/opt/agents/data-presenter-agent/.venv/bin/python -m worker.orchestrator \
  --cabinet 1 --collectors <имя> --date-from 2026-06-01 --date-to 2026-09-07 --run-kind manual
```

## Что вскрыл осмотр 07.09 (влияет на задачи)

| Факт | Следствие |
|---|---|
| WB с 25.08 отдаёт остатки одной строкой «Склад WB» (`warehouse_id=-999999`), а в заказах за 28 дней 196 из ~230 FBO-заказов помечены складом «Склад WB РФ» | Покрытие по складам WB невычислимо; план WB считается на уровне кабинета: «остаток WB всего / скорость всего», склад назначения — ручной выбор из `shared.wb_warehouses`. Как только WB вернёт разбивку, адаптер переключится без правки планировщика |
| `tenant.wb_supplies` — поставки **FBS** (marketplace-api `/api/v3/supplies`, сборочные задания → СЦ; `destination_office_id` — офисы СЦ, не склады) | Спека §4.3 для WB ошибочна. Факт приёмки FBO у WB — statistics-api `GET /api/v1/supplier/incomes` (приёмки: incomeId, date, dateClose, warehouseName, nmId, barcode, quantity, status). Ключ уже есть в заказах: `wb_orders.income_id` заполнен у 3 215 из 3 215 строк. Новый сборщик `wb_incomes`, таблица `tenant.wb_incomes` |
| Ozon: `ozon_daily_stock` по складам (ГРИВНО_РФЦ 413, Казань 112, …), `ozon_orders.warehouse_id` у FBO-постингов, `shared.ozon_clusters` (warehouse_id → cluster), `ozon_supply_orders` 445 шт с `dest_warehouse_id` и составом (`qty_accepted` NULL — Ozon не отдаёт) | План Ozon — по складам МП, как в спеке; связь документа с `ozon_supply_orders` по складу и дате |
| В `auth.cabinets` нет колонки настроек (есть только `external_keys` под ключи) | Миграция добавляет `auth.cabinets.settings JSONB NOT NULL DEFAULT '{}'` — пороги `supply_target_days`/`supply_min_days` |
| `ff_shipment_docs`/`ff_shipment_lines` пусты во всех кабинетах | Дефолт статуса для существующих строк не важен; форма создания меняется свободно |
| `wb_daily_metrics(nm_id, date, orders)` — дневные заказы по товару (уже источник velocity в `/stocks`) | Скорость WB — отсюда; Ozon — из `ozon_orders` по складу (`COUNT/SUM qty` за 28 дней) |

## File Structure

| Файл | Ответственность |
|---|---|
| `db/migrations/055_supplies_stage3.sql` | статусы/связи документа, `qty_accepted`, `pack_qty`, `auth.cabinets.settings`, `tenant.wb_incomes` |
| `worker/collectors/wb_incomes.py`, `worker/db_pg.py` | приёмки FBO WB |
| `lib/supplyPlan.js`, `lib/__tests__/supplyPlan.test.mjs` | чистый планировщик (скорость, покрытие, потребность, источник, группировка) |
| `lib/supplyPlanData.js` | чтение остатков/скоростей/мест из БД (tenant-транзакция), вызов планировщика |
| `lib/shipmentDocs.js`, `lib/__tests__/shipmentDocs.test.mjs` | чистые правила статусов документа и подбора факта (`deriveStatus`, `matchSupply`) |
| `app/api/cabinets/[id]/settings/route.js` | пороги планирования |
| `app/api/cabinets/[id]/inventory/route.js` | `pack_qty` в `update_field` |
| `app/api/cabinets/[id]/shipments/route.js` | документ v2: `create` (draft/shipped), `ship`, `link_supply`, `accept`, `delete` (только draft), GET со статусами и подсказками факта |
| `app/api/cabinets/[id]/supply-plan/route.js` | GET рекомендации, POST `create_doc` из группы |
| `app/cabinets/[id]/shipments/ShipmentsPage.jsx`, `ShipmentFormModal.jsx`, `AcceptModal.jsx` | вкладка «Рекомендации», таблица документов со статусами, связь с фактом, приёмка |
| `app/cabinets/[id]/settings/…` | поля порогов (существующая страница настроек) |
| `scripts/check-warehouses-stage3.sql`, `scripts/test-wb-incomes-parse.py` | сторожа |
| `AGENTS.md`, спека §4 | документация (в т.ч. исправление §4.3 WB → incomes) |

---

### Task 1: Миграция 055 — статусы документа, приёмки WB, настройки

**Files:**
- Create: `db/migrations/055_supplies_stage3.sql`

**Interfaces:**
- Produces: `ff_shipment_docs.{location_id, dest_warehouse_id, status, shipped_at, mp_supply_id, mp_supply_kind}`, `ff_shipment_lines.qty_accepted`, `ff_inventory.pack_qty`, `auth.cabinets.settings`, `tenant.wb_incomes`.

- [ ] **Step 1: Миграция**

```sql
-- 055_supplies_stage3.sql — Склады 2.0, этап 3 «Поставки» (спека §4).
-- Документ отгрузки получает статусы и связь с фактом приёмки; приёмки FBO WB
-- (statistics-api /api/v1/supplier/incomes) — новая таблица; пороги планирования —
-- auth.cabinets.settings. Идемпотентно.
BEGIN;

ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS location_id       BIGINT;        -- откуда (место)
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS dest_warehouse_id BIGINT;        -- склад МП по справочнику
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'shipped'
    CHECK (status IN ('draft','shipped','accepted','partial','rejected'));
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS shipped_at        TIMESTAMPTZ;   -- момент списания
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS mp_supply_id      TEXT;          -- wb: income_id; ozon: order_id
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS mp_supply_kind    TEXT CHECK (mp_supply_kind IN ('wb_income','ozon_supply_order'));
ALTER TABLE tenant.ff_shipment_lines ADD COLUMN IF NOT EXISTS qty_accepted     INTEGER;
ALTER TABLE tenant.ff_inventory      ADD COLUMN IF NOT EXISTS pack_qty         INTEGER;       -- кратность упаковки (NULL = 1)
ALTER TABLE auth.cabinets            ADD COLUMN IF NOT EXISTS settings         JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Приёмки FBO WB: statistics-api GET /api/v1/supplier/incomes (строка = incomeId × nmId × barcode)
CREATE TABLE IF NOT EXISTS tenant.wb_incomes (
    cabinet_id     BIGINT  NOT NULL,
    income_id      BIGINT  NOT NULL,
    nm_id          BIGINT  NOT NULL,
    barcode        TEXT    NOT NULL DEFAULT '',
    number         TEXT,                 -- номер поставки в ЛК
    date           DATE,                 -- дата создания
    date_close     DATE,                 -- дата приёмки
    last_change    TIMESTAMPTZ,
    warehouse_name TEXT,
    tech_size      TEXT,
    quantity       INTEGER,              -- принято, шт
    total_price    NUMERIC(14,2),
    status         TEXT,                 -- «Принято» и т.п. как отдаёт WB
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, income_id, nm_id, barcode)
);
CREATE INDEX IF NOT EXISTS wb_incomes_date_idx ON tenant.wb_incomes (cabinet_id, date);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wb_incomes'] LOOP
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

- [ ] **Step 2 (контроллер): применить дважды, проверить колонки/политики (2 политики на `wb_incomes`).**
- [ ] **Step 3: Commit** `feat(supplies): миграция 055 — статусы документа отгрузки, приёмки FBO WB, настройки кабинета`.

---

### Task 2: Сборщик `wb_incomes` — приёмки FBO WB

**Files:**
- Create: `worker/collectors/wb_incomes.py`, `scripts/test-wb-incomes-parse.py`
- Modify: `worker/db_pg.py`, `worker/orchestrator.py` (`WB_COLLECTORS` после `"wb_orders",`), `worker/run_saas_collect.sh` (`MAIN_COLLECTORS` — дописать `,wb_incomes`)

**Interfaces:**
- Produces: `wb_incomes.parse_rows(data) -> list[dict]` (ключи по колонкам таблицы), `db_pg.upsert_wb_incomes_many(rows)`; `db_pg.wb_incomes_for_match(days) -> list` для подсказок связи.

- [ ] **Step 1: Тест разбора**

```python
#!/usr/bin/env python3
"""Разбор ответа statistics-api /api/v1/supplier/incomes. Без сети и БД."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import wb_incomes as m

data = [
    {"incomeId": 41257995, "number": "ПОС-1", "date": "2026-08-28T00:00:00", "lastChangeDate": "2026-08-30T10:00:00",
     "supplierArticle": "SA1", "techSize": "0", "barcode": "2000000000012", "quantity": 120, "totalPrice": 0,
     "dateClose": "2026-08-30T00:00:00", "warehouseName": "Казань", "nmId": 1383643331, "status": "Принято"},
    {"incomeId": 41257995, "number": "ПОС-1", "date": "2026-08-28T00:00:00", "nmId": None, "quantity": 5},  # без nmId — пропуск
]
rows = m.parse_rows(data)
assert rows == [{
    "income_id": 41257995, "nm_id": 1383643331, "barcode": "2000000000012", "number": "ПОС-1",
    "date": "2026-08-28", "date_close": "2026-08-30", "last_change": "2026-08-30T10:00:00",
    "warehouse_name": "Казань", "tech_size": "0", "quantity": 120, "total_price": 0, "status": "Принято",
}], rows
assert m.parse_rows([]) == []
print("OK: 2 проверки")
```

- [ ] **Step 2: RED**, затем сборщик (образец — `worker/collectors/wb_supplies.py`: `_get` с ретраями, мягкая деградация, `SAAS_PROBE`):

```python
"""
SaaS-сборщик ПРИЁМОК FBO WB → tenant.wb_incomes (план «Склады 2.0», этап 3).
statistics-api GET /api/v1/supplier/incomes?dateFrom=<ISO> — все приёмки с даты
(строка = incomeId × nmId × barcode; quantity — принято; dateClose — дата приёмки;
status — текст WB). Окно: последние INCOMES_DAYS (90) дней от даты прогона —
хватает для связи документов и сторожа; полный бэкфилл — SAAS_INCOMES_DAYS=400.
Аргументы дат оркестратора игнорируются. Мягкая деградация. SAAS_PROBE=1 — дамп.
"""
```
`INCOMES_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/incomes"`, `dateFrom` = сегодня − окно (`YYYY-MM-DD`); statistics-api отдаёт всё с `dateFrom` одним ответом (лимит запросов 1/мин — один вызов). `parse_rows`: пропуск строк без `nmId`; даты обрезаются до `YYYY-MM-DD` для `date`/`dateClose`, `lastChangeDate` как есть. `db_pg.upsert_wb_incomes_many` — `_batch_upsert("wb_incomes", ["income_id","nm_id","barcode"], [...все колонки...], rows)`.

- [ ] **Step 3: Регистрация, проба, прогон, сверка**

`SAAS_PROBE=1 ORCH --collectors wb_incomes` → дамп; если форма отличается (имена полей) — поправить парсер и фикстуру. `ORCH` (окно 90 дней). Сверка:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT COUNT(*), COUNT(DISTINCT income_id), MIN(date), MAX(date), SUM(quantity) FROM tenant.wb_incomes WHERE cabinet_id=1; SELECT COUNT(DISTINCT o.income_id) AS in_orders, COUNT(DISTINCT i.income_id) AS matched FROM tenant.wb_orders o LEFT JOIN tenant.wb_incomes i ON i.cabinet_id=o.cabinet_id AND i.income_id=o.income_id WHERE o.cabinet_id=1 AND o.order_dt >= '2026-07-01'"
```
Expected: приёмки есть; `matched` близко к `in_orders` за окно (заказы продаются из приёмок старше окна — расхождение объяснимо, записать числа).

- [ ] **Step 4: Commit** `feat(wb_incomes): приёмки FBO WB → tenant.wb_incomes`.

---

### Task 3: Чистый планировщик `lib/supplyPlan.js`

**Files:**
- Create: `lib/supplyPlan.js`, `lib/__tests__/supplyPlan.test.mjs`

**Interfaces:**
- Produces:
  - `velocityPerDay(ordersQty, days) -> number`;
  - `coverageDays(stock, inTransit, velocity) -> number|null` (`null` при velocity 0; `Infinity` не возвращать — `null`);
  - `needQty({ targetDays, velocity, stock, inTransit, packQty }) -> number` (0, если покрытие ≥ target; иначе `ceil((target×vel − stock − inTransit) / pack) × pack`);
  - `pickSources(sources, needed, destKey) -> { parts:[{locationId, qty}], uncovered }` — `sources = [{locationId, city, regionKeys:Set|Array, available}]`, приоритет: источник с `regionKeys` содержащим `destKey` → 0, иначе 1; внутри — по `available` убыв.;
  - `buildSupplyPlan({ settings, targets, sources }) -> { groups:[{ locationId, platform, warehouseKey, warehouseName, lines:[{itemId, itemName, skuKey, need, qty, velocity, coverageDays}], uncovered:[…] }] }` — `targets = [{platform, warehouseKey, warehouseName, regionKey, itemId, itemName, skuKey, stock, inTransit, ordersQty, days, packQty}]`, `sources = {itemId: [{locationId, city, regionKeys, available}]}`; склад с `stock=0 && ordersQty=0` пропускается; `velocity=0` → пропуск; покрытие ≥ `min_days` → пропуск.

- [ ] **Step 1: Тест**

```js
// lib/__tests__/supplyPlan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { velocityPerDay, coverageDays, needQty, pickSources, buildSupplyPlan } from "../supplyPlan.js";

test("скорость и покрытие", () => {
  assert.equal(velocityPerDay(56, 28), 2);
  assert.equal(coverageDays(10, 4, 2), 7);
  assert.equal(coverageDays(10, 0, 0), null);
});

test("потребность с кратностью упаковки", () => {
  assert.equal(needQty({ targetDays: 30, velocity: 2, stock: 10, inTransit: 4, packQty: 12 }), 48); // 60−14=46 → 48
  assert.equal(needQty({ targetDays: 30, velocity: 2, stock: 70, inTransit: 0, packQty: null }), 0);
  assert.equal(needQty({ targetDays: 30, velocity: 0.5, stock: 0, inTransit: 0, packQty: 1 }), 15);
});

test("источник: ближний регион первым, остаток не покрыт — явно", () => {
  const sources = [
    { locationId: 5, city: "Казань", regionKeys: ["Приволжский"], available: 20 },
    { locationId: 6, city: "Москва", regionKeys: ["Центральный"], available: 50 },
  ];
  assert.deepEqual(pickSources(sources, 30, "Приволжский"), { parts: [{ locationId: 5, qty: 20 }, { locationId: 6, qty: 10 }], uncovered: 0 });
  assert.deepEqual(pickSources(sources, 100, "Центральный"), { parts: [{ locationId: 6, qty: 50 }, { locationId: 5, qty: 20 }], uncovered: 30 });
  assert.deepEqual(pickSources([], 5, "x"), { parts: [], uncovered: 5 });
});

test("план: группы по (место → склад), пропуск покрытых и без скорости", () => {
  const settings = { targetDays: 30, minDays: 14 };
  const targets = [
    { platform: "ozon", warehouseKey: "w1", warehouseName: "КАЗАНЬ_РФЦ", regionKey: "Приволжский", itemId: 1, itemName: "A", skuKey: 4988, stock: 4, inTransit: 0, ordersQty: 56, days: 28, packQty: null },
    { platform: "ozon", warehouseKey: "w2", warehouseName: "ГРИВНО_РФЦ", regionKey: "Центральный", itemId: 1, itemName: "A", skuKey: 4988, stock: 100, inTransit: 0, ordersQty: 28, days: 28, packQty: null },
    { platform: "ozon", warehouseKey: "w3", warehouseName: "УФА_РФЦ", regionKey: "Приволжский", itemId: 2, itemName: "B", skuKey: 4999, stock: 0, inTransit: 0, ordersQty: 0, days: 28, packQty: null },
  ];
  const sources = { 1: [{ locationId: 5, city: "Казань", regionKeys: ["Приволжский"], available: 30 }] };
  const plan = buildSupplyPlan({ settings, targets, sources });
  assert.equal(plan.groups.length, 1);
  const g = plan.groups[0];
  assert.equal(g.locationId, 5); assert.equal(g.warehouseKey, "w1");
  assert.deepEqual(g.lines.map((l) => [l.itemId, l.need, l.qty, l.coverageDays]), [[1, 56, 30, 2]]); // need = 30×2−4 = 56, есть 30
  assert.deepEqual(plan.uncovered, [{ itemId: 1, warehouseKey: "w1", qty: 26 }]);
});
```

- [ ] **Step 2: RED → реализация** (чистые функции строго по контракту; `buildSupplyPlan` считает `velocity = velocityPerDay(ordersQty, days)`, `coverageDays`, `need = needQty(...)`, `pickSources(sources[itemId] || [], need, regionKey)`; группирует `parts` по `(locationId, platform, warehouseKey)`; `uncovered` — список по товару/складу; источники расходуются в пределах плана (available уменьшается) — тест 4 это не проверяет, добавить пятый тест на два склада из одного источника: 30 доступно, потребности 20 и 20 → 20 и 10, uncovered 10).

- [ ] **Step 3: GREEN → Commit** `feat(supplies): чистый планировщик поставок — скорость, покрытие, потребность, источники`.

---

### Task 4: Адаптер данных `lib/supplyPlanData.js` и роут `/supply-plan`

**Files:**
- Create: `lib/supplyPlanData.js`, `app/api/cabinets/[id]/supply-plan/route.js`
- Modify: `app/api/cabinets/[id]/settings/route.js` (пороги), `app/api/cabinets/[id]/inventory/route.js` (`pack_qty` в `update_field` allowed + в GET items)

**Interfaces:**
- Produces: `readSupplySettings(cabinetId) -> { targetDays, minDays }` (из `auth.cabinets.settings.supply_target_days|supply_min_days`, дефолты 30/14); `collectTargets({ from, to }) -> targets[]`:
  - **Ozon**: `ozon_daily_stock` на последнюю дату (по складу: `fbo_present + fbo_reserved`? — нет: `stock = fbo_present`, `inTransit = 0` — в пути Ozon не отдаёт); `ordersQty` = `SUM(qty)` из `ozon_orders` по `warehouse_id` за 28 дней (`scheme='fbo'`, `is_cancel=0`); `regionKey` = `cluster_name` из `shared.ozon_clusters` по `warehouse_id`; `warehouseKey = warehouse_id`; товар = `product_id` → позиции ФФ через `ff_inventory_skus (platform='ozon')`;
  - **WB**: одна цель на товар: `warehouseKey = 'wb'`, `warehouseName = 'WB (все склады)'`, `regionKey = null`; `stock = SUM(quantity)`, `inTransit = SUM(in_way_to)` из `wb_daily_stock` на последнюю дату; `ordersQty = SUM(orders)` из `wb_daily_metrics` за 28 дней; товар = `nm_id`;
  - `collectSources() -> { itemId: [{locationId, city, regionKeys, available}] }` — активные места с `SUM(qty) > 0` по позиции; `regionKeys` = регионы/кластеры, в которых лежит `city` места (сопоставление по вхождению названия города в `shared.wb_warehouses.region`/`shared.ozon_clusters.cluster_name` — простая таблица соответствий `CITY_TO_REGIONS` в файле для 10 крупных городов, остальное — пусто → приоритет 1);
  - `itemId` = `ff_inventory.id`-группа: одна физическая позиция = одна строка `ff_inventory` (без слияния партий; `available` = её `qty`);
  - GET `/supply-plan?platform=all|wb|ozon` → `{ settings, groups, uncovered, generatedAt }`; POST `{action:"create_doc", locationId, platform, warehouseKey, warehouseName, lines:[{ff_inventory_id, qty}]}` → создаёт документ `draft` через логику задачи 5 (вызов той же функции `createShipmentDoc` из `lib/shipmentDocs.js`).
- Settings: GET отдаёт `supply_target_days`, `supply_min_days`; PUT принимает их (целые 1..365, `min < target`).

- [ ] **Step 1**: реализация по контракту; `supplyPlanData.js` использует `tenantQuery` (внутри `withCabinet`) и `query` для `shared.*`.
- [ ] **Step 2**: `node -e` smoke импорта; `npm run build` (компиляция роутов).
- [ ] **Step 3: Commit** `feat(supplies): данные для плана поставок, роут /supply-plan, пороги в настройках, pack_qty`.

---

### Task 5: Документ отгрузки v2 — статусы, связь с фактом, приёмка

**Files:**
- Create: `lib/shipmentDocs.js`, `lib/__tests__/shipmentDocs.test.mjs`
- Modify: `app/api/cabinets/[id]/shipments/route.js`

**Interfaces:**
- Produces (чистые, тестируются):
  - `deriveStatus({ status, lines, supply }) -> 'draft'|'shipped'|'accepted'|'partial'|'rejected'` — `supply` = `{ kind, closed: bool, rejected: bool }`; правила: `draft` остаётся; `shipped` + supply.rejected → `rejected`; `shipped` + supply.closed: если у всех строк `qty_accepted != null` → `SUM(qty_accepted) < SUM(qty)` ? `partial` : `accepted`; иначе `accepted` (приёмка прошла, количество не проверено);
  - `matchSupply(doc, candidates) -> ranked[]` — кандидаты `{ id, kind, date, warehouseKey, warehouseName, qty }`; ранг: совпадение склада (+2), |дата − shipped_at| ≤ 3 дн (+1), qty ≈ Σ строк ±10 % (+1); возвращает отсортированные по рангу, ≥1;
  - `createShipmentDoc(tq, { platform, shipDt, locationId, destWarehouseId, destWarehouse, docNo, note, lines, status:'draft'|'shipped', userId })` — вставка документа и строк; при `shipped` — предпроверка `FOR UPDATE` и `applyMove(out_fbo)` по строкам, `shipped_at = now()`;
  - `shipDoc(tq, { id, userId })` — `draft → shipped` (та же предпроверка/списание);
  - `linkSupply(tq, { id, mpSupplyId, kind })`, `acceptDoc(tq, { id, accepted:[{lineId, qtyAccepted}] })` → пересчёт статуса через `deriveStatus`;
  - роут: `create` (поле `status`), `ship`, `link_supply`, `accept`, `delete` — только `draft` (для `shipped` и выше → 400 «документ уже отгружен: оформите корректировку остатка»); GET: документы + `status`, `supply` (данные приёмки: для `wb_income` — Σ quantity по nm за income_id, `date_close`, `status`; для `ozon_supply_order` — `state`, `dest_warehouse_name`), `suggestions` (топ-3 `matchSupply` для документов без связи), `warehouses` (WB: `shared.wb_warehouses` id/name; Ozon: склады из `ozon_daily_stock`/`shared.ozon_clusters`).
- Consumes: `applyMove` (этап 2); задача 4 использует `createShipmentDoc`.

- [ ] **Step 1: Тест** `deriveStatus`/`matchSupply` (6 случаев: draft; shipped без связи; shipped+closed без qty_accepted → accepted; с qty_accepted меньше → partial; равно → accepted; rejected; ранжирование кандидатов по складу/дате/qty).
- [ ] **Step 2: RED → реализация → GREEN.**
- [ ] **Step 3**: перевод существующего `create` на `createShipmentDoc` (поведение `shipped` по умолчанию = как сейчас), `delete` только draft; сборка `npm run build`.
- [ ] **Step 4: Commit** `feat(supplies): документ отгрузки — черновик/отгружено/приёмка, связь с фактом WB/Ozon`.

---

### Task 6: UI — «Рекомендации», статусы документов, приёмка, настройки

**Files:**
- Modify: `app/cabinets/[id]/shipments/ShipmentsPage.jsx`, `app/cabinets/[id]/shipments/ShipmentFormModal.jsx`, страница настроек (`app/cabinets/[id]/settings/*Page.jsx`)
- Create: `app/cabinets/[id]/shipments/AcceptModal.jsx`

- [ ] **Step 1: ShipmentsPage** — две секции: сверху «Рекомендации» (GET `/supply-plan`; карточки по группам «ФФ X → склад Y», строки товар/покрытие/нужно/есть на ФФ, «не покрыто»; кнопка «Создать черновик» → POST `create_doc` → reload), фильтр площадки; снизу таблица документов: колонки статус (бейдж), № / связь с фактом (селект из `suggestions` + «выбрать другую…» по списку кандидатов, кнопка «Связать»), откуда, куда, дата, Σ шт, принято Σ, действия: «Отгрузить» (draft), «Приёмка» (shipped/accepted → `AcceptModal`), «Удалить» (draft).
- [ ] **Step 2: ShipmentFormModal** — селект «Откуда» (места), селект «Склад назначения» (из `warehouses` по площадке), переключатель «черновик / отгрузить сейчас».
- [ ] **Step 3: AcceptModal** — таблица строк документа с полем «принято», предзаполнение из факта WB (`wb_incomes` по nm), «Сохранить» → `accept`.
- [ ] **Step 4: Настройки** — поля «Целевой запас, дн» / «Минимальный запас, дн».
- [ ] **Step 5:** `npm run build`; Commit `feat(supplies-ui): рекомендации поставок, статусы и приёмка документов, пороги`.

---

### Task 7: Сторож этапа 3

**Files:**
- Create: `scripts/check-warehouses-stage3.sql`

- [ ] Проверки (кабинет 1): (1) `wb_incomes` собраны, `date_close` заполнен у принятых; (2) приёмки за 60 дней покрывают `income_id` заказов (доля ≥ 0.8); (3) документы: `status='shipped'` ⇒ есть `out_fbo` по каждой строке (`stock_moves src_ref = doc:line`), `draft` ⇒ нет; (4) `partial` ⇒ `SUM(qty_accepted) < SUM(qty)`; (5) `mp_supply_id` ссылается на существующую приёмку/заказ на поставку; (6) настройки: `supply_min_days < supply_target_days` там, где заданы. Все `ok=t` (при отсутствии документов проверки 3–5 — `COUNT(*)=0` допустимо с явной колонкой `n`).
- [ ] Commit `test(supplies): sql-сторож этапа 3`.

---

### Task 8: Документация, деплой, приёмка

- [ ] AGENTS.md — подраздел «Склады 2.0 — этап 3 «Поставки»» (таблицы, сборщик `wb_incomes`, план на уровне кабинета для WB и почему, статусы, что руками); спека §4.1 (WB кабинет-уровень), §4.3 (WB — `wb_incomes`, не `wb_supplies`; `qty_accepted` WB предзаполняется из приёмки по nm), §7.
- [ ] grep-инвариант ledger: `grep -rn "SET qty" app lib worker --include=*.js --include=*.py | grep -v "stockLedger.js\|stock_ledger.py"` → пусто.
- [ ] (контроллер) `npm run build && systemctl restart saas-web`; первый main-тик с `wb_incomes`; сторож 3.
- [ ] Приёмка владельцем: рекомендации по Ozon на кабинете 1 (после привязки мест) — 2–3 группы пересчитать руками (скорость = заказы 28 дн / 28, покрытие, потребность); создать черновик → отгрузить → связать с приёмкой → ввести принятое → статус.
- [ ] Commit `docs(supplies): этап 3 — рекомендации, документы, факт приёмки`.

## Self-review

**Покрытие спеки §4:** 4.1 → задачи 3–4 (с оговоркой WB на уровне кабинета); 4.2 → задачи 1, 5; 4.3 → задачи 2, 5, 6 (WB через `wb_incomes` — правка спеки в задаче 8); 4.4 — не делаем. §5.3 «Поставки» частично (рекомендации + документы на существующей `/shipments`, страница `/warehouses` — этап 4). §6 «Этап 3» → задачи 3 (тесты планировщика), 5 (тесты статусов), 7 (сторож), 8 (ручной пересчёт).

**Плейсхолдеры:** нет; развилка по форме ответа `incomes` закрывается пробой в задаче 2.

**Согласованность имён:** `buildSupplyPlan/pickSources/needQty/coverageDays/velocityPerDay` (3) ← 4; `createShipmentDoc/shipDoc/linkSupply/acceptDoc/deriveStatus/matchSupply` (5) ← 4 (POST create_doc), 6; `readSupplySettings` (4) ← 4, 6; `wb_incomes` колонки (1) ← 2, 5, 7; `mp_supply_kind` значения (1) ← 5.
