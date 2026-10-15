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
