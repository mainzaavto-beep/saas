# «Доставлено на склад» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Партия закупки по кнопке «✓ Доставлено» попадает на новую страницу «Доставлено на склад», где фиксируется принятое ФФ количество по артикулам; партия — конечная точка, ни с чем дальше не связана.

**Architecture:** Миграция 069 (колонки приёмки у `tenant.purchases` + таблица строк `tenant.purchase_receipt_lines`). Чистые функции в `lib/deliveries.js`, роут `app/api/cabinets/[id]/deliveries`, страница `/deliveries`. В роуте закупок `complete_to_stock` перестаёт писать в `ff_inventory`/журнал движений.

**Tech Stack:** Next.js 14 App Router, PostgreSQL (RLS по `app.cabinet_id`), node:test, `lib/db.js` (`tenantQuery`), `lib/withCabinet.js`.

**Spec:** `docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md`

## Global Constraints

- Эксперименты и смоуки — только кабинет #1. Чужие кабинеты не трогать.
- Боевую БД читать под `saas_ro`: `psql -h localhost -U saas_ro -d saas -Atc "…"`. Миграцию применять только `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f …`.
- Бэкап боевого файла перед правкой: `cp <file> /opt/agentsDB/backups/<basename>.$(date +%Y%m%d_%H%M%S).bak`.
- Миграция идемпотентна (`IF NOT EXISTS`, проверки `pg_policies`).
- Клиентские страницы: компонент принимает `{ cabinetId }`; fetch только в backticks `` `/api/cabinets/${cabinetId}/…` ``; все хуки до ранних `return`; цвета — `C`/`soft()` из `@/lib/palette.js`, без `${C.x}NN`.
- В `withCabinet` одна транзакция на запрос; запросы строго последовательно (без `Promise.all`).
- Пустой `catch {}` без `console.error` запрещён.
- Не запускать `next dev` в каталоге прода. После правок `app/`/`lib/`: `npm run build && systemctl restart saas-web`.
- `git add` — только явный список файлов задачи.
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Права: POST роута `deliveries` — `requireRole: 'manager'`; `undone` — дополнительно только `cabinet.role === 'owner'`.

---

### Task 1: Миграция 069

**Files:**
- Create: `db/migrations/069_purchase_receipts.sql`

**Interfaces:**
- Produces: колонки `tenant.purchases.delivered_at date`, `receipt_done_at timestamptz`, `receipt_done_by bigint`; таблица `tenant.purchase_receipt_lines(cabinet_id, id, purchase_id, platform, nm_id, product_id, label, qty_accepted, note, created_at, updated_at)`.

- [ ] **Step 1: Написать миграцию**

```sql
-- 069_purchase_receipts.sql — «Доставлено на склад» (15.10.2026, спека
-- docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md): партия закупки после
-- «✓ Доставлено» ждёт приёмки ФФ; приёмка = строки «артикул → принято, шт». Конечная точка:
-- ни ff_inventory, ни stock_moves, ни cost_overrides эти данные не трогают. Идемпотентно.
BEGIN;

ALTER TABLE tenant.purchases ADD COLUMN IF NOT EXISTS delivered_at    DATE;
ALTER TABLE tenant.purchases ADD COLUMN IF NOT EXISTS receipt_done_at TIMESTAMPTZ;
ALTER TABLE tenant.purchases ADD COLUMN IF NOT EXISTS receipt_done_by BIGINT;

-- Уже завершённые партии появляются на странице «Ждёт приёмки».
UPDATE tenant.purchases
   SET delivered_at = COALESCE(delivery_dt::date, created_at::date)
 WHERE archived AND delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant.purchase_receipt_lines (
    cabinet_id   BIGINT      NOT NULL,
    id           BIGSERIAL   NOT NULL,
    purchase_id  BIGINT      NOT NULL,
    platform     TEXT        CHECK (platform IN ('wb', 'ozon')),
    nm_id        BIGINT,
    product_id   BIGINT,
    label        TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
    qty_accepted INTEGER     NOT NULL CHECK (qty_accepted >= 0),
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, purchase_id) REFERENCES tenant.purchases (cabinet_id, id),
    CHECK (
      (platform = 'wb'   AND nm_id IS NOT NULL AND product_id IS NULL) OR
      (platform = 'ozon' AND product_id IS NOT NULL AND nm_id IS NULL) OR
      (platform IS NULL  AND nm_id IS NULL AND product_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS ix_purchase_receipt_lines_purchase
    ON tenant.purchase_receipt_lines (cabinet_id, purchase_id);

DO $$
DECLARE t TEXT := 'purchase_receipt_lines';
BEGIN
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
END $$;

COMMIT;
```

Перед применением проверить, что `saas_ro` видит новую таблицу (у роли `BYPASSRLS`; если в кластере для неё нет default privileges на `tenant`, добавить в DO-блок `GRANT SELECT ON tenant.%I TO saas_ro` и `saas_triage`). Проверка: `psql -h localhost -U saas_ro -d saas -Atc "select has_table_privilege('saas_ro','tenant.purchases','select')"` и `grep -n "DEFAULT PRIVILEGES" db/ops/saas_ro_role.sql db/ops/saas_triage_role.sql`.

- [ ] **Step 2: Применить и применить повторно (идемпотентность)**

```bash
cd /opt/agents/saas
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/069_purchase_receipts.sql
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/069_purchase_receipts.sql
```
Expected: оба прогона `COMMIT` без ошибок.

- [ ] **Step 3: Проверить данные**

```bash
psql -h localhost -U saas_ro -d saas -Atc "select count(*), count(delivered_at) from tenant.purchases where cabinet_id=1 and archived and deleted_at is null; select count(*) from tenant.purchase_receipt_lines"
```
Expected: `12|12` (или равные числа), `0`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/069_purchase_receipts.sql
git commit -m "feat(deliveries): миграция 069 — приёмка партий закупки по артикулам

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Чистые функции `lib/deliveries.js`

**Files:**
- Create: `lib/deliveries.js`
- Test: `lib/__tests__/deliveries.test.mjs`

**Interfaces:**
- Produces:
  - `receiptTotals(purchase: {qty}, lines: [{qty_accepted}]) → { ordered: int, accepted: int, diff: int }`
  - `receiptStatus(purchase: {receipt_done_at}) → 'waiting' | 'done'`
  - `validateLine(raw) → { ok: true, line: { platform, nm_id, product_id, label, qty_accepted, note } } | { ok: false, error: string }`
  - `buildDeliveries(purchases: [{id, supplier_name, category, qty, photo_url, im_url, delivered_at, receipt_done_at}], lines: [{id, purchase_id, …}]) → { items: [{ id, name, category, photo, delivered_at, receipt_done_at, status, ordered, accepted, diff, lines }], totals: { waiting, done } }` (порядок `purchases` сохраняется)
  - `filterDeliveries(items, { status: 'waiting'|'done'|'all', q: string }) → items`

- [ ] **Step 1: Написать падающие тесты**

```js
// lib/__tests__/deliveries.test.mjs — «Доставлено на склад» (15.10.2026).
import test from "node:test";
import assert from "node:assert/strict";
import { receiptTotals, receiptStatus, validateLine, buildDeliveries, filterDeliveries } from "../deliveries.js";

test("receiptTotals: заказано / принято / расхождение", () => {
  assert.deepEqual(receiptTotals({ qty: "510" }, [{ qty_accepted: 250 }, { qty_accepted: 255 }]),
    { ordered: 510, accepted: 505, diff: -5 });
  assert.deepEqual(receiptTotals({ qty: null }, []), { ordered: 0, accepted: 0, diff: 0 });
  assert.deepEqual(receiptTotals({ qty: 10 }, [{ qty_accepted: 12 }]), { ordered: 10, accepted: 12, diff: 2 });
});

test("receiptStatus", () => {
  assert.equal(receiptStatus({ receipt_done_at: null }), "waiting");
  assert.equal(receiptStatus({ receipt_done_at: "2026-10-15T10:00:00Z" }), "done");
});

test("validateLine: каталог WB", () => {
  const r = validateLine({ platform: "wb", nm_id: "123", label: " Камера ", qty_accepted: "5", note: "" });
  assert.deepEqual(r, { ok: true, line: { platform: "wb", nm_id: 123, product_id: null, label: "Камера", qty_accepted: 5, note: null } });
});

test("validateLine: каталог Ozon и ручной ввод", () => {
  assert.equal(validateLine({ platform: "ozon", product_id: 77, label: "Рег", qty_accepted: 0 }).line.product_id, 77);
  const m = validateLine({ platform: "", label: "сердечко белое S", qty_accepted: 3, note: " брак 1 " });
  assert.deepEqual(m.line, { platform: null, nm_id: null, product_id: null, label: "сердечко белое S", qty_accepted: 3, note: "брак 1" });
});

test("validateLine: ошибки", () => {
  assert.equal(validateLine({ label: "x", qty_accepted: -1 }).ok, false);
  assert.equal(validateLine({ label: "x", qty_accepted: 1.5 }).ok, false);
  assert.equal(validateLine({ label: "x", qty_accepted: "" }).ok, false);
  assert.equal(validateLine({ label: "  ", qty_accepted: 1 }).ok, false);
  assert.equal(validateLine({ platform: "wb", label: "x", qty_accepted: 1 }).ok, false);   // нет nm_id
  assert.equal(validateLine({ platform: "ozon", product_id: 0, label: "x", qty_accepted: 1 }).ok, false);
  assert.equal(validateLine({ platform: "ali", label: "x", qty_accepted: 1 }).ok, false);
  assert.equal(validateLine({ label: "x".repeat(301), qty_accepted: 1 }).ok, false);
});

test("buildDeliveries: группировка строк, итоги, счётчики, фото", () => {
  const purchases = [
    { id: 2, supplier_name: "Сердечко", category: "Бельё", qty: 510, photo_url: null, im_url: "wb.jpg", delivered_at: "2026-10-10", receipt_done_at: null },
    { id: 1, supplier_name: "Камера", category: null, qty: 100, photo_url: "own.jpg", im_url: "wb2.jpg", delivered_at: "2026-10-01", receipt_done_at: "2026-10-05T00:00:00Z" },
  ];
  const lines = [
    { id: 10, purchase_id: 2, qty_accepted: 250, label: "белое" },
    { id: 11, purchase_id: 1, qty_accepted: 100, label: "кам" },
    { id: 12, purchase_id: 2, qty_accepted: 255, label: "чёрное" },
  ];
  const { items, totals } = buildDeliveries(purchases, lines);
  assert.deepEqual(items.map((i) => i.id), [2, 1]);
  assert.deepEqual(items[0].lines.map((l) => l.id), [10, 12]);
  assert.equal(items[0].accepted, 505);
  assert.equal(items[0].diff, -5);
  assert.equal(items[0].status, "waiting");
  assert.equal(items[0].photo, "wb.jpg");
  assert.equal(items[1].photo, "own.jpg");
  assert.equal(items[1].name, "Камера");
  assert.deepEqual(totals, { waiting: 1, done: 1 });
});

test("filterDeliveries: статус и поиск по партии и строкам", () => {
  const items = [
    { id: 1, name: "Сердечко", status: "waiting", lines: [{ label: "белое S" }] },
    { id: 2, name: "Камера", status: "done", lines: [] },
  ];
  assert.deepEqual(filterDeliveries(items, { status: "waiting" }).map((i) => i.id), [1]);
  assert.deepEqual(filterDeliveries(items, { status: "all", q: "БЕЛОЕ" }).map((i) => i.id), [1]);
  assert.deepEqual(filterDeliveries(items, { status: "all", q: "кам" }).map((i) => i.id), [2]);
  assert.equal(filterDeliveries(items, {}).length, 2);
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test lib/__tests__/deliveries.test.mjs`
Expected: FAIL — `Cannot find module '../deliveries.js'`.

- [ ] **Step 3: Реализация**

```js
// lib/deliveries.js — «Доставлено на склад» (15.10.2026, спека
// docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md). Чистые функции, без БД.
// Партия — tenant.purchases (archived), приёмка — tenant.purchase_receipt_lines.
// Конечная точка: эти цифры ни в остатки, ни в себестоимость не уходят.

const LABEL_MAX = 300;
const int = (v) => Math.round(Number(v) || 0);

export function receiptTotals(purchase, lines) {
  const ordered = int(purchase?.qty);
  const accepted = (lines || []).reduce((s, l) => s + int(l.qty_accepted), 0);
  return { ordered, accepted, diff: accepted - ordered };
}

export function receiptStatus(purchase) {
  return purchase?.receipt_done_at ? "done" : "waiting";
}

const posInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function validateLine(raw) {
  const platform = raw?.platform ? String(raw.platform) : null;
  if (platform && platform !== "wb" && platform !== "ozon") return { ok: false, error: "площадка: wb, ozon или пусто" };
  const label = String(raw?.label ?? "").trim();
  if (!label) return { ok: false, error: "укажите артикул или название" };
  if (label.length > LABEL_MAX) return { ok: false, error: `название длиннее ${LABEL_MAX} символов` };
  const q = raw?.qty_accepted;
  const qty = q === "" || q == null ? NaN : Number(q);
  if (!Number.isInteger(qty) || qty < 0) return { ok: false, error: "принято — целое число ≥ 0" };
  let nm_id = null, product_id = null;
  if (platform === "wb") {
    nm_id = posInt(raw?.nm_id);
    if (!nm_id) return { ok: false, error: "нет артикула WB (nm_id)" };
  } else if (platform === "ozon") {
    product_id = posInt(raw?.product_id);
    if (!product_id) return { ok: false, error: "нет товара Ozon (product_id)" };
  }
  const note = String(raw?.note ?? "").trim() || null;
  return { ok: true, line: { platform, nm_id, product_id, label, qty_accepted: qty, note } };
}

export function buildDeliveries(purchases, lines) {
  const byPurchase = new Map();
  for (const l of lines || []) {
    const k = Number(l.purchase_id);
    if (!byPurchase.has(k)) byPurchase.set(k, []);
    byPurchase.get(k).push(l);
  }
  const totals = { waiting: 0, done: 0 };
  const items = (purchases || []).map((p) => {
    const ls = byPurchase.get(Number(p.id)) || [];
    const status = receiptStatus(p);
    totals[status]++;
    return {
      id: Number(p.id),
      name: p.supplier_name || `Партия #${p.id}`,
      category: p.category || null,
      photo: p.photo_url || p.im_url || null,
      delivered_at: p.delivered_at || null,
      receipt_done_at: p.receipt_done_at || null,
      status,
      ...receiptTotals(p, ls),
      lines: ls,
    };
  });
  return { items, totals };
}

export function filterDeliveries(items, { status = "all", q = "" } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  return (items || []).filter((it) => {
    if ((status === "waiting" || status === "done") && it.status !== status) return false;
    if (!needle) return true;
    if (String(it.name || "").toLowerCase().includes(needle)) return true;
    return (it.lines || []).some((l) => String(l.label || "").toLowerCase().includes(needle));
  });
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `node --test lib/__tests__/deliveries.test.mjs`
Expected: PASS, все 7 тестов.

- [ ] **Step 5: Commit**

```bash
git add lib/deliveries.js lib/__tests__/deliveries.test.mjs
git commit -m "feat(deliveries): расчёт приёмки партий (итоги, статус, валидация строки)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: «✓ Доставлено» в закупках — без записи на склад

**Files:**
- Modify: `app/api/cabinets/[id]/purchases/route.js` (блок `if (b.action === "complete_to_stock")`, ~строки 216–285)
- Modify: `app/cabinets/[id]/fin-purchases/PurchasesPage.jsx` (функция `completeToStock` ~136–150, кнопка ~411)
- Test: `lib/__tests__/deliveriesGuard.test.mjs`

**Interfaces:**
- Consumes: колонка `tenant.purchases.delivered_at` (Task 1).
- Produces: POST `{action:"complete_to_stock", id}` → `{ ok: true, delivered_at }`; ставит `archived=true`, `delivered_at`; НЕ пишет `ff_inventory`, `ff_inventory_skus`, `stock_moves`.

- [ ] **Step 1: Падающий гард**

```js
// lib/__tests__/deliveriesGuard.test.mjs — «✓ Доставлено» — конечная точка (спека 2026-10-15 §2.3):
// complete_to_stock больше не пишет в остатки склада/ФФ и журнал движений.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../app/api/cabinets/[id]/purchases/route.js", import.meta.url), "utf8");

function block(action) {
  const start = src.indexOf(`b.action === "${action}"`);
  assert.ok(start > 0, `нет блока ${action}`);
  // блок заканчивается на первом «return NextResponse.json({ ok: true» после начала
  const end = src.indexOf("return NextResponse.json({ ok: true", start);
  assert.ok(end > start, "нет успешного ответа в блоке");
  return src.slice(start, end);
}

test("complete_to_stock не трогает ff_inventory / ff_inventory_skus / applyMove", () => {
  const b = block("complete_to_stock");
  assert.ok(!/ff_inventory/.test(b), "блок пишет в ff_inventory");
  assert.ok(!/applyMove/.test(b), "блок вызывает applyMove");
  assert.ok(/delivered_at/.test(b), "блок не ставит delivered_at");
  assert.ok(/archived\s*=\s*true/.test(b), "блок не архивирует партию");
});
```

Run: `node --test lib/__tests__/deliveriesGuard.test.mjs`
Expected: FAIL — «блок пишет в ff_inventory».

- [ ] **Step 2: Бэкап и правка роута**

```bash
cp "app/api/cabinets/[id]/purchases/route.js" /opt/agentsDB/backups/purchases.route.js.$(date +%Y%m%d_%H%M%S).bak
cp "app/cabinets/[id]/fin-purchases/PurchasesPage.jsx" /opt/agentsDB/backups/PurchasesPage.jsx.$(date +%Y%m%d_%H%M%S).bak
```

Заменить весь блок `if (b.action === "complete_to_stock") { … }` (от комментария «Завершить закупку → скопировать партию в склад» до закрывающей `}` после `return NextResponse.json({ ok: true, inventory_id: invId, unit_cost: unitCost });`) на:

```js
  // «✓ Доставлено» (с 15.10.2026, спека 2026-10-15-delivered-to-stock-design.md): партия
  // уходит из активных закупок на страницу «Доставлено на склад» и ждёт приёмки ФФ по
  // артикулам. Конечная точка: в ff_inventory / журнал движений / себестоимость НЕ пишем
  // (до 15.10 здесь создавалась позиция «Остатков склад/ФФ» и движение «in»).
  if (b.action === "complete_to_stock") {
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const cur = (await tenantQuery(
      `SELECT id, archived, delivery_dt FROM tenant.purchases
       WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [Number(b.id)]
    ))[0];
    if (!cur) return NextResponse.json({ error: `партия id=${b.id} не найдена` }, { status: 404 });
    if (cur.archived) return NextResponse.json({ error: "партия уже доставлена" }, { status: 400 });
    const deliveredAt = cur.delivery_dt ? String(cur.delivery_dt).slice(0, 10)
      : new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
    await tenantQuery(
      `UPDATE tenant.purchases SET archived = true, delivered_at = $2::date WHERE id = $1`,
      [Number(b.id), deliveredAt]
    );
    return NextResponse.json({ ok: true, delivered_at: deliveredAt });
  }
```

Внимание: `delivery_dt` в БД может быть `date` или `text` — `String(...).slice(0,10)` покрывает оба; если node-pg вернёт `Date`, `String(Date)` не ISO — проверить тип: `psql -h localhost -U saas_ro -d saas -Atc "select data_type from information_schema.columns where table_schema='tenant' and table_name='purchases' and column_name='delivery_dt'"`. Если `date` — использовать в SQL `COALESCE(delivery_dt, $2::date)` вместо JS-вычисления:

```js
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
    const upd = await tenantQuery(
      `UPDATE tenant.purchases SET archived = true, delivered_at = COALESCE(delivery_dt::date, $2::date)
       WHERE id = $1 RETURNING delivered_at::text AS delivered_at`, [Number(b.id), today]
    );
    return NextResponse.json({ ok: true, delivered_at: upd[0]?.delivered_at || today });
```
(этот вариант годится для обоих типов — предпочесть его.)

После правки удалить ставшие неиспользуемыми импорты, только если их больше нигде в файле нет: `grep -n "applyMove\|DatabaseSync\|computeExcel" "app/api/cabinets/[id]/purchases/route.js"`.

- [ ] **Step 3: Правка UI закупок**

В `PurchasesPage.jsx` функция `completeToStock`:

```js
  // «✓ Доставлено» → партия уходит на страницу «Доставлено на склад» (ждёт приёмки ФФ).
  async function completeToStock(it) {
    if (!confirm(`Партия «${it.supplier_name || "#" + it.id}» доставлена на склад?\n` +
      `Она скроется из активных закупок и появится в «Доставлено на склад» — там отметите приёмку по артикулам.`)) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete_to_stock", id: it.id }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не отметилось: " + (d.error || "")); return; }
    if (expanded === it.id) setExpanded(null);
    reload();
  }
```

Кнопка (строка ~411): `title="Доставлено на склад → ждёт приёмки ФФ"` и текст `✓ Доставлено`.
Найти прочие упоминания: `grep -n "склад/ФФ\|Остатки склад" "app/cabinets/[id]/fin-purchases/PurchasesPage.jsx"` — в подписях, относящихся к этой кнопке/архиву, заменить на «Доставлено на склад».

- [ ] **Step 4: Гард и тесты зелёные**

Run: `node --test lib/__tests__/deliveriesGuard.test.mjs lib/__tests__/roleGuards.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/api/cabinets/[id]/purchases/route.js" "app/cabinets/[id]/fin-purchases/PurchasesPage.jsx" lib/__tests__/deliveriesGuard.test.mjs
git commit -m "feat(purchases): «✓ Доставлено» — партия уходит в «Доставлено на склад», склад/ФФ не трогаем

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: API `deliveries`

**Files:**
- Create: `app/api/cabinets/[id]/deliveries/route.js`
- Modify: `lib/__tests__/roleGuards.test.mjs` (добавить `"deliveries"` в массив `MANAGER_FIN`)

**Interfaces:**
- Consumes: `buildDeliveries`, `filterDeliveries`, `validateLine` из `@/lib/deliveries.js` (Task 2); таблицы Task 1.
- Produces:
  - GET `?status=&q=` → `{ items, totals, role }` (items — из `buildDeliveries`, после `filterDeliveries`; `totals` — по всем, до фильтра).
  - GET `?catalog=1&q=` → `{ catalog: [{ platform:'wb', nm_id, label, im_url, article:null } | { platform:'ozon', product_id, label, im_url, article: offer_id }] }` (≤ 20).
  - POST `line_add {purchase_id, platform?, nm_id?, product_id?, label?, qty_accepted, note?}` → `{ ok, line }`
  - POST `line_update {id, qty_accepted?, note?, label?}` → `{ ok, line }`
  - POST `line_delete {id}` → `{ ok }`
  - POST `done {purchase_id}` → `{ ok }`; `undone {purchase_id}` (owner) → `{ ok }`; `return_to_purchases {purchase_id}` → `{ ok }`.

- [ ] **Step 1: Гард ролей — падающий**

В `lib/__tests__/roleGuards.test.mjs` в `MANAGER_FIN` добавить `"deliveries"`.
Run: `node --test lib/__tests__/roleGuards.test.mjs`
Expected: FAIL — «нет роута deliveries».

- [ ] **Step 2: Написать роут**

```js
// /api/cabinets/[id]/deliveries — «Доставлено на склад» (15.10.2026, спека
// docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md).
// GET ?status=waiting|done|all &q= → { items, totals, role } — доставленные партии закупки
//   (tenant.purchases archived) со строками приёмки (tenant.purchase_receipt_lines).
// GET ?catalog=1&q= → { catalog } — поиск артикула WB/Ozon для строки приёмки.
// POST (manager): line_add | line_update | line_delete | done | undone (owner) | return_to_purchases.
// Конечная точка: в остатки, журнал движений и себестоимость НЕ пишем.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { buildDeliveries, filterDeliveries, validateLine } from "@/lib/deliveries.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error, status = 400) => NextResponse.json({ error }, { status });

async function loadCatalog(q) {
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

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  if (url.searchParams.get("catalog") === "1") {
    return NextResponse.json({ catalog: await loadCatalog(url.searchParams.get("q")) });
  }
  const purchases = await tenantQuery(
    `SELECT p.id, p.supplier_name, p.category, p.qty, p.photo_url, a.im_url,
            p.delivered_at::text AS delivered_at, p.receipt_done_at
     FROM tenant.purchases p
     LEFT JOIN tenant.wb_articles a ON a.cabinet_id = p.cabinet_id AND a.nm_id = p.nm_id
     WHERE p.archived AND p.deleted_at IS NULL
     ORDER BY (p.receipt_done_at IS NOT NULL), p.delivered_at DESC NULLS LAST, p.id DESC`, []);
  const lines = await tenantQuery(
    `SELECT l.id, l.purchase_id, l.platform, l.nm_id, l.product_id, l.label, l.qty_accepted, l.note,
            COALESCE(a.im_url, o.im_url) AS im_url, o.offer_id AS article
     FROM tenant.purchase_receipt_lines l
     LEFT JOIN tenant.wb_articles a ON l.platform = 'wb' AND a.cabinet_id = l.cabinet_id AND a.nm_id = l.nm_id
     LEFT JOIN tenant.ozon_products o ON l.platform = 'ozon' AND o.cabinet_id = l.cabinet_id AND o.product_id = l.product_id
     ORDER BY l.purchase_id, l.id`, []);
  const { items, totals } = buildDeliveries(purchases, lines);
  const filtered = filterDeliveries(items, { status: url.searchParams.get("status") || "all", q: url.searchParams.get("q") || "" });
  return NextResponse.json({ items: filtered, totals, role: cabinet.role });
});

// Партия под блокировкой; null — нет такой доставленной партии.
async function lockPurchase(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return (await tenantQuery(
    `SELECT id, archived, receipt_done_at FROM tenant.purchases
     WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [n]))[0] || null;
}

async function catalogLabel(line) {
  if (line.platform === "wb") {
    const r = (await tenantQuery(`SELECT name FROM tenant.wb_articles WHERE nm_id = $1`, [Number(line.nm_id)]))[0];
    return r?.name || null;
  }
  if (line.platform === "ozon") {
    const r = (await tenantQuery(`SELECT name FROM tenant.ozon_products WHERE product_id = $1`, [Number(line.product_id)]))[0];
    return r?.name || null;
  }
  return null;
}

const LINE_COLS = `id, purchase_id, platform, nm_id, product_id, label, qty_accepted, note`;

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  const action = b?.action;

  if (action === "line_add") {
    const p = await lockPurchase(b.purchase_id);
    if (!p || !p.archived) return bad("партия не найдена среди доставленных", 404);
    if (p.receipt_done_at) return bad("партия закрыта, снимите отметку «Учтено по артикулам»");
    const raw = { ...b };
    if (raw.platform && !String(raw.label || "").trim()) raw.label = await catalogLabel(raw) || "";
    const v = validateLine(raw);
    if (!v.ok) return bad(v.error);
    const l = v.line;
    const ins = await tenantQuery(
      `INSERT INTO tenant.purchase_receipt_lines
         (cabinet_id, purchase_id, platform, nm_id, product_id, label, qty_accepted, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7)
       RETURNING ${LINE_COLS}`,
      [p.id, l.platform, l.nm_id, l.product_id, l.label, l.qty_accepted, l.note]);
    return NextResponse.json({ ok: true, line: ins[0] });
  }

  if (action === "line_update" || action === "line_delete") {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return bad("id required");
    const cur = (await tenantQuery(`SELECT ${LINE_COLS} FROM tenant.purchase_receipt_lines WHERE id = $1`, [id]))[0];
    if (!cur) return bad(`строка id=${id} не найдена`, 404);
    const p = await lockPurchase(cur.purchase_id);
    if (!p) return bad("партия не найдена", 404);
    if (p.receipt_done_at) return bad("партия закрыта, снимите отметку «Учтено по артикулам»");
    if (action === "line_delete") {
      await tenantQuery(`DELETE FROM tenant.purchase_receipt_lines WHERE id = $1`, [id]);
      return NextResponse.json({ ok: true });
    }
    const v = validateLine({
      ...cur,
      qty_accepted: b.qty_accepted !== undefined ? b.qty_accepted : cur.qty_accepted,
      note: b.note !== undefined ? b.note : cur.note,
      label: b.label !== undefined ? b.label : cur.label,
    });
    if (!v.ok) return bad(v.error);
    const upd = await tenantQuery(
      `UPDATE tenant.purchase_receipt_lines SET qty_accepted = $2, note = $3, label = $4, updated_at = now()
       WHERE id = $1 RETURNING ${LINE_COLS}`, [id, v.line.qty_accepted, v.line.note, v.line.label]);
    return NextResponse.json({ ok: true, line: upd[0] });
  }

  if (action === "done" || action === "undone" || action === "return_to_purchases") {
    const p = await lockPurchase(b.purchase_id);
    if (!p || !p.archived) return bad("партия не найдена среди доставленных", 404);
    const [{ n }] = await tenantQuery(
      `SELECT count(*)::int AS n FROM tenant.purchase_receipt_lines WHERE purchase_id = $1`, [p.id]);
    if (action === "done") {
      if (p.receipt_done_at) return bad("партия уже учтена");
      if (!n) return bad("добавьте хотя бы одну строку приёмки");
      await tenantQuery(`UPDATE tenant.purchases SET receipt_done_at = now(), receipt_done_by = $2 WHERE id = $1`,
        [p.id, session?.user_id ?? null]);
      return NextResponse.json({ ok: true });
    }
    if (action === "undone") {
      if (cabinet.role !== "owner") return bad("снять отметку может только владелец", 403);
      if (!p.receipt_done_at) return bad("партия ещё не учтена");
      await tenantQuery(`UPDATE tenant.purchases SET receipt_done_at = NULL, receipt_done_by = NULL WHERE id = $1`, [p.id]);
      return NextResponse.json({ ok: true });
    }
    // return_to_purchases
    if (p.receipt_done_at || n) return bad("у партии уже есть приёмка — сначала удалите строки");
    await tenantQuery(`UPDATE tenant.purchases SET archived = false, delivered_at = NULL WHERE id = $1`, [p.id]);
    return NextResponse.json({ ok: true });
  }

  return bad("неизвестное действие");
}, { requireRole: "manager" });
```

Перед кодом проверить, как `withCabinet` отдаёт роль: `grep -n "role" lib/withCabinet.js | sed -n 1,40p` — в контексте должен быть `cabinet.role` (используется в `app/api/cabinets/[id]/bonus/route.js:26`). Если имя иное — использовать его.

- [ ] **Step 3: Гард ролей зелёный**

Run: `node --test lib/__tests__/roleGuards.test.mjs lib/__tests__/deliveries.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "app/api/cabinets/[id]/deliveries/route.js" lib/__tests__/roleGuards.test.mjs
git commit -m "feat(deliveries): API приёмки доставленных партий (строки, отметка, возврат в закупки)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Страница «Доставлено на склад» и меню

**Files:**
- Create: `app/cabinets/[id]/deliveries/page.js`
- Create: `app/cabinets/[id]/deliveries/DeliveriesPage.jsx`
- Create: `app/cabinets/[id]/deliveries/ReceiptPanel.jsx`
- Modify: `app/cabinets/[id]/layout.js` (группа «Товары»: `{ href: "/warehouses", label: "Склады" }`)

**Interfaces:**
- Consumes: GET/POST `/api/cabinets/${cabinetId}/deliveries` (Task 4).
- Produces: `<DeliveriesPage cabinetId />`, `<ReceiptPanel cabinetId item role onChanged />`.

- [ ] **Step 1: page.js**

```js
import DeliveriesPage from "./DeliveriesPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <DeliveriesPage cabinetId={Number(params.id)} />;
}
```

- [ ] **Step 2: DeliveriesPage.jsx**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useState } from "react";
import ReceiptPanel from "./ReceiptPanel";

// /cabinets/[id]/deliveries — «Доставлено на склад» (15.10.2026, спека
// docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md): партии из «Закупок» после
// «✓ Доставлено» → приёмка ФФ по артикулам → «✓ Учтено по артикулам». Конечная точка.

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const ddmmyyyy = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const FILTERS = [{ v: "waiting", l: "Ждут приёмки" }, { v: "done", l: "Учтено" }, { v: "all", l: "Все" }];

export default function DeliveriesPage({ cabinetId }) {
  const [status, setStatus] = useState("waiting");
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/deliveries?status=${status}&q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d); setErr(null);
    } catch (e) { console.error("deliveries load", e); setErr(String(e.message || e)); }
  }, [cabinetId, status, q]);

  useEffect(() => { reload(); }, [reload]);

  const items = data?.items || [];
  const totals = data?.totals || { waiting: 0, done: 0 };

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>Доставлено на склад</h1>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 16 }}>
        Партии из «Закупок», доставленные на фулфилмент. После приёмки ФФ внесите, сколько принято по каждому
        артикулу, и отметьте «Учтено по артикулам». Эти цифры никуда дальше не передаются.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button key={f.v} onClick={() => setStatus(f.v)}
            style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13,
              border: `1px solid ${status === f.v ? C.accent : C.line}`,
              background: status === f.v ? soft("accent", 15) : "transparent", color: C.ink }}>
            {f.l}{f.v === "waiting" ? ` · ${totals.waiting}` : f.v === "done" ? ` · ${totals.done}` : ""}
          </button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по партии или артикулу"
          style={{ marginLeft: "auto", padding: "6px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
            background: C.surface, color: C.ink, minWidth: 260 }} />
      </div>
      {err && <div style={{ color: C.neg, marginBottom: 12 }}>Ошибка: {err}</div>}
      {!data && !err && <div style={{ color: C.muted }}>Загрузка…</div>}
      {data && !items.length && <div style={{ color: C.muted }}>Нет партий по фильтру.</div>}
      {items.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: C.muted, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={{ padding: 8, width: 48 }} />
              <th style={{ padding: 8 }}>Партия</th>
              <th style={{ padding: 8 }}>Категория</th>
              <th style={{ padding: 8 }}>Доставлено</th>
              <th style={{ padding: 8, textAlign: "right" }}>Заказано</th>
              <th style={{ padding: 8, textAlign: "right" }}>Принято</th>
              <th style={{ padding: 8, textAlign: "right" }}>Расхождение</th>
              <th style={{ padding: 8 }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <Row key={it.id} it={it} open={open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)}
                cabinetId={cabinetId} role={data.role} onChanged={reload} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Row({ it, open, onToggle, cabinetId, role, onChanged }) {
  const done = it.status === "done";
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer", borderBottom: `1px solid ${soft("line", 50)}`,
        background: open ? soft("accent", 6) : "transparent" }}>
        <td style={{ padding: 8 }}>
          {it.photo ? <img src={it.photo} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6 }} /> : null}
        </td>
        <td style={{ padding: 8, fontWeight: 500 }}>{it.name}</td>
        <td style={{ padding: 8, color: C.muted }}>{it.category || "—"}</td>
        <td style={{ padding: 8 }}>{ddmmyyyy(it.delivered_at)}</td>
        <td style={{ padding: 8, textAlign: "right" }}>{nf0.format(it.ordered)}</td>
        <td style={{ padding: 8, textAlign: "right" }}>{it.lines.length ? nf0.format(it.accepted) : "—"}</td>
        <td style={{ padding: 8, textAlign: "right", color: it.lines.length && it.diff !== 0 ? C.neg : C.muted }}>
          {it.lines.length ? (it.diff > 0 ? "+" : "") + nf0.format(it.diff) : "—"}
        </td>
        <td style={{ padding: 8 }}>
          <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12,
            background: soft(done ? "pos" : "warn", 18), color: done ? C.pos : C.warn }}>
            {done ? "✓ Учтено по артикулам" : "Ждёт приёмки"}
          </span>
        </td>
      </tr>
      {open && (
        <tr><td colSpan={8} style={{ padding: "8px 8px 16px 56px", background: soft("accent", 4) }}>
          <ReceiptPanel cabinetId={cabinetId} item={it} role={role} onChanged={onChanged} />
        </td></tr>
      )}
    </>
  );
}
```

Перед записью сверить имена токенов палитры: `grep -n "muted\|accent\|warn\|pos\|neg\|surface\|ink\|line" lib/palette.js | head -30` — использовать только существующие ключи `C` и имена токенов `soft()`.

- [ ] **Step 3: ReceiptPanel.jsx**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState } from "react";

// Панель приёмки партии: строки «артикул → принято, шт», выбор артикула из каталога WB/Ozon
// или вручную, итог и отметка «Учтено по артикулам». У закрытой — только чтение.

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const inp = { padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
const btn = { padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.ink, cursor: "pointer", fontSize: 13 };

export default function ReceiptPanel({ cabinetId, item, role, onChanged }) {
  const done = item.status === "done";
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(null); // { platform, nm_id|product_id, label } | { platform: null }
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [manual, setManual] = useState("");
  const [search, setSearch] = useState("");
  const [found, setFound] = useState([]);

  useEffect(() => {
    if (done || search.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/deliveries?catalog=1&q=${encodeURIComponent(search.trim())}`);
        const d = await r.json();
        setFound(d.catalog || []);
      } catch (e) { console.error("deliveries catalog", e); setFound([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [cabinetId, search, done]);

  async function post(body) {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/deliveries`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert(d.error || `Ошибка ${r.status}`); return false; }
      await onChanged();
      return true;
    } catch (e) { console.error("deliveries post", e); alert(String(e.message || e)); return false; }
    finally { setBusy(false); }
  }

  async function addLine() {
    if (!pick) { alert("Выберите артикул из каталога или «другое»"); return; }
    const body = { action: "line_add", purchase_id: item.id, qty_accepted: qty, note,
      platform: pick.platform || null, nm_id: pick.nm_id, product_id: pick.product_id,
      label: pick.platform ? pick.label : manual };
    if (await post(body)) { setPick(null); setQty(""); setNote(""); setManual(""); setSearch(""); }
  }

  async function editQty(l) {
    const v = prompt(`Принято, шт — «${l.label}»`, String(l.qty_accepted));
    if (v == null) return;
    await post({ action: "line_update", id: l.id, qty_accepted: v.trim() });
  }

  async function markDone() {
    const msg = item.diff !== 0
      ? `Принято ${nf0.format(item.accepted)} из ${nf0.format(item.ordered)} (расхождение ${item.diff > 0 ? "+" : ""}${nf0.format(item.diff)}). Отметить «Учтено по артикулам»?`
      : "Отметить «Учтено по артикулам»? Строки станут только для чтения.";
    if (confirm(msg)) await post({ action: "done", purchase_id: item.id });
  }

  return (
    <div style={{ fontSize: 13 }}>
      {item.lines.length > 0 ? (
        <table style={{ borderCollapse: "collapse", marginBottom: 10, minWidth: 560 }}>
          <thead><tr style={{ color: C.muted, textAlign: "left" }}>
            <th style={{ padding: "4px 8px" }}>Артикул</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }}>Принято, шт</th>
            <th style={{ padding: "4px 8px" }}>Примечание</th>
            <th />
          </tr></thead>
          <tbody>
            {item.lines.map((l) => (
              <tr key={l.id} style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: "4px 8px" }}>
                  {l.im_url ? <img src={l.im_url} alt="" style={{ width: 24, height: 24, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} /> : null}
                  {l.label}
                  <span style={{ color: C.muted, marginLeft: 6 }}>
                    {l.platform === "wb" ? `WB ${l.nm_id}` : l.platform === "ozon" ? `Ozon ${l.article || l.product_id}` : "вручную"}
                  </span>
                </td>
                <td style={{ padding: "4px 8px", textAlign: "right" }}>
                  {done ? nf0.format(l.qty_accepted)
                    : <button style={btn} disabled={busy} onClick={() => editQty(l)}>{nf0.format(l.qty_accepted)} ✏️</button>}
                </td>
                <td style={{ padding: "4px 8px", color: C.muted }}>{l.note || ""}</td>
                <td style={{ padding: "4px 8px" }}>
                  {!done && <button style={{ ...btn, color: C.neg }} disabled={busy}
                    onClick={() => confirm(`Удалить строку «${l.label}»?`) && post({ action: "line_delete", id: l.id })}>✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div style={{ color: C.muted, marginBottom: 10 }}>Строк приёмки ещё нет.</div>}

      <div style={{ marginBottom: 12 }}>
        Итого: принято <b>{nf0.format(item.accepted)}</b> из {nf0.format(item.ordered)}
        {item.lines.length > 0 && (
          <span style={{ color: item.diff !== 0 ? C.neg : C.pos, marginLeft: 8 }}>
            расхождение {item.diff > 0 ? "+" : ""}{nf0.format(item.diff)}
          </span>
        )}
      </div>

      {!done && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 12 }}>
          <div style={{ position: "relative" }}>
            {pick ? (
              <div style={{ ...inp, display: "flex", gap: 6, alignItems: "center", minWidth: 260 }}>
                {pick.platform
                  ? <span>{pick.label} <span style={{ color: C.muted }}>{pick.platform === "wb" ? `WB ${pick.nm_id}` : `Ozon ${pick.article || pick.product_id}`}</span></span>
                  : <input autoFocus value={manual} onChange={(e) => setManual(e.target.value)} placeholder="артикул / название из акта"
                      style={{ border: "none", background: "transparent", color: C.ink, outline: "none", minWidth: 220 }} />}
                <button style={{ ...btn, padding: "0 6px" }} onClick={() => { setPick(null); setManual(""); }}>×</button>
              </div>
            ) : (
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Артикул: поиск WB/Ozon"
                style={{ ...inp, minWidth: 260 }} />
            )}
            {!pick && search.trim().length >= 2 && (
              <div style={{ position: "absolute", zIndex: 5, top: "100%", left: 0, right: 0, marginTop: 2, maxHeight: 260, overflowY: "auto",
                background: C.surface, border: `1px solid ${C.line}`, borderRadius: 6 }}>
                {found.map((f) => (
                  <div key={`${f.platform}:${f.nm_id || f.product_id}`} onClick={() => setPick(f)}
                    style={{ padding: "5px 8px", cursor: "pointer", display: "flex", gap: 6, alignItems: "center" }}>
                    {f.im_url ? <img src={f.im_url} alt="" style={{ width: 24, height: 24, objectFit: "cover", borderRadius: 4 }} /> : null}
                    <span>{f.label}</span>
                    <span style={{ color: C.muted, marginLeft: "auto" }}>{f.platform === "wb" ? `WB ${f.nm_id}` : `Ozon ${f.article || f.product_id}`}</span>
                  </div>
                ))}
                <div onClick={() => setPick({ platform: null })}
                  style={{ padding: "5px 8px", cursor: "pointer", color: C.accent, borderTop: `1px solid ${soft("line", 50)}` }}>
                  другое — ввести вручную
                </div>
              </div>
            )}
          </div>
          <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="принято, шт" inputMode="numeric" style={{ ...inp, width: 110 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="примечание (брак, недостача)" style={{ ...inp, minWidth: 220 }} />
          <button style={btn} disabled={busy} onClick={addLine}>+ Добавить</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        {!done && <button style={{ ...btn, borderColor: C.pos, color: C.pos }} disabled={busy || !item.lines.length} onClick={markDone}>✓ Учтено по артикулам</button>}
        {!done && !item.lines.length && <button style={btn} disabled={busy}
          onClick={() => confirm("Вернуть партию в активные закупки?") && post({ action: "return_to_purchases", purchase_id: item.id })}>↩ Вернуть в закупки</button>}
        {done && role === "owner" && <button style={btn} disabled={busy}
          onClick={() => confirm("Снять отметку «Учтено по артикулам»? Строки снова можно будет править.") && post({ action: "undone", purchase_id: item.id })}>Снять отметку</button>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Меню**

```bash
cp "app/cabinets/[id]/layout.js" /opt/agentsDB/backups/layout.js.$(date +%Y%m%d_%H%M%S).bak
```
В `app/cabinets/[id]/layout.js` заменить строку `{ href: "/warehouses", label: "Склады" },` на `{ href: "/deliveries", label: "Доставлено на склад" },`. Роут `/warehouses` не удалять (на него ссылаются сигналы главной, `OverviewClient.jsx`).

- [ ] **Step 5: Скрининги и сборка**

```bash
grep -rn 'fetch("[^"]*\${' "app/cabinets/[id]/deliveries/"     # пусто (D3)
grep -rn 'var(--[a-z]*)[0-9A-F]\{2\}' "app/cabinets/[id]/deliveries/"   # пусто (D13)
npm run build
```
Expected: сборка без ошибок.

- [ ] **Step 6: Commit**

```bash
git add "app/cabinets/[id]/deliveries/page.js" "app/cabinets/[id]/deliveries/DeliveriesPage.jsx" "app/cabinets/[id]/deliveries/ReceiptPanel.jsx" "app/cabinets/[id]/layout.js"
git commit -m "feat(deliveries): страница «Доставлено на склад» вместо «Склады» в меню

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Смоук, деплой, документация

**Files:**
- Create: `scripts/smoke-deliveries.mjs`
- Modify: `AGENTS.md` (TL;DR-таблица + раздел «Маршрут «Закупки → Склад/ФФ»»)

**Interfaces:**
- Consumes: GET `/api/cabinets/1/deliveries` (Task 4), таблицы Task 1.

- [ ] **Step 1: Смоук (только чтение + обратимая проверка на #1)**

```js
#!/usr/bin/env node
// scripts/smoke-deliveries.mjs — смоук «Доставлено на склад» (15.10.2026). Проверяет:
//   1) GET отвечает 200; партий = архивных неудалённых партий в БД; totals.waiting+done = всего;
//   2) accepted каждой партии = Σ qty_accepted её строк в БД;
//   3) нет закрытых партий без строк;
//   4) catalog=1 отвечает 200;
//   5) (только кабинет #1, обратимо) line_add → line_update → line_delete на ждущей партии,
//      закрытую партию нельзя править (если такая есть).
// Аутентификация — sealed-cookie, как scripts/smoke-order-matrix.mjs.
// Запуск: node scripts/smoke-deliveries.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query, withTenant, tenantQuery } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
const tq = (sql, params = []) => withTenant(CAB, () => tenantQuery(sql, params));

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  if (!cond) failed++;
};
const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
const cookie = `saas_session=${encodeURIComponent(seal)}`;
const get = async (path) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { headers: { cookie } });
  return { status: r.status, data: await r.json() };
};
const post = async (body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/deliveries`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

const all = await get('deliveries?status=all');
check('GET deliveries 200', all.status === 200, all.data);
const items = all.data.items || [];
const [{ n }] = await tq('SELECT count(*)::int AS n FROM tenant.purchases WHERE archived AND deleted_at IS NULL');
check('партий = архивных в БД', items.length === n, { api: items.length, db: n });
check('totals = всего', (all.data.totals.waiting + all.data.totals.done) === items.length, all.data.totals);
const sums = await tq('SELECT purchase_id, sum(qty_accepted)::int AS s FROM tenant.purchase_receipt_lines GROUP BY 1');
const sumBy = Object.fromEntries(sums.map((r) => [Number(r.purchase_id), r.s]));
const badSum = items.filter((it) => it.accepted !== (sumBy[it.id] || 0));
check('accepted = Σ строк', !badSum.length, badSum.map((i) => i.id));
check('нет закрытых без строк', !items.some((it) => it.status === 'done' && !it.lines.length));
const cat = await get('deliveries?catalog=1&q=ка');
check('catalog 200', cat.status === 200 && Array.isArray(cat.data.catalog), cat.data);

if (CAB === 1) {
  const w = items.find((it) => it.status === 'waiting');
  if (w) {
    const add = await post({ action: 'line_add', purchase_id: w.id, label: 'smoke-тест', qty_accepted: 1, note: 'smoke' });
    check('line_add', add.status === 200 && add.data.line?.id, add.data);
    const id = add.data.line?.id;
    const upd = await post({ action: 'line_update', id, qty_accepted: 2 });
    check('line_update', upd.status === 200 && upd.data.line?.qty_accepted === 2, upd.data);
    const neg = await post({ action: 'line_update', id, qty_accepted: -1 });
    check('отрицательное → 400', neg.status === 400, neg.data);
    const del = await post({ action: 'line_delete', id });
    check('line_delete', del.status === 200, del.data);
  } else console.log('SKIP  нет ждущих партий для обратимой проверки');
  const d = items.find((it) => it.status === 'done' && it.lines.length);
  if (d) {
    const r = await post({ action: 'line_update', id: d.lines[0].id, qty_accepted: d.lines[0].qty_accepted });
    check('закрытую партию править нельзя', r.status === 400, r.data);
  } else console.log('SKIP  нет закрытых партий');
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Деплой и прогон**

```bash
npm run build && systemctl restart saas-web
sleep 5; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3200/
node scripts/smoke-deliveries.mjs 1
node --test lib/__tests__/deliveries.test.mjs lib/__tests__/deliveriesGuard.test.mjs lib/__tests__/roleGuards.test.mjs
```
Expected: `200` (или редирект 3xx на логин), смоук `ALL PASS`, тесты PASS.
Проверить, что смоук не оставил строк: `psql -h localhost -U saas_ro -d saas -Atc "select count(*) from tenant.purchase_receipt_lines where note='smoke'"` → `0`.

- [ ] **Step 3: AGENTS.md**

```bash
cp AGENTS.md /opt/agentsDB/backups/AGENTS.md.$(date +%Y%m%d_%H%M%S).bak
```
В TL;DR-таблицу добавить строку:
`| Доставлено на склад (приёмка партий закупки по артикулам) | `lib/deliveries.js`, `/deliveries`, миграция 069 |`

В начало раздела «### 🆕 Маршрут «Закупки → Склад/ФФ» (с 2026-07-15)» вставить абзац:

```
> **С 2026-10-15 маршрут другой** (спека `docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md`):
> кнопка «✓ Доставлено» в «Закупках» (action `complete_to_stock`) только ставит `archived=true` и
> `delivered_at` — партия уходит на страницу «Доставлено на склад» (`/deliveries`, меню «Товары» вместо
> «Склады»), где фиксируется приёмка ФФ по артикулам (`tenant.purchase_receipt_lines`, миграция 069) и
> отметка «Учтено по артикулам» (`purchases.receipt_done_at`; снять — только owner). Это КОНЕЧНАЯ точка:
> в `ff_inventory`, журнал движений и `cost_overrides` не пишется (решение владельца). Описанное ниже —
> история; позиции `ff_inventory`, созданные до 15.10, не тронуты. `/warehouses` убран из меню, но роут жив
> (ссылки сигналов главной). Тесты `lib/__tests__/deliveries.test.mjs`, гард `deliveriesGuard.test.mjs`,
> смоук `node scripts/smoke-deliveries.mjs 1`.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-deliveries.mjs AGENTS.md
git commit -m "test(deliveries): смоук «Доставлено на склад»; карта проекта

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
