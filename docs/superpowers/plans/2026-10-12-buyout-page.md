# Процент выкупа (WB) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница «Процент выкупа» с точным когортным выкупом WB по товарам и размерам, график по неделям, и та же цифра в «Сводке по товарам».

**Architecture:** Чистое ядро `lib/buyout.js` (классификация судьбы заказа, агрегаты, недели) + адаптер БД `lib/buyoutData.js` (один SQL по `wb_orders` с признаками по `srid`) + роут `/api/cabinets/[id]/buyout` + клиентская страница. Сводка (`products-summary`) берёт WB-выкуп из того же ядра; Ozon остаётся на прежней формуле с флагом `buyoutLegacy`.

**Tech Stack:** Next.js 14 App Router, PostgreSQL (RLS через `withCabinet` → `tenantQuery`), `node:test`, recharts.

**Spec:** `docs/superpowers/specs/2026-10-11-buyout-page-design.md`

## Global Constraints

- % выкупа = `sold / (sold + refused + returned)`; `pending` и `cancelledPre` в знаменатель не входят; самовыкупы исключены.
- Порядок вёдер: `self` → `returned` → `sold` → `refused` → `cancelledPre` → `pending`.
- `CANCEL_SETTLE_DAYS = 7` (отмена без логистики к клиенту старше 7 дней → `cancelledPre`), `IMMATURE_SHARE = 0.05`, `MIN_RESOLVED = 20`.
- Когорта — по дате заказа `substr(order_dt,1,10)` в `[from, to]`; дефолт `defaultPeriod(30)` из `lib/period.js` (30 дней по вчера).
- Проценты — числа 0..100 с округлением `round2` (как в Сводке).
- Только WB; Ozon в Сводке — прежняя формула + `buyoutLegacy: true`. Юнит-экономику НЕ трогать (кроме текста подсказки колонки).
- Пустой `catch {}` запрещён — всегда `console.error`.
- Запросы в адаптере — строго последовательно (один client на транзакцию).
- Проверки только на кабинете #1; страница только читает БД.
- Бэкап боевого файла перед правкой — в `/opt/agentsDB/backups/<имя>.<YYYYMMDD_HHMMSS>.bak`.
- `git add` — только явный список файлов задачи (не `-A`, не `.`).
- Не запускать `next dev` в `/opt/agents/saas`; после правок `app/`/`lib/` — `npm run build && systemctl restart saas-web`.

---

## Файлы

| Файл | Ответственность |
|---|---|
| `lib/buyout.js` (новый) | чистое ядро: `classifyWbOrder`, `aggregateBuyout`, `weeklyBuyout`, `buyoutStats`, `weekStart`, `sortSizes`, константы |
| `lib/__tests__/buyout.test.mjs` (новый) | тесты ядра |
| `lib/buyoutData.js` (новый) | `loadWbBuyoutRows(from, to)` — SQL |
| `app/api/cabinets/[id]/buyout/route.js` (новый) | GET таблица / `series=1` недели |
| `app/cabinets/[id]/buyout/page.js`, `BuyoutPage.jsx`, `BuyoutChart.jsx` (новые) | UI |
| `app/cabinets/[id]/layout.js` | пункт меню |
| `app/api/cabinets/[id]/products-summary/route.js` | WB-выкуп из ядра, Ozon legacy, итоги по счётчикам |
| `app/cabinets/[id]/summary/SummaryPage.jsx` | пересчёт итогов по фильтрам — по счётчикам |
| `lib/unit.js` | только текст `tip` колонки `buyout` (WB и Ozon) |
| `scripts/smoke-buyout.mjs` (новый) | смоук |
| `docs/metrics-contract.md`, `AGENTS.md` | §18 и карта |

---

### Task 1: Чистое ядро `lib/buyout.js`

**Files:**
- Create: `lib/buyout.js`
- Test: `lib/__tests__/buyout.test.mjs`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `CANCEL_SETTLE_DAYS = 7`, `IMMATURE_SHARE = 0.05`, `MIN_RESOLVED = 20`, `NO_SIZE = "0"`
  - Входная строка (row): `{ srid: string, nmId: number, article: string|null, name: string|null, size: string, orderDate: "YYYY-MM-DD", isCancel: boolean, cancelAt: string|null, hasSale: boolean, hasReturn: boolean, refusedLogistics: boolean, selfBuyout: boolean }`
  - `classifyWbOrder(row, asOf: "YYYY-MM-DD") → "self"|"returned"|"sold"|"refused"|"cancelledPre"|"pending"`
  - `buyoutStats(counts) → { ...counts, resolved, buyoutPct: number|null, pendingShare: number, immature: boolean, lowSample: boolean }`, где `counts = { ordered, self, returned, sold, refused, cancelledPre, pending }`
  - `aggregateBuyout(rows, asOf) → { kpi: Stats, items: Array<Stats & { nmId, article, name, sizes: Array<Stats & { size }> }> }` (items отсортированы по `ordered` убыв.; `sizes` пустой, если у товара только `NO_SIZE`)
  - `weekStart(dateStr) → "YYYY-MM-DD"` (понедельник)
  - `weeklyBuyout(rows, asOf, { weeks = 13, nmId = null } = {}) → { weeks: Array<Stats & { week, sizes: { [size]: Stats } }>, sizeList: string[] }`
  - `sortSizes(list: string[]) → string[]`

- [ ] **Step 1: Написать падающие тесты**

`lib/__tests__/buyout.test.mjs`:

```js
// lib/__tests__/buyout.test.mjs — процент выкупа WB когортно по дате заказа
// (спека docs/superpowers/specs/2026-10-11-buyout-page-design.md).
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWbOrder, buyoutStats, aggregateBuyout, weeklyBuyout, weekStart, sortSizes,
  CANCEL_SETTLE_DAYS, MIN_RESOLVED,
} from "../buyout.js";

const ASOF = "2026-10-12";
const base = { srid: "x", nmId: 1, article: "A1", name: "Бюстгальтер", size: "M", orderDate: "2026-09-01",
  isCancel: false, cancelAt: null, hasSale: false, hasReturn: false, refusedLogistics: false, selfBuyout: false };
const row = (o) => ({ ...base, ...o });

test("порядок вёдер: самовыкуп важнее всего, возврат важнее продажи", () => {
  assert.equal(classifyWbOrder(row({ selfBuyout: true, hasSale: true }), ASOF), "self");
  assert.equal(classifyWbOrder(row({ hasSale: true, hasReturn: true }), ASOF), "returned");
  assert.equal(classifyWbOrder(row({ hasSale: true }), ASOF), "sold");
  assert.equal(classifyWbOrder(row({ isCancel: true, refusedLogistics: true }), ASOF), "refused");
});

test("отмена без логистики: старше 7 дней — до отгрузки, моложе или ровно 7 — в пути", () => {
  assert.equal(CANCEL_SETTLE_DAYS, 7);
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: "2026-10-04T00:00:00" }), ASOF), "cancelledPre");
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: "2026-10-05T00:00:00" }), ASOF), "pending");
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: null }), ASOF), "pending");
});

test("заказ без развязки — в пути", () => {
  assert.equal(classifyWbOrder(row({}), ASOF), "pending");
});

test("buyoutStats: знаменатель без в-пути и отмен до отгрузки; null при нуле", () => {
  const s = buyoutStats({ ordered: 10, self: 1, returned: 1, sold: 3, refused: 4, cancelledPre: 1, pending: 0 });
  assert.equal(s.resolved, 8);
  assert.equal(s.buyoutPct, 37.5);
  assert.equal(s.immature, false);
  assert.equal(s.lowSample, true);
  const z = buyoutStats({ ordered: 2, self: 0, returned: 0, sold: 0, refused: 0, cancelledPre: 0, pending: 2 });
  assert.equal(z.buyoutPct, null);
  assert.equal(z.pendingShare, 1);
  assert.equal(z.immature, true);
});

test("lowSample снимается с MIN_RESOLVED доехавших; immature при доле в пути > 5 %", () => {
  const s = buyoutStats({ ordered: 22, self: 0, returned: 0, sold: MIN_RESOLVED, refused: 0, cancelledPre: 0, pending: 2 });
  assert.equal(s.lowSample, false);
  assert.equal(s.immature, true); // 2/22 ≈ 9 %
});

test("aggregateBuyout: размеры суммируются в товар, товары — в KPI", () => {
  const rows = [
    row({ srid: "1", size: "S", hasSale: true }),
    row({ srid: "2", size: "S", isCancel: true, refusedLogistics: true }),
    row({ srid: "3", size: "M", hasSale: true }),
    row({ srid: "4", size: "M", hasSale: true, hasReturn: true }),
    row({ srid: "5", nmId: 2, size: "0", hasSale: true }),
  ];
  const { kpi, items } = aggregateBuyout(rows, ASOF);
  assert.equal(kpi.ordered, 5);
  assert.equal(kpi.sold, 3);
  assert.equal(kpi.resolved, 5);
  assert.equal(kpi.buyoutPct, 60);
  const bra = items.find((i) => i.nmId === 1);
  assert.equal(bra.ordered, 4);
  assert.deepEqual(bra.sizes.map((s) => s.size), ["S", "M"]);
  assert.equal(bra.sizes[0].buyoutPct, 50);
  assert.equal(bra.sizes[1].returned, 1);
  for (const k of ["ordered", "sold", "refused", "returned", "pending", "cancelledPre", "self"]) {
    assert.equal(bra.sizes.reduce((a, s) => a + s[k], 0), bra[k], k);
  }
  assert.deepEqual(items.find((i) => i.nmId === 2).sizes, []);
});

test("sortSizes: буквенные по росту, числовые по числу, прочие в конце", () => {
  assert.deepEqual(sortSizes(["XL", "S", "M", "XS", "L"]), ["XS", "S", "M", "L", "XL"]);
  assert.deepEqual(sortSizes(["75B", "70A", "80C"]), ["70A", "75B", "80C"]);
  assert.deepEqual(sortSizes(["M", "ONE", "S"]), ["S", "M", "ONE"]);
});

test("weekStart — понедельник", () => {
  assert.equal(weekStart("2026-10-12"), "2026-10-12"); // понедельник
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // воскресенье
  assert.equal(weekStart("2026-10-08"), "2026-10-05");
});

test("weeklyBuyout: 13 недель подряд с пустыми, размеры по неделям, фильтр товара", () => {
  const rows = [
    row({ srid: "1", orderDate: "2026-10-06", size: "S", hasSale: true }),
    row({ srid: "2", orderDate: "2026-10-07", size: "M", isCancel: true, refusedLogistics: true }),
    row({ srid: "3", orderDate: "2026-09-29", nmId: 2, size: "0", hasSale: true }),
  ];
  const all = weeklyBuyout(rows, ASOF);
  assert.equal(all.weeks.length, 13);
  assert.equal(all.weeks[12].week, "2026-10-12");
  assert.equal(all.weeks[11].week, "2026-10-05");
  assert.equal(all.weeks[11].resolved, 2);
  assert.equal(all.weeks[10].sold, 1);
  assert.equal(all.weeks[0].ordered, 0);
  const one = weeklyBuyout(rows, ASOF, { nmId: 1 });
  assert.equal(one.weeks[10].ordered, 0);
  assert.deepEqual(one.sizeList, ["S", "M"]);
  assert.equal(one.weeks[11].sizes.S.buyoutPct, 100);
  assert.equal(one.weeks[11].sizes.M.buyoutPct, 0);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /opt/agents/saas && node --test lib/__tests__/buyout.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/buyout.js'`

- [ ] **Step 3: Реализация**

`lib/buyout.js`:

```js
// lib/buyout.js — процент выкупа WB когортно по дате заказа (11.10.2026).
// Спека docs/superpowers/specs/2026-10-11-buyout-page-design.md, контракт метрик §18.
// Чистые функции, без БД (данные — lib/buyoutData.js). Берём заказы периода и смотрим
// судьбу КАЖДОГО заказа (srid): одно ведро на заказ, проверки в порядке BUCKETS.
//   % выкупа = sold / (sold + refused + returned); pending и cancelledPre в знаменатель
//   не входят, самовыкупы (self) исключены из всех вёдер.
// ⚠️ Это НЕ коэффициент выкупа юнитки (lib/unit.js): там b по событиям отчёта реализации,
// чтобы логистика сводилась к Σлогистики/продано (§18.4 контракта).

export const CANCEL_SETTLE_DAYS = 7; // отчёт реализации отстаёт: раньше 7 дней отмену без логистики не судим
export const IMMATURE_SHARE = 0.05;  // доля «в пути» выше — период не дозрел
export const MIN_RESOLVED = 20;      // меньше доехавших — процент бледный (малая выборка)
export const NO_SIZE = "0";          // WB tech_size неразмерного товара
const COUNT_KEYS = ["ordered", "self", "returned", "sold", "refused", "cancelledPre", "pending"];
const DAY = 864e5;

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const emptyCounts = () => Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));

export function classifyWbOrder(r, asOf) {
  if (r.selfBuyout) return "self";
  if (r.hasReturn) return "returned";
  if (r.hasSale) return "sold";
  if (r.isCancel) {
    if (r.refusedLogistics) return "refused";
    const at = r.cancelAt ? Date.parse(String(r.cancelAt).slice(0, 10)) : NaN;
    if (Number.isFinite(at) && (Date.parse(asOf) - at) / DAY > CANCEL_SETTLE_DAYS) return "cancelledPre";
  }
  return "pending";
}

export function buyoutStats(c) {
  const resolved = c.sold + c.refused + c.returned;
  const open = resolved + c.pending;
  const pendingShare = open > 0 ? c.pending / open : 0;
  return {
    ...c,
    resolved,
    buyoutPct: resolved > 0 ? round2((100 * c.sold) / resolved) : null,
    pendingShare: round2(pendingShare),
    immature: pendingShare > IMMATURE_SHARE,
    lowSample: resolved < MIN_RESOLVED,
  };
}

function add(counts, bucket) {
  counts.ordered += 1;
  counts[bucket] += 1;
}

const LETTER = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "3XL", "4XL", "5XL"];
export function sortSizes(list) {
  const rank = (s) => {
    const u = String(s).toUpperCase();
    const li = LETTER.indexOf(u);
    if (li >= 0) return [0, li, u];
    const n = parseFloat(u);
    if (Number.isFinite(n)) return [1, n, u];
    return [2, 0, u];
  };
  return [...list].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2], "ru");
  });
}

export function aggregateBuyout(rows, asOf) {
  const kpi = emptyCounts();
  const byNm = new Map();
  for (const r of rows) {
    const b = classifyWbOrder(r, asOf);
    add(kpi, b);
    let it = byNm.get(r.nmId);
    if (!it) {
      it = { nmId: r.nmId, article: r.article || null, name: r.name || null, counts: emptyCounts(), sizes: new Map() };
      byNm.set(r.nmId, it);
    }
    if (!it.name && r.name) it.name = r.name;
    if (!it.article && r.article) it.article = r.article;
    add(it.counts, b);
    const size = r.size || NO_SIZE;
    if (!it.sizes.has(size)) it.sizes.set(size, emptyCounts());
    add(it.sizes.get(size), b);
  }
  const items = [...byNm.values()].map((it) => {
    const sizeKeys = [...it.sizes.keys()];
    const real = sizeKeys.some((s) => s !== NO_SIZE);
    return {
      nmId: it.nmId, article: it.article, name: it.name,
      ...buyoutStats(it.counts),
      sizes: real ? sortSizes(sizeKeys).map((s) => ({ size: s === NO_SIZE ? "без размера" : s, ...buyoutStats(it.sizes.get(s)) })) : [],
    };
  }).sort((a, b) => b.ordered - a.ordered);
  return { kpi: buyoutStats(kpi), items };
}

export function weekStart(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // пн = 0
  return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}

export function weeklyBuyout(rows, asOf, { weeks = 13, nmId = null } = {}) {
  const last = Date.parse(`${weekStart(asOf)}T00:00:00Z`);
  const keys = Array.from({ length: weeks }, (_, i) => new Date(last - (weeks - 1 - i) * 7 * DAY).toISOString().slice(0, 10));
  const acc = new Map(keys.map((k) => [k, { total: emptyCounts(), sizes: new Map() }]));
  const sizeSet = new Set();
  for (const r of rows) {
    if (nmId != null && r.nmId !== nmId) continue;
    const w = acc.get(weekStart(r.orderDate));
    if (!w) continue;
    const b = classifyWbOrder(r, asOf);
    add(w.total, b);
    const size = r.size || NO_SIZE;
    if (nmId != null && size !== NO_SIZE) {
      sizeSet.add(size);
      if (!w.sizes.has(size)) w.sizes.set(size, emptyCounts());
      add(w.sizes.get(size), b);
    }
  }
  const sizeList = sortSizes([...sizeSet]);
  return {
    sizeList,
    weeks: keys.map((k) => {
      const w = acc.get(k);
      return {
        week: k,
        ...buyoutStats(w.total),
        sizes: Object.fromEntries(sizeList.map((s) => [s, buyoutStats(w.sizes.get(s) || emptyCounts())])),
      };
    }),
  };
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `cd /opt/agents/saas && node --test lib/__tests__/buyout.test.mjs`
Expected: PASS, 9 тестов, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /opt/agents/saas
git add lib/buyout.js lib/__tests__/buyout.test.mjs
git commit -m "feat(buyout): ядро когортного выкупа WB — вёдра судьбы заказа, размеры, недели

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Адаптер БД и API `/buyout`

**Files:**
- Create: `lib/buyoutData.js`
- Create: `app/api/cabinets/[id]/buyout/route.js`

**Interfaces:**
- Consumes: `aggregateBuyout`, `weeklyBuyout`, `weekStart` из `lib/buyout.js`; `tenantQuery` из `lib/db.js`; `withCabinet` из `lib/withCabinet.js`; `defaultPeriod` из `lib/period.js`.
- Produces:
  - `loadWbBuyoutRows(from: "YYYY-MM-DD", to: "YYYY-MM-DD") → Promise<Row[]>` (форма Row — Task 1)
  - `GET /api/cabinets/[id]/buyout?from&to&q` → `{ platform: "wb", from, to, asOf, kpi, items, ozon: { legacy: true } }`; `q` фильтрует items по подстроке в `name`/`article`/`nmId` (KPI не фильтруется)
  - `GET /api/cabinets/[id]/buyout?series=1[&nm=<nmId>]` → `{ asOf, nmId, sizeList, weeks }`

- [ ] **Step 1: Адаптер**

`lib/buyoutData.js`:

```js
// lib/buyoutData.js — данные для процента выкупа WB (lib/buyout.js). Вызывается изнутри
// withCabinet (tenantQuery, RLS по cabinet_id). Один запрос: заказы периода по дате заказа
// + признаки судьбы по srid. wb_sales без индекса по srid — поэтому признаки продаж
// агрегируются один раз по srid когорты (CTE), а не EXISTS на каждую строку.
let _db = null;
async function getDb() { if (!_db) _db = await import("./db.js"); return _db; }

export async function loadWbBuyoutRows(from, to) {
  const { tenantQuery } = await getDb();
  const rows = await tenantQuery(
    `WITH o AS (
       SELECT srid, nm_id, supplier_article, COALESCE(NULLIF(tech_size, ''), '0') AS size,
              substr(order_dt, 1, 10) AS order_date, is_cancel, COALESCE(cancel_dt, last_change_dt) AS cancel_at
       FROM tenant.wb_orders
       WHERE substr(order_dt, 1, 10) BETWEEN $1 AND $2
     ),
     s AS (
       SELECT srid, bool_or(sale_id LIKE 'S%') AS has_sale, bool_or(sale_id LIKE 'R%') AS has_return
       FROM tenant.wb_sales WHERE srid IN (SELECT srid FROM o) GROUP BY srid
     ),
     f AS (
       SELECT DISTINCT srid FROM tenant.wb_finance_report
       WHERE srid IN (SELECT srid FROM o) AND bonus_type_name LIKE 'К клиенту при отмене%'
     ),
     sb AS (
       SELECT srid FROM tenant.wb_order_costs WHERE srid IN (SELECT srid FROM o) AND self_buyout = 1
     )
     SELECT o.srid, o.nm_id, o.supplier_article, o.size, o.order_date, o.is_cancel, o.cancel_at,
            a.name, COALESCE(s.has_sale, false) AS has_sale, COALESCE(s.has_return, false) AS has_return,
            (f.srid IS NOT NULL) AS refused_logistics, (sb.srid IS NOT NULL) AS self_buyout
     FROM o
     LEFT JOIN s ON s.srid = o.srid
     LEFT JOIN f ON f.srid = o.srid
     LEFT JOIN sb ON sb.srid = o.srid
     LEFT JOIN tenant.wb_articles a ON a.nm_id = o.nm_id`,
    [from, to]
  );
  return rows.map((r) => ({
    srid: r.srid,
    nmId: Number(r.nm_id),
    article: r.supplier_article || null,
    name: r.name || null,
    size: r.size,
    orderDate: r.order_date,
    isCancel: Number(r.is_cancel) === 1,
    cancelAt: r.cancel_at || null,
    hasSale: r.has_sale === true,
    hasReturn: r.has_return === true,
    refusedLogistics: r.refused_logistics === true,
    selfBuyout: r.self_buyout === true,
  }));
}
```

- [ ] **Step 2: Роут**

`app/api/cabinets/[id]/buyout/route.js`:

```js
// /api/cabinets/[id]/buyout — «Процент выкупа» (WB, когортно по дате заказа, 11.10.2026).
// GET ?from&to (YYYY-MM-DD, по дате заказа; дефолт 30 дней по вчера) &q (поиск по товару)
//     → { kpi, items[] с sizes[] }.
// GET ?series=1[&nm=<nmId>] → 13 недель заказа (12 полных + текущая), при nm — по размерам.
// Расчёт — lib/buyout.js, данные — lib/buyoutData.js. Ozon — следующий этап (спека §8).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { aggregateBuyout, weeklyBuyout, weekStart } from "@/lib/buyout.js";
import { loadWbBuyoutRows } from "@/lib/buyoutData.js";
import { defaultPeriod } from "@/lib/period.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const GET = withCabinet(async (req) => {
  try {
    const qp = new URL(req.url).searchParams;
    const asOf = new Date().toISOString().slice(0, 10);
    if (qp.get("series") === "1") {
      const nmRaw = parseInt(qp.get("nm"), 10);
      const nmId = Number.isFinite(nmRaw) ? nmRaw : null;
      const from = new Date(Date.parse(`${weekStart(asOf)}T00:00:00Z`) - 12 * 7 * 864e5).toISOString().slice(0, 10);
      const rows = await loadWbBuyoutRows(from, asOf);
      return NextResponse.json({ asOf, nmId, ...weeklyBuyout(rows, asOf, { nmId }) });
    }
    const def = defaultPeriod(30);
    const from = ISO.test(qp.get("from") || "") ? qp.get("from") : def.from;
    const to = ISO.test(qp.get("to") || "") ? qp.get("to") : def.to;
    if (from > to) return NextResponse.json({ error: "from > to" }, { status: 400 });
    const { kpi, items } = aggregateBuyout(await loadWbBuyoutRows(from, to), asOf);
    const q = (qp.get("q") || "").trim().toLowerCase();
    const shown = q
      ? items.filter((i) => `${i.name || ""} ${i.article || ""} ${i.nmId}`.toLowerCase().includes(q))
      : items;
    return NextResponse.json({ platform: "wb", from, to, asOf, kpi, items: shown, ozon: { legacy: true } });
  } catch (e) {
    console.error("buyout:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
```

- [ ] **Step 3: Сверить SQL адаптера с когортой спеки §4 напрямую в БД (кабинет #1, только чтение)**

Run:
```bash
cd /opt/agents/saas && cat > /tmp/claude-0/buyout_probe.mjs <<'EOF'
import { readFileSync } from 'node:fs';
for (const line of readFileSync('/opt/agents/saas/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { withTenant } = await import('/opt/agents/saas/lib/db.js');
const { loadWbBuyoutRows } = await import('/opt/agents/saas/lib/buyoutData.js');
const { aggregateBuyout } = await import('/opt/agents/saas/lib/buyout.js');
const d = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
await withTenant(1, async () => {
  const rows = await loadWbBuyoutRows(d(60), d(30));
  const { kpi } = aggregateBuyout(rows, d(0));
  console.log(JSON.stringify(kpi));
});
process.exit(0);
EOF
node /tmp/claude-0/buyout_probe.mjs
```
Expected: одна строка JSON; `ordered` ≈ 461 (окно сдвинулось на 2 дня с 10.10 — допуск ±15 %), `buyoutPct` в диапазоне 45–55, `refused` ≫ `cancelledPre`. Если `withTenant` экспортирован с другой сигнатурой — открыть `lib/db.js` (раздел `withTenant`, около строки 179) и вызвать по ней; запись в БД скрипт не делает.

- [ ] **Step 4: Сборка и рестарт, проверка эндпоинта**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 3 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/api/cabinets/1/buyout`
Expected: сборка без ошибок; `401` (без сессии — роут жив, авторизация работает). Содержательная проверка — смоук в Task 6.

- [ ] **Step 5: Commit**

```bash
cd /opt/agents/saas
git add lib/buyoutData.js "app/api/cabinets/[id]/buyout/route.js"
git commit -m "feat(buyout): адаптер БД и API /buyout — таблица по товарам/размерам и недели

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Страница — плитки, таблица с размерами, меню

**Files:**
- Create: `app/cabinets/[id]/buyout/page.js`
- Create: `app/cabinets/[id]/buyout/BuyoutPage.jsx`
- Modify: `app/cabinets/[id]/layout.js` (группа «Товары», после `{ href: "/purchase-need", label: "Потребность" },`)

**Interfaces:**
- Consumes: `GET /api/cabinets/[id]/buyout?from&to&q` (Task 2); `C`, `soft` из `lib/palette.js`; `useSort` из `lib/useSort.js`.
- Produces: компонент `BuyoutPage({ cabinetId })`; место под график — `<BuyoutChart cabinetId={cabinetId} nmId={selectedNm} name={selectedName} />` (подключается в Task 4; в этой задаче — `selectedNm` state и клик по строке уже есть).

- [ ] **Step 1: Бэкап и пункт меню**

```bash
cd /opt/agents/saas && cp "app/cabinets/[id]/layout.js" /opt/agentsDB/backups/layout.js.$(date +%Y%m%d_%H%M%S).bak
```
В `app/cabinets/[id]/layout.js` после строки `{ href: "/purchase-need", label: "Потребность" },` добавить:
```js
      { href: "/buyout", label: "Процент выкупа" },
```

- [ ] **Step 2: `page.js`**

```js
import BuyoutPage from "./BuyoutPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <BuyoutPage cabinetId={Number(params.id)} />;
}
```

- [ ] **Step 3: `BuyoutPage.jsx`**

Правила проекта: проп `{ cabinetId }` (D1), fetch в бэктиках (D3), все хуки до ранних `return` (D7), цвета только через `C`/`soft` (D13).

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useState } from "react";
import { useSort } from "@/lib/useSort.js";
import BuyoutChart from "./BuyoutChart";

// /cabinets/[id]/buyout — «Процент выкупа» (11.10.2026). WB, когортно по дате заказа:
// берём заказы периода и смотрим судьбу каждого (выкуп / невыкуп / возврат / в пути).
// % выкупа = выкуплено / (выкуплено + невыкуп + возвраты). Расчёт — lib/buyout.js,
// контракт метрик §18. Это НЕ коэффициент выкупа юнитки (там — по событиям отчёта реализации).

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : nf0.format(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : `${nf1.format(v)} %`);
const iso = (d) => d.toISOString().slice(0, 10);
const defFrom = () => iso(new Date(Date.now() - 30 * 864e5));
const defTo = () => iso(new Date(Date.now() - 864e5));

const COLS = [
  { key: "ordered", label: "Заказано", tip: "все заказы периода (по дате заказа)" },
  { key: "cancelledPre", label: "Отменено до отгрузки", tip: "отменены, товар к покупателю не ехал — в % не входят" },
  { key: "resolved", label: "Доехало", tip: "выкуплено + невыкуп + возвраты" },
  { key: "sold", label: "Выкуплено" },
  { key: "refused", label: "Невыкуп", tip: "доехал до ПВЗ, покупатель отказался" },
  { key: "returned", label: "Возвраты", tip: "выкупил, потом вернул" },
  { key: "pending", label: "В пути", tip: "развязки ещё нет — в % не входят" },
  { key: "self", label: "Самовыкупы", tip: "исключены из расчёта" },
  { key: "buyoutPct", label: "% выкупа" },
];

const th = { padding: "8px 10px", fontSize: 12, color: C.muted, fontWeight: 600, textAlign: "right", whiteSpace: "nowrap", cursor: "pointer", borderBottom: `1px solid ${C.line}` };
const td = { padding: "7px 10px", fontSize: 13, textAlign: "right", whiteSpace: "nowrap", borderBottom: `1px solid ${soft("line", 40)}` };

function PctCell({ r }) {
  const faded = r.lowSample;
  return (
    <span title={faded ? `мало доехавших (${r.resolved}) — процент неустойчив` : r.immature ? `ещё в пути ${nf1.format(r.pendingShare * 100)} % — цифра изменится` : ""}
      style={{ fontWeight: 700, color: faded ? C.muted : C.text, opacity: faded ? 0.6 : 1 }}>
      {pct(r.buyoutPct)}{r.immature ? " ⏳" : ""}
    </span>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 16px", minWidth: 150 }}>
      <div style={{ fontSize: 12, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

export default function BuyoutPage({ cabinetId }) {
  const [from, setFrom] = useState(defFrom);
  const [to, setTo] = useState(defTo);
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [selected, setSelected] = useState(null); // { nmId, name }
  const { sort, toggle, apply } = useSort("ordered", "desc");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/buyout?from=${from}&to=${to}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { if (alive) setData(j); })
      .catch((e) => { console.error("buyout load:", e); if (alive) setError(String(e.message || e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cabinetId, from, to]);

  const rows = useMemo(() => {
    const items = data?.items || [];
    const qq = q.trim().toLowerCase();
    const f = qq ? items.filter((i) => `${i.name || ""} ${i.article || ""} ${i.nmId}`.toLowerCase().includes(qq)) : items;
    return apply(f, Object.fromEntries(COLS.map((c) => [c.key, (r) => r[c.key]])));
  }, [data, q, apply]);

  const toggleOpen = (nm) => setOpen((cur) => {
    const n = new Set(cur);
    n.has(nm) ? n.delete(nm) : n.add(nm);
    return n;
  });

  const kpi = data?.kpi;
  return (
    <div style={{ padding: 24, fontFamily: FONT, color: C.text }}>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>Процент выкупа</h1>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, maxWidth: 900 }}>
        Wildberries. Берём заказы, сделанные в периоде, и смотрим, чем закончился каждый. % выкупа =
        выкуплено / (выкуплено + невыкуп + возвраты); заказы в пути и отменённые до отгрузки не входят,
        самовыкупы исключены. Свежие недели «дозревают» (⏳). Ozon — следующим этапом.
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ fontSize: 13 }}>Заказы с <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label style={{ fontSize: 13 }}>по <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <input placeholder="Поиск: название, артикул, nm" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ padding: "6px 10px", border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel, color: C.text, minWidth: 240 }} />
        {loading ? <span style={{ fontSize: 13, color: C.muted }}>загрузка…</span> : null}
      </div>

      {error ? <div style={{ color: C.neg, marginBottom: 12 }}>Ошибка: {error}</div> : null}

      {kpi ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          <Tile label="% выкупа" value={<PctCell r={kpi} />} sub={kpi.immature ? "период не дозрел" : null} />
          <Tile label="Доехало до покупателя" value={num(kpi.resolved)} sub={`из ${num(kpi.ordered)} заказов`} />
          <Tile label="Невыкуп" value={num(kpi.refused)} />
          <Tile label="Возвраты" value={num(kpi.returned)} />
          <Tile label="В пути" value={num(kpi.pending)} sub={`${nf1.format(kpi.pendingShare * 100)} % открытых`} />
        </div>
      ) : null}

      <BuyoutChart cabinetId={cabinetId} nmId={selected?.nmId ?? null} name={selected?.name ?? null}
        onReset={() => setSelected(null)} />

      <div style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", cursor: "default" }}>Товар</th>
              {COLS.map((c) => (
                <th key={c.key} style={th} title={c.tip || ""} onClick={() => toggle(c.key)}>
                  {c.label}{sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : " ↕"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => {
              const isOpen = open.has(it.nmId);
              const isSel = selected?.nmId === it.nmId;
              return [
                <tr key={it.nmId} style={{ background: isSel ? soft("accent", 10) : "transparent", cursor: "pointer" }}
                  onClick={() => setSelected(isSel ? null : { nmId: it.nmId, name: it.name || it.article })}>
                  <td style={{ ...td, textAlign: "left", whiteSpace: "normal", minWidth: 240 }}>
                    {it.sizes.length ? (
                      <span onClick={(e) => { e.stopPropagation(); toggleOpen(it.nmId); }}
                        style={{ display: "inline-block", width: 18, color: C.muted }}>{isOpen ? "▾" : "▸"}</span>
                    ) : <span style={{ display: "inline-block", width: 18 }} />}
                    <b>{it.name || "—"}</b>
                    <div style={{ fontSize: 12, color: C.muted, marginLeft: 18 }}>{it.article || ""} · {it.nmId}</div>
                  </td>
                  {COLS.map((c) => (
                    <td key={c.key} style={td}>{c.key === "buyoutPct" ? <PctCell r={it} /> : num(it[c.key])}</td>
                  ))}
                </tr>,
                ...(isOpen ? it.sizes.map((s) => (
                  <tr key={`${it.nmId}|${s.size}`} style={{ background: soft("line", 10) }}>
                    <td style={{ ...td, textAlign: "left", paddingLeft: 38, color: C.muted }}>размер <b style={{ color: C.text }}>{s.size}</b></td>
                    {COLS.map((c) => (
                      <td key={c.key} style={td}>{c.key === "buyoutPct" ? <PctCell r={s} /> : num(s[c.key])}</td>
                    ))}
                  </tr>
                )) : []),
              ];
            })}
            {!rows.length && !loading ? (
              <tr><td colSpan={COLS.length + 1} style={{ ...td, textAlign: "center", color: C.muted }}>Нет заказов за период</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

Проверить в `lib/useSort.js` (строки 19–40), что хук возвращает именно `{ sort, toggle, apply }`; если имена другие (например, `{ s, toggle, apply }`) — использовать их, как в `app/cabinets/[id]/purchase-need/PurchaseNeedPage.jsx`. Проверить, что в `lib/palette.js` есть `C.text`, `C.muted`, `C.panel`, `C.line`, `C.neg` и токен `accent` для `soft`; если имя другое — взять используемое в `PurchaseNeedPage.jsx`.

- [ ] **Step 4: Временная заглушка графика, чтобы сборка прошла до Task 4**

`app/cabinets/[id]/buyout/BuyoutChart.jsx`:
```jsx
"use client";
export default function BuyoutChart() { return null; }
```

- [ ] **Step 5: Сборка, рестарт, страница отвечает**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 3 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/cabinets/1/buyout`
Expected: сборка без ошибок; `200` или `307` (редирект на логин без сессии).

- [ ] **Step 6: Скрининги проекта**

Run: `cd /opt/agents/saas && grep -rn 'fetch("[^"]*\${' "app/cabinets/[id]/buyout/"; grep -rn 'var(--[a-z]*)[0-9A-F]\{2\}' "app/cabinets/[id]/buyout/"; grep -rn 'catch {}' "app/cabinets/[id]/buyout/" lib/buyout*.js`
Expected: пусто.

- [ ] **Step 7: Commit**

```bash
cd /opt/agents/saas
git add "app/cabinets/[id]/buyout/page.js" "app/cabinets/[id]/buyout/BuyoutPage.jsx" "app/cabinets/[id]/buyout/BuyoutChart.jsx" "app/cabinets/[id]/layout.js"
git commit -m "feat(buyout): страница «Процент выкупа» — плитки, таблица с раскрытием по размерам, меню

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: График по неделям

**Files:**
- Modify (полная замена заглушки): `app/cabinets/[id]/buyout/BuyoutChart.jsx`

**Interfaces:**
- Consumes: `GET /api/cabinets/[id]/buyout?series=1[&nm=]` → `{ sizeList, weeks: [{ week, buyoutPct, immature, lowSample, ordered, sold, refused, returned, pending, sizes: { [size]: Stats } }] }` (Task 2); props `{ cabinetId, nmId, name, onReset }` (Task 3).
- Produces: ничего для следующих задач.

Правила точек (спека §5.3): неделя `lowSample` — точка бледная и линия через неё не проводится (значение в линии = `null`, отдельная серия `*_low` рисует только точку); неделя `immature` — отрезок пунктиром. Реализация: для каждой серии три ключа данных — `${k}` (зрелые точки, сплошная), `${k}_imm` (последняя зрелая + недозревшие, пунктир), `${k}_low` (малые выборки, только точки).

- [ ] **Step 1: Компонент**

```jsx
"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

// График «% выкупа по неделям заказа» (спека 2026-10-11 §5.3). Без товара — весь кабинет;
// выбран товар — линия товара + линия на каждый размер. Пунктир — неделя не дозрела
// (в пути > 5 %), бледная точка без линии — доехало < 20 заказов.

const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const fmtWeek = (w) => new Date(`${w}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const PALETTE = ["accent", "pos", "warn", "pink", "neg", "muted"];

function splitSeries(points, key, st) {
  // st: Stats недели. Зрелая и достаточная — в сплошную; недозревшая — в пунктир;
  // малая выборка — только точка.
  points[key] = null; points[`${key}_imm`] = null; points[`${key}_low`] = null;
  if (st.buyoutPct == null) return;
  if (st.lowSample) points[`${key}_low`] = st.buyoutPct;
  else if (st.immature) points[`${key}_imm`] = st.buyoutPct;
  else points[key] = st.buyoutPct;
}

export default function BuyoutChart({ cabinetId, nmId, name, onReset }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    const nm = nmId != null ? `&nm=${nmId}` : "";
    fetch(`/api/cabinets/${cabinetId}/buyout?series=1${nm}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { if (alive) setData(j); })
      .catch((e) => { console.error("buyout series:", e); if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, [cabinetId, nmId]);

  const { series, chart } = useMemo(() => {
    if (!data) return { series: [], chart: [] };
    const series = [{ key: "total", label: nmId != null ? "Товар" : "Кабинет" }]
      .concat((data.sizeList || []).map((s) => ({ key: `s_${s}`, label: s, size: s })));
    const chart = data.weeks.map((w) => {
      const p = { week: w.week, _w: w };
      splitSeries(p, "total", w);
      for (const s of series.slice(1)) splitSeries(p, s.key, w.sizes[s.size]);
      return p;
    });
    // пунктир должен начинаться от последней зрелой точки — дублируем её в _imm
    for (const s of series) {
      for (let i = 1; i < chart.length; i++) {
        if (chart[i][`${s.key}_imm`] != null && chart[i - 1][s.key] != null && chart[i - 1][`${s.key}_imm`] == null) {
          chart[i - 1][`${s.key}_imm`] = chart[i - 1][s.key];
        }
      }
    }
    return { series, chart };
  }, [data, nmId]);

  const colorOf = (i) => `var(--${PALETTE[i % PALETTE.length]})`;

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <b>% выкупа по неделям заказа{nmId != null ? ` — ${name || nmId}` : " — весь кабинет"}</b>
        <span style={{ fontSize: 12, color: C.muted }}>
          пунктир — неделя не дозрела · бледная точка — доехало &lt; 20
          {nmId != null ? <> · <a onClick={onReset} style={{ cursor: "pointer", color: C.accent }}>весь кабинет</a></> : " · клик по товару в таблице — график по размерам"}
        </span>
      </div>
      {error ? <div style={{ color: C.neg }}>Ошибка: {error}</div> : null}
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            <CartesianGrid stroke={soft("line", 20)} vertical={false} />
            <XAxis dataKey="week" tickFormatter={fmtWeek} tick={{ fontSize: 11, fill: C.muted }} stroke={soft("line", 30)} />
            <YAxis domain={[0, 100]} tickFormatter={(v) => `${v} %`} tick={{ fontSize: 11, fill: C.muted }} stroke={soft("line", 30)} width={50} />
            <Tooltip
              labelFormatter={(w) => `неделя с ${fmtWeek(w)}`}
              formatter={(v, key, item) => {
                const base = String(key).replace(/_(imm|low)$/, "");
                const s = series.find((x) => x.key === base);
                const st = base === "total" ? item.payload._w : item.payload._w.sizes[s?.size];
                const extra = st ? ` (заказано ${st.ordered}, выкуп ${st.sold}, невыкуп ${st.refused}, возвр. ${st.returned}, в пути ${st.pending})` : "";
                return [`${nf1.format(v)} %${extra}`, s?.label || base];
              }}
              contentStyle={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12 }}
            />
            {series.length > 1 ? <Legend payload={series.map((s, i) => ({ value: s.label, type: "line", color: colorOf(i) }))} /> : null}
            {series.flatMap((s, i) => [
              <Line key={s.key} dataKey={s.key} name={s.label} stroke={colorOf(i)} strokeWidth={s.key === "total" ? 3 : 2}
                dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} legendType="none" />,
              <Line key={`${s.key}_imm`} dataKey={`${s.key}_imm`} name={s.label} stroke={colorOf(i)} strokeWidth={2}
                strokeDasharray="5 4" dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} legendType="none" />,
              <Line key={`${s.key}_low`} dataKey={`${s.key}_low`} name={s.label} stroke="transparent"
                dot={{ r: 3, fill: colorOf(i), fillOpacity: 0.35, stroke: "none" }} isAnimationActive={false} legendType="none" />,
            ])}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

Перед сборкой сверить, что токены `--accent`, `--pos`, `--warn`, `--pink`, `--neg`, `--muted` определены в `app/globals.css` (D13); отсутствующий заменить существующим.

- [ ] **Step 2: Сборка и рестарт**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web`
Expected: без ошибок.

- [ ] **Step 3: Проверка графика**

Содержательно данные недель проверяет смоук Task 6 (13 недель, последняя — текущая). Здесь —
открыть `/cabinets/1/buyout` под владельцем: график рисуется, клик по бюстгальтеру даёт линии
XS…XL, последние 1–2 недели пунктиром. Если браузера нет — пропустить до Task 6 и отметить.

- [ ] **Step 4: Commit**

```bash
cd /opt/agents/saas
git add "app/cabinets/[id]/buyout/BuyoutChart.jsx"
git commit -m "feat(buyout): график % выкупа по неделям — кабинет или товар по размерам

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: «Сводка по товарам» на новом расчёте (WB)

**Files:**
- Modify: `app/api/cabinets/[id]/products-summary/route.js` — `collectWB` (функция от строки ~495), `collectOzon` (~672), цикл досчёта (~97), `aggTotals` (~235–272)
- Modify: `app/cabinets/[id]/summary/SummaryPage.jsx` — пересчёт `ft` (~270–311), подсказка колонки «% выкупа»

**Interfaces:**
- Consumes: `loadWbBuyoutRows` (Task 2), `aggregateBuyout` (Task 1).
- Produces: у каждого item Сводки поля `buyoutSold: number`, `buyoutResolved: number`, `buyoutLegacy: boolean`; `buyoutPct = buyoutResolved > 0 ? round2(100 * buyoutSold / buyoutResolved) : null` — в item, totals и клиентском `ft`. Поля `sold`/`returns`/`cancelled` и их смысл НЕ меняются (на них завязаны деньги и колонки).

- [ ] **Step 1: Бэкапы**

```bash
cd /opt/agents/saas && TS=$(date +%Y%m%d_%H%M%S) && cp "app/api/cabinets/[id]/products-summary/route.js" /opt/agentsDB/backups/products-summary.route.js.$TS.bak && cp "app/cabinets/[id]/summary/SummaryPage.jsx" /opt/agentsDB/backups/SummaryPage.jsx.$TS.bak
```

- [ ] **Step 2: Импорты в `route.js`** (после `import { defaultPeriod } from "@/lib/period.js";`)

```js
import { aggregateBuyout } from "@/lib/buyout.js";
import { loadWbBuyoutRows } from "@/lib/buyoutData.js";
```

- [ ] **Step 3: `collectWB` — выкуп по товару из ядра**

Сразу перед строкой `const profitBatch = await wbProfitProductBatch(db, taxMode, { from, to: toEnd.slice(0, 10) });` вставить:

```js
  // % выкупа — КАНОН lib/buyout.js (спека 2026-10-11): когорта заказов окна по дате
  // заказа, судьба каждого srid. Одна цифра со страницей «Процент выкупа».
  const asOf = new Date().toISOString().slice(0, 10);
  const buyoutByNm = new Map(
    aggregateBuyout(await loadWbBuyoutRows(from, toEnd.slice(0, 10)), asOf).items.map((b) => [b.nmId, b])
  );
```

В объекте `out.push({ ... })` WB, после строки `sold, returns, selfBuyout: r.selfBuyout || 0,` добавить:

```js
      buyoutSold: buyoutByNm.get(Number(nm))?.sold || 0,
      buyoutResolved: buyoutByNm.get(Number(nm))?.resolved || 0,
      buyoutLegacy: false,
```

- [ ] **Step 4: `collectOzon` — прежняя формула, явно помеченная**

В объекте `out.push({ ... })` Ozon (строка с `ordered: o.ordered, cancelled: o.cancelled,` около ~887) после неё добавить:

```js
      // % выкупа Ozon — ПРЕЖНЯЯ формула sold/(sold+returns+cancelled) (смешение популяций,
      // спека 2026-10-11 §2): перевод на когорту — отдельный этап (§8), до него флаг.
      buyoutSold: r.sold || 0,
      buyoutResolved: (r.sold || 0) + (r.returns || 0) + (o.cancelled || 0),
      buyoutLegacy: true,
```

Перед вставкой открыть этот `out.push` и убедиться, что переменные там называются `r` и `o` (как в WB-блоке); если иначе — использовать фактические имена.

- [ ] **Step 5: Формула item и итогов**

Заменить (≈стр. 97–98):
```js
      it.buyoutPct = (it.sold + it.returns + it.cancelled) > 0
        ? round2(100 * it.sold / (it.sold + it.returns + it.cancelled)) : null;
```
на:
```js
      it.buyoutPct = it.buyoutResolved > 0 ? round2(100 * it.buyoutSold / it.buyoutResolved) : null;
```

В `aggTotals`: в начальный объект `t` добавить `buyoutSold: 0, buyoutResolved: 0, buyoutLegacy: false,`; в цикл —
```js
    t.buyoutSold += i.buyoutSold || 0;
    t.buyoutResolved += i.buyoutResolved || 0;
    if (i.buyoutLegacy) t.buyoutLegacy = true;
```
и заменить
```js
  t.buyoutPct = (t.sold + t.returns + t.cancelled) > 0
    ? round2(100 * t.sold / (t.sold + t.returns + t.cancelled)) : null;
```
на
```js
  t.buyoutPct = t.buyoutResolved > 0 ? round2(100 * t.buyoutSold / t.buyoutResolved) : null;
```

- [ ] **Step 6: `SummaryPage.jsx` — тот же пересчёт по фильтрам**

В начальный объект `ft` (≈стр. 274) добавить `buyoutSold: 0, buyoutResolved: 0, buyoutLegacy: false,`; в цикл суммирования (рядом с `ft.cancelled += i.cancelled || 0;`):
```js
      ft.buyoutSold += i.buyoutSold || 0;
      ft.buyoutResolved += i.buyoutResolved || 0;
      if (i.buyoutLegacy) ft.buyoutLegacy = true;
```
Заменить (≈стр. 310–311):
```js
    ft.buyoutPct = (ft.sold + ft.returns + ft.cancelled) > 0
      ? round2(100 * ft.sold / (ft.sold + ft.returns + ft.cancelled)) : null;
```
на
```js
    // % выкупа — по счётчикам когорты (lib/buyout.js, спека 2026-10-11); Ozon — legacy-флаг.
    ft.buyoutPct = ft.buyoutResolved > 0 ? round2(100 * ft.buyoutSold / ft.buyoutResolved) : null;
```
У ячейки строки `<Td right>{pct(it.buyoutPct)}</Td>` (≈стр. 547) — обернуть в подсказку:
```jsx
                <Td right><span title={it.buyoutLegacy ? "Ozon: прежняя формула, переводится" : "WB: заказы периода → выкуплено / (выкуплено + невыкуп + возвраты), см. «Процент выкупа»"}>{pct(it.buyoutPct)}{it.buyoutLegacy ? "*" : ""}</span></Td>
```
Если `Td` не пробрасывает детей как есть — открыть его определение в файле и проверить; `title` на внутреннем `span` не зависит от `Td`.

- [ ] **Step 7: Сборка, рестарт, проверка**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web && grep -n "it.sold + it.returns + it.cancelled\|t.sold + t.returns + t.cancelled\|ft.sold + ft.returns + ft.cancelled" "app/api/cabinets/[id]/products-summary/route.js" "app/cabinets/[id]/summary/SummaryPage.jsx"`
Expected: сборка без ошибок; grep пуст. Сверка цифр — смоук Task 6.

- [ ] **Step 8: Commit**

```bash
cd /opt/agents/saas
git add "app/api/cabinets/[id]/products-summary/route.js" "app/cabinets/[id]/summary/SummaryPage.jsx"
git commit -m "fix(summary): % выкупа WB — когортный расчёт lib/buyout.js, Ozon помечен legacy

Прежняя формула sold/(sold+returns+cancelled) смешивала продажи по дате продажи,
возвраты по дате возврата и отмены по дате заказа (спека 2026-10-11 §2).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Смоук, документация, подсказка юнитки

**Files:**
- Create: `scripts/smoke-buyout.mjs`
- Modify: `docs/metrics-contract.md` (новый раздел `## 18. Процент выкупа (с 2026-10-11)` перед `## Известные расхождения с реализацией`)
- Modify: `AGENTS.md` (строка в таблице TL;DR и пункт в «Где что считается»)
- Modify: `lib/unit.js:49` и строка Ozon-колонки `buyout` (~81) — только текст `tip`

**Interfaces:**
- Consumes: `GET /buyout`, `GET /products-summary?platform=wb&from&to`.

- [ ] **Step 1: Смоук**

`scripts/smoke-buyout.mjs`:

```js
#!/usr/bin/env node
// scripts/smoke-buyout.mjs — смоук «Процента выкупа» (11.10.2026). Только чтение. Проверяет:
//   1) /buyout 200; Σ размеров = товар по каждому счётчику; Σ товаров = KPI;
//   2) % = sold/resolved на каждой строке; resolved = sold+refused+returned;
//   3) WB-выкуп Сводки (platform=wb, то же окно) = выкуп страницы — по товарам и в итогах;
//   4) недели: 13 штук, последняя — текущая неделя.
// Аутентификация — sealed-cookie, как scripts/smoke-purchase-need.mjs.
// Запуск: node scripts/smoke-buyout.mjs [cabinetId=1] [baseUrl]
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
const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
const get = async (path) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { headers: { cookie: `saas_session=${encodeURIComponent(seal)}` } });
  return { status: r.status, data: await r.json() };
};
const K = ['ordered', 'self', 'returned', 'sold', 'refused', 'cancelledPre', 'pending'];
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

const b = await get('buyout');
check('buyout: HTTP 200 без error', b.status === 200 && !b.data.error, `${b.status} ${b.data.error || ''}`);
const { from, to, kpi, items = [] } = b.data;
console.log(`      окно ${from}..${to}: заказов ${kpi?.ordered}, доехало ${kpi?.resolved}, выкуп ${kpi?.buyoutPct} %, в пути ${kpi?.pending}`);

const badSizes = [];
for (const it of items) {
  if (!it.sizes.length) continue;
  for (const k of K) if (it.sizes.reduce((a, s) => a + s[k], 0) !== it[k]) badSizes.push(`${it.nmId}.${k}`);
}
check('Σ размеров = товар', badSizes.length === 0, badSizes);
const badKpi = K.filter((k) => items.reduce((a, i) => a + i[k], 0) !== kpi[k]);
check('Σ товаров = KPI', badKpi.length === 0, badKpi);
const badPct = [kpi, ...items, ...items.flatMap((i) => i.sizes)].filter((r) =>
  r.resolved !== r.sold + r.refused + r.returned ||
  r.buyoutPct !== (r.resolved > 0 ? r2(100 * r.sold / r.resolved) : null));
check('% = sold/resolved, resolved = sold+refused+returned', badPct.length === 0, badPct.map((r) => r.nmId ?? r.size ?? 'kpi'));

const s = await get(`products-summary?platform=wb&from=${from}&to=${to}&includeInactive=1`);
check('products-summary: HTTP 200', s.status === 200 && !s.data.error, `${s.status} ${s.data.error || ''}`);
const byNm = new Map(items.map((i) => [Number(i.nmId), i]));
const diff = [];
for (const it of s.data.items || []) {
  const p = byNm.get(Number(it.nm));
  const want = p ? p.buyoutPct : null;
  if (it.buyoutPct !== want) diff.push(`${it.nm}: сводка ${it.buyoutPct} ≠ страница ${want}`);
}
check('выкуп по товарам: Сводка = страница', diff.length === 0, diff);
check('выкуп итогов: Сводка = страница', s.data.totals?.buyoutPct === kpi.buyoutPct,
  `${s.data.totals?.buyoutPct} ≠ ${kpi.buyoutPct}`);

const w = await get('buyout?series=1');
const monday = (() => { const d = new Date(); const dow = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10); })();
check('недели: 13, последняя — текущая', w.data.weeks?.length === 13 && w.data.weeks[12].week === monday,
  `${w.data.weeks?.length} ${w.data.weeks?.[12]?.week} ≠ ${monday}`);

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
```

Замечание к проверке «Сводка = страница»: в Сводке товар без заказов в окне получает `buyoutPct = null`, на странице его нет вовсе → `want = null` — совпадает. Если Сводка группирует WB по иному ключу, чем `nm` (проверить поле в ответе: `it.nm`), — использовать фактическое поле.

- [ ] **Step 2: Прогнать смоук и тесты**

Run: `cd /opt/agents/saas && node --test lib/__tests__/buyout.test.mjs && node scripts/smoke-buyout.mjs 1`
Expected: тесты PASS; смоук `ALL PASS`. При FAIL — разбирать как баг (правило по финансам), не ослаблять проверку.

- [ ] **Step 3: Регрессия соседей**

Run: `cd /opt/agents/saas && node scripts/smoke-purchase-need.mjs 1 && node --test lib/__tests__/*.test.mjs`
Expected: ALL PASS / все тесты зелёные (Сводка и юнитка не сломаны).

- [ ] **Step 4: Подсказка колонки юнитки** (`lib/unit.js`, бэкап перед правкой)

```bash
cd /opt/agents/saas && cp lib/unit.js /opt/agentsDB/backups/unit.js.$(date +%Y%m%d_%H%M%S).bak
```
В WB-колонке `buyout` (стр. 49) заменить значение `tip` на:
```
"коэффициент модели логистики: продано / (продано + невыкупы) по СОБЫТИЯМ отчёта реализации за 30 дней по вчера — так логистика = Σлогистики/продано. Это не «% выкупа» товара: точный выкуп по заказам и размерам — страница «Процент выкупа» (контракт §18)"
```
В Ozon-колонке `buyout` (~стр. 81) в конец текущего `tip` дописать: `"; не «% выкупа» товара — см. контракт §18"`. Формулы не трогать.

- [ ] **Step 5: Контракт метрик** — в `docs/metrics-contract.md` перед `## Известные расхождения с реализацией` вставить:

```markdown
## 18. Процент выкупа (с 2026-10-11)

Спека `docs/superpowers/specs/2026-10-11-buyout-page-design.md`. Код `lib/buyout.js` (ядро),
`lib/buyoutData.js` (данные), страница `/buyout`, Сводка `products-summary`.

### 18.1 Канон (WB)

Когорта — заказы `wb_orders` с датой заказа в окне. Судьба каждого `srid` — одно ведро, в
порядке: самовыкуп (`wb_order_costs.self_buyout=1`, исключён) → возврат (`wb_sales` `R…`) →
выкуп (`wb_sales` `S…`) → невыкуп (`is_cancel=1` + логистика «К клиенту при отмене» в отчёте
реализации) → отмена до отгрузки (`is_cancel=1`, логистики нет, отмене > 7 дней) → в пути.

`% выкупа = выкуп / (выкуп + невыкуп + возврат)`; в пути и отмены до отгрузки — вне
знаменателя. «Не дозрел» — в пути > 5 % открытых; «малая выборка» — доехало < 20.

### 18.2 Почему не прежняя формула Сводки

`sold/(sold+returns+cancelled)` (с 12.07.2026 до 11.10.2026) брала продажи по дате продажи,
возвраты по дате возврата и отмены по дате заказа — три разные популяции; у Ozon в отменах —
отмены до отгрузки. Заменена каноном 18.1 для WB.

### 18.3 Ozon — legacy до отдельного этапа

`ozon_sales` неполна, у FBO пустая `shipment_dt`: невыкуп от отмены до отгрузки — вероятно,
только по начислениям. До пробы Ozon в Сводке — прежняя формула, `buyoutLegacy: true`, в UI
отмечена `*`.

### 18.4 Юнитка — другая величина (решение владельца 11.10.2026)

`lib/unit.js` `buyout` — коэффициент модели логистики по СОБЫТИЯМ отчёта реализации за 30
дней по вчера: `F + R(1−b)/b = Σлогистики / продано` (сверено с фактом 06.10.2026). Когортный
выкуп туда не подставляется — сломал бы равенство. Подписано в подсказке колонки юнитки.
```

- [ ] **Step 6: AGENTS.md** — бэкап, затем:
  - в таблицу TL;DR после строки «Премия менеджеров / роли» добавить:
    `| Процент выкупа (когорта по заказам, размеры WB) | `lib/buyout.js`, `lib/buyoutData.js`, `/buyout`, контракт §18 |`
  - в «Где что считается» после пункта «Премия менеджеров площадок» добавить пункт:
    ```markdown
    - **Процент выкупа (с 2026-10-11)** — страница `/buyout` (меню «Товары»), API
      `/api/cabinets/[id]/buyout` (`?series=1[&nm=]` — 13 недель). WB когортно по дате заказа:
      судьба каждого `srid` (самовыкуп → возврат → выкуп → невыкуп по логистике «К клиенту при
      отмене» → отмена до отгрузки > 7 дн → в пути); `% = выкуп / (выкуп + невыкуп + возврат)`;
      размеры — `wb_orders.tech_size`. Ядро `lib/buyout.js` (тесты `lib/__tests__/buyout.test.mjs`),
      данные `lib/buyoutData.js`. «Сводка по товарам» берёт WB-выкуп отсюда же (одна цифра);
      Ozon — прежняя формула с флагом `buyoutLegacy` до отдельного этапа. Юнитка НЕ переведена
      (коэффициент модели логистики, §18.4). Смоук `node scripts/smoke-buyout.mjs 1`.
    ```

- [ ] **Step 7: Финальная сборка и смоук после правки `lib/unit.js`**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 3 && node scripts/smoke-buyout.mjs 1`
Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
cd /opt/agents/saas
git add scripts/smoke-buyout.mjs docs/metrics-contract.md AGENTS.md lib/unit.js
git commit -m "docs+smoke(buyout): контракт §18, карта AGENTS.md, смоук, подсказка выкупа в юнитке

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Самопроверка плана (выполнено при написании)

- Спека §3.1–3.2, §5.1–5.2 → Task 1–2; §5.3 → Task 1 (`weeklyBuyout`), Task 4; §3.3 → Task 5; §3.4, §5.4 → Task 6 (подсказка + §18.4); §3.5, §8 → Task 5 (legacy) + Task 3 (текст на странице); §6 файлы — все в таблице; §7 (пустой catch, 7 дней, только #1) — Global Constraints; §9 → Task 6.
- Отклонение от спеки §6: параметр `platform` у `/buyout` не вводится — страница только WB, Ozon поясняется текстом (`ozon: {legacy:true}` в ответе). Переключатель площадки появится вместе с Ozon-этапом.
- Имена сквозные: `buyoutStats`/`aggregateBuyout`/`weeklyBuyout`/`loadWbBuyoutRows`, поля `resolved`, `cancelledPre`, `buyoutSold`/`buyoutResolved`/`buyoutLegacy` — одинаковы во всех задачах.
