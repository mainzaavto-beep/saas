# Дашборд показателей — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница «Дашборд показателей» (`/cabinets/[id]/kpi`): сетка KPI-плиток за период с прошлым периодом, дельтой, цветом «хорошо/плохо», раскрытием состава, фильтрами и личной настройкой плиток.

**Architecture:** Никаких новых денежных формул. Товарные строки — тот же `buildTotals`, что у «Сводки по товарам» (выносится из роута в `lib/productsSummaryData.js`); без товарного фильтра деньги берутся из кабинетного канона `wbProfitCabinet`/`ozProfitCabinet` (как `/pnl`). Чистое ядро `lib/kpiDashboard.js` (без импортов, работает и на клиенте) превращает агрегаты в плитки; адаптер `lib/kpiDashboardData.js` грузит источники под SAVEPOINT; роут `app/api/cabinets/[id]/kpi/route.js`; личный layout — `tenant.kpi_dashboard_prefs` (миграция 068).

**Tech Stack:** Next.js 14 App Router, PostgreSQL (RLS), `node:test`, React (клиентские компоненты), палитра `lib/palette.js`.

**Spec:** `docs/superpowers/specs/2026-10-15-kpi-dashboard-design.md`

## Global Constraints

- Все проверки и записи — только кабинет #1. Боевые кабинеты клиентов не трогать.
- Прибыль = канон (`wbProfitCabinet`/`ozProfitCabinet` без фильтра, `*ProfitProductBatch` через строки Сводки с фильтром); `opex` в прибыль НЕ входит.
- Пустой `catch {}` без `console.error` запрещён.
- Запросы внутри одного HTTP-запроса — строго последовательно (`withCabinet` = одна транзакция, один клиент PG; `Promise.all` запрещён).
- `lib/*.js` импортируют друг друга ОТНОСИТЕЛЬНО (`./db.js`), не через `@/` — иначе node-скрипты и тесты не загрузят модуль.
- Порог цвета: |относительное изменение| < 1 % → без цвета. Расходы оцениваются по доле в выручке (`revenue`).
- Миграции идемпотентны, номер `068`.
- Бэкап боевого файла перед правкой — в `/opt/agentsDB/backups/` (`<имя>.<YYYYMMDD_HHMMSS>.bak`).
- После правок `app/`/`lib/` — `npm run build && systemctl restart saas-web`. `next dev` в каталоге прода НЕ запускать.
- `git add` — только явным списком файлов задачи (никаких `git add -A`/`.`).
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Ветка `feat/kpi-dashboard` (уже создана), в `master` — только по слову владельца.
- Клиентские компоненты: `{ cabinetId }` в пропсах, fetch через backticks, хуки до ранних `return` (D1–D7 AGENTS.md).

## Файлы

| Файл | Что |
|---|---|
| `lib/productsSummaryData.js` (новый) | `buildTotals`, `aggTotals`, `collectWB`, `collectOzon`, `shiftDateUTC`, `round2` — перенос из роута Сводки без изменения логики (+ `profitGross` у WB-строк) |
| `app/api/cabinets/[id]/products-summary/route.js` | импортирует перенесённое, своё тело GET не меняется |
| `lib/kpiDashboard.js` (новый) | чистое ядро: агрегаты, кабинетные статьи → плитки, метрики, плитки, цвет, раскрытие, layout |
| `lib/__tests__/kpiDashboard.test.mjs` (новый) | тесты ядра |
| `lib/kpiDashboardData.js` (новый) | загрузка источников (SAVEPOINT), фильтры, opex |
| `db/migrations/068_kpi_dashboard_prefs.sql` (новый) | таблица личного layout |
| `app/api/cabinets/[id]/kpi/route.js` (новый) | GET / POST |
| `lib/__tests__/roleGuards.test.mjs` | гард: роут kpi без requireRole, user_id из сессии |
| `app/cabinets/[id]/kpi/page.js`, `KpiPage.jsx`, `KpiTile.jsx`, `MultiSelect.jsx`, `WidgetSettings.jsx` (новые) | UI |
| `app/cabinets/[id]/layout.js` | пункт меню |
| `scripts/smoke-kpi.mjs` (новый) | сверка с `/pnl` и Сводкой |
| `AGENTS.md` | абзац в «Где что считается» + строка в TL;DR |

---

### Task 1: Вынести расчёт Сводки в `lib/productsSummaryData.js`

Цель — дашборд и Сводка считают строки ОДНИМ кодом. Логика не меняется; единственное добавление — поле `profitGross` у WB-строк (у Ozon оно уже есть), нужно для метрики «Валовая прибыль» при товарном фильтре.

**Files:**
- Create: `lib/productsSummaryData.js`
- Modify: `app/api/cabinets/[id]/products-summary/route.js` (удалить перенесённые функции, добавить import)

**Interfaces:**
- Produces: `export async function buildTotals(cabinet, platform, from, to, includeInactive, stat)` → `{ items, totals, unallocatedAds }` (как сейчас); `export function aggTotals(items)`; `export function shiftDateUTC(dateStr, deltaDays)`; `export function round2(x)`. Строка `items[]` несёт: `nm` (WB nm_id / Ozon product_id), `platform` ('wb'|'ozon'), `sa`, `name`, `brand`, `cat`, `grp`, `ordered`, `cancelled`, `sold`, `returns`, `buyoutSold`, `buyoutResolved`, `orderRub`, `salesRub`, `spp`, `realized`, `payout`, `costRub`, `commission`, `logistics`, `acquiring`, `loyalty`, `services` (Ozon), `returnLogistics`, `adSpend`, `tax`, `profit`, `profitGross`, `stock`, `unitCost`, `status`.

- [ ] **Step 1: Снять эталон ответа Сводки до переноса** (прод уже собран из текущего `master`)

```bash
mkdir -p /opt/agents/saas/scratchpad/kpi
cd /opt/agents/saas && cat > scratchpad/kpi/snap-summary.mjs <<'EOF'
// Снимок /products-summary кабинета #1 для сверки «до/после» переноса.
import { readFileSync, writeFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query } = await import('../../lib/db.js');
const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = 1');
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 3600 });
const out = {};
for (const pf of ['all', 'wb', 'ozon']) {
  const r = await fetch(`http://127.0.0.1:3200/api/cabinets/1/products-summary?platform=${pf}&from=2026-09-01&to=2026-09-30`,
    { headers: { cookie: `saas_session=${encodeURIComponent(seal)}` } });
  out[pf] = await r.json();
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log('saved', process.argv[2]);
process.exit(0);
EOF
node scratchpad/kpi/snap-summary.mjs scratchpad/kpi/summary-before.json
```
Expected: `saved scratchpad/kpi/summary-before.json`.

- [ ] **Step 2: Бэкап роута**

```bash
cp "app/api/cabinets/[id]/products-summary/route.js" "/opt/agentsDB/backups/products-summary.route.js.$(date +%Y%m%d_%H%M%S).bak"
```

- [ ] **Step 3: Перенести функции**

Перенести из `route.js` в новый `lib/productsSummaryData.js` БЕЗ правок тела (кроме экспорта, импортов и одной строки ниже): `round2` (стр. 234), `aggTotals` (236), `shiftDateUTC` (289), `buildTotals` (304), `collectWB` (512), `collectOzon` (697). Функции `unallocatedCabinetCosts`, `ozonSkuAdLagNote` и GET остаются в роуте. Комментарии переносятся вместе с функциями.

Шапка нового файла (импорты — относительные; набор — ровно то, что используют перенесённые функции, сверить `grep -n` по их телам: `DatabaseSync`, `wbAdTotal`, `wbProfitProductBatch`, `WB_COST_INFO_ONLY`, `ozProfitProductBatch`, `normalizeTaxMode`, `ZERO_PROFIT`, `aggregateBuyout`, `todayMsk`, `loadWbBuyoutRows`, `loadOzonBuyoutRows`; если какой-то не используется перенесённым кодом — оставить его в роуте):

```js
// lib/productsSummaryData.js — строки и итоги «Сводки по товарам» (перенос из
// app/api/cabinets/[id]/products-summary/route.js, 15.10.2026, без изменения логики):
// единый расчёт для Сводки и «Дашборда показателей» (lib/kpiDashboardData.js).
// Деньги каждой строки — канон *ProfitProductBatch; итоги — aggTotals + довычет
// нераспределённой рекламы (buildTotals). Импорты относительные — модуль грузят
// и node-скрипты (scripts/smoke-*.mjs).
import { DatabaseSync } from "./db.js";
import { wbAdTotal, wbProfitProductBatch, WB_COST_INFO_ONLY } from "./wbMetrics.js";
import { ozProfitProductBatch } from "./ozonMetrics.js";
import { normalizeTaxMode } from "./tax.js";
import { ZERO_PROFIT } from "./profitForms.js";
import { aggregateBuyout, todayMsk } from "./buyout.js";
import { loadWbBuyoutRows, loadOzonBuyoutRows } from "./buyoutData.js";
```

Каждую перенесённую функцию объявить с `export`. В `collectWB`, в объекте `out.push({...})`, сразу после строки `tax: f.tax, profit: f.profit,` дописать поле:

```js
      profitGross: f.profitGross, // валовая (до рекламы/налога) — канон wbProfitProductBatch; для «Дашборда показателей»
```

В `route.js` — добавить import и удалить перенесённые определения:

```js
import { buildTotals, round2, shiftDateUTC } from "@/lib/productsSummaryData.js";
```
(+ убрать из импортов роута то, что больше в нём не используется; `aggTotals`/`collectWB`/`collectOzon` роут напрямую не зовёт — проверить `grep -n "aggTotals\|collectWB\|collectOzon" route.js` → пусто.)

- [ ] **Step 4: Сборка и рестарт**

```bash
cd /opt/agents/saas && npm run build 2>&1 | tail -5 && systemctl restart saas-web && sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3200/login
```
Expected: сборка без ошибок, `200`.

- [ ] **Step 5: Сверить ответ Сводки «до/после»**

```bash
cd /opt/agents/saas && node scratchpad/kpi/snap-summary.mjs scratchpad/kpi/summary-after.json && node -e '
const a=require("./scratchpad/kpi/summary-before.json"), b=require("./scratchpad/kpi/summary-after.json");
const strip=(o)=>{for(const pf of ["all","wb","ozon"]) for(const it of o[pf].items) if(it.platform==="wb") delete it.profitGross; return JSON.stringify(o);};
console.log(strip(a)===strip(b) ? "IDENTICAL" : "DIFF");'
```
Expected: `IDENTICAL` (единственное отличие — новое поле `profitGross` у WB-строк, оно вычищено перед сравнением). При `DIFF` — найти расхождение, перенос не должен менять ни одной цифры.

- [ ] **Step 6: Commit**

```bash
git add lib/productsSummaryData.js "app/api/cabinets/[id]/products-summary/route.js"
git commit -m "refactor(summary): расчёт строк Сводки вынесен в lib/productsSummaryData.js

Без изменения логики (ответ /products-summary до/после идентичен);
WB-строки получили profitGross из канона — нужен дашборду показателей.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Чистое ядро `lib/kpiDashboard.js` + тесты

**Files:**
- Create: `lib/kpiDashboard.js`
- Test: `lib/__tests__/kpiDashboard.test.mjs`

**Interfaces:**
- Consumes: форма строки Сводки из Task 1.
- Produces (все — именованные экспорты, без импортов в модуле):
  - `TONE_THRESHOLD = 0.01`
  - `emptyAgg()` → объект с нулями по `AGG_KEYS`, `costLines: []`
  - `aggregateItems(items, { wbTaxBase = "realized" })` → `{ wb: Agg, ozon: Agg }`
  - `applyCanon(agg, canon, platform, { wbTaxBase })` → новый Agg: деньги из канона, штуки из agg, `costLines` из `canon.cabinetCosts`
  - `costTileOf(platform, costType)` → `"storage"|"acceptance"|"penalties"|"compensations"|"otherDeductions"`
  - `filterItems(items, { brands = [], cats = [], skus = [] })` → items; `skuKeyOf(item)` → `"wb:123"`
  - `computeMetrics(agg, { opex = null, productFilter = false })` → плоский объект метрик (null = недоступно)
  - `TILES` (24 базовых), `CATALOG` (9 доп.), `ALL_TILES`
  - `tileTone(def, curM, prevM)` → `"good"|"bad"|"neutral"`
  - `buildTiles({ cur, prev, productFilter, errors = [] })` → `Tile[]` (все из `ALL_TILES`); `cur`/`prev` = `{ wb: Agg|null, ozon: Agg|null, opex: number|null }`
  - `DEFAULT_LAYOUT`, `normalizeLayout(raw)` → `{ order, hidden, extra }`, `applyLayout(tiles, layout)` → видимые плитки по порядку
  - Tile: `{ key, title, value, unit, second: {value, unit}|null, prev, delta: {abs, pct}|null, tone, breakdown: [{label, value, unit}], unavailable: bool, error: bool, hint }`

- [ ] **Step 1: Написать тесты**

```js
// lib/__tests__/kpiDashboard.test.mjs — «Дашборд показателей» (15.10.2026), чистое ядро.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TONE_THRESHOLD, emptyAgg, aggregateItems, applyCanon, costTileOf, filterItems, skuKeyOf,
  computeMetrics, TILES, CATALOG, ALL_TILES, tileTone, buildTiles,
  DEFAULT_LAYOUT, normalizeLayout, applyLayout,
} from "../kpiDashboard.js";

const wbItem = (o = {}) => ({
  platform: "wb", nm: 11, sa: "CAM", name: "Камера", brand: "Acme", cat: "Видеорегистраторы",
  ordered: 10, cancelled: 1, sold: 8, returns: 1, buyoutSold: 6, buyoutResolved: 8,
  orderRub: 20000, salesRub: 16000, spp: 2000, realized: 14000, payout: 11000, costRub: 4000,
  commission: 3000, logistics: 1600, acquiring: 0, loyalty: 0, returnLogistics: 100,
  adSpend: 800, tax: 900, profit: 5700, profitGross: 7400, stock: 5, unitCost: 500, ...o,
});
const ozItem = (o = {}) => ({
  platform: "ozon", nm: 21, sa: "REG", name: "Регистратор", brand: "Beta", cat: "Электроника",
  ordered: 4, cancelled: 0, sold: 4, returns: 0, buyoutSold: 3, buyoutResolved: 4,
  orderRub: 8000, salesRub: 8000, spp: 0, realized: 8000, payout: 6000, costRub: 2000,
  commission: 1500, services: 200, logistics: 600, acquiring: 100, loyalty: 0, returnLogistics: 0,
  adSpend: 400, tax: 300, profit: 2900, profitGross: 3600, stock: 3, unitCost: null, ...o,
});

test("aggregateItems: суммы по площадкам, налоговая база WB по wbTaxBase", () => {
  const a = aggregateItems([wbItem(), wbItem({ nm: 12, stock: 0 }), ozItem()], { wbTaxBase: "realized" });
  assert.equal(a.wb.revenue, 32000);
  assert.equal(a.wb.sold, 16);
  assert.equal(a.wb.taxBase, 28000);
  assert.equal(a.ozon.taxBase, 8000);
  assert.equal(a.ozon.services, 200);
  assert.equal(a.wb.ads, 1600);
  assert.equal(a.wb.stockValue, 2500);
  assert.equal(a.ozon.stockValue, 0);
  assert.equal(a.ozon.stockNoCost, 1);
  assert.equal(aggregateItems([wbItem()], { wbTaxBase: "revenue" }).wb.taxBase, 16000);
});

test("costTileOf: известные статьи по плиткам, остальное — прочие удержания", () => {
  assert.equal(costTileOf("wb", "storage"), "storage");
  assert.equal(costTileOf("wb", "supply"), "acceptance");
  assert.equal(costTileOf("wb", "penalty"), "penalties");
  assert.equal(costTileOf("wb", "payout_other"), "compensations");
  assert.equal(costTileOf("wb", "subscription"), "otherDeductions");
  assert.equal(costTileOf("ozon", "accrual_46"), "storage");
  assert.equal(costTileOf("ozon", "accrual_93"), "penalties");
  assert.equal(costTileOf("ozon", "accrual_999"), "otherDeductions");
});

test("applyCanon: деньги из канона, штуки из строк, кабинетные статьи по плиткам", () => {
  const items = aggregateItems([wbItem()]).wb;
  const canon = {
    revenue: 17000, realized: 15000, payout: 12000, spp: 2000, cogs: 4100, commission: 3100,
    acquiring: 0, loyalty: 0, logistics: 1700, returnLogistics: 100, ads: 900, tax: 950,
    profit: 4000, profitGross: 8000,
    cabinetCosts: [
      { costType: "storage", label: "Хранение", amount: -300 },
      { costType: "payout_other", label: "Выплаты WB (компенсации)", amount: 200 },
      { costType: "subscription", label: "Подписка", amount: -100 },
    ],
  };
  const a = applyCanon(items, canon, "wb", { wbTaxBase: "realized" });
  assert.equal(a.revenue, 17000);
  assert.equal(a.profit, 4000);
  assert.equal(a.taxBase, 15000);
  assert.equal(a.sold, 8);              // штуки — из строк
  assert.equal(a.storage, 300);         // расход — положительным
  assert.equal(a.compensations, 200);   // доход — положительным
  assert.equal(a.otherDeductions, 100);
  assert.equal(a.costLines.length, 3);
  // тождество: Σ плиток статей (расходы − компенсации) = −Σ amount
  const net = a.storage + a.acceptance + a.penalties + a.otherDeductions - a.compensations;
  assert.equal(net, 200);
});

test("filterItems: бренд/категория/артикулы, пусто = без фильтра", () => {
  const items = [wbItem(), ozItem()];
  assert.equal(filterItems(items, {}).length, 2);
  assert.deepEqual(filterItems(items, { brands: ["Beta"] }).map(skuKeyOf), ["ozon:21"]);
  assert.deepEqual(filterItems(items, { cats: ["Видеорегистраторы"] }).map(skuKeyOf), ["wb:11"]);
  assert.deepEqual(filterItems(items, { skus: ["wb:11", "ozon:21"], brands: ["Acme"] }).map(skuKeyOf), ["wb:11"]);
});

test("computeMetrics: производные, деление на ноль → null, товарный фильтр гасит кабинетные", () => {
  const a = aggregateItems([wbItem()]).wb;
  const m = computeMetrics(a, { opex: 1000 });
  assert.equal(m.margin, 35.63);              // 5700 / 16000
  assert.equal(m.roi, 142.5);                 // 5700 / 4000
  assert.equal(m.drr, 4);                     // 800 / 20000
  assert.equal(m.buyoutPct, 75);
  assert.equal(m.avgPriceBeforeMp, 2000);     // 16000 / 8
  assert.equal(m.avgSalePrice, 1750);         // 14000 / 8
  assert.equal(m.logisticsPerUnit, 200);
  assert.equal(m.opex, 1000);
  assert.equal(m.storage, 0);
  const z = computeMetrics(emptyAgg(), {});
  assert.equal(z.margin, null);
  assert.equal(z.avgSalePrice, null);
  const f = computeMetrics(a, { opex: 1000, productFilter: true });
  for (const k of ["storage", "acceptance", "penalties", "otherDeductions", "compensations", "opex"]) assert.equal(f[k], null, k);
});

test("tileTone: рост прибыли хорошо; расход по доле в выручке; порог 1 %", () => {
  const def = (k) => ALL_TILES.find((t) => t.key === k);
  assert.equal(tileTone(def("profit"), { profit: 110 }, { profit: 100 }), "good");
  assert.equal(tileTone(def("profit"), { profit: 90 }, { profit: 100 }), "bad");
  assert.equal(tileTone(def("profit"), { profit: 100.5 }, { profit: 100 }), "neutral");
  // логистика упала в рублях, но доля выросла — плохо
  assert.equal(tileTone(def("logistics"), { logistics: 90, revenue: 800 }, { logistics: 100, revenue: 1000 }), "bad");
  assert.equal(tileTone(def("logistics"), { logistics: 90, revenue: 1000 }, { logistics: 100, revenue: 1000 }), "good");
  assert.equal(tileTone(def("taxBase"), { taxBase: 1 }, { taxBase: 100 }), "neutral");
  assert.equal(tileTone(def("profit"), { profit: 5 }, { profit: 0 }), "neutral");
  assert.equal(tileTone(def("logisticsPerUnit"), { logisticsPerUnit: 90 }, { logisticsPerUnit: 100 }), "good");
  assert.ok(TONE_THRESHOLD === 0.01);
});

test("buildTiles: значения, дельты, раскрытие WB/Ozon, недоступность и ошибки", () => {
  const cur = { ...aggregateItems([wbItem(), ozItem()]), opex: 500 };
  const prev = { ...aggregateItems([wbItem({ profit: 5000 }), ozItem()]), opex: 0 };
  const tiles = buildTiles({ cur, prev, productFilter: false });
  assert.equal(tiles.length, ALL_TILES.length);
  const p = tiles.find((t) => t.key === "profit");
  assert.equal(p.value, 8600);
  assert.equal(p.prev, 7900);
  assert.deepEqual(p.delta, { abs: 700, pct: 8.86 });
  assert.equal(p.tone, "good");
  assert.deepEqual(p.breakdown.map((b) => b.label), ["WB", "Ozon"]);
  const stock = tiles.find((t) => t.key === "stock");
  assert.equal(stock.delta, null);
  assert.equal(stock.tone, "neutral");
  const f = buildTiles({ cur, prev, productFilter: true });
  const st = f.find((t) => t.key === "storage");
  assert.equal(st.unavailable, true);
  assert.equal(st.value, null);
  const e = buildTiles({ cur, prev, productFilter: false, errors: ["opex"] });
  assert.equal(e.find((t) => t.key === "opex").error, true);
  assert.equal(e.find((t) => t.key === "profit").error, false);
  // только одна площадка
  const wbOnly = buildTiles({ cur: { wb: cur.wb, ozon: null, opex: null }, prev: { wb: prev.wb, ozon: null, opex: null }, productFilter: false });
  assert.deepEqual(wbOnly.find((t) => t.key === "profit").breakdown.map((b) => b.label), ["WB"]);
});

test("buildTiles: раскрытие кабинетных статей — строки costLines своей плитки", () => {
  const wb = applyCanon(aggregateItems([wbItem()]).wb, {
    ...aggregateItems([wbItem()]).wb, cogs: 4000, ads: 800,
    cabinetCosts: [
      { costType: "storage", label: "Хранение", amount: -300 },
      { costType: "subscription", label: "Подписка", amount: -100 },
      { costType: "deduction_other", label: "Удержание (прочее)", amount: -50 },
    ],
  }, "wb", {});
  const tiles = buildTiles({ cur: { wb, ozon: null, opex: null }, prev: { wb, ozon: null, opex: null }, productFilter: false });
  const other = tiles.find((t) => t.key === "otherDeductions");
  assert.equal(other.value, 150);
  assert.deepEqual(other.breakdown.map((b) => b.label), ["WB · Подписка", "WB · Удержание (прочее)"]);
});

test("TILES/CATALOG: 24 базовых, 9 доп., ключи уникальны", () => {
  assert.equal(TILES.length, 24);
  assert.equal(CATALOG.length, 9);
  assert.equal(new Set(ALL_TILES.map((t) => t.key)).size, 33);
});

test("normalizeLayout/applyLayout: мусор отбрасывается, доп. плитки только из extra", () => {
  assert.deepEqual(normalizeLayout(null), DEFAULT_LAYOUT);
  const l = normalizeLayout({ order: ["roi", "nope", "profit"], hidden: ["stock", "x"], extra: ["payout", "zzz"] });
  assert.deepEqual(l.hidden, ["stock"]);
  assert.deepEqual(l.extra, ["payout"]);
  assert.equal(l.order[0], "roi");
  assert.equal(l.order[1], "profit");
  assert.ok(l.order.includes("revenue"));       // недостающие базовые дописаны в конец
  assert.ok(l.order.includes("payout"));        // добавленная доп. — в порядке
  const tiles = ALL_TILES.map((t) => ({ key: t.key }));
  const vis = applyLayout(tiles, l).map((t) => t.key);
  assert.equal(vis[0], "roi");
  assert.ok(!vis.includes("stock"));
  assert.ok(vis.includes("payout"));
  assert.ok(!vis.includes("spp"));             // доп., не добавлена
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /opt/agents/saas && node --test lib/__tests__/kpiDashboard.test.mjs`
Expected: FAIL — `Cannot find module '../kpiDashboard.js'`.

- [ ] **Step 3: Реализация**

```js
// lib/kpiDashboard.js — «Дашборд показателей» (15.10.2026), чистое ядро без БД и без импортов
// (работает и в браузере: applyLayout/normalizeLayout зовёт клиент). Спека
// docs/superpowers/specs/2026-10-15-kpi-dashboard-design.md.
// Деньги — ТОЛЬКО канон: строки «Сводки по товарам» (lib/productsSummaryData.js) либо,
// без товарного фильтра, wbProfitCabinet/ozProfitCabinet (applyCanon). Здесь — суммы,
// производные (÷), цвет и раскрытие; новых денежных формул нет.

export const TONE_THRESHOLD = 0.01; // |отн. изменение| < 1 % → без цвета

const MONEY = ["revenue", "realized", "payout", "spp", "cogs", "commission", "acquiring", "loyalty",
  "services", "logistics", "returnLogistics", "ads", "tax", "profit", "profitGross", "taxBase"];
const COUNTS = ["sold", "returns", "cancelled", "ordered", "orderRub", "buyoutSold", "buyoutResolved",
  "stock", "stockValue", "stockNoCost"];
const COST_TILES = ["storage", "acceptance", "penalties", "otherDeductions", "compensations"];
const AGG_KEYS = [...MONEY, ...COUNTS, ...COST_TILES];
// Поле строки Сводки, соответствующее значению WB_TAX_BASE (lib/wbMetrics.js).
const WB_BASE_FIELD = { revenue: "salesRub", realized: "realized", payout: "payout" };

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const div = (a, b) => (b ? r2(a / b) : null);
const pct = (a, b) => (b ? r2((100 * a) / b) : null);

export function emptyAgg() {
  const a = {};
  for (const k of AGG_KEYS) a[k] = 0;
  a.costLines = [];
  return a;
}

export function skuKeyOf(it) { return `${it.platform}:${it.nm}`; }

// Строки Сводки → { wb, ozon } суммы. adSpend строки = ads; costRub = cogs; salesRub = revenue.
export function aggregateItems(items, { wbTaxBase = "realized" } = {}) {
  const out = { wb: emptyAgg(), ozon: emptyAgg() };
  for (const it of items || []) {
    const a = out[it.platform];
    if (!a) continue;
    a.revenue += num(it.salesRub);
    a.realized += num(it.realized);
    a.payout += num(it.payout);
    a.spp += num(it.spp);
    a.cogs += num(it.costRub);
    a.commission += num(it.commission);
    a.acquiring += num(it.acquiring);
    a.loyalty += num(it.loyalty);
    a.services += num(it.services);
    a.logistics += num(it.logistics);
    a.returnLogistics += num(it.returnLogistics);
    a.ads += num(it.adSpend);
    a.tax += num(it.tax);
    a.profit += num(it.profit);
    a.profitGross += num(it.profitGross);
    a.taxBase += num(it.platform === "wb" ? it[WB_BASE_FIELD[wbTaxBase] || "realized"] : it.salesRub);
    for (const k of ["sold", "returns", "cancelled", "ordered", "orderRub", "buyoutSold", "buyoutResolved"]) a[k] += num(it[k]);
    const st = num(it.stock);
    a.stock += st;
    if (num(it.unitCost) > 0) a.stockValue += st * num(it.unitCost);
    else if (st > 0) a.stockNoCost += 1;
  }
  for (const a of Object.values(out)) for (const k of MONEY.concat(["orderRub", "stockValue"])) a[k] = r2(a[k]);
  return out;
}

// Статьи кабинетных расходов → плитка. WB — cost_type сборщика wb_cabinet_costs;
// Ozon — accrual_<type_id> (shared.ozon_accrual_types). Всё прочее — «Прочие удержания».
const COST_TILE = {
  wb: {
    storage: "storage", supply: "acceptance", crossdocking: "acceptance", penalty: "penalties",
    payout_other: "compensations", pvz_compensation: "compensations", transport_compensation: "compensations",
  },
  ozon: {
    accrual_46: "storage", accrual_60: "storage", accrual_78: "storage", accrual_79: "storage", accrual_102: "storage",
    accrual_12: "acceptance", accrual_131: "acceptance", accrual_134: "acceptance",
    accrual_93: "penalties",
    accrual_10: "compensations", accrual_25: "compensations", accrual_104: "compensations",
  },
};
export function costTileOf(platform, costType) {
  return COST_TILE[platform]?.[costType] || "otherDeductions";
}

// Без товарного фильтра: деньги — кабинетный канон (как /pnl), штуки/остатки — строки Сводки.
// canon.cabinetCosts[].amount — канон-знак (<0 расход, >0 доход). Плитки расходов хранят
// расход положительным (−amount), «Компенсации» — доход положительным (+amount).
export function applyCanon(agg, canon, platform, { wbTaxBase = "realized" } = {}) {
  const a = { ...agg, costLines: [] };
  for (const k of MONEY) if (k !== "taxBase") a[k] = r2(num(canon[k]));
  a.taxBase = r2(num(platform === "wb" ? canon[wbTaxBase] : canon.revenue));
  for (const k of COST_TILES) a[k] = 0;
  for (const c of canon.cabinetCosts || []) {
    const tile = costTileOf(platform, c.costType);
    const amount = num(c.amount);
    a[tile] = r2(a[tile] + (tile === "compensations" ? amount : -amount));
    a.costLines.push({ platform, tile, label: c.label, amount: r2(amount) });
  }
  return a;
}

export function filterItems(items, { brands = [], cats = [], skus = [] } = {}) {
  const b = new Set(brands), c = new Set(cats), s = new Set(skus);
  return (items || []).filter((it) =>
    (!b.size || b.has(it.brand || "")) && (!c.size || c.has(it.cat || "")) && (!s.size || s.has(skuKeyOf(it))));
}

function sumAggs(list) {
  const out = emptyAgg();
  for (const a of list) {
    if (!a) continue;
    for (const k of AGG_KEYS) out[k] += num(a[k]);
    out.costLines.push(...(a.costLines || []));
  }
  for (const k of AGG_KEYS) out[k] = r2(out[k]);
  return out;
}

export function computeMetrics(a, { opex = null, productFilter = false } = {}) {
  const cab = (v) => (productFilter ? null : v);
  return {
    profit: a.profit, margin: pct(a.profit, a.revenue),
    revenue: a.revenue, sold: a.sold, realized: a.realized,
    orderRub: a.orderRub, ordered: a.ordered,
    buyoutPct: pct(a.buyoutSold, a.buyoutResolved),
    logistics: a.logistics, ads: a.ads, drr: pct(a.ads, a.orderRub), drrSales: pct(a.ads, a.revenue),
    storage: cab(a.storage), acceptance: cab(a.acceptance), otherDeductions: cab(a.otherDeductions),
    penalties: cab(a.penalties), compensations: cab(a.compensations),
    roi: pct(a.profit, a.cogs), cogs: a.cogs,
    opex: productFilter ? null : opex,
    tax: a.tax, taxBase: a.taxBase, commission: a.commission,
    avgPriceBeforeMp: div(a.revenue, a.sold), avgSalePrice: div(a.realized, a.sold),
    logisticsPerUnit: div(a.logistics, a.sold), profitPerUnit: div(a.profit, a.sold),
    stock: a.stock, stockValue: r2(a.stockValue), stockNoCost: a.stockNoCost,
    payout: a.payout, profitGross: a.profitGross, spp: a.spp, acquiring: a.acquiring,
    services: a.services, returnLogistics: a.returnLogistics, cancelled: a.cancelled, returns: a.returns,
  };
}

// good: up — рост хорошо; down — снижение хорошо (по самой величине);
// shareDown — снижение ДОЛИ в выручке хорошо; neutral — без цвета.
// second: { metric, unit } | { share: true } (доля value в выручке, %).
// cab: кабинетная статья (при товарном фильтре — «—»). src: источник ошибки.
// bd: вид раскрытия — "platform" (по умолчанию) | "costs" | "logistics" | "commission".
const T = (key, title, value, unit, good, extra = {}) => ({ key, title, value, unit, good, ...extra });
export const TILES = [
  T("profit", "Чистая прибыль / маржа", "profit", "rub", "up", { second: { metric: "margin", unit: "pct" } }),
  T("revenue", "Продажи", "revenue", "rub", "up", { second: { metric: "sold", unit: "pcs" } }),
  T("realized", "Реализация", "realized", "rub", "up"),
  T("orders", "Заказы", "orderRub", "rub", "up", { second: { metric: "ordered", unit: "pcs" }, src: "items" }),
  T("buyoutPct", "Процент выкупа", "buyoutPct", "pct", "up", { src: "items" }),
  T("logistics", "Логистика", "logistics", "rub", "shareDown", { second: { share: true }, bd: "logistics" }),
  T("ads", "Реклама / ДРР", "ads", "rub", "shareDown", { second: { metric: "drr", unit: "pct" } }),
  T("storage", "Хранение", "storage", "rub", "shareDown", { second: { share: true }, cab: true, bd: "costs" }),
  T("acceptance", "Платная приёмка", "acceptance", "rub", "shareDown", { second: { share: true }, cab: true, bd: "costs" }),
  T("otherDeductions", "Прочие удержания", "otherDeductions", "rub", "shareDown", { second: { share: true }, cab: true, bd: "costs" }),
  T("roi", "ROI", "roi", "pct", "up"),
  T("cogs", "Себестоимость продаж", "cogs", "rub", "shareDown", { second: { share: true } }),
  T("opex", "Операционные расходы", "opex", "rub", "shareDown", { second: { share: true }, cab: true, src: "opex", bd: "none",
    hint: "Ручные расходы (раздел «Сопутств. расходы»), справочно: в прибыль панели не входят" }),
  T("tax", "Налоги", "tax", "rub", "shareDown", { second: { share: true } }),
  T("taxBase", "Налоговая база", "taxBase", "rub", "neutral"),
  T("commission", "Комиссия", "commission", "rub", "shareDown", { second: { share: true }, bd: "commission" }),
  T("avgPriceBeforeMp", "Сред. цена до скидок МП", "avgPriceBeforeMp", "rub", "up", { hint: "Продажи ÷ продано шт: цена продавца до СПП" }),
  T("stockValue", "Капитализация по себес.", "stockValue", "rub", "neutral", { snapshot: true, src: "items" }),
  T("stock", "Остатки", "stock", "pcs", "neutral", { snapshot: true, src: "items" }),
  T("penalties", "Штрафы", "penalties", "rub", "shareDown", { second: { share: true }, cab: true, bd: "costs" }),
  T("compensations", "Компенсации", "compensations", "rub", "up", { second: { share: true }, cab: true, bd: "costs" }),
  T("avgSalePrice", "Сред. цена продажи", "avgSalePrice", "rub", "up", { hint: "Реализация ÷ продано шт" }),
  T("logisticsPerUnit", "Сред. стоимость логистики на 1 шт", "logisticsPerUnit", "rub", "down"),
  T("profitPerUnit", "Средняя прибыль на 1 шт", "profitPerUnit", "rub", "up"),
];
export const CATALOG = [
  T("drrSales", "ДРР от продаж", "drrSales", "pct", "down"),
  T("payout", "К перечислению", "payout", "rub", "up", { hint: "У Ozon — расчётно: выручка − вознаграждение − сборы − эквайринг − лояльность" }),
  T("profitGross", "Валовая прибыль", "profitGross", "rub", "up", { hint: "До рекламы, налога и кабинетных расходов" }),
  T("spp", "СПП, ₽", "spp", "rub", "neutral", { hint: "Скидка WB покупателю; у Ozon 0" }),
  T("acquiring", "Эквайринг", "acquiring", "rub", "shareDown", { second: { share: true } }),
  T("services", "Сборы Ozon", "services", "rub", "shareDown", { second: { share: true } }),
  T("returnLogistics", "Возвратная логистика", "returnLogistics", "rub", "shareDown", { second: { share: true }, hint: "Уже входит в «Логистику»" }),
  T("cancelled", "Отмены, шт", "cancelled", "pcs", "down", { src: "items" }),
  T("returns", "Возвраты, шт", "returns", "pcs", "down", { src: "items" }),
];
export const ALL_TILES = [...TILES, ...CATALOG];

function shareOf(def, m) { return m && m[def.value] != null && m.revenue ? m[def.value] / m.revenue : null; }

export function tileTone(def, cur, prev) {
  if (def.good === "neutral" || def.snapshot) return "neutral";
  const c = def.good === "shareDown" ? shareOf(def, cur) : cur?.[def.value];
  const p = def.good === "shareDown" ? shareOf(def, prev) : prev?.[def.value];
  if (c == null || p == null || p === 0) return "neutral";
  const rel = (c - p) / Math.abs(p);
  if (Math.abs(rel) < TONE_THRESHOLD) return "neutral";
  return (def.good === "up" ? rel > 0 : rel < 0) ? "good" : "bad";
}

function secondOf(def, m) {
  if (!def.second) return null;
  if (def.second.share) return { value: m[def.value] == null ? null : pct(m[def.value], m.revenue), unit: "pct" };
  return { value: m[def.second.metric], unit: def.second.unit };
}

function breakdownOf(def, cur, mByPf, productFilter) {
  if (def.bd === "none") return [];
  const names = { wb: "WB", ozon: "Ozon" };
  if (def.bd === "costs") {
    if (productFilter) return [];
    const lines = [];
    for (const pf of ["wb", "ozon"]) {
      for (const l of cur[pf]?.costLines || []) {
        if (l.tile !== def.key) continue;
        lines.push({ label: `${names[pf]} · ${l.label}`, value: def.key === "compensations" ? l.amount : r2(-l.amount), unit: "rub" });
      }
    }
    return lines;
  }
  const rows = [];
  for (const pf of ["wb", "ozon"]) {
    const m = mByPf[pf];
    if (!m) continue;
    rows.push({ label: names[pf], value: m[def.value], unit: def.unit });
    if (def.bd === "logistics") rows.push({ label: `${names[pf]} · в т.ч. возвратная`, value: m.returnLogistics, unit: "rub" });
    if (def.bd === "commission") rows.push({ label: `${names[pf]} · эквайринг (отдельно)`, value: m.acquiring, unit: "rub" });
  }
  return rows;
}

function metricsFor(side, productFilter) {
  const total = sumAggs([side.wb, side.ozon]);
  return {
    total: computeMetrics(total, { opex: side.opex, productFilter }),
    wb: side.wb ? computeMetrics(side.wb, { opex: null, productFilter }) : null,
    ozon: side.ozon ? computeMetrics(side.ozon, { opex: null, productFilter }) : null,
  };
}

// cur/prev: { wb: Agg|null, ozon: Agg|null, opex: number|null }.
// errors: источники, которые не загрузились ("money"|"items"|"opex").
export function buildTiles({ cur, prev, productFilter = false, errors = [] }) {
  const mc = metricsFor(cur, productFilter);
  const mp = metricsFor(prev, productFilter);
  const err = new Set(errors);
  return ALL_TILES.map((def) => {
    const unavailable = !!def.cab && productFilter;
    const error = err.has(def.src || "money");
    const value = unavailable || error ? null : mc.total[def.value];
    const prevVal = def.snapshot || unavailable || error ? null : mp.total[def.value];
    const delta = value != null && prevVal != null
      ? { abs: r2(value - prevVal), pct: prevVal ? r2((100 * (value - prevVal)) / Math.abs(prevVal)) : null }
      : null;
    let hint = def.hint || null;
    if (unavailable) hint = "Расход кабинета: не делится по товарам — при фильтре по брендам, категориям или артикулам не показывается";
    if (def.key === "stockValue" && mc.total.stockNoCost > 0) hint = `Без себестоимости: ${mc.total.stockNoCost} артикулов (не вошли в сумму)`;
    return {
      key: def.key, title: def.title, value, unit: def.unit,
      second: value == null ? null : secondOf(def, mc.total),
      prev: prevVal, delta,
      tone: value == null ? "neutral" : tileTone(def, mc.total, mp.total),
      breakdown: value == null ? [] : breakdownOf(def, cur, { wb: mc.wb, ozon: mc.ozon }, productFilter),
      unavailable, error, hint,
    };
  });
}

const BASE_KEYS = TILES.map((t) => t.key);
const EXTRA_KEYS = CATALOG.map((t) => t.key);
export const DEFAULT_LAYOUT = { order: [...BASE_KEYS], hidden: [], extra: [] };

export function normalizeLayout(raw) {
  if (!raw || typeof raw !== "object") return { order: [...BASE_KEYS], hidden: [], extra: [] };
  const arr = (x) => (Array.isArray(x) ? x.filter((k) => typeof k === "string") : []);
  const extra = [...new Set(arr(raw.extra).filter((k) => EXTRA_KEYS.includes(k)))];
  const allowed = new Set([...BASE_KEYS, ...extra]);
  const order = [...new Set(arr(raw.order).filter((k) => allowed.has(k)))];
  for (const k of [...BASE_KEYS, ...extra]) if (!order.includes(k)) order.push(k);
  const hidden = [...new Set(arr(raw.hidden).filter((k) => allowed.has(k)))];
  return { order, hidden, extra };
}

export function applyLayout(tiles, layout) {
  const l = normalizeLayout(layout);
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  const hidden = new Set(l.hidden);
  return l.order.filter((k) => !hidden.has(k) && byKey.has(k)).map((k) => byKey.get(k));
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `cd /opt/agents/saas && node --test lib/__tests__/kpiDashboard.test.mjs`
Expected: все тесты PASS. Если падает арифметика ожиданий теста — пересчитать руками и поправить ОЖИДАНИЕ только при явной ошибке в тесте (например, `margin` = r2(100×5700/16000) = 35.63; `delta.pct` = r2(100×700/7900) = 8.86).

- [ ] **Step 5: Commit**

```bash
git add lib/kpiDashboard.js lib/__tests__/kpiDashboard.test.mjs
git commit -m "feat(kpi): чистое ядро дашборда показателей — плитки, цвет по доле, раскрытие, layout

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Миграция 068 + загрузчик `lib/kpiDashboardData.js`

**Files:**
- Create: `db/migrations/068_kpi_dashboard_prefs.sql`
- Create: `lib/kpiDashboardData.js`

**Interfaces:**
- Consumes: `buildTotals`, `shiftDateUTC` (Task 1); `aggregateItems`, `applyCanon`, `filterItems`, `normalizeLayout`, `DEFAULT_LAYOUT` (Task 2); `wbProfitCabinet`, `WB_TAX_BASE` (`lib/wbMetrics.js`); `ozProfitCabinet` (`lib/ozonMetrics.js`); `statusMap` (`lib/finItems.js`); `normalizeTaxMode` (`lib/tax.js`); `DatabaseSync`, `tenantQuery`, `query` (`lib/db.js`).
- Produces:
  - `parseKpiQuery(searchParams)` → `{ from, to, shops: number[], brands: string[], cats: string[], skus: string[] }` (from/to — `YYYY-MM-DD` либо дефолт 7 дней по вчера; окно ≤ 366 дн; `from > to` → меняет местами)
  - `async loadKpiDashboard(cabinet, opts)` → `{ period:{from,to}, prevPeriod:{from,to}, platforms: string[], productFilter: bool, cur, prev, errors: string[], options: { shops, brands, cats, skus } }`
  - `async readLayout(cabinetId, userId)` → layout (normalized); `async saveLayout(cabinetId, userId, layout)`; `async resetLayout(cabinetId, userId)`

- [ ] **Step 1: Миграция**

```sql
-- 068_kpi_dashboard_prefs.sql — «Дашборд показателей» (15.10.2026): личная настройка плиток
-- (порядок, скрытые, добавленные из каталога) — своя у каждого пользователя кабинета.
-- layout = {order:[tileKey…], hidden:[…], extra:[…]}; неизвестные ключи панель отбрасывает
-- при чтении (lib/kpiDashboard.js normalizeLayout). Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.kpi_dashboard_prefs (
    cabinet_id  BIGINT      NOT NULL,
    user_id     BIGINT      NOT NULL,
    layout      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, user_id)
);

DO $$
DECLARE t TEXT := 'kpi_dashboard_prefs';
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
  EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
END $$;

COMMIT;
```

- [ ] **Step 2: Применить и проверить (дважды — идемпотентность)**

```bash
cd /opt/agents/saas && for i in 1 2; do PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/068_kpi_dashboard_prefs.sql; done
psql -h localhost -U saas_ro -d saas -Atc "select policyname from pg_policies where tablename='kpi_dashboard_prefs' order by 1"
```
Expected: оба прогона `COMMIT`; политики `panel_local_ro_cab1`, `tenant_iso_kpi_dashboard_prefs`.

- [ ] **Step 3: Загрузчик**

```js
// lib/kpiDashboardData.js — данные «Дашборда показателей» (15.10.2026). Спека
// docs/superpowers/specs/2026-10-15-kpi-dashboard-design.md §4.
// Источники (строго последовательно — withCabinet держит одну транзакцию):
//   items — buildTotals Сводки (lib/productsSummaryData.js), текущее и прошлое окно;
//   money — без товарного фильтра wbProfitCabinet/ozProfitCabinet (как /pnl),
//           с фильтром — деньги из тех же строк Сводки (канон *ProfitProductBatch);
//   opex  — tenant.opex (справочно, в прибыль не входит).
// Каждый источник под своим SAVEPOINT: сбой → console.error + имя в errors[], плитки
// этого источника показывают «ошибка загрузки», остальные живы (паттерн блока складов
// на Главной, app/api/cabinets/[id]/overview/route.js).
import { DatabaseSync, tenantQuery, query } from "./db.js";
import { buildTotals, shiftDateUTC } from "./productsSummaryData.js";
import { wbProfitCabinet, WB_TAX_BASE } from "./wbMetrics.js";
import { ozProfitCabinet } from "./ozonMetrics.js";
import { statusMap } from "./finItems.js";
import { normalizeTaxMode } from "./tax.js";
import { aggregateItems, applyCanon, filterItems, normalizeLayout, skuKeyOf } from "./kpiDashboard.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const list = (sp, k) => (sp.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);

export function parseKpiQuery(sp) {
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  let to = DATE_RE.test(sp.get("to") || "") ? sp.get("to") : yesterday;
  let from = DATE_RE.test(sp.get("from") || "") ? sp.get("from") : shiftDateUTC(to, -6);
  if (from > to) [from, to] = [to, from];
  if ((new Date(to) - new Date(from)) / 864e5 + 1 > MAX_DAYS) from = shiftDateUTC(to, -(MAX_DAYS - 1));
  return {
    from, to,
    shops: list(sp, "shops").map(Number).filter((n) => Number.isInteger(n) && n > 0),
    brands: list(sp, "brands"), cats: list(sp, "cats"), skus: list(sp, "skus"),
  };
}

async function guarded(name, errors, fn, fallback) {
  await tenantQuery(`SAVEPOINT kpi_${name}`, []);
  try {
    const v = await fn();
    await tenantQuery(`RELEASE SAVEPOINT kpi_${name}`, []);
    return v;
  } catch (e) {
    console.error(`[kpi] источник ${name}:`, e);
    await tenantQuery(`ROLLBACK TO SAVEPOINT kpi_${name}`, []);
    await tenantQuery(`RELEASE SAVEPOINT kpi_${name}`, []);
    if (!errors.includes(name)) errors.push(name);
    return fallback;
  }
}

async function loadOpex(from, to) {
  const [r] = await tenantQuery(
    `SELECT COALESCE(SUM(amount),0)::float AS s FROM tenant.opex
     WHERE status = 'active' AND domain = 'business' AND COALESCE(included_in_cogs,0) = 0
       AND substr(COALESCE(NULLIF(op_date,''), period || '-01'),1,10) BETWEEN $1 AND $2`,
    [from, to]
  );
  return Math.round((r?.s || 0) * 100) / 100;
}

async function loadSide(cabinet, { platforms, from, to, productFilter, filter, stat, errors, wbTaxBase }) {
  const pf = platforms.length === 2 ? "all" : platforms[0];
  const built = await guarded("items", errors, () => buildTotals(cabinet, pf, from, to, true, stat), { items: [] });
  const items = productFilter ? filterItems(built.items, filter) : built.items;
  const agg = aggregateItems(items, { wbTaxBase });
  const side = { wb: platforms.includes("wb") ? agg.wb : null, ozon: platforms.includes("ozon") ? agg.ozon : null, opex: null, items: built.items };
  if (!productFilter) {
    if (side.wb) {
      const c = await guarded("money", errors,
        () => wbProfitCabinet(new DatabaseSync("wb", { readOnly: true }), normalizeTaxMode(cabinet.shopTax?.wb), { from, to }), null);
      if (c?.unknownCostTypes) console.error(`[kpi] WB: незнакомые статьи кабинетных расходов: ${c.unknownCostTypes}`);
      side.wb = c ? applyCanon(side.wb, c, "wb", { wbTaxBase }) : side.wb;
    }
    if (side.ozon) {
      const c = await guarded("money", errors,
        () => ozProfitCabinet(new DatabaseSync("ozon", { readOnly: true }), normalizeTaxMode(cabinet.shopTax?.ozon), { from, to }), null);
      if (c?.unknownCostTypes) console.error(`[kpi] Ozon: незнакомые статьи кабинетных расходов: ${c.unknownCostTypes}`);
      side.ozon = c ? applyCanon(side.ozon, c, "ozon", { wbTaxBase }) : side.ozon;
    }
    side.opex = await guarded("opex", errors, () => loadOpex(from, to), null);
  }
  return side;
}

export async function loadKpiDashboard(cabinet, opts) {
  const { from, to } = opts;
  const N = Math.round((new Date(to) - new Date(from)) / 864e5) + 1;
  const prevTo = shiftDateUTC(from, -1);
  const prevFrom = shiftDateUTC(prevTo, -(N - 1));

  const shopRows = await query(
    `SELECT shop_id, mp_code, shop_name FROM auth.shops WHERE cabinet_id = $1 AND is_active ORDER BY shop_id`,
    [cabinet.cabinet_id]
  );
  const cabMps = (cabinet.marketplaces || ["wb", "ozon"]).filter((m) => m === "wb" || m === "ozon");
  const chosen = opts.shops.length ? shopRows.filter((s) => opts.shops.includes(Number(s.shop_id))) : [];
  const platforms = chosen.length ? cabMps.filter((m) => chosen.some((s) => s.mp_code === m)) : cabMps;
  const filter = { brands: opts.brands, cats: opts.cats, skus: opts.skus };
  const productFilter = !!(filter.brands.length || filter.cats.length || filter.skus.length);

  const errors = [];
  const stat = await guarded("items", errors, () => statusMap(), {});
  const common = { platforms, productFilter, filter, stat, errors, wbTaxBase: WB_TAX_BASE };
  const cur = await loadSide(cabinet, { ...common, from, to });
  const prev = await loadSide(cabinet, { ...common, from: prevFrom, to: prevTo });

  // Варианты фильтров — активные товары и товары с движением текущего окна (как видит Сводка).
  const visible = cur.items.filter((it) => (it.status || "active") === "active"
    || (it.sold || 0) > 0 || (it.returns || 0) > 0 || (it.ordered || 0) > 0 || (it.buyoutResolved || 0) > 0)
    .filter((it) => platforms.includes(it.platform));
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  const options = {
    shops: shopRows.map((s) => ({ id: Number(s.shop_id), platform: s.mp_code, name: s.shop_name || s.mp_code })),
    brands: uniq(visible.map((it) => it.brand)),
    cats: uniq(visible.map((it) => it.cat)),
    skus: visible.map((it) => ({ key: skuKeyOf(it), platform: it.platform, name: it.name, article: it.sa }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru")),
  };
  delete cur.items;
  delete prev.items;
  for (const s of [cur, prev]) for (const pf of ["wb", "ozon"]) if (s[pf] === undefined) s[pf] = null;
  return { period: { from, to }, prevPeriod: { from: prevFrom, to: prevTo }, platforms, productFilter, cur, prev, errors, options };
}

export async function readLayout(cabinetId, userId) {
  const [r] = await tenantQuery(
    `SELECT layout FROM tenant.kpi_dashboard_prefs WHERE cabinet_id = $1 AND user_id = $2`, [cabinetId, userId]);
  return normalizeLayout(r?.layout);
}

export async function saveLayout(cabinetId, userId, layout) {
  const norm = normalizeLayout(layout);
  await tenantQuery(
    `INSERT INTO tenant.kpi_dashboard_prefs (cabinet_id, user_id, layout, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (cabinet_id, user_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()`,
    [cabinetId, userId, JSON.stringify(norm)]);
  return norm;
}

export async function resetLayout(cabinetId, userId) {
  await tenantQuery(`DELETE FROM tenant.kpi_dashboard_prefs WHERE cabinet_id = $1 AND user_id = $2`, [cabinetId, userId]);
  return normalizeLayout(null);
}
```

`cabinet` из `withCabinet` (`lib/withCabinet.js:122-126`) = строка membership-запроса (`cabinet_id`, `marketplaces`, …) + `shop_names` + `shopTax` (`{wb, ozon}` → `tax_mode`); handler получает и `session: { user_id }`.

- [ ] **Step 4: Прогон загрузчика на кабинете #1 (без HTTP)**

```bash
cd /opt/agents/saas && cat > scratchpad/kpi/load.mjs <<'EOF'
import { readFileSync } from 'node:fs';
for (const line of readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { withTenant, query } = await import('../../lib/db.js');
const { loadKpiDashboard, parseKpiQuery } = await import('../../lib/kpiDashboardData.js');
const { buildTiles } = await import('../../lib/kpiDashboard.js');
const [c] = await query(`SELECT cabinet_id, marketplaces FROM auth.cabinets WHERE cabinet_id = 1`);
const shops = await query(`SELECT mp_code, tax_mode FROM auth.shops WHERE cabinet_id = 1`);
const cabinet = { ...c, shopTax: Object.fromEntries(shops.map((s) => [s.mp_code, s.tax_mode])) };
const d = await withTenant(1, () => loadKpiDashboard(cabinet, parseKpiQuery(new URLSearchParams('from=2026-09-01&to=2026-09-30'))));
console.log('errors', d.errors, 'platforms', d.platforms);
for (const t of buildTiles(d)) if (['profit','revenue','orders','storage','opex','stock'].includes(t.key)) console.log(t.key, t.value, t.prev, t.tone);
process.exit(0);
EOF
node scratchpad/kpi/load.mjs
```
Expected: `errors []`, платформы `[ 'wb', 'ozon' ]`, у `profit`/`revenue` — ненулевые значения. Сверить `cabinet.shopTax` с тем, как его собирает `withCabinet` (тот же формат), — при расхождении поправить скрипт, не загрузчик.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/068_kpi_dashboard_prefs.sql lib/kpiDashboardData.js
git commit -m "feat(kpi): миграция 068 (личный layout) и загрузчик дашборда показателей

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Роут `/api/cabinets/[id]/kpi` + гард ролей

**Files:**
- Create: `app/api/cabinets/[id]/kpi/route.js`
- Modify: `lib/__tests__/roleGuards.test.mjs` (новый тест в конце файла)

**Interfaces:**
- Consumes: `parseKpiQuery`, `loadKpiDashboard`, `readLayout`, `saveLayout`, `resetLayout` (Task 3); `buildTiles`, `ALL_TILES` (Task 2).
- Produces: `GET /api/cabinets/[id]/kpi?from&to&shops&brands&cats&skus` → `{ period, prevPeriod, platforms, productFilter, tiles, catalog:[{key,title}], layout, options, errors }`; `POST {action:"save_layout", layout}` → `{ ok, layout }`; `POST {action:"reset_layout"}` → `{ ok, layout }`.

- [ ] **Step 1: Тест гарда (падает — роута нет)**

Дописать в конец `lib/__tests__/roleGuards.test.mjs`:

```js
test("«Дашборд показателей»: смотреть и сохранять свой вид может любой член кабинета, user_id — из сессии", () => {
  const r = all.find((x) => x.key === "kpi");
  assert.ok(r, "нет роута kpi");
  assert.ok(!/requireRole/.test(r.src), "kpi: личный вид не должен требовать роль");
  assert.ok(/session\.user_id/.test(r.src), "kpi: user_id должен браться из сессии");
  assert.ok(!/body\.user_id|b\.user_id/.test(r.src), "kpi: user_id из тела запроса запрещён");
});
```

Run: `node --test lib/__tests__/roleGuards.test.mjs` → Expected: FAIL «нет роута kpi».

- [ ] **Step 2: Роут**

```js
// /api/cabinets/[id]/kpi — «Дашборд показателей» (15.10.2026).
// GET ?from&to (YYYY-MM-DD, дефолт 7 дн по вчера) &shops=id,id &brands=… &cats=… &skus=wb:1,ozon:2
//   → { period, prevPeriod, platforms, productFilter, tiles, catalog, layout, options, errors }.
// POST { action: "save_layout", layout } | { action: "reset_layout" } — личный вид пользователя
//   (tenant.kpi_dashboard_prefs, миграция 068); user_id — только из сессии, роль не требуется.
// Данные — lib/kpiDashboardData.js, плитки — lib/kpiDashboard.js (канон, без своих формул).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { parseKpiQuery, loadKpiDashboard, readLayout, saveLayout, resetLayout } from "@/lib/kpiDashboardData.js";
import { buildTiles, CATALOG } from "@/lib/kpiDashboard.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet, session }) => {
  try {
    const opts = parseKpiQuery(new URL(req.url).searchParams);
    const d = await loadKpiDashboard(cabinet, opts);
    const tiles = buildTiles({ cur: d.cur, prev: d.prev, productFilter: d.productFilter, errors: d.errors });
    const layout = await readLayout(cabinet.cabinet_id, session.user_id);
    return NextResponse.json({
      period: d.period, prevPeriod: d.prevPeriod, platforms: d.platforms, productFilter: d.productFilter,
      tiles, catalog: CATALOG.map((t) => ({ key: t.key, title: t.title })), layout, options: d.options, errors: d.errors,
    });
  } catch (e) {
    console.error("kpi GET:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "save_layout") {
      const layout = await saveLayout(cabinet.cabinet_id, session.user_id, body.layout);
      return NextResponse.json({ ok: true, layout });
    }
    if (body.action === "reset_layout") {
      const layout = await resetLayout(cabinet.cabinet_id, session.user_id);
      return NextResponse.json({ ok: true, layout });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    console.error("kpi POST:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
```

- [ ] **Step 3: Тесты**

Run: `cd /opt/agents/saas && node --test lib/__tests__/roleGuards.test.mjs lib/__tests__/kpiDashboard.test.mjs`
Expected: все PASS.

- [ ] **Step 4: Commit**

```bash
git add "app/api/cabinets/[id]/kpi/route.js" lib/__tests__/roleGuards.test.mjs
git commit -m "feat(kpi): роут /kpi — плитки, варианты фильтров, личный layout

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: UI страницы и пункт меню

**Files:**
- Create: `app/cabinets/[id]/kpi/page.js`, `KpiPage.jsx`, `KpiTile.jsx`, `MultiSelect.jsx`, `WidgetSettings.jsx`
- Modify: `app/cabinets/[id]/layout.js:21` (пункт меню после «Главной»)

**Interfaces:**
- Consumes: `GET/POST /api/cabinets/${cabinetId}/kpi` (Task 4); `applyLayout`, `normalizeLayout` из `@/lib/kpiDashboard.js`; `C`, `soft` из `@/lib/palette.js`; `defaultPeriod` из `@/lib/period.js`.

- [ ] **Step 1: Бэкап `layout.js`, пункт меню**

```bash
cp "app/cabinets/[id]/layout.js" "/opt/agentsDB/backups/cabinet-layout.js.$(date +%Y%m%d_%H%M%S).bak"
```
В массиве меню сразу после строки `{ href: "", label: "Главная", icon: "📊" },` добавить:
```js
  { href: "/kpi", label: "Дашборд показателей", icon: "📈" },
```

- [ ] **Step 2: `page.js`**

```js
import KpiPage from "./KpiPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <KpiPage cabinetId={Number(params.id)} />;
}
```

- [ ] **Step 3: `MultiSelect.jsx`**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useRef, useState } from "react";

// Кнопка-фильтр с выпадающим списком: поиск, галочки, «Сбросить». options: [{value, label, sub?}].
export default function MultiSelect({ label, options, value, onChange, title }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => `${o.label} ${o.sub || ""}`.toLowerCase().includes(s)) : options;
  }, [options, q]);
  const sel = new Set(value);
  const toggle = (v) => onChange(sel.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div ref={ref} title={title} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(!open)} style={{
        padding: "7px 12px", borderRadius: 8, border: `1px solid ${value.length ? C.accent : C.line}`,
        background: value.length ? soft("accent", 12) : C.surface, color: C.ink, cursor: "pointer", fontSize: 13,
      }}>
        {label}{value.length ? ` · ${value.length}` : ""} ▾
      </button>
      {open && (
        <div style={{
          position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, width: 300, maxWidth: "90vw",
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 8,
          boxShadow: `0 8px 24px ${soft("ink", 15)}`,
        }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" style={{
            width: "100%", boxSizing: "border-box", padding: "6px 8px", marginBottom: 6, borderRadius: 6,
            border: `1px solid ${C.line}`, background: C.bg, color: C.ink,
          }} />
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {shown.length === 0 && <div style={{ color: C.muted, fontSize: 12, padding: 6 }}>Ничего не найдено</div>}
            {shown.map((o) => (
              <label key={o.value} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 6px", cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={sel.has(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}{o.sub && <span style={{ color: C.muted, fontSize: 11 }}> · {o.sub}</span>}</span>
              </label>
            ))}
          </div>
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])} style={{ marginTop: 6, background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 12 }}>
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

Токены `lib/palette.js`: `bg, surface, surfaceAlt, ink, muted, faint, line, accent, accent2, pos, neg, warn, pink, blue`; контрастный текст на акценте — CSS-переменная `var(--accentInk)` (в `C` её нет).

- [ ] **Step 4: `KpiTile.jsx`**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
export function fmt(v, unit) {
  if (v == null) return "—";
  if (unit === "pct") return `${nf2.format(v)} %`;
  if (unit === "pcs") return `${nf0.format(v)} шт`;
  return `${nf0.format(v)} ₽`;
}
const TONE_BG = { good: () => soft("pos", 14), bad: () => soft("neg", 14), neutral: () => soft("accent", 6) };

// Плитка: основная цифра (+ вторая), прошлый период, дельта со стрелкой, значок раскрытия.
export default function KpiTile({ tile, onOpen }) {
  const t = tile;
  const arrow = t.delta?.abs > 0 ? "↗" : t.delta?.abs < 0 ? "↘" : "";
  const dColor = t.tone === "good" ? C.pos : t.tone === "bad" ? C.neg : C.muted;
  const canOpen = t.breakdown.length > 0;
  return (
    <div
      onClick={canOpen ? () => onOpen(t) : undefined}
      title={t.hint || undefined}
      style={{
        background: TONE_BG[t.tone](), border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px",
        minHeight: 104, cursor: canOpen ? "pointer" : "default", display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 13, color: C.ink }}>
        <span>{t.title}{t.hint && <span style={{ color: C.muted }}> ⓘ</span>}</span>
        {canOpen && <span style={{ fontSize: 11, color: C.muted, border: `1px solid ${C.line}`, borderRadius: 6, padding: "0 6px" }}>▢ {t.breakdown.length}</span>}
      </div>
      {t.error ? (
        <div style={{ color: C.neg, fontSize: 14 }}>ошибка загрузки</div>
      ) : (
        <div style={{ fontSize: 22, fontWeight: 700, color: C.ink, fontVariantNumeric: "tabular-nums" }}>
          {fmt(t.value, t.unit)}
          {t.second && t.second.value != null && <span style={{ fontSize: 15, fontWeight: 600 }}> / {fmt(t.second.value, t.second.unit)}</span>}
        </div>
      )}
      {t.unavailable && <div style={{ fontSize: 11, color: C.muted }}>не делится по товарам</div>}
      {!t.error && !t.unavailable && t.prev != null && (
        <div style={{ fontSize: 12, color: C.muted, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span>{fmt(t.prev, t.unit)}</span>
          {t.delta && (
            <span style={{ color: dColor, border: `1px solid ${soft(t.tone === "good" ? "pos" : t.tone === "bad" ? "neg" : "line", 40)}`, borderRadius: 6, padding: "0 6px" }}>
              {t.delta.abs > 0 ? "+" : ""}{t.unit === "pct" ? `${nf2.format(t.delta.abs)} п.п.` : fmt(t.delta.abs, t.unit)}
              {t.delta.pct != null && ` (${t.delta.pct > 0 ? "+" : ""}${nf2.format(t.delta.pct)}%)`} {arrow}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
```

Дельта процентной плитки (выкуп, ROI) — в процентных пунктах («п.п.»), в скобках — относительное изменение.

- [ ] **Step 5: `WidgetSettings.jsx`**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";
import { normalizeLayout } from "@/lib/kpiDashboard.js";

// Модалка «Настройка виджетов»: порядок (перетаскивание; стрелки ↑↓ — для телефона),
// скрытие галочкой, «+ Метрика» из каталога, сброс к стандарту.
export default function WidgetSettings({ titles, catalog, layout, onSave, onReset, onClose }) {
  const [l, setL] = useState(() => normalizeLayout(layout));
  const [drag, setDrag] = useState(null);
  const move = (from, to) => {
    if (to < 0 || to >= l.order.length) return;
    const order = [...l.order];
    const [k] = order.splice(from, 1);
    order.splice(to, 0, k);
    setL({ ...l, order });
  };
  const toggleHidden = (k) => setL({ ...l, hidden: l.hidden.includes(k) ? l.hidden.filter((x) => x !== k) : [...l.hidden, k] });
  const addExtra = (k) => setL(normalizeLayout({ ...l, extra: [...l.extra, k] }));
  const removeExtra = (k) => setL(normalizeLayout({ ...l, extra: l.extra.filter((x) => x !== k), order: l.order.filter((x) => x !== k) }));
  const notAdded = catalog.filter((c) => !l.extra.includes(c.key));
  const isExtra = (k) => catalog.some((c) => c.key === k);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: soft("ink", 40), zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, borderRadius: 12, padding: 16, width: 480, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", border: `1px solid ${C.line}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <b style={{ color: C.ink }}>Настройка виджетов</b>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>
        {l.order.map((k, i) => (
          <div key={k} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag != null) move(drag, i); setDrag(null); }}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.line}`, marginBottom: 4, background: drag === i ? soft("accent", 10) : C.surface, cursor: "grab" }}>
            <span style={{ color: C.muted }}>⠿</span>
            <input type="checkbox" checked={!l.hidden.includes(k)} onChange={() => toggleHidden(k)} title="Показывать" />
            <span style={{ flex: 1, color: C.ink, fontSize: 13 }}>{titles[k] || k}</span>
            <button onClick={() => move(i, i - 1)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted }}>↑</button>
            <button onClick={() => move(i, i + 1)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted }}>↓</button>
            {isExtra(k) && <button onClick={() => removeExtra(k)} title="Убрать метрику" style={{ background: "none", border: "none", cursor: "pointer", color: C.neg }}>✕</button>}
          </div>
        ))}
        {notAdded.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>+ Метрика</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {notAdded.map((c) => (
                <button key={c.key} onClick={() => addExtra(c.key)} style={{ padding: "4px 10px", borderRadius: 14, border: `1px solid ${C.line}`, background: C.bg, color: C.ink, cursor: "pointer", fontSize: 12 }}>+ {c.title}</button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14 }}>
          <button onClick={onReset} style={{ background: "none", border: "none", color: C.accent, cursor: "pointer" }}>Сбросить к стандарту</button>
          <button onClick={() => onSave(l)} style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: C.accent, color: "var(--accentInk)", cursor: "pointer" }}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: `KpiPage.jsx`**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { applyLayout } from "@/lib/kpiDashboard.js";
import { defaultPeriod } from "@/lib/period.js";
import KpiTile, { fmt } from "./KpiTile";
import MultiSelect from "./MultiSelect";
import WidgetSettings from "./WidgetSettings";

// /cabinets/[id]/kpi — «Дашборд показателей» (15.10.2026). Плитки — GET /api/cabinets/[id]/kpi
// (канон: lib/kpiDashboard.js + lib/kpiDashboardData.js). Фильтры живут в URL (ссылкой можно
// поделиться); набор и порядок плиток — личный (POST save_layout).
const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const PARAMS = ["from", "to", "shops", "brands", "cats", "skus"];
const ddmm = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");

function readUrl() {
  const sp = new URLSearchParams(window.location.search);
  const list = (k) => (sp.get(k) || "").split(",").filter(Boolean);
  const def = defaultPeriod(7); // 7 полных дней по вчера — тот же дефолт, что parseKpiQuery
  return { from: sp.get("from") || def.from, to: sp.get("to") || def.to, shops: list("shops"), brands: list("brands"), cats: list("cats"), skus: list("skus") };
}
function toQuery(f) {
  const sp = new URLSearchParams();
  for (const k of PARAMS) {
    const v = Array.isArray(f[k]) ? f[k].join(",") : f[k];
    if (v) sp.set(k, v);
  }
  return sp.toString();
}

export default function KpiPage({ cabinetId }) {
  const [f, setF] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);
  const [settings, setSettings] = useState(false);
  const [layout, setLayout] = useState(null);

  useEffect(() => { setF(readUrl()); }, []);

  useEffect(() => {
    if (!f) return;
    const qs = toQuery(f);
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    setLoading(true);
    setErr("");
    fetch(`/api/cabinets/${cabinetId}/kpi?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
        setLayout(d.layout);
      })
      .catch((e) => { console.error("kpi load:", e); setErr(String(e.message || e)); })
      .finally(() => setLoading(false));
  }, [f, cabinetId]);

  const tiles = useMemo(() => (data && layout ? applyLayout(data.tiles, layout) : []), [data, layout]);
  const titles = useMemo(() => Object.fromEntries((data?.tiles || []).map((t) => [t.key, t.title])), [data]);
  const opt = data?.options || { shops: [], brands: [], cats: [], skus: [] };
  const set = useCallback((k, v) => setF((x) => ({ ...x, [k]: v })), []);

  const postLayout = async (body) => {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/kpi`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setLayout(d.layout);
      setSettings(false);
    } catch (e) {
      console.error("kpi layout:", e);
      alert(`Не удалось сохранить настройку: ${e.message || e}`);
    }
  };

  const inputStyle = { padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
  return (
    <div style={{ padding: 16, fontFamily: FONT, color: C.ink, maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>Дашборд показателей</h1>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        {f && (
          <>
            <input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} style={inputStyle} />
            <span style={{ color: C.muted }}>—</span>
            <input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} style={inputStyle} />
            <MultiSelect label="Магазины" value={f.shops} onChange={(v) => set("shops", v)}
              title="Данные хранятся по площадке: несколько юрлиц одной площадки не различаются"
              options={opt.shops.map((s) => ({ value: String(s.id), label: s.name, sub: s.platform === "wb" ? "WB" : "Ozon" }))} />
            <MultiSelect label="Бренды" value={f.brands} onChange={(v) => set("brands", v)} options={opt.brands.map((b) => ({ value: b, label: b }))} />
            <MultiSelect label="Категории" value={f.cats} onChange={(v) => set("cats", v)} options={opt.cats.map((c) => ({ value: c, label: c }))} />
            <MultiSelect label="Артикулы" value={f.skus} onChange={(v) => set("skus", v)}
              options={opt.skus.map((s) => ({ value: s.key, label: s.name, sub: `${s.platform === "wb" ? "WB" : "Ozon"} ${s.article || ""}` }))} />
          </>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setSettings(true)} disabled={!data} style={{ ...inputStyle, cursor: "pointer" }}>⚙ Настройка виджетов</button>
      </div>

      {data && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
          Сравнение с {ddmm(data.prevPeriod.from)} — {ddmm(data.prevPeriod.to)}.
          {data.productFilter && " Фильтр по товарам: расходы кабинета (хранение, штрафы, удержания и т.п.) не делятся по товарам и не показываются; прибыль — сумма прибыли выбранных товаров."}
          {data.errors.length > 0 && <span style={{ color: C.neg }}> Часть данных не загрузилась — см. плитки «ошибка загрузки».</span>}
        </div>
      )}
      {err && <div style={{ color: C.neg, marginBottom: 10 }}>Ошибка: {err}</div>}
      {loading && !data && <div style={{ color: C.muted }}>Загрузка…</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, opacity: loading ? 0.6 : 1 }}>
        {tiles.map((t) => <KpiTile key={t.key} tile={t} onOpen={setOpen} />)}
      </div>

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, background: soft("ink", 40), zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, width: 420, maxWidth: "100%" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <b>{open.title}</b>
              <button onClick={() => setOpen(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18 }}>✕</button>
            </div>
            {open.breakdown.map((b, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
                <span>{b.label}</span><b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(b.value, b.unit)}</b>
              </div>
            ))}
          </div>
        </div>
      )}

      {settings && data && (
        <WidgetSettings titles={titles} catalog={data.catalog} layout={layout}
          onSave={(l) => postLayout({ action: "save_layout", layout: l })}
          onReset={() => postLayout({ action: "reset_layout" })}
          onClose={() => setSettings(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 7: Скрининги D1–D13 и сборка**

```bash
cd /opt/agents/saas && grep -rn 'fetch("[^"]*\${' "app/cabinets/[id]/kpi/" ; grep -rn 'var(--[a-z]*)[0-9A-F]\{2\}' "app/cabinets/[id]/kpi/" ; grep -rn "catch {}\|catch(e) {}\|catch (e) {}" "app/cabinets/[id]/kpi/" lib/kpiDashboard*.js
npm run build 2>&1 | tail -8 && systemctl restart saas-web && sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3200/login
```
Expected: три grep — пусто; сборка без ошибок; `200`.

- [ ] **Step 8: Commit**

```bash
git add "app/cabinets/[id]/kpi/page.js" "app/cabinets/[id]/kpi/KpiPage.jsx" "app/cabinets/[id]/kpi/KpiTile.jsx" "app/cabinets/[id]/kpi/MultiSelect.jsx" "app/cabinets/[id]/kpi/WidgetSettings.jsx" "app/cabinets/[id]/layout.js"
git commit -m "feat(kpi): страница «Дашборд показателей» — плитки, фильтры, раскрытие, настройка виджетов

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Смоук-сверка, «Что нового», AGENTS.md

**Files:**
- Create: `scripts/smoke-kpi.mjs`
- Modify: `AGENTS.md` (TL;DR-таблица + абзац в «Где что считается» после «Матрицы заказов»)

- [ ] **Step 1: Смоук**

```js
#!/usr/bin/env node
// scripts/smoke-kpi.mjs — смоук «Дашборда показателей» (15.10.2026). Проверяет «одна цифра везде»:
//   1) /kpi отвечает 200 без errors, 24 базовые плитки на месте;
//   2) без фильтра деньги = /pnl total (прибыль, выручка, реализация, себестоимость, комиссия,
//      логистика, реклама, налог) за тот же период, Δ ≤ 0,01 ₽; маржа = /pnl margin;
//   3) тождество статей: хранение + приёмка + штрафы + прочие − компенсации = −cabinetCostsTotal /pnl;
//   4) прошлый период: plitka.prev прибыли = /pnl за prevPeriod;
//   5) штуки = Сводка (includeInactive=1): заказы шт/₽, продано, % выкупа;
//   6) магазин WB → прибыль = блок wb /pnl;
//   7) фильтр по бренду: прибыль = Σ profit строк Сводки этого бренда; кабинетные плитки unavailable;
//   8) save_layout → GET отдаёт тот же порядок; reset_layout → стандарт (пишет только кабинет #1).
// Запуск: node scripts/smoke-kpi.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  if (!cond) failed++;
};
const near = (a, b, eps = 0.011) => a != null && b != null && Math.abs(a - b) <= eps;

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 3600 });
const cookie = `saas_session=${encodeURIComponent(seal)}`;
const get = async (path) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { headers: { cookie } });
  return { status: r.status, data: await r.json() };
};
const post = async (body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/kpi`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const tile = (d, k) => d.tiles.find((t) => t.key === k);

for (const [from, to] of [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-14']]) {
  const tag = `${from}..${to}`;
  const k = await get(`kpi?from=${from}&to=${to}`);
  check(`${tag}: HTTP 200, errors пусто`, k.status === 200 && !k.data.error && k.data.errors.length === 0, k.data.error || k.data.errors);
  const d = k.data;
  check(`${tag}: 33 плитки (24 + 9)`, d.tiles.length === 33, d.tiles.length);

  const pnl = (await get(`pnl?from=${from}&to=${to}`)).data;
  const T = pnl.total;
  const pairs = [['profit', T.profit], ['revenue', T.revenue], ['realized', T.realized], ['cogs', T.cogs],
    ['commission', T.commission], ['logistics', T.logistics], ['ads', T.ads], ['tax', T.tax]];
  for (const [key, want] of pairs) check(`${tag}: ${key} = /pnl (${want})`, near(tile(d, key).value, want), tile(d, key).value);
  check(`${tag}: маржа = /pnl margin`, near(tile(d, 'profit').second.value, T.margin), [tile(d, 'profit').second.value, T.margin]);

  const net = ['storage', 'acceptance', 'penalties', 'otherDeductions'].reduce((a, x) => a + tile(d, x).value, 0) - tile(d, 'compensations').value;
  check(`${tag}: статьи кабинета = −cabinetCostsTotal (${-T.cabinetCostsTotal})`, near(net, -T.cabinetCostsTotal, 0.05), net);

  const pp = (await get(`pnl?from=${d.prevPeriod.from}&to=${d.prevPeriod.to}`)).data.total;
  check(`${tag}: прошлый период прибыль = /pnl prev (${pp.profit})`, near(tile(d, 'profit').prev, pp.profit), tile(d, 'profit').prev);

  const s = (await get(`products-summary?platform=all&from=${from}&to=${to}&includeInactive=1`)).data.totals;
  check(`${tag}: заказы шт = Сводка (${s.ordered})`, tile(d, 'orders').second.value === s.ordered, tile(d, 'orders').second.value);
  check(`${tag}: заказы ₽ = Сводка (${s.orderRub})`, near(tile(d, 'orders').value, s.orderRub, 0.05), tile(d, 'orders').value);
  check(`${tag}: продано шт = Сводка (${s.sold})`, tile(d, 'revenue').second.value === s.sold, tile(d, 'revenue').second.value);
  check(`${tag}: % выкупа = Сводка (${s.buyoutPct})`, near(tile(d, 'buyoutPct').value, s.buyoutPct), tile(d, 'buyoutPct').value);

  const wbShop = d.options.shops.find((x) => x.platform === 'wb');
  if (wbShop) {
    const w = (await get(`kpi?from=${from}&to=${to}&shops=${wbShop.id}`)).data;
    check(`${tag}: магазин WB → прибыль = /pnl wb (${pnl.wb?.profit})`, near(tile(w, 'profit').value, pnl.wb?.profit), tile(w, 'profit').value);
  }

  const brand = d.options.brands[0];
  if (brand) {
    const b = (await get(`kpi?from=${from}&to=${to}&brands=${encodeURIComponent(brand)}`)).data;
    const items = (await get(`products-summary?platform=all&from=${from}&to=${to}&includeInactive=1`)).data.items.filter((it) => (it.brand || '') === brand);
    const want = Math.round(items.reduce((a, it) => a + (it.profit || 0), 0) * 100) / 100;
    check(`${tag}: бренд «${brand}» прибыль = Σ строк Сводки (${want})`, near(tile(b, 'profit').value, want, 0.05), tile(b, 'profit').value);
    check(`${tag}: при товарном фильтре хранение недоступно`, tile(b, 'storage').unavailable === true && tile(b, 'storage').value === null);
  }
}

if (CAB === 1) {
  const order = ['roi', 'profit'];
  const s1 = await post({ action: 'save_layout', layout: { order, hidden: ['stock'], extra: ['payout'] } });
  const g = (await get('kpi?from=2026-10-01&to=2026-10-07')).data.layout;
  check('layout сохранён и читается', s1.status === 200 && g.order[0] === 'roi' && g.hidden.includes('stock') && g.extra.includes('payout'), g);
  const r = await post({ action: 'reset_layout' });
  check('reset_layout → стандарт', r.status === 200 && r.data.layout.order[0] === 'profit' && r.data.layout.extra.length === 0, r.data);
} else {
  console.log('SKIP  запись layout — только кабинет #1');
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
```

Перед запуском проверить имена полей, на которые опирается смоук: `/pnl` → `total.{profit,revenue,realized,cogs,commission,logistics,ads,tax,margin,cabinetCostsTotal}`, `wb.profit` (`app/api/cabinets/[id]/pnl/route.js:31-108,196`); Сводка → `totals.{ordered,orderRub,sold,buyoutPct}`. Если `/pnl` не принимает `from/to` напрямую — посмотреть разбор параметров у `GET` (стр. ~164-195) и передать как он ждёт.

- [ ] **Step 2: Прогон**

Run: `cd /opt/agents/saas && node scripts/smoke-kpi.mjs 1`
Expected: `ALL PASS`. Любой FAIL по деньгам — баг дашборда (правило «расхождение = наш баг»): найти, в каком слое расходится (applyCanon / aggregateItems / filterItems), починить, пересобрать, перезапустить смоук. Подгонять допуск нельзя.

Дополнительно — регресс соседей: `node scripts/smoke-order-matrix.mjs 1 && node scripts/smoke-buyout.mjs 1 && node scripts/smoke-bonus.mjs 1` → все без FAIL (Сводка теперь живёт в `lib/productsSummaryData.js`). И все юнит-тесты: `node --test lib/__tests__/` → без FAIL.

- [ ] **Step 3: «Что нового»**

```bash
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -c "INSERT INTO shared.changelog (date, type, title, body) VALUES ('2026-10-15', 'feature', 'Дашборд показателей', 'Новая страница в меню: ключевые цифры кабинета плитками — прибыль и маржа, продажи, заказы, выкуп, логистика, реклама, удержания, налоги и другие — с прошлым периодом и изменением. Цвет показывает, хорошо это или плохо (расходы оцениваются по доле в выручке). Клик по плитке раскрывает состав, фильтры по магазинам, брендам, категориям и артикулам, свой набор и порядок плиток — в «Настройке виджетов».');"
```

- [ ] **Step 4: AGENTS.md**

Бэкап: `cp AGENTS.md /opt/agentsDB/backups/AGENTS.md.$(date +%Y%m%d_%H%M%S).bak`.

В таблицу TL;DR после строки «Процент выкупа …» добавить:
```
| Дашборд показателей (KPI-плитки) | `lib/kpiDashboard.js`, `lib/kpiDashboardData.js`, `/kpi` |
```
В «Где что считается» после пункта «Матрица заказов» добавить:
```
- **Дашборд показателей (с 2026-10-15)** — страница `/kpi` (пункт меню после «Главной»), API
  `/api/cabinets/[id]/kpi?from&to&shops&brands&cats&skus`: 24 плитки + каталог «+ Метрика» (9), прошлый
  период той же длины, дельта, цвет (расходы — по ДОЛЕ в выручке, порог 1 %), раскрытие по клику. Своих
  формул нет: без товарного фильтра деньги = `wbProfitCabinet`/`ozProfitCabinet` (как `/pnl`), штуки/выкуп/
  остатки — строки «Сводки» (`buildTotals`, вынесен в `lib/productsSummaryData.js` 15.10); с фильтром по
  бренду/категории/артикулам — суммы строк Сводки, кабинетные статьи (хранение, приёмка, штрафы, прочие
  удержания, компенсации, opex) → «—». Статьи кабинета → плитки — `costTileOf` (`lib/kpiDashboard.js`; Ozon
  по `accrual_<id>`). Опер. расходы (`tenant.opex`, business, не в себестоимости) — справочно, в прибыль не
  входят. Фильтр «Магазины» = площадка (tenant-данные без `shop_id`). Личный вид — `tenant.kpi_dashboard_prefs`
  (миграция 068), user_id из сессии, роль не нужна. Тесты `lib/__tests__/kpiDashboard.test.mjs`, смоук
  `node scripts/smoke-kpi.mjs 1` (сверка с `/pnl` и Сводкой). Открыто: остаток WB в Сводке — `quantity_full`
  (с «в пути»), у Ozon и `/stocks` — «доступно»; решение по канону — владельца.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-kpi.mjs AGENTS.md
git commit -m "test(kpi): смоук-сверка дашборда с /pnl и Сводкой; карта проекта

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Доложить владельцу** — ссылка на страницу, итог смоука, открытый вопрос по остатку WB; слияние в `master` — только по его слову.
