// /api/cabinets/[id]/pnl — P&L (Сводка по прибыли) из PostgreSQL.
// Источник: wb_finance_report + ozon_order_costs.
// Поддержка: один период (period=YYYY-MM), произвольный диапазон
// (from/to), разбивка на отрезки (breakdown=week|month) как сегменты.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { normalizeTaxMode, describeCombinedTaxMode } from "@/lib/tax.js";
import { ozProfitCabinet } from "@/lib/ozonMetrics.js";
import { wbProfitCabinet, wbRevenueGross } from "@/lib/wbMetrics.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const round2 = (v) => Math.round(((v || 0) + Number.EPSILON) * 100) / 100;

// Приводит ответ канона (ozProfitCabinet/wbProfitCabinet, lib/ozonMetrics.js
// /lib/wbMetrics.js — задачи 1-2 плана унификации прибыли) к форме строки P&L.
// grossProfit — справочный подытог ДО рекламы/налога/кабинетных статей (тот же
// смысл, что раньше: выручка минус прямые расходы уровня заказа). forPay — только
// у WB (canon.revenue = cost_value_pay, УЖЕ равен ppvz_for_pay «к перечислению»,
// см. worker/collectors/wb_order_costs.py:57); у Ozon такого понятия на этой
// странице исторически не было — 0, как и раньше.
// revenueGross (задача «WB валовая выручка справочной строкой», 2026-08-20,
// решение владельца) — АДДИТИВНОЕ справочное поле, ТОЛЬКО у WB: валовая
// выручка (Σ cost_value_retail, lib/wbMetrics.js:wbRevenueGross) для сверки
// с отчётами МП. Канон (revenue/profit = ppvz-нетто) не трогаем — это
// отдельное число рядом, не замена. У Ozon revenue уже валовая
// (см. докстроку lib/ozonMetrics.js) — поле не добавляется (undefined,
// TOTAL_NUM_KEYS суммирует как 0).
function mpBlock(c, isWb, revenueGross, platform) {
  return {
    revenue: c.revenue,
    ...(isWb ? { revenueGross } : {}),
    cogs: c.cogs,
    commission: c.commission,
    // services («Сборы Ozon» — задача 4 плана «Сборы Ozon», 2026-08-25):
    // расщеплено бэкфиллом (задачи 1-2) из logistics; отзывы, рассрочка,
    // упаковка, размещение, утилизация и прочие позаказные сборы. Только
    // у Ozon (c.services у WB не существует — undefined, ключ не пишется).
    ...(isWb ? {} : { services: c.services }),
    logistics: c.logistics,
    acquiring: c.acquiring,
    loyalty: c.loyalty,
    returnLogistics: c.returnLogistics,
    ads: c.ads,
    tax: c.tax,
    // costType (accrual_<N> у Ozon) — технический ключ канона, наружу не отдаём
    // (Global Constraint плана: «accrual_<N> не должен показываться сырым нигде
    // после задачи 4») — только русский label + знаковая сумма. platform
    // ('wb'|'ozon') — помета площадки для фильтрации и группировки.
    cabinetCosts: c.cabinetCosts.map((x) => ({ label: x.label, amount: x.amount, platform })),
    cabinetCostsTotal: round2(c.cabinetCosts.reduce((acc, x) => acc + x.amount, 0)),
    unknownCostTypes: c.unknownCostTypes,
    profit: c.profit,
    // grossProfit — из канона (ozProfitCabinet/wbProfitCabinet наследуют
    // profitGross от ozProfitProduct/wbProfitProduct через `...base`,
    // см. lib/ozonMetrics.js/lib/wbMetrics.js), задача 2 плана «канон
    // волна 2»; локальная формула-дубль удалена.
    grossProfit: c.profitGross,
    forPay: isWb ? c.revenue : 0,
  };
}

const TOTAL_NUM_KEYS = [
  "revenue", "cogs", "commission", "logistics", "acquiring", "loyalty",
  "returnLogistics", "ads", "tax", "unknownCostTypes", "profit",
  "grossProfit", "forPay", "cabinetCostsTotal",
  // revenueGross — только у WB-блока (mpBlock, isWb=true); Ozon-блок его не
  // отдаёт (undefined → 0 в сумме ниже), total.revenueGross = WB-часть.
  "revenueGross",
  // services («Сборы Ozon») — только у Ozon-блока (см. mpBlock); WB-блок его
  // не отдаёт (undefined → 0 в сумме), total.services = Ozon-часть.
  "services",
];

// Расчёт P&L за произвольный диапазон [from, to] (YYYY-MM-DD) — канон.
// Возвращает { total, wb, ozon }.
async function computePnl(from, to, mps, wbTax, ozonTax) {
  let wb = null, ozon = null;

  if (mps.includes("wb")) {
    const db = new DatabaseSync("wb", { readOnly: true });
    // Последовательно (не Promise.all) — один db делит соединение из
    // AsyncLocalStorage (lib/db.js), конкурентные запросы на нём не гарантия.
    const c = await wbProfitCabinet(db, wbTax, { from, to });
    const revenueGross = await wbRevenueGross(db, { from, to });
    wb = mpBlock(c, true, revenueGross, "wb");
  }
  if (mps.includes("ozon")) {
    const db = new DatabaseSync("ozon", { readOnly: true });
    ozon = mpBlock(await ozProfitCabinet(db, ozonTax, { from, to }), false, undefined, "ozon");
  }

  // Объединение WB + Ozon.
  const total = {};
  for (const k of TOTAL_NUM_KEYS) total[k] = 0;
  const cabinetCosts = [];
  for (const mp of [wb, ozon]) {
    if (!mp) continue;
    for (const k of TOTAL_NUM_KEYS) total[k] += mp[k] || 0;
    cabinetCosts.push(...mp.cabinetCosts);
  }
  for (const k of TOTAL_NUM_KEYS) if (k !== "unknownCostTypes") total[k] = round2(total[k]);
  total.cabinetCosts = cabinetCosts;
  total.margin = total.revenue > 0 ? round2((total.profit / total.revenue) * 10000) / 100 : 0;
  return { total, wb, ozon };
}

// Разбить [from, to] на календарные отрезки. gran='month' → месяцы,
// 'week' → недели (пн-вс). Возвращает [{label, from, to}].
function splitRange(from, to, gran) {
  const [Y, M, D] = from.split("-").map(Number);
  const start = new Date(Y, M - 1, D);
  const [Y2, M2, D2] = to.split("-").map(Number);
  const end = new Date(Y2, M2 - 1, D2);
  const segs = [];
  const fmtMon = (d) => d.toLocaleDateString("ru-RU", { month: "short", year: "2-digit" });
  const fmtRu = (d) => d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });

  if (gran === "month") {
    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const s = new Date(cur);
      const e = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const fs = s < start ? start : s;
      const fe = e > end ? end : e;
      segs.push({ label: fmtMon(cur), from: ymd(fs), to: ymd(fe) });
      cur.setMonth(cur.getMonth() + 1);
    }
  } else {
    // week: пн-вс. Начинаем с понедельника, содержащего/до start.
    const cur = new Date(start);
    const wd = (cur.getDay() + 6) % 7; // 0=пн
    cur.setDate(cur.getDate() - wd);
    while (cur <= end) {
      const s = new Date(cur);
      const e = new Date(cur);
      e.setDate(s.getDate() + 6);
      const fs = s < start ? start : s;
      const fe = e > end ? end : e;
      segs.push({ label: fmtRu(s), from: ymd(fs), to: ymd(fe) });
      cur.setDate(cur.getDate() + 7);
    }
  }
  return segs;
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mps = cabinet.marketplaces || ["wb", "ozon"];

  // Налоговый режим на каждый МП (per shop / per legal entity).
  const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
  const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);

  // Параметры периода. Приоритет: from/to (диапазон), иначе period (один месяц).
  const breakdown = url.searchParams.get("breakdown") || "none"; // none|week|month
  let from = url.searchParams.get("from") || "";
  let to = url.searchParams.get("to") || "";
  const periodQ = url.searchParams.get("period") || "";

  if (!from || !to) {
    // Обратная совместимость: period=YYYY-MM → один месяц.
    const period = periodQ || new Date().toISOString().slice(0, 7);
    from = period + "-01";
    to = ymd(new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0));
  }

  // Общий итог диапазона.
  const { total, wb, ozon } = await computePnl(from, to, mps, wbTax, ozonTax);

  // Разбивка на отрезки (если запросили).
  let segments = null;
  if (breakdown !== "none") {
    const ranges = splitRange(from, to, breakdown);
    segments = [];
    for (const r of ranges) {
      const res = await computePnl(r.from, r.to, mps, wbTax, ozonTax);
      segments.push({ label: r.label, from: r.from, to: r.to, total: res.total });
    }
  }

  return NextResponse.json({ from, to, breakdown, period: periodQ, total, wb, ozon, segments,
    taxLabel: describeCombinedTaxMode(cabinet.shopTax, { short: true }),
  });
});
