# Склады 2.0 — этап 2 «Учёт»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Каждое изменение остатка своего склада/ФФ проходит через журнал движений `stock_moves`; FBS-заказы WB/Ozon списываются автоматически по привязке «склад продавца → место»; нераспознанные задания копятся в `stock_move_gaps`; перемещение ФФ→ФФ оформляется документом; расхождение «остаток ≠ сумма движений» видно в панели.

**Architecture:** Журнал поверх текущего `ff_inventory.qty` (вариант А спеки): единая точка записи `applyMove()` в `lib/stockLedger.js` (панель, внутри транзакции `withTenant`) и `worker/stock_ledger.py` (воркер, savepoint на движение) с одним SQL-контрактом — уникальный индекс источника делает повторы идемпотентными. Существующие правки остатка (закупка → склад, отгрузка, ручная правка) переводятся на ledger. Два новых сборщика `wb_fbs_writeoff` / `ozon_fbs_writeoff` планируют движения чистыми функциями (тестируются без БД) и применяют их через Python-ledger.

**Tech Stack:** Python 3 (psycopg3) в `/opt/agents/data-presenter-agent/.venv/bin/python`; PostgreSQL 16 с RLS; Next.js 14 App Router (`tenantQuery`, `withCabinet`); node:test.

**Spec:** `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md` (раздел 3 целиком, раздел 6 «Этап 2», этап 2 раздела 7).

## Global Constraints

- Все живые прогоны, пробы и ручные проверки БД — **только кабинет #1** (`--cabinet 1`). Остальные кабинеты боевые.
- Чтение БД: `psql -h localhost -U saas_ro -d saas -Atc "…"` с обязательным `WHERE cabinet_id = 1`. Запись/миграции: только контроллер, `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`.
- Регистрация сборщика = список `WB_COLLECTORS`/`OZON_COLLECTORS` в `worker/orchestrator.py` **и** переменная режима в `worker/run_saas_collect.sh`. Порядок в списках load-bearing: сборщик-источник раньше потребителя.
- Мягкая деградация: нет токена/API недоступен → `ПРОПУСК`, `return 0`, `exit 0`. Частичный результат → `exit 3` (оркестратор ставит `partial`).
- Инвариант ledger: **прямых `UPDATE tenant.ff_inventory SET qty` вне `lib/stockLedger.js` и `worker/stock_ledger.py` быть не должно** (проверяется grep'ом в задаче 9). Новая позиция создаётся с `qty = 0`, количество приходит движением.
- Каждая новая tenant-таблица: RLS `tenant_iso_<table>` для `saas_app` + `panel_local_ro_cab1` для `panel_local_ro`; GRANT'ы как в миграции 052.
- Никакого `next dev` в каталоге прода; `npm run build` — только в задаче 7 (проверка JSX) и при деплое (контроллер).
- `git add` только явным списком файлов.
- Тесты: Python — самостоятельные `scripts/test-*.py` с assert; JS — `node --test lib/__tests__/*.test.mjs`.

Команда одиночного прогона сборщика (`ORCH`):

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && \
SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas \
/opt/agents/data-presenter-agent/.venv/bin/python -m worker.orchestrator \
  --cabinet 1 --collectors <имя> --date-from 2026-09-04 --date-to 2026-09-06 --run-kind manual
```
Проба без записи: префикс `SAAS_PROBE=1` (печатает план движений и ничего не пишет).

## Что вскрыл осмотр 06.09 (влияет на задачи)

| Факт | Следствие |
|---|---|
| Привязка позиции к артикулам с 2026-07-18 живёт в `tenant.ff_inventory_skus` (много артикулов обеих площадок на позицию; уникальность по частичным индексам `uq_ff_inventory_skus_wb/ozon`); колонки `nm_id/product_id/platform` в `ff_inventory` — dead back-compat | Спека §3.1 «двойная привязка» уже реализована. Поиск позиции по артикулу — через `ff_inventory_skus`. Спека правится в задаче 9 |
| У кабинета #1 12 активных позиций, `location_id` NULL у всех; 9 привязок WB, 1 Ozon; `ff_shipments`/`ff_shipment_docs` пусты | Первый прогон авто-списания даст только gaps (`no_location`); содержательная сверка — после того как владелец расставит места и привяжет склады. `stock_moves.location_id` — NULLABLE (спека говорит NOT NULL, но у позиций места нет) |
| Прямые правки `qty` в панели: `inventory/route.js` (`update_qty`, legacy-действие `shipment` add/delete, `add`), `purchases/route.js` (`complete_to_stock`), `shipments/route.js` (`create`/`delete`) | Все переводятся на ledger в задаче 3. Legacy-действие `shipment` в inventory-роуте UI не вызывает (grep по jsx — 0 вызовов) → удаляется, история `ff_shipments` в GET остаётся |
| WB-задания: `wb_status` ∈ waiting / sorted / ready_for_pickup / sold / canceled / canceled_by_client / declined_by_client / defect / NULL; у 225 из 236 есть `supply_id`, все поставки закрыты (`closed_at`) | Признак «товар уехал со склада продавца» = `wb_supplies.closed_at IS NOT NULL` **или** `wb_status ∈ {sorted, ready_for_pickup, sold}`. Возврат на склад: статус ∈ {canceled_by_client, declined_by_client, defect} при уже сделанном списании, либо возвратная продажа `wb_sales.sale_id LIKE 'R%'` по `srid = rid` |
| Ozon FBS-постинги в БД: `delivered` 227, `cancelled` 9; статусы жизни: awaiting_packaging → awaiting_deliver → delivering → delivered | Списание при статусе ∈ {awaiting_deliver, delivering, delivered}; `cancelled` → возврат только если списание уже было; возврат покупателем — `ozon_sales.is_return=1 AND scheme='fbs'` |
| `withTenant` держит весь обработчик в одной транзакции; `tenantQuery` бросает исходную pg-ошибку | `applyMove` в панели — обычные `await tenantQuery`, откат всей операции при throw. В Python `get_connection()` = одна транзакция на with-блок; для батча — savepoint на движение |
| `/health` читает только `jobs.*`/`auth.*` без RLS; tenant-таблицы под `saas_app` без `app.cabinet_id` не видны | Сторож «qty ≠ сумма движений» кладём **не** в `/health`, а в GET `/inventory` (`ledger.mismatch`) + баннер на странице + SQL-сторож этапа. Спека §3.3 правится в задаче 9 |

## File Structure

| Файл | Ответственность |
|---|---|
| `db/migrations/053_stock_ledger.sql` | `stock_moves`, `stock_move_gaps`, `ff_transfer_docs`, `ff_transfer_lines`, начальное сальдо |
| `lib/stockMoves.js` | Чистые константы/валидация движения (`KINDS`, `SRC_KINDS`, `normalizeMove`, `normalizeTransferDoc`) |
| `lib/stockLedger.js` | `applyMove`, `applyTransfer` — единственная точка записи `ff_inventory.qty` в панели |
| `app/api/cabinets/[id]/inventory/route.js` | `add`/`update_qty` через ledger; legacy `shipment` удалён; GET отдаёт `ledger` |
| `app/api/cabinets/[id]/purchases/route.js` | `complete_to_stock` через ledger |
| `app/api/cabinets/[id]/shipments/route.js` | `create`/`delete` через ledger |
| `app/api/cabinets/[id]/transfers/route.js` | Документы перемещения ФФ→ФФ |
| `app/cabinets/[id]/inventory/InventoryPage.jsx` | Причина при ручной правке qty; баннер расхождения/пробелов; кнопка «Перемещение» + `TransferFormModal.jsx` |
| `worker/stock_ledger.py` | `apply_moves(moves) -> dict` (savepoint на движение), `record_gaps`, `resolve_gaps` |
| `worker/fbs_writeoff_core.py` | Чистое планирование движений: `plan_wb_moves`, `plan_ozon_moves`, `resolve_item` (FIFO) |
| `worker/collectors/wb_fbs_writeoff.py`, `worker/collectors/ozon_fbs_writeoff.py` | Чтение источников из БД → план → `apply_moves`; `SAAS_PROBE=1` печатает план |
| `worker/db_pg.py` | Чтение источников для планировщика (задания, постинги, возвраты, позиции, места, существующие движения) |
| `scripts/test-stock-ledger-py.py`, `scripts/test-fbs-writeoff-core.py`, `lib/__tests__/stockMoves.test.mjs` | Тесты чистой логики |
| `scripts/check-warehouses-stage2.sql` | SQL-сторож этапа |
| `AGENTS.md`, спека §3 | Документация |

---

### Task 1: Миграция 053 — журнал движений, пробелы, перемещения, начальное сальдо

**Files:**
- Create: `db/migrations/053_stock_ledger.sql`

**Interfaces:**
- Produces: таблицы `tenant.stock_moves`, `tenant.stock_move_gaps`, `tenant.ff_transfer_docs`, `tenant.ff_transfer_lines`; уникальный индекс `stock_moves_src_uq (cabinet_id, src_kind, src_ref, kind)`; начальные движения `adjust` с `src_kind='manual'`, `src_ref='opening:<ff_inventory_id>'`.

- [ ] **Step 1: Написать миграцию**

```sql
-- 053_stock_ledger.sql — Склады 2.0, этап 2 «Учёт» (спека §3).
-- Журнал движений поверх ff_inventory.qty: каждое изменение остатка — строка
-- stock_moves; qty позиции = сумма движений (сторож scripts/check-warehouses-stage2.sql).
-- stock_move_gaps — задания/постинги FBS, которые не удалось разнести (нет места,
-- нет позиции, не хватило остатка). ff_transfer_docs/lines — перемещение ФФ→ФФ.
-- Начальное сальдо: по одному движению adjust на каждую позицию с qty<>0, чтобы
-- инвариант «qty = SUM(stock_moves.qty)» выполнялся с первого дня. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.stock_moves (
    cabinet_id      BIGINT      NOT NULL,
    id              BIGSERIAL,
    ff_inventory_id BIGINT      NOT NULL,                  -- → ff_inventory.id (логический FK)
    location_id     BIGINT,                                -- место на момент движения (NULL — позиция без места)
    kind            TEXT        NOT NULL CHECK (kind IN ('in','out_fbo','out_fbs','transfer_out','transfer_in','adjust','return_in')),
    qty             INTEGER     NOT NULL,                  -- со знаком: приход +, списание −
    src_kind        TEXT        NOT NULL CHECK (src_kind IN ('purchase','ff_shipment_doc','wb_fbs_task','ozon_posting','transfer_doc','manual','wb_fbs_return','ozon_return')),
    src_ref         TEXT        NOT NULL,                  -- id/rid/posting_number источника
    moved_at        TIMESTAMPTZ NOT NULL,
    note            TEXT,
    created_by      BIGINT,                                -- auth user_id; NULL — воркер/миграция
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_moves_src_uq ON tenant.stock_moves (cabinet_id, src_kind, src_ref, kind);
CREATE INDEX IF NOT EXISTS stock_moves_inv_idx ON tenant.stock_moves (cabinet_id, ff_inventory_id);
CREATE INDEX IF NOT EXISTS stock_moves_moved_idx ON tenant.stock_moves (cabinet_id, moved_at);

CREATE TABLE IF NOT EXISTS tenant.stock_move_gaps (
    cabinet_id    BIGINT NOT NULL,
    id            BIGSERIAL,
    src_kind      TEXT   NOT NULL,
    src_ref       TEXT   NOT NULL,
    platform      TEXT   NOT NULL CHECK (platform IN ('wb','ozon')),
    warehouse_id  BIGINT,
    sku_key       BIGINT,                                  -- wb: nm_id; ozon: product_id
    qty           INTEGER NOT NULL,
    reason        TEXT   NOT NULL CHECK (reason IN ('no_location','no_item','insufficient')),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ,
    PRIMARY KEY (cabinet_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_move_gaps_src_uq ON tenant.stock_move_gaps (cabinet_id, src_kind, src_ref);
CREATE INDEX IF NOT EXISTS stock_move_gaps_open_idx ON tenant.stock_move_gaps (cabinet_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant.ff_transfer_docs (
    cabinet_id       BIGINT NOT NULL,
    id               BIGSERIAL,
    from_location_id BIGINT NOT NULL,
    to_location_id   BIGINT NOT NULL,
    moved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    note             TEXT,
    created_by       BIGINT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    CHECK (from_location_id <> to_location_id)
);
CREATE TABLE IF NOT EXISTS tenant.ff_transfer_lines (
    cabinet_id         BIGINT  NOT NULL,
    id                 BIGSERIAL,
    doc_id             BIGINT  NOT NULL,
    ff_inventory_id    BIGINT  NOT NULL,                   -- позиция-источник
    to_ff_inventory_id BIGINT  NOT NULL,                   -- позиция-приёмник (найдена или создана)
    qty                INTEGER NOT NULL CHECK (qty > 0),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS ff_transfer_lines_doc_idx ON tenant.ff_transfer_lines (cabinet_id, doc_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_moves','stock_move_gaps','ff_transfer_docs','ff_transfer_lines'] LOOP
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

-- Начальное сальдо: qty на момент миграции = одно движение adjust (все кабинеты;
-- миграция идёт под postgres, RLS не мешает). Повторный запуск — ON CONFLICT DO NOTHING.
INSERT INTO tenant.stock_moves (cabinet_id, ff_inventory_id, location_id, kind, qty, src_kind, src_ref, moved_at, note)
SELECT f.cabinet_id, f.id, f.location_id, 'adjust', f.qty, 'manual', 'opening:' || f.id, now(),
       'начальное сальдо 2026-09-06 (миграция 053)'
FROM tenant.ff_inventory f
WHERE f.qty <> 0
ON CONFLICT (cabinet_id, src_kind, src_ref, kind) DO NOTHING;

COMMIT;
```

- [ ] **Step 2 (контроллер): применить дважды, проверить**

```bash
cd /opt/agents/saas && for i in 1 2; do PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -q -f db/migrations/053_stock_ledger.sql && echo "apply $i OK"; done
psql -h localhost -U saas_ro -d saas -Atc "SELECT COUNT(*) FROM pg_policies WHERE schemaname='tenant' AND tablename IN ('stock_moves','stock_move_gaps','ff_transfer_docs','ff_transfer_lines'); SELECT COUNT(*), SUM(qty) FROM tenant.stock_moves WHERE cabinet_id=1 AND src_ref LIKE 'opening:%'; SELECT COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s,0)) AS mismatch FROM tenant.ff_inventory f LEFT JOIN (SELECT ff_inventory_id, SUM(qty) s FROM tenant.stock_moves WHERE cabinet_id=1 GROUP BY 1) m ON m.ff_inventory_id=f.id WHERE f.cabinet_id=1"
```
Expected: 8 политик; `12|5720` (по осмотру 06.09); `mismatch = 0`.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/053_stock_ledger.sql
git commit -m "feat(ledger): миграция 053 — журнал движений, пробелы FBS, перемещения ФФ→ФФ, начальное сальдо"
```

---

### Task 2: Чистые правила движений (`lib/stockMoves.js`) и ledger панели (`lib/stockLedger.js`)

**Files:**
- Create: `lib/stockMoves.js`, `lib/__tests__/stockMoves.test.mjs`, `lib/stockLedger.js`

**Interfaces:**
- Produces:
  - `KINDS`, `SRC_KINDS` (массивы строк, как в CHECK миграции), `SIGN = { in:+1, return_in:+1, transfer_in:+1, out_fbo:-1, out_fbs:-1, transfer_out:-1, adjust:0 }`;
  - `normalizeMove(input) -> { ok:true, move } | { ok:false, error }` — `input: { ffInventoryId, kind, qty, srcKind, srcRef, movedAt?, note?, userId? }`; для `kind ≠ 'adjust'` требует `qty > 0` целое и ставит знак по `SIGN`; для `adjust` `qty` — любое целое ≠ 0 и `note` обязателен; `movedAt` по умолчанию `new Date().toISOString()`;
  - `normalizeTransferDoc(body) -> { ok:true, doc:{ fromLocationId, toLocationId, movedAt, note, lines:[{ffInventoryId, qty}] } } | { ok:false, error }`;
  - `applyMove(move) -> Promise<{ applied:true, id, newQty } | { applied:false, duplicate:true }>` — внутри транзакции `withTenant`; бросает `Error('insufficient: ff_inventory_id=<id>')`, если остаток ушёл бы в минус (кроме `adjust`), и `Error('not found: ff_inventory_id=<id>')`;
  - `applyTransfer({ ffInventoryId, toLocationId, qty, docId, lineNo, movedAt, userId }) -> Promise<{ toFfInventoryId }>`.

- [ ] **Step 1: Тест правил**

```js
// lib/__tests__/stockMoves.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMove, normalizeTransferDoc, SIGN } from "../stockMoves.js";

test("списание получает минус, приход плюс", () => {
  const a = normalizeMove({ ffInventoryId: 5, kind: "out_fbs", qty: 2, srcKind: "wb_fbs_task", srcRef: "rid1" });
  assert.equal(a.ok, true); assert.equal(a.move.qty, -2);
  const b = normalizeMove({ ffInventoryId: 5, kind: "in", qty: 7, srcKind: "purchase", srcRef: "3" });
  assert.equal(b.move.qty, 7);
});

test("adjust требует ненулевое qty и причину", () => {
  assert.deepEqual(normalizeMove({ ffInventoryId: 1, kind: "adjust", qty: 0, srcKind: "manual", srcRef: "x", note: "y" }),
    { ok: false, error: "adjust: qty must be a non-zero integer" });
  assert.deepEqual(normalizeMove({ ffInventoryId: 1, kind: "adjust", qty: -3, srcKind: "manual", srcRef: "x" }),
    { ok: false, error: "adjust: note required" });
  const ok = normalizeMove({ ffInventoryId: 1, kind: "adjust", qty: -3, srcKind: "manual", srcRef: "x", note: "инвентаризация" });
  assert.equal(ok.ok, true); assert.equal(ok.move.qty, -3);
});

test("неизвестный kind/srcKind и дробное qty отклоняются", () => {
  assert.equal(normalizeMove({ ffInventoryId: 1, kind: "sale", qty: 1, srcKind: "manual", srcRef: "x" }).ok, false);
  assert.equal(normalizeMove({ ffInventoryId: 1, kind: "in", qty: 1, srcKind: "csv", srcRef: "x" }).ok, false);
  assert.equal(normalizeMove({ ffInventoryId: 1, kind: "in", qty: 1.5, srcKind: "purchase", srcRef: "x" }).ok, false);
  assert.equal(normalizeMove({ ffInventoryId: 0, kind: "in", qty: 1, srcKind: "purchase", srcRef: "x" }).ok, false);
});

test("movedAt по умолчанию — сейчас, ISO", () => {
  const m = normalizeMove({ ffInventoryId: 1, kind: "in", qty: 1, srcKind: "purchase", srcRef: "x" }).move;
  assert.match(m.movedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(SIGN.adjust, 0);
});

test("normalizeTransferDoc: разные места, строки без дублей", () => {
  const bad = normalizeTransferDoc({ from_location_id: 5, to_location_id: 5, lines: [{ ff_inventory_id: 1, qty: 1 }] });
  assert.deepEqual(bad, { ok: false, error: "from and to locations must differ" });
  const dup = normalizeTransferDoc({ from_location_id: 5, to_location_id: 6, lines: [{ ff_inventory_id: 1, qty: 1 }, { ff_inventory_id: "1", qty: 2 }] });
  assert.deepEqual(dup, { ok: false, error: "позиция id=1 повторяется в составе" });
  const ok = normalizeTransferDoc({ from_location_id: "5", to_location_id: 6, moved_at: "2026-09-06", note: " x ", lines: [{ ff_inventory_id: 1, qty: "3" }] });
  assert.deepEqual(ok, { ok: true, doc: { fromLocationId: 5, toLocationId: 6, movedAt: "2026-09-06", note: "x", lines: [{ ffInventoryId: 1, qty: 3 }] } });
  assert.equal(normalizeTransferDoc({ from_location_id: 5, to_location_id: 6, lines: [] }).ok, false);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /opt/agents/saas && node --test lib/__tests__/stockMoves.test.mjs`
Expected: `Cannot find module '…/lib/stockMoves.js'`.

- [ ] **Step 3: `lib/stockMoves.js`**

```js
// lib/stockMoves.js — чистые правила движения остатка (спека «Склады 2.0» §3.2).
// Никакой БД: только нормализация входа для applyMove/applyTransfer (lib/stockLedger.js)
// и роутов. Знак qty задаётся kind'ом, кроме adjust (ручная корректировка со знаком).
export const KINDS = ["in", "out_fbo", "out_fbs", "transfer_out", "transfer_in", "adjust", "return_in"];
export const SRC_KINDS = ["purchase", "ff_shipment_doc", "wb_fbs_task", "ozon_posting", "transfer_doc", "manual", "wb_fbs_return", "ozon_return"];
export const SIGN = { in: 1, return_in: 1, transfer_in: 1, out_fbo: -1, out_fbs: -1, transfer_out: -1, adjust: 0 };

const posInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

export function normalizeMove(input) {
  const ffInventoryId = Number(input.ffInventoryId);
  if (!posInt(ffInventoryId)) return { ok: false, error: "ffInventoryId must be a positive integer" };
  const kind = String(input.kind || "");
  if (!KINDS.includes(kind)) return { ok: false, error: `unknown kind: ${kind}` };
  const srcKind = String(input.srcKind || "");
  if (!SRC_KINDS.includes(srcKind)) return { ok: false, error: `unknown srcKind: ${srcKind}` };
  const srcRef = String(input.srcRef ?? "").trim();
  if (!srcRef) return { ok: false, error: "srcRef required" };
  const raw = Number(input.qty);
  if (!Number.isInteger(raw)) return { ok: false, error: "qty must be an integer" };
  let qty;
  const note = input.note == null ? null : String(input.note).trim() || null;
  if (kind === "adjust") {
    if (raw === 0) return { ok: false, error: "adjust: qty must be a non-zero integer" };
    if (!note) return { ok: false, error: "adjust: note required" };
    qty = raw;
  } else {
    if (raw <= 0) return { ok: false, error: `${kind}: qty must be a positive integer` };
    qty = raw * SIGN[kind];
  }
  const movedAt = input.movedAt ? String(input.movedAt) : new Date().toISOString();
  const userId = input.userId == null ? null : Number(input.userId);
  return { ok: true, move: { ffInventoryId, kind, qty, srcKind, srcRef, movedAt, note, userId } };
}

export function normalizeTransferDoc(body) {
  const fromLocationId = Number(body.from_location_id);
  const toLocationId = Number(body.to_location_id);
  if (!posInt(fromLocationId) || !posInt(toLocationId)) return { ok: false, error: "from_location_id and to_location_id required" };
  if (fromLocationId === toLocationId) return { ok: false, error: "from and to locations must differ" };
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return { ok: false, error: "нужна хотя бы одна строка товара" };
  const seen = new Set();
  const norm = [];
  for (const [i, ln] of lines.entries()) {
    const ffInventoryId = Number(ln.ff_inventory_id);
    const qty = Number(ln.qty);
    if (!posInt(ffInventoryId)) return { ok: false, error: `строка ${i + 1}: ff_inventory_id required` };
    if (!posInt(qty)) return { ok: false, error: `строка ${i + 1}: qty должно быть целым ≥ 1` };
    if (seen.has(ffInventoryId)) return { ok: false, error: `позиция id=${ffInventoryId} повторяется в составе` };
    seen.add(ffInventoryId);
    norm.push({ ffInventoryId, qty });
  }
  const movedAt = (body.moved_at || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const note = String(body.note ?? "").trim() || null;
  return { ok: true, doc: { fromLocationId, toLocationId, movedAt, note, lines: norm } };
}
```

- [ ] **Step 4: Тест проходит**

Run: `node --test lib/__tests__/stockMoves.test.mjs` → `# pass 5`.

- [ ] **Step 5: `lib/stockLedger.js` (единственная точка записи qty в панели)**

```js
// lib/stockLedger.js — журнал движений остатка (спека «Склады 2.0» §3.3).
// ЕДИНСТВЕННОЕ место в панели, где меняется tenant.ff_inventory.qty. Работает
// внутри транзакции withTenant (tenantQuery): при throw вся операция роута откатывается.
// Контракт с worker/stock_ledger.py: тот же уникальный индекс stock_moves_src_uq —
// повторное движение с тем же (src_kind, src_ref, kind) = no-op {duplicate:true}.
import { tenantQuery } from "@/lib/db.js";
import { normalizeMove } from "@/lib/stockMoves.js";

export async function applyMove(input) {
  const n = normalizeMove(input);
  if (!n.ok) throw new Error(`stock move: ${n.error}`);
  const m = n.move;
  const row = (await tenantQuery(
    `SELECT id, qty, location_id FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
    [m.ffInventoryId]
  ))[0];
  if (!row) throw new Error(`not found: ff_inventory_id=${m.ffInventoryId}`);
  const ins = await tenantQuery(
    `INSERT INTO tenant.stock_moves
       (cabinet_id, ff_inventory_id, location_id, kind, qty, src_kind, src_ref, moved_at, note, created_by)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (cabinet_id, src_kind, src_ref, kind) DO NOTHING
     RETURNING id`,
    [m.ffInventoryId, row.location_id, m.kind, m.qty, m.srcKind, m.srcRef, m.movedAt, m.note, m.userId]
  );
  if (!ins.length) return { applied: false, duplicate: true };
  const upd = await tenantQuery(
    `UPDATE tenant.ff_inventory SET qty = qty + $1, updated_at = now()
     WHERE id = $2 AND ($3 OR qty + $1 >= 0)
     RETURNING qty`,
    [m.qty, m.ffInventoryId, m.kind === "adjust"]
  );
  if (!upd.length) throw new Error(`insufficient: ff_inventory_id=${m.ffInventoryId}`);
  return { applied: true, id: ins[0].id, newQty: upd[0].qty };
}

// Перемещение одной строки документа ФФ→ФФ: transfer_out у источника + transfer_in у
// приёмника. Приёмник — активная позиция на месте назначения с тем же internal_name и
// unit_cost; нет — создаётся копия строки с qty=0 и теми же привязками артикулов.
export async function applyTransfer({ ffInventoryId, toLocationId, qty, docId, lineNo, movedAt, userId }) {
  const src = (await tenantQuery(
    `SELECT id, internal_name, unit_cost, category, im_url, completed_at, location_id
     FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL`, [ffInventoryId]
  ))[0];
  if (!src) throw new Error(`not found: ff_inventory_id=${ffInventoryId}`);
  let dst = (await tenantQuery(
    `SELECT id FROM tenant.ff_inventory
     WHERE archived_at IS NULL AND location_id = $1 AND id <> $2
       AND internal_name IS NOT DISTINCT FROM $3 AND unit_cost IS NOT DISTINCT FROM $4
     ORDER BY id LIMIT 1`,
    [toLocationId, src.id, src.internal_name, src.unit_cost]
  ))[0];
  if (!dst) {
    dst = (await tenantQuery(
      `INSERT INTO tenant.ff_inventory
         (cabinet_id, purchase_id, internal_name, qty, unit_cost, category, im_url, completed_at, location_id)
       VALUES (current_setting('app.cabinet_id')::bigint, NULL, $1, 0, $2, $3, $4, $5, $6) RETURNING id`,
      [src.internal_name, src.unit_cost, src.category, src.im_url, src.completed_at, toLocationId]
    ))[0];
    await tenantQuery(
      `INSERT INTO tenant.ff_inventory_skus (cabinet_id, ff_inventory_id, platform, nm_id, product_id, sku_name, im_url)
       SELECT cabinet_id, $1, platform, nm_id, product_id, sku_name, im_url
       FROM tenant.ff_inventory_skus WHERE ff_inventory_id = $2
       ON CONFLICT DO NOTHING`,
      [dst.id, src.id]
    );
  }
  const ref = `${docId}:${lineNo}`;
  await applyMove({ ffInventoryId: src.id, kind: "transfer_out", qty, srcKind: "transfer_doc", srcRef: ref, movedAt, userId });
  await applyMove({ ffInventoryId: dst.id, kind: "transfer_in", qty, srcKind: "transfer_doc", srcRef: ref, movedAt, userId });
  return { toFfInventoryId: dst.id };
}
```

- [ ] **Step 6: Импорт-проверка модуля**

Run: `node -e "import('./lib/stockMoves.js').then(m=>console.log(Object.keys(m)))"`
Expected: `[ 'KINDS', 'SIGN', 'SRC_KINDS', 'normalizeMove', 'normalizeTransferDoc' ]`. (`stockLedger.js` импортирует `@/lib/db.js` через алиас Next.js — проверяется сборкой в задаче 7.)

- [ ] **Step 7: Commit**

```bash
git add lib/stockMoves.js lib/stockLedger.js lib/__tests__/stockMoves.test.mjs
git commit -m "feat(ledger): правила движений и applyMove/applyTransfer для панели"
```

---

### Task 3: Перевод правок остатка в панели на ledger

**Files:**
- Modify: `app/api/cabinets/[id]/inventory/route.js` (действия `add`, `shipment`, `update_qty`), `app/api/cabinets/[id]/purchases/route.js` (`complete_to_stock`), `app/api/cabinets/[id]/shipments/route.js` (`create`, `delete`), `app/cabinets/[id]/inventory/InventoryPage.jsx:255-270` (`commitQty`)

**Interfaces:**
- Consumes: `applyMove` (задача 2); `withCabinet` передаёт `session.user_id` в обработчик как второй аргумент `{ cabinet, session }` (проверить имя поля в `lib/withCabinet.js`; если сессия недоступна — `userId: null`).
- Produces: POST `/inventory {action:"update_qty", id, qty, note}` — `note` обязателен, иначе 400 `{error:"note required"}`; движения: `add` → `in` (`manual`, `add:<id>`), `update_qty` → `adjust` (`manual`, `qty:<id>:<ISO-время>`), `complete_to_stock` → `in` (`purchase`, `<purchase_id>`), отгрузка `create` → `out_fbo` (`ff_shipment_doc`, `<doc_id>:<line_id>`), отгрузка `delete` → `adjust` (`ff_shipment_doc`, `<doc_id>:<line_id>:delete`, note «удаление документа отгрузки №…»).

- [ ] **Step 1: `inventory/route.js`**

Импорт: `import { applyMove } from "@/lib/stockLedger.js";`.

`add`: сейчас INSERT с `qty`. Заменить на INSERT с `qty = 0` (`RETURNING id`) и затем `if (qty > 0) await applyMove({ ffInventoryId: newId, kind: "in", qty, srcKind: "manual", srcRef: \`add:${newId}\`, note: "ручное добавление", userId })`.

`shipment` (legacy, add/delete): **удалить весь блок** `if (b.action === "shipment") {…}` вместе с комментарием над ним; GET-секция «Журнал отгрузок» из `ff_shipments` остаётся (история).

`update_qty`:

```js
  if (b.action === "update_qty") {
    const qty = Number(b.qty);
    if (!Number.isInteger(qty) || qty < 0) return NextResponse.json({ error: "qty must be integer >= 0" }, { status: 400 });
    const note = String(b.note ?? "").trim();
    if (!note) return NextResponse.json({ error: "note required" }, { status: 400 });
    const cur = (await tenantQuery(`SELECT qty FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL`, [id]))[0];
    if (!cur) return NextResponse.json({ error: `строка id=${id} не найдена` }, { status: 404 });
    const delta = qty - Number(cur.qty);
    if (delta === 0) return NextResponse.json({ ok: true, unchanged: true });
    // Ручная правка = корректировка со ссылкой на момент (уникальность источника — по времени).
    const r = await applyMove({ ffInventoryId: id, kind: "adjust", qty: delta, srcKind: "manual",
      srcRef: `qty:${id}:${new Date().toISOString()}`, note, userId });
    return NextResponse.json({ ok: true, new_qty: r.newQty });
  }
```

`userId`: в начале POST — `const userId = session?.user_id ?? null;` (сигнатура обработчика `withCabinet(async (req, { cabinet, session }) => …)`; если `withCabinet` не передаёт `session`, посмотреть `lib/withCabinet.js` и взять то поле, что есть; в крайнем случае `null`).

- [ ] **Step 2: `purchases/route.js` `complete_to_stock`**

INSERT в `ff_inventory` — `qty` заменить на `0` в VALUES; после получения `invId` (и в ветке `exists`, и в ветке INSERT) добавить:

```js
    const qtyIn = Number(cur.qty) || 0;
    if (invId && qtyIn > 0) {
      await applyMove({ ffInventoryId: invId, kind: "in", qty: qtyIn, srcKind: "purchase",
        srcRef: String(b.id), movedAt: completedAt, note: `закупка ${cur.supplier_name || ""}`.trim(), userId });
    }
```
(идемпотентно: повторное завершение той же закупки — `duplicate`, qty не удваивается). Импорт `applyMove`; `userId` как в шаге 1.

- [ ] **Step 3: `shipments/route.js`**

`create`: убрать цикл `UPDATE … WHERE qty >= $1`; сначала INSERT документа и строк (строки — `RETURNING id, ff_inventory_id, qty`), затем для каждой строки `await applyMove({ ffInventoryId: ln.ff_inventory_id, kind: "out_fbo", qty: ln.qty, srcKind: "ff_shipment_doc", srcRef: \`${docId}:${ln.id}\`, movedAt: shipDt, userId })` — при `insufficient` throw откатывает документ целиком (поведение сохранено). Сообщение об ошибке: перехватить `e.message.startsWith("insufficient")` и вернуть 400 `{ error: "недостаточно остатка для позиции id=…" }`, иначе пробросить.

`delete`: вместо `UPDATE … qty + $1` — для каждой строки (`SELECT id, ff_inventory_id, qty …`) `await applyMove({ ffInventoryId, kind: "adjust", qty: ln.qty, srcKind: "ff_shipment_doc", srcRef: \`${id}:${ln.id}:delete\`, note: \`удаление документа отгрузки №${id}\`, userId })`; затем DELETE строк и документа как сейчас.

- [ ] **Step 4: UI — причина при правке qty**

В `InventoryPage.jsx` `commitQty()`: перед `fetch` — `const note = prompt("Причина изменения остатка (инвентаризация, брак, пересорт…):"); if (note == null || !note.trim()) { setQtyText(String(it.qty)); return; }` и добавить `note` в тело запроса. (`setQtyText` — существующий сеттер локального состояния строки; если имя другое — использовать его.)

- [ ] **Step 5: Проверка, что прямых правок qty не осталось**

Run: `grep -rn "SET qty" app lib --include=*.js | grep -v "lib/stockLedger.js"`
Expected: пусто.

Run: `node --test lib/__tests__/stockMoves.test.mjs` → `# pass 5` (регрессия).

- [ ] **Step 6: Commit**

```bash
git add "app/api/cabinets/[id]/inventory/route.js" "app/api/cabinets/[id]/purchases/route.js" "app/api/cabinets/[id]/shipments/route.js" "app/cabinets/[id]/inventory/InventoryPage.jsx"
git commit -m "feat(ledger): закупки, отгрузки и ручные правки остатка идут через журнал движений"
```

---

### Task 4: Python-ledger и планировщик списаний (чистые функции)

**Files:**
- Create: `worker/stock_ledger.py`, `worker/fbs_writeoff_core.py`, `scripts/test-fbs-writeoff-core.py`, `scripts/test-stock-ledger-py.py`
- Modify: `worker/db_pg.py` (чтение источников)

**Interfaces:**
- Produces:
  - `fbs_writeoff_core.resolve_item(rows, qty) -> (list[(ff_inventory_id, take)], shortage)` — `rows` = `[{"id","qty","completed_at"}]` уже отфильтрованные по месту и артикулу; FIFO по `completed_at` (NULL — последними), затем `id`;
  - `fbs_writeoff_core.plan_wb(tasks, supplies_closed, loc_by_wh, items, existing_out, returns) -> (moves, gaps)`;
  - `fbs_writeoff_core.plan_ozon(postings, loc_by_wh, items, existing_out, returns) -> (moves, gaps)`;
    - `move` = `{"ff_inventory_id","kind","qty"(со знаком),"src_kind","src_ref","moved_at","note"}`;
    - `gap` = `{"src_kind","src_ref","platform","warehouse_id","sku_key","qty","reason"}`;
    - `items` = `{(location_id, platform, sku_key): [row,…]}`; `loc_by_wh` = `{(platform, warehouse_id): location_id}`; `existing_out` = `{src_ref: ff_inventory_id}` (уже сделанные `out_fbs` по этому `src_kind`); `returns` — см. тесты;
  - `stock_ledger.apply_moves(moves) -> {"applied":int,"duplicate":int,"insufficient":list[src_ref]}` — одна транзакция, savepoint на движение;
  - `stock_ledger.record_gaps(gaps)`, `stock_ledger.resolve_gaps(src_kind, src_refs)`;
  - `db_pg.fbs_items_by_location() -> dict`, `db_pg.locations_by_warehouse() -> dict`, `db_pg.existing_out_moves(src_kind) -> dict`, `db_pg.wb_fbs_tasks_for_writeoff() -> list`, `db_pg.wb_supplies_closed() -> set`, `db_pg.wb_fbs_returns() -> list`, `db_pg.ozon_fbs_postings_for_writeoff() -> list`, `db_pg.ozon_fbs_returns() -> list`.

- [ ] **Step 1: Тест планировщика**

```python
#!/usr/bin/env python3
"""Планировщик авто-списания FBS (worker/fbs_writeoff_core.py). Без сети и БД."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker"))
import fbs_writeoff_core as c

# resolve_item: FIFO по completed_at (NULL последними), затем id
rows = [{"id": 3, "qty": 2, "completed_at": None}, {"id": 1, "qty": 1, "completed_at": "2026-07-15"},
        {"id": 2, "qty": 5, "completed_at": "2026-08-01"}]
assert c.resolve_item(rows, 3) == ([(1, 1), (2, 2)], 0)
assert c.resolve_item(rows, 9) == ([(1, 1), (2, 5), (3, 2)], 1)
assert c.resolve_item([], 1) == ([], 1)

loc = {("wb", 500): 7, ("ozon", 9): 8}
items = {(7, "wb", 111): [{"id": 10, "qty": 1, "completed_at": "2026-07-15"}],
         (8, "ozon", 4988): [{"id": 20, "qty": 3, "completed_at": None}]}

# WB: уехало (поставка закрыта) → out_fbs; статус waiting без закрытой поставки → ничего;
# нет места → gap no_location; нет позиции → no_item; не хватило → insufficient.
tasks = [
    {"rid": "r1", "nm_id": 111, "warehouse_id": 500, "wb_status": "waiting", "supply_id": "S1", "wb_status_at": None, "created_at": "2026-09-01T10:00:00+03:00"},
    {"rid": "r2", "nm_id": 111, "warehouse_id": 500, "wb_status": "waiting", "supply_id": "S2", "wb_status_at": None, "created_at": "2026-09-01T11:00:00+03:00"},
    {"rid": "r3", "nm_id": 111, "warehouse_id": 999, "wb_status": "sold", "supply_id": None, "wb_status_at": "2026-09-02T10:00:00+03:00", "created_at": "2026-09-01T12:00:00+03:00"},
    {"rid": "r4", "nm_id": 222, "warehouse_id": 500, "wb_status": "sorted", "supply_id": None, "wb_status_at": "2026-09-02T10:00:00+03:00", "created_at": "2026-09-01T13:00:00+03:00"},
    {"rid": "r5", "nm_id": 111, "warehouse_id": 500, "wb_status": "sold", "supply_id": None, "wb_status_at": "2026-09-02T10:00:00+03:00", "created_at": "2026-09-01T14:00:00+03:00"},
]
moves, gaps = c.plan_wb(tasks, supplies_closed={"S1"}, loc_by_wh=loc, items=items, existing_out={}, returns=[])
assert [(m["src_ref"], m["kind"], m["qty"], m["ff_inventory_id"]) for m in moves] == [("r1", "out_fbs", -1, 10)], moves
assert sorted((g["src_ref"], g["reason"]) for g in gaps) == [("r3", "no_location"), ("r4", "no_item"), ("r5", "insufficient")], gaps
assert moves[0]["src_kind"] == "wb_fbs_task" and moves[0]["moved_at"] == "2026-09-01T10:00:00+03:00"

# WB: остаток внутри одного прогона расходуется (r1 и r5 на одну штуку — вторая insufficient) — проверено выше.
# WB: отмена после списания → return_in на ту же позицию; отмена без списания → ничего;
# возвратная продажа (R…) по rid со списанием → return_in src_kind wb_fbs_return.
tasks2 = [
    {"rid": "r1", "nm_id": 111, "warehouse_id": 500, "wb_status": "canceled_by_client", "supply_id": "S1", "wb_status_at": "2026-09-03T10:00:00+03:00", "created_at": "2026-09-01T10:00:00+03:00"},
    {"rid": "r6", "nm_id": 111, "warehouse_id": 500, "wb_status": "canceled", "supply_id": None, "wb_status_at": "2026-09-03T10:00:00+03:00", "created_at": "2026-09-01T10:00:00+03:00"},
]
moves, gaps = c.plan_wb(tasks2, supplies_closed={"S1"}, loc_by_wh=loc, items=items, existing_out={"r1": 10},
                        returns=[{"sale_id": "R77", "srid": "r1", "sale_dt": "2026-09-05"}])
kinds = sorted((m["src_kind"], m["src_ref"], m["kind"], m["qty"], m["ff_inventory_id"]) for m in moves)
assert kinds == [("wb_fbs_return", "R77", "return_in", 1, 10), ("wb_fbs_task", "r1", "return_in", 1, 10)], kinds
assert gaps == []

# Ozon: delivered → out_fbs на qty; cancelled без списания → ничего; cancelled со списанием → return_in;
# возврат покупателем → return_in ozon_return.
postings = [
    {"posting_number": "P1", "product_id": 4988, "qty": 2, "warehouse_id": 9, "status": "delivered", "last_change_dt": "2026-09-02T10:00:00Z", "in_process_at": "2026-09-01T10:00:00Z"},
    {"posting_number": "P2", "product_id": 4988, "qty": 1, "warehouse_id": 9, "status": "cancelled", "last_change_dt": "2026-09-02T10:00:00Z", "in_process_at": None},
    {"posting_number": "P3", "product_id": 4988, "qty": 1, "warehouse_id": 9, "status": "cancelled", "last_change_dt": "2026-09-03T10:00:00Z", "in_process_at": None},
    {"posting_number": "P4", "product_id": 4988, "qty": 1, "warehouse_id": 9, "status": "awaiting_packaging", "last_change_dt": None, "in_process_at": "2026-09-05T10:00:00Z"},
]
moves, gaps = c.plan_ozon(postings, loc_by_wh=loc, items=items, existing_out={"P3:4988": 20},
                          returns=[{"posting_number": "P1", "product_id": 4988, "qty": 2}])
got = sorted((m["src_kind"], m["src_ref"], m["kind"], m["qty"], m["ff_inventory_id"]) for m in moves)
assert got == [("ozon_posting", "P1:4988", "out_fbs", -2, 20), ("ozon_posting", "P3:4988", "return_in", 1, 20),
               ("ozon_return", "P1:4988", "return_in", 2, 20)], got
assert gaps == []
print("OK: 9 проверок")
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-fbs-writeoff-core.py`
Expected: `ModuleNotFoundError: No module named 'fbs_writeoff_core'`.

- [ ] **Step 3: `worker/fbs_writeoff_core.py`**

```python
"""
Планировщик авто-списания FBS (спека «Склады 2.0» §3.4). ЧИСТЫЕ функции: вход —
списки из БД, выход — движения и пробелы. Применяет worker/stock_ledger.py.

WB: задание списывается (out_fbs, −1), когда товар физически уехал со склада продавца:
поставка задания закрыта (wb_supplies.closed_at) ИЛИ wb_status ∈ SHIPPED_WB.
Возврат на склад (return_in, +1): статус ∈ RETURNED_WB при уже сделанном списании
(тот же rid, kind другой — уникальность stock_moves позволяет), либо возвратная
продажа wb_sales 'R…' по srid задания (src_kind wb_fbs_return).
Ozon: постинг FBS списывается при статусе ∈ SHIPPED_OZON на qty строки; cancelled
после списания → return_in; возврат покупателем (ozon_sales is_return) → return_in
ozon_return. src_ref Ozon = posting_number:product_id (в постинге несколько товаров).

Место: (platform, warehouse_id) → location_id через stock_ff_locations.
Позиции: (location_id, platform, sku_key) → строки ff_inventory (через ff_inventory_skus),
FIFO по completed_at (NULL последними), затем id. Остаток расходуется в пределах прогона.
Нет места → gap no_location; нет позиций → no_item; не хватило → insufficient.
"""
SHIPPED_WB = {"sorted", "ready_for_pickup", "sold"}
RETURNED_WB = {"canceled_by_client", "declined_by_client", "defect"}
SHIPPED_OZON = {"awaiting_deliver", "delivering", "delivered"}


def resolve_item(rows, qty):
    """FIFO-разнесение qty по строкам позиции. rows: [{id, qty, completed_at}]. Возвращает
    ([(id, take), …], shortage). Мутирует rows[i]["qty"] (остаток в пределах прогона)."""
    ordered = sorted(rows, key=lambda r: (r.get("completed_at") is None, r.get("completed_at") or "", r["id"]))
    out, need = [], int(qty)
    for r in ordered:
        if need <= 0:
            break
        avail = int(r.get("qty") or 0)
        if avail <= 0:
            continue
        take = min(avail, need)
        out.append((r["id"], take))
        r["qty"] = avail - take
        need -= take
    return out, need


def _writeoff(platform, src_kind, src_ref, wh, sku_key, qty, moved_at, loc_by_wh, items, moves, gaps):
    loc = loc_by_wh.get((platform, wh))
    gap = {"src_kind": src_kind, "src_ref": src_ref, "platform": platform, "warehouse_id": wh, "sku_key": sku_key, "qty": qty}
    if loc is None:
        gaps.append({**gap, "reason": "no_location"})
        return
    rows = items.get((loc, platform, sku_key)) or []
    if not rows:
        gaps.append({**gap, "reason": "no_item"})
        return
    parts, shortage = resolve_item(rows, qty)
    if shortage:
        # Частичного списания не делаем: остаток вернуть строкам и записать пробел.
        for r in rows:
            for pid, take in parts:
                if r["id"] == pid:
                    r["qty"] += take
        gaps.append({**gap, "reason": "insufficient"})
        return
    for pid, take in parts:
        moves.append({"ff_inventory_id": pid, "kind": "out_fbs", "qty": -take, "src_kind": src_kind,
                      "src_ref": src_ref if len(parts) == 1 else f"{src_ref}#{pid}",
                      "moved_at": moved_at, "note": None})


def plan_wb(tasks, supplies_closed, loc_by_wh, items, existing_out, returns):
    moves, gaps = [], []
    for t in tasks:
        rid, st = t["rid"], t.get("wb_status")
        shipped = (t.get("supply_id") in supplies_closed) or (st in SHIPPED_WB) or (st in RETURNED_WB and rid in existing_out)
        moved_at = t.get("wb_status_at") or t.get("created_at")
        if rid in existing_out:
            if st in RETURNED_WB:
                moves.append({"ff_inventory_id": existing_out[rid], "kind": "return_in", "qty": 1, "src_kind": "wb_fbs_task",
                              "src_ref": rid, "moved_at": moved_at, "note": f"возврат на склад: {st}"})
            continue
        if not shipped or st in RETURNED_WB or t.get("warehouse_id") is None:
            continue
        _writeoff("wb", "wb_fbs_task", rid, int(t["warehouse_id"]), int(t["nm_id"]), 1, moved_at, loc_by_wh, items, moves, gaps)
    for r in returns:  # wb_sales 'R…' по srid задания
        inv = existing_out.get(r["srid"])
        if inv is None:
            continue
        moves.append({"ff_inventory_id": inv, "kind": "return_in", "qty": 1, "src_kind": "wb_fbs_return",
                      "src_ref": r["sale_id"], "moved_at": r.get("sale_dt"), "note": "возврат покупателя"})
    return moves, gaps


def plan_ozon(postings, loc_by_wh, items, existing_out, returns):
    moves, gaps = [], []
    for p in postings:
        ref = f"{p['posting_number']}:{p['product_id']}"
        st, qty = p.get("status"), int(p.get("qty") or 0)
        moved_at = p.get("last_change_dt") or p.get("in_process_at")
        if ref in existing_out:
            if st == "cancelled":
                moves.append({"ff_inventory_id": existing_out[ref], "kind": "return_in", "qty": qty, "src_kind": "ozon_posting",
                              "src_ref": ref, "moved_at": moved_at, "note": "отмена после отгрузки"})
            continue
        if st not in SHIPPED_OZON or qty <= 0 or p.get("warehouse_id") is None:
            continue
        _writeoff("ozon", "ozon_posting", ref, int(p["warehouse_id"]), int(p["product_id"]), qty, moved_at, loc_by_wh, items, moves, gaps)
    for r in returns:
        ref = f"{r['posting_number']}:{r['product_id']}"
        inv = existing_out.get(ref)
        if inv is None:
            continue
        moves.append({"ff_inventory_id": inv, "kind": "return_in", "qty": int(r.get("qty") or 1), "src_kind": "ozon_return",
                      "src_ref": ref, "moved_at": r.get("moved_at"), "note": "возврат покупателя"})
    return moves, gaps
```

⚠ В тесте `plan_wb` для `tasks` первый сценарий ожидает, что `r1` (waiting, поставка S1 закрыта) списан, а `r2` (waiting, S2 не закрыта) — нет; `r3`/`r4`/`r5` дают три вида пробелов. Если реализация даёт другой порядок движений — тест сравнивает списки в порядке появления, для пробелов — сортированно.

- [ ] **Step 4: Тест проходит**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-fbs-writeoff-core.py` → `OK: 9 проверок`.

- [ ] **Step 5: Тест Python-ledger (SQL-контракт без БД)**

```python
#!/usr/bin/env python3
"""worker/stock_ledger.py: контракт SQL и обработка результатов без БД — курсор подменяется."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker"))
import stock_ledger as L


class FakeCur:
    def __init__(self, script):
        self.script = list(script); self.sql = []; self._row = None
    def execute(self, sql, params=None):
        self.sql.append((sql.strip().split()[0].upper(), params))
        if sql.strip().upper().startswith(("SAVEPOINT", "RELEASE", "ROLLBACK")):
            self._row = None; return
        self._row = self.script.pop(0) if self.script else None
    def fetchone(self):
        return self._row


class FakeConn:
    def __init__(self, script): self.cur = FakeCur(script)
    def cursor(self): return self.cur
    def __enter__(self): return self
    def __exit__(self, *a): return False


moves = [
    {"ff_inventory_id": 10, "kind": "out_fbs", "qty": -1, "src_kind": "wb_fbs_task", "src_ref": "r1", "moved_at": "2026-09-01", "note": None},
    {"ff_inventory_id": 10, "kind": "out_fbs", "qty": -1, "src_kind": "wb_fbs_task", "src_ref": "r1", "moved_at": "2026-09-01", "note": None},
    {"ff_inventory_id": 11, "kind": "out_fbs", "qty": -5, "src_kind": "wb_fbs_task", "src_ref": "r9", "moved_at": "2026-09-01", "note": None},
]
# script: SELECT location → INSERT RETURNING → UPDATE RETURNING; дубль: SELECT → INSERT (None);
# insufficient: SELECT → INSERT → UPDATE (None)
conn = FakeConn([{"location_id": 7}, {"id": 1}, {"qty": 0},
                 {"location_id": 7}, None,
                 {"location_id": 7}, {"id": 2}, None])
res = L.apply_moves_conn(conn, moves)
assert res == {"applied": 1, "duplicate": 1, "insufficient": ["r9"]}, res
ops = [s for s, _ in conn.cur.sql]
assert ops.count("SAVEPOINT") == 3 and ops.count("ROLLBACK") == 1 and ops.count("RELEASE") == 2, ops
ins = [p for s, p in conn.cur.sql if s == "INSERT"][0]
assert ins[:6] == (10, 7, "out_fbs", -1, "wb_fbs_task", "r1"), ins
print("OK: 3 проверки")
```

- [ ] **Step 6: `worker/stock_ledger.py`**

```python
"""
Python-ledger остатков (спека «Склады 2.0» §3.3) — зеркало lib/stockLedger.js для
воркера. Тот же SQL-контракт: INSERT в stock_moves с ON CONFLICT (stock_moves_src_uq)
DO NOTHING → дубль = no-op; UPDATE ff_inventory с проверкой неотрицательности (кроме
adjust). Батч — одна транзакция, SAVEPOINT на движение: нехватка остатка откатывает
только своё движение и попадает в insufficient (сборщик пишет gap), остальные
применяются. Единственное место в воркере, где меняется ff_inventory.qty.
"""
import db_pg

_SQL_LOC = "SELECT location_id FROM tenant.ff_inventory WHERE id = %s AND archived_at IS NULL FOR UPDATE"
_SQL_INS = ("INSERT INTO tenant.stock_moves (cabinet_id, ff_inventory_id, location_id, kind, qty, src_kind, src_ref, moved_at, note) "
            "VALUES (current_setting('app.cabinet_id')::bigint, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (cabinet_id, src_kind, src_ref, kind) DO NOTHING RETURNING id")
_SQL_UPD = ("UPDATE tenant.ff_inventory SET qty = qty + %s, updated_at = now() "
            "WHERE id = %s AND (%s OR qty + %s >= 0) RETURNING qty")


def apply_moves_conn(conn, moves):
    res = {"applied": 0, "duplicate": 0, "insufficient": []}
    cur = conn.cursor()
    for i, m in enumerate(moves):
        sp = f"mv{i}"
        cur.execute(f"SAVEPOINT {sp}")
        cur.execute(_SQL_LOC, (m["ff_inventory_id"],))
        row = cur.fetchone()
        loc = row["location_id"] if row else None
        cur.execute(_SQL_INS, (m["ff_inventory_id"], loc, m["kind"], m["qty"], m["src_kind"], m["src_ref"], m["moved_at"], m.get("note")))
        if cur.fetchone() is None:
            res["duplicate"] += 1
            cur.execute(f"RELEASE SAVEPOINT {sp}")
            continue
        cur.execute(_SQL_UPD, (m["qty"], m["ff_inventory_id"], m["kind"] == "adjust", m["qty"]))
        if cur.fetchone() is None:
            cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
            res["insufficient"].append(m["src_ref"])
            continue
        cur.execute(f"RELEASE SAVEPOINT {sp}")
        res["applied"] += 1
    return res


def apply_moves(moves):
    if not moves:
        return {"applied": 0, "duplicate": 0, "insufficient": []}
    with db_pg.get_connection() as conn:
        return apply_moves_conn(conn, moves)


def record_gaps(gaps):
    """Открытые пробелы: новый — INSERT, существующий — reason/last_seen_at обновить, resolved_at снять."""
    if not gaps:
        return 0
    cid = db_pg._cabinet_id()
    with db_pg.get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO tenant.stock_move_gaps (cabinet_id, src_kind, src_ref, platform, warehouse_id, sku_key, qty, reason) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (cabinet_id, src_kind, src_ref) DO UPDATE SET reason=EXCLUDED.reason, warehouse_id=EXCLUDED.warehouse_id, "
                "sku_key=EXCLUDED.sku_key, qty=EXCLUDED.qty, last_seen_at=now(), resolved_at=NULL",
                [[cid, g["src_kind"], g["src_ref"], g["platform"], g.get("warehouse_id"), g.get("sku_key"), g["qty"], g["reason"]] for g in gaps])
    return len(gaps)


def resolve_gaps(src_kind, src_refs):
    """Пробелы, по которым движение теперь создано, закрываются."""
    if not src_refs:
        return 0
    with db_pg.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE tenant.stock_move_gaps SET resolved_at = now() "
                        "WHERE src_kind = %s AND resolved_at IS NULL AND src_ref = ANY(%s)", (src_kind, list(src_refs)))
            return cur.rowcount
```

- [ ] **Step 7: Тест ledger проходит**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/test-stock-ledger-py.py` → `OK: 3 проверки`.

- [ ] **Step 8: Чтение источников в `db_pg.py`** (после `seller_warehouse_ids`)

```python
# --- авто-списание FBS (план «Склады 2.0», этап 2) ---
def locations_by_warehouse():
    """{(platform, warehouse_id): location_id} по активным местам с привязкой."""
    out = {}
    for r in query("SELECT id, wb_warehouse_id, ozon_warehouse_id FROM tenant.stock_ff_locations WHERE is_active"):
        if r["wb_warehouse_id"] is not None:
            out[("wb", int(r["wb_warehouse_id"]))] = int(r["id"])
        if r["ozon_warehouse_id"] is not None:
            out[("ozon", int(r["ozon_warehouse_id"]))] = int(r["id"])
    return out


def fbs_items_by_location():
    """{(location_id, platform, sku_key): [{id, qty, completed_at}]} — активные позиции с местом
    и привязкой артикула (ff_inventory_skus)."""
    out = {}
    for r in query(
            "SELECT f.id, f.qty, f.completed_at::text AS completed_at, f.location_id, s.platform, "
            "COALESCE(s.nm_id, s.product_id) AS sku_key "
            "FROM tenant.ff_inventory f JOIN tenant.ff_inventory_skus s "
            "  ON s.cabinet_id = f.cabinet_id AND s.ff_inventory_id = f.id "
            "WHERE f.archived_at IS NULL AND f.location_id IS NOT NULL"):
        key = (int(r["location_id"]), r["platform"], int(r["sku_key"]))
        out.setdefault(key, []).append({"id": int(r["id"]), "qty": int(r["qty"] or 0), "completed_at": r["completed_at"]})
    return out


def existing_out_moves(src_kind):
    """{src_ref: ff_inventory_id} уже сделанных out_fbs по источнику (для return_in и идемпотентности).
    src_ref вида 'ref#<id>' (разнесено по нескольким позициям) сводится к 'ref' → первая позиция."""
    out = {}
    for r in query("SELECT src_ref, ff_inventory_id FROM tenant.stock_moves WHERE src_kind = %s AND kind = 'out_fbs' ORDER BY id", (src_kind,)):
        base = r["src_ref"].split("#", 1)[0]
        out.setdefault(base, int(r["ff_inventory_id"]))
    return out


def wb_fbs_tasks_for_writeoff():
    return query("SELECT rid, nm_id, warehouse_id, supply_id, wb_status, wb_status_at::text AS wb_status_at, "
                 "created_at::text AS created_at FROM tenant.wb_fbs_tasks WHERE nm_id IS NOT NULL")


def wb_supplies_closed():
    return {r["supply_id"] for r in query("SELECT supply_id FROM tenant.wb_supplies WHERE closed_at IS NOT NULL")}


def wb_fbs_returns():
    return query("SELECT s.sale_id, s.srid, s.sale_dt FROM tenant.wb_sales s "
                 "JOIN tenant.wb_fbs_tasks t ON t.cabinet_id = s.cabinet_id AND t.rid = s.srid "
                 "WHERE s.sale_id LIKE 'R%%'")


def ozon_fbs_postings_for_writeoff():
    return query("SELECT posting_number, product_id, qty, warehouse_id, status, last_change_dt, in_process_at "
                 "FROM tenant.ozon_orders WHERE scheme = 'fbs'")


def ozon_fbs_returns():
    return query("SELECT posting_number, product_id, qty, last_change_dt AS moved_at FROM tenant.ozon_sales "
                 "WHERE scheme = 'fbs' AND is_return = 1")
```
(В `wb_fbs_returns` `'R%%'` — экранирование `%` для psycopg при передаче без параметров; если `query()` вызывается без `params`, использовать `'R%'` и проверить, что psycopg не ругается — при `params=()` psycopg **не** интерпретирует `%`; оставить `'R%'` и `params=()`.)

- [ ] **Step 9: Commit**

```bash
git add worker/stock_ledger.py worker/fbs_writeoff_core.py worker/db_pg.py scripts/test-fbs-writeoff-core.py scripts/test-stock-ledger-py.py
git commit -m "feat(ledger): python-ledger с savepoint на движение и чистый планировщик списаний FBS"
```

---

### Task 5: Сборщик `wb_fbs_writeoff`

**Files:**
- Create: `worker/collectors/wb_fbs_writeoff.py`
- Modify: `worker/orchestrator.py` (`WB_COLLECTORS` после `"wb_fbs_status"`), `worker/run_saas_collect.sh` (`FBSSTATUS_COLLECTORS="wb_fbs_status,wb_fbs_writeoff"` и `MAIN_COLLECTORS` — дописать `,wb_fbs_writeoff` в конец)

**Interfaces:**
- Consumes: задача 4 целиком, `_probe`.
- Produces: движения `out_fbs`/`return_in` по WB-заданиям и возвратам; пробелы в `stock_move_gaps`; лог `[wb_fbs_writeoff] задания N: списано A, дублей D, не хватило I, пробелов G (no_location/no_item/insufficient = …), закрыто пробелов R`; `##OBS rows=<applied>`.

- [ ] **Step 1: Сборщик**

```python
"""
SaaS-сборщик АВТО-СПИСАНИЯ FBS WB → tenant.stock_moves / stock_move_gaps (спека §3.4).

Источники (всё из БД, API не трогает): tenant.wb_fbs_tasks (статусы часового опроса),
wb_supplies.closed_at, wb_sales 'R…' по srid. План — worker/fbs_writeoff_core.plan_wb,
запись — worker/stock_ledger.apply_moves (идемпотентно по stock_moves_src_uq).
Тик fbsstatus (часовой, после wb_fbs_status) и main. SAAS_PROBE=1 — печатает план
и не пишет. Идемпотентен: повторный прогон → 0 applied, N duplicate.
"""
import os
import sys
from collections import Counter
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe
import fbs_writeoff_core as core
import stock_ledger


def collect():
    print(f"[wb_fbs_writeoff] авто-списание FBS WB ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    tasks = db_pg.wb_fbs_tasks_for_writeoff()
    moves, gaps = core.plan_wb(
        tasks, supplies_closed=db_pg.wb_supplies_closed(), loc_by_wh=db_pg.locations_by_warehouse(),
        items=db_pg.fbs_items_by_location(), existing_out=db_pg.existing_out_moves("wb_fbs_task"),
        returns=db_pg.wb_fbs_returns())
    if _probe.is_probe():
        _probe.dump("план движений", moves, n=10)
        _probe.dump("пробелы", gaps, n=10)
        return 0
    res = stock_ledger.apply_moves(moves)
    for ref in res["insufficient"]:
        base = ref.split("#", 1)[0]
        t = next((x for x in tasks if x["rid"] == base), None)
        gaps.append({"src_kind": "wb_fbs_task", "src_ref": base, "platform": "wb",
                     "warehouse_id": t and t.get("warehouse_id"), "sku_key": t and t.get("nm_id"), "qty": 1, "reason": "insufficient"})
    stock_ledger.record_gaps(gaps)
    done_refs = {m["src_ref"].split("#", 1)[0] for m in moves if m["src_kind"] == "wb_fbs_task" and m["src_ref"].split("#", 1)[0] not in {r.split("#", 1)[0] for r in res["insufficient"]}}
    resolved = stock_ledger.resolve_gaps("wb_fbs_task", done_refs)
    by = Counter(g["reason"] for g in gaps)
    print(f"[wb_fbs_writeoff] задания {len(tasks)}: списано {res['applied']}, дублей {res['duplicate']}, "
          f"не хватило {len(res['insufficient'])}, пробелов {len(gaps)} (no_location {by['no_location']}, "
          f"no_item {by['no_item']}, insufficient {by['insufficient']}), закрыто пробелов {resolved}", flush=True)
    print(f"##OBS rows={res['applied']}", flush=True)
    return res["applied"]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 2: Регистрация**

`orchestrator.py` `WB_COLLECTORS`: после `"wb_fbs_status",` добавить `"wb_fbs_writeoff", # авто-списание FBS → stock_moves (после wb_fbs_status: читает его статусы; читает wb_sales из main)`.
`run_saas_collect.sh`: `FBSSTATUS_COLLECTORS="wb_fbs_status,wb_fbs_writeoff"`; в `MAIN_COLLECTORS` дописать `,wb_fbs_writeoff` в конец.

- [ ] **Step 3: Проба → прогон → идемпотентность**

Run: `SAAS_PROBE=1 ORCH --collectors wb_fbs_writeoff` (полный вывод — прямым запуском модуля с env оркестратора, как в этапе 1). Ожидание на 06.09: план пуст, пробелы — почти все задания с `no_location` (у позиций нет мест). Если владелец уже расставил места и привязал склады — появятся движения; проверить 2–3 из них руками по `wb_fbs_tasks`.

Run: `ORCH --collectors wb_fbs_writeoff` дважды. Второй прогон: `списано 0`, `дублей` = число движений первого. Проверки:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT kind, src_kind, COUNT(*), SUM(qty) FROM tenant.stock_moves WHERE cabinet_id=1 AND src_kind IN ('wb_fbs_task','wb_fbs_return') GROUP BY 1,2; SELECT reason, COUNT(*) FROM tenant.stock_move_gaps WHERE cabinet_id=1 AND platform='wb' AND resolved_at IS NULL GROUP BY 1; SELECT COUNT(*) FROM (SELECT f.id, f.qty, COALESCE(SUM(m.qty),0) s FROM tenant.ff_inventory f LEFT JOIN tenant.stock_moves m ON m.cabinet_id=f.cabinet_id AND m.ff_inventory_id=f.id WHERE f.cabinet_id=1 GROUP BY 1,2) x WHERE qty<>s"
```
Expected: последняя цифра `0` (инвариант); число пробелов + движений `out_fbs` = число заданий с признаком отгрузки.

- [ ] **Step 4: Commit**

```bash
git add worker/collectors/wb_fbs_writeoff.py worker/orchestrator.py worker/run_saas_collect.sh
git commit -m "feat(ledger): авто-списание FBS WB по заданиям и возвратам"
```

---

### Task 6: Сборщик `ozon_fbs_writeoff`

**Files:**
- Create: `worker/collectors/ozon_fbs_writeoff.py`
- Modify: `worker/orchestrator.py` (`OZON_COLLECTORS` после `"ozon_sales",`), `worker/run_saas_collect.sh` (`MAIN_COLLECTORS` — дописать `,ozon_fbs_writeoff`)

**Interfaces:**
- Consumes: задача 4, `_probe`.
- Produces: движения по постингам Ozon FBS и возвратам; пробелы; лог как у WB с префиксом `[ozon_fbs_writeoff]`.

- [ ] **Step 1: Сборщик** — копия WB-сборщика с заменами: докстринг «FBS Ozon: tenant.ozon_orders scheme='fbs', ozon_sales is_return; план — plan_ozon»; вызов:

```python
    postings = db_pg.ozon_fbs_postings_for_writeoff()
    moves, gaps = core.plan_ozon(
        postings, loc_by_wh=db_pg.locations_by_warehouse(), items=db_pg.fbs_items_by_location(),
        existing_out=db_pg.existing_out_moves("ozon_posting"), returns=db_pg.ozon_fbs_returns())
```
Пробелы `insufficient` строятся по `base = ref.split("#",1)[0]` → `posting_number, product_id = base.split(":")`, `qty` из постинга, `platform="ozon"`, `src_kind="ozon_posting"`. `resolve_gaps("ozon_posting", …)`. Префиксы логов `[ozon_fbs_writeoff]`.

- [ ] **Step 2: Регистрация** — `OZON_COLLECTORS` после `"ozon_sales",`: `"ozon_fbs_writeoff",  # авто-списание FBS → stock_moves (после ozon_orders/ozon_sales)`; `MAIN_COLLECTORS` дописать `,ozon_fbs_writeoff`.

- [ ] **Step 3: Проба → прогон дважды → проверки** — как в задаче 5, с `platform='ozon'` и `src_kind IN ('ozon_posting','ozon_return')`. Инвариант `qty = SUM(moves)` = 0 расхождений.

- [ ] **Step 4: Commit**

```bash
git add worker/collectors/ozon_fbs_writeoff.py worker/orchestrator.py worker/run_saas_collect.sh
git commit -m "feat(ledger): авто-списание FBS Ozon по постингам и возвратам"
```

---

### Task 7: Перемещение ФФ→ФФ (API + модалка) и баннер расхождений

**Files:**
- Create: `app/api/cabinets/[id]/transfers/route.js`, `app/cabinets/[id]/inventory/TransferFormModal.jsx`
- Modify: `app/api/cabinets/[id]/inventory/route.js` (GET: `ledger`), `app/cabinets/[id]/inventory/InventoryPage.jsx` (кнопка «⇄ Перемещение», баннер)

**Interfaces:**
- Consumes: `normalizeTransferDoc`, `applyTransfer` (задача 2).
- Produces: GET `/transfers` → `{ docs:[{id, from_location_id, from_name, to_location_id, to_name, moved_at, note, lines:[{ff_inventory_id, to_ff_inventory_id, qty, item_name}]}] }`; POST `/transfers {action:"create", from_location_id, to_location_id, moved_at?, note?, lines:[{ff_inventory_id, qty}]}` → `{ ok, id }`; 400 при нехватке остатка (весь документ откатывается). GET `/inventory` → `ledger: { mismatch: N, gaps: { no_location, no_item, insufficient } }`.

- [ ] **Step 1: `transfers/route.js`**

```js
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { normalizeTransferDoc } from "@/lib/stockMoves.js";
import { applyTransfer } from "@/lib/stockLedger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/cabinets/[id]/transfers — перемещения ФФ→ФФ (спека «Склады 2.0» §3.6).
// Документ = откуда, куда, дата, строки. Создание: ff_transfer_docs + lines, затем
// applyTransfer по строкам (transfer_out/transfer_in) — при нехватке остатка на любой
// строке withTenant откатывает всё. Без стадии «в пути»: перемещение мгновенное.
export const GET = withCabinet(async () => {
  const docs = await tenantQuery(
    `SELECT d.id, d.from_location_id, lf.name AS from_name, d.to_location_id, lt.name AS to_name,
            d.moved_at, d.note, d.created_at
     FROM tenant.ff_transfer_docs d
     LEFT JOIN tenant.stock_ff_locations lf ON lf.cabinet_id = d.cabinet_id AND lf.id = d.from_location_id
     LEFT JOIN tenant.stock_ff_locations lt ON lt.cabinet_id = d.cabinet_id AND lt.id = d.to_location_id
     ORDER BY d.moved_at DESC, d.id DESC LIMIT 200`
  );
  const lines = await tenantQuery(
    `SELECT l.doc_id, l.ff_inventory_id, l.to_ff_inventory_id, l.qty,
            COALESCE(f.internal_name, f.sku_name, '(скрыто)') AS item_name
     FROM tenant.ff_transfer_lines l
     LEFT JOIN tenant.ff_inventory f ON f.cabinet_id = l.cabinet_id AND f.id = l.ff_inventory_id`
  );
  const byDoc = new Map();
  for (const ln of lines) { if (!byDoc.has(ln.doc_id)) byDoc.set(ln.doc_id, []); byDoc.get(ln.doc_id).push(ln); }
  return NextResponse.json({ docs: docs.map((d) => ({ ...d, lines: byDoc.get(d.id) || [] })) });
});

export const POST = withCabinet(async (req, { session }) => {
  const b = await req.json();
  if (b.action !== "create") return NextResponse.json({ error: `unknown action: ${b.action}` }, { status: 400 });
  const n = normalizeTransferDoc(b);
  if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
  const { fromLocationId, toLocationId, movedAt, note, lines } = n.doc;
  const userId = session?.user_id ?? null;
  // Все строки должны лежать на месте-источнике.
  const ids = lines.map((l) => l.ffInventoryId);
  const wrong = await tenantQuery(
    `SELECT id FROM tenant.ff_inventory WHERE id = ANY($1::bigint[]) AND (location_id IS DISTINCT FROM $2 OR archived_at IS NOT NULL)`,
    [ids, fromLocationId]
  );
  if (wrong.length) return NextResponse.json({ error: `позиции не на месте-источнике: ${wrong.map((w) => w.id).join(", ")}` }, { status: 400 });
  const doc = (await tenantQuery(
    `INSERT INTO tenant.ff_transfer_docs (cabinet_id, from_location_id, to_location_id, moved_at, note, created_by)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5) RETURNING id`,
    [fromLocationId, toLocationId, movedAt, note, userId]
  ))[0];
  try {
    for (const [i, ln] of lines.entries()) {
      const { toFfInventoryId } = await applyTransfer({ ffInventoryId: ln.ffInventoryId, toLocationId, qty: ln.qty,
        docId: doc.id, lineNo: i + 1, movedAt, userId });
      await tenantQuery(
        `INSERT INTO tenant.ff_transfer_lines (cabinet_id, doc_id, ff_inventory_id, to_ff_inventory_id, qty)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4)`,
        [doc.id, ln.ffInventoryId, toFfInventoryId, ln.qty]
      );
    }
  } catch (e) {
    if (String(e?.message).startsWith("insufficient")) throw Object.assign(new Error("недостаточно остатка: " + e.message), { status: 400 });
    throw e;
  }
  return NextResponse.json({ ok: true, id: doc.id });
}, { requireRole: "manager" });
```
(Если `withCabinet` не превращает `err.status` в HTTP-код — вернуть `NextResponse.json({error}, {status:400})` нельзя после начала записи без отката; тогда проверить остаток заранее: `SELECT id, qty FROM ff_inventory WHERE id = ANY($1)` и сравнить с `lines` до INSERT документа, а `applyTransfer` оставить как страховку. Посмотреть `lib/withCabinet.js`, как обрабатываются исключения, и выбрать один из двух вариантов; записать в отчёт.)

- [ ] **Step 2: GET `/inventory` — `ledger`**

В GET перед `return`:
```js
  const mm = (await tenantQuery(
    `SELECT COUNT(*)::int AS mismatch FROM tenant.ff_inventory f
     LEFT JOIN (SELECT ff_inventory_id, SUM(qty) AS s FROM tenant.stock_moves GROUP BY 1) m ON m.ff_inventory_id = f.id
     WHERE f.archived_at IS NULL AND f.qty <> COALESCE(m.s, 0)`
  ))[0];
  const gp = await tenantQuery(
    `SELECT reason, COUNT(*)::int AS n FROM tenant.stock_move_gaps WHERE resolved_at IS NULL GROUP BY reason`
  );
  const ledger = { mismatch: mm?.mismatch ?? 0, gaps: Object.fromEntries(gp.map((g) => [g.reason, g.n])) };
```
и добавить `ledger` в JSON-ответ.

- [ ] **Step 3: UI**

`InventoryPage.jsx`: под шапкой страницы — баннер (стиль `ALERT` из `@/lib/callout.js`, как на `/move`):
- если `data.ledger.mismatch > 0` — красный: «Остаток {N} позиций не сходится с журналом движений — сообщите разработчику»;
- если сумма `gaps` > 0 — жёлтый: «Не разнесено FBS-заданий: {no_location} без места, {no_item} без позиции, {insufficient} не хватило остатка. Проверьте привязку складов в «📍 Места» и места у позиций».

Кнопка «⇄ Перемещение» рядом с «📍 Места» открывает `TransferFormModal` (по образцу `../shipments/ShipmentFormModal.jsx`): селект «Откуда» (места), селект «Куда» (места, кроме выбранного), дата, комментарий, строки: селект позиции (только позиции с `location_id === from`, показывать `internal_name`/`sku_name` и остаток) + qty, «+ строка», «Переместить» → POST `/transfers`; ошибку показывать `alert`; после успеха `reload()`.

- [ ] **Step 4: Сборка**

Run: `cd /opt/agents/saas && npm run build 2>&1 | tail -3` — без ошибок (проверка JSX и алиасов `@/lib/stockLedger.js`). `saas-web` не перезапускать.

- [ ] **Step 5: Commit**

```bash
git add "app/api/cabinets/[id]/transfers/route.js" "app/cabinets/[id]/inventory/TransferFormModal.jsx" "app/api/cabinets/[id]/inventory/route.js" "app/cabinets/[id]/inventory/InventoryPage.jsx"
git commit -m "feat(ledger): перемещение ФФ→ФФ документом; баннер расхождений и пробелов на /inventory"
```

---

### Task 8: SQL-сторож этапа 2

**Files:**
- Create: `scripts/check-warehouses-stage2.sql`

- [ ] **Step 1: Сторож**

```sql
-- Смоук-сторож «Склады 2.0», этап 2 «Учёт». Запуск:
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage2.sql
-- Все проверки должны отдать ok=t (кабинет #1; под saas_ro RLS не скоупит — WHERE явно).

-- 1. Инвариант ledger: остаток каждой позиции = сумма её движений
SELECT 'ledger_invariant' AS check,
       COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s, 0)) = 0 AS ok,
       COUNT(*) AS positions, COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s, 0)) AS mismatch
FROM tenant.ff_inventory f
LEFT JOIN (SELECT ff_inventory_id, SUM(qty) AS s FROM tenant.stock_moves WHERE cabinet_id=1 GROUP BY 1) m
       ON m.ff_inventory_id = f.id
WHERE f.cabinet_id=1;

-- 2. Начальное сальдо записано для всех ненулевых позиций на момент миграции
SELECT 'opening_balance' AS check,
       COUNT(*) > 0 AND COUNT(*) FILTER (WHERE kind <> 'adjust' OR src_kind <> 'manual') = 0 AS ok,
       COUNT(*) AS opening_moves, SUM(qty) AS opening_qty
FROM tenant.stock_moves WHERE cabinet_id=1 AND src_ref LIKE 'opening:%';

-- 3. Дублей источника нет (уникальный индекс держит; проверка на всякий случай)
SELECT 'no_duplicate_sources' AS check,
       COUNT(*) = 0 AS ok, COUNT(*) AS dups
FROM (SELECT src_kind, src_ref, kind FROM tenant.stock_moves WHERE cabinet_id=1 GROUP BY 1,2,3 HAVING COUNT(*) > 1) d;

-- 4. Каждое отгруженное WB-задание с warehouse_id либо списано, либо в открытом пробеле
SELECT 'wb_tasks_accounted' AS check,
       COUNT(*) > 0 AND COUNT(*) FILTER (WHERE mv.src_ref IS NULL AND g.src_ref IS NULL) = 0 AS ok,
       COUNT(*) AS shipped_tasks,
       COUNT(mv.src_ref) AS written_off, COUNT(g.src_ref) AS gaps_open,
       COUNT(*) FILTER (WHERE mv.src_ref IS NULL AND g.src_ref IS NULL) AS unaccounted
FROM tenant.wb_fbs_tasks t
LEFT JOIN tenant.wb_supplies s ON s.cabinet_id=t.cabinet_id AND s.supply_id=t.supply_id
LEFT JOIN (SELECT DISTINCT split_part(src_ref,'#',1) AS src_ref FROM tenant.stock_moves WHERE cabinet_id=1 AND src_kind='wb_fbs_task' AND kind='out_fbs') mv ON mv.src_ref=t.rid
LEFT JOIN tenant.stock_move_gaps g ON g.cabinet_id=t.cabinet_id AND g.src_kind='wb_fbs_task' AND g.src_ref=t.rid AND g.resolved_at IS NULL
WHERE t.cabinet_id=1 AND t.warehouse_id IS NOT NULL AND t.nm_id IS NOT NULL
  AND (s.closed_at IS NOT NULL OR t.wb_status IN ('sorted','ready_for_pickup','sold'))
  AND COALESCE(t.wb_status,'') NOT IN ('canceled_by_client','declined_by_client','defect');

-- 5. То же для Ozon FBS-постингов
SELECT 'ozon_postings_accounted' AS check,
       COUNT(*) > 0 AND COUNT(*) FILTER (WHERE mv.src_ref IS NULL AND g.src_ref IS NULL) = 0 AS ok,
       COUNT(*) AS shipped_postings, COUNT(mv.src_ref) AS written_off, COUNT(g.src_ref) AS gaps_open
FROM tenant.ozon_orders o
LEFT JOIN (SELECT DISTINCT split_part(src_ref,'#',1) AS src_ref FROM tenant.stock_moves WHERE cabinet_id=1 AND src_kind='ozon_posting' AND kind='out_fbs') mv
       ON mv.src_ref = o.posting_number||':'||o.product_id
LEFT JOIN tenant.stock_move_gaps g ON g.cabinet_id=o.cabinet_id AND g.src_kind='ozon_posting' AND g.src_ref=o.posting_number||':'||o.product_id AND g.resolved_at IS NULL
WHERE o.cabinet_id=1 AND o.scheme='fbs' AND o.warehouse_id IS NOT NULL AND o.status IN ('awaiting_deliver','delivering','delivered');

-- 6. Возвраты не превышают списаний по той же позиции и источнику
SELECT 'returns_not_exceed' AS check, COUNT(*) = 0 AS ok, COUNT(*) AS bad
FROM (SELECT ff_inventory_id, split_part(src_ref,'#',1) AS ref,
             SUM(qty) FILTER (WHERE kind='out_fbs') AS out_q, SUM(qty) FILTER (WHERE kind='return_in') AS ret_q
      FROM tenant.stock_moves WHERE cabinet_id=1 AND src_kind IN ('wb_fbs_task','ozon_posting') GROUP BY 1,2
      HAVING COALESCE(SUM(qty) FILTER (WHERE kind='return_in'),0) > -COALESCE(SUM(qty) FILTER (WHERE kind='out_fbs'),0)) x;
```

- [ ] **Step 2: Прогнать**

Run: `psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage2.sql` → 6 строк `ok=t`. Проверки 4–5 требуют, чтобы задачи 5–6 отработали на кабинете #1.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-warehouses-stage2.sql
git commit -m "test(ledger): sql-сторож этапа 2 «Учёт»"
```

---

### Task 9: Документация, деплой, первый плановый тик

**Files:**
- Modify: `AGENTS.md` (после подраздела «Склады 2.0 — этап 1»), спека §3.1, §3.2, §3.3, §3.4, §3.6

- [ ] **Step 1: AGENTS.md — подраздел «Склады 2.0 — этап 2 „Учёт" (с 2026-09-06)»**

```markdown
### 🆕 Склады 2.0 — этап 2 «Учёт» (с 2026-09-06)

План `docs/superpowers/plans/2026-09-06-warehouses-stage2-ledger.md`. Миграция 053.

- **Журнал движений** `tenant.stock_moves` — единственный путь изменения `ff_inventory.qty`:
  панель — `lib/stockLedger.js` (`applyMove`, `applyTransfer`, внутри транзакции withTenant),
  воркер — `worker/stock_ledger.py` (`apply_moves`, savepoint на движение). Уникальность
  источника `(src_kind, src_ref, kind)` → повтор = no-op. Прямых `UPDATE ff_inventory SET qty`
  в коде нет (проверка: `grep -rn "SET qty" app lib worker --include=*.js --include=*.py`).
- **Виды**: in (закупка/ручное добавление), out_fbo (документ отгрузки), out_fbs (FBS-заказ),
  transfer_out/transfer_in (перемещение ФФ→ФФ, `/transfers`), adjust (ручная правка — причина
  обязательна; удаление документа отгрузки), return_in (отмена после отгрузки, возврат покупателя).
- **Авто-списание FBS**: `wb_fbs_writeoff` (тики fbsstatus + main) и `ozon_fbs_writeoff` (main);
  правила — `worker/fbs_writeoff_core.py` (чистые функции, тест `scripts/test-fbs-writeoff-core.py`).
  Место = `stock_ff_locations` по `wb_warehouse_id/ozon_warehouse_id`; позиция = `ff_inventory_skus`
  по артикулу на этом месте, FIFO по `completed_at`. Не разнесённые → `tenant.stock_move_gaps`
  (no_location / no_item / insufficient; `resolved_at` при успехе) — баннер на `/inventory`.
- **Привязка артикулов**: `ff_inventory_skus` (много артикулов обеих площадок на позицию) — так
  было с 2026-07-18, отдельная «двойная привязка» не понадобилась.
- **Сторож**: `scripts/check-warehouses-stage2.sql` (6 проверок). Инвариант qty = Σ движений также
  отдаётся GET `/inventory` → `ledger.mismatch` (не в `/health`: tenant-таблицы под RLS).
- Первые содержательные списания появятся после того, как владелец расставит места у позиций
  и привяжет склады продавца к местам (на 06.09 у всех 12 позиций кабинета #1 места нет).
```

- [ ] **Step 2: Спека**

§3.1: заменить абзац на «Реализовано ранее: с 2026-07-18 привязка живёт в `tenant.ff_inventory_skus` (много артикулов обеих площадок на одну позицию, уникальность по частичным индексам). Колонки `nm_id/product_id/platform` в `ff_inventory` — dead back-compat. Этап 2 использует `ff_inventory_skus` для поиска позиции по артикулу.»
§3.2: `location_id` — «NULL, если у позиции нет места»; в `src_ref` для разнесения по нескольким партиям — суффикс `#<ff_inventory_id>`.
§3.3: заменить «сторож-запрос … в `/health`» на «в GET `/inventory` (`ledger.mismatch`) + баннер + `check-warehouses-stage2.sql`; `/health` не видит tenant-таблицы под RLS». Дописать: удаление документа отгрузки = `adjust` с причиной; ручная правка = `adjust` с обязательной причиной.
§3.4: правила признака отгрузки WB (`closed_at` поставки или статус sorted/ready_for_pickup/sold) и Ozon (awaiting_deliver/delivering/delivered); возвраты — как в докстринге `fbs_writeoff_core.py`.
§3.6: строка документа хранит `to_ff_inventory_id`; приёмник ищется по `internal_name`+`unit_cost` на месте назначения, иначе создаётся копия с привязками.

- [ ] **Step 3 (контроллер): деплой и первый тик**

```bash
cd /opt/agents/saas && npm run build 2>&1 | tail -3 && systemctl restart saas-web && sleep 4 && systemctl is-active saas-web
grep -n "wb_fbs_writeoff\|ozon_fbs_writeoff" worker/run_saas_collect.sh
```
Expected: `active`; три совпадения (`MAIN_COLLECTORS` ×2, `FBSSTATUS_COLLECTORS`). После ближайшего часового тика `saas-fbs-status`: `jobs.collector_runs` содержит `wb_fbs_writeoff` со статусом `ok`; после main-тика — `ozon_fbs_writeoff` `ok` на всех Ozon-кабинетах.

- [ ] **Step 4: Приёмка владельцем** — на `/cabinets/1/inventory`: (1) задать место у 2–3 позиций и убедиться, что после часового тика пробелы по ним закрылись, а остаток уменьшился на число отгруженных заданий; (2) поменять qty руками — панель просит причину; (3) создать перемещение ФФ→ФФ и увидеть `transfer_out/transfer_in` в `stock_moves`.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md
git commit -m "docs(ledger): этап 2 «Учёт» — журнал движений, авто-списание FBS, перемещения"
```

---

## Self-review

**Покрытие спеки (раздел 3):** §3.1 двойная привязка — уже есть (`ff_inventory_skus`), спека правится в задаче 9; §3.2 `stock_moves` + уникальность → задача 1; §3.3 `applyMove`/`applyTransfer`, перевод существующих правок, начальное сальдо, сторож → задачи 2, 3, 1, 8 (+ GET `/inventory` вместо `/health`, задача 7); §3.4 авто-списание, gaps, отмены/возвраты → задачи 4, 5, 6; §3.5 расхождение с МП «на лету» — витрина этапа 4, данные (`mp_fbs_daily_stock`) есть с этапа 1, в этом плане не требуется; §3.6 перемещение → задачи 1, 2, 7; §6 «Этап 2» (инвариант, число out_fbs = число отгруженных минус пробелы, идемпотентность, откат документа при нехватке) → задачи 5, 6, 8, 3/7.

**Плейсхолдеры:** нет. Два места с явной развилкой (`session` в `withCabinet`, обработка исключений в `/transfers`) дают оба варианта и требуют записать выбор в отчёт.

**Согласованность имён:** `normalizeMove/normalizeTransferDoc/SIGN/KINDS/SRC_KINDS` (2) ← 3, 7; `applyMove(input)` возвращает `{applied,id,newQty}|{applied:false,duplicate:true}` (2) ← 3; `applyTransfer(...) -> {toFfInventoryId}` (2) ← 7; `resolve_item/plan_wb/plan_ozon` и формы `move`/`gap` (4) ← 5, 6, тесты; `apply_moves/apply_moves_conn/record_gaps/resolve_gaps` (4) ← 5, 6; `db_pg.*_for_writeoff/locations_by_warehouse/fbs_items_by_location/existing_out_moves/wb_supplies_closed/*_returns` (4) ← 5, 6; `src_ref` Ozon `posting:product_id` одинаков в планировщике, сборщике и стороже (проверка 5); суффикс `#<id>` при разнесении учтён в `existing_out_moves`, сборщиках (`split("#",1)`) и стороже (`split_part`).
