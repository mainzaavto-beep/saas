// lib/__tests__/wbCabinetCosts.test.mjs — wbProfitCabinet: оплата рекламы
// удержанием WB («WB Продвижение», cost_type='promotion') НЕ входит в
// прибыль — реклама WB уже вычтена по кампаниям (daily_metrics.ad_spend).
// Решение владельца 12.10.2026, docs/metrics-contract.md §19.
//
// Подставной db, БЕЗ боевой БД: cabinet_costs — сырые суммы в нативном знаке
// WB (расход > 0, возмещение < 0), остальное — минимальный агрегат
// order_costs (одна продажа) и реклама кампаний.
import test from "node:test";
import assert from "node:assert/strict";
import { wbProfitProduct, wbProfitCabinet, WB_COST_INFO_ONLY } from "../wbMetrics.js";
import { ozProfitCabinet } from "../ozonMetrics.js";

const AGG = {
  revenue: 2835, realized: 1990, payout: 1437.12,
  cogs: 600, logistics: 80, rawProfit: 757.12, retLogistics: 0,
  commissionReport: 300, acquiringReport: 25, loyaltyReport: 10,
};
// Сырой знак WB: storage/promotion — расходы (>0), transport_compensation —
// возмещение (<0).
const COSTS = [
  { cost_type: "promotion", s: 14647 },
  { cost_type: "storage", s: 78.46 },
  { cost_type: "transport_compensation", s: -347.3 },
];
const ADS = 2335.69;

function makeDb(costs = COSTS) {
  return {
    prepare(sql) {
      const isCosts = sql.includes("cabinet_costs");
      const isAd = sql.includes("daily_metrics");
      return {
        get: () => (isAd ? { s: ADS } : { ...AGG }),
        all: () => {
          if (isCosts) return costs.map((r) => ({ ...r }));
          if (isAd) return [];
          return [{ ...AGG }];
        },
      };
    },
  };
}

const PERIOD = { from: "2026-10-11", to: "2026-10-11" };
const TAX = { type: "usn_income", rate: 6, vat: 0 };
const round2 = (v) => Math.round((v || 0) * 100) / 100;

test("WB_COST_INFO_ONLY: справочная только оплата рекламы удержанием", () => {
  assert.deepEqual([...WB_COST_INFO_ONLY], ["promotion"]);
});

test("wbProfitCabinet: promotion не входит в cabinetCosts и в profit", async () => {
  const base = await wbProfitProduct(makeDb(), TAX, PERIOD, null);
  const c = await wbProfitCabinet(makeDb(), TAX, PERIOD);

  assert.ok(!c.cabinetCosts.some((x) => x.costType === "promotion"),
    "promotion не должен попадать в cabinetCosts (иначе двойной счёт рекламы)");
  assert.deepEqual(c.cabinetCosts.map((x) => x.costType).sort(), ["storage", "transport_compensation"]);

  const sumCosts = c.cabinetCosts.reduce((a, x) => a + x.amount, 0);
  assert.equal(round2(sumCosts), round2(-78.46 + 347.3));
  assert.equal(c.profit, round2(base.profit + sumCosts),
    "profit = товарная прибыль (уже минус реклама кампаний) + Σ cabinetCosts без promotion");
  // реклама кампаний по-прежнему вычтена в товарной части
  assert.equal(c.ads, ADS);
});

test("wbProfitCabinet: promotion виден справочно в cabinetCostsInfo с канон-знаком", async () => {
  const c = await wbProfitCabinet(makeDb(), TAX, PERIOD);
  assert.equal(c.cabinetCostsInfo.length, 1);
  const p = c.cabinetCostsInfo[0];
  assert.equal(p.costType, "promotion");
  assert.equal(p.amount, -14647, "канон-знак: расход < 0");
  assert.ok(/удержани/i.test(p.label), `label про удержание: ${p.label}`);
  assert.ok(/уже учтен/i.test(p.note), `note про «уже учтено в рекламе»: ${p.note}`);
});

test("wbProfitCabinet: без promotion — cabinetCostsInfo пуст, profit прежний", async () => {
  const costs = COSTS.filter((r) => r.cost_type !== "promotion");
  const base = await wbProfitProduct(makeDb(costs), TAX, PERIOD, null);
  const c = await wbProfitCabinet(makeDb(costs), TAX, PERIOD);
  assert.deepEqual(c.cabinetCostsInfo, []);
  assert.equal(c.profit, round2(base.profit - 78.46 + 347.3));
});

test("ozProfitCabinet: единый контракт — cabinetCostsInfo есть и пуст", async () => {
  // Минимальный подставной db Ozon: пустые агрегаты и кабинетные статьи.
  const db = {
    prepare() {
      return { get: () => ({}), all: () => [] };
    },
  };
  const c = await ozProfitCabinet(db, TAX, PERIOD);
  assert.deepEqual(c.cabinetCostsInfo, []);
});
