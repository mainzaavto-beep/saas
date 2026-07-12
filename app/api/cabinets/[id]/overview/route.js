// /api/cabinets/[id]/overview — НАСТОЯЩИЙ overview из data-presenter (PostgreSQL+RLS).
// Полный перенос: все KPI, lossMakers, lowStock, noCogs.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import {
  wbFinancePeriod, wbOrdersCount, wbCancelCount, wbAdTotal, wbSold,
  USN_RATE,
} from "@/lib/wbMetrics.js";
import { ozOrderCostsAggregate, ozAdSpend } from "@/lib/ozonMetrics.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const zeroKpi = () => ({
  revenue: 0, sold: 0, commission: 0, logistics: 0, acquiring: 0, loyalty: 0,
  costRub: 0, adSp: 0, tax: 0, profit: 0, orders: 0, cancelCnt: 0,
  netPay: 0, storage: 0,
});

async function collectWb(db, from, to, toEnd) {
  const k = zeroKpi();
  const fin = await wbFinancePeriod(db, { from, to });
  k.revenue = fin.salesRub;
  k.commission = fin.commission;
  k.acquiring = fin.acquiring;
  k.logistics = fin.logistics;

  k.sold = Object.values(await wbSold(db, { from, to })).reduce((a, b) => a + b, 0);

  k.costRub = (await db.prepare(
    `SELECT COALESCE(SUM(s.quantity * CASE WHEN c.cost > 0 THEN c.cost ELSE NULL END),0) AS v
     FROM finance_report s LEFT JOIN cogs c ON c.nm_id = s.nm_id
     WHERE s.supplier_oper_name = 'Продажа' AND s.nm_id > 0
       AND s.rr_dt >= ? AND s.rr_dt <= ?`
  ).get(from, toEnd)).v || 0;

  k.adSp = await wbAdTotal(db, { from, to });

  const forPaySales = (await db.prepare(
    `SELECT COALESCE(SUM(ppvz_for_pay),0) AS v FROM finance_report
     WHERE supplier_oper_name = 'Продажа' AND rr_dt >= ? AND rr_dt <= ?`
  ).get(from, toEnd)).v;
  const forPayReturns = (await db.prepare(
    `SELECT COALESCE(SUM(ppvz_for_pay),0) AS v FROM finance_report
     WHERE supplier_oper_name = 'Возврат' AND rr_dt >= ? AND rr_dt <= ?`
  ).get(from, toEnd)).v;
  k.netPay = forPaySales - Math.abs(forPayReturns);

  k.storage = (await db.prepare(
    `SELECT COALESCE(SUM(ABS(additional_payment)),0) AS v FROM finance_report
     WHERE supplier_oper_name = 'Хранение' AND rr_dt >= ? AND rr_dt <= ?`
  ).get(from, toEnd)).v || 0;

  k.orders = await wbOrdersCount(db, { from, to });
  k.cancelCnt = await wbCancelCount(db, { from, to });

  k.tax = Math.round(k.revenue * USN_RATE * 100) / 100;
  k.profit = Math.round(
    (k.revenue - k.commission - k.acquiring - k.logistics - k.costRub - k.adSp - k.tax) * 100
  ) / 100;
  return k;
}

async function collectOzon(db, from, to, toEnd) {
  const k = zeroKpi();
  const f = await ozOrderCostsAggregate(db, { from, to });
  k.revenue = f.revenue;
  k.costRub = f.cost;
  k.commission = f.commission;
  k.logistics = f.logistics;
  k.acquiring = f.acquiring;
  k.loyalty = f.loyalty;

  k.sold = (await db.prepare(
    `SELECT COUNT(*) AS c FROM order_costs
     WHERE is_return = 0
       AND COALESCE(sale_dt, return_dt) IS NOT NULL
       AND substr(COALESCE(sale_dt, return_dt),1,10) >= ?
       AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?`
  ).get(from, to)).c || 0;

  k.adSp = await ozAdSpend(db, { from, to });

  k.orders = (await db.prepare(
    `SELECT COUNT(*) AS c FROM orders
     WHERE is_cancel = 0 AND substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ?`
  ).get(from, to)).c || 0;
  k.cancelCnt = (await db.prepare(
    `SELECT COUNT(*) AS c FROM orders
     WHERE is_cancel = 1 AND substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ?`
  ).get(from, to)).c || 0;

  k.tax = Math.round(k.revenue * USN_RATE * 100) / 100;
  k.profit = Math.round(
    (k.revenue - k.commission - k.acquiring - k.logistics - k.loyalty
      - k.costRub - k.adSp - k.tax) * 100
  ) / 100;
  return k;
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mps = cabinet.marketplaces || ['wb', 'ozon'];
  const mp = url.searchParams.get("mp") || "all";

  const fromQ = url.searchParams.get("from") || "";
  const toQ = url.searchParams.get("to") || "";
  // Дефолт: последние 30 дней от сегодня (упрощено для SaaS).
  const to = toQ || new Date().toISOString().slice(0, 10);
  const from = fromQ || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const toEnd = to + "T23:59:59";

  const parts = [];
  if (mp !== "ozon" && mps.includes('wb')) {
    const db = new DatabaseSync('wb', { readOnly: true });
    parts.push(await collectWb(db, from, to, toEnd));
  }
  if (mp !== "wb" && mps.includes('ozon')) {
    const db = new DatabaseSync('ozon', { readOnly: true });
    parts.push(await collectOzon(db, from, to, toEnd));
  }

  const k = zeroKpi();
  for (const p of parts) {
    for (const key of Object.keys(k)) k[key] += p[key] || 0;
  }
  k.profit = Math.round(k.profit * 100) / 100;
  const margin = k.revenue > 0 ? (k.profit / k.revenue) * 100 : 0;
  const cancelRate =
    k.orders + k.cancelCnt > 0 ? (k.cancelCnt / (k.orders + k.cancelCnt)) * 100 : 0;
  const expenses = k.commission + k.logistics + k.storage;

  // --- lossMakers / lowStock: WB-only ---
  let lossMakers = [];
  let lowStock = [];
  let noCogsCount = 0;
  if (mp !== "ozon" && mps.includes('wb')) {
    const db = new DatabaseSync('wb', { readOnly: true });
    const lmFin = await db.prepare(
      `SELECT s.nm_id,
         SUM(s.retail_price_withdisc_rub) AS salesRub,
         SUM(s.commission_percent * s.retail_price_withdisc_rub / 100.0) AS commission,
         SUM(s.acquiring_fee) AS acquiring,
         SUM(s.quantity) AS qty
       FROM finance_report s
       WHERE s.supplier_oper_name='Продажа' AND s.nm_id > 0
         AND s.rr_dt >= ? AND s.rr_dt <= ?
       GROUP BY s.nm_id`
    ).all(from, toEnd);
    const lmLog = await db.prepare(
      `SELECT nm_id, SUM(delivery_rub) AS logistics FROM finance_report
       WHERE supplier_oper_name='Логистика' AND nm_id > 0
         AND rr_dt >= ? AND rr_dt <= ? GROUP BY nm_id`
    ).all(from, toEnd);
    const lmAd = await db.prepare(
      `SELECT nm_id, COALESCE(SUM(ad_spend),0) AS ad FROM daily_metrics
       WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL GROUP BY nm_id`
    ).all(from, to);
    const lmLogMap = {}, lmAdMap = {}, lmCost = {}, lmName = {};
    for (const r of lmLog) lmLogMap[r.nm_id] = r.logistics || 0;
    for (const r of lmAd) lmAdMap[r.nm_id] = r.ad || 0;
    for (const r of await db.prepare("SELECT nm_id, cost FROM cogs WHERE cost > 0").all()) lmCost[r.nm_id] = r.cost;
    for (const r of await db.prepare("SELECT nm_id, name FROM articles").all()) lmName[r.nm_id] = r.name;
    lossMakers = lmFin
      .filter((f) => lmCost[f.nm_id] != null)
      .map((f) => {
        const rev = f.salesRub || 0;
        const tax = rev * USN_RATE;
        const costRub = (lmCost[f.nm_id] || 0) * (f.qty || 0);
        const profit = rev - (f.commission || 0) - (f.acquiring || 0)
          - (lmLogMap[f.nm_id] || 0) - (lmAdMap[f.nm_id] || 0) - tax - costRub;
        return { nm_id: f.nm_id, name: lmName[f.nm_id] || String(f.nm_id),
                 profit: Math.round(profit * 100) / 100 };
      })
      .filter((x) => x.profit < 0)
      .sort((a, b) => a.profit - b.profit)
      .slice(0, 5);

    lowStock = await db.prepare(
      `WITH last_stock AS (
         SELECT nm_id, SUM(quantity) AS qty
         FROM daily_stock
         WHERE date = (SELECT MAX(date) FROM daily_stock)
         GROUP BY nm_id
       ),
       avg_sales AS (
         SELECT nm_id, AVG(qty) AS daily
         FROM (
           SELECT nm_id, DATE(order_dt) AS d, COUNT(*) AS qty
           FROM orders WHERE is_cancel = 0
             AND DATE(order_dt) >= ? AND DATE(order_dt) <= ?
           GROUP BY nm_id, DATE(order_dt)
         )
         GROUP BY nm_id
       )
       SELECT ls.nm_id,
              COALESCE(a.name, CAST(ls.nm_id AS TEXT), '') AS name,
              ls.qty,
              CAST(COALESCE(as_.daily,0) AS REAL) AS daily_sales,
              CASE WHEN COALESCE(as_.daily,0) > 0
                   THEN ls.qty / as_.daily ELSE NULL END AS days_to_oos
       FROM last_stock ls
       LEFT JOIN avg_sales as_ ON as_.nm_id = ls.nm_id
       LEFT JOIN articles a ON a.nm_id = ls.nm_id
       WHERE ls.qty > 0 AND COALESCE(as_.daily,0) > 0
       ORDER BY days_to_oos ASC
       LIMIT 5`
    ).all(from, to);

    noCogsCount = (await db.prepare(
      `SELECT COUNT(DISTINCT s.nm_id) AS c
       FROM finance_report s LEFT JOIN cogs c ON c.nm_id = s.nm_id
       WHERE s.supplier_oper_name = 'Продажа' AND s.nm_id > 0
         AND (c.cost IS NULL OR c.cost <= 0) AND s.rr_dt >= ? AND s.rr_dt <= ?`
    ).get(from, toEnd)).c || 0;
  }

  return NextResponse.json({
    period: { from, to },
    mp,
    kpi: {
      revenue: Math.round(k.revenue * 100) / 100,
      netPay: Math.round(k.netPay * 100) / 100,
      grossProfit: k.profit,
      margin,
      cogsSold: Math.round(k.costRub * 100) / 100,
      adSpend: Math.round(k.adSp * 100) / 100,
      tax: Math.round(k.tax * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      expensesBreakdown: {
        logistics: Math.round(k.logistics * 100) / 100,
        commission: Math.round(k.commission * 100) / 100,
        storage: Math.round(k.storage * 100) / 100,
        penalties: 0,
      },
      orders: k.orders,
      cancelRate,
      sold: k.sold,
    },
    alerts: { lossMakers, lowStock, noCogsCount },
  });
});
