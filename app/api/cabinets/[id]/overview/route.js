// /api/cabinets/[id]/overview — НАСТОЯЩИЙ overview из data-presenter (PostgreSQL+RLS).
// Полный перенос: все KPI, lossMakers, lowStock, noCogs.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import {
  wbFinancePeriod, wbOrdersCount, wbCancelCount, wbAdTotal, wbSold,
  wbFinanceByDay, wbOrdersByDay, wbOrderRubByDay,
} from "@/lib/wbMetrics.js";
import { ozOrderCostsAggregate, ozAdSpend, ozOrdersByDay } from "@/lib/ozonMetrics.js";
import { calcTotalTax, normalizeTaxMode, describeCombinedTaxMode } from "@/lib/tax.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const zeroKpi = () => ({
  revenue: 0, sold: 0, commission: 0, logistics: 0, acquiring: 0, loyalty: 0,
  costRub: 0, adSp: 0, tax: 0, profit: 0, orders: 0, cancelCnt: 0, orderRub: 0,
  netPay: 0, storage: 0,
});

async function collectWb(db, from, to, toEnd, taxMode) {
  const k = zeroKpi();
  const fin = await wbFinancePeriod(db, { from, to });
  k.revenue = fin.salesRub;
  k.commission = fin.commission;
  k.acquiring = fin.acquiring;
  k.logistics = fin.logistics;

  k.sold = Object.values(await wbSold(db, { from, to })).reduce((a, b) => a + b, 0);

  k.costRub = (await db.prepare(
    `SELECT COALESCE(SUM(s.quantity * co.cost),0) AS v
     FROM finance_report s
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE nm_id = s.nm_id AND platform = 'wb'
         AND effective_from <= substr(s.rr_dt,1,10)::date
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
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
    `SELECT COALESCE(SUM(storage_fee),0) AS v FROM finance_report
     WHERE supplier_oper_name = 'Хранение' AND rr_dt >= ? AND rr_dt <= ?`
  ).get(from, toEnd)).v || 0;

  k.orders = await wbOrdersCount(db, { from, to });
  k.cancelCnt = await wbCancelCount(db, { from, to });
  // Сумма заказов в рублях (price_with_disc по не отменённым) — цена со скидкой
  // продавца, БЕЗ СПП. Это стандартная «сумма заказов» в отчётах МП. Отличается
  // от salesRub (фактические продажи по finance_report): часть заказов
  // отменяется/не выкупается, поэтому orderRub >= salesRub обычно.
  k.orderRub = (await db.prepare(
    `SELECT COALESCE(SUM(price_with_disc),0) AS v FROM orders
     WHERE is_cancel = 0 AND order_dt >= ? AND order_dt <= ?`
  ).get(from, toEnd)).v || 0;

  // Налог: УСН (база = выручка без НДС) + НДС (выделение из цены). profit вычитает total.
  const expenses = k.commission + k.acquiring + k.logistics + k.costRub + k.adSp + k.storage;
  const tot = calcTotalTax(taxMode, k.revenue, expenses);
  k.tax = tot.total;
  k.profit = Math.round(
    (k.revenue - k.commission - k.acquiring - k.logistics - k.costRub - k.adSp - k.tax) * 100
  ) / 100;
  return k;
}

async function collectOzon(db, from, to, toEnd, taxMode) {
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
  // Сумма заказов в рублях (price по не отменённым).
  k.orderRub = (await db.prepare(
    `SELECT COALESCE(SUM(price),0) AS v FROM orders
     WHERE is_cancel = 0 AND substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ?`
  ).get(from, to)).v || 0;

  // Налог: УСН (база = выручка без НДС) + НДС (выделение из цены). profit вычитает total.
  const expenses = k.commission + k.acquiring + k.logistics + k.loyalty + k.costRub + k.adSp;
  k.tax = calcTotalTax(taxMode, k.revenue, expenses).total;
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

  // Налоговый режим на каждый МП (per shop / per legal entity).
  const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
  const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);

  const parts = [];
  if (mp !== "ozon" && mps.includes('wb')) {
    const db = new DatabaseSync('wb', { readOnly: true });
    parts.push(await collectWb(db, from, to, toEnd, wbTax));
  }
  if (mp !== "wb" && mps.includes('ozon')) {
    const db = new DatabaseSync('ozon', { readOnly: true });
    parts.push(await collectOzon(db, from, to, toEnd, ozonTax));
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
    for (const r of await db.prepare(
      `SELECT DISTINCT ON (nm_id) nm_id, cost FROM tenant.cost_overrides
       WHERE platform = 'wb' AND cost > 0
         AND effective_from <= current_date
       ORDER BY nm_id, effective_from DESC`
    ).all()) lmCost[r.nm_id] = r.cost;
    for (const r of await db.prepare("SELECT nm_id, name FROM articles").all()) lmName[r.nm_id] = r.name;
    lossMakers = lmFin
      .filter((f) => lmCost[f.nm_id] != null)
      .map((f) => {
        const rev = f.salesRub || 0;
        const costRub = (lmCost[f.nm_id] || 0) * (f.qty || 0);
        const itemExpenses = (f.commission || 0) + (f.acquiring || 0)
          + (lmLogMap[f.nm_id] || 0) + (lmAdMap[f.nm_id] || 0) + costRub;
        const tax = calcTotalTax(wbTax, rev, itemExpenses).total;
        const profit = rev - itemExpenses - tax;
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
       FROM finance_report s
       LEFT JOIN LATERAL (
         SELECT cost FROM tenant.cost_overrides
         WHERE nm_id = s.nm_id AND platform = 'wb'
           AND effective_from <= substr(s.rr_dt,1,10)::date
         ORDER BY effective_from DESC LIMIT 1
       ) co ON true
       WHERE s.supplier_oper_name = 'Продажа' AND s.nm_id > 0
         AND (co.cost IS NULL OR co.cost <= 0) AND s.rr_dt >= ? AND s.rr_dt <= ?`
    ).get(from, toEnd)).c || 0;
  }

  // --- Временной ряд для графика на Главной (по дням). ---
  // WB: выручка, маржинальная прибыль (sales − commission − acquiring − logistics −
  //   loyalty; БЕЗ себестоимости/рекламы/налога — их нет в finance_report по дням),
  //   заказы (шт), сумма заказов (₽), комиссия, к перечислению (for_pay Продажа−Возврат).
  // Ozon: заказы, выручка, комиссия (per-day прибыли/перечисления нет в данных).
  //   Склеиваем по дате WB + Ozon, сортируем по возрасту.
  const TS_KEYS = ["revenue", "profit", "orders", "orderRub", "commission", "netPay"];
  const tsByDate = new Map(); // date -> {revenue, profit, ...}
  const tsSet = (d, patch) => {
    if (!tsByDate.has(d)) {
      const o = {}; for (const k of TS_KEYS) o[k] = 0; tsByDate.set(d, o);
    }
    const o = tsByDate.get(d);
    for (const key of Object.keys(patch)) o[key] = (o[key] || 0) + (patch[key] || 0);
  };
  if (mp !== "ozon" && mps.includes('wb')) {
    const db = new DatabaseSync('wb', { readOnly: true });
    const fin = await wbFinanceByDay(db, { from, to });
    for (const [key, v] of fin) {
      const d = key.split("|")[1];
      const profit = (v.salesRub || 0) - (v.commission || 0) - (v.acquiring || 0)
        - (v.logistics || 0) - (v.loyalty || 0);
      tsSet(d, {
        revenue: v.salesRub || 0,
        commission: v.commission || 0,
        profit,
      });
    }
    const ord = await wbOrdersByDay(db, { from, to });
    for (const [key, c] of ord) tsSet(key.split("|")[1], { orders: c });
    // Сумма заказов ₽ (price_with_disc) по дням.
    const ordRub = await wbOrderRubByDay(db, { from, to });
    for (const [key, s] of ordRub) tsSet(key.split("|")[1], { orderRub: s });
    // К перечислению (ppvz_for_pay) по дням: Продажа(+), Возврат(−).
    for (const r of await db.prepare(
      `SELECT substr(rr_dt,1,10) AS d,
              SUM(CASE WHEN supplier_oper_name='Продажа' THEN ppvz_for_pay
                       WHEN supplier_oper_name='Возврат'  THEN -ABS(ppvz_for_pay)
                       ELSE 0 END) AS net
       FROM finance_report
       WHERE supplier_oper_name IN ('Продажа','Возврат')
         AND rr_dt >= ? AND rr_dt <= ?
       GROUP BY substr(rr_dt,1,10)`
    ).all(from, toEnd)) {
      tsSet(r.d, { netPay: r.net || 0 });
    }
  }
  if (mp !== "wb" && mps.includes('ozon')) {
    const db = new DatabaseSync('ozon', { readOnly: true });
    const ord = await ozOrdersByDay(db, { from, to });
    for (const [key, c] of ord) tsSet(key.split("|")[1], { orders: c });
    // Ozon: выручка + комиссия per-day из order_costs (cost_value_retail, commission).
    // Прибыль/перечисление по дням не считаем (нет данных per-day).
    for (const r of await db.prepare(
      `SELECT substr(COALESCE(sale_dt, return_dt),1,10) AS d,
              SUM(CASE WHEN is_return=0 THEN cost_value_retail ELSE 0 END) AS rev,
              SUM(CASE WHEN is_return=0 THEN commission ELSE 0 END) AS com
       FROM order_costs
       WHERE COALESCE(sale_dt, return_dt) IS NOT NULL
         AND substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
       GROUP BY substr(COALESCE(sale_dt, return_dt),1,10)`
    ).all(from, to)) {
      tsSet(r.d, { revenue: r.rev || 0, commission: r.com || 0 });
    }
  }
  const timeseries = [...tsByDate.entries()]
    .map(([date, v]) => {
      const o = { date };
      for (const k of TS_KEYS) o[k] = Math.round((v[k] || 0) * 100) / 100;
      return o;
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));

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
      orderRub: Math.round(k.orderRub * 100) / 100,
      cancelRate,
      sold: k.sold,
    },
    alerts: { lossMakers, lowStock, noCogsCount },
    timeseries,
    taxLabel: describeCombinedTaxMode(cabinet.shopTax, { short: true }),
  });
});
