// lib/__tests__/wbDayProfit.test.mjs — композиция дня WB после переезда
// канона на «выручку по цене со скидкой продавца» (план 2026-09-06,
// docs/superpowers/specs/2026-09-06-wb-revenue-by-price-design.md).
//
// Что фиксируем:
//   • WB_TAX_BASE === "realized" — налоговая база WB = «реализовано»
//     (Σ cost_value_retail), а НЕ выручка по цене со скидкой и не payout.
//   • расходы для УСН Доходы−Расходы включают НЕТТО-вознаграждение WB
//     (agg.commission = realized − payout) — оно реально вычитается из
//     realized при переходе к payout, значит это расход для базы.
//   • структура прибыли не меняется: profit = rawProfit − ads − tax.
//
// Числа agg — «синтетический день» из спеки (цена со скидкой 2 835,
// реализовано 1 990 после СПП, к перечислению 1 437,12):
//   spp = 2835 − 1990 = 845; commission = 1990 − 1437,12 = 552,88;
//   rawProfit = payout − cogs − logistics = 1437,12 − 600 − 80 = 757,12.
import test from "node:test";
import assert from "node:assert/strict";
import { wbDayProfit, WB_TAX_BASE } from "../wbMetrics.js";
import { calcTotalTax } from "../tax.js";

const agg = {
  revenue: 2835, realized: 1990, payout: 1437.12, spp: 845, commission: 552.88,
  cogs: 600, logistics: 80, rawProfit: 757.12, acquiring: 0, loyalty: 0,
};

const round2 = (v) => Math.round((v || 0) * 100) / 100;

test("тождества агрегата дня: revenue − spp − commission = payout, rawProfit = payout − cogs − logistics", () => {
  assert.equal(round2(agg.revenue - agg.spp - agg.commission), agg.payout);
  assert.equal(round2(agg.payout - agg.cogs - agg.logistics), agg.rawProfit);
});

test("налоговая база — реализовано, УСН 6%", () => {
  assert.equal(WB_TAX_BASE, "realized");
  const p = wbDayProfit(agg, 50, { type: "usn_income", rate: 6, vat: 0 });
  // profit = rawProfit − ads − 6% × realized (НЕ × revenue и НЕ × payout)
  assert.equal(p, round2(757.12 - 50 - 1990 * 0.06));
  // контроль: база именно realized — на revenue/payout числа другие
  assert.notEqual(p, round2(757.12 - 50 - 2835 * 0.06));
  assert.notEqual(p, round2(757.12 - 50 - 1437.12 * 0.06));
});

test("УСН Д−Р: расходы включают нетто-вознаграждение WB", () => {
  const taxMode = { type: "usn_income_expenses", rate: 15, vat: 0 };
  const expenses = 600 + 80 + 50 + 552.88; // cogs + logistics + ads + commission
  // Ожидание считаем той же функцией (в calcUsnTax есть пол «минимальный
  // налог 1%» — хардкод числа его бы не учёл), но фиксируем и сам результат:
  // 15% × (1990 − 1282,88) = 106,07 ₽ > минимального 19,90 ₽.
  const expectedTax = calcTotalTax(taxMode, 1990, expenses).total;
  assert.equal(expectedTax, 106.07);
  const p = wbDayProfit(agg, 50, taxMode);
  assert.equal(p, round2(757.12 - 50 - expectedTax));
  // контроль: без commission в расходах налог был бы заметно больше
  assert.notEqual(p, round2(757.12 - 50 - calcTotalTax(taxMode, 1990, 600 + 80 + 50).total));
});
