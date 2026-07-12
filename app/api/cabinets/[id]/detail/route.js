// /api/cabinets/[id]/detail — детсводка по одному товару (WB или Ozon).
// Параметры: ?platform=wb|ozon&nm=<id>&from=&to=
// Отдаёт: инфо о товаре, KPI периода, динамика по дням (выручка/продано/прибыль).
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import {
  wbFinancePeriod, wbOrdersCount, wbSold, wbAdTotal,
  wbSoldByDay, wbStockByDay, wbFinanceByDay, wbUnitCost,
} from "@/lib/wbMetrics.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") || "wb";
  const nmRaw = url.searchParams.get("nm");
  if (!nmRaw) return NextResponse.json({ error: "nm required" }, { status: 400 });
  const nm = Number(nmRaw);

  const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get("from") ||
    new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const toEnd = to + "T23:59:59";

  if (platform === "wb") {
    const db = new DatabaseSync("wb", { readOnly: true });

    // Инфо о товаре
    const info = await db.prepare(
      `SELECT nm_id, name, brand, im_url, subject FROM articles WHERE nm_id = ?`
    ).get(nm);

    // Финансы за период (единый канон)
    const fin = await wbFinancePeriod(db, { from, to, nmId: nm });

    // Заказы и продажи
    const orders = await wbOrdersCount(db, { from, to, nmId: nm });
    const soldMap = await wbSoldByDay(db, { from, to, nmIds: [nm] });
    const sold = Object.values(soldMap).reduce((a, b) => a + b, 0);

    // Реклама
    const adSp = await wbAdTotal(db, { from, to });

    // Себестоимость
    const unitCost = await wbUnitCost(db, nm);
    const costRub = (unitCost || 0) * sold;

    // Динамика по дням
    const finByDay = await wbFinanceByDay(db, { from, to, nmIds: [nm] });

    // Дни для матрицы
    const days = [];
    const dStart = new Date(from);
    const dEnd = new Date(to);
    for (let d = new Date(dStart); d <= dEnd; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      const key = `${nm}|${ds}`;
      const fd = finByDay.get(key) || {};
      days.push({
        date: ds,
        weekday: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"][new Date(ds + "T00:00:00").getDay()],
        revenue: fd.salesRub || 0,
        commission: fd.commission || 0,
        logistics: fd.logistics || 0,
        acquiring: fd.acquiring || 0,
        sold: soldMap.get(key) || 0,
        profit: Math.round(((fd.salesRub || 0) - (fd.commission || 0) - (fd.acquiring || 0) -
          (fd.logistics || 0) - (unitCost || 0) * (soldMap.get(key) || 0) - (fd.adSp || 0) -
          (fd.salesRub || 0) * 0.06) * 100) / 100,
      });
    }

    const revenue = fin.salesRub || 0;
    const tax = Math.round(revenue * 0.06 * 100) / 100;
    const profit = Math.round((revenue - fin.commission - fin.acquiring - fin.logistics -
      costRub - adSp - tax) * 100) / 100;

    return NextResponse.json({
      platform: "wb",
      nm,
      info,
      period: { from, to },
      kpi: {
        revenue: Math.round(revenue * 100) / 100,
        sold,
        orders,
        commission: Math.round(fin.commission * 100) / 100,
        logistics: Math.round(fin.logistics * 100) / 100,
        acquiring: Math.round(fin.acquiring * 100) / 100,
        costRub: Math.round(costRub * 100) / 100,
        adSpend: Math.round(adSp * 100) / 100,
        tax,
        profit,
        margin: revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : 0,
        unitCost,
      },
      days,
    });
  } else {
    // Ozon
    const db = new DatabaseSync("ozon", { readOnly: true });

    const info = await db.prepare(
      `SELECT product_id AS nm_id, name, '' AS brand, '' AS im_url, '' AS subject, '' AS category FROM products WHERE product_id = ?`
    ).get(nm);

    // Агрегат из order_costs
    const agg = await db.prepare(
      `SELECT
         COALESCE(SUM(cost_value_retail), 0) AS revenue,
         COALESCE(SUM(cost), 0) AS cost,
         COALESCE(SUM(commission), 0) AS commission,
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(acquiring), 0) AS acquiring,
         COALESCE(SUM(profit), 0) AS profit,
         COUNT(*) AS sold
       FROM order_costs
       WHERE product_id = ? AND is_return = 0
         AND sale_dt IS NOT NULL
         AND substr(sale_dt, 1, 10) >= ? AND substr(sale_dt, 1, 10) <= ?`
    ).get(nm, from, to);

    // Динамика по дням
    const dailyRows = await db.prepare(
      `SELECT substr(sale_dt, 1, 10) AS date,
              COALESCE(SUM(cost_value_retail), 0) AS revenue,
              COALESCE(SUM(profit), 0) AS profit,
              COUNT(*) AS sold
       FROM order_costs
       WHERE product_id = ? AND is_return = 0 AND sale_dt IS NOT NULL
         AND substr(sale_dt, 1, 10) >= ? AND substr(sale_dt, 1, 10) <= ?
       GROUP BY 1 ORDER BY 1`
    ).all(nm, from, to);

    const days = dailyRows.map((r) => ({
      date: r.date,
      weekday: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"][new Date(r.date + "T00:00:00").getDay()],
      revenue: Number(r.revenue) || 0,
      sold: Number(r.sold) || 0,
      profit: Math.round(Number(r.profit) * 100) / 100,
    }));

    const revenue = Number(agg.revenue) || 0;
    const profit = Number(agg.profit) || 0;

    return NextResponse.json({
      platform: "ozon",
      nm,
      info,
      period: { from, to },
      kpi: {
        revenue: Math.round(revenue * 100) / 100,
        sold: Number(agg.sold) || 0,
        orders: 0,
        commission: Math.round(Number(agg.commission) * 100) / 100,
        logistics: Math.round(Number(agg.logistics) * 100) / 100,
        acquiring: Math.round(Number(agg.acquiring) * 100) / 100,
        costRub: Math.round(Number(agg.cost) * 100) / 100,
        adSpend: 0,
        tax: Math.round(revenue * 0.06 * 100) / 100,
        profit,
        margin: revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : 0,
        unitCost: null,
      },
      days,
    });
  }
});
