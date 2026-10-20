# Процент выкупа: корзина по покупателю Ozon и перезаказы — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** корзина Ozon = покупатель + день; новый тип «Перезаказ» (не выкупил → в течение 7 дней заказал другой вариант той же модели) в фильтре и отдельный блок со сводкой перезаказов.

**Architecture:** чистые функции в `lib/buyout.js` (`assignOzonBaskets`, `tagReorders`, `reorderSummary`, `shiftDate`), загрузчик Ozon отдаёт `buyer/orderNumber/region`, роут грузит окно ±7 дн, размечает, режет до периода; страница — пункт фильтра и блок.

**Tech Stack:** Next.js 14, PostgreSQL (RLS), node:test.

**Spec:** `docs/superpowers/specs/2026-10-20-buyout-reorders-design.md` (продолжение `2026-10-20-buyout-fitting-design.md`)

## Global Constraints

- Только кабинет #1. Только чтение БД (новых миграций нет).
- Дефолт «Все»: KPI/таблица/категории при `fit=all` — ровно строки периода `from..to`; смоук «Сводка = страница» остаётся зелёным.
- `ANOMALY_REGIONS_PER_DAY = 3`, `REORDER_WINDOW_DAYS = 7`; тот же день — не перезаказ.
- «Не выкуплен покупателем» = ведро `refused`/`returned` ИЛИ `status === "cancelled"` с причиной не из `OZ_OZONSIDE_REASON_PREFIXES`.
- Бэкап боевых файлов в `/opt/agentsDB/backups/<имя>.20261020_HHMMSS.bak`; `git add` только файлы задачи; без пустых `catch {}`; хуки до ранних return; `next dev` не запускать.

---

### Task 1: Чистые функции (`lib/buyout.js`)

**Files:**
- Modify: `lib/buyout.js` (раздел «Примерка» в конце файла)
- Test: `lib/__tests__/buyout.test.mjs` (в конец)

**Interfaces:**
- Produces:
  - `shiftDate(dateStr: "YYYY-MM-DD", days: number) -> "YYYY-MM-DD"`
  - `ANOMALY_REGIONS_PER_DAY = 3`, `REORDER_WINDOW_DAYS = 7`
  - `assignOzonBaskets(rows) -> rows` — Ozon-строкам с `buyer`: `buyerAnomalous: boolean`, `basket` = аномальный ? `orderNumber` : `` `${buyer}|${orderDate}` ``; прочие строки — как есть.
  - `tagReorders(rows, asOf, windowDays = 7) -> rows` — вызывать ПОСЛЕ `tagFitting`; строкам цепочек `reorderTo`/`reorderFrom` (srid или отсутствуют), `fit: "fit_reorder"`, если было `"single"`.
  - `reorderSummary(rows, allRows, asOf) -> { dropped, pairs, reorderShare, bResolved, bBuyoutPct, byModel: [{ platform, modelKey, name, pairs, sizeUp, sizeDown, color, mixed, bSold, bResolved, bBuyoutPct, combos: [{ combo, n }] }] }`
  - `FIT_VALUES` = `["all","single","fitting","size","color","mixed","reorder"]`.

- [ ] **Step 1: Падающие тесты** (в конец `lib/__tests__/buyout.test.mjs`)

```js
import { assignOzonBaskets, tagReorders, reorderSummary, shiftDate, REORDER_WINDOW_DAYS, ANOMALY_REGIONS_PER_DAY } from "../buyout.js";

// Перезаказы и корзина по покупателю Ozon (20.10.2026, спека 2026-10-20-buyout-reorders-design.md).
const ozRe = (o) => ({ platform: "ozon", srid: "p", nmId: 1, name: "Комплект", article: "коричн-цвет-M", status: "delivered",
  isReturn: false, selfBuyout: false, orderDate: "2026-09-01", cancelAt: null, cancelReason: null,
  buyer: "U1", orderNumber: "U1-0001", region: "Москва", basket: "U1-0001",
  modelKey: "m:1", variantKey: "1", colorKey: "коричн", sizeKey: "M", sizeLabel: "M", fitEstimated: false, ...o });
const BUYER_CANCEL = "Покупатель отменил заказ";
const prep = (rows) => tagReorders(tagFitting(assignOzonBaskets(rows)), ASOF);

test("shiftDate и константы", () => {
  assert.equal(shiftDate("2026-09-28", 7), "2026-10-05");
  assert.equal(shiftDate("2026-09-01", -7), "2026-08-25");
  assert.equal(REORDER_WINDOW_DAYS, 7);
  assert.equal(ANOMALY_REGIONS_PER_DAY, 3);
});

test("assignOzonBaskets: корзина = покупатель + день; аномальный покупатель — по номеру заказа; WB не трогаем", () => {
  const rows = assignOzonBaskets([
    ozRe({ srid: "a", orderNumber: "U1-0001" }), ozRe({ srid: "b", orderNumber: "U1-0002" }),
    ozRe({ srid: "c", orderNumber: "U1-0003", orderDate: "2026-09-02" }),
    ozRe({ srid: "x1", buyer: "BAD", orderNumber: "BAD-1", region: "A" }), ozRe({ srid: "x2", buyer: "BAD", orderNumber: "BAD-2", region: "B" }),
    ozRe({ srid: "x3", buyer: "BAD", orderNumber: "BAD-3", region: "C" }),
    { platform: "wb", srid: "w", basket: "G1" },
  ]);
  assert.equal(rows[0].basket, "U1|2026-09-01");
  assert.equal(rows[1].basket, "U1|2026-09-01");
  assert.equal(rows[2].basket, "U1|2026-09-02");
  assert.equal(rows[0].buyerAnomalous, false);
  assert.equal(rows[3].basket, "BAD-1");
  assert.equal(rows[3].buyerAnomalous, true);
  assert.deepEqual(rows[6], { platform: "wb", srid: "w", basket: "G1" });
});

test("assignOzonBaskets: два заказа одного дня с разными вариантами — одна корзина-примерка", () => {
  const rows = tagFitting(assignOzonBaskets([ozRe({ srid: "a", orderNumber: "U1-1", sizeKey: "S", sizeLabel: "S", variantKey: "1" }),
    ozRe({ srid: "b", orderNumber: "U1-2", variantKey: "2" })]));
  assert.deepEqual(rows.map((r) => r.fit), ["fit_size", "fit_size"]);
});

test("tagReorders: отмена покупателем → на следующий день другой размер — перезаказ, обе строки fit_reorder", () => {
  const rows = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, sizeKey: "L", sizeLabel: "L", variantKey: "L" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", sizeKey: "XL", sizeLabel: "XL", variantKey: "XL" }),
  ]);
  assert.equal(rows[0].reorderTo, "b");
  assert.equal(rows[1].reorderFrom, "a");
  assert.deepEqual(rows.map((r) => r.fit), ["fit_reorder", "fit_reorder"]);
});

test("tagReorders: не перезаказ — через 8 дней, отмена со стороны Ozon, выкупленный A, тот же вариант, аномальный покупатель", () => {
  const A = { srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "L", sizeKey: "L", sizeLabel: "L" };
  const B = { srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", variantKey: "XL", sizeKey: "XL", sizeLabel: "XL" };
  const none = (rows) => prep(rows).every((r) => !r.reorderTo && !r.reorderFrom && r.fit === "single");
  assert.ok(none([ozRe(A), ozRe({ ...B, orderDate: "2026-09-09" })]));
  assert.ok(none([ozRe({ ...A, cancelReason: "Не удалось доставить заказ" }), ozRe(B)]));
  assert.ok(none([ozRe({ ...A, status: "delivered", cancelReason: null }), ozRe(B)]));
  assert.ok(none([ozRe(A), ozRe({ ...B, variantKey: "L" })]));
  assert.ok(none([ozRe({ ...A, buyer: "BAD", region: "A" }), ozRe({ ...B, buyer: "BAD", region: "A" }),
    ozRe({ srid: "z1", buyer: "BAD", orderNumber: "BAD-9", region: "B" }), ozRe({ srid: "z2", buyer: "BAD", orderNumber: "BAD-8", region: "C" })]
    .map((r) => ({ ...r, orderDate: r.srid === "b" ? "2026-09-02" : "2026-09-01" }))));
  // 7 дней — ещё перезаказ (граница включительно)
  assert.equal(prep([ozRe(A), ozRe({ ...B, orderDate: "2026-09-08" })])[0].reorderTo, "b");
});

test("tagReorders: невыкуп (refused) и цепочка A→B→C; корзина главнее", () => {
  const rows = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: "Покупатель не забрал заказ", variantKey: "S", sizeKey: "S", sizeLabel: "S" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-03", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "M", sizeKey: "M", sizeLabel: "M" }),
    ozRe({ srid: "b2", orderNumber: "U1-2", orderDate: "2026-09-03", variantKey: "XS", sizeKey: "XS", sizeLabel: "XS" }),
    ozRe({ srid: "c", orderNumber: "U1-3", orderDate: "2026-09-05", variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.srid, r]));
  assert.equal(by.a.reorderTo, "b");
  assert.equal(by.b.reorderFrom, "a");
  assert.equal(by.b.reorderTo, "c");
  assert.equal(by.a.fit, "fit_reorder");
  assert.equal(by.b.fit, "fit_size");   // корзина 09-03 (M + XS) главнее
  assert.equal(by.c.fit, "fit_reorder");
});

test("filterByFitting: размеры + цвета + смешанные + перезаказы = примерки; одиночные + примерки = все", () => {
  const rows = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", variantKey: "XL", sizeKey: "XL", sizeLabel: "XL" }),
    ozRe({ srid: "s1", buyer: "U2", orderNumber: "U2-1", variantKey: "1" }), ozRe({ srid: "s2", buyer: "U2", orderNumber: "U2-1", variantKey: "2", colorKey: "баклаж" }),
    ozRe({ srid: "o", buyer: "U3", orderNumber: "U3-1" }),
  ]);
  const k = (kind) => aggregateBuyout(filterByFitting(rows, kind), ASOF).kpi;
  for (const key of ["ordered", "sold", "refused", "returned", "pending", "cancelledPre", "self"]) {
    assert.equal(k("single")[key] + k("fitting")[key], k("all")[key], key);
    assert.equal(k("size")[key] + k("color")[key] + k("mixed")[key] + k("reorder")[key], k("fitting")[key], key);
  }
  assert.equal(k("reorder").ordered, 2);
  assert.deepEqual(FIT_VALUES, ["all", "single", "fitting", "size", "color", "mixed", "reorder"]);
});

test("fittingSummary не считает перезаказы примерочными корзинами", () => {
  const rows = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", variantKey: "XL", sizeKey: "XL", sizeLabel: "XL" }),
  ]);
  const s = fittingSummary(rows, ASOF);
  assert.equal(s.fittingBaskets, 0);
  assert.equal(s.fittingRows, 0);
});

test("reorderSummary: доля, направление, выкуп второго, B за периодом", () => {
  const all = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, article: "коричн-цвет-L", variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", article: "коричн-цвет-XL", variantKey: "XL", sizeKey: "XL", sizeLabel: "XL" }),
    ozRe({ srid: "c", buyer: "U2", orderNumber: "U2-1", status: "cancelled", cancelReason: BUYER_CANCEL, article: "коричн-цвет-M", variantKey: "M" }),
    ozRe({ srid: "d", buyer: "U2", orderNumber: "U2-2", orderDate: "2026-09-04", article: "баклаж-цвет-M", variantKey: "BM", colorKey: "баклаж",
      status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    ozRe({ srid: "e", buyer: "U3", orderNumber: "U3-1", status: "cancelled", cancelReason: BUYER_CANCEL }),
  ]);
  const period = all.filter((r) => r.srid !== "b"); // B за границей периода — судьба всё равно видна
  const s = reorderSummary(period, all, ASOF);
  assert.equal(s.dropped, 4);       // a, c, d, e
  assert.equal(s.pairs, 2);         // a→b, c→d
  assert.equal(s.reorderShare, 50);
  assert.equal(s.bResolved, 2);
  assert.equal(s.bBuyoutPct, 50);   // b выкуплен, d — невыкуп
  const m = s.byModel[0];
  assert.equal(m.pairs, 2);
  assert.equal(m.sizeUp, 1);
  assert.equal(m.color, 1);
  assert.deepEqual(m.combos, [{ combo: "коричн-цвет-L → коричн-цвет-XL", n: 1 }, { combo: "коричн-цвет-M → баклаж-цвет-M", n: 1 }]);
});
```

Run: `node --test lib/__tests__/buyout.test.mjs` → FAIL (`does not provide an export named 'assignOzonBaskets'`).

- [ ] **Step 2: Реализация** (бэкап `lib/buyout.js`)

(a) Вынести `pctOf` на уровень модуля (над `fittingSummary`) и удалить локальное определение внутри `fittingSummary`:

```js
const pctOf = (a, b) => (b > 0 ? round2((100 * a) / b) : null);
```

(b) `FIT_VALUES` и `FIT_PRED`:

```js
export const FIT_VALUES = ["all", "single", "fitting", "size", "color", "mixed", "reorder"];
const FIT_PRED = {
  single: (f) => f === "single",
  fitting: (f) => f !== "single",
  size: (f) => f === "fit_size",
  color: (f) => f === "fit_color",
  mixed: (f) => f === "fit_mixed",
  reorder: (f) => f === "fit_reorder",
};
```

(c) В `fittingSummary`: `if (r.fit !== "single") nFitRows += 1;` → `if (r.fit !== "single" && r.fit !== "fit_reorder") nFitRows += 1;` и `if (g.fit === "single") continue;` → `if (g.fit === "single" || g.fit === "fit_reorder") continue;` с комментарием: «сводка примерок ПО КОРЗИНЕ — перезаказы (разные дни) считает reorderSummary».

(d) В конец файла:

```js
// Корзина по покупателю Ozon и перезаказы (20.10.2026, спека docs/superpowers/specs/2026-10-20-buyout-reorders-design.md).
// Покупатель = первая часть posting_number (наблюдение пробой: счётчик заказов растёт по дате, 95 % префиксов —
// один регион; не документированное поле Ozon). Корзина = покупатель + день заказа. Аномальный «покупатель»
// (в один день заказы в 3+ регионах — массовые сбои/боты) — корзина по номеру заказа, в перезаказах не участвует.
// Перезаказ: A не выкуплен покупателем → первый заказ того же покупателя и модели с ДРУГИМ вариантом позже дня A,
// но не позже A + 7 дн. У WB ID покупателя нет — только корзина g_number.
export const ANOMALY_REGIONS_PER_DAY = 3;
export const REORDER_WINDOW_DAYS = 7;

export function shiftDate(dateStr, days) {
  return new Date(Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export function assignOzonBaskets(rows) {
  const regions = new Map();
  for (const r of rows) {
    if (r.platform !== "ozon" || !r.buyer || !r.region) continue;
    const k = `${r.buyer}|${r.orderDate}`;
    if (!regions.has(k)) regions.set(k, new Set());
    regions.get(k).add(r.region);
  }
  const bad = new Set();
  for (const [k, s] of regions) if (s.size >= ANOMALY_REGIONS_PER_DAY) bad.add(k.slice(0, k.indexOf("|")));
  return rows.map((r) => {
    if (r.platform !== "ozon" || !r.buyer) return r;
    const anomalous = bad.has(r.buyer);
    return { ...r, buyerAnomalous: anomalous, basket: anomalous ? r.orderNumber : `${r.buyer}|${r.orderDate}` };
  });
}

// «Не выкуплен покупателем»: невыкуп/возврат либо отмена не по вине Ozon/продавца (в т.ч. без причины).
function ozBuyerDropped(r, asOf) {
  if (r.selfBuyout) return false;
  const b = classifyRow(r, asOf);
  if (b === "refused" || b === "returned") return true;
  if (r.status !== OZ_CANCELLED) return false;
  return !startsWithAny(String(r.cancelReason || "").trim().toLowerCase(), OZ_OZONSIDE_REASON_PREFIXES);
}

const byDateThenSrid = (rows) => (a, b) =>
  rows[a].orderDate < rows[b].orderDate ? -1 : rows[a].orderDate > rows[b].orderDate ? 1
    : String(rows[a].srid) < String(rows[b].srid) ? -1 : String(rows[a].srid) > String(rows[b].srid) ? 1 : 0;

export function tagReorders(rows, asOf, windowDays = REORDER_WINDOW_DAYS) {
  const groups = new Map();
  rows.forEach((r, i) => {
    if (r.platform !== "ozon" || !r.buyer || r.buyerAnomalous || r.selfBuyout) return;
    const k = `${r.buyer}|${r.modelKey}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const to = new Map(), from = new Map();
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    idx.sort(byDateThenSrid(rows));
    for (const ia of idx) {
      const a = rows[ia];
      if (!ozBuyerDropped(a, asOf)) continue;
      const limit = shiftDate(a.orderDate, windowDays);
      const ib = idx.find((j) => rows[j].orderDate > a.orderDate && rows[j].orderDate <= limit && rows[j].variantKey !== a.variantKey);
      if (ib == null) continue;
      to.set(ia, rows[ib].srid);
      if (!from.has(ib)) from.set(ib, a.srid);
    }
  }
  return rows.map((r, i) => {
    const reorderTo = to.get(i), reorderFrom = from.get(i);
    if (reorderTo == null && reorderFrom == null) return r;
    return { ...r, reorderTo: reorderTo ?? null, reorderFrom: reorderFrom ?? null,
      fit: !r.fit || r.fit === "single" ? "fit_reorder" : r.fit };
  });
}

// rows — строки периода (после фильтра категорий), allRows — все загруженные (B может быть за периодом).
export function reorderSummary(rows, allRows, asOf) {
  const bySrid = new Map(allRows.map((r) => [r.srid, r]));
  let dropped = 0, pairs = 0, bResolved = 0, bSold = 0;
  const byModel = new Map();
  for (const a of rows) {
    if (a.platform !== "ozon" || !a.buyer || a.buyerAnomalous || !ozBuyerDropped(a, asOf)) continue;
    dropped += 1;
    const b = a.reorderTo != null ? bySrid.get(a.reorderTo) : null;
    if (!b) continue;
    pairs += 1;
    const bb = classifyRow(b, asOf);
    const resolvedB = bb === "sold" || bb === "refused" || bb === "returned";
    if (resolvedB) bResolved += 1;
    if (bb === "sold") bSold += 1;
    const c = (a.colorKey ?? "") !== (b.colorKey ?? "");
    const s = !!a.sizeKey && !!b.sizeKey && a.sizeKey !== b.sizeKey;
    const dir = c && s ? "mixed" : s ? (sortSizes([a.sizeLabel, b.sizeLabel])[0] === a.sizeLabel ? "sizeUp" : "sizeDown") : "color";
    const mk = `ozon|${a.modelKey}`;
    let m = byModel.get(mk);
    if (!m) byModel.set(mk, (m = { platform: "ozon", modelKey: a.modelKey, name: a.name, pairs: 0, sizeUp: 0, sizeDown: 0,
      color: 0, mixed: 0, bSold: 0, bResolved: 0, combos: new Map() }));
    if (!m.name && a.name) m.name = a.name;
    m.pairs += 1;
    m[dir] += 1;
    if (resolvedB) m.bResolved += 1;
    if (bb === "sold") m.bSold += 1;
    const combo = `${a.article || a.sizeLabel} → ${b.article || b.sizeLabel}`;
    m.combos.set(combo, (m.combos.get(combo) || 0) + 1);
  }
  return {
    dropped, pairs, reorderShare: pctOf(pairs, dropped), bResolved, bBuyoutPct: pctOf(bSold, bResolved),
    byModel: [...byModel.values()]
      .map((m) => ({ ...m, bBuyoutPct: pctOf(m.bSold, m.bResolved),
        combos: [...m.combos].map(([combo, n]) => ({ combo, n })).sort((x, y) => y.n - x.n || (x.combo < y.combo ? -1 : x.combo > y.combo ? 1 : 0)) }))
      .sort((x, y) => y.pairs - x.pairs),
  };
}
```

`OZ_CANCELLED`, `startsWithAny`, `OZ_OZONSIDE_REASON_PREFIXES`, `DAY`, `classifyRow`, `sortSizes`, `round2` уже объявлены выше в файле. Если тест чего-то не ждёт из-за порядка `combos` или цифр — сверить с правилами спеки; при расхождении правила и теста сообщить DONE_WITH_CONCERNS, не меняя правило.

- [ ] **Step 3:** `node --test lib/__tests__/buyout.test.mjs` → все PASS (старые тоже, всего 34 + 10).

- [ ] **Step 4: Commit**

```bash
git add lib/buyout.js lib/__tests__/buyout.test.mjs
git commit -m "feat(buyout): корзина по покупателю Ozon и перезаказы (чистые функции)"
```

---

### Task 2: Загрузчик, роут, страница

**Files:**
- Modify: `lib/buyoutData.js` (`loadOzonBuyoutRows`)
- Modify: `app/api/cabinets/[id]/buyout/route.js`
- Modify: `app/cabinets/[id]/buyout/BuyoutPage.jsx`

**Interfaces:**
- Consumes (Task 1): `assignOzonBaskets`, `tagReorders`, `reorderSummary`, `shiftDate`, `REORDER_WINDOW_DAYS`, `FIT_VALUES` (с `reorder`).
- Produces: ответ периода `{ ..., reorders }`.

- [ ] **Step 1: Загрузчик** (бэкап). В CTE `o` добавить `region`; в итоговый SELECT — `o.region`; в `rows.map` (поле `basket` оставить как есть — номер заказа; его заменит `assignOzonBaskets` в роуте, прочие потребители загрузчика не меняются):

```js
    buyer: String(r.posting_number).split("-")[0], // покупатель — наблюдение пробы 20.10.2026, см. lib/buyout.js
    orderNumber: ozonBasket(r.posting_number),
    region: r.region || null,
```

- [ ] **Step 2: Роут** (бэкап). Импорт дополнить `assignOzonBaskets, tagReorders, reorderSummary, shiftDate, REORDER_WINDOW_DAYS`. В шапку комментария: `// Перезаказы и корзина по покупателю Ozon (20.10.2026, спека 2026-10-20-buyout-reorders-design.md): грузим окно ±REORDER_WINDOW_DAYS, размечаем корзины/примерки/перезаказы по всем строкам, в когорту — только from..to; reorders — сводка перезаказов (Ozon).`

Добавить перед `export const GET`:

```js
// Окно с запасом ±REORDER_WINDOW_DAYS: перезаказ на границе периода не теряется; в когорту — только from..to.
async function loadTagged(platform, from, to, asOf) {
  const extTo = shiftDate(to, REORDER_WINDOW_DAYS) < asOf ? shiftDate(to, REORDER_WINDOW_DAYS) : asOf;
  const ext = await loadBuyoutRows(platform, shiftDate(from, -REORDER_WINDOW_DAYS), extTo);
  const all = tagReorders(tagFitting(assignOzonBaskets(ext)), asOf);
  return { all, period: all.filter((r) => r.orderDate >= from && r.orderDate <= to) };
}
```

Series-ветка: `const { period } = await loadTagged(platform, from, asOf, asOf); const rows = filterByFitting(filterByCategory(period, cats), fit);`

Period-ветка:

```js
    const { all, period } = await loadTagged(platform, from, to, asOf);
    const categories = categoryFacets(period);
    const byCat = filterByCategory(period, cats);
    const fitting = fittingSummary(byCat, asOf);
    const reorders = reorderSummary(byCat, all, asOf);
    const { kpi, items } = aggregateBuyout(filterByFitting(byCat, fit), asOf);
```
и `reorders` в JSON ответа (рядом с `fitting`).

- [ ] **Step 3: Страница** (бэкап).
- `FITS`: добавить `{ v: "reorder", l: "Перезаказы" }` последним.
- Подсказку переключателя дополнить: «; «Перезаказы» — не выкупил и в течение 7 дней заказал другой вариант (только Ozon)».
- Плитка «Примерки»: в `sub` дописать `` ` · перезаказов ${num(data.reorders?.pairs)}` ``.
- В пояснительный абзац про примерки дописать: «Ozon: корзина — покупатель за день (покупатель определяется по номеру заказа — это наблюдение, а не официальное поле Ozon); «Перезаказ» — не выкупил и в течение 7 дней заказал другой размер или цвет той же модели. У WB покупателя не видно — только корзина.»
- После `FitSizeBlock` (та же условная форма): `{data?.reorders?.pairs ? <ReorderBlock r={data.reorders} /> : null}` и компонент:

```jsx
function ReorderBlock({ r }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", marginBottom: 16 }}>
      <div style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Перезаказы (Ozon): {num(r.pairs)}
      </div>
      <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>
        После {pct(r.reorderShare)} невыкупленных заказов Ozon покупатель в течение 7 дней заказал другой вариант той же модели;
        второй вариант выкупают в {pct(r.bBuyoutPct)} случаев.
      </div>
      {open ? (
        <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 8 }}>
          <thead><tr>
            <th style={{ ...th, textAlign: "left", cursor: "default" }}>Модель</th>
            {["Перезаказов", "В больший", "В меньший", "Другой цвет", "Смешанные", "Второй выкуплен"].map((h) => <th key={h} style={{ ...th, cursor: "default" }}>{h}</th>)}
            <th style={{ ...th, textAlign: "left", cursor: "default" }}>Что на что меняют</th>
          </tr></thead>
          <tbody>{r.byModel.map((m) => (
            <tr key={m.modelKey}>
              <td style={{ ...td, textAlign: "left", whiteSpace: "normal" }}>{m.name || m.modelKey}</td>
              <td style={td}>{num(m.pairs)}</td><td style={td}>{num(m.sizeUp)}</td><td style={td}>{num(m.sizeDown)}</td>
              <td style={td}>{num(m.color)}</td><td style={td}>{num(m.mixed)}</td><td style={td}>{pct(m.bBuyoutPct)}</td>
              <td style={{ ...td, textAlign: "left", whiteSpace: "normal", color: C.muted }}>{m.combos.slice(0, 4).map((c) => `${c.combo} ×${c.n}`).join(" · ")}</td>
            </tr>))}</tbody>
        </table>
      ) : null}
      {open ? <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>Чаще перезаказывают в больший — модель маломерит, в меньший — большемерит.</div> : null}
    </div>
  );
}
```

- [ ] **Step 4: Проверка.** `node --test lib/__tests__/buyout.test.mjs` → PASS; `cd /opt/agents/saas && npm run build && systemctl restart saas-web` → 200 на `http://127.0.0.1:3200/`; `node scripts/smoke-buyout.mjs 1` → ALL PASS (в т.ч. «Сводка = страница»; существующая проверка «размеры + цвета + смешанные = примерки» теперь ДОЛЖНА упасть на Ozon/all — это ожидаемо, её обновит Task 3; если упала только она — продолжать, указать в отчёте). Живая сводка: один запрос `buyout?platform=ozon` через смоук-механику (или node-скрипт как в Task 3 прошлого плана) — записать в отчёт `reorders.pairs`, `reorderShare`, `bBuyoutPct`, топ-модель.

- [ ] **Step 5: Commit**

```bash
git add lib/buyoutData.js "app/api/cabinets/[id]/buyout/route.js" "app/cabinets/[id]/buyout/BuyoutPage.jsx"
git commit -m "feat(buyout): корзина Ozon по покупателю за день, фильтр и блок «Перезаказы»"
```

---

### Task 3: Смоук и документация

**Files:**
- Modify: `scripts/smoke-buyout.mjs` (блок «примерки», ~стр. 136–149)
- Modify: `docs/metrics-contract.md` (§18.5 — новый подпункт после текущего текста §18.5)
- Modify: `AGENTS.md` (пункт «Процент выкупа», после предложения про разрез fit)

- [ ] **Step 1: Смоук.** В блоке примерок: список запросов дополнить `reorder`, инвариант — `sz + c + m + r = f`:

```js
  const [a, s, f, sz, c, m, r] = await Promise.all(['all', 'single', 'fitting', 'size', 'color', 'mixed', 'reorder'].map(g));
  ...
  const bad2 = K.filter((k) => sz.kpi[k] + c.kpi[k] + m.kpi[k] + r.kpi[k] !== f.kpi[k]);
  check(`примерки ${plat}: размеры + цвета + смешанные + перезаказы = примерки`, bad2.length === 0, bad2);
  check(`перезаказы ${plat}: сводка есть`, a.reorders && Number.isFinite(a.reorders.pairs), a.reorders);
  if (plat === 'wb') check('перезаказы wb: пусто (у WB нет покупателя)', a.reorders.pairs === 0 && a.reorders.dropped === 0, a.reorders);
  console.log(`      ${plat}: перезаказов ${a.reorders?.pairs} из ${a.reorders?.dropped} невыкупленных (${a.reorders?.reorderShare} %), второй выкуплен ${a.reorders?.bBuyoutPct} %`);
```

Run: `node scripts/smoke-buyout.mjs 1` → ALL PASS.

- [ ] **Step 2: Контракт §18.5** — подпункт «Корзина по покупателю Ozon и перезаказы (20.10.2026)»: определения из спеки `2026-10-20-buyout-reorders-design.md` (покупатель = первая часть номера — наблюдение пробы с цифрами 1153/1153 и 95 %/2,3 %; корзина = покупатель + день; аномалия 3+ регионов в день; «не выкуплен покупателем»; перезаказ ≤ 7 дн, тот же день — корзина; цепочки; `fit_reorder` в «Примерках», «Одиночные» = один вариант на покупателя в неделю; `fittingSummary` перезаказы не считает; окно ±7 дн; `reorderSummary` и его поля; только Ozon) + живые цифры из отчёта Task 2.

- [ ] **Step 3: AGENTS.md** — одно предложение: «Корзина Ozon с 20.10.2026 — покупатель (первая часть `posting_number`, наблюдение) + день; «Перезаказ» (`&fit=reorder`, `fit_reorder` входит в «Примерки»): не выкупил → ≤ 7 дн другой вариант той же модели; `assignOzonBaskets`/`tagReorders`/`reorderSummary` в `lib/buyout.js`, роут грузит окно ±7 дн; аномальные префиксы (3+ регионов за день) не склеиваются; спека `docs/superpowers/specs/2026-10-20-buyout-reorders-design.md`.»

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-buyout.mjs docs/metrics-contract.md AGENTS.md
git commit -m "docs+smoke(buyout): перезаказы и корзина по покупателю Ozon"
```
