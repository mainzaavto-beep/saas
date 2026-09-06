// lib/__tests__/wbCanonShape.test.mjs — маппер агрегата WB (wbAggRow) и
// тождества канона на подставном db, БЕЗ обращения к боевой БД.
//
// Что фиксируем (план 2026-09-06 «выручка WB по цене со скидкой продавца»):
//   spp = revenue − realized; commission = realized − payout (НЕТТО, а не
//   отчётная колонка); acquiring = loyalty = 0; отчётные суммы доезжают
//   как commissionReport/acquiringReport/loyaltyReport; тождества
//   revenue − spp − commission = payout и profitGross = rawProfit.
//
// Строки-заготовки повторяют форму SELECT канона (WB_AGG_FIELDS):
//   • обычная продажа: цена со скидкой 2 835, реализовано 1 990 (СПП 845),
//     к перечислению 1 437,12; отчётные комиссия/эквайринг/лояльность
//     НАРОЧНО не равны нетто-вознаграждению 552,88 — так и в бою
//     (разложение отчёта не сходится), тест обязан их не перепутать;
//   • возврат: выручка/реализовано/к перечислению обнулены сборщиком,
//     остаётся логистика 55 ₽ и rawProfit = −55 ₽.
import test from "node:test";
import assert from "node:assert/strict";
import {
  wbProfitProduct, wbProfitProductBatch, wbDayProfit, WB_TAX_BASE,
} from "../wbMetrics.js";

const SALE = {
  nm_id: 1, d: "2026-07-01",
  revenue: 2835, realized: 1990, payout: 1437.12,
  cogs: 600, logistics: 80, rawProfit: 757.12, retLogistics: 0,
  commissionReport: 300, acquiringReport: 25, loyaltyReport: 10,
};
const RETURN = {
  nm_id: 2, d: "2026-07-02",
  revenue: 0, realized: 0, payout: 0,
  cogs: 0, logistics: 55, rawProfit: -55, retLogistics: 55,
  commissionReport: 0, acquiringReport: 0, loyaltyReport: 0,
};
const ROWS = [SALE, RETURN];
const SUM_KEYS = [
  "revenue", "realized", "payout", "cogs", "logistics", "rawProfit",
  "retLogistics", "commissionReport", "acquiringReport", "loyaltyReport",
];
const round2 = (v) => Math.round((v || 0) * 100) / 100;

// Подставной db: prepare() смотрит на текст SQL и отдаёт заготовки.
// daily_metrics — реклама (wbAdTotal), иначе — агрегат order_costs;
// GROUP BY nm_id → batch-форма, GROUP BY substr(...) → по дням.
function makeDb({ ads = {} } = {}) {
  const sqlSeen = [];
  const total = () => {
    const acc = { };
    for (const k of SUM_KEYS) acc[k] = round2(ROWS.reduce((a, r) => a + r[k], 0));
    return acc;
  };
  return {
    sqlSeen,
    prepare(sql) {
      sqlSeen.push(sql);
      const isAd = sql.includes("daily_metrics");
      const byNm = sql.includes("GROUP BY nm_id");
      const byDay = sql.includes("GROUP BY substr");
      return {
        get: () => (isAd
          ? { s: Object.values(ads).reduce((a, b) => a + b, 0) }
          : total()),
        all: () => {
          if (isAd) return Object.entries(ads).map(([nm_id, s]) => ({ nm_id: Number(nm_id), s }));
          if (byNm) return ROWS.map((r) => ({ ...r }));
          if (byDay) return ROWS.map((r) => ({ ...r }));
          return [total()];
        },
      };
    },
  };
}

const PERIOD = { from: "2026-07-01", to: "2026-07-31" };
const TAX = { type: "usn_income", rate: 6, vat: 0 };

test("wbProfitProduct: маппер считает spp/нетто-commission, отчётные поля отдельно", async () => {
  const p = await wbProfitProduct(makeDb(), TAX, PERIOD, null);

  // суммы прямо из заготовок
  assert.equal(p.revenue, 2835);
  assert.equal(p.realized, 1990);
  assert.equal(p.payout, 1437.12);
  assert.equal(p.logistics, 135);   // 80 продажи + 55 возврата
  assert.equal(p.returnLogistics, 55);
  assert.equal(p.rawProfit, 702.12); // 757,12 − 55

  // производные маппера
  assert.equal(p.spp, round2(p.revenue - p.realized), "spp = revenue − realized");
  assert.equal(p.spp, 845);
  assert.equal(p.commission, round2(p.realized - p.payout), "commission = realized − payout");
  assert.equal(p.commission, 552.88);
  assert.equal(p.acquiring, 0);
  assert.equal(p.loyalty, 0);

  // отчётные суммы — СПРАВОЧНО, не перепутаны с нетто-вознаграждением
  assert.equal(p.commissionReport, 300);
  assert.equal(p.acquiringReport, 25);
  assert.equal(p.loyaltyReport, 10);
  assert.notEqual(p.commission, p.commissionReport);
});

test("wbProfitProduct: тождества канона", async () => {
  const p = await wbProfitProduct(makeDb(), TAX, PERIOD, null);
  assert.equal(round2(p.revenue - p.spp - p.commission), p.payout,
    "revenue − spp − commission = payout");
  assert.ok(Math.abs(p.profitGross - p.rawProfit) < 0.01,
    `profitGross (${p.profitGross}) = rawProfit (${p.rawProfit})`);
  assert.equal(p.profitGross,
    round2(p.revenue - p.spp - p.commission - p.cogs - p.logistics));
  // структура прибыли: rawProfit − ads − tax
  assert.equal(p.profit, round2(p.rawProfit - p.ads - p.tax));
  // налог на базе realized (WB_TAX_BASE), реклама 0
  assert.equal(WB_TAX_BASE, "realized");
  assert.equal(p.ads, 0);
  assert.equal(p.tax, round2(1990 * 0.06));
});

test("wbProfitProductBatch: та же форма и те же тождества по каждому товару", async () => {
  const byNm = await wbProfitProductBatch(makeDb({ ads: {} }), TAX, PERIOD);
  assert.deepEqual([...byNm.keys()].sort(), [1, 2]);

  const sale = byNm.get(1);
  assert.equal(sale.revenue, 2835);
  assert.equal(sale.spp, 845);
  assert.equal(sale.commission, 552.88);
  assert.equal(sale.acquiring, 0);
  assert.equal(sale.loyalty, 0);
  assert.equal(sale.commissionReport, 300);
  assert.ok(Math.abs(sale.profitGross - sale.rawProfit) < 0.01);
  assert.equal(round2(sale.revenue - sale.spp - sale.commission), sale.payout);

  // возврат: выручки нет, убыток = логистика, налога нет (база 0)
  const ret = byNm.get(2);
  assert.equal(ret.revenue, 0);
  assert.equal(ret.spp, 0);
  assert.equal(ret.commission, 0);
  assert.equal(ret.rawProfit, -55);
  assert.ok(Math.abs(ret.profitGross - ret.rawProfit) < 0.01);
  assert.equal(ret.tax, 0);
  assert.equal(ret.profit, -55);
});

test("wbDayProfit на том же агрегате согласован с wbProfitProduct", async () => {
  const p = await wbProfitProduct(makeDb(), TAX, PERIOD, null);
  assert.equal(wbDayProfit(p, 0, TAX), p.profit);
});
