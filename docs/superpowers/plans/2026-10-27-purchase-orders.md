# Закупки: заказ → позиции → отправки — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить «одна строка закупки = одна позиция» на заказ с позициями, общими оплатами и отправками (карго) с раскидкой логистики по весу; приёмка — по отправкам на «Доставлено на склад».

**Architecture:** 5 новых таблиц `tenant.purchase_*` (миграция 075). Весь расчёт — чистая `lib/purchaseOrders.js` (`calcOrder`), БД — `lib/purchaseOrdersData.js`, роут `purchase-orders`. Платежи в ДДС пишет только `lib/paymentCalendarData.js` (`syncOrderPayments`). Старые `tenant.purchases` — архив только чтение.

**Tech Stack:** Next.js 14 App Router (JS/JSX), PostgreSQL + RLS (`lib/db.js` `tenantQuery`, `withCabinet`), тесты `node --test` (`node:test` + `node:assert/strict`, файлы `lib/__tests__/*.test.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-27-purchase-orders-design.md`

## Global Constraints

- Эксперименты и смоук — только кабинет #1; другие кабинеты не трогать.
- Миграции идемпотентны (`IF NOT EXISTS`), номер `075`; применять: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/075_purchase_orders.sql`.
- Чтение боевой БД — `psql -h localhost -U saas_ro -d saas`.
- `dds_movements` пишется только из `lib/paymentCalendarData.js`.
- Пустой `catch {}` запрещён — всегда `console.error`.
- SQL: даты отдавать `::text`, деньги `::float8`; `ROUND` только по `::numeric`; запросы внутри роута — последовательно (не `Promise.all`).
- Клиентские компоненты: проп `{ cabinetId }`, fetch в backticks, хуки до ранних `return` (грабли D1–D7 AGENTS.md).
- Себестоимость в `cost_overrides`, `ff_inventory`, `stock_moves` НЕ пишется.
- Себестоимость — на отправленные штуки; недостача только показывается.
- `git add` — только явный список файлов задачи. Коммит заканчивается строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- После правок `app/`/`lib/` в конце: `npm run build && systemctl restart saas-web`. `next dev` в каталоге прода не запускать.
- Прогон всех тестов: `node --test lib/__tests__/`.

## File Structure

| Файл | Роль |
|---|---|
| `db/migrations/075_purchase_orders.sql` (new) | 5 таблиц + RLS/гранты |
| `lib/purchaseOrders.js` (new) | чистые: `calcOrder`, `allocate`, валидаторы, `defaultShipmentLines`, `checkShipQty`, `autoOrderStatus`, `cargoRub` |
| `lib/__tests__/purchaseOrders.test.mjs` (new) | тесты чистого слоя |
| `lib/paymentCalendar.js` (mod) | + чистая `orderPayments` |
| `lib/paymentCalendarData.js` (mod) | общий `syncRefs`, + `syncOrderPayments`, `archiveOrderPayments` |
| `lib/catalogSearch.js` (new) | `searchCatalog(q)`, `catalogLabel(line)` — вынесено из deliveries route |
| `lib/purchaseOrdersData.js` (new) | загрузка заказа/списка, `refreshOrderStatus`, `ordersInTransit` |
| `app/api/cabinets/[id]/purchase-orders/route.js` (new) | GET список / заказ / каталог, POST действия |
| `app/api/cabinets/[id]/purchases/route.js` (mod) | POST/DELETE → 410 (архив) |
| `app/api/cabinets/[id]/deliveries/route.js` (mod) | + отправки, действия приёмки отправки |
| `lib/deliveries.js` (mod) | + `buildShipmentDeliveries` |
| `lib/purchasesInTransit.js` (mod) | + отправки в пути |
| `app/cabinets/[id]/fin-purchases/{page.js, OrdersPage.jsx}` | список заказов + вкладка архива |
| `app/cabinets/[id]/fin-purchases/PurchasesPage.jsx` (mod) | проп `readOnly` |
| `app/cabinets/[id]/fin-purchases/[orderId]/{page.js, OrderPage.jsx, OrderLines.jsx, OrderPayments.jsx, OrderShipments.jsx, CatalogPicker.jsx}` | карточка заказа |
| `app/cabinets/[id]/deliveries/{DeliveriesPage.jsx, ShipmentReceiptPanel.jsx}` | приёмка отправки |
| `lib/cabinetNav.js` (mod) | алиас `/fin-purchases/` |
| `lib/__tests__/{roleGuards,paymentCalendarGuard,deliveriesGuard,cabinetNav,deliveries,paymentCalendar}.test.mjs` (mod) | гарды |
| `scripts/smoke-purchase-orders.mjs` (new) | смоук на каб. #1 |
| `AGENTS.md` (mod) | строка в TL;DR + абзац |

---

### Task 1: Миграция 075

**Files:**
- Create: `db/migrations/075_purchase_orders.sql`

**Interfaces:**
- Produces: таблицы `tenant.purchase_orders`, `purchase_order_payments`, `purchase_order_lines`, `purchase_shipments`, `purchase_shipment_lines` с колонками ниже (имена используются всеми задачами).

- [ ] **Step 1: Написать миграцию**

```sql
-- 075_purchase_orders.sql — закупки «заказ → позиции → отправки» (27.10.2026, спека
-- docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Старые tenant.purchases — архив.
-- Себестоимость считает lib/purchaseOrders.js; здесь только ввод. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.purchase_orders (
    cabinet_id       BIGINT      NOT NULL,
    id               BIGSERIAL   NOT NULL,
    order_no         TEXT,
    supplier         TEXT        NOT NULL CHECK (length(btrim(supplier)) > 0),
    supplier_contact TEXT,
    source_country   TEXT,
    category         TEXT,
    note             TEXT,
    order_dt         DATE,
    rate_cny         NUMERIC(12,4) CHECK (rate_cny IS NULL OR rate_cny > 0),
    status           TEXT        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','ordered','production','shipping','closed')),
    archived_at      TIMESTAMPTZ,
    deleted_at       TIMESTAMPTZ,
    created_by       BIGINT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

CREATE TABLE IF NOT EXISTS tenant.purchase_order_payments (
    cabinet_id  BIGINT      NOT NULL,
    id          BIGSERIAL   NOT NULL,
    order_id    BIGINT      NOT NULL,
    kind        TEXT        NOT NULL CHECK (kind IN ('prepay','balance','other')),
    currency    TEXT        NOT NULL DEFAULT 'cny' CHECK (currency IN ('cny','rub')),
    amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    rate        NUMERIC(12,4) CHECK (rate IS NULL OR rate > 0),
    plan_date   DATE,
    note        TEXT,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, order_id) REFERENCES tenant.purchase_orders (cabinet_id, id),
    CHECK (currency = 'rub' OR rate IS NOT NULL),
    CHECK (kind = 'other' OR currency = 'cny')
);

CREATE TABLE IF NOT EXISTS tenant.purchase_order_lines (
    cabinet_id  BIGINT      NOT NULL,
    id          BIGSERIAL   NOT NULL,
    order_id    BIGINT      NOT NULL,
    platform    TEXT        CHECK (platform IN ('wb','ozon')),
    nm_id       BIGINT,
    product_id  BIGINT,
    label       TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
    variant     TEXT,
    qty         INTEGER     NOT NULL CHECK (qty > 0),
    price_cny   NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (price_cny >= 0),
    weight_kg   NUMERIC(10,4) CHECK (weight_kg IS NULL OR weight_kg > 0),
    photo_url   TEXT,
    note        TEXT,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, order_id) REFERENCES tenant.purchase_orders (cabinet_id, id),
    CHECK (
      (platform = 'wb'   AND nm_id IS NOT NULL AND product_id IS NULL) OR
      (platform = 'ozon' AND product_id IS NOT NULL AND nm_id IS NULL) OR
      (platform IS NULL  AND nm_id IS NULL AND product_id IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS tenant.purchase_shipments (
    cabinet_id   BIGINT      NOT NULL,
    id           BIGSERIAL   NOT NULL,
    order_id     BIGINT      NOT NULL,
    shipment_no  TEXT,
    carrier      TEXT,
    ship_dt      DATE,
    eta          DATE,
    arrived_dt   DATE,
    status       TEXT        NOT NULL DEFAULT 'transit' CHECK (status IN ('transit','arrived','accepted')),
    cargo_rub    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cargo_rub >= 0),
    ff_rub       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (ff_rub >= 0),
    accepted_at  TIMESTAMPTZ,
    accepted_by  BIGINT,
    note         TEXT,
    deleted_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, order_id) REFERENCES tenant.purchase_orders (cabinet_id, id)
);

CREATE TABLE IF NOT EXISTS tenant.purchase_shipment_lines (
    cabinet_id    BIGINT  NOT NULL,
    id            BIGSERIAL NOT NULL,
    shipment_id   BIGINT  NOT NULL,
    line_id       BIGINT  NOT NULL,
    qty_shipped   INTEGER NOT NULL CHECK (qty_shipped > 0),
    qty_accepted  INTEGER CHECK (qty_accepted IS NULL OR qty_accepted >= 0),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, shipment_id, line_id),
    FOREIGN KEY (cabinet_id, shipment_id) REFERENCES tenant.purchase_shipments (cabinet_id, id),
    FOREIGN KEY (cabinet_id, line_id) REFERENCES tenant.purchase_order_lines (cabinet_id, id)
);

CREATE INDEX IF NOT EXISTS ix_po_payments_order ON tenant.purchase_order_payments (cabinet_id, order_id);
CREATE INDEX IF NOT EXISTS ix_po_lines_order ON tenant.purchase_order_lines (cabinet_id, order_id);
CREATE INDEX IF NOT EXISTS ix_po_shipments_order ON tenant.purchase_shipments (cabinet_id, order_id);
CREATE INDEX IF NOT EXISTS ix_po_ship_lines_ship ON tenant.purchase_shipment_lines (cabinet_id, shipment_id);
CREATE INDEX IF NOT EXISTS ix_po_ship_lines_line ON tenant.purchase_shipment_lines (cabinet_id, line_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders','purchase_order_payments','purchase_order_lines',
                           'purchase_shipments','purchase_shipment_lines'] LOOP
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
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tenant.%I TO saas_app', t || '_id_seq');
    EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
  END LOOP;
END $$;

COMMIT;
```

- [ ] **Step 2: Применить и проверить идемпотентность (два прогона)**

Run: `cd /opt/agents/saas && for i in 1 2; do PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -q -f db/migrations/075_purchase_orders.sql && echo OK$i; done`
Expected: `OK1` и `OK2`.

- [ ] **Step 3: Проверить, что saas_ro и saas_triage видят таблицы**

Run: `psql -h localhost -U saas_ro -d saas -Atc "select count(*) from tenant.purchase_orders; select count(*) from tenant.purchase_shipment_lines"`
Expected: `0` и `0`. Если `permission denied` — выдать `GRANT SELECT` так же, как роль получила права на 074 (посмотреть `db/ops/saas_ro_role.sql`/`db/ops/saas_triage_role.sql` и перезапустить нужный скрипт от postgres), в миграцию не добавлять.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/075_purchase_orders.sql
git commit -m "feat(purchase-orders): таблицы заказ/позиции/оплаты/отправки (миграция 075)"
```

---

### Task 2: Расчёт `calcOrder` (чистый слой)

**Files:**
- Create: `lib/purchaseOrders.js`
- Test: `lib/__tests__/purchaseOrders.test.mjs`

**Interfaces:**
- Produces:
  - `allocate(total: number, rows: {key, qty, weight}[]) → { byKey: Map<key, number>, basis: 'weight'|'qty', ok: boolean }`
  - `paymentRub(p: {currency, amount, rate}) → number`
  - `calcOrder({ order, payments, lines, shipments, shipmentLines }) → OrderCalc` — входы уже без удалённых строк; поля — как в БД (числа или числовые строки).
  - `OrderCalc = { totalCny, paidCny, remainingCny, rateEff, goodsRub, otherRub, logisticsRub, totalRub, qty, shippedQty, acceptedQty, shortageQty, shortageRub, warnings: string[], lines: LineCalc[], shipments: ShipCalc[] }`
  - `LineCalc = { id, qty, sumCny, goodsUnit, otherUnit, logisticsUnit: number|null, unitCost, shipped, accepted, shortage, surplus, shortageRub }`
  - `ShipCalc = { id, status, logisticsRub, basis, qty, value, lines: { line_id, qty_shipped, qty_accepted, alloc }[] }` (`value` = Σ qty_shipped × unitCost строки — для «товара в пути»)

- [ ] **Step 1: Написать падающие тесты**

```js
// lib/__tests__/purchaseOrders.test.mjs — заказ → позиции → отправки (спека 2026-10-27-purchase-orders-design.md §2).
import test from "node:test";
import assert from "node:assert/strict";
import { allocate, calcOrder, paymentRub } from "../purchaseOrders.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// Пример спеки §2.
const EX = () => ({
  order: { id: 1, rate_cny: 11.9 },
  payments: [
    { id: 1, kind: "prepay", currency: "cny", amount: 4000, rate: 11.46 },
    { id: 2, kind: "other", currency: "cny", amount: 300, rate: 11.5 },
  ],
  lines: [
    { id: 10, qty: 70, price_cny: 150, weight_kg: 0.3 },   // камера
    { id: 11, qty: 200, price_cny: 12.5, weight_kg: 0.1 }, // бельё
  ],
  shipments: [
    { id: 100, status: "accepted", cargo_rub: 12000, ff_rub: 4000 },
    { id: 101, status: "transit", cargo_rub: 5000, ff_rub: 0 },
  ],
  shipmentLines: [
    { shipment_id: 100, line_id: 10, qty_shipped: 40, qty_accepted: 38 },
    { shipment_id: 100, line_id: 11, qty_shipped: 200, qty_accepted: 200 },
    { shipment_id: 101, line_id: 10, qty_shipped: 30, qty_accepted: null },
  ],
});

test("allocate: по весу, если вес у всех", () => {
  const r = allocate(16000, [{ key: 10, qty: 40, weight: 0.3 }, { key: 11, qty: 200, weight: 0.1 }]);
  assert.equal(r.basis, "weight");
  close(r.byKey.get(10), 6000);
  close(r.byKey.get(11), 10000);
});

test("allocate: вес не у всех → по штукам", () => {
  const r = allocate(1000, [{ key: 1, qty: 30, weight: 0.5 }, { key: 2, qty: 70, weight: null }]);
  assert.equal(r.basis, "qty");
  close(r.byKey.get(1), 300);
  close(r.byKey.get(2), 700);
});

test("allocate: пустая база → ok:false", () => {
  assert.equal(allocate(500, []).ok, false);
});

test("paymentRub: ¥ × курс, ₽ как есть", () => {
  close(paymentRub({ currency: "cny", amount: 100, rate: 11.5 }), 1150);
  close(paymentRub({ currency: "rub", amount: 700, rate: null }), 700);
});

test("calcOrder: пример спеки — курс, товар, логистика, прочее", () => {
  const r = calcOrder(EX());
  close(r.totalCny, 13000);
  close(r.paidCny, 4000);
  close(r.remainingCny, 9000);
  close(r.rateEff, (4000 * 11.46 + 9000 * 11.9) / 13000);
  const cam = r.lines.find((l) => l.id === 10);
  const lin = r.lines.find((l) => l.id === 11);
  close(cam.goodsUnit, 150 * r.rateEff);
  close(cam.logisticsUnit, 11000 / 70);
  close(lin.logisticsUnit, 50);
  close(cam.otherUnit, 3450 * 21 / 41 / 70);
  close(lin.otherUnit, 3450 * 20 / 41 / 200);
  close(cam.unitCost, cam.goodsUnit + cam.otherUnit + cam.logisticsUnit);
  assert.equal(cam.shipped, 70);
});

test("calcOrder: инвариант — полностью отправленный заказ сходится до копейки", () => {
  const r = calcOrder(EX());
  const sum = r.lines.reduce((s, l) => s + l.unitCost * l.qty, 0);
  close(sum, r.goodsRub + r.otherRub + r.logisticsRub, 1e-6);
  close(r.totalRub, sum, 1e-6);
  close(r.logisticsRub, 21000);
  close(r.otherRub, 3450);
});

test("calcOrder: недостача только по принятым отправкам, на себестоимость не влияет", () => {
  const r = calcOrder(EX());
  const cam = r.lines.find((l) => l.id === 10);
  assert.equal(cam.accepted, 38);
  assert.equal(cam.shortage, 2);
  close(cam.shortageRub, 2 * cam.unitCost);
  assert.equal(r.shortageQty, 2);
  close(cam.logisticsUnit, 11000 / 70); // недостача не поднимает логистику
});

test("calcOrder: излишек показывается, недостачи нет", () => {
  const ex = EX();
  ex.shipmentLines[1].qty_accepted = 205;
  const lin = calcOrder(ex).lines.find((l) => l.id === 11);
  assert.equal(lin.surplus, 5);
  assert.equal(lin.shortage, 0);
});

test("calcOrder: ничего не отправлено → logisticsUnit null, unitCost без логистики", () => {
  const ex = EX();
  ex.shipments = []; ex.shipmentLines = [];
  const cam = calcOrder(ex).lines.find((l) => l.id === 10);
  assert.equal(cam.logisticsUnit, null);
  close(cam.unitCost, cam.goodsUnit + cam.otherUnit);
});

test("calcOrder: переплата → курс по оплатам и предупреждение", () => {
  const ex = EX();
  ex.payments.push({ id: 3, kind: "balance", currency: "cny", amount: 10000, rate: 12 });
  const r = calcOrder(ex);
  close(r.rateEff, (4000 * 11.46 + 10000 * 12) / 14000);
  close(r.remainingCny, 0);
  assert.ok(r.warnings.some((w) => /больше суммы заказа/.test(w)));
});

test("calcOrder: прочее в ₽; плановый курс не указан → предупреждение", () => {
  const ex = EX();
  ex.order.rate_cny = null;
  ex.payments[1] = { id: 2, kind: "other", currency: "rub", amount: 1000, rate: null };
  const r = calcOrder(ex);
  close(r.otherRub, 1000);
  close(r.rateEff, (4000 * 11.46) / 13000);
  assert.ok(r.warnings.some((w) => /плановый курс/.test(w)));
});

test("calcOrder: стоимость отправки в пути (value) = Σ шт × себестоимость", () => {
  const r = calcOrder(EX());
  const s = r.shipments.find((x) => x.id === 101);
  const cam = r.lines.find((l) => l.id === 10);
  close(s.value, 30 * cam.unitCost);
  assert.equal(s.qty, 30);
});

test("calcOrder: пустой заказ", () => {
  const r = calcOrder({ order: { id: 1, rate_cny: 12 }, payments: [], lines: [], shipments: [], shipmentLines: [] });
  assert.equal(r.totalCny, 0);
  assert.equal(r.rateEff, 12);
  assert.equal(r.lines.length, 0);
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test lib/__tests__/purchaseOrders.test.mjs`
Expected: FAIL — `Cannot find module '../purchaseOrders.js'`.

- [ ] **Step 3: Реализация**

```js
// lib/purchaseOrders.js — закупки «заказ → позиции → отправки» (спека
// docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Чистые функции, без БД.
// Себестоимость позиции = товар (эфф. курс оплат) + прочие расходы заказа + логистика отправок,
// на ОТПРАВЛЕННЫЕ штуки. Недостача при приёмке — только показ. Округление — у потребителя.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// Раскидка суммы: по весу (qty × weight), если вес > 0 у ВСЕХ строк, иначе по штукам.
export function allocate(total, rows) {
  const byKey = new Map();
  const allW = rows.length > 0 && rows.every((r) => num(r.weight) > 0);
  const base = rows.map((r) => (allW ? num(r.qty) * num(r.weight) : num(r.qty)));
  const sum = base.reduce((s, x) => s + x, 0);
  if (!(sum > 0)) return { byKey, basis: allW ? "weight" : "qty", ok: false };
  rows.forEach((r, i) => byKey.set(r.key, (num(total) * base[i]) / sum));
  return { byKey, basis: allW ? "weight" : "qty", ok: true };
}

export function paymentRub(p) {
  return p.currency === "rub" ? num(p.amount) : num(p.amount) * num(p.rate);
}

export function calcOrder({ order, payments = [], lines = [], shipments = [], shipmentLines = [] }) {
  const warnings = [];
  const planRate = numOrNull(order?.rate_cny);
  const totalCny = lines.reduce((s, l) => s + num(l.qty) * num(l.price_cny), 0);

  const goodsPays = payments.filter((p) => p.kind === "prepay" || p.kind === "balance");
  const paidCny = goodsPays.reduce((s, p) => s + num(p.amount), 0);
  const paidRub = goodsPays.reduce((s, p) => s + paymentRub(p), 0);
  const remainingCny = Math.max(0, totalCny - paidCny);
  let rateEff;
  if (totalCny <= 0) rateEff = planRate ?? (paidCny > 0 ? paidRub / paidCny : 0);
  else if (paidCny > totalCny) {
    rateEff = paidRub / paidCny;
    warnings.push(`оплачено ${paidCny} ¥ — больше суммы заказа ${totalCny} ¥`);
  } else {
    if (remainingCny > 0 && planRate == null) warnings.push("не указан плановый курс заказа — неоплаченный остаток посчитан по 0");
    rateEff = (paidRub + remainingCny * (planRate ?? 0)) / totalCny;
  }

  const otherRub = payments.filter((p) => p.kind === "other").reduce((s, p) => s + paymentRub(p), 0);
  const otherAlloc = allocate(otherRub, lines.map((l) => ({ key: Number(l.id), qty: l.qty, weight: l.weight_kg })));
  if (otherRub > 0 && !otherAlloc.ok) warnings.push("прочие расходы не на что раскидать — нет позиций");

  const lineById = new Map(lines.map((l) => [Number(l.id), l]));
  const logByLine = new Map();     // line_id → Σ доли логистики
  const shippedByLine = new Map(); // line_id → Σ qty_shipped
  const acceptedByLine = new Map(); // line_id → { shipped, accepted } по принятым отправкам
  let logisticsRub = 0;
  const shipCalcs = shipments.map((s) => {
    const sl = shipmentLines.filter((x) => Number(x.shipment_id) === Number(s.id) && lineById.has(Number(x.line_id)));
    const L = num(s.cargo_rub) + num(s.ff_rub);
    logisticsRub += L;
    const al = allocate(L, sl.map((x) => ({ key: Number(x.line_id), qty: x.qty_shipped, weight: lineById.get(Number(x.line_id)).weight_kg })));
    if (L > 0 && !al.ok) warnings.push(`логистику отправки #${s.id} не на что раскидать`);
    for (const x of sl) {
      const k = Number(x.line_id);
      logByLine.set(k, (logByLine.get(k) || 0) + (al.byKey.get(k) || 0));
      shippedByLine.set(k, (shippedByLine.get(k) || 0) + num(x.qty_shipped));
      if (s.status === "accepted" && x.qty_accepted != null) {
        const a = acceptedByLine.get(k) || { shipped: 0, accepted: 0 };
        a.shipped += num(x.qty_shipped); a.accepted += num(x.qty_accepted);
        acceptedByLine.set(k, a);
      }
    }
    return { id: Number(s.id), status: s.status, logisticsRub: L, basis: al.basis,
      lines: sl.map((x) => ({ line_id: Number(x.line_id), qty_shipped: num(x.qty_shipped),
        qty_accepted: x.qty_accepted == null ? null : num(x.qty_accepted), alloc: al.byKey.get(Number(x.line_id)) || 0 })) };
  });

  const lineCalcs = lines.map((l) => {
    const id = Number(l.id);
    const qty = num(l.qty);
    const goodsUnit = num(l.price_cny) * rateEff;
    const otherUnit = qty > 0 ? (otherAlloc.byKey.get(id) || 0) / qty : 0;
    const shipped = shippedByLine.get(id) || 0;
    const logisticsUnit = shipped > 0 ? (logByLine.get(id) || 0) / shipped : null;
    const unitCost = goodsUnit + otherUnit + (logisticsUnit ?? 0);
    const acc = acceptedByLine.get(id);
    const diff = acc ? acc.shipped - acc.accepted : 0;
    const shortage = Math.max(0, diff);
    return { id, qty, sumCny: qty * num(l.price_cny), goodsUnit, otherUnit, logisticsUnit, unitCost, shipped,
      accepted: acc ? acc.accepted : 0, shortage, surplus: Math.max(0, -diff), shortageRub: shortage * unitCost };
  });
  const unitById = new Map(lineCalcs.map((l) => [l.id, l.unitCost]));
  for (const s of shipCalcs) {
    s.qty = s.lines.reduce((t, x) => t + x.qty_shipped, 0);
    s.value = s.lines.reduce((t, x) => t + x.qty_shipped * (unitById.get(x.line_id) || 0), 0);
  }

  const goodsRub = totalCny * rateEff;
  return {
    totalCny, paidCny, remainingCny, rateEff, goodsRub, otherRub, logisticsRub,
    totalRub: lineCalcs.reduce((s, l) => s + l.unitCost * l.qty, 0),
    qty: lineCalcs.reduce((s, l) => s + l.qty, 0),
    shippedQty: lineCalcs.reduce((s, l) => s + l.shipped, 0),
    acceptedQty: lineCalcs.reduce((s, l) => s + l.accepted, 0),
    shortageQty: lineCalcs.reduce((s, l) => s + l.shortage, 0),
    shortageRub: lineCalcs.reduce((s, l) => s + l.shortageRub, 0),
    warnings, lines: lineCalcs, shipments: shipCalcs,
  };
}
```

Примечание: `totalRub` = Σ unitCost × qty; при неполной отправке он меньше `goodsRub + otherRub + logisticsRub` не бывает (логистика считается только по отправленному) — для частично отправленного заказа логистика неотправленных штук ещё не известна, это ожидаемо.

- [ ] **Step 4: Тесты зелёные**

Run: `node --test lib/__tests__/purchaseOrders.test.mjs`
Expected: все PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/purchaseOrders.js lib/__tests__/purchaseOrders.test.mjs
git commit -m "feat(purchase-orders): расчёт себестоимости позиции заказа (calcOrder)"
```

---

### Task 3: Валидаторы и правила отправок (чистый слой)

**Files:**
- Modify: `lib/purchaseOrders.js` (добавить в конец)
- Test: `lib/__tests__/purchaseOrders.test.mjs` (добавить в конец)

**Interfaces:**
- Produces (все возвращают `{ ok: true, value } | { ok: false, error: string }`, если не сказано иное):
  - `validateOrderInput(raw)` → `value = { order_no, supplier, supplier_contact, source_country, category, note, order_dt, rate_cny, status }`
  - `validateLineInput(raw)` → `value = { platform, nm_id, product_id, label, variant, qty, price_cny, weight_kg, photo_url, note }`
  - `validatePaymentInput(raw)` → `value = { kind, currency, amount, rate, plan_date, note }`
  - `validateShipmentInput(raw)` → `value = { shipment_no, carrier, ship_dt, eta, arrived_dt, cargo_rub, ff_rub, note, lines: {line_id, qty_shipped}[] | undefined }` (`lines` undefined, если в raw нет ключа `lines`)
  - `checkShipQty(lines, shipmentLines, newLines, excludeShipmentId) → string|null` — ошибка, если Σ отправленного по позиции > qty
  - `defaultShipmentLines(lines, shipmentLines) → {line_id, qty_shipped}[]` — неотправленные остатки
  - `autoOrderStatus(currentStatus, lines, shipments, shipmentLines) → status`
  - `cargoRub(totalKg, usdPerKg, rateUsd) → number`
  - `ORDER_STATUS_LABELS`, `PAY_KIND_LABELS`, `SHIP_STATUS_LABELS` (объекты код → русская подпись)

- [ ] **Step 1: Падающие тесты (дописать в файл)**

```js
import { validateOrderInput, validateLineInput, validatePaymentInput, validateShipmentInput,
  checkShipQty, defaultShipmentLines, autoOrderStatus, cargoRub } from "../purchaseOrders.js";

test("validateOrderInput: поставщик обязателен, курс > 0 или пусто, дата ISO", () => {
  assert.equal(validateOrderInput({ supplier: " " }).ok, false);
  assert.equal(validateOrderInput({ supplier: "A", rate_cny: -1 }).ok, false);
  assert.equal(validateOrderInput({ supplier: "A", order_dt: "27.10.2026" }).ok, false);
  assert.equal(validateOrderInput({ supplier: "A", status: "nope" }).ok, false);
  const v = validateOrderInput({ supplier: " hanyou ", rate_cny: "11,9", order_dt: "2026-10-27" });
  assert.equal(v.ok, true);
  assert.equal(v.value.supplier, "hanyou");
  assert.equal(v.value.rate_cny, 11.9);
  assert.equal(v.value.status, "draft");
});

test("validateLineInput: артикул или текст, qty целое > 0, вес пусто или > 0", () => {
  assert.equal(validateLineInput({ label: "", qty: 1 }).ok, false);
  assert.equal(validateLineInput({ label: "x", qty: 0 }).ok, false);
  assert.equal(validateLineInput({ label: "x", qty: 1.5 }).ok, false);
  assert.equal(validateLineInput({ label: "x", qty: 1, weight_kg: 0 }).ok, false);
  assert.equal(validateLineInput({ platform: "wb", label: "x", qty: 1 }).ok, false);
  const v = validateLineInput({ platform: "ozon", product_id: "55", label: "Трусы", variant: "M", qty: "10", price_cny: "12,5", weight_kg: "" });
  assert.equal(v.ok, true);
  assert.deepEqual([v.value.product_id, v.value.nm_id, v.value.qty, v.value.price_cny, v.value.weight_kg], [55, null, 10, 12.5, null]);
});

test("validatePaymentInput: товар только в ¥ с курсом; прочее в ₽ без курса", () => {
  assert.equal(validatePaymentInput({ kind: "prepay", currency: "rub", amount: 1 }).ok, false);
  assert.equal(validatePaymentInput({ kind: "prepay", amount: 1 }).ok, false); // нет курса
  assert.equal(validatePaymentInput({ kind: "prepay", amount: 0, rate: 11 }).ok, false);
  const a = validatePaymentInput({ kind: "prepay", amount: "4000", rate: "11.46", plan_date: "2026-10-01" });
  assert.equal(a.ok, true);
  assert.equal(a.value.currency, "cny");
  const b = validatePaymentInput({ kind: "other", currency: "rub", amount: 700, rate: 5 });
  assert.equal(b.ok, true);
  assert.equal(b.value.rate, null);
});

test("validateShipmentInput: деньги ≥ 0, строки без дублей", () => {
  assert.equal(validateShipmentInput({ cargo_rub: -1 }).ok, false);
  assert.equal(validateShipmentInput({ lines: [{ line_id: 1, qty_shipped: 1 }, { line_id: 1, qty_shipped: 2 }] }).ok, false);
  assert.equal(validateShipmentInput({ lines: [{ line_id: 1, qty_shipped: 0 }] }).ok, false);
  const v = validateShipmentInput({ shipment_no: "TRK1", cargo_rub: "12000", lines: [{ line_id: "10", qty_shipped: "40" }] });
  assert.equal(v.ok, true);
  assert.equal(v.value.ff_rub, 0);
  assert.deepEqual(v.value.lines, [{ line_id: 10, qty_shipped: 40 }]);
  assert.equal(validateShipmentInput({ note: "x" }).value.lines, undefined);
});

test("checkShipQty: нельзя отправить больше заказанного (с учётом других отправок)", () => {
  const lines = [{ id: 10, qty: 70, label: "камера" }];
  const sl = [{ shipment_id: 100, line_id: 10, qty_shipped: 40 }];
  assert.equal(checkShipQty(lines, sl, [{ line_id: 10, qty_shipped: 30 }], null), null);
  assert.match(checkShipQty(lines, sl, [{ line_id: 10, qty_shipped: 31 }], null), /камера/);
  assert.equal(checkShipQty(lines, sl, [{ line_id: 10, qty_shipped: 70 }], 100), null); // правка той же отправки
  assert.match(checkShipQty(lines, sl, [{ line_id: 99, qty_shipped: 1 }], null), /не из этого заказа/);
});

test("defaultShipmentLines: только неотправленные остатки", () => {
  const lines = [{ id: 10, qty: 70 }, { id: 11, qty: 200 }];
  const sl = [{ shipment_id: 100, line_id: 10, qty_shipped: 40 }, { shipment_id: 100, line_id: 11, qty_shipped: 200 }];
  assert.deepEqual(defaultShipmentLines(lines, sl), [{ line_id: 10, qty_shipped: 30 }]);
});

test("autoOrderStatus: закрыт, когда всё отправлено и всё принято; иначе откат из closed", () => {
  const lines = [{ id: 10, qty: 70 }];
  const ships = [{ id: 100, status: "accepted" }];
  const full = [{ shipment_id: 100, line_id: 10, qty_shipped: 70 }];
  assert.equal(autoOrderStatus("shipping", lines, ships, full), "closed");
  assert.equal(autoOrderStatus("closed", lines, [{ id: 100, status: "arrived" }], full), "shipping");
  assert.equal(autoOrderStatus("ordered", lines, ships, [{ shipment_id: 100, line_id: 10, qty_shipped: 10 }]), "shipping");
  assert.equal(autoOrderStatus("ordered", lines, [], []), "ordered");
  assert.equal(autoOrderStatus("draft", [], [], []), "draft");
});

test("cargoRub: кг × $/кг × курс $", () => {
  close(cargoRub(50, 3.5, 90), 15750);
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test lib/__tests__/purchaseOrders.test.mjs`
Expected: FAIL — `validateOrderInput is not a function` (или SyntaxError импорта).

- [ ] **Step 3: Реализация (дописать в `lib/purchaseOrders.js`)**

```js
export const ORDER_STATUS_LABELS = { draft: "Черновик", ordered: "Заказан", production: "В производстве", shipping: "Отгружается", closed: "Закрыт" };
export const PAY_KIND_LABELS = { prepay: "Предоплата", balance: "Доплата", other: "Прочее (доставка по Китаю и т.п.)" };
export const SHIP_STATUS_LABELS = { transit: "В пути", arrived: "Прибыла", accepted: "Принята" };

const TEXT_MAX = 300;
const txt = (v) => { const s = String(v ?? "").trim(); return s ? s.slice(0, TEXT_MAX) : null; };
const parseNum = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};
const isoDate = (v) => {
  if (v == null || v === "") return { ok: true, v: null };
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { ok: true, v: s } : { ok: false };
};
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const fail = (error) => ({ ok: false, error });

export function validateOrderInput(raw = {}) {
  const supplier = txt(raw.supplier);
  if (!supplier) return fail("укажите поставщика");
  const rate = parseNum(raw.rate_cny);
  if (Number.isNaN(rate) || (rate != null && rate <= 0)) return fail("плановый курс ¥ — число > 0 или пусто");
  const d = isoDate(raw.order_dt);
  if (!d.ok) return fail("дата заказа — ГГГГ-ММ-ДД");
  const status = raw.status == null || raw.status === "" ? "draft" : String(raw.status);
  if (!ORDER_STATUS_LABELS[status]) return fail("неизвестный статус заказа");
  return { ok: true, value: { order_no: txt(raw.order_no), supplier, supplier_contact: txt(raw.supplier_contact),
    source_country: txt(raw.source_country), category: txt(raw.category), note: txt(raw.note),
    order_dt: d.v, rate_cny: rate, status } };
}

export function validateLineInput(raw = {}) {
  const platform = raw.platform ? String(raw.platform) : null;
  if (platform && platform !== "wb" && platform !== "ozon") return fail("площадка: wb, ozon или пусто");
  let nm_id = null, product_id = null;
  if (platform === "wb") { nm_id = posInt(raw.nm_id); if (!nm_id) return fail("нет артикула WB (nm_id)"); }
  if (platform === "ozon") { product_id = posInt(raw.product_id); if (!product_id) return fail("нет товара Ozon (product_id)"); }
  const label = txt(raw.label);
  if (!label) return fail("укажите товар: артикул или название");
  const qty = Number(raw.qty);
  if (!Number.isInteger(qty) || qty <= 0) return fail("количество — целое число > 0");
  const price = parseNum(raw.price_cny) ?? 0;
  if (Number.isNaN(price) || price < 0) return fail("цена ¥ — число ≥ 0");
  const w = parseNum(raw.weight_kg);
  if (Number.isNaN(w) || (w != null && w <= 0)) return fail("вес — число > 0 или пусто");
  return { ok: true, value: { platform, nm_id, product_id, label, variant: txt(raw.variant), qty, price_cny: price,
    weight_kg: w, photo_url: txt(raw.photo_url), note: txt(raw.note) } };
}

export function validatePaymentInput(raw = {}) {
  const kind = String(raw.kind || "");
  if (!PAY_KIND_LABELS[kind]) return fail("вид оплаты: предоплата, доплата или прочее");
  const currency = raw.currency === "rub" ? "rub" : "cny";
  if (kind !== "other" && currency !== "cny") return fail("оплата товара — только в ¥");
  const amount = parseNum(raw.amount);
  if (amount == null || Number.isNaN(amount) || amount <= 0) return fail("сумма — число > 0");
  let rate = null;
  if (currency === "cny") {
    rate = parseNum(raw.rate);
    if (rate == null || Number.isNaN(rate) || rate <= 0) return fail("курс оплаты — число > 0");
  }
  const d = isoDate(raw.plan_date);
  if (!d.ok) return fail("дата оплаты — ГГГГ-ММ-ДД");
  return { ok: true, value: { kind, currency, amount, rate, plan_date: d.v, note: txt(raw.note) } };
}

export function validateShipmentInput(raw = {}) {
  const dates = {};
  for (const k of ["ship_dt", "eta", "arrived_dt"]) {
    const d = isoDate(raw[k]);
    if (!d.ok) return fail(`${k} — ГГГГ-ММ-ДД`);
    dates[k] = d.v;
  }
  const money = {};
  for (const k of ["cargo_rub", "ff_rub"]) {
    const n = parseNum(raw[k]) ?? 0;
    if (Number.isNaN(n) || n < 0) return fail("логистика — число ≥ 0");
    money[k] = n;
  }
  let lines;
  if (raw.lines !== undefined) {
    if (!Array.isArray(raw.lines)) return fail("lines — список");
    const seen = new Set();
    lines = [];
    for (const x of raw.lines) {
      const line_id = posInt(x?.line_id), q = posInt(x?.qty_shipped);
      if (!line_id) return fail("строка отправки без позиции");
      if (!q) return fail("отправлено — целое число > 0");
      if (seen.has(line_id)) return fail("позиция повторяется в отправке");
      seen.add(line_id);
      lines.push({ line_id, qty_shipped: q });
    }
  }
  return { ok: true, value: { shipment_no: txt(raw.shipment_no), carrier: txt(raw.carrier), ...dates, ...money,
    note: txt(raw.note), lines } };
}

export function checkShipQty(lines, shipmentLines, newLines, excludeShipmentId) {
  const byId = new Map(lines.map((l) => [Number(l.id), l]));
  const used = new Map();
  for (const x of shipmentLines) {
    if (excludeShipmentId != null && Number(x.shipment_id) === Number(excludeShipmentId)) continue;
    used.set(Number(x.line_id), (used.get(Number(x.line_id)) || 0) + Number(x.qty_shipped));
  }
  for (const n of newLines) {
    const l = byId.get(Number(n.line_id));
    if (!l) return `позиция ${n.line_id} не из этого заказа`;
    const total = (used.get(Number(n.line_id)) || 0) + Number(n.qty_shipped);
    if (total > Number(l.qty)) return `«${l.label || l.id}»: отправлено ${total} из заказанных ${l.qty}`;
  }
  return null;
}

export function defaultShipmentLines(lines, shipmentLines) {
  const used = new Map();
  for (const x of shipmentLines) used.set(Number(x.line_id), (used.get(Number(x.line_id)) || 0) + Number(x.qty_shipped));
  return lines
    .map((l) => ({ line_id: Number(l.id), qty_shipped: Number(l.qty) - (used.get(Number(l.id)) || 0) }))
    .filter((x) => x.qty_shipped > 0);
}

export function autoOrderStatus(current, lines, shipments, shipmentLines) {
  if (!lines.length) return current === "closed" ? "ordered" : current;
  const live = new Set(shipments.map((s) => Number(s.id)));
  const sl = shipmentLines.filter((x) => live.has(Number(x.shipment_id)));
  const fullyShipped = defaultShipmentLines(lines, sl).length === 0;
  const allAccepted = shipments.length > 0 && shipments.every((s) => s.status === "accepted");
  if (fullyShipped && allAccepted) return "closed";
  if (sl.length > 0) return "shipping";
  return current === "closed" || current === "shipping" ? "ordered" : current;
}

export function cargoRub(totalKg, usdPerKg, rateUsd) {
  return num(totalKg) * num(usdPerKg) * num(rateUsd);
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `node --test lib/__tests__/purchaseOrders.test.mjs`
Expected: все PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/purchaseOrders.js lib/__tests__/purchaseOrders.test.mjs
git commit -m "feat(purchase-orders): валидаторы ввода и правила отправок"
```

---

### Task 4: Платежи заказа в календарь/ДДС

**Files:**
- Modify: `lib/paymentCalendar.js` (добавить `orderPayments` после `purchasePayments`, ~стр. 97)
- Modify: `lib/paymentCalendarData.js:15-65` (вынести общий `syncRefs`, добавить `syncOrderPayments`, `archiveOrderPayments`)
- Test: `lib/__tests__/paymentCalendar.test.mjs` (дописать), `lib/__tests__/paymentCalendarGuard.test.mjs` (дописать)

**Interfaces:**
- Consumes: `paymentRub` из `lib/purchaseOrders.js`.
- Produces:
  - `orderPayments(order, payments, shipments) → { ref, article, amount, date, description }[]` (чистая)
  - `syncOrderPayments(orderId) → Promise<{upserted, archived}>` — читает заказ сам; удалённый заказ → архивирует всё
  - `archiveOrderPayments(orderId) → Promise<number>`

- [ ] **Step 1: Падающий тест чистой функции (в конец `lib/__tests__/paymentCalendar.test.mjs`)**

```js
import { orderPayments } from "../paymentCalendar.js";

test("orderPayments: оплаты и логистика отправок, refs, статьи, даты", () => {
  const order = { id: 7, order_no: "A-1", order_dt: "2026-10-01", created_at: "2026-09-30" };
  const pays = [
    { id: 1, kind: "prepay", currency: "cny", amount: 4000, rate: 11.46, plan_date: "2026-10-02" },
    { id: 2, kind: "other", currency: "rub", amount: 700, rate: null, plan_date: null },
  ];
  const ships = [
    { id: 5, cargo_rub: 12000, ff_rub: 0, ship_dt: "2026-10-10", eta: "2026-10-25", arrived_dt: null },
  ];
  const r = orderPayments(order, pays, ships);
  assert.deepEqual(r.map((x) => [x.ref, x.article, x.amount, x.date]), [
    ["order:7:pay:1", "supplier", 45840, "2026-10-02"],
    ["order:7:pay:2", "cargo", 700, "2026-10-01"],
    ["order:7:ship:5:cargo", "cargo", 12000, "2026-10-25"],
  ]);
  assert.match(r[0].description, /Заказ A-1 · предоплата/);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `node --test lib/__tests__/paymentCalendar.test.mjs`
Expected: FAIL — `orderPayments` не экспортирован.

- [ ] **Step 3: Реализация `orderPayments` (в `lib/paymentCalendar.js` после `purchasePayments`)**

```js
import { paymentRub } from "./purchaseOrders.js"; // ← в шапку файла к остальным import

// Заказ закупки (спека 2026-10-27-purchase-orders-design.md §5): оплата → строка «Поставщик»
// (прочее — «Карго/логистика»), отправка → до двух строк «Карго/логистика» (до МСК, МСК→ФФ).
const ORDER_PAY_WHAT = { prepay: "предоплата", balance: "доплата", other: "прочие расходы" };
export function orderPayments(order, payments, shipments) {
  const fallback = firstDate(order.order_dt, order.created_at) || new Date().toISOString().slice(0, 10);
  const name = order.order_no ? `Заказ ${order.order_no}` : `Заказ #${order.id}`;
  const out = [];
  for (const p of payments) {
    const amount = r2(paymentRub(p));
    if (!(amount > 0)) continue;
    out.push({ ref: `order:${order.id}:pay:${p.id}`, article: p.kind === "other" ? "cargo" : "supplier", amount,
      date: firstDate(p.plan_date) || fallback, description: `${name} · ${ORDER_PAY_WHAT[p.kind] || p.kind}` });
  }
  for (const s of shipments) {
    const date = firstDate(s.arrived_dt, s.eta, s.ship_dt) || fallback;
    const label = s.shipment_no ? `отправка ${s.shipment_no}` : `отправка #${s.id}`;
    for (const [key, what, v] of [["cargo", "карго до МСК", s.cargo_rub], ["ff", "МСК→ФФ", s.ff_rub]]) {
      const amount = r2(Number(v) || 0);
      if (amount > 0) out.push({ ref: `order:${order.id}:ship:${s.id}:${key}`, article: "cargo", amount, date,
        description: `${name} · ${label} · ${what}` });
    }
  }
  return out;
}
```

- [ ] **Step 4: Тест зелёный**

Run: `node --test lib/__tests__/paymentCalendar.test.mjs`
Expected: PASS.

- [ ] **Step 5: Вынести общий синк в `lib/paymentCalendarData.js`**

Заменить тело `syncPurchasePayments` и `archivePurchasePayments` (стр. 15–65) на общий хелпер; поведение для старых партий не меняется:

```js
import { purchasePayments, orderPayments, expandRecurring, wbPayoutWindows, ozPayoutWindows, readPayoutSettings, addDays } from "./paymentCalendar.js";

// Общий синк плановых строк ДДС по набору ref с префиксом (партия / заказ закупки).
// Оплаченные не трогаем; date_locked — дату не двигаем; исчезнувшие плановые → archived.
async function syncRefs(prefix, want, counterparty) {
  const existing = await tenantQuery(
    `SELECT id, source_ref, status, date_locked FROM tenant.dds_movements
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status <> 'archived'`, [`${prefix}%`]);
  const byRef = new Map(existing.map((r) => [r.source_ref, r]));
  let upserted = 0, archived = 0;
  for (const w of want) {
    const cur = byRef.get(w.ref);
    byRef.delete(w.ref);
    if (!cur) {
      // Без ON CONFLICT: ref проверен выше в той же транзакции; строка-источник (партия/заказ)
      // заблокирована роутом раньше синка — параллельная вставка того же ref невозможна.
      await tenantQuery(
        `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, article_key, counterparty,
           description, status, source, source_kind, source_ref)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, 'expense', $2, $2, $3, $4, $5, 'planned', 'purchase', 'purchase', $6)`,
        [w.date, w.amount, w.article, counterparty, w.description, w.ref]);
      upserted++;
    } else if (cur.status === "planned") {
      // description не трогаем: комментарий из календаря переживает сохранение источника.
      await tenantQuery(
        `UPDATE tenant.dds_movements SET amount = $1, amount_planned = $1, counterparty = $2, article_key = $5,
            date = CASE WHEN date_locked THEN date ELSE $3 END, updated_at = now() WHERE id = $4`,
        [w.amount, counterparty, w.date, cur.id, w.article]);
      upserted++;
    }
  }
  for (const stale of byRef.values()) {
    if (stale.status !== "planned") continue; // оплаченное не трогаем
    await tenantQuery(`UPDATE tenant.dds_movements SET status = 'archived', updated_at = now() WHERE id = $1`, [stale.id]);
    archived++;
  }
  return { upserted, archived };
}

async function archiveRefs(prefix) {
  const r = await tenantQuery(
    `UPDATE tenant.dds_movements SET status = 'archived', updated_at = now()
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status = 'planned' RETURNING id`, [`${prefix}%`]);
  return r.length;
}

export async function syncPurchasePayments(purchaseId) {
  const p = (await tenantQuery(`SELECT * FROM tenant.purchases WHERE id = $1`, [purchaseId]))[0];
  // «Архив до 16.10» (purchases.legacy_at, миграция 071) — история, платежи не пересоздаём: их строки ДДС
  // владелец 18.10.2026 убрал в архив (ДДС ведётся с 18.10), и синк вставил бы их заново как planned.
  if (p?.legacy_at) return { upserted: 0, archived: 0 };
  if (!p || p.deleted_at) return { upserted: 0, archived: await archivePurchasePayments(purchaseId) };
  return syncRefs(`purchase:${purchaseId}:`, purchasePayments(p), p.supplier_name || null);
}

export async function archivePurchasePayments(purchaseId) {
  return archiveRefs(`purchase:${purchaseId}:`);
}

// Заказ закупки (спека 2026-10-27 §5). Вызывать в той же транзакции после любой правки шапки,
// оплат или отправок заказа (заказ к этому моменту заблокирован роутом FOR UPDATE).
export async function syncOrderPayments(orderId) {
  const o = (await tenantQuery(
    `SELECT id, order_no, supplier, order_dt::text AS order_dt, created_at::text AS created_at, deleted_at
       FROM tenant.purchase_orders WHERE id = $1`, [orderId]))[0];
  if (!o || o.deleted_at) return { upserted: 0, archived: await archiveOrderPayments(orderId) };
  const pays = await tenantQuery(
    `SELECT id, kind, currency, amount::float8 AS amount, rate::float8 AS rate, plan_date::text AS plan_date
       FROM tenant.purchase_order_payments WHERE order_id = $1 AND deleted_at IS NULL ORDER BY id`, [orderId]);
  const ships = await tenantQuery(
    `SELECT id, shipment_no, cargo_rub::float8 AS cargo_rub, ff_rub::float8 AS ff_rub,
            ship_dt::text AS ship_dt, eta::text AS eta, arrived_dt::text AS arrived_dt
       FROM tenant.purchase_shipments WHERE order_id = $1 AND deleted_at IS NULL ORDER BY id`, [orderId]);
  return syncRefs(`order:${orderId}:`, orderPayments(o, pays, ships), o.supplier || null);
}

export async function archiveOrderPayments(orderId) {
  return archiveRefs(`order:${orderId}:`);
}
```

Важно: префикс `order:7:` не должен ловить `order:70:` — двоеточие в конце префикса это гарантирует (`LIKE 'order:7:%'`).

- [ ] **Step 6: Проверить, что `editRules` в `lib/dds.js` трактует новые строки как партию**

Run: `grep -n "source_kind" lib/dds.js | head`
Expected: правило для `purchase` — по `source_kind`, не по формату `source_ref`. Если где-то парсится `source_ref` вида `purchase:` (grep `purchase:` в `lib/`, `app/`), — расширить на `order:` в том же месте. Ожидаемо — ничего не нужно.

- [ ] **Step 7: Гард (в конец `lib/__tests__/paymentCalendarGuard.test.mjs`)**

```js
test("заказы закупки: ДДС пишется только через paymentCalendarData", () => {
  for (const p of ["app/api/cabinets/[id]/purchase-orders/route.js", "lib/purchaseOrdersData.js", "app/api/cabinets/[id]/deliveries/route.js"]) {
    const src = read(p);
    assert.doesNotMatch(src, /dds_movements/, `${p} пишет dds_movements напрямую`);
  }
  assert.match(read("app/api/cabinets/[id]/purchase-orders/route.js"), /syncOrderPayments\(/);
});
```

(Тест упадёт до Task 6 — файлов ещё нет; это ожидаемо, в этой задаче он не запускается.)

- [ ] **Step 8: Прогон затронутых тестов**

Run: `node --test lib/__tests__/paymentCalendar.test.mjs lib/__tests__/dds.test.mjs lib/__tests__/ddsGuard.test.mjs`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/paymentCalendar.js lib/paymentCalendarData.js lib/__tests__/paymentCalendar.test.mjs lib/__tests__/paymentCalendarGuard.test.mjs
git commit -m "feat(purchase-orders): платежи заказа и логистика отправок в календарь"
```

---

### Task 5: Слой данных `lib/purchaseOrdersData.js` + поиск каталога

**Files:**
- Create: `lib/purchaseOrdersData.js`
- Create: `lib/catalogSearch.js`
- Modify: `app/api/cabinets/[id]/deliveries/route.js:19-34,72-82` (использовать `lib/catalogSearch.js`)

**Interfaces:**
- Consumes: `calcOrder`, `autoOrderStatus` (Task 2–3).
- Produces:
  - `searchCatalog(q) → Promise<{platform, nm_id?, product_id?, label, im_url, article}[]>`; `catalogLabel(line) → Promise<string|null>`; `catalogPhoto(line) → Promise<string|null>`
  - `loadOrder(id, { lock = false } = {}) → Promise<{ order, payments, lines, shipments, shipmentLines } | null>` (без удалённых; `lock` → `FOR UPDATE` строки заказа)
  - `loadOrderView(id) → Promise<{ ...bundle, calc, dds: {source_ref, status, paid_at}[] } | null>`
  - `listOrders({ status, supplier, category, closed }) → Promise<OrderRow[]>`, `OrderRow = { id, order_no, supplier, category, order_dt, status, lines, qty, totalCny, totalRub, paidCny, shippedQty, acceptedQty, shortageQty, avgUnitCost }`
  - `refreshOrderStatus(id) → Promise<string>` — пересчитать и сохранить `status`/`archived_at`
  - `ordersInTransit() → Promise<{ total, items: {id, name, qty, unit_cost, value, lifecycle}[] }>`
  - `lockShipment(id) → Promise<shipmentRow|null>` (FOR UPDATE, вместе с `order_id`)

- [ ] **Step 1: `lib/catalogSearch.js`** — перенести `loadCatalog` и `catalogLabel` из deliveries route без изменений логики

```js
// lib/catalogSearch.js — поиск артикула WB/Ozon для строк закупок и приёмки (вынесено из
// app/api/cabinets/[id]/deliveries/route.js 27.10.2026). Внутри withTenant.
import { tenantQuery } from "./db.js";

export async function searchCatalog(q) {
  const needle = `%${String(q || "").trim()}%`;
  const out = [];
  const wb = await tenantQuery(
    `SELECT nm_id, name, im_url FROM tenant.wb_articles
     WHERE name ILIKE $1 OR nm_id::text LIKE $1 ORDER BY name LIMIT 20`, [needle]);
  for (const r of wb) out.push({ platform: "wb", nm_id: Number(r.nm_id), label: r.name || `WB ${r.nm_id}`, im_url: r.im_url || null, article: null });
  const oz = await tenantQuery(
    `SELECT product_id, offer_id, name, im_url FROM tenant.ozon_products
     WHERE name ILIKE $1 OR offer_id ILIKE $1 OR product_id::text LIKE $1 ORDER BY name LIMIT 20`, [needle]);
  for (const r of oz) out.push({ platform: "ozon", product_id: Number(r.product_id), label: r.name || `Ozon ${r.product_id}`, im_url: r.im_url || null, article: r.offer_id || null });
  return out.slice(0, 20);
}

async function catalogRow(line) {
  if (line.platform === "wb") return (await tenantQuery(`SELECT name, im_url FROM tenant.wb_articles WHERE nm_id = $1`, [Number(line.nm_id)]))[0];
  if (line.platform === "ozon") return (await tenantQuery(`SELECT name, im_url FROM tenant.ozon_products WHERE product_id = $1`, [Number(line.product_id)]))[0];
  return null;
}
export async function catalogLabel(line) { return (await catalogRow(line))?.name || null; }
export async function catalogPhoto(line) { return (await catalogRow(line))?.im_url || null; }
```

В `deliveries/route.js`: удалить локальные `loadCatalog` и `catalogLabel`, добавить `import { searchCatalog, catalogLabel } from "@/lib/catalogSearch.js";`, вызов `loadCatalog(...)` → `searchCatalog(...)`.

- [ ] **Step 2: `lib/purchaseOrdersData.js`**

```js
// lib/purchaseOrdersData.js — БД заказов закупки (спека 2026-10-27-purchase-orders-design.md).
// Всё внутри withTenant (одна транзакция роута), запросы последовательно. Расчёт — lib/purchaseOrders.js.
import { tenantQuery } from "./db.js";
import { calcOrder, autoOrderStatus } from "./purchaseOrders.js";

const ORDER_COLS = `id, order_no, supplier, supplier_contact, source_country, category, note,
  order_dt::text AS order_dt, rate_cny::float8 AS rate_cny, status, archived_at::text AS archived_at,
  created_at::text AS created_at`;
const PAY_COLS = `id, order_id, kind, currency, amount::float8 AS amount, rate::float8 AS rate,
  plan_date::text AS plan_date, note`;
const LINE_COLS = `l.id, l.order_id, l.platform, l.nm_id, l.product_id, l.label, l.variant, l.qty,
  l.price_cny::float8 AS price_cny, l.weight_kg::float8 AS weight_kg, l.note,
  COALESCE(l.photo_url, a.im_url, o.im_url) AS photo, o.offer_id AS article`;
const LINE_JOIN = `LEFT JOIN tenant.wb_articles a ON l.platform = 'wb' AND a.cabinet_id = l.cabinet_id AND a.nm_id = l.nm_id
  LEFT JOIN tenant.ozon_products o ON l.platform = 'ozon' AND o.cabinet_id = l.cabinet_id AND o.product_id = l.product_id`;
const SHIP_COLS = `id, order_id, shipment_no, carrier, ship_dt::text AS ship_dt, eta::text AS eta,
  arrived_dt::text AS arrived_dt, status, cargo_rub::float8 AS cargo_rub, ff_rub::float8 AS ff_rub,
  accepted_at::text AS accepted_at, note`;
const SL_COLS = `sl.id, sl.shipment_id, sl.line_id, sl.qty_shipped, sl.qty_accepted`;

export async function loadOrder(id, { lock = false } = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const order = (await tenantQuery(
    `SELECT ${ORDER_COLS} FROM tenant.purchase_orders WHERE id = $1 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`, [n]))[0];
  if (!order) return null;
  const payments = await tenantQuery(
    `SELECT ${PAY_COLS} FROM tenant.purchase_order_payments WHERE order_id = $1 AND deleted_at IS NULL ORDER BY id`, [n]);
  const lines = await tenantQuery(
    `SELECT ${LINE_COLS} FROM tenant.purchase_order_lines l ${LINE_JOIN}
      WHERE l.order_id = $1 AND l.deleted_at IS NULL ORDER BY l.id`, [n]);
  const shipments = await tenantQuery(
    `SELECT ${SHIP_COLS} FROM tenant.purchase_shipments WHERE order_id = $1 AND deleted_at IS NULL ORDER BY id`, [n]);
  const shipmentLines = await tenantQuery(
    `SELECT ${SL_COLS} FROM tenant.purchase_shipment_lines sl
       JOIN tenant.purchase_shipments s ON s.cabinet_id = sl.cabinet_id AND s.id = sl.shipment_id
      WHERE s.order_id = $1 AND s.deleted_at IS NULL ORDER BY sl.id`, [n]);
  return { order, payments, lines, shipments, shipmentLines };
}

export async function loadOrderView(id) {
  const b = await loadOrder(id);
  if (!b) return null;
  const dds = await tenantQuery(
    `SELECT source_ref, status, paid_at::text AS paid_at FROM tenant.dds_movements
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status <> 'archived'`, [`order:${b.order.id}:%`]);
  return { ...b, calc: calcOrder(b), dds };
}

// Список: грузим всё живое разом (масштаб — десятки заказов) и считаем тем же calcOrder.
async function loadAllBundles() {
  const orders = await tenantQuery(`SELECT ${ORDER_COLS} FROM tenant.purchase_orders WHERE deleted_at IS NULL ORDER BY COALESCE(order_dt, created_at::date) DESC, id DESC`);
  const payments = await tenantQuery(`SELECT ${PAY_COLS} FROM tenant.purchase_order_payments WHERE deleted_at IS NULL`);
  const lines = await tenantQuery(`SELECT ${LINE_COLS} FROM tenant.purchase_order_lines l ${LINE_JOIN} WHERE l.deleted_at IS NULL`);
  const shipments = await tenantQuery(`SELECT ${SHIP_COLS} FROM tenant.purchase_shipments WHERE deleted_at IS NULL`);
  const shipmentLines = await tenantQuery(
    `SELECT ${SL_COLS} FROM tenant.purchase_shipment_lines sl
       JOIN tenant.purchase_shipments s ON s.cabinet_id = sl.cabinet_id AND s.id = sl.shipment_id
      WHERE s.deleted_at IS NULL`);
  const by = (rows, key) => {
    const m = new Map();
    for (const r of rows) { const k = Number(r[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  const P = by(payments, "order_id"), L = by(lines, "order_id"), S = by(shipments, "order_id"), SL = by(shipmentLines, "shipment_id");
  return orders.map((order) => {
    const ships = S.get(Number(order.id)) || [];
    const b = { order, payments: P.get(Number(order.id)) || [], lines: L.get(Number(order.id)) || [], shipments: ships,
      shipmentLines: ships.flatMap((s) => SL.get(Number(s.id)) || []) };
    return { ...b, calc: calcOrder(b) };
  });
}

export async function listOrders({ status = "", supplier = "", category = "", closed = false } = {}) {
  const needle = String(supplier || "").trim().toLowerCase();
  return (await loadAllBundles())
    .filter(({ order }) => (closed ? true : order.status !== "closed")
      && (!status || order.status === status)
      && (!category || order.category === category)
      && (!needle || String(order.supplier || "").toLowerCase().includes(needle) || String(order.order_no || "").toLowerCase().includes(needle)))
    .map(({ order, lines, calc }) => ({
      id: Number(order.id), order_no: order.order_no, supplier: order.supplier, category: order.category,
      order_dt: order.order_dt, status: order.status, lines: lines.length, qty: calc.qty,
      totalCny: calc.totalCny, totalRub: calc.totalRub, paidCny: calc.paidCny,
      shippedQty: calc.shippedQty, acceptedQty: calc.acceptedQty, shortageQty: calc.shortageQty,
      avgUnitCost: calc.qty > 0 ? calc.totalRub / calc.qty : null, photo: lines.find((l) => l.photo)?.photo || null,
    }));
}

export async function refreshOrderStatus(id) {
  const b = await loadOrder(id);
  if (!b) return null;
  const next = autoOrderStatus(b.order.status, b.lines, b.shipments, b.shipmentLines);
  if (next !== b.order.status) {
    await tenantQuery(
      `UPDATE tenant.purchase_orders SET status = $2,
         archived_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`,
      [b.order.id, next]);
  }
  return next;
}

export async function lockShipment(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return (await tenantQuery(
    `SELECT ${SHIP_COLS} FROM tenant.purchase_shipments WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [n]))[0] || null;
}

// «Товар в пути» для «Баланса»: отправки status='transit', стоимость = Σ шт × себестоимость/шт.
export async function ordersInTransit() {
  const items = [];
  let total = 0;
  for (const { order, calc, shipments } of await loadAllBundles()) {
    for (const s of calc.shipments) {
      if (s.status !== "transit") continue;
      const raw = shipments.find((x) => Number(x.id) === s.id);
      const value = Math.round(s.value * 100) / 100;
      total += value;
      items.push({ id: `s${s.id}`, name: `${order.supplier} · ${order.order_no || `заказ #${order.id}`} · ${raw?.shipment_no || `отправка #${s.id}`}`,
        qty: s.qty, unit_cost: s.qty > 0 ? Math.round((s.value / s.qty) * 100) / 100 : 0, value, lifecycle: "in_transit" });
    }
  }
  return { total: Math.round(total * 100) / 100, items };
}
```

- [ ] **Step 3: Тесты — deliveries после выноса каталога не сломаны**

Run: `node --test lib/__tests__/ && node -e "import('/opt/agents/saas/lib/purchaseOrdersData.js').then(()=>console.log('import ok'))"`
Expected: все PASS, кроме нового гарда из Task 4 Step 7 (нет файла роута — FAIL ожидаем до Task 6); `import ok` (если импорт `lib/db.js` требует env — допустимо падение с ошибкой про env/подключение, но НЕ SyntaxError).

- [ ] **Step 4: Commit**

```bash
git add lib/purchaseOrdersData.js lib/catalogSearch.js app/api/cabinets/[id]/deliveries/route.js
git commit -m "feat(purchase-orders): слой данных заказов, общий поиск каталога"
```

---

### Task 6: API `purchase-orders`

**Files:**
- Create: `app/api/cabinets/[id]/purchase-orders/route.js`
- Modify: `lib/__tests__/roleGuards.test.mjs:9` (добавить `"purchase-orders"` в `MANAGER_FIN`)

**Interfaces:**
- Consumes: Task 3 валидаторы, Task 4 `syncOrderPayments`/`archiveOrderPayments`, Task 5 `loadOrder`/`loadOrderView`/`listOrders`/`refreshOrderStatus`/`lockShipment`/`searchCatalog`/`catalogLabel`/`catalogPhoto`.
- Produces (HTTP):
  - `GET ?catalog=1&q=` → `{ catalog }`; `GET ?id=N` → `{ order, payments, lines, shipments, shipmentLines, calc, dds, role }`; `GET` → `{ items: OrderRow[], suppliers: string[], categories: string[], role }`
  - `POST {action, ...}` → `{ ok: true, id? }` или `{ error }` 4xx. Действия: `create`, `update`, `delete`, `line_add`, `line_update`, `line_copy`, `line_delete`, `pay_add`, `pay_update`, `pay_delete`, `ship_add`, `ship_update`, `ship_delete`, `ship_arrived`, `ship_unarrived`. Все, кроме `create`, принимают `order_id`; `line_*`/`pay_*`/`ship_*` (кроме `_add`) — `id` своей строки.

- [ ] **Step 1: Роут**

```js
// /api/cabinets/[id]/purchase-orders — закупки «заказ → позиции → отправки» (27.10.2026, спека
// docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Расчёт — lib/purchaseOrders.js,
// БД — lib/purchaseOrdersData.js, ДДС — только syncOrderPayments (lib/paymentCalendarData.js).
// Любая запись: заказ берётся FOR UPDATE первым, затем правка, затем syncOrderPayments + refreshOrderStatus.
// В ff_inventory / stock_moves / cost_overrides НЕ пишем.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { validateOrderInput, validateLineInput, validatePaymentInput, validateShipmentInput,
  checkShipQty, defaultShipmentLines } from "@/lib/purchaseOrders.js";
import { loadOrder, loadOrderView, listOrders, refreshOrderStatus } from "@/lib/purchaseOrdersData.js";
import { syncOrderPayments, archiveOrderPayments } from "@/lib/paymentCalendarData.js";
import { searchCatalog, catalogLabel, catalogPhoto } from "@/lib/catalogSearch.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const ok = (extra = {}) => NextResponse.json({ ok: true, ...extra });
const posId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  if (url.searchParams.get("catalog") === "1") {
    return NextResponse.json({ catalog: await searchCatalog(url.searchParams.get("q")) });
  }
  const id = url.searchParams.get("id");
  if (id) {
    const v = await loadOrderView(id);
    if (!v) return bad("заказ не найден", 404);
    return NextResponse.json({ ...v, role: cabinet.role });
  }
  const items = await listOrders({
    status: url.searchParams.get("status") || "",
    supplier: url.searchParams.get("supplier") || "",
    category: url.searchParams.get("category") || "",
    closed: url.searchParams.get("closed") === "1",
  });
  const all = await listOrders({ closed: true });
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  return NextResponse.json({ items, suppliers: uniq(all.map((x) => x.supplier)), categories: uniq(all.map((x) => x.category)), role: cabinet.role });
});

// Позиция: подставить имя/фото карточки, если выбран артикул и текст пуст.
async function fillFromCatalog(raw) {
  const r = { ...raw };
  if (r.platform && !String(r.label || "").trim()) r.label = (await catalogLabel(r)) || "";
  if (r.platform && !r.photo_url) r.photo_url = await catalogPhoto(r);
  return r;
}

async function afterChange(orderId) {
  await syncOrderPayments(orderId);
  await refreshOrderStatus(orderId);
}

export const POST = withCabinet(async (req, { session }) => {
  const b = await req.json();
  const action = b?.action;

  // Действие без order_id — до проверки order_id (грабля D10).
  if (action === "create") {
    const v = validateOrderInput(b);
    if (!v.ok) return bad(v.error);
    const o = v.value;
    const r = await tenantQuery(
      `INSERT INTO tenant.purchase_orders (cabinet_id, order_no, supplier, supplier_contact, source_country, category,
         note, order_dt, rate_cny, status, created_by)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [o.order_no, o.supplier, o.supplier_contact, o.source_country, o.category, o.note, o.order_dt, o.rate_cny, o.status, session?.user_id ?? null]);
    return ok({ id: Number(r[0].id) });
  }

  const orderId = posId(b?.order_id);
  if (!orderId) return bad("order_id required");
  const bundle = await loadOrder(orderId, { lock: true });
  if (!bundle) return bad("заказ не найден", 404);
  const { order, lines, shipments, shipmentLines } = bundle;

  if (action === "update") {
    const v = validateOrderInput({ ...order, ...b });
    if (!v.ok) return bad(v.error);
    const o = v.value;
    await tenantQuery(
      `UPDATE tenant.purchase_orders SET order_no = $2, supplier = $3, supplier_contact = $4, source_country = $5,
         category = $6, note = $7, order_dt = $8, rate_cny = $9, status = $10, updated_at = now() WHERE id = $1`,
      [orderId, o.order_no, o.supplier, o.supplier_contact, o.source_country, o.category, o.note, o.order_dt, o.rate_cny, o.status]);
    await afterChange(orderId);
    return ok();
  }

  if (action === "delete") {
    if (shipments.some((s) => s.status === "accepted")) return bad("у заказа есть принятые отправки — удалить нельзя");
    await tenantQuery(`UPDATE tenant.purchase_orders SET deleted_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
    await tenantQuery(`UPDATE tenant.purchase_order_payments SET deleted_at = now() WHERE order_id = $1 AND deleted_at IS NULL`, [orderId]);
    await tenantQuery(`UPDATE tenant.purchase_shipments SET deleted_at = now() WHERE order_id = $1 AND deleted_at IS NULL`, [orderId]);
    await tenantQuery(`UPDATE tenant.purchase_order_lines SET deleted_at = now() WHERE order_id = $1 AND deleted_at IS NULL`, [orderId]);
    await archiveOrderPayments(orderId);
    return ok();
  }

  // ---- позиции ----
  const findLine = (id) => lines.find((l) => Number(l.id) === Number(id));
  const shippedOf = (lineId) => shipmentLines.filter((x) => Number(x.line_id) === Number(lineId))
    .reduce((s, x) => s + Number(x.qty_shipped), 0);

  if (action === "line_add" || action === "line_copy") {
    let raw = b;
    if (action === "line_copy") {
      const src = findLine(b.id);
      if (!src) return bad("позиция не найдена", 404);
      raw = { ...src, variant: b.variant ?? null, qty: b.qty ?? src.qty, photo_url: null };
    }
    const v = validateLineInput(await fillFromCatalog(raw));
    if (!v.ok) return bad(v.error);
    const l = v.value;
    const r = await tenantQuery(
      `INSERT INTO tenant.purchase_order_lines (cabinet_id, order_id, platform, nm_id, product_id, label, variant, qty,
         price_cny, weight_kg, photo_url, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [orderId, l.platform, l.nm_id, l.product_id, l.label, l.variant, l.qty, l.price_cny, l.weight_kg, l.photo_url, l.note]);
    await afterChange(orderId);
    return ok({ id: Number(r[0].id) });
  }

  if (action === "line_update") {
    const cur = findLine(b.id);
    if (!cur) return bad("позиция не найдена", 404);
    const merged = { ...cur, photo_url: null, ...b };
    if (b.platform !== undefined && b.label === undefined) merged.label = ""; // сменили артикул — имя из каталога
    const v = validateLineInput(await fillFromCatalog(merged));
    if (!v.ok) return bad(v.error);
    const l = v.value;
    if (l.qty < shippedOf(cur.id)) return bad(`уже отправлено ${shippedOf(cur.id)} шт — меньше нельзя`);
    await tenantQuery(
      `UPDATE tenant.purchase_order_lines SET platform = $2, nm_id = $3, product_id = $4, label = $5, variant = $6,
         qty = $7, price_cny = $8, weight_kg = $9, photo_url = $10, note = $11, updated_at = now() WHERE id = $1`,
      [cur.id, l.platform, l.nm_id, l.product_id, l.label, l.variant, l.qty, l.price_cny, l.weight_kg, l.photo_url, l.note]);
    await afterChange(orderId);
    return ok();
  }

  if (action === "line_delete") {
    const cur = findLine(b.id);
    if (!cur) return bad("позиция не найдена", 404);
    if (shippedOf(cur.id) > 0) return bad("позиция уже в отправке — сначала уберите её из отправок");
    await tenantQuery(`UPDATE tenant.purchase_order_lines SET deleted_at = now(), updated_at = now() WHERE id = $1`, [cur.id]);
    await afterChange(orderId);
    return ok();
  }

  // ---- оплаты ----
  if (action === "pay_add" || action === "pay_update") {
    const cur = action === "pay_update" ? bundle.payments.find((p) => Number(p.id) === Number(b.id)) : null;
    if (action === "pay_update" && !cur) return bad("оплата не найдена", 404);
    const v = validatePaymentInput({ ...(cur || {}), ...b });
    if (!v.ok) return bad(v.error);
    const p = v.value;
    let id = cur?.id;
    if (cur) {
      await tenantQuery(
        `UPDATE tenant.purchase_order_payments SET kind = $2, currency = $3, amount = $4, rate = $5, plan_date = $6,
           note = $7, updated_at = now() WHERE id = $1`, [cur.id, p.kind, p.currency, p.amount, p.rate, p.plan_date, p.note]);
    } else {
      const r = await tenantQuery(
        `INSERT INTO tenant.purchase_order_payments (cabinet_id, order_id, kind, currency, amount, rate, plan_date, note)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [orderId, p.kind, p.currency, p.amount, p.rate, p.plan_date, p.note]);
      id = r[0].id;
    }
    await afterChange(orderId);
    return ok({ id: Number(id) });
  }

  if (action === "pay_delete") {
    const cur = bundle.payments.find((p) => Number(p.id) === Number(b.id));
    if (!cur) return bad("оплата не найдена", 404);
    await tenantQuery(`UPDATE tenant.purchase_order_payments SET deleted_at = now(), updated_at = now() WHERE id = $1`, [cur.id]);
    await afterChange(orderId); // плановая строка ДДС → архив, оплаченная — остаётся (правило syncRefs)
    return ok();
  }

  // ---- отправки ----
  const findShip = (id) => shipments.find((s) => Number(s.id) === Number(id));

  if (action === "ship_add") {
    const v = validateShipmentInput(b);
    if (!v.ok) return bad(v.error);
    const s = v.value;
    const newLines = s.lines ?? defaultShipmentLines(lines, shipmentLines);
    if (!newLines.length) return bad("всё уже отправлено — нечего добавить в отправку");
    const err = checkShipQty(lines, shipmentLines, newLines, null);
    if (err) return bad(err);
    const r = await tenantQuery(
      `INSERT INTO tenant.purchase_shipments (cabinet_id, order_id, shipment_no, carrier, ship_dt, eta, arrived_dt,
         cargo_rub, ff_rub, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [orderId, s.shipment_no, s.carrier, s.ship_dt, s.eta, s.arrived_dt, s.cargo_rub, s.ff_rub, s.note]);
    const sid = Number(r[0].id);
    for (const x of newLines) {
      await tenantQuery(
        `INSERT INTO tenant.purchase_shipment_lines (cabinet_id, shipment_id, line_id, qty_shipped)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3)`, [sid, x.line_id, x.qty_shipped]);
    }
    await afterChange(orderId);
    return ok({ id: sid });
  }

  if (action === "ship_update") {
    const cur = findShip(b.id);
    if (!cur) return bad("отправка не найдена", 404);
    const v = validateShipmentInput({ ...cur, ...b });
    if (!v.ok) return bad(v.error);
    const s = v.value;
    if (s.lines !== undefined) {
      if (cur.status === "accepted") return bad("отправка принята — состав менять нельзя (деньги — можно)");
      if (!s.lines.length) return bad("в отправке должна быть хотя бы одна позиция");
      const err = checkShipQty(lines, shipmentLines, s.lines, cur.id);
      if (err) return bad(err);
      await tenantQuery(`DELETE FROM tenant.purchase_shipment_lines WHERE shipment_id = $1`, [cur.id]);
      for (const x of s.lines) {
        await tenantQuery(
          `INSERT INTO tenant.purchase_shipment_lines (cabinet_id, shipment_id, line_id, qty_shipped)
           VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3)`, [cur.id, x.line_id, x.qty_shipped]);
      }
    }
    await tenantQuery(
      `UPDATE tenant.purchase_shipments SET shipment_no = $2, carrier = $3, ship_dt = $4, eta = $5, arrived_dt = $6,
         cargo_rub = $7, ff_rub = $8, note = $9, updated_at = now() WHERE id = $1`,
      [cur.id, s.shipment_no, s.carrier, s.ship_dt, s.eta, s.arrived_dt, s.cargo_rub, s.ff_rub, s.note]);
    await afterChange(orderId);
    return ok();
  }

  if (action === "ship_delete") {
    const cur = findShip(b.id);
    if (!cur) return bad("отправка не найдена", 404);
    if (cur.status === "accepted") return bad("отправка уже принята — удалить нельзя");
    await tenantQuery(`DELETE FROM tenant.purchase_shipment_lines WHERE shipment_id = $1`, [cur.id]);
    await tenantQuery(`UPDATE tenant.purchase_shipments SET deleted_at = now(), updated_at = now() WHERE id = $1`, [cur.id]);
    await afterChange(orderId);
    return ok();
  }

  if (action === "ship_arrived" || action === "ship_unarrived") {
    const cur = findShip(b.id);
    if (!cur) return bad("отправка не найдена", 404);
    if (action === "ship_arrived") {
      if (cur.status !== "transit") return bad("отправка уже прибыла");
      const d = String(b.arrived_dt || cur.arrived_dt || new Date().toISOString().slice(0, 10)).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return bad("дата прибытия — ГГГГ-ММ-ДД");
      await tenantQuery(`UPDATE tenant.purchase_shipments SET status = 'arrived', arrived_dt = $2, updated_at = now() WHERE id = $1`, [cur.id, d]);
    } else {
      if (cur.status !== "arrived") return bad("вернуть «в пути» можно только прибывшую, ещё не принятую отправку");
      await tenantQuery(`UPDATE tenant.purchase_shipments SET status = 'transit', updated_at = now() WHERE id = $1`, [cur.id]);
    }
    await afterChange(orderId);
    return ok();
  }

  return bad("неизвестное действие");
}, { requireRole: "manager" });
```

- [ ] **Step 2: Гард ролей** — в `lib/__tests__/roleGuards.test.mjs` дописать `"purchase-orders"` в массив `MANAGER_FIN`.

- [ ] **Step 3: Все тесты**

Run: `node --test lib/__tests__/`
Expected: все PASS (включая гард из Task 4 Step 7).

- [ ] **Step 4: Commit**

```bash
git add "app/api/cabinets/[id]/purchase-orders/route.js" lib/__tests__/roleGuards.test.mjs
git commit -m "feat(purchase-orders): API заказов (позиции, оплаты, отправки)"
```

---

### Task 7: Старые закупки — только чтение

**Files:**
- Modify: `app/api/cabinets/[id]/purchases/route.js:165-268` (POST и DELETE → 410)
- Modify: `app/cabinets/[id]/fin-purchases/PurchasesPage.jsx` (проп `readOnly`)
- Modify: `lib/__tests__/deliveriesGuard.test.mjs`, `lib/__tests__/paymentCalendarGuard.test.mjs` (старые гарды про `complete_to_stock`/`syncPurchasePayments` в роуте партий → гард «архив»)

**Interfaces:**
- Produces: `PurchasesPage({ cabinetId, readOnly })`; `POST/DELETE /purchases` → 410 `{ error: ARCHIVE_ERROR }`.

- [ ] **Step 1: Бэкап боевых файлов**

Run: `ts=$(date +%Y%m%d_%H%M%S); cp "app/api/cabinets/[id]/purchases/route.js" /opt/agentsDB/backups/purchases.route.js.$ts.bak; cp "app/cabinets/[id]/fin-purchases/PurchasesPage.jsx" /opt/agentsDB/backups/PurchasesPage.jsx.$ts.bak`

- [ ] **Step 2: Переписать гарды под новое правило**

В `lib/__tests__/deliveriesGuard.test.mjs` удалить функцию `block` и тест `complete_to_stock …`, добавить:

```js
test("старые партии — архив: POST и DELETE роута purchases отвечают 410 и ничего не пишут", () => {
  assert.match(src, /status:\s*410/);
  assert.doesNotMatch(src, /INSERT INTO tenant\.purchases|UPDATE tenant\.purchases|ff_inventory|applyMove/);
});
```

В `lib/__tests__/paymentCalendarGuard.test.mjs` заменить тест `purchases/route.js: синхронизация платежей без глушения ошибок` на:

```js
test("purchases/route.js: архив — платежи партий больше не синкаются из роута", () => {
  const src = read("app/api/cabinets/[id]/purchases/route.js");
  assert.doesNotMatch(src, /syncPurchasePayments\(|dds_movements/);
  assert.doesNotMatch(src, /catch\s*(\(\w*\))?\s*\{\s*\}/);
});
```

Run: `node --test lib/__tests__/deliveriesGuard.test.mjs lib/__tests__/paymentCalendarGuard.test.mjs`
Expected: FAIL (роут ещё пишет).

- [ ] **Step 3: Роут** — в `purchases/route.js` заменить весь `export const POST = …` (стр. 165–259) и `export const DELETE = …` (стр. 261–268) на:

```js
// С 27.10.2026 закупки ведутся заказами (/api/cabinets/[id]/purchase-orders, спека
// docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Старые партии — архив, только чтение.
const ARCHIVE_ERROR = "Старые партии — архив, только чтение. Закупки ведутся заказами на странице «Закупки».";
export const POST = withCabinet(async () => NextResponse.json({ error: ARCHIVE_ERROR }, { status: 410 }), { requireRole: "manager" });
export const DELETE = withCabinet(async () => NextResponse.json({ error: ARCHIVE_ERROR }, { status: 410 }), { requireRole: "manager" });
```

Удалить ставшие неиспользуемыми импорты (`syncPurchasePayments`, `archivePurchasePayments`, `computeExcel`, если их нет в GET — проверить `grep -n` по файлу; `computeExcel` GET использует — оставить).

- [ ] **Step 4: UI `readOnly`** — в `PurchasesPage.jsx`:
  1. Сигнатура: `export default function PurchasesPage({ cabinetId, readOnly = false })`.
  2. Строка 230: `{!readOnly && <AddForm form={addForm} setForm={setAddForm} onAdd={addRecord} busy={adding} />}`.
  3. В начале `saveField`, `delRow` и обработчика «✓ Доставлено» (`grep -n "complete_to_stock" PurchasesPage.jsx`) добавить `if (readOnly) return;`.
  4. В `Row` передать `readOnly` и скрыть кнопки удаления и «✓ Доставлено»: `{!readOnly && (<button …>)}` вокруг каждой.
  5. Над таблицей: `{readOnly && <div style={{ color: C.muted, fontSize: 13, margin: "4px 0 12px" }}>Архив партий до 16.10 — только чтение. Новые закупки заводятся заказами.</div>}`.

- [ ] **Step 5: Тесты**

Run: `node --test lib/__tests__/`
Expected: все PASS.

- [ ] **Step 6: Commit**

```bash
git add "app/api/cabinets/[id]/purchases/route.js" "app/cabinets/[id]/fin-purchases/PurchasesPage.jsx" lib/__tests__/deliveriesGuard.test.mjs lib/__tests__/paymentCalendarGuard.test.mjs
git commit -m "feat(purchases): старые партии — архив только для чтения"
```

---

### Task 8: Приёмка отправок на «Доставлено на склад»

**Files:**
- Modify: `lib/deliveries.js` (добавить `buildShipmentDeliveries`)
- Modify: `app/api/cabinets/[id]/deliveries/route.js` (GET + действия `ship_accept_line`, `ship_link_line`, `ship_done`, `ship_undone`)
- Create: `app/cabinets/[id]/deliveries/ShipmentReceiptPanel.jsx`
- Modify: `app/cabinets/[id]/deliveries/DeliveriesPage.jsx`
- Test: `lib/__tests__/deliveries.test.mjs` (дописать)

**Interfaces:**
- Consumes: `lockShipment`, `refreshOrderStatus`, `loadOrder` (Task 5); `syncOrderPayments` (Task 4); `validateLineInput` (Task 3); `catalogLabel`, `catalogPhoto` (Task 5).
- Produces: `buildShipmentDeliveries(shipments, lines) → item[]`, `item = { kind: 'shipment', key: 's<id>', id, order_id, name, shipment_no, category, photo, delivered_at, receipt_done_at, status: 'waiting'|'done', ordered, accepted, diff, lines: [{ id (shipment_line id), line_id, label, variant, platform, nm_id, product_id, photo, article, qty_shipped, qty_accepted }] }`. У старых партий в `buildDeliveries` — добавить `kind: 'purchase', key: 'p<id>'`.

- [ ] **Step 1: Падающий тест (в конец `lib/__tests__/deliveries.test.mjs`)**

```js
import { buildShipmentDeliveries } from "../deliveries.js";

test("buildShipmentDeliveries: прибывшая — ждёт, принятая — учтено; принято по умолчанию = отправлено", () => {
  const ships = [
    { id: 5, order_id: 7, order_no: "A-1", supplier: "hanyou", category: "Камеры", shipment_no: "TRK", status: "arrived", arrived_dt: "2026-10-25", accepted_at: null },
    { id: 6, order_id: 7, order_no: "A-1", supplier: "hanyou", category: "Камеры", shipment_no: null, status: "accepted", arrived_dt: "2026-10-26", accepted_at: "2026-10-27" },
  ];
  const lines = [
    { id: 1, shipment_id: 5, line_id: 10, label: "камера", variant: null, qty_shipped: 40, qty_accepted: null, photo: "p.jpg" },
    { id: 2, shipment_id: 6, line_id: 10, label: "камера", variant: null, qty_shipped: 30, qty_accepted: 28, photo: null },
  ];
  const [a, b] = buildShipmentDeliveries(ships, lines);
  assert.equal(a.key, "s5");
  assert.equal(a.status, "waiting");
  assert.equal(a.ordered, 40);
  assert.equal(a.accepted, 40);
  assert.equal(a.photo, "p.jpg");
  assert.match(a.name, /hanyou · A-1 · TRK/);
  assert.equal(b.status, "done");
  assert.equal(b.diff, -2);
});
```

Run: `node --test lib/__tests__/deliveries.test.mjs` → FAIL (нет экспорта).

- [ ] **Step 2: `lib/deliveries.js`** — дописать, и в `buildDeliveries` в возвращаемый объект добавить `kind: "purchase", key: \`p${p.id}\``:

```js
// Отправки заказов закупки (спека 2026-10-27-purchase-orders-design.md §5): прибывшая → ждёт приёмки,
// принятая → учтено. Принято по строке до ввода = отправлено.
export function buildShipmentDeliveries(shipments, lines) {
  const byShip = new Map();
  for (const l of lines || []) {
    const k = Number(l.shipment_id);
    if (!byShip.has(k)) byShip.set(k, []);
    byShip.get(k).push(l);
  }
  return (shipments || []).map((s) => {
    const ls = byShip.get(Number(s.id)) || [];
    const ordered = ls.reduce((t, l) => t + int(l.qty_shipped), 0);
    const accepted = ls.reduce((t, l) => t + int(l.qty_accepted ?? l.qty_shipped), 0);
    return {
      kind: "shipment", key: `s${s.id}`, id: Number(s.id), order_id: Number(s.order_id),
      name: [s.supplier, s.order_no || `заказ #${s.order_id}`, s.shipment_no || `отправка #${s.id}`].join(" · "),
      shipment_no: s.shipment_no || null, category: s.category || null,
      photo: ls.find((l) => l.photo)?.photo || null,
      delivered_at: s.arrived_dt || null, receipt_done_at: s.accepted_at || null,
      status: s.status === "accepted" ? "done" : "waiting",
      ordered, accepted, diff: accepted - ordered, lines: ls,
    };
  });
}
```

Run: `node --test lib/__tests__/deliveries.test.mjs` → PASS.

- [ ] **Step 3: Роут deliveries — GET.** После получения `{ items, totals }` старых партий:

```js
  const ships = await tenantQuery(
    `SELECT s.id, s.order_id, o.order_no, o.supplier, o.category, s.shipment_no, s.status,
            s.arrived_dt::text AS arrived_dt, s.accepted_at::text AS accepted_at
       FROM tenant.purchase_shipments s
       JOIN tenant.purchase_orders o ON o.cabinet_id = s.cabinet_id AND o.id = s.order_id AND o.deleted_at IS NULL
      WHERE s.deleted_at IS NULL AND s.status IN ('arrived','accepted')
      ORDER BY (s.status = 'accepted'), s.arrived_dt DESC NULLS LAST, s.id DESC`, []);
  const shipLines = await tenantQuery(
    `SELECT sl.id, sl.shipment_id, sl.line_id, sl.qty_shipped, sl.qty_accepted,
            l.label, l.variant, l.platform, l.nm_id, l.product_id,
            COALESCE(l.photo_url, a.im_url, o.im_url) AS photo, o.offer_id AS article
       FROM tenant.purchase_shipment_lines sl
       JOIN tenant.purchase_order_lines l ON l.cabinet_id = sl.cabinet_id AND l.id = sl.line_id
       LEFT JOIN tenant.wb_articles a ON l.platform = 'wb' AND a.cabinet_id = l.cabinet_id AND a.nm_id = l.nm_id
       LEFT JOIN tenant.ozon_products o ON l.platform = 'ozon' AND o.cabinet_id = l.cabinet_id AND o.product_id = l.product_id
      ORDER BY sl.shipment_id, sl.id`, []);
  const shipItems = buildShipmentDeliveries(ships, shipLines);
  for (const it of shipItems) totals[it.status]++;
  const filtered = filterDeliveries([...shipItems, ...items], { status: url.searchParams.get("status") || "all", q: url.searchParams.get("q") || "" });
```

(Заменить прежнюю строку `const filtered = …`; импорт `buildShipmentDeliveries` добавить к импорту из `@/lib/deliveries.js`.)

- [ ] **Step 4: Роут deliveries — POST, новые действия.** Добавить в начало `POST` (до `line_add`):

```js
  if (action === "ship_accept_line" || action === "ship_link_line" || action === "ship_done" || action === "ship_undone") {
    const ship = await lockShipment(b.shipment_id);
    if (!ship) return bad("отправка не найдена", 404);
    await loadOrder(ship.order_id, { lock: true }); // порядок блокировок как в purchase-orders: заказ → строки
    if (action === "ship_undone") {
      if (cabinet.role !== "owner") return bad("снять отметку может только владелец", 403);
      if (ship.status !== "accepted") return bad("отправка ещё не принята");
      await tenantQuery(`UPDATE tenant.purchase_shipments SET status = 'arrived', accepted_at = NULL, accepted_by = NULL, updated_at = now() WHERE id = $1`, [ship.id]);
      await refreshOrderStatus(ship.order_id);
      return NextResponse.json({ ok: true });
    }
    if (ship.status !== "arrived") return bad(ship.status === "accepted" ? "отправка принята, снимите отметку" : "отправка ещё в пути");
    if (action === "ship_done") {
      await tenantQuery(`UPDATE tenant.purchase_shipment_lines SET qty_accepted = qty_shipped WHERE shipment_id = $1 AND qty_accepted IS NULL`, [ship.id]);
      await tenantQuery(`UPDATE tenant.purchase_shipments SET status = 'accepted', accepted_at = now(), accepted_by = $2, updated_at = now() WHERE id = $1`,
        [ship.id, session?.user_id ?? null]);
      await refreshOrderStatus(ship.order_id);
      return NextResponse.json({ ok: true });
    }
    const sl = (await tenantQuery(
      `SELECT id, line_id FROM tenant.purchase_shipment_lines WHERE id = $1 AND shipment_id = $2 FOR UPDATE`, [Number(b.id), ship.id]))[0];
    if (!sl) return bad("строка отправки не найдена", 404);
    if (action === "ship_accept_line") {
      const q = Number(b.qty_accepted);
      if (!Number.isInteger(q) || q < 0) return bad("принято — целое число ≥ 0");
      await tenantQuery(`UPDATE tenant.purchase_shipment_lines SET qty_accepted = $2 WHERE id = $1`, [sl.id, q]);
      return NextResponse.json({ ok: true });
    }
    // ship_link_line — привязать артикул к позиции заказа (пишется в позицию, видно и в «Закупках»)
    const cur = (await tenantQuery(`SELECT * FROM tenant.purchase_order_lines WHERE id = $1 FOR UPDATE`, [sl.line_id]))[0];
    const raw = { ...cur, platform: b.platform || null, nm_id: b.nm_id, product_id: b.product_id };
    if (raw.platform) { raw.photo_url = cur.photo_url || await catalogPhoto(raw); }
    const v = validateLineInput(raw);
    if (!v.ok) return bad(v.error);
    await tenantQuery(
      `UPDATE tenant.purchase_order_lines SET platform = $2, nm_id = $3, product_id = $4, photo_url = $5, updated_at = now() WHERE id = $1`,
      [cur.id, v.value.platform, v.value.nm_id, v.value.product_id, v.value.photo_url]);
    return NextResponse.json({ ok: true });
  }
```

Импорты в шапку: `import { lockShipment, loadOrder, refreshOrderStatus } from "@/lib/purchaseOrdersData.js";`, `import { validateLineInput } from "@/lib/purchaseOrders.js";`, `catalogPhoto` — к импорту из `@/lib/catalogSearch.js`. Обновить шапку-комментарий роута: перечислить новые действия. Привязка артикула меняет только идентификатор товара: имя позиции (`label`) остаётся введённым при заказе.

- [ ] **Step 5: UI.** `ShipmentReceiptPanel.jsx`:

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState } from "react";

// Приёмка отправки заказа (спека 2026-10-27-purchase-orders-design.md §5): по каждой позиции
// «отправлено → принято» (по умолчанию = отправлено), привязка артикула позиции без артикула,
// «✓ Учтено». Конечная точка: в остатки/себестоимость не пишет.

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const inp = { padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
const btn = { padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.ink, cursor: "pointer", fontSize: 13 };

export default function ShipmentReceiptPanel({ cabinetId, item, role, onChanged }) {
  const done = item.status === "done";
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(null); // shipment_line id
  const [search, setSearch] = useState("");
  const [found, setFound] = useState([]);

  useEffect(() => {
    if (!linking || search.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/deliveries?catalog=1&q=${encodeURIComponent(search.trim())}`);
        setFound((await r.json()).catalog || []);
      } catch (e) { console.error("shipment receipt catalog", e); setFound([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [cabinetId, search, linking]);

  async function post(body) {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/deliveries`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipment_id: item.id, ...body }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert(d.error || `Ошибка ${r.status}`); return false; }
      await onChanged();
      return true;
    } catch (e) { console.error("shipment receipt post", e); alert(String(e.message || e)); return false; }
    finally { setBusy(false); }
  }

  async function markDone() {
    const msg = item.diff !== 0
      ? `Принято ${nf0.format(item.accepted)} из ${nf0.format(item.ordered)} (${item.diff > 0 ? "+" : ""}${nf0.format(item.diff)}). Отметить «Учтено»?`
      : "Отметить отправку «Учтено»? Строки станут только для чтения.";
    if (confirm(msg)) await post({ action: "ship_done" });
  }

  return (
    <div style={{ fontSize: 13 }}>
      <table style={{ borderCollapse: "collapse", marginBottom: 10, minWidth: 620 }}>
        <thead><tr style={{ color: C.muted, textAlign: "left" }}>
          <th style={{ padding: "4px 8px" }}>Позиция</th>
          <th style={{ padding: "4px 8px", textAlign: "right" }}>Отправлено</th>
          <th style={{ padding: "4px 8px", textAlign: "right" }}>Принято</th>
          <th />
        </tr></thead>
        <tbody>
          {item.lines.map((l) => {
            const acc = l.qty_accepted ?? l.qty_shipped;
            return (
              <tr key={l.id} style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: "4px 8px" }}>
                  {l.photo && <img src={l.photo} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} />}
                  {l.label}{l.variant ? ` · ${l.variant}` : ""}
                  <span style={{ color: C.muted, marginLeft: 6 }}>
                    {l.platform === "wb" ? `WB ${l.nm_id}` : l.platform === "ozon" ? `Ozon ${l.article || l.product_id}` : "без артикула"}
                  </span>
                </td>
                <td style={{ padding: "4px 8px", textAlign: "right" }}>{nf0.format(l.qty_shipped)}</td>
                <td style={{ padding: "4px 8px", textAlign: "right" }}>
                  {done ? <span style={{ color: acc !== l.qty_shipped ? C.neg : C.ink }}>{nf0.format(acc)}</span> : (
                    <input type="number" min={0} defaultValue={acc} disabled={busy} style={{ ...inp, width: 80, textAlign: "right" }}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== String(acc)) post({ action: "ship_accept_line", id: l.id, qty_accepted: v }); }} />
                  )}
                </td>
                <td style={{ padding: "4px 8px" }}>
                  {!done && !l.platform && <button style={btn} onClick={() => { setLinking(l.id); setSearch(""); }}>Привязать артикул</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {linking && (
        <div style={{ marginBottom: 10, padding: 8, border: `1px solid ${C.line}`, borderRadius: 8 }}>
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск артикула WB/Ozon" style={{ ...inp, minWidth: 280 }} />
          <button style={{ ...btn, marginLeft: 6 }} onClick={() => setLinking(null)}>Отмена</button>
          {found.map((c) => (
            <div key={`${c.platform}${c.nm_id || c.product_id}`} style={{ padding: "4px 0", cursor: "pointer" }}
              onClick={async () => { if (await post({ action: "ship_link_line", id: linking, platform: c.platform, nm_id: c.nm_id, product_id: c.product_id })) setLinking(null); }}>
              {c.im_url && <img src={c.im_url} alt="" style={{ width: 24, height: 24, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} />}
              {c.platform === "wb" ? "WB" : "Ozon"} · {c.label} <span style={{ color: C.muted }}>{c.nm_id || c.article || c.product_id}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>Итого: принято {nf0.format(item.accepted)} из {nf0.format(item.ordered)}</span>
        {!done && <button style={{ ...btn, borderColor: C.pos, color: C.pos }} disabled={busy} onClick={markDone}>✓ Учтено</button>}
        {done && role === "owner" && <button style={btn} disabled={busy} onClick={() => confirm("Снять отметку «Учтено»?") && post({ action: "ship_undone" })}>Снять отметку</button>}
        <a href={`/cabinets/${cabinetId}/fin-purchases/${item.order_id}`} style={{ marginLeft: "auto", color: C.accent }}>Заказ →</a>
      </div>
    </div>
  );
}
```

`DeliveriesPage.jsx`: `import ShipmentReceiptPanel from "./ShipmentReceiptPanel";`; ключи строк и `open` — по `it.key` (`key={it.key}`, `open === it.key`, `setOpen(open === it.key ? null : it.key)`); в раскрытии: `{it.kind === "shipment" ? <ShipmentReceiptPanel … /> : <ReceiptPanel … />}`; заголовок колонки «Партия» → «Партия / отправка», «Заказано» → «Ожидали»; в подзаголовке страницы: «Отправки заказов из «Закупок» после «✓ Прибыла» и старые партии…».

- [ ] **Step 6: Тесты**

Run: `node --test lib/__tests__/`
Expected: все PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/deliveries.js lib/__tests__/deliveries.test.mjs "app/api/cabinets/[id]/deliveries/route.js" "app/cabinets/[id]/deliveries/ShipmentReceiptPanel.jsx" "app/cabinets/[id]/deliveries/DeliveriesPage.jsx"
git commit -m "feat(deliveries): приёмка отправок заказов закупки"
```

---

### Task 9: «Товар в пути» в «Балансе»

**Files:**
- Modify: `lib/purchasesInTransit.js`

**Interfaces:**
- Consumes: `ordersInTransit()` (Task 5).
- Produces: `purchasesInTransit()` — прежняя форма `{ total, count, items }`, items старых партий + отправок.

- [ ] **Step 1: Правка** — в конце `purchasesInTransit` перед `return`:

```js
import { ordersInTransit } from "./purchaseOrdersData.js"; // ← в шапку

  // Отправки заказов закупки в пути (спека 2026-10-27-purchase-orders-design.md §5).
  const ord = await ordersInTransit();
  for (const it of ord.items) items.push(it);
  total += ord.total;
```

Обновить шапку-комментарий файла одной строкой: «+ отправки заказов (`purchase_shipments.status='transit'`), стоимость = Σ шт × себестоимость/шт».

- [ ] **Step 2: Проверка** — `grep -n "purchasesInTransit" -r app lib` → только `balance/route.js`; форма ответа не изменилась.

- [ ] **Step 3: Commit**

```bash
git add lib/purchasesInTransit.js
git commit -m "feat(balance): отправки заказов закупки в «товаре в пути»"
```

---

### Task 10: Список заказов `/fin-purchases`

**Files:**
- Create: `app/cabinets/[id]/fin-purchases/OrdersPage.jsx`
- Modify: `app/cabinets/[id]/fin-purchases/page.js`

**Interfaces:**
- Consumes: `GET/POST /api/cabinets/{id}/purchase-orders` (Task 6), `PurchasesPage({cabinetId, readOnly})` (Task 7), `ORDER_STATUS_LABELS` (Task 3).
- Produces: `OrdersPage({ cabinetId })`.

- [ ] **Step 1: `page.js`**

```js
import OrdersPage from './OrdersPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <OrdersPage cabinetId={Number(params.id)} />;
}
```

- [ ] **Step 2: `OrdersPage.jsx`**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useState } from "react";
import PurchasesPage from "./PurchasesPage";
import { ORDER_STATUS_LABELS } from "@/lib/purchaseOrders.js";

// /cabinets/[id]/fin-purchases — закупки заказами (спека 2026-10-27-purchase-orders-design.md §4):
// список заказов + вкладка «Архив до 16.10» (старые партии, только чтение).

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const ddmm = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const inp = { padding: "6px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
const STATUS_TONE = { draft: "muted", ordered: "accent", production: "warn", shipping: "blue", closed: "pos" };

export default function OrdersPage({ cabinetId }) {
  const [tab, setTab] = useState("orders");
  const [f, setF] = useState({ status: "", supplier: "", category: "", closed: false });
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ status: f.status, supplier: f.supplier, category: f.category, closed: f.closed ? "1" : "" });
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders?${qs}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d); setErr(null);
    } catch (e) { console.error("purchase-orders load", e); setErr(String(e.message || e)); }
  }, [cabinetId, f]);
  useEffect(() => { if (tab === "orders") reload(); }, [reload, tab]);

  async function createOrder() {
    const supplier = prompt("Поставщик");
    if (!supplier || !supplier.trim()) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", supplier, order_dt: new Date().toISOString().slice(0, 10) }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert(d.error || `Ошибка ${r.status}`); return; }
      window.location.href = `/cabinets/${cabinetId}/fin-purchases/${d.id}`;
    } catch (e) { console.error("purchase-orders create", e); alert(String(e.message || e)); }
  }

  const items = data?.items || [];
  const canEdit = data && data.role !== "viewer";
  const tabBtn = (v, l) => (
    <button onClick={() => setTab(v)} style={{ padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13,
      border: `1px solid ${tab === v ? C.accent : C.line}`, background: tab === v ? soft("accent", 15) : "transparent", color: C.ink }}>{l}</button>
  );

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>Закупки</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>{tabBtn("orders", "Заказы")}{tabBtn("archive", "Архив до 16.10")}</div>
      {tab === "archive" ? <PurchasesPage cabinetId={cabinetId} readOnly /> : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
            <input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} placeholder="Поставщик или № заказа" style={{ ...inp, minWidth: 220 }} list="po-suppliers" />
            <datalist id="po-suppliers">{(data?.suppliers || []).map((s) => <option key={s} value={s} />)}</datalist>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={inp}>
              <option value="">Все статусы</option>
              {Object.entries(ORDER_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={inp}>
              <option value="">Все категории</option>
              {(data?.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label style={{ fontSize: 13 }}><input type="checkbox" checked={f.closed} onChange={(e) => setF({ ...f, closed: e.target.checked })} /> закрытые</label>
            {canEdit && <button onClick={createOrder} style={{ ...inp, marginLeft: "auto", cursor: "pointer", borderColor: C.accent }}>+ Заказ</button>}
          </div>
          {err && <div style={{ color: C.neg, marginBottom: 12 }}>Ошибка: {err}</div>}
          {!data && !err && <div style={{ color: C.muted }}>Загрузка…</div>}
          {data && !items.length && <div style={{ color: C.muted }}>Заказов нет. Нажмите «+ Заказ».</div>}
          {items.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ color: C.muted, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
                <th style={{ padding: 8, width: 44 }} />
                <th style={{ padding: 8 }}>Заказ</th>
                <th style={{ padding: 8 }}>Дата</th>
                <th style={{ padding: 8, textAlign: "right" }}>Позиций / шт</th>
                <th style={{ padding: 8, textAlign: "right" }}>Сумма</th>
                <th style={{ padding: 8 }}>Оплачено</th>
                <th style={{ padding: 8, textAlign: "right" }}>Отправлено / принято</th>
                <th style={{ padding: 8, textAlign: "right" }}>Себест./шт</th>
                <th style={{ padding: 8 }}>Статус</th>
              </tr></thead>
              <tbody>
                {items.map((o) => {
                  const pct = o.totalCny > 0 ? Math.min(100, (o.paidCny / o.totalCny) * 100) : 0;
                  return (
                    <tr key={o.id} onClick={() => { window.location.href = `/cabinets/${cabinetId}/fin-purchases/${o.id}`; }}
                      style={{ cursor: "pointer", borderBottom: `1px solid ${soft("line", 50)}` }}>
                      <td style={{ padding: 8 }}>{o.photo && <img src={o.photo} alt="" style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 6 }} />}</td>
                      <td style={{ padding: 8 }}><b>{o.supplier}</b>{o.order_no && <span style={{ color: C.muted }}> · {o.order_no}</span>}{o.category && <div style={{ color: C.muted, fontSize: 12 }}>{o.category}</div>}</td>
                      <td style={{ padding: 8 }}>{ddmm(o.order_dt)}</td>
                      <td style={{ padding: 8, textAlign: "right" }}>{o.lines} / {nf0.format(o.qty)}</td>
                      <td style={{ padding: 8, textAlign: "right" }}>{nf2.format(o.totalCny)} ¥<div style={{ color: C.muted, fontSize: 12 }}>{nf0.format(o.totalRub)} ₽</div></td>
                      <td style={{ padding: 8, minWidth: 140 }}>
                        <div style={{ fontSize: 12 }}>{nf0.format(o.paidCny)} из {nf0.format(o.totalCny)} ¥</div>
                        <div style={{ height: 4, background: soft("line", 60), borderRadius: 2 }}><div style={{ width: `${pct}%`, height: 4, background: C.pos, borderRadius: 2 }} /></div>
                      </td>
                      <td style={{ padding: 8, textAlign: "right" }}>{nf0.format(o.shippedQty)} / {nf0.format(o.acceptedQty)}{o.shortageQty > 0 && <div style={{ color: C.neg, fontSize: 12 }}>недостача {o.shortageQty}</div>}</td>
                      <td style={{ padding: 8, textAlign: "right" }}>{o.avgUnitCost == null ? "—" : `${nf0.format(o.avgUnitCost)} ₽`}</td>
                      <td style={{ padding: 8 }}><span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12, background: soft(STATUS_TONE[o.status] || "muted", 18) }}>{ORDER_STATUS_LABELS[o.status] || o.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
```

Проверить, что токен `blue` есть в `lib/palette.js`/`globals.css` (`grep -n "blue" lib/palette.js`); если нет — `STATUS_TONE.shipping = "accent"`.

`lib/purchaseOrders.js` импортируется на клиенте — в нём нет импортов Node/БД (проверено: файл чистый), это допустимо.

- [ ] **Step 3: Commit**

```bash
git add "app/cabinets/[id]/fin-purchases/page.js" "app/cabinets/[id]/fin-purchases/OrdersPage.jsx"
git commit -m "feat(purchase-orders): список заказов и вкладка архива на /fin-purchases"
```

---

### Task 11: Карточка заказа `/fin-purchases/[orderId]`

**Files:**
- Create: `app/cabinets/[id]/fin-purchases/[orderId]/page.js`, `OrderPage.jsx`, `OrderLines.jsx`, `OrderPayments.jsx`, `OrderShipments.jsx`, `CatalogPicker.jsx`
- Modify: `lib/cabinetNav.js` (`ALIASES`), `lib/__tests__/cabinetNav.test.mjs` (если гард требует перечисления — см. Step 1)

**Interfaces:**
- Consumes: `GET ?id=`, `POST` (Task 6); `ORDER_STATUS_LABELS`, `PAY_KIND_LABELS`, `SHIP_STATUS_LABELS`, `cargoRub` (Task 3).
- Produces: компоненты `OrderPage({cabinetId, orderId})`; общий `post(action, body) → Promise<boolean>` передаётся вниз пропом; `CatalogPicker({cabinetId, onPick})` — `onPick({platform, nm_id, product_id, label, im_url})`.

- [ ] **Step 1: Навигация.** Как `resolveNav` сопоставляет алиасы (стр. ~125–135, функция `under`): проверить, ловит ли `under("/fin-purchases")` путь `/fin-purchases/123`. Run: `node -e "import('/opt/agents/saas/lib/cabinetNav.js').then(m=>console.log(JSON.stringify(m.resolveNav('/cabinets/1/fin-purchases/5', 'owner')).slice(0,300)))"`. Если активный пункт уже «Закупки» — алиас не нужен. Если нет — добавить в `ALIASES` строку `"/fin-purchases/": "/fin-purchases",` и прогнать `node --test lib/__tests__/cabinetNav.test.mjs` (должен быть PASS).

- [ ] **Step 2: `page.js`**

```js
import OrderPage from './OrderPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <OrderPage cabinetId={Number(params.id)} orderId={Number(params.orderId)} />;
}
```

- [ ] **Step 3: `CatalogPicker.jsx`**

```jsx
"use client";
import { C } from "@/lib/palette.js";
import { useEffect, useState } from "react";

// Поиск артикула WB/Ozon для позиции заказа (GET purchase-orders?catalog=1).
export default function CatalogPicker({ cabinetId, onPick, onCancel }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders?catalog=1&q=${encodeURIComponent(q.trim())}`);
        setFound((await r.json()).catalog || []);
      } catch (e) { console.error("po catalog", e); setFound([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [cabinetId, q]);
  return (
    <div style={{ padding: 8, border: `1px solid ${C.line}`, borderRadius: 8, background: C.surface, minWidth: 340 }}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Артикул, название, offer_id"
        style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, width: "100%" }} />
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {found.map((c) => (
          <div key={`${c.platform}${c.nm_id || c.product_id}`} onClick={() => onPick(c)} style={{ padding: "4px 2px", cursor: "pointer", fontSize: 13 }}>
            {c.im_url && <img src={c.im_url} alt="" style={{ width: 24, height: 24, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} />}
            {c.platform === "wb" ? "WB" : "Ozon"} · {c.label} <span style={{ color: C.muted }}>{c.nm_id || c.article || c.product_id}</span>
          </div>
        ))}
      </div>
      {onCancel && <button onClick={onCancel} style={{ marginTop: 6, fontSize: 12, background: "none", border: "none", color: C.muted, cursor: "pointer" }}>отмена</button>}
    </div>
  );
}
```

- [ ] **Step 4: `OrderPage.jsx`** (шапка, итоги, предупреждения, секции)

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useState } from "react";
import { ORDER_STATUS_LABELS } from "@/lib/purchaseOrders.js";
import OrderLines from "./OrderLines";
import OrderPayments from "./OrderPayments";
import OrderShipments from "./OrderShipments";

// Карточка заказа закупки (спека 2026-10-27-purchase-orders-design.md §4). Все цифры — calc из API
// (lib/purchaseOrders.js calcOrder), клиент ничего не пересчитывает.

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 });
export const inp = { padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
export const btn = { padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.ink, cursor: "pointer", fontSize: 13 };
const HEAD_FIELDS = [
  ["supplier", "Поставщик"], ["order_no", "№ заказа"], ["supplier_contact", "Контакт"], ["source_country", "Где"],
  ["category", "Категория"], ["order_dt", "Дата", "date"], ["rate_cny", "План. курс ¥"],
];

export default function OrderPage({ cabinetId, orderId }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders?id=${orderId}`);
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setD(j); setErr(null);
    } catch (e) { console.error("order load", e); setErr(String(e.message || e)); }
  }, [cabinetId, orderId]);
  useEffect(() => { reload(); }, [reload]);

  const post = useCallback(async (action, body = {}) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, order_id: orderId, ...body }),
      });
      const j = await r.json();
      if (!r.ok || j.error) { alert(j.error || `Ошибка ${r.status}`); return false; }
      await reload();
      return true;
    } catch (e) { console.error("order post", e); alert(String(e.message || e)); return false; }
    finally { setBusy(false); }
  }, [cabinetId, orderId, reload]);

  if (err) return <div style={{ fontFamily: FONT, padding: 28, color: C.neg }}>Ошибка: {err}</div>;
  if (!d) return <div style={{ fontFamily: FONT, padding: 28, color: C.muted }}>Загрузка…</div>;
  const { order, calc } = d;
  const canEdit = d.role !== "viewer";

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px" }}>
      <a href={`/cabinets/${cabinetId}/fin-purchases`} style={{ color: C.muted, fontSize: 13 }}>← Закупки</a>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", margin: "8px 0 16px" }}>
        <div style={{ flex: "1 1 520px" }}>
          <h1 style={{ fontSize: 22, margin: "0 0 10px" }}>{order.supplier}{order.order_no ? ` · ${order.order_no}` : ""}</h1>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
            {HEAD_FIELDS.map(([k, l, type]) => (
              <label key={k} style={{ fontSize: 12, color: C.muted }}>{l}
                <input key={`${k}:${order[k] ?? ""}`} type={type || "text"} defaultValue={order[k] ?? ""} disabled={!canEdit || busy}
                  style={{ ...inp, width: "100%", display: "block" }}
                  onBlur={(e) => { const v = e.target.value; if (v !== String(order[k] ?? "")) post("update", { [k]: v }); }} />
              </label>
            ))}
            <label style={{ fontSize: 12, color: C.muted }}>Статус
              <select value={order.status} disabled={!canEdit || busy} style={{ ...inp, width: "100%", display: "block" }}
                onChange={(e) => post("update", { status: e.target.value })}>
                {Object.entries(ORDER_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
          <label style={{ fontSize: 12, color: C.muted, display: "block", marginTop: 8 }}>Примечание
            <input key={`note:${order.note ?? ""}`} defaultValue={order.note ?? ""} disabled={!canEdit || busy} style={{ ...inp, width: "100%", display: "block" }}
              onBlur={(e) => { if (e.target.value !== (order.note ?? "")) post("update", { note: e.target.value }); }} />
          </label>
        </div>
        <div style={{ flex: "0 0 300px", padding: 14, borderRadius: 10, background: soft("accent", 6), fontSize: 13, lineHeight: 1.7 }}>
          <div>Сумма: <b>{nf2.format(calc.totalCny)} ¥</b> · {nf0.format(calc.goodsRub)} ₽</div>
          <div>Эфф. курс: {nf4.format(calc.rateEff)}</div>
          <div>Оплачено: {nf2.format(calc.paidCny)} ¥ · осталось {nf2.format(calc.remainingCny)} ¥</div>
          <div>Прочие расходы: {nf0.format(calc.otherRub)} ₽</div>
          <div>Логистика: {nf0.format(calc.logisticsRub)} ₽</div>
          <div>Себестоимость всего: <b>{nf0.format(calc.totalRub)} ₽</b>{calc.qty > 0 ? ` · ср. ${nf0.format(calc.totalRub / calc.qty)} ₽/шт` : ""}</div>
          <div>Отправлено {nf0.format(calc.shippedQty)} из {nf0.format(calc.qty)} · принято {nf0.format(calc.acceptedQty)}</div>
          {calc.shortageQty > 0 && <div style={{ color: C.neg }}>Недостача: {nf0.format(calc.shortageQty)} шт · {nf0.format(calc.shortageRub)} ₽</div>}
          {canEdit && <button style={{ ...btn, marginTop: 8, color: C.neg, borderColor: C.neg }} disabled={busy}
            onClick={async () => { if (confirm("Удалить заказ целиком? Плановые платежи уйдут из календаря.") && await post("delete")) window.location.href = `/cabinets/${cabinetId}/fin-purchases`; }}>Удалить заказ</button>}
        </div>
      </div>
      {calc.warnings.length > 0 && (
        <div style={{ padding: 10, borderRadius: 8, background: soft("warn", 15), color: C.warn, fontSize: 13, marginBottom: 14 }}>
          {calc.warnings.map((w) => <div key={w}>⚠ {w}</div>)}
        </div>
      )}
      <OrderLines cabinetId={cabinetId} d={d} post={post} busy={busy} canEdit={canEdit} />
      <OrderPayments d={d} post={post} busy={busy} canEdit={canEdit} />
      <OrderShipments d={d} post={post} busy={busy} canEdit={canEdit} />
    </div>
  );
}
```

- [ ] **Step 5: `OrderLines.jsx`**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";
import CatalogPicker from "./CatalogPicker";
import { inp, btn } from "./OrderPage";

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const EMPTY = { label: "", variant: "", qty: "", price_cny: "", weight_kg: "" };

// Позиции заказа: товар (артикул WB/Ozon или текст), вариант, кол-во, цена ¥, вес; себестоимость — из calc.
export default function OrderLines({ cabinetId, d, post, busy, canEdit }) {
  const [add, setAdd] = useState(EMPTY);
  const [pick, setPick] = useState(null);      // выбранный артикул для новой строки
  const [picking, setPicking] = useState(null); // 'new' | line id
  const calcBy = new Map(d.calc.lines.map((l) => [l.id, l]));

  async function addLine() {
    const body = { ...add, label: add.label || pick?.label || "", platform: pick?.platform || null, nm_id: pick?.nm_id, product_id: pick?.product_id };
    if (await post("line_add", body)) { setAdd(EMPTY); setPick(null); }
  }
  const cell = (l, k, w = 70, type = "text") => (
    <input key={`${k}:${l[k] ?? ""}`} type={type} defaultValue={l[k] ?? ""} disabled={!canEdit || busy} style={{ ...inp, width: w, textAlign: type === "number" ? "right" : "left" }}
      onBlur={(e) => { if (e.target.value !== String(l[k] ?? "")) post("line_update", { id: l.id, [k]: e.target.value }); }} />
  );

  return (
    <section style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Позиции</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ color: C.muted, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
          <th style={{ padding: 6 }}>Товар</th><th style={{ padding: 6 }}>Вариант</th>
          <th style={{ padding: 6, textAlign: "right" }}>Кол-во</th><th style={{ padding: 6, textAlign: "right" }}>Цена ¥</th>
          <th style={{ padding: 6, textAlign: "right" }}>Вес ед., кг</th><th style={{ padding: 6, textAlign: "right" }}>Сумма ¥</th>
          <th style={{ padding: 6, textAlign: "right" }}>Себест. ₽/шт</th><th style={{ padding: 6, textAlign: "right" }}>Отпр. / принято</th><th />
        </tr></thead>
        <tbody>
          {d.lines.map((l) => {
            const c = calcBy.get(Number(l.id)) || {};
            const tip = `товар ${nf2.format(c.goodsUnit || 0)} + прочее ${nf2.format(c.otherUnit || 0)} + логистика ${c.logisticsUnit == null ? "ещё не известна" : nf2.format(c.logisticsUnit)}`;
            return (
              <tr key={l.id} style={{ borderBottom: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: 6, position: "relative" }}>
                  {l.photo && <img src={l.photo} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} />}
                  {cell(l, "label", 220)}
                  <span style={{ color: C.muted, marginLeft: 6, cursor: canEdit ? "pointer" : "default" }} onClick={() => canEdit && setPicking(l.id)}>
                    {l.platform === "wb" ? `WB ${l.nm_id}` : l.platform === "ozon" ? `Ozon ${l.article || l.product_id}` : "＋ артикул"}
                  </span>
                  {picking === l.id && (
                    <div style={{ position: "absolute", zIndex: 5, top: "100%", left: 0 }}>
                      <CatalogPicker cabinetId={cabinetId} onCancel={() => setPicking(null)}
                        onPick={async (p) => { if (await post("line_update", { id: l.id, platform: p.platform, nm_id: p.nm_id, product_id: p.product_id, label: l.label })) setPicking(null); }} />
                    </div>
                  )}
                </td>
                <td style={{ padding: 6 }}>{cell(l, "variant", 80)}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{cell(l, "qty", 70, "number")}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{cell(l, "price_cny", 80)}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{cell(l, "weight_kg", 70)}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{nf2.format(c.sumCny || 0)}</td>
                <td style={{ padding: 6, textAlign: "right" }} title={tip}>
                  <b>{nf0.format(c.unitCost || 0)}</b>{c.logisticsUnit == null && <div style={{ color: C.muted, fontSize: 11 }}>без логистики</div>}
                </td>
                <td style={{ padding: 6, textAlign: "right" }}>
                  {nf0.format(c.shipped || 0)} / {nf0.format(c.accepted || 0)}
                  {c.shortage > 0 && <div style={{ color: C.neg, fontSize: 11 }}>недостача {c.shortage} · {nf0.format(c.shortageRub)} ₽</div>}
                  {c.surplus > 0 && <div style={{ color: C.muted, fontSize: 11 }}>излишек {c.surplus}</div>}
                </td>
                <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                  {canEdit && <button title="Ещё размер/цвет" style={btn} disabled={busy}
                    onClick={() => { const v = prompt("Вариант (размер/цвет) новой строки", ""); if (v != null) post("line_copy", { id: l.id, variant: v }); }}>⧉</button>}
                  {canEdit && <button title="Удалить" style={{ ...btn, marginLeft: 4 }} disabled={busy}
                    onClick={() => confirm(`Удалить «${l.label}»?`) && post("line_delete", { id: l.id })}>✕</button>}
                </td>
              </tr>
            );
          })}
          {canEdit && (
            <tr>
              <td style={{ padding: 6, position: "relative" }}>
                <input value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} placeholder={pick ? pick.label : "Название или выберите артикул →"} style={{ ...inp, width: 220 }} />
                <span style={{ color: C.accent, marginLeft: 6, cursor: "pointer" }} onClick={() => setPicking("new")}>{pick ? `${pick.platform === "wb" ? "WB" : "Ozon"} ✓` : "＋ артикул"}</span>
                {picking === "new" && (
                  <div style={{ position: "absolute", zIndex: 5, top: "100%", left: 0 }}>
                    <CatalogPicker cabinetId={cabinetId} onCancel={() => setPicking(null)} onPick={(p) => { setPick(p); setPicking(null); }} />
                  </div>
                )}
              </td>
              <td style={{ padding: 6 }}><input value={add.variant} onChange={(e) => setAdd({ ...add, variant: e.target.value })} style={{ ...inp, width: 80 }} /></td>
              <td style={{ padding: 6, textAlign: "right" }}><input type="number" value={add.qty} onChange={(e) => setAdd({ ...add, qty: e.target.value })} style={{ ...inp, width: 70 }} /></td>
              <td style={{ padding: 6, textAlign: "right" }}><input value={add.price_cny} onChange={(e) => setAdd({ ...add, price_cny: e.target.value })} style={{ ...inp, width: 80 }} /></td>
              <td style={{ padding: 6, textAlign: "right" }}><input value={add.weight_kg} onChange={(e) => setAdd({ ...add, weight_kg: e.target.value })} style={{ ...inp, width: 70 }} /></td>
              <td colSpan={4} style={{ padding: 6 }}><button style={{ ...btn, borderColor: C.accent }} disabled={busy} onClick={addLine}>+ Позиция</button></td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 6: `OrderPayments.jsx`**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";
import { PAY_KIND_LABELS } from "@/lib/purchaseOrders.js";
import { inp, btn } from "./OrderPage";

const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const EMPTY = { kind: "prepay", currency: "cny", amount: "", rate: "", plan_date: "" };

// Оплаты заказа: каждая — строка календаря (статус «оплачено» — из ДДС, правится в календаре).
export default function OrderPayments({ d, post, busy, canEdit }) {
  const [add, setAdd] = useState(EMPTY);
  const ddsBy = new Map(d.dds.map((x) => [x.source_ref, x]));
  const set = (k) => (e) => setAdd({ ...add, [k]: e.target.value, ...(k === "kind" && e.target.value !== "other" ? { currency: "cny" } : {}) });
  const field = (p, k, w, type = "text") => (
    <input key={`${k}:${p[k] ?? ""}`} type={type} defaultValue={p[k] ?? ""} disabled={!canEdit || busy} style={{ ...inp, width: w }}
      onBlur={(e) => { if (e.target.value !== String(p[k] ?? "")) post("pay_update", { id: p.id, [k]: e.target.value }); }} />
  );
  return (
    <section style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Оплаты <span style={{ fontSize: 13, color: C.muted, fontWeight: 400 }}>осталось оплатить {nf2.format(d.calc.remainingCny)} ¥</span></h2>
      <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ color: C.muted, textAlign: "left" }}>
          <th style={{ padding: 6 }}>Вид</th><th style={{ padding: 6 }}>Сумма</th><th style={{ padding: 6 }}>Валюта</th>
          <th style={{ padding: 6 }}>Курс</th><th style={{ padding: 6 }}>Дата</th><th style={{ padding: 6 }}>В календаре</th><th />
        </tr></thead>
        <tbody>
          {d.payments.map((p) => {
            const m = ddsBy.get(`order:${d.order.id}:pay:${p.id}`);
            return (
              <tr key={p.id} style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: 6 }}>{PAY_KIND_LABELS[p.kind]}</td>
                <td style={{ padding: 6 }}>{field(p, "amount", 90)}</td>
                <td style={{ padding: 6 }}>{p.currency === "rub" ? "₽" : "¥"}</td>
                <td style={{ padding: 6 }}>{p.currency === "cny" ? field(p, "rate", 70) : "—"}</td>
                <td style={{ padding: 6 }}>{field(p, "plan_date", 140, "date")}</td>
                <td style={{ padding: 6, color: m?.status === "paid" ? C.pos : C.muted }}>{m ? (m.status === "paid" ? `✓ оплачено ${m.paid_at ? m.paid_at.slice(0, 10) : ""}` : "запланировано") : "—"}</td>
                <td style={{ padding: 6 }}>{canEdit && <button style={btn} disabled={busy} onClick={() => confirm("Удалить оплату?") && post("pay_delete", { id: p.id })}>✕</button>}</td>
              </tr>
            );
          })}
          {canEdit && (
            <tr style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
              <td style={{ padding: 6 }}><select value={add.kind} onChange={set("kind")} style={inp}>{Object.entries(PAY_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
              <td style={{ padding: 6 }}><input value={add.amount} onChange={set("amount")} style={{ ...inp, width: 90 }} /></td>
              <td style={{ padding: 6 }}>
                <select value={add.currency} onChange={set("currency")} disabled={add.kind !== "other"} style={inp}><option value="cny">¥</option><option value="rub">₽</option></select>
              </td>
              <td style={{ padding: 6 }}><input value={add.rate} onChange={set("rate")} disabled={add.currency === "rub"} style={{ ...inp, width: 70 }} /></td>
              <td style={{ padding: 6 }}><input type="date" value={add.plan_date} onChange={set("plan_date")} style={inp} /></td>
              <td colSpan={2} style={{ padding: 6 }}><button style={{ ...btn, borderColor: C.accent }} disabled={busy}
                onClick={async () => { if (await post("pay_add", add)) setAdd(EMPTY); }}>+ Оплата</button></td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 7: `OrderShipments.jsx`**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";
import { SHIP_STATUS_LABELS, cargoRub } from "@/lib/purchaseOrders.js";
import { inp, btn } from "./OrderPage";

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

// Отправки заказа: состав «позиция → шт», логистика до МСК / МСК→ФФ (помощник $/кг), «✓ Прибыла».
export default function OrderShipments({ d, post, busy, canEdit }) {
  const lineBy = new Map(d.lines.map((l) => [Number(l.id), l]));
  const calcBy = new Map(d.calc.shipments.map((s) => [s.id, s]));
  return (
    <section>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Отправки</h2>
      {d.shipments.map((s) => (
        <Shipment key={s.id} s={s} c={calcBy.get(Number(s.id))} sl={d.shipmentLines.filter((x) => Number(x.shipment_id) === Number(s.id))}
          lineBy={lineBy} post={post} busy={busy} canEdit={canEdit} />
      ))}
      {canEdit && <button style={{ ...btn, borderColor: C.accent }} disabled={busy}
        onClick={() => post("ship_add", {})}>+ Отправка (всё неотправленное)</button>}
    </section>
  );
}

function Shipment({ s, c, sl, lineBy, post, busy, canEdit }) {
  const [kg, setKg] = useState({ usd: "", rate: "" });
  const locked = s.status === "accepted";
  const totalKg = sl.reduce((t, x) => t + x.qty_shipped * (Number(lineBy.get(Number(x.line_id))?.weight_kg) || 0), 0);
  const field = (k, l, w, type = "text") => (
    <label style={{ fontSize: 12, color: C.muted }}>{l}
      <input key={`${k}:${s[k] ?? ""}`} type={type} defaultValue={s[k] ?? ""} disabled={!canEdit || busy} style={{ ...inp, width: w, display: "block" }}
        onBlur={(e) => { if (e.target.value !== String(s[k] ?? "")) post("ship_update", { id: s.id, [k]: e.target.value }); }} />
    </label>
  );
  const setQty = (lineId, v) => {
    const lines = sl.map((x) => ({ line_id: Number(x.line_id), qty_shipped: Number(x.line_id) === lineId ? Number(v) : x.qty_shipped }))
      .filter((x) => x.qty_shipped > 0);
    post("ship_update", { id: s.id, lines });
  };
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <b style={{ alignSelf: "center" }}>#{s.id}</b>
        <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12, alignSelf: "center",
          background: soft(s.status === "accepted" ? "pos" : s.status === "arrived" ? "warn" : "accent", 18) }}>{SHIP_STATUS_LABELS[s.status]}</span>
        {field("shipment_no", "Трек / №", 120)}{field("carrier", "Перевозчик", 120)}
        {field("ship_dt", "Отправлена", 140, "date")}{field("eta", "Ожидается", 140, "date")}{field("arrived_dt", "Прибыла", 140, "date")}
        {field("cargo_rub", "До МСК, ₽", 100)}{field("ff_rub", "МСК→ФФ, ₽", 100)}
      </div>
      {canEdit && (
        <div style={{ fontSize: 12, color: C.muted, margin: "8px 0" }}>
          Карго по весу: {nf2.format(totalKg)} кг ×
          <input value={kg.usd} onChange={(e) => setKg({ ...kg, usd: e.target.value })} placeholder="$/кг" style={{ ...inp, width: 60, margin: "0 4px" }} />×
          <input value={kg.rate} onChange={(e) => setKg({ ...kg, rate: e.target.value })} placeholder="курс $" style={{ ...inp, width: 60, margin: "0 4px" }} />
          = {nf0.format(cargoRub(totalKg, kg.usd, kg.rate))} ₽
          <button style={{ ...btn, marginLeft: 6 }} disabled={busy || !(cargoRub(totalKg, kg.usd, kg.rate) > 0)}
            onClick={() => post("ship_update", { id: s.id, cargo_rub: Math.round(cargoRub(totalKg, kg.usd, kg.rate) * 100) / 100 })}>→ в «До МСК»</button>
          {totalKg === 0 && <span> (вес у позиций не указан)</span>}
        </div>
      )}
      <table style={{ borderCollapse: "collapse", fontSize: 13, marginTop: 6 }}>
        <thead><tr style={{ color: C.muted, textAlign: "left" }}>
          <th style={{ padding: 4 }}>Позиция</th><th style={{ padding: 4, textAlign: "right" }}>Шт</th>
          <th style={{ padding: 4, textAlign: "right" }}>Логистика, ₽</th><th style={{ padding: 4, textAlign: "right" }}>Принято</th>
        </tr></thead>
        <tbody>
          {sl.map((x) => {
            const l = lineBy.get(Number(x.line_id));
            const a = c?.lines.find((y) => y.line_id === Number(x.line_id));
            return (
              <tr key={x.id}>
                <td style={{ padding: 4 }}>{l?.label}{l?.variant ? ` · ${l.variant}` : ""}</td>
                <td style={{ padding: 4, textAlign: "right" }}>
                  {locked || !canEdit ? x.qty_shipped : <input key={`q:${x.qty_shipped}`} type="number" min={0} defaultValue={x.qty_shipped} disabled={busy}
                    style={{ ...inp, width: 70, textAlign: "right" }} onBlur={(e) => { if (Number(e.target.value) !== x.qty_shipped) setQty(Number(x.line_id), e.target.value); }} />}
                </td>
                <td style={{ padding: 4, textAlign: "right" }}>{nf0.format(a?.alloc || 0)}</td>
                <td style={{ padding: 4, textAlign: "right" }}>{x.qty_accepted == null ? "—" : x.qty_accepted}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Логистика делится {c?.basis === "weight" ? "по весу" : "по штукам (вес указан не у всех позиций)"}.</div>
      {canEdit && (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {s.status === "transit" && <button style={{ ...btn, borderColor: C.pos, color: C.pos }} disabled={busy} onClick={() => post("ship_arrived", { id: s.id })}>✓ Прибыла</button>}
          {s.status === "arrived" && <button style={btn} disabled={busy} onClick={() => post("ship_unarrived", { id: s.id })}>↩ В пути</button>}
          {s.status === "arrived" && <span style={{ fontSize: 12, color: C.muted, alignSelf: "center" }}>ждёт приёмки на «Доставлено на склад»</span>}
          {!locked && <button style={{ ...btn, marginLeft: "auto" }} disabled={busy} onClick={() => confirm("Удалить отправку?") && post("ship_delete", { id: s.id })}>Удалить</button>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Тесты + скрининги граблей**

Run: `node --test lib/__tests__/ && grep -rn 'fetch("[^"]*\${' "app/cabinets/[id]/fin-purchases" "app/cabinets/[id]/deliveries"; echo "D3 exit=$?"`
Expected: тесты PASS; grep ничего не находит (`D3 exit=1`).

- [ ] **Step 9: Commit**

```bash
git add "app/cabinets/[id]/fin-purchases/[orderId]" lib/cabinetNav.js lib/__tests__/cabinetNav.test.mjs
git commit -m "feat(purchase-orders): карточка заказа — позиции, оплаты, отправки"
```

(Если `cabinetNav.js`/тест не менялись в Step 1 — не включать их в `git add`.)

---

### Task 12: Сборка, смоук, документация

**Files:**
- Create: `scripts/smoke-purchase-orders.mjs`
- Modify: `AGENTS.md` (TL;DR-строка + абзац в «Где что считается»)

**Interfaces:**
- Consumes: всё выше; HTTP на `http://127.0.0.1:3200`.

- [ ] **Step 1: Смоук** (каркас — как `scripts/smoke-cost-calc.mjs`: чтение `.env.local`, `cookieFor`, только каб. #1)

```js
#!/usr/bin/env node
// scripts/smoke-purchase-orders.mjs — смоук закупок заказами (спека 2026-10-27). Только кабинет #1.
// Создаёт заказ по примеру спеки §2 → сверяет calc (курс, логистика, инвариант суммы) → строки ДДС →
// «✓ Прибыла» → отправка на /deliveries → приёмка с недостачей → удаляет за собой (заказ мягко, ДДС → archived).
// Запуск: node scripts/smoke-purchase-orders.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
if (CAB !== 1) { console.error('смоук пишет в БД — только кабинет #1'); process.exit(2); }
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail).slice(0, 400)}`); if (!cond) failed++; };
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

async function cookieFor(userId) {
  const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [userId]);
  const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version, active_cabinet_id: null, touched_at: Date.now() },
    { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
  return `saas_session=${encodeURIComponent(seal)}`;
}
const api = async (cookie, path, method = 'GET', body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const own = await cookieFor(owner_user_id);
let orderId = null;
try {
  const c = await api(own, 'purchase-orders', 'POST', { action: 'create', supplier: '__smoke purchase-orders', rate_cny: 11.9, order_dt: '2026-10-01' });
  check('create → id', c.status === 200 && c.data.id > 0, c);
  orderId = c.data.id;
  const P = (action, b) => api(own, 'purchase-orders', 'POST', { action, order_id: orderId, ...b });
  const cam = (await P('line_add', { label: 'камера', qty: 70, price_cny: 150, weight_kg: 0.3 })).data.id;
  const lin = (await P('line_add', { label: 'бельё', qty: 200, price_cny: 12.5, weight_kg: 0.1 })).data.id;
  await P('pay_add', { kind: 'prepay', amount: 4000, rate: 11.46, plan_date: '2026-10-02' });
  await P('pay_add', { kind: 'other', amount: 300, rate: 11.5 });
  const s1 = (await P('ship_add', { cargo_rub: 12000, ff_rub: 4000, lines: [{ line_id: cam, qty_shipped: 40 }, { line_id: lin, qty_shipped: 200 }] })).data.id;
  const over = await P('ship_add', { lines: [{ line_id: cam, qty_shipped: 31 }] });
  check('отправить больше заказанного → 400', over.status === 400, over);
  const s2 = (await P('ship_add', { cargo_rub: 5000 })).data.id; // по умолчанию — остаток 30 камер

  const v = (await api(own, `purchase-orders?id=${orderId}`)).data;
  const cl = v.calc.lines.find((l) => l.id === cam);
  check('эфф. курс', close(v.calc.rateEff, (4000 * 11.46 + 9000 * 11.9) / 13000, 1e-6), v.calc.rateEff);
  check('логистика камеры 157,14', close(cl.logisticsUnit, 11000 / 70), cl);
  const sum = v.calc.lines.reduce((s, l) => s + l.unitCost * l.qty, 0);
  check('инвариант суммы', close(sum, v.calc.goodsRub + v.calc.otherRub + v.calc.logisticsRub), { sum, calc: v.calc });
  check('ДДС: 2 оплаты + 3 строки логистики', v.dds.length === 5, v.dds);

  await P('ship_arrived', { id: s1 });
  const del = (await api(own, 'deliveries?status=waiting')).data;
  const it = del.items.find((x) => x.key === `s${s1}`);
  check('отправка на /deliveries', !!it && it.ordered === 240, del.items?.map((x) => x.key));
  const camLine = it.lines.find((l) => Number(l.line_id) === cam);
  await api(own, 'deliveries', 'POST', { action: 'ship_accept_line', shipment_id: s1, id: camLine.id, qty_accepted: 38 });
  const done = await api(own, 'deliveries', 'POST', { action: 'ship_done', shipment_id: s1 });
  check('ship_done', done.status === 200, done);
  const v2 = (await api(own, `purchase-orders?id=${orderId}`)).data;
  const cl2 = v2.calc.lines.find((l) => l.id === cam);
  check('недостача 2 шт, логистика не изменилась', cl2.shortage === 2 && close(cl2.logisticsUnit, 11000 / 70), cl2);
  const delAcc = await P('delete', {});
  check('нельзя удалить заказ с принятой отправкой', delAcc.status === 400, delAcc);
  const old = await api(own, 'purchases', 'POST', { supplier_name: 'x', qty: 1 });
  check('старые партии — 410', old.status === 410, old);
  void s2;
} finally {
  if (orderId) {
    // Уборка — от админа: снять приёмку и удалить тестовый заказ целиком (строки ДДС → archived).
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ host: 'localhost', user: 'postgres', database: 'saas' }); // пароль — PGPASSFILE=/root/.pgpass-admin
    await admin.connect();
    await admin.query(`UPDATE tenant.dds_movements SET status='archived' WHERE cabinet_id=$1 AND source_ref LIKE $2 AND status='planned'`, [CAB, `order:${orderId}:%`]);
    for (const t of ['purchase_shipment_lines']) await admin.query(`DELETE FROM tenant.${t} WHERE cabinet_id=$1 AND shipment_id IN (SELECT id FROM tenant.purchase_shipments WHERE cabinet_id=$1 AND order_id=$2)`, [CAB, orderId]);
    for (const t of ['purchase_shipments', 'purchase_order_payments', 'purchase_order_lines']) await admin.query(`DELETE FROM tenant.${t} WHERE cabinet_id=$1 AND order_id=$2`, [CAB, orderId]);
    await admin.query(`DELETE FROM tenant.purchase_orders WHERE cabinet_id=$1 AND id=$2`, [CAB, orderId]);
    await admin.end();
    console.log(`уборка: заказ ${orderId} удалён`);
  }
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
```

Строки `dds_movements` смоука остаются со `status='archived'` (не удаляются — ДДС-журнал не чистим физически).

- [ ] **Step 2: Сборка и рестарт**

Run: `cd /opt/agents/saas && node --test lib/__tests__/ && npm run build 2>&1 | tail -15 && systemctl restart saas-web && sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3200/`
Expected: тесты PASS, сборка без ошибок, `200` (или `307` редирект на логин).

- [ ] **Step 3: Смоук**

Run: `PGPASSFILE=/root/.pgpass-admin node scripts/smoke-purchase-orders.mjs 1`
Expected: `ALL PASS`, «уборка: заказ N удалён». При FAIL — разбирать (superpowers:systematic-debugging), не подгонять ожидания.

- [ ] **Step 4: Соседние смоуки не сломаны**

Run: `node scripts/smoke-deliveries.mjs 1; node scripts/smoke-payment-calendar.mjs 1; node scripts/smoke-dds.mjs 1`
Expected: ALL PASS у каждого. `smoke-deliveries.mjs` может проверять `complete_to_stock` старых партий — если он падает на 410, поправить смоук под архив (старые партии — только чтение) в этом же шаге, отдельным пунктом в отчёте.

- [ ] **Step 5: AGENTS.md** — в таблицу TL;DR после строки «Доставлено на склад» добавить:

```
| Закупки заказами (заказ → позиции → оплаты → отправки, себестоимость позиции с логистикой по весу) | `lib/purchaseOrders.js` (`calcOrder`), `lib/purchaseOrdersData.js`, `/fin-purchases`, `/fin-purchases/[orderId]`, API `purchase-orders`, миграция 075, смоук `PGPASSFILE=/root/.pgpass-admin node scripts/smoke-purchase-orders.mjs 1` |
```

и в «Где что считается» абзац:

```
- **Закупки заказами (с 2026-10-27)** — `/fin-purchases`: заказ (поставщик, план. курс ¥) → позиции (артикул WB/Ozon или текст,
  вариант, кол-во, цена ¥, вес) → оплаты (0..N, ¥ по своему курсу; «прочее» — ¥ или ₽) → отправки (часть позиций/штук, логистика
  до МСК + МСК→ФФ в ₽). Себестоимость позиции = цена ¥ × эфф. курс (оплаты по своим курсам, остаток — по плановому) + прочее заказа
  (по весу всего заказа) + логистика отправок (по весу строк отправки; вес не у всех — по штукам), на ОТПРАВЛЕННЫЕ штуки; недостача
  приёмки — только показ. Ядро `lib/purchaseOrders.js` (тесты `lib/__tests__/purchaseOrders.test.mjs`), ДДС — `syncOrderPayments`
  (`source_ref='order:<id>:pay:<pid>'`/`order:<id>:ship:<sid>:cargo|ff`). Приёмка — по отправке на `/deliveries` (`ship_*`).
  В `cost_overrides`/`ff_inventory` не пишет. Старые `tenant.purchases` — архив «до 16.10», POST/DELETE → 410. Спека
  `docs/superpowers/specs/2026-10-27-purchase-orders-design.md`.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-purchase-orders.mjs AGENTS.md
git commit -m "docs+smoke(purchase-orders): смоук на каб. #1, строка в карте AGENTS.md"
```

(Если в Step 4 правился `scripts/smoke-deliveries.mjs` — добавить его в этот же `git add`.)
