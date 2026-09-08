# Склады 2.0 — этап 4 «Витрина» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница `/warehouses` (Матрица «товар × место», карточки мест и FBO-складов с проблемами и действиями, вкладка «Поставки») и сигналы склада на главной — одна витрина поверх данных этапов 1–3, без новых источников данных и без новых таблиц.

**Architecture:** Чистые расчёты — `lib/warehousesMetrics.js` (без БД: матрица, карточки, сигналы, планирование инвентаризации), адаптер к БД — `lib/warehousesData.js` (ленивый импорт `db.js`, переиспользует `collectTargets`/`readSupplySettings` этапа 3 — FBO-остатки и скорость считаются одним каноном `lib/stockCoverage.js`), тонкий роут `app/api/cabinets/[id]/warehouses/route.js` (GET `?tab=matrix|places`, всегда с `signals`; POST `inventory_adjust`). UI — `app/cabinets/[id]/warehouses/*` с тремя вкладками; вкладка «Поставки» встраивает существующую `ShipmentsPage` (проп `embedded`), карточки мест переиспользуют `LocationsManager` (выносится из `InventoryPage.jsx` без изменений) и `TransferFormModal`. Сигналы отдаются на главную через `alerts.warehouses` роута `/overview`; виджет «Заканчиваются на складе» переводится на тот же канон.

**Tech Stack:** Next.js 14 App Router (JS/JSX, без TS), PostgreSQL 16 + RLS (`tenantQuery`/`withCabinet`), `node --test` для `lib/`, psql-сторож под `saas_ro`.

**Spec:** `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md` — §5 (5.1–5.4), §3.5 (расхождение с МП), §6 «Этап 4», §7.

## Global Constraints

- Живые прогоны, пробы и ручные проверки БД — только кабинет #1. Чтение под `saas_ro`: `psql -h localhost -U saas_ro -d saas -Atc "…"` с явным `WHERE cabinet_id = 1` (saas_ro обходит RLS). В боевую БД руками не писать; миграций в этапе нет (новых таблиц нет — §5 работает на данных этапов 1–3).
- Изменение `ff_inventory.qty` — только через `lib/stockLedger.js` `applyMove` (инвентаризация = движения `adjust`). Инвариант: `grep -rnE "SET qty\b" app lib worker --include=*.js --include=*.py | grep -v "stockLedger.js\|stock_ledger.py"` → пусто.
- `withCabinet` коммитит транзакцию при любом возвращённом ответе (в т.ч. 400) и отдаёт 500 при throw → любая проверка, дающая 400, делается ДО первой записи (предпроверка `SELECT … FOR UPDATE` по отсортированным id). Роли: GET без `requireRole`, POST — `{ requireRole: 'manager' }`.
- Канон покрытия (с 2026-09-08, AGENTS.md «Склады 2.0 — этап 3»): скорость = `velocityPerDay(ordersQty, VELOCITY_WINDOW_DAYS)` из `lib/stockCoverage.js` (28 календарных дней / 28), остаток = «доступно». Никаких новых формул скорости.
- Пороги: `readSupplySettings(cabinetId)` → `{ targetDays, minDays }` (`lib/supplyPlanData.js`, дефолты 30/14 из `lib/supplyDays.js`).
- Библиотеки в `lib/` без статических импортов `@/…` (алиас не резолвится в `node --test`): соседей импортировать относительно, `db.js` — лениво (`getDb()` как в `lib/supplyPlanData.js`).
- Стиль UI: константы `C`/`soft` из `@/lib/palette.js`, острова/карточки как в `app/cabinets/[id]/shipments/ShipmentsPage.jsx` и `stocks/StocksPage.jsx`; без новых библиотек и Tailwind; таблицы с `overflow-x:auto` внутри контейнера.
- `npm run build` — только как компиляционная проверка в задачах с JSX/роутами и при деплое; `saas-web` не перезапускать (контроллер); `next dev` запрещён.
- `git add` только явным списком. Коммиты с трейлерами `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` и `Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3`.
- Тесты: JS — `node --test lib/__tests__/*.test.mjs`; SQL-сторожа — `psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage<N>.sql`.

## Что вскрыл осмотр 08.09 (влияет на задачи)

| Факт | Следствие |
|---|---|
| Брифинг (`/api/cabinets/[id]/briefings`) — read-only текст из внешней `agent_memory.db` (SQLite), генерируется вне этого репозитория | «Сигналы в брифинг» (§5.4) в этом плане **не делаются**; сигналы идут на главную (`/overview`, `alerts.warehouses`) и в шапку `/warehouses`. Записать в спеку §5.4 и AGENTS.md как отклонение |
| `lib/opsAlerts.js` — алерты оператора по `jobs.collector_runs`, не сигналы кабинета | Сигналы склада — новая чистая функция `buildSignals` в `lib/warehousesMetrics.js`, `opsAlerts.js` не трогаем |
| Виджет «Заканчиваются на складе» на главной считает скорость как среднее по дням с продажами за период (`overview/route.js:224-253`), только WB | Переводится на канон 28/28 и «доступно» через `lib/warehousesData.js` (обе площадки, «где кончится») — смена канона на главной, записать владельцу |
| `sku_key` в `mp_fbs_daily_stock`/`stock_move_gaps` = `nm_id` (WB) / `product_id` (Ozon) (`worker/fbs_writeoff_core.py`) | Матрица сопоставляет позиции ФФ со снимком FBS по `ff_inventory_skus` (`nm_id`/`product_id`) |
| FBS-заказы по складам продавца: WB — `tenant.wb_fbs_tasks` (`warehouse_id`, `nm_id`, `created_at`, `wb_status`), Ozon — `tenant.ozon_orders` (`scheme='fbs'`, `warehouse_id`, `product_id`, `qty`, `is_cancel`, `order_dt` — текст `YYYY-MM-DD…`) | FBS-скорость места — из этих таблиц за 28 дней; типы `is_cancel`/`created_at` исполнитель проверяет по `information_schema` |
| `collectTargets({platform})` (`lib/supplyPlanData.js`) уже отдаёт FBO-остаток/заказы per склад с именами и `packQty` | FBO-колонки матрицы и карточки FBO-складов строятся из `collectTargets`, а не новым SQL |
| Кабинет 1: 12 позиций ФФ, ни одна не привязана к месту, места без складов МП | До привязки владельцем матрица покажет ФФ-ячейки без сравнения с МП (Δ не считается), карточки мест — «не привязан» красным; сторож считает по фактам, а не по «должно быть заполнено» |
| `LocationsManager` (привязка складов/город/активность) живёт внутри `InventoryPage.jsx:871` и не экспортируется | Выносится в `app/cabinets/[id]/inventory/LocationsManager.jsx` без изменений логики (задача 4) |
| Старые страницы: `/mp-stock` (остатки на МП по складам), `/ff-stock` (снапшоты склада/ФФ «по дате», старый контур), `/move` (заявки на перемещение между складами WB; вкладка «Рекомендации» пуста — роут не отдаёт `recommendations`), `/shipments` | §5: остаются в меню до приёмки; решение об удалении — владелец после приёмки. В плане — только пункт «Склады» первым в группе «Товары» и пометка в AGENTS.md, что кандидаты на удаление: `/ff-stock` (дублирует `/inventory`), `/shipments` (целиком во вкладке «Поставки») |

## Контракты (единый источник для всех задач)

```js
// lib/warehousesMetrics.js — чистые функции
buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps })
// → { columns: [{ key, kind:'ff'|'fbo', title, locationId?, platform?, warehouseKey?, wbBound?, ozonBound? }],
//     rows: [{ itemKey, name, imUrl, skus:{wb:number|null, ozon:number|null}, positionIds:[…],
//              cells: { [colKey]: FfCell | FboCell }, totals:{ own, mp, fbo, gapsQty, gapsCount }, problem:boolean }] }
// FfCell  = { own, mp:{ wb:{present, delta}|null, ozon:{present, delta}|null }, velocity, coverage, flags:{ delta, low } }
// FboCell = { stock, inTransit, velocity, coverage, low }
buildPlaceCards({ settings, positions, locations, sellerWarehouses, fbsStock, fbsVelocity, fboTargets, gaps, docs })
// → { places:[PlaceCard], fboWarehouses:[FboCard] }
buildSignals({ matrix, gaps, docs, settings, now })
// → [{ kind:'discrepancy'|'gaps'|'waiting_accept'|'low_coverage', level:'warn'|'crit', count, text, items?:[…] }]
planInventoryAdjust(current, lines) // → { ok:true, moves:[{ id, delta }] } | { ok:false, error }

// lib/warehousesData.js — адаптер
loadWarehousesInput(cabinetId)  // → все входы buildMatrix/buildPlaceCards одним объектом
loadWarehouseSignals(cabinetId) // → buildSignals(...) на живых данных (для /overview)

// GET /api/cabinets/[id]/warehouses?tab=matrix|places
//   { signals, settings, generatedAt, matrix }          — tab=matrix
//   { signals, settings, generatedAt, places, fboWarehouses, locations, sellerWarehouses, items } — tab=places
// POST /api/cabinets/[id]/warehouses (manager)
//   { action:'inventory_adjust', location_id|null, note, lines:[{ ff_inventory_id, qty_fact }] }
//   → { ok:true, applied, unchanged } | 400 { error }
```

Входные записи адаптера (формы, которые видят чистые функции):

```js
positions:    [{ id, internal_name, qty, unit_cost, location_id, skus:[{ platform, sku_key, name, im_url }] }]
locations:    [{ id, name, address, city, loc_type, is_active, wb_warehouse_id, ozon_warehouse_id }]
sellerWarehouses: [{ platform, warehouse_id, name, kind, is_active }]
fbsStock:     [{ platform, warehouse_id, sku_key, present, reserved }]      // последний снимок каждой площадки
fbsVelocity:  [{ platform, warehouse_id, sku_key, orders_qty }]            // за VELOCITY_WINDOW_DAYS
fboTargets:   [{ platform, warehouseKey, warehouseName, regionKey, skuKey, itemName, stock, inTransit, ordersQty, days }]
gaps:         [{ id, platform, warehouse_id, sku_key, qty, reason, src_kind, src_ref, first_seen_at }]
docs:         [{ id, platform, status, shipped_at, ship_dt, dest_warehouse_id, dest_warehouse }]
settings:     { targetDays, minDays }
```

---

### Task 1: Чистая матрица «товар × место» — `lib/warehousesMetrics.js` (buildMatrix)

**Files:**
- Create: `lib/warehousesMetrics.js`
- Test: `lib/__tests__/warehousesMetrics.test.mjs`

**Interfaces:**
- Consumes: `velocityPerDay`, `coverageDays`, `VELOCITY_WINDOW_DAYS` из `./stockCoverage.js`.
- Produces: `buildMatrix(input)` (контракт выше), `itemKeyOf(position)`, `EMPTY_SKUS`.

Правила (спека §5.1, §3.5):
- Строка = физическая позиция, сгруппированная по паре `(nm_id, product_id)`: у позиции берём первый WB-артикул и первый Ozon-артикул из `skus` (порядок как пришёл — по `created_at`); `itemKey = "${wb ?? '-'}|${ozon ?? '-'}"`; позиция без артикулов → `itemKey = "pos:<id>"`, имя — `internal_name`.
- Колонки: каждое активное место (`kind:'ff'`) + каждый FBO-склад из `fboTargets` (`kind:'fbo'`, ключ `fbo:<platform>:<warehouseKey>`). Неактивные места — только если на них есть остаток (`own > 0` хоть у одной строки).
- Ячейка ФФ: `own` = Σ `qty` позиций строки на месте; для площадки p: если у места есть `p_warehouse_id` и у строки есть артикул p → `present` = Σ `fbsStock.present` по `(p, warehouse_id, sku_key)`, `delta = own − present`; иначе `null`. `velocity` = `velocityPerDay(Σ fbsVelocity.orders_qty по привязанным складам места и артикулам строки, VELOCITY_WINDOW_DAYS)`; `coverage = coverageDays(own, 0, velocity)`; `flags.delta` = хоть один `delta ≠ 0`; `flags.low` = `coverage != null && coverage < settings.minDays`.
- Ячейка FBO: из `fboTargets` по `(platform, warehouseKey, skuKey == skus[platform])`: `stock`, `inTransit`, `velocity = velocityPerDay(ordersQty, days)`, `coverage = coverageDays(stock, inTransit, velocity)`, `low` — как выше.
- Итоги строки: `own` = Σ own по ФФ, `mp` = Σ present по ФФ-ячейкам (только где считалось), `fbo` = Σ stock + inTransit, `gapsQty`/`gapsCount` — открытые gaps, у которых `(platform, sku_key)` совпадает с артикулом строки. `problem` = есть `flags.delta` или `flags.low`/`low` или `gapsCount > 0`.
- Ячейки без данных (нет позиций на месте и нет остатка на складе) не создаются — `cells[colKey]` отсутствует.
- Порядок строк: `problem` первыми, затем по `name`; колонки: места по `name`, затем FBO WB по `title`, затем FBO Ozon.

- [ ] **Step 1: Написать падающий тест**

```js
// lib/__tests__/warehousesMetrics.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildMatrix, itemKeyOf } from "../warehousesMetrics.js";

const settings = { targetDays: 30, minDays: 14 };
const locations = [
  { id: 1, name: "ФФ Москва", city: "Москва", loc_type: "ff", is_active: true, wb_warehouse_id: 501, ozon_warehouse_id: 9001 },
  { id: 2, name: "ФФ Казань", city: "Казань", loc_type: "ff", is_active: true, wb_warehouse_id: null, ozon_warehouse_id: null },
  { id: 3, name: "Архив", city: null, loc_type: "stock", is_active: false, wb_warehouse_id: null, ozon_warehouse_id: null },
];
const positions = [
  { id: 11, internal_name: "Баклажан партия 1", qty: 10, unit_cost: 100, location_id: 1,
    skus: [{ platform: "wb", sku_key: 111, name: "Баклажан-цвет", im_url: "x" }, { platform: "ozon", sku_key: 222, name: "Баклажан", im_url: null }] },
  { id: 12, internal_name: "Баклажан партия 2", qty: 5, unit_cost: 100, location_id: 1,
    skus: [{ platform: "wb", sku_key: 111, name: "Баклажан-цвет", im_url: "x" }, { platform: "ozon", sku_key: 222, name: "Баклажан", im_url: null }] },
  { id: 13, internal_name: "Баклажан партия 3", qty: 7, unit_cost: 100, location_id: 2,
    skus: [{ platform: "wb", sku_key: 111, name: "Баклажан-цвет", im_url: "x" }] },
  { id: 14, internal_name: "Без артикула", qty: 3, unit_cost: 50, location_id: 2, skus: [] },
  { id: 15, internal_name: "Старое", qty: 0, unit_cost: 50, location_id: 3, skus: [] },
];
const fbsStock = [
  { platform: "wb", warehouse_id: 501, sku_key: 111, present: 12, reserved: 0 },
  { platform: "ozon", warehouse_id: 9001, sku_key: 222, present: 15, reserved: 1 },
];
const fbsVelocity = [
  { platform: "wb", warehouse_id: 501, sku_key: 111, orders_qty: 28 },   // 1/дн
  { platform: "ozon", warehouse_id: 9001, sku_key: 222, orders_qty: 56 }, // 2/дн
];
const fboTargets = [
  { platform: "wb", warehouseKey: 507, warehouseName: "Коледино", regionKey: null, skuKey: 111, itemName: "Баклажан-цвет",
    stock: 20, inTransit: 8, ordersQty: 56, days: 28 },
];
const gaps = [
  { id: 1, platform: "wb", warehouse_id: 501, sku_key: 111, qty: 2, reason: "no_location", src_kind: "wb_fbs_task", src_ref: "r1", first_seen_at: "2026-09-07T10:00:00Z" },
  { id: 2, platform: "ozon", warehouse_id: 9001, sku_key: 999, qty: 1, reason: "no_item", src_kind: "ozon_posting", src_ref: "p1", first_seen_at: "2026-09-07T10:00:00Z" },
];

test("itemKeyOf: пара артикулов, только один, без артикулов", () => {
  assert.equal(itemKeyOf(positions[0]), "111|222");
  assert.equal(itemKeyOf(positions[2]), "111|-");
  assert.equal(itemKeyOf(positions[3]), "pos:14");
});

test("buildMatrix: колонки — активные места, неактивное с нулём скрыто, FBO из targets", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  assert.deepEqual(m.columns.map((c) => c.key), ["ff:2", "ff:1", "fbo:wb:507"]);
  assert.equal(m.columns[1].wbBound, true);
  assert.equal(m.columns[0].wbBound, false);
});

test("buildMatrix: ячейка ФФ — own по двум партиям, Δ по WB и Ozon, скорость и покрытие", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const row = m.rows.find((r) => r.itemKey === "111|222");
  const c = row.cells["ff:1"];
  assert.equal(c.own, 15);
  assert.deepEqual(c.mp.wb, { present: 12, delta: 3 });
  assert.deepEqual(c.mp.ozon, { present: 15, delta: 0 });
  assert.equal(c.velocity, 3);            // 1 + 2 в день
  assert.equal(c.coverage, 5);            // 15 / 3
  assert.deepEqual(c.flags, { delta: true, low: true });
  assert.equal(row.cells["ff:2"], undefined); // партия 3 — другой itemKey (111|-)
});

test("buildMatrix: место без привязок — mp null, скорость 0, покрытие null", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const row = m.rows.find((r) => r.itemKey === "111|-");
  const c = row.cells["ff:2"];
  assert.equal(c.own, 7);
  assert.deepEqual(c.mp, { wb: null, ozon: null });
  assert.equal(c.velocity, 0);
  assert.equal(c.coverage, null);
  assert.deepEqual(c.flags, { delta: false, low: false });
});

test("buildMatrix: FBO-ячейка и итоги строки, gaps по артикулу", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const row = m.rows.find((r) => r.itemKey === "111|222");
  assert.deepEqual(row.cells["fbo:wb:507"], { stock: 20, inTransit: 8, velocity: 2, coverage: 14, low: false });
  assert.deepEqual(row.totals, { own: 15, mp: 27, fbo: 28, gapsQty: 2, gapsCount: 1 });
  assert.equal(row.problem, true);
  const plain = m.rows.find((r) => r.itemKey === "pos:14");
  assert.equal(plain.name, "Без артикула");
  assert.deepEqual(plain.totals, { own: 3, mp: 0, fbo: 0, gapsQty: 0, gapsCount: 0 });
  assert.equal(plain.problem, false);
});

test("buildMatrix: проблемные строки первыми, затем по имени; пустой вход — пустая матрица", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  assert.equal(m.rows[0].problem, true);
  assert.equal(m.rows[m.rows.length - 1].problem, false);
  const e = buildMatrix({ settings, positions: [], locations: [], fbsStock: [], fbsVelocity: [], fboTargets: [], gaps: [] });
  assert.deepEqual(e, { columns: [], rows: [] });
});
```

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `node --test lib/__tests__/warehousesMetrics.test.mjs`
Expected: FAIL — `Cannot find module '../warehousesMetrics.js'`.

- [ ] **Step 3: Реализация**

```js
// lib/warehousesMetrics.js — витрина «Склады 2.0», этап 4 (спека §5). Чистые функции, без БД.
//
// Канон покрытия: скорость = velocityPerDay(заказы за VELOCITY_WINDOW_DAYS), остаток «доступно».
// Строка матрицы = физическая позиция, сгруппированная по паре (nm_id, product_id) — первый
// WB- и первый Ozon-артикул позиции. Ячейка ФФ сравнивает свой остаток с последним снимком
// FBS-остатков МП по привязанному складу продавца (§3.5): delta = own − present.
import { velocityPerDay, coverageDays, VELOCITY_WINDOW_DAYS } from "./stockCoverage.js";

const PLATFORMS = ["wb", "ozon"];
export const EMPTY_SKUS = { wb: null, ozon: null };

function skusOf(position) {
  const out = { ...EMPTY_SKUS };
  for (const s of position.skus || []) {
    if (PLATFORMS.includes(s.platform) && out[s.platform] == null && s.sku_key != null) out[s.platform] = Number(s.sku_key);
  }
  return out;
}

export function itemKeyOf(position) {
  const s = skusOf(position);
  if (s.wb == null && s.ozon == null) return `pos:${position.id}`;
  return `${s.wb ?? "-"}|${s.ozon ?? "-"}`;
}

function nameOf(position) {
  const s = (position.skus || []).find((x) => x.name);
  return { name: s?.name || position.internal_name || `#${position.id}`, imUrl: (position.skus || []).find((x) => x.im_url)?.im_url || null };
}

const keyFbs = (p, w, k) => `${p}:${w}:${k}`;

function indexBy(rows, fn, valueOf) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    m.set(k, (m.get(k) || 0) + Number(valueOf(r)) || 0);
  }
  return m;
}

export function buildMatrix({ settings, positions = [], locations = [], fbsStock = [], fbsVelocity = [], fboTargets = [], gaps = [] }) {
  const minDays = Number(settings?.minDays) || 14;
  const presentIdx = indexBy(fbsStock, (r) => keyFbs(r.platform, r.warehouse_id, r.sku_key), (r) => r.present);
  const velIdx = indexBy(fbsVelocity, (r) => keyFbs(r.platform, r.warehouse_id, r.sku_key), (r) => r.orders_qty);
  const locById = new Map(locations.map((l) => [Number(l.id), l]));

  // 1. Строки: группировка позиций по itemKey.
  const rows = new Map();
  for (const p of positions) {
    const key = itemKeyOf(p);
    let row = rows.get(key);
    if (!row) {
      const { name, imUrl } = nameOf(p);
      row = { itemKey: key, name, imUrl, skus: skusOf(p), positionIds: [], cells: {}, totals: { own: 0, mp: 0, fbo: 0, gapsQty: 0, gapsCount: 0 }, problem: false, _own: new Map() };
      rows.set(key, row);
    }
    row.positionIds.push(p.id);
    if (p.location_id != null) row._own.set(Number(p.location_id), (row._own.get(Number(p.location_id)) || 0) + (Number(p.qty) || 0));
  }

  // 2. Колонки: активные места + неактивные с остатком, затем FBO-склады из targets.
  const ownByLoc = new Map();
  for (const row of rows.values()) for (const [lid, q] of row._own) ownByLoc.set(lid, (ownByLoc.get(lid) || 0) + q);
  const ffCols = locations
    .filter((l) => l.is_active !== false || (ownByLoc.get(Number(l.id)) || 0) > 0)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"))
    .map((l) => ({ key: `ff:${l.id}`, kind: "ff", title: l.name, locationId: Number(l.id), wbBound: l.wb_warehouse_id != null, ozonBound: l.ozon_warehouse_id != null }));
  const fboSeen = new Map();
  for (const t of fboTargets) {
    const key = `fbo:${t.platform}:${t.warehouseKey}`;
    if (!fboSeen.has(key)) fboSeen.set(key, { key, kind: "fbo", platform: t.platform, warehouseKey: t.warehouseKey, title: t.warehouseName || String(t.warehouseKey) });
  }
  const fboCols = [...fboSeen.values()].sort((a, b) => (a.platform === b.platform ? a.title.localeCompare(b.title, "ru") : a.platform === "wb" ? -1 : 1));
  const columns = [...ffCols, ...fboCols];

  // 3. Ячейки ФФ.
  for (const row of rows.values()) {
    for (const col of ffCols) {
      const loc = locById.get(col.locationId);
      const own = row._own.get(col.locationId) || 0;
      const mp = { wb: null, ozon: null };
      let ordersQty = 0;
      let hasData = own > 0;
      for (const p of PLATFORMS) {
        const wh = loc?.[`${p}_warehouse_id`];
        const sku = row.skus[p];
        if (wh == null || sku == null) continue;
        const k = keyFbs(p, wh, sku);
        const present = presentIdx.get(k);
        ordersQty += velIdx.get(k) || 0;
        if (present != null) { mp[p] = { present, delta: own - present }; hasData = true; }
        else if (own > 0) mp[p] = { present: 0, delta: own };
      }
      if (!hasData) continue;
      const velocity = velocityPerDay(ordersQty, VELOCITY_WINDOW_DAYS);
      const coverage = coverageDays(own, 0, velocity);
      const flags = { delta: PLATFORMS.some((p) => mp[p] && mp[p].delta !== 0), low: coverage != null && coverage < minDays };
      row.cells[col.key] = { own, mp, velocity, coverage, flags };
      row.totals.own += own;
      for (const p of PLATFORMS) if (mp[p]) row.totals.mp += mp[p].present;
      if (flags.delta || flags.low) row.problem = true;
    }
  }

  // 4. Ячейки FBO.
  for (const t of fboTargets) {
    for (const row of rows.values()) {
      if (row.skus[t.platform] == null || Number(row.skus[t.platform]) !== Number(t.skuKey)) continue;
      const velocity = velocityPerDay(t.ordersQty, t.days || VELOCITY_WINDOW_DAYS);
      const coverage = coverageDays(t.stock, t.inTransit, velocity);
      const low = coverage != null && coverage < minDays;
      row.cells[`fbo:${t.platform}:${t.warehouseKey}`] = { stock: Number(t.stock) || 0, inTransit: Number(t.inTransit) || 0, velocity, coverage, low };
      row.totals.fbo += (Number(t.stock) || 0) + (Number(t.inTransit) || 0);
      if (low) row.problem = true;
    }
  }

  // 5. Gaps по артикулу строки.
  for (const g of gaps) {
    for (const row of rows.values()) {
      if (row.skus[g.platform] == null || Number(row.skus[g.platform]) !== Number(g.sku_key)) continue;
      row.totals.gapsQty += Number(g.qty) || 0;
      row.totals.gapsCount += 1;
      row.problem = true;
    }
  }

  const out = [...rows.values()].map(({ _own, ...r }) => r)
    .sort((a, b) => (a.problem === b.problem ? a.name.localeCompare(b.name, "ru") : a.problem ? -1 : 1));
  return { columns, rows: out };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `node --test lib/__tests__/warehousesMetrics.test.mjs`
Expected: 6/6 pass. Если `coverage` в тесте «5» не сходится из-за округления в `coverageDays` — проверь `lib/stockCoverage.js` (там `Math.round(...*10)/10`?) и приведи ожидание теста к фактическому контракту helper'а, не меняя helper.

- [ ] **Step 5: Коммит**

```bash
git add lib/warehousesMetrics.js lib/__tests__/warehousesMetrics.test.mjs
git commit -m "feat(warehouses): чистая матрица «товар × место» — свой/на МП/Δ, покрытие, gaps"
```

---

### Task 2: Карточки мест, сигналы, планирование инвентаризации — `lib/warehousesMetrics.js`

**Files:**
- Modify: `lib/warehousesMetrics.js`
- Test: `lib/__tests__/warehousesMetrics.test.mjs`

**Interfaces:**
- Consumes: `buildMatrix` (задача 1).
- Produces: `buildPlaceCards(input) → { places, fboWarehouses }`, `buildSignals({ matrix, gaps, docs, settings, now }) → Signal[]`, `planInventoryAdjust(current, lines)`, `WAITING_ACCEPT_DAYS = 7`, `LOW_COVERAGE_TOP = 5`.

Формы:

```js
PlaceCard = { id, name, city, address, is_active, loc_type,
  bindings: { wb: { warehouse_id, name }|null, ozon: {…}|null },
  positions, units, value,                      // count позиций с qty>0, Σqty, Σ qty×unit_cost (округл. 2)
  velocity, coverage,                           // Σ FBS-скорости по привязанным складам, units/velocity
  problems: { discrepancies:[{ itemKey, name, platform, own, present, delta }],
              gaps:[{ id, platform, sku_key, qty, reason, src_ref, first_seen_at }],
              low:[{ itemKey, name, own, velocity, coverage }] } }
FboCard = { key:'fbo:<platform>:<warehouseKey>', platform, warehouseKey, name,
  items, units, inTransit, velocity, coverage,
  low:[{ itemKey, name, stock, velocity, coverage }],
  openDocs:[{ id, status, ship_dt, shipped_at }] }
Signal = { kind, level, count, text, items }
```

Правила: `gaps` места — по `warehouse_id` gap = привязанный склад места той же площадки; неразнесённые задания без склада (`warehouse_id IS NULL`) в карточку не попадают, но входят в сигнал «не разнесено» (он считает все открытые). Склад продавца из `sellerWarehouses`, не привязанный ни к одному месту, → отдельная запись в `places` с `id: null`, `name: <имя склада>`, `unbound: true` (UI красит «не привязан» красным). Сигналы: `discrepancy` = число строк матрицы с `flags.delta` (level `warn`); `gaps` = число открытых gaps (`crit` если > 0); `waiting_accept` = документы `status='shipped'` с `shipped_at` старше `WAITING_ACCEPT_DAYS` (`warn`); `low_coverage` = топ-`LOW_COVERAGE_TOP` ячеек (ФФ и FBO) по скорости с `coverage < minDays`, текст «<товар> кончится на <место/склад> через <N> дн» (`crit`, если `coverage < minDays/2`). `planInventoryAdjust(current:[{id, qty}], lines:[{ff_inventory_id, qty_fact}])`: `qty_fact` — целое ≥ 0, `ff_inventory_id` из `current`, без дублей; → `moves` только с `delta ≠ 0`, отсортированные по `id`.

- [ ] **Step 1: Тесты**

```js
// добавить в lib/__tests__/warehousesMetrics.test.mjs
import { buildPlaceCards, buildSignals, planInventoryAdjust } from "../warehousesMetrics.js";

const sellerWarehouses = [
  { platform: "wb", warehouse_id: 501, name: "ФФ Москва (WB)", kind: "fbs", is_active: true },
  { platform: "ozon", warehouse_id: 9001, name: "ФФ Москва (Ozon)", kind: "fbs", is_active: true },
  { platform: "ozon", warehouse_id: 9002, name: "Уфа", kind: "fbs", is_active: true },
];
const docs = [
  { id: 1, platform: "wb", status: "shipped", shipped_at: "2026-08-20T10:00:00Z", ship_dt: "2026-08-20", dest_warehouse_id: 507, dest_warehouse: "Коледино" },
  { id: 2, platform: "wb", status: "shipped", shipped_at: "2026-09-07T10:00:00Z", ship_dt: "2026-09-07", dest_warehouse_id: 507, dest_warehouse: "Коледино" },
  { id: 3, platform: "wb", status: "accepted", shipped_at: "2026-08-01T10:00:00Z", ship_dt: "2026-08-01", dest_warehouse_id: 507, dest_warehouse: "Коледино" },
];
const now = new Date("2026-09-08T12:00:00Z");

test("buildPlaceCards: карточка места — привязки, единицы, стоимость, проблемы; непривязанный склад — отдельная запись", () => {
  const { places, fboWarehouses } = buildPlaceCards({ settings, positions, locations, sellerWarehouses, fbsStock, fbsVelocity, fboTargets, gaps, docs });
  const msk = places.find((p) => p.id === 1);
  assert.deepEqual(msk.bindings, { wb: { warehouse_id: 501, name: "ФФ Москва (WB)" }, ozon: { warehouse_id: 9001, name: "ФФ Москва (Ozon)" } });
  assert.equal(msk.positions, 2);
  assert.equal(msk.units, 15);
  assert.equal(msk.value, 1500);
  assert.equal(msk.velocity, 3);
  assert.equal(msk.coverage, 5);
  assert.deepEqual(msk.problems.discrepancies, [{ itemKey: "111|222", name: "Баклажан-цвет", platform: "wb", own: 15, present: 12, delta: 3 }]);
  assert.deepEqual(msk.problems.gaps.map((g) => g.id), [1, 2]);
  assert.deepEqual(msk.problems.low.map((l) => l.itemKey), ["111|222"]);
  const kzn = places.find((p) => p.id === 2);
  assert.deepEqual(kzn.bindings, { wb: null, ozon: null });
  assert.equal(kzn.units, 10);
  const ufa = places.find((p) => p.unbound);
  assert.equal(ufa.name, "Уфа");
  assert.equal(ufa.id, null);
  assert.equal(places.some((p) => p.id === 3), false); // неактивное место без остатка скрыто
  assert.equal(fboWarehouses.length, 1);
  assert.equal(fboWarehouses[0].name, "Коледино");
  assert.equal(fboWarehouses[0].units, 20);
  assert.equal(fboWarehouses[0].inTransit, 8);
  assert.equal(fboWarehouses[0].coverage, 14);
  assert.deepEqual(fboWarehouses[0].openDocs.map((d) => d.id), [1, 2]);
});

test("buildSignals: четыре сигнала с правильными счётчиками и уровнями", () => {
  const matrix = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const s = buildSignals({ matrix, gaps, docs, settings, now });
  const byKind = Object.fromEntries(s.map((x) => [x.kind, x]));
  assert.equal(byKind.discrepancy.count, 1);
  assert.equal(byKind.discrepancy.level, "warn");
  assert.equal(byKind.gaps.count, 2);
  assert.equal(byKind.gaps.level, "crit");
  assert.equal(byKind.waiting_accept.count, 1);         // только документ 1 (19 дней), не 2 и не accepted
  assert.deepEqual(byKind.waiting_accept.items.map((d) => d.id), [1]);
  assert.equal(byKind.low_coverage.count, 1);           // ФФ Москва: покрытие 5 < 14; FBO 14 — не ниже
  assert.match(byKind.low_coverage.items[0].text, /Баклажан-цвет.*ФФ Москва.*5 дн/);
  assert.equal(byKind.low_coverage.level, "crit");      // 5 < 14/2
});

test("buildSignals: без проблем — сигналы с count 0 не возвращаются", () => {
  const matrix = buildMatrix({ settings, positions: [], locations: [], fbsStock: [], fbsVelocity: [], fboTargets: [], gaps: [] });
  assert.deepEqual(buildSignals({ matrix, gaps: [], docs: [], settings, now }), []);
});

test("planInventoryAdjust: дельты только по изменившимся, ошибки до записи", () => {
  const current = [{ id: 11, qty: 10 }, { id: 12, qty: 5 }];
  assert.deepEqual(planInventoryAdjust(current, [{ ff_inventory_id: 12, qty_fact: 4 }, { ff_inventory_id: 11, qty_fact: 10 }]),
    { ok: true, moves: [{ id: 12, delta: -1 }] });
  assert.equal(planInventoryAdjust(current, [{ ff_inventory_id: 99, qty_fact: 1 }]).ok, false);
  assert.equal(planInventoryAdjust(current, [{ ff_inventory_id: 11, qty_fact: -1 }]).ok, false);
  assert.equal(planInventoryAdjust(current, [{ ff_inventory_id: 11, qty_fact: 1.5 }]).ok, false);
  assert.equal(planInventoryAdjust(current, [{ ff_inventory_id: 11, qty_fact: 1 }, { ff_inventory_id: 11, qty_fact: 2 }]).ok, false);
  assert.deepEqual(planInventoryAdjust(current, []), { ok: false, error: "нет строк" });
});
```

- [ ] **Step 2: Прогнать — падает** (`buildPlaceCards is not a function`).

- [ ] **Step 3: Реализация** (добавить в `lib/warehousesMetrics.js`)

```js
export const WAITING_ACCEPT_DAYS = 7;
export const LOW_COVERAGE_TOP = 5;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fmtDays = (d) => (d == null ? "—" : String(Math.round(d)));

export function buildPlaceCards({ settings, positions = [], locations = [], sellerWarehouses = [], fbsStock = [], fbsVelocity = [], fboTargets = [], gaps = [], docs = [] }) {
  const minDays = Number(settings?.minDays) || 14;
  const matrix = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const whName = new Map(sellerWarehouses.map((w) => [`${w.platform}:${w.warehouse_id}`, w.name]));
  const boundKeys = new Set();
  const places = [];

  for (const col of matrix.columns.filter((c) => c.kind === "ff")) {
    const loc = locations.find((l) => Number(l.id) === col.locationId);
    const bindings = { wb: null, ozon: null };
    for (const p of PLATFORMS) {
      const wh = loc?.[`${p}_warehouse_id`];
      if (wh == null) continue;
      bindings[p] = { warehouse_id: Number(wh), name: whName.get(`${p}:${wh}`) || String(wh) };
      boundKeys.add(`${p}:${wh}`);
    }
    const posHere = positions.filter((x) => Number(x.location_id) === col.locationId && (Number(x.qty) || 0) > 0);
    let velocity = 0;
    const problems = { discrepancies: [], gaps: [], low: [] };
    for (const row of matrix.rows) {
      const c = row.cells[col.key];
      if (!c) continue;
      velocity += c.velocity;
      for (const p of PLATFORMS) if (c.mp[p] && c.mp[p].delta !== 0) problems.discrepancies.push({ itemKey: row.itemKey, name: row.name, platform: p, own: c.own, present: c.mp[p].present, delta: c.mp[p].delta });
      if (c.flags.low) problems.low.push({ itemKey: row.itemKey, name: row.name, own: c.own, velocity: c.velocity, coverage: c.coverage });
    }
    velocity = round2(velocity);
    const units = posHere.reduce((s, x) => s + (Number(x.qty) || 0), 0);
    for (const g of gaps) {
      const b = bindings[g.platform];
      if (b && g.warehouse_id != null && Number(g.warehouse_id) === b.warehouse_id) problems.gaps.push({ id: g.id, platform: g.platform, sku_key: g.sku_key, qty: g.qty, reason: g.reason, src_ref: g.src_ref, first_seen_at: g.first_seen_at });
    }
    problems.low.sort((a, b) => b.velocity - a.velocity);
    places.push({
      id: col.locationId, name: loc?.name || col.title, city: loc?.city || null, address: loc?.address || null,
      is_active: loc?.is_active !== false, loc_type: loc?.loc_type || null, unbound: false, bindings,
      positions: posHere.length, units, value: round2(posHere.reduce((s, x) => s + (Number(x.qty) || 0) * (Number(x.unit_cost) || 0), 0)),
      velocity, coverage: coverageDays(units, 0, velocity), problems,
    });
  }
  for (const w of sellerWarehouses) {
    if (boundKeys.has(`${w.platform}:${w.warehouse_id}`) || w.is_active === false) continue;
    places.push({ id: null, name: w.name, city: null, address: null, is_active: true, loc_type: null, unbound: true,
      platform: w.platform, warehouse_id: Number(w.warehouse_id),
      bindings: { wb: null, ozon: null }, positions: 0, units: 0, value: 0, velocity: 0, coverage: null,
      problems: { discrepancies: [], gaps: [], low: [] } });
  }

  const fboWarehouses = [];
  for (const col of matrix.columns.filter((c) => c.kind === "fbo")) {
    let items = 0, units = 0, inTransit = 0, ordersPerDay = 0;
    const low = [];
    for (const row of matrix.rows) {
      const c = row.cells[col.key];
      if (!c) continue;
      items += 1; units += c.stock; inTransit += c.inTransit; ordersPerDay += c.velocity;
      if (c.low) low.push({ itemKey: row.itemKey, name: row.name, stock: c.stock, velocity: c.velocity, coverage: c.coverage });
    }
    const velocity = round2(ordersPerDay);
    low.sort((a, b) => b.velocity - a.velocity);
    const openDocs = docs
      .filter((d) => d.platform === col.platform && d.status === "shipped" && d.dest_warehouse_id != null && Number(d.dest_warehouse_id) === Number(col.warehouseKey))
      .map((d) => ({ id: d.id, status: d.status, ship_dt: d.ship_dt, shipped_at: d.shipped_at }));
    fboWarehouses.push({ key: col.key, platform: col.platform, warehouseKey: col.warehouseKey, name: col.title, items, units, inTransit, velocity, coverage: coverageDays(units, inTransit, velocity), low, openDocs });
  }
  return { places, fboWarehouses };
}

export function buildSignals({ matrix, gaps = [], docs = [], settings, now = new Date() }) {
  const minDays = Number(settings?.minDays) || 14;
  const out = [];
  const disc = matrix.rows.filter((r) => Object.values(r.cells).some((c) => c.flags?.delta));
  if (disc.length) out.push({ kind: "discrepancy", level: "warn", count: disc.length, text: `${disc.length} товаров с расхождением учёта и МП`, items: disc.map((r) => ({ itemKey: r.itemKey, name: r.name })) });
  if (gaps.length) out.push({ kind: "gaps", level: "crit", count: gaps.length, text: `${gaps.length} заданий FBS не разнесено`, items: gaps.slice(0, 10).map((g) => ({ id: g.id, platform: g.platform, reason: g.reason, qty: g.qty })) });
  const cutoff = now.getTime() - WAITING_ACCEPT_DAYS * 86400000;
  const waiting = docs.filter((d) => d.status === "shipped" && d.shipped_at && new Date(d.shipped_at).getTime() < cutoff);
  if (waiting.length) out.push({ kind: "waiting_accept", level: "warn", count: waiting.length, text: `${waiting.length} поставок ждут приёмки > ${WAITING_ACCEPT_DAYS} дней`, items: waiting.map((d) => ({ id: d.id, platform: d.platform, dest_warehouse: d.dest_warehouse, shipped_at: d.shipped_at })) });
  const low = [];
  for (const r of matrix.rows) for (const col of matrix.columns) {
    const c = r.cells[col.key];
    if (!c) continue;
    const cov = c.coverage, isLow = col.kind === "ff" ? c.flags.low : c.low;
    if (!isLow) continue;
    low.push({ itemKey: r.itemKey, name: r.name, where: col.title, colKey: col.key, qty: col.kind === "ff" ? c.own : c.stock, velocity: c.velocity, coverage: cov, text: `${r.name} кончится на ${col.title} через ${fmtDays(cov)} дн` });
  }
  low.sort((a, b) => b.velocity - a.velocity);
  const top = low.slice(0, LOW_COVERAGE_TOP);
  if (top.length) out.push({ kind: "low_coverage", level: top.some((x) => x.coverage < minDays / 2) ? "crit" : "warn", count: low.length, text: `${low.length} позиций с покрытием < ${minDays} дн`, items: top });
  return out;
}

export function planInventoryAdjust(current = [], lines = []) {
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: "нет строк" };
  const cur = new Map(current.map((c) => [Number(c.id), Number(c.qty) || 0]));
  const seen = new Set();
  const moves = [];
  for (const l of lines) {
    const id = Number(l.ff_inventory_id);
    const fact = Number(l.qty_fact);
    if (!cur.has(id)) return { ok: false, error: `позиция ${l.ff_inventory_id} не найдена на этом месте` };
    if (seen.has(id)) return { ok: false, error: `позиция ${id} указана дважды` };
    seen.add(id);
    if (!Number.isInteger(fact) || fact < 0) return { ok: false, error: `факт по позиции ${id} должен быть целым ≥ 0` };
    const delta = fact - cur.get(id);
    if (delta !== 0) moves.push({ id, delta });
  }
  moves.sort((a, b) => a.id - b.id);
  return { ok: true, moves };
}
```

- [ ] **Step 4: Прогнать** `node --test lib/__tests__/warehousesMetrics.test.mjs` → 10/10 pass. Если в тесте карточки `coverage: 14` для FBO не сходится (28/2 = 14 — ровно), проверь, что `coverageDays` не округляет иначе.

- [ ] **Step 5: Коммит**

```bash
git add lib/warehousesMetrics.js lib/__tests__/warehousesMetrics.test.mjs
git commit -m "feat(warehouses): карточки мест и FBO-складов, сигналы склада, план инвентаризации"
```

---

### Task 3: Адаптер данных и роут `/api/cabinets/[id]/warehouses`

**Files:**
- Create: `lib/warehousesData.js`
- Create: `app/api/cabinets/[id]/warehouses/route.js`
- Test: `lib/__tests__/warehousesData.test.mjs` (нормализация строк адаптера на фикстурах, без БД)

**Interfaces:**
- Consumes: `buildMatrix`, `buildPlaceCards`, `buildSignals`, `planInventoryAdjust` (задачи 1–2); `collectTargets({platform})`, `readSupplySettings(cabinetId)` из `./supplyPlanData.js`; `VELOCITY_WINDOW_DAYS` из `./stockCoverage.js`; `applyMove` из `@/lib/stockLedger.js` (в роуте); `tenantQuery`.
- Produces: `loadWarehousesInput(cabinetId)`, `loadWarehouseSignals(cabinetId)`, `normalizePositions(rows, skuRows)`, `normalizeFbsVelocity(rows)`; GET/POST контракт из раздела «Контракты».

- [ ] **Step 1: Тест нормализации**

```js
// lib/__tests__/warehousesData.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizePositions } from "../warehousesData.js";

test("normalizePositions: артикулы группируются по позиции, sku_key = nm_id для WB и product_id для Ozon, порядок сохранён", () => {
  const rows = [{ id: 11, internal_name: "A", qty: "10", unit_cost: "100.50", location_id: 1 }, { id: 12, internal_name: "B", qty: 0, unit_cost: null, location_id: null }];
  const skus = [
    { ff_inventory_id: 11, platform: "ozon", nm_id: null, product_id: 222, sku_name: "A-oz", im_url: null },
    { ff_inventory_id: 11, platform: "wb", nm_id: 111, product_id: null, sku_name: "A-wb", im_url: "u" },
  ];
  const out = normalizePositions(rows, skus);
  assert.deepEqual(out[0], { id: 11, internal_name: "A", qty: 10, unit_cost: 100.5, location_id: 1,
    skus: [{ platform: "ozon", sku_key: 222, name: "A-oz", im_url: null }, { platform: "wb", sku_key: 111, name: "A-wb", im_url: "u" }] });
  assert.deepEqual(out[1].skus, []);
  assert.equal(out[1].location_id, null);
});
```

- [ ] **Step 2: Прогнать — падает.**

- [ ] **Step 3: Адаптер**

```js
// lib/warehousesData.js — адаптер БД для витрины «Склады 2.0» (спека §5). Все запросы — под
// tenantQuery (RLS по cabinet_id), вызывается изнутри withCabinet. FBO-остатки и заказы —
// через collectTargets этапа 3 (один канон покрытия), пороги — readSupplySettings.
// Импорт db.js ленивый: модуль должен импортироваться в node --test.
import { buildMatrix, buildPlaceCards, buildSignals } from "./warehousesMetrics.js";
import { collectTargets, readSupplySettings } from "./supplyPlanData.js";
import { VELOCITY_WINDOW_DAYS } from "./stockCoverage.js";

let _db = null;
async function getDb() { if (!_db) _db = await import("./db.js"); return _db; }

export function normalizePositions(rows, skuRows) {
  const skusBy = new Map();
  for (const s of skuRows) {
    const list = skusBy.get(Number(s.ff_inventory_id)) || [];
    list.push({ platform: s.platform, sku_key: s.platform === "wb" ? (s.nm_id == null ? null : Number(s.nm_id)) : (s.product_id == null ? null : Number(s.product_id)), name: s.sku_name || null, im_url: s.im_url || null });
    skusBy.set(Number(s.ff_inventory_id), list);
  }
  return rows.map((r) => ({ id: Number(r.id), internal_name: r.internal_name, qty: Number(r.qty) || 0, unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
    location_id: r.location_id == null ? null : Number(r.location_id), skus: skusBy.get(Number(r.id)) || [] }));
}

// Отменённые задания WB не считаются спросом. Список статусов — тот же, что у авто-списания
// (worker/fbs_writeoff_core.py, RETURNED_WB / отменённые) — исполнитель сверяет и копирует.
export const WB_TASK_CANCELLED = ["canceled", "canceled_by_client", "declined_by_client"];

export async function loadWarehousesInput(cabinetId) {
  const { tenantQuery } = await getDb();
  const [posRows, skuRows, locations, sellerWarehouses, fbsStock, fbsVelocity, gaps, docs, settings, wbTargets, ozTargets] = await Promise.all([
    tenantQuery(`SELECT id, internal_name, qty, unit_cost, location_id FROM tenant.ff_inventory WHERE archived_at IS NULL ORDER BY id`),
    tenantQuery(`SELECT ff_inventory_id, platform, nm_id, product_id, sku_name, im_url FROM tenant.ff_inventory_skus ORDER BY created_at, id`),
    tenantQuery(`SELECT id, name, address, city, loc_type, is_active, wb_warehouse_id, ozon_warehouse_id FROM tenant.stock_ff_locations ORDER BY name`),
    tenantQuery(`SELECT platform, warehouse_id, name, kind, is_active FROM tenant.mp_seller_warehouses ORDER BY platform, name`),
    tenantQuery(`SELECT s.platform, s.warehouse_id, s.sku_key, s.present, s.reserved
                 FROM tenant.mp_fbs_daily_stock s
                 JOIN (SELECT platform, MAX(date) AS d FROM tenant.mp_fbs_daily_stock GROUP BY 1) m
                   ON m.platform = s.platform AND m.d = s.date`),
    tenantQuery(`SELECT 'wb' AS platform, warehouse_id, nm_id AS sku_key, COUNT(*)::int AS orders_qty
                 FROM tenant.wb_fbs_tasks
                 WHERE warehouse_id IS NOT NULL AND nm_id IS NOT NULL
                   AND created_at >= now() - ($1 || ' days')::interval
                   AND COALESCE(wb_status, '') <> ALL($2::text[])
                 GROUP BY 1, 2, 3
                 UNION ALL
                 SELECT 'ozon', warehouse_id, product_id, SUM(qty)::int
                 FROM tenant.ozon_orders
                 WHERE scheme = 'fbs' AND warehouse_id IS NOT NULL AND product_id IS NOT NULL
                   AND COALESCE(is_cancel, 0) = 0
                   AND order_dt >= to_char(now() - ($1 || ' days')::interval, 'YYYY-MM-DD')
                 GROUP BY 1, 2, 3`, [String(VELOCITY_WINDOW_DAYS), WB_TASK_CANCELLED]),
    tenantQuery(`SELECT id, platform, warehouse_id, sku_key, qty, reason, src_kind, src_ref, first_seen_at
                 FROM tenant.stock_move_gaps WHERE resolved_at IS NULL ORDER BY first_seen_at`),
    tenantQuery(`SELECT id, platform, status, shipped_at, ship_dt, dest_warehouse_id, dest_warehouse
                 FROM tenant.ff_shipment_docs WHERE status <> 'draft' ORDER BY id`),
    readSupplySettings(cabinetId),
    collectTargets({ platform: "wb" }),
    collectTargets({ platform: "ozon" }),
  ]);
  return {
    settings,
    positions: normalizePositions(posRows, skuRows),
    locations: locations.map((l) => ({ ...l, id: Number(l.id), wb_warehouse_id: l.wb_warehouse_id == null ? null : Number(l.wb_warehouse_id), ozon_warehouse_id: l.ozon_warehouse_id == null ? null : Number(l.ozon_warehouse_id) })),
    sellerWarehouses: sellerWarehouses.map((w) => ({ ...w, warehouse_id: Number(w.warehouse_id) })),
    fbsStock: fbsStock.map((r) => ({ platform: r.platform, warehouse_id: Number(r.warehouse_id), sku_key: Number(r.sku_key), present: Number(r.present) || 0, reserved: Number(r.reserved) || 0 })),
    fbsVelocity: fbsVelocity.map((r) => ({ platform: r.platform, warehouse_id: Number(r.warehouse_id), sku_key: Number(r.sku_key), orders_qty: Number(r.orders_qty) || 0 })),
    fboTargets: [...wbTargets, ...ozTargets],
    gaps: gaps.map((g) => ({ ...g, id: Number(g.id), warehouse_id: g.warehouse_id == null ? null : Number(g.warehouse_id), sku_key: g.sku_key == null ? null : Number(g.sku_key), qty: Number(g.qty) || 0 })),
    docs: docs.map((d) => ({ ...d, id: Number(d.id), dest_warehouse_id: d.dest_warehouse_id == null ? null : Number(d.dest_warehouse_id) })),
  };
}

export async function loadWarehouseSignals(cabinetId, now = new Date()) {
  const input = await loadWarehousesInput(cabinetId);
  const matrix = buildMatrix(input);
  return buildSignals({ matrix, gaps: input.gaps, docs: input.docs, settings: input.settings, now });
}

export { buildMatrix, buildPlaceCards, buildSignals };
```

Перед написанием SQL исполнитель проверяет типы под `saas_ro`: `is_cancel` в `tenant.ozon_orders` (если boolean — `NOT COALESCE(is_cancel,false)`), `created_at` в `wb_fbs_tasks` (timestamptz), `order_dt` (text). Проверка живьём (кабинет 1, только чтение): каждый SELECT выше с `WHERE cabinet_id = 1` — выполняется без ошибок; число строк `fbsStock` по площадкам совпадает со сторожем этапа 1 (`fbs_stock_today`).

- [ ] **Step 4: Роут**

```js
// app/api/cabinets/[id]/warehouses/route.js — витрина «Склады 2.0» (спека §5).
// GET ?tab=matrix|places → всегда { signals, settings, generatedAt } + данные вкладки.
//   Вкладка «Поставки» ходит в существующие /supply-plan и /shipments — здесь ничего.
// POST { action:'inventory_adjust', location_id|null, note, lines:[{ff_inventory_id, qty_fact}] }
//   (role: manager) — инвентаризация места: по строке движение adjust через applyMove.
//   Все 400 — ДО первой записи (withCabinet коммитит любой ответ): строки блокируются
//   SELECT … FOR UPDATE по возрастанию id (как update_qty в /inventory), план дельт —
//   чистая planInventoryAdjust.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { applyMove } from "@/lib/stockLedger.js";
import { loadWarehousesInput, buildMatrix, buildPlaceCards, buildSignals } from "@/lib/warehousesData.js";
import { planInventoryAdjust } from "@/lib/warehousesMetrics.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const tab = url.searchParams.get("tab") || "matrix";
  if (!["matrix", "places"].includes(tab)) return NextResponse.json({ error: "tab must be matrix|places" }, { status: 400 });
  const input = await loadWarehousesInput(cabinet.cabinet_id);
  const matrix = buildMatrix(input);
  const signals = buildSignals({ matrix, gaps: input.gaps, docs: input.docs, settings: input.settings });
  const base = { signals, settings: input.settings, generatedAt: new Date().toISOString() };
  if (tab === "matrix") return NextResponse.json({ ...base, matrix });
  const { places, fboWarehouses } = buildPlaceCards(input);
  return NextResponse.json({ ...base, places, fboWarehouses, locations: input.locations, sellerWarehouses: input.sellerWarehouses, items: input.positions });
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  if (b.action !== "inventory_adjust") return NextResponse.json({ error: `unknown action: ${b.action}` }, { status: 400 });
  const note = String(b.note ?? "").trim();
  if (!note) return NextResponse.json({ error: "note required (причина инвентаризации)" }, { status: 400 });
  const locationId = b.location_id == null ? null : Number(b.location_id);
  if (locationId != null && !(Number.isInteger(locationId) && locationId > 0)) return NextResponse.json({ error: "location_id must be a positive integer or null" }, { status: 400 });
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const ids = [...new Set(lines.map((l) => Number(l.ff_inventory_id)).filter((x) => Number.isInteger(x) && x > 0))].sort((a, c) => a - c);
  if (!ids.length) return NextResponse.json({ error: "нет строк" }, { status: 400 });
  // Блокировка по возрастанию id — детерминированный порядок против дедлока (как в этапах 2–3).
  const cur = await tenantQuery(
    `SELECT id, qty FROM tenant.ff_inventory
     WHERE id = ANY($1::bigint[]) AND archived_at IS NULL AND ($2::bigint IS NULL OR location_id = $2)
     ORDER BY id FOR UPDATE`, [ids, locationId]);
  const plan = planInventoryAdjust(cur.map((r) => ({ id: Number(r.id), qty: Number(r.qty) })), lines);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });
  const stamp = new Date().toISOString();
  const userId = session?.user_id ?? null;
  let applied = 0;
  for (const m of plan.moves) {
    const r = await applyMove({ ffInventoryId: m.id, kind: "adjust", qty: m.delta, srcKind: "manual", srcRef: `inv:${stamp}:${m.id}`, note: `инвентаризация: ${note}`, userId });
    if (r.applied) applied += 1;
  }
  return NextResponse.json({ ok: true, applied, unchanged: lines.length - plan.moves.length });
}, { requireRole: "manager" });
```

Исполнитель сверяет сигнатуру `applyMove` по `lib/stockLedger.js:9` (ключи `ffInventoryId/kind/qty/srcKind/srcRef/note/userId`, как в `inventory/route.js update_qty`) и `session.user_id` по `shipments/route.js:201`.

- [ ] **Step 5: Проверки**

`node --test lib/__tests__/*.test.mjs` → всё зелёное (+1). `npm run build` → `✓ Compiled successfully`, роут в манифесте. Живая проверка чтения: каждый SQL адаптера прогнать под `saas_ro` с `WHERE cabinet_id = 1` — без ошибок; в отчёт — число позиций/мест/строк снимка/скорости (ожидание на 08.09: 12 позиций, все `location_id IS NULL`; матрица без ФФ-ячеек, но с FBO-колонками WB «Склад WB» и Ozon-складами).

- [ ] **Step 6: Коммит**

```bash
git add lib/warehousesData.js lib/__tests__/warehousesData.test.mjs "app/api/cabinets/[id]/warehouses/route.js"
git commit -m "feat(warehouses): адаптер данных витрины и роут /warehouses — матрица, места, сигналы, инвентаризация"
```

---

### Task 4: Подготовка переиспользования UI — `LocationsManager` в отдельный файл, `embedded` у `ShipmentsPage`

**Files:**
- Create: `app/cabinets/[id]/inventory/LocationsManager.jsx` (перенос `function LocationsManager` из `InventoryPage.jsx:871` до конца её тела, вместе с локальными helper'ами/стилями, которые использует только она)
- Modify: `app/cabinets/[id]/inventory/InventoryPage.jsx` (импорт вместо локальной функции; поведение не меняется)
- Modify: `app/cabinets/[id]/shipments/ShipmentsPage.jsx` (проп `embedded`)

**Interfaces:**
- Produces: `export function LocationsManager({ cabinetId, locations, reload, sellerWarehouses })` — та же сигнатура; `ShipmentsPage({ cabinetId, embedded = false })` — при `embedded` не рендерит заголовок страницы (h1/шапку), только секцию рекомендаций и таблицу документов.

- [ ] **Step 1:** Вырезать `LocationsManager` (и только её зависимости: если она использует общие константы стилей `InventoryPage.jsx`, продублировать их в новом файле с пометкой «копия из InventoryPage» — не экспортировать из страницы). В `InventoryPage.jsx` добавить `import { LocationsManager } from "./LocationsManager";`. Ни одной логической правки.
- [ ] **Step 2:** В `ShipmentsPage.jsx` добавить проп `embedded`; обернуть заголовок страницы в `{!embedded && (…)}`. Остальное без изменений.
- [ ] **Step 3:** `npm run build` → зелёная; `git diff --stat` показывает перенос (удалено ≈ добавлено в паре файлов).
- [ ] **Step 4: Коммит**

```bash
git add "app/cabinets/[id]/inventory/LocationsManager.jsx" "app/cabinets/[id]/inventory/InventoryPage.jsx" "app/cabinets/[id]/shipments/ShipmentsPage.jsx"
git commit -m "refactor(inventory,shipments): LocationsManager в отдельный файл, embedded-режим ShipmentsPage"
```

---

### Task 5: Страница `/warehouses` — каркас, сигналы, вкладка «Матрица», пункт меню

**Files:**
- Create: `app/cabinets/[id]/warehouses/page.js`, `WarehousesPage.jsx`, `SignalsStrip.jsx`, `MatrixTab.jsx`
- Modify: `app/cabinets/[id]/layout.js:38-45` (пункт «Склады» первым в группе «Товары»)

**Interfaces:**
- Consumes: GET `/api/cabinets/[id]/warehouses?tab=matrix` → `{ signals, settings, matrix:{columns, rows} }`.
- Produces: `WarehousesPage({ cabinetId })` с вкладками `matrix|places|supplies` (`?tab=` в URL через `useSearchParams`, дефолт `matrix`); `SignalsStrip({ signals, cabinetId })`; `MatrixTab({ cabinetId })`.

- [ ] **Step 1: page.js и каркас**

```js
// app/cabinets/[id]/warehouses/page.js
import WarehousesPage from "./WarehousesPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <WarehousesPage cabinetId={Number(params.id)} />;
}
```

```jsx
// app/cabinets/[id]/warehouses/WarehousesPage.jsx
"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { C } from "@/lib/palette.js";
import { SignalsStrip } from "./SignalsStrip";
import { MatrixTab } from "./MatrixTab";

const TABS = [["matrix", "Матрица"], ["places", "Места"], ["supplies", "Поставки"]];

export default function WarehousesPage({ cabinetId }) {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = TABS.some(([k]) => k === sp.get("tab")) ? sp.get("tab") : "matrix";
  const [signals, setSignals] = useState(null);
  const setTab = (k) => router.replace(`?tab=${k}`);
  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Склады</h1>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 12 }}>Свой учёт против остатков на МП, покрытие по каждому месту и складу, поставки</div>
      <SignalsStrip cabinetId={cabinetId} signals={signals} />
      <div style={{ display: "flex", gap: 6, margin: "12px 0" }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${C.line}`, background: tab === k ? C.accent : "transparent", color: tab === k ? "var(--accentInk)" : C.ink, cursor: "pointer", fontWeight: 600 }}>{label}</button>
        ))}
      </div>
      {tab === "matrix" && <MatrixTab cabinetId={cabinetId} onSignals={setSignals} />}
      {tab === "places" && <PlacesTabLazy cabinetId={cabinetId} onSignals={setSignals} />}
      {tab === "supplies" && <SuppliesTabLazy cabinetId={cabinetId} />}
    </div>
  );
}
// До задачи 6 вкладки «Места» и «Поставки» — заглушки; задача 6 заменяет их на PlacesTab/SuppliesTab.
function PlacesTabLazy() { return <div style={{ color: C.muted }}>Карточки мест — следующая задача плана.</div>; }
function SuppliesTabLazy() { return <div style={{ color: C.muted }}>Поставки — следующая задача плана.</div>; }
```

- [ ] **Step 2: SignalsStrip** — горизонтальная полоса пиллов: цвет по `level` (`crit` → `soft(C.neg, …)`, `warn` → `soft(C.warn, …)`), текст сигнала, клик по `discrepancy`/`low_coverage` → `?tab=matrix&problems=1`, `gaps` → `?tab=places`, `waiting_accept` → `?tab=supplies`; `signals === null` → «Считаем…», `[]` → зелёный пилл «Проблем нет». Раскрытие по клику на пилл `low_coverage` показывает `items[].text` списком.

- [ ] **Step 3: MatrixTab** — загрузка `GET ?tab=matrix` (после ответа вызывает `onSignals(data.signals)`); фильтры: площадка (все/WB/Ozon — скрывает колонки FBO другой площадки и Δ другой площадки в ФФ-ячейках), «только проблемные» (по `row.problem`, стартовое значение из `?problems=1`), поиск по `name`/`skus`; сортировка `useSort` (скопировать `useSort`/`SortTh`/`cmpVal` из `stocks/StocksPage.jsx:65-100` в `MatrixTab.jsx` — там они не экспортируются; пометить «копия из StocksPage»), ключи сортировки: `name`, `own`, `mp`, `fbo`, `gapsQty` и по каждой колонке (`coverage` ячейки, `null` — в конец). Таблица в контейнере `overflow-x:auto; max-height: 70vh; overflow-y:auto`, первая колонка `position: sticky; left: 0; background: C.bg; z-index: 1`, шапка `position: sticky; top: 0`. Ячейка ФФ: три строки «свой N», «WB N (Δ ±k)» / «Ozon …» (только для привязанных площадок; неприв. — «—»), «покрытие N дн»; фон `soft(C.warn, 25)` при `flags.delta`, `soft(C.neg, 25)` при `flags.low`; пустая ячейка — «·». Ячейка FBO: «N (+в пути M)», «покрытие N дн», фон красный при `low`. Итоги: «свой / на МП / FBO» и «не разнесено: k шт (n)» — при `gapsCount > 0` красным. Пустое состояние (нет строк) — подсказка «Позиции ФФ не привязаны к местам — привяжите их в «Места» и в «Остатки склад/ФФ»». Число строк/колонок над таблицей.

- [ ] **Step 4: Меню** — в `layout.js` группу «Товары» начать с `{ href: "/warehouses", label: "Склады" }` (перед «Себестоимость»; остальные пункты не трогать — §5: старые страницы остаются до приёмки).

- [ ] **Step 5:** `npm run build` → зелёная, `/cabinets/[id]/warehouses` в манифесте.

- [ ] **Step 6: Коммит**

```bash
git add "app/cabinets/[id]/warehouses/page.js" "app/cabinets/[id]/warehouses/WarehousesPage.jsx" "app/cabinets/[id]/warehouses/SignalsStrip.jsx" "app/cabinets/[id]/warehouses/MatrixTab.jsx" "app/cabinets/[id]/layout.js"
git commit -m "feat(warehouses-ui): страница /warehouses — сигналы, матрица «товар × место», пункт меню"
```

---

### Task 6: Вкладки «Места» (карточки, инвентаризация, перемещение, настройки) и «Поставки»

**Files:**
- Create: `app/cabinets/[id]/warehouses/PlacesTab.jsx`, `PlaceCard.jsx`, `FboCard.jsx`, `InventoryModal.jsx`, `SuppliesTab.jsx`
- Modify: `app/cabinets/[id]/warehouses/WarehousesPage.jsx` (заменить заглушки на импорты)

**Interfaces:**
- Consumes: GET `?tab=places` → `{ signals, settings, places, fboWarehouses, locations, sellerWarehouses, items }`; POST `/warehouses` `inventory_adjust`; `TransferFormModal({ cabinetId, items, locations, onClose, onDone })` из `../inventory/TransferFormModal`; `LocationsManager({ cabinetId, locations, reload, sellerWarehouses })` из `../inventory/LocationsManager`; `ShipmentsPage({ cabinetId, embedded })`.
- Produces: `PlacesTab({ cabinetId, onSignals })`, `SuppliesTab({ cabinetId })`.

- [ ] **Step 1: PlacesTab** — грузит `?tab=places`, `onSignals(data.signals)`; две секции: «Места (ФФ и склады)» — сетка карточек `PlaceCard` (`unbound` карточки — с красной подписью «не привязан ни к одному месту» и кнопкой «Привязать» → раскрывает `LocationsManager` внизу); «FBO-склады маркетплейсов» — сетка `FboCard`. Внизу — свёрнутый блок «⚙ Настройки мест» с `LocationsManager` (привязка складов, город, активность — как на `/inventory`). Кнопка «Перемещение» на карточке места открывает `TransferFormModal` с `items` (из ответа, поле `items` — позиции с `location_id`, `qty`, `internal_name`; проверь, какие поля ждёт модалка: `TransferFormModal.jsx:16-30`, при нехватке полей — расширь `items` в роуте задачи 3, не модалку) и `locations`, предвыбранным «откуда» = место карточки (если модалка не принимает preset — добавь опциональный проп `fromLocationId` в модалку, default undefined, поведение без пропа не меняется). После `onDone` — reload.

- [ ] **Step 2: PlaceCard** — шапка: имя, город/адрес, пилл активности; строка привязок «WB: <имя> · Ozon: <имя>» (нет → «не привязан» красным); метрики: позиций / единиц / стоимость (₽, 2 знака) / скорость (шт/дн) / покрытие (дн, красным < `settings.minDays`); блок «Проблемы»: расхождения (`name`, площадка, «свой X, на МП Y, Δ ±k»), не разнесено (`reason` по-русски: `no_location` «нет места для склада», `no_item` «нет позиции с артикулом», `insufficient` «не хватило остатка»; `src_ref`, дата), мало (`name`, «покрытие N дн»); пустые списки не рендерятся, при отсутствии проблем — «Проблем нет». Кнопки (`canManage` — роль из `GET /api/cabinets/[id]/me`, как в `ShipmentsPage.jsx`): «Перемещение», «Инвентаризация».

- [ ] **Step 3: InventoryModal** — таблица позиций места (`items.filter(location_id === id)`): имя, учёт (`qty`), поле «факт» (предзаполнено учётом), Δ на лету; одно поле «Причина» (обязательное); «Сохранить» → POST `{ action:'inventory_adjust', location_id, note, lines:[{ff_inventory_id, qty_fact}] }` только по строкам, где факт введён (пустое поле = не трогать); ответ `{applied, unchanged}` → тост «Проведено движений: N», reload; 400 → текст ошибки в модалке.

- [ ] **Step 4: FboCard** — площадка, имя, регион/кластер (если есть в `fboTargets.regionKey` — роут задачи 3 отдаёт `regionKey` в карточке через `buildPlaceCards`? нет — добавь в `FboCard` из `matrix.columns`? Проще: в задаче 3 `FboCard` не несёт регион → показывать только имя; регион — вне рамок), позиций / единиц (+в пути) / скорость / покрытие; «ниже минимума» список `low`; «открытые поставки» — `openDocs` со ссылкой `?tab=supplies`.

- [ ] **Step 5: SuppliesTab** — `return <ShipmentsPage cabinetId={cabinetId} embedded />` (импорт `../shipments/ShipmentsPage`).

- [ ] **Step 6:** Заменить заглушки в `WarehousesPage.jsx`. `npm run build` → зелёная.

- [ ] **Step 7: Коммит**

```bash
git add "app/cabinets/[id]/warehouses/PlacesTab.jsx" "app/cabinets/[id]/warehouses/PlaceCard.jsx" "app/cabinets/[id]/warehouses/FboCard.jsx" "app/cabinets/[id]/warehouses/InventoryModal.jsx" "app/cabinets/[id]/warehouses/SuppliesTab.jsx" "app/cabinets/[id]/warehouses/WarehousesPage.jsx"
# + "app/cabinets/[id]/inventory/TransferFormModal.jsx" и роут warehouses, если расширялись
git commit -m "feat(warehouses-ui): карточки мест и FBO-складов, инвентаризация, перемещение, вкладка «Поставки»"
```

---

### Task 7: Сигналы склада на главной — `alerts.warehouses` и виджет «Заканчиваются» на каноне

**Files:**
- Modify: `app/api/cabinets/[id]/overview/route.js:163-253` (блок lowStock) и `:389` (`alerts`)
- Modify: `app/cabinets/[id]/OverviewClient.jsx:314-336` (виджет) + новая карточка «Склады»

**Interfaces:**
- Consumes: `loadWarehouseSignals(cabinetId)` из `@/lib/warehousesData.js`.
- Produces: `alerts.warehouses: Signal[]`, `alerts.lowStock: [{ name, where, qty, days_to_oos }]` (из сигнала `low_coverage.items`: `name`, `where`, `qty`, `coverage`), `noCogsCount` без изменений.

- [ ] **Step 1: Роут** — заменить SQL `lowStock` (строки 224-253) на:

```js
// Сигналы склада (Склады 2.0, этап 4) — тот же расчёт, что вкладка /warehouses; канон 28/28,
// остаток «доступно». Виджет «Заканчиваются на складе» с 2026-09-XX считает по нему (обе
// площадки, с местом/складом) — раньше был отдельный WB-only расчёт по дням с продажами.
let warehouses = [];
try {
  warehouses = await loadWarehouseSignals(cabinet.cabinet_id);
} catch (e) {
  console.error("[overview] warehouse signals failed:", e?.message || e);
}
const lowSig = warehouses.find((s) => s.kind === "low_coverage");
lowStock = (lowSig?.items || []).map((x) => ({ name: x.name, where: x.where, qty: x.qty, days_to_oos: x.coverage }));
```

Блок вызывается вне условия `mp !== "ozon" && mps.includes('wb')` (сигналы — обеих площадок); `alerts: { lossMakers, lowStock, noCogsCount, warehouses }`. `lossMakers`/`noCogsCount` не трогать. Ошибка расчёта сигналов не роняет главную (try/catch выше).

- [ ] **Step 2: UI** — в виджете «Заканчиваются на складе» колонки «Товар · Где · Остаток · дней», подсказка `hint="покрытие < минимального запаса, канон 28 дн"`; ключ строки `${t.name}|${t.where}`. Новая карточка «🏬 Склады» рядом (в том же `grid`): список `alerts.warehouses` пиллами по `level` с текстом и ссылкой `Link` на `/cabinets/${id}/warehouses?tab=…` (как в `SignalsStrip`; можно переиспользовать `SignalsStrip` — импорт из `./warehouses/SignalsStrip`, проп `cabinetId`), пусто → «Проблем на складах нет».

- [ ] **Step 3:** `npm run build` → зелёная. Живая проверка: `GET /api/cabinets/1/overview` через существующий смоук-скрипт проверки панели (см. AGENTS.md «Протокол проверки») или `curl` с cookie сессии владельца — если сессии нет, проверить чтением кода и отметить в отчёте.

- [ ] **Step 4: Коммит**

```bash
git add "app/api/cabinets/[id]/overview/route.js" "app/cabinets/[id]/OverviewClient.jsx"
git commit -m "feat(overview): сигналы склада на главной, виджет «Заканчиваются» на каноне покрытия"
```

---

### Task 8: Сторож этапа 4, документация, деплой, приёмка

**Files:**
- Create: `scripts/check-warehouses-stage4.sql`
- Modify: `AGENTS.md` (подраздел «Склады 2.0 — этап 4 «Витрина»» после этапа 3; «Где что считается» — строка про сигналы/виджет главной), спека §5.4 (сигналы: главная + `/warehouses`, брифинг — вне репозитория), §5 (решение по старым страницам — кандидаты, решает владелец после приёмки), §7 (этап 4 — ГОТОВО с датой)

- [ ] **Step 1: Сторож** (образец формата — `scripts/check-warehouses-stage3.sql`; каждая проверка — `check | ok | диагностика`, все tenant-запросы с `WHERE cabinet_id=1`):

1. `ledger_invariant` — как в этапах 2–3 (регресс-сеть).
2. `matrix_own_equals_inventory` — Σ `qty` активных позиций с `location_id` = Σ по местам из независимого запроса (`GROUP BY location_id`) — проверка на уровне SQL, что «свой» в матрице нечему разойтись с `/inventory`: `SUM(qty) FILTER (location_id IS NOT NULL) + SUM(qty) FILTER (location_id IS NULL) = SUM(qty)` и число позиций без места (диагностика `unplaced_positions`, `unplaced_units`).
3. `fbs_snapshot_fresh` — последний снимок `mp_fbs_daily_stock` каждой площадки не старше 2 дней (`ok` = обе площадки свежие или у площадки нет складов продавца).
4. `gaps_open_count` — число открытых `stock_move_gaps` по причинам (диагностика; `ok=t` всегда — сигнал, не ошибка) и что у каждого открытого gap есть `platform` и `qty > 0`.
5. `bindings_unique` — один склад продавца не привязан к двум местам (частичные индексы этапа 1 — контроль, что не сняты).
6. `waiting_accept_docs` — документы `shipped` старше 7 дней без приёмки: диагностика `count`, `ok=t` (сигнал).
7. `fbs_velocity_sources` — за 28 дней есть задания WB с `warehouse_id` и постинги Ozon `scheme='fbs'` с `warehouse_id` (доля с заполненным складом ≥ 0.95 среди неотменённых) — иначе скорость мест занижена.

Прогнать: `psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage4.sql` → все `ok=t`; расхождение — разобраться (данные или запрос), не подгонять.

- [ ] **Step 2: Документация** — AGENTS.md: файлы и контракты (`lib/warehousesMetrics.js`, `lib/warehousesData.js`, роут, UI), группировка строк матрицы, что такое Δ и порог, FBS-скорость мест (источники и исключённые статусы), сигналы (4 вида, пороги `WAITING_ACCEPT_DAYS`/`LOW_COVERAGE_TOP`), смена виджета главной, инвентаризация = движения `adjust` с `src_ref inv:<stamp>:<id>`, что руками (привязки), кандидаты на удаление из меню (`/ff-stock`, `/shipments`) — решает владелец. Спека — правки выше.

- [ ] **Step 3: grep-инвариант** `grep -rnE "SET qty\b" app lib worker --include=*.js --include=*.py | grep -v "stockLedger.js\|stock_ledger.py"` → пусто.

- [ ] **Step 4 (контроллер):** `npm run build && systemctl restart saas-web`; сторожа 1–4; смоук главной и `/warehouses` (200).

- [ ] **Step 5 (владелец):** привязать места и склады; проверить на 2 товарах: «свой» = `/inventory`, «на МП» = `/mp-stock` (FBS-снимок), FBO-ячейка = `/stocks`; расхождение Δ у одного товара после ручной правки qty на `/inventory`; инвентаризация одного места (факт ≠ учёт → движение `adjust` в журнале); сигналы на главной = полосе сигналов на `/warehouses`; решить судьбу `/ff-stock`, `/shipments`, `/mp-stock`, `/move`.

- [ ] **Step 6: Коммит**

```bash
git add scripts/check-warehouses-stage4.sql AGENTS.md docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md
git commit -m "docs(warehouses): этап 4 «Витрина» — сторож, документация, решение по старым страницам"
```

## Self-review

**Покрытие спеки §5:** 5.1 матрица → задачи 1, 3, 5 (строки по паре артикулов, ячейки ФФ «свой/на МП/Δ» по площадкам, FBO-колонки с покрытием, итоги и «не разнесено», фильтры/сортировка/закреплённая колонка); 5.2 места → задачи 2, 3, 6 (карточки ФФ с привязками/стоимостью/скоростью/проблемами, кнопки «Перемещение» и «Инвентаризация», настройки места через `LocationsManager`; карточки FBO-складов с открытыми поставками); 5.3 поставки → задача 6 (встроенная `ShipmentsPage`, пороги и кратность уже в настройках/`/inventory` с этапа 3); 5.4 сигналы → задачи 2, 7 (главная и `/warehouses`; брифинг — вне репозитория, отклонение задокументировано в задаче 8); §3.5 → задача 1; §6 «Этап 4» → задачи 8 (сторож, приёмка: матрица = `/inventory`/`/mp-stock`/`/stocks`, карточка = `stock_move_gaps`, сигналы главной = вкладке); «решение по старым страницам» → задача 8 (кандидаты названы, решает владелец).

**Плейсхолдеры:** нет. Регион FBO-склада в карточке (§5.2) — осознанно не показывается (нет в `buildPlaceCards`), отмечено в задаче 6.

**Согласованность имён:** `buildMatrix/buildPlaceCards/buildSignals/planInventoryAdjust/itemKeyOf` (1–2) ← 3, 7; `loadWarehousesInput/loadWarehouseSignals/normalizePositions` (3) ← 7; ответ GET `{signals, settings, matrix}` / `{…, places, fboWarehouses, locations, sellerWarehouses, items}` (3) ← 5, 6; `Signal.items[].{text, where, qty, coverage}` (2) ← 5 (полоса), 7 (виджет); `LocationsManager`/`embedded` (4) ← 6.
