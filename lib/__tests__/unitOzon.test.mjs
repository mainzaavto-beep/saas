// lib/__tests__/unitOzon.test.mjs — Ozon-модель юнит-экономики уровня WB
// (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §2).
import test from "node:test";
import assert from "node:assert/strict";
import { calcOzon, COLUMNS_OZON } from "../unit.js";

const base = {
  priceOzon: 1800, discount: 0, boost: 0.3,
  commissionRate: 0.47, acquiringRate: 0.008,
  buyout: 10 / 12, logisticsFbo: 100, returnLogistics: 150,
  adsRate: 0.1, cost: 500, defectRate: 0,
  usnRate: 0.06, vatRate: 5 / 105,
};

test("тождество логистики: при фактических F, R, b логистика = Σлогистики окна / продано", () => {
  // окно: продано 10, невыкупов 2; Σлог(продано) = 1000 → F = 100; Σлог(невыкупы) = 300 → R = 150; b = 10/12
  const r = calcOzon(base);
  assert.equal(r.logistics, 130); // (1000 + 300) / 10
});

test("галочка «с % выкупа» OFF (b = 1) → логистика = F", () => {
  const r = calcOzon({ ...base, buyout: 1 });
  assert.equal(r.logistics, 100);
});

test("buyout не задан → как b = 1 (без деления на ноль)", () => {
  const r = calcOzon({ ...base, buyout: undefined });
  assert.equal(r.logistics, 100);
});

test("комиссия, эквайринг, реклама — от цены продавца с НДС; УСН — от выручки без НДС", () => {
  const r = calcOzon({ ...base, discount: 0.1 }); // priceSell = 1620
  assert.equal(r.priceSell, 1620);
  assert.equal(r.commission, 761.4);          // 1620 × 0.47
  assert.equal(r.acquiring, 12.96);           // 1620 × 0.008
  assert.equal(r.ads, 162);                   // 1620 × 0.10
  assert.equal(r.vat, Math.round(1620 * 5 / 105 * 100) / 100);
  assert.equal(r.usn, Math.round((1620 - 1620 * 5 / 105) * 0.06 * 100) / 100);
});

test("прибыль и маржа: маржа от priceSell, как у WB", () => {
  const r = calcOzon(base);
  const vat = 1800 * 5 / 105;
  const usn = (1800 - vat) * 0.06;
  const expected = 1800 - vat - usn - 1800 * 0.47 - 1800 * 0.008 - 130 - 180 - 500;
  assert.equal(r.profit, Math.round(expected * 100) / 100);
  assert.equal(r.margin, Math.round((expected / 1800) * 10000) / 10000);
});

test("соинвест: priceBuyer = priceSell × (1 − boost); boost = null → priceBuyer = null, расчёт не ломается", () => {
  assert.equal(calcOzon(base).priceBuyer, 1260);
  const r = calcOzon({ ...base, boost: null });
  assert.equal(r.boost, null);
  assert.equal(r.priceBuyer, null);
  assert.ok(Number.isFinite(r.profit));
});

test("брак — зеркало WB, маржа с браком от priceSell", () => {
  const r = calcOzon({ ...base, defectRate: 0.1 });
  assert.equal(r.profitWithDefect, Math.round((r.profit - 50) * 100) / 100);
  assert.equal(r.marginWithDefect, Math.round((r.profitWithDefect / 1800) * 10000) / 10000);
});

test("идемпотентность: повторный прогон на округлённых выходах не меняет прибыль", () => {
  const r1 = calcOzon(base);
  const r2 = calcOzon(r1);
  assert.equal(r2.profit, r1.profit);
});

test("идемпотентность на реалистичных дробных ставках факта (round4 бил её на acquiringRate)", () => {
  const input = { ...base, acquiringRate: 0.0081634, buyout: 10 / 12, commissionRate: 0.4010364 };
  const r1 = calcOzon(input);
  const r2 = calcOzon(r1);
  assert.equal(r2.profit, r1.profit);
  assert.equal(r2.margin, r1.margin);
});

test("округление эха: logisticsFbo/returnLogistics/priceFact — 2 знака, acquiringRate — 6", () => {
  const r = calcOzon({ ...base, acquiringRate: 0.0081634, logisticsFbo: 100.126, returnLogistics: 150.784, priceFact: 1799.999 });
  assert.equal(r.logisticsFbo, 100.13);
  assert.equal(r.returnLogistics, 150.78);
  assert.equal(r.priceFact, 1800);
  assert.equal(r.acquiringRate, 0.008163);
});

test("COLUMNS_OZON содержит новые колонки в нужном порядке", () => {
  const keys = COLUMNS_OZON.map((c) => c.key);
  const want = ["priceOzon", "priceFact", "boost", "priceBuyer", "acquiringRate", "acquiring", "buyout", "logisticsFbo", "returnLogistics", "logistics", "margin"];
  for (const k of want) assert.ok(keys.includes(k), `нет колонки ${k}`);
  assert.ok(keys.indexOf("buyout") < keys.indexOf("logisticsFbo"));
  assert.ok(keys.indexOf("returnLogistics") < keys.indexOf("logistics"));
});
