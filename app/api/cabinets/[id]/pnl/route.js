// /api/cabinets/[id]/pnl — P&L (Сводка по прибыли) из PostgreSQL.
// Источник: wb_finance_report + ozon_order_costs.
// Поддержка: один период (period=YYYY-MM), произвольный диапазон
// (from/to), разбивка на отрезки (breakdown=week|month) как сегменты.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TAX_INCOME_RATE = 0.06;

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Расчёт P&L за произвольный диапазон [from, to] (YYYY-MM-DD).
// Возвращает { total, wb, ozon } с теми же полями, что раньше.
async function computePnl(from, to, mps) {
  const te = to + "T23:59:59";
  const fromTs = from + " 00:00:00";
  let wb = null, ozon = null;

  // WB P&L — из finance_report (диапазон по rr_dt).
  if (mps.includes("wb")) {
    const db = new DatabaseSync("wb", { readOnly: true });
    const f = await db.prepare(
      `SELECT
         SUM(CASE WHEN supplier_oper_name='Продажа' THEN retail_amount ELSE 0 END) AS sales,
         SUM(CASE WHEN supplier_oper_name='Возврат' THEN retail_amount ELSE 0 END) AS returns,
         SUM(CASE WHEN supplier_oper_name='Продажа' THEN ppvz_for_pay ELSE 0 END) AS forPaySales,
         SUM(CASE WHEN supplier_oper_name='Возврат' THEN ppvz_for_pay ELSE 0 END) AS forPayReturns,
         SUM(acquiring_fee) AS acquiring,
         SUM(delivery_rub)  AS logistics,
         SUM(ABS(CASE WHEN supplier_oper_name='Хранение' THEN additional_payment ELSE 0 END)) AS storage,
         SUM(CASE WHEN supplier_oper_name='Продажа' THEN quantity ELSE 0 END) AS qtySold
       FROM finance_report
       WHERE rr_dt >= ? AND rr_dt <= ?`
    ).get(fromTs, te);

    const costRow = await db.prepare(
      `SELECT COALESCE(SUM(s.quantity * CASE WHEN c.cost > 0 THEN c.cost ELSE 0 END), 0) AS v
       FROM finance_report s
       LEFT JOIN cogs c ON c.nm_id = s.nm_id
       WHERE s.supplier_oper_name = 'Продажа' AND s.nm_id > 0
         AND s.rr_dt >= ? AND s.rr_dt <= ?`
    ).get(fromTs, te);

    const sales = Number(f.sales) || 0;
    const returns = Number(f.returns) || 0;
    const netSales = sales - Math.abs(returns);
    const costRub = Number(costRow.v) || 0;
    const commission = netSales - (Number(f.forPaySales) - Math.abs(Number(f.forPayReturns))) - costRub;
    const tax = netSales * TAX_INCOME_RATE;

    wb = {
      sales,
      returns: Math.abs(returns),
      netSales,
      cost: costRub,
      commission: Math.max(0, commission),
      logistics: Number(f.logistics) || 0,
      acquiring: Number(f.acquiring) || 0,
      storage: Number(f.storage) || 0,
      tax,
      grossProfit: netSales - costRub - Math.max(0, commission) - (Number(f.logistics) || 0) - (Number(f.acquiring) || 0),
      netProfit: netSales - costRub - Math.max(0, commission) - (Number(f.logistics) || 0) - (Number(f.acquiring) || 0) - (Number(f.storage) || 0) - tax,
      qtySold: Number(f.qtySold) || 0,
      forPay: (Number(f.forPaySales) || 0) - Math.abs(Number(f.forPayReturns) || 0),
    };
  }

  // Ozon P&L — из order_costs (диапазон по sale_dt как TEXT).
  if (mps.includes("ozon")) {
    const db = new DatabaseSync("ozon", { readOnly: true });
    const f = await db.prepare(
      `SELECT
         COALESCE(SUM(cost_value_retail), 0) AS sales,
         COALESCE(SUM(cost), 0) AS cost,
         COALESCE(SUM(commission), 0) AS commission,
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(acquiring), 0) AS acquiring,
         COALESCE(SUM(profit), 0) AS profit,
         COUNT(*) AS qtySold
       FROM order_costs
       WHERE is_return = 0 AND sale_dt IS NOT NULL
         AND sale_dt >= ? AND sale_dt <= ?`
    ).get(fromTs, te);

    const sales = Number(f.sales) || 0;
    const costRub = Number(f.cost) || 0;
    const tax = sales * TAX_INCOME_RATE;

    ozon = {
      sales,
      returns: 0,
      netSales: sales,
      cost: costRub,
      commission: Number(f.commission) || 0,
      logistics: Number(f.logistics) || 0,
      acquiring: Number(f.acquiring) || 0,
      storage: 0,
      tax,
      grossProfit: sales - costRub - (Number(f.commission) || 0) - (Number(f.logistics) || 0) - (Number(f.acquiring) || 0),
      netProfit: Number(f.profit) || 0,
      qtySold: Number(f.qtySold) || 0,
      forPay: 0,
    };
  }

  // Объединение WB + Ozon.
  const total = { sales: 0, returns: 0, netSales: 0, cost: 0, commission: 0, logistics: 0, acquiring: 0, storage: 0, tax: 0, grossProfit: 0, netProfit: 0, qtySold: 0, forPay: 0 };
  for (const mp of [wb, ozon]) {
    if (!mp) continue;
    for (const k of Object.keys(total)) total[k] += mp[k] || 0;
  }
  total.margin = total.netSales > 0 ? Math.round((total.netProfit / total.netSales) * 10000) / 100 : 0;
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
  const { total, wb, ozon } = await computePnl(from, to, mps);

  // Разбивка на отрезки (если запросили).
  let segments = null;
  if (breakdown !== "none") {
    const ranges = splitRange(from, to, breakdown);
    segments = [];
    for (const r of ranges) {
      const res = await computePnl(r.from, r.to, mps);
      segments.push({ label: r.label, from: r.from, to: r.to, total: res.total });
    }
  }

  return NextResponse.json({ from, to, breakdown, period: periodQ, total, wb, ozon, segments });
});
