// /api/cabinets/[id]/pnl — P&L (Сводка по прибыли) из PostgreSQL.
// Источник: wb_finance_report + ozon_order_costs.
// Упрощённая версия (без cost_overrides — использует cogs напрямую).
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TAX_INCOME_RATE = 0.06;

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const period = url.searchParams.get("period") ||
    new Date().toISOString().slice(0, 7); // YYYY-MM
  const mps = cabinet.marketplaces || ["wb", "ozon"];

  // Период = календарный месяц.
  const from = period + "-01";
  const to = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)
    .toISOString().slice(0, 10);
  const te = to + "T23:59:59";

  let wb = null, ozon = null;

  // WB P&L — из finance_report (как data-presenter pnl route)
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
    ).get(from + " 00:00:00", te);

    // Себестоимость (cost>0 из cogs × qty)
    const costRow = await db.prepare(
      `SELECT COALESCE(SUM(s.quantity * CASE WHEN c.cost > 0 THEN c.cost ELSE 0 END), 0) AS v
       FROM finance_report s
       LEFT JOIN cogs c ON c.nm_id = s.nm_id
       WHERE s.supplier_oper_name = 'Продажа' AND s.nm_id > 0
         AND s.rr_dt >= ? AND s.rr_dt <= ?`
    ).get(from + " 00:00:00", te);

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

  // Ozon P&L — из order_costs
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
         AND substr(sale_dt, 1, 7) = ?`
    ).get(period);

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

  // Объединение
  const total = { sales: 0, returns: 0, netSales: 0, cost: 0, commission: 0, logistics: 0, acquiring: 0, storage: 0, tax: 0, grossProfit: 0, netProfit: 0, qtySold: 0, forPay: 0 };
  for (const mp of [wb, ozon]) {
    if (!mp) continue;
    for (const k of Object.keys(total)) total[k] += mp[k] || 0;
  }
  total.margin = total.netSales > 0 ? Math.round((total.netProfit / total.netSales) * 10000) / 100 : 0;

  return NextResponse.json({ period, wb, ozon, total });
});
