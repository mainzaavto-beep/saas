// /api/cabinets/[id]/unit — юнит-экономика (WB+Ozon) из PostgreSQL.
// Средние значения на единицу товара за период.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { calcTotalTax, normalizeTaxMode } from "@/lib/tax.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get("from") ||
    new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const mps = cabinet.marketplaces || ["wb", "ozon"];

  // Налоговый режим на каждый МП (per shop / per legal entity).
  const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
  const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);

  const items = [];

  // WB
  if (mps.includes("wb")) {
    const db = new DatabaseSync("wb", { readOnly: true });
    const rows = await db.prepare(
      `SELECT a.nm_id, a.name, a.brand, a.im_url, a.subject AS category,
              COUNT(*) FILTER (WHERE oc.is_return = 0) AS sold,
              AVG(oc.cost_value_retail) FILTER (WHERE oc.is_return = 0) AS price,
              AVG(oc.cost) FILTER (WHERE oc.is_return = 0) AS cost,
              AVG(oc.commission) FILTER (WHERE oc.is_return = 0) AS commission,
              AVG(oc.logistics) FILTER (WHERE oc.is_return = 0) AS logistics,
              AVG(oc.acquiring) FILTER (WHERE oc.is_return = 0) AS acquiring,
              AVG(oc.profit) FILTER (WHERE oc.is_return = 0) AS profit
       FROM articles a
       LEFT JOIN order_costs oc ON oc.nm_id = a.nm_id
         AND oc.sale_dt IS NOT NULL
         AND substr(oc.sale_dt, 1, 10) >= ? AND substr(oc.sale_dt, 1, 10) <= ?
       GROUP BY a.nm_id, a.name, a.brand, a.im_url, a.subject
       HAVING COUNT(*) FILTER (WHERE oc.is_return = 0) > 0
       ORDER BY profit DESC`
    ).all(from, to);

    for (const r of rows) {
      const price = Number(r.price) || 0;
      const cost = Number(r.cost) || 0;
      const commission = Number(r.commission) || 0;
      const logistics = Number(r.logistics) || 0;
      const acquiring = Number(r.acquiring) || 0;
      const profit = Number(r.profit) || 0;
      // Налог на единицу: расходы = себест + комиссия + логистика + эквайринг.
      const unitExpenses = cost + commission + logistics + acquiring;
      items.push({
        platform: "wb",
        nm: r.nm_id,
        name: r.name,
        brand: r.brand,
        im_url: r.im_url,
        category: r.category,
        sold: Number(r.sold) || 0,
        price: Math.round(price * 100) / 100,
        cost: Math.round(cost * 100) / 100,
        commission: Math.round(commission * 100) / 100,
        logistics: Math.round(logistics * 100) / 100,
        acquiring: Math.round(acquiring * 100) / 100,
        tax: calcTotalTax(wbTax, price, unitExpenses).total,
        profit: Math.round(profit * 100) / 100,
        margin: price > 0 ? Math.round((profit / price) * 10000) / 100 : 0,
      });
    }
  }

  // Ozon
  if (mps.includes("ozon")) {
    const db = new DatabaseSync("ozon", { readOnly: true });
    const rows = await db.prepare(
      `SELECT p.product_id AS nm, p.name, p.brand, p.im_url, '' AS category,
              COUNT(*) FILTER (WHERE oc.is_return = 0) AS sold,
              AVG(oc.cost_value_retail) FILTER (WHERE oc.is_return = 0) AS price,
              AVG(oc.cost) FILTER (WHERE oc.is_return = 0) AS cost,
              AVG(oc.commission) FILTER (WHERE oc.is_return = 0) AS commission,
              AVG(oc.logistics) FILTER (WHERE oc.is_return = 0) AS logistics,
              AVG(oc.acquiring) FILTER (WHERE oc.is_return = 0) AS acquiring,
              AVG(oc.profit) FILTER (WHERE oc.is_return = 0) AS profit
       FROM products p
       LEFT JOIN order_costs oc ON oc.product_id = p.product_id
         AND oc.sale_dt IS NOT NULL
         AND substr(oc.sale_dt, 1, 10) >= ? AND substr(oc.sale_dt, 1, 10) <= ?
       GROUP BY p.product_id, p.name, p.brand, p.im_url
       HAVING COUNT(*) FILTER (WHERE oc.is_return = 0) > 0
       ORDER BY profit DESC`
    ).all(from, to);

    for (const r of rows) {
      const price = Number(r.price) || 0;
      const cost = Number(r.cost) || 0;
      const commission = Number(r.commission) || 0;
      const logistics = Number(r.logistics) || 0;
      const acquiring = Number(r.acquiring) || 0;
      const profit = Number(r.profit) || 0;
      // Налог на единицу: расходы = себест + комиссия + логистика + эквайринг.
      const unitExpenses = cost + commission + logistics + acquiring;
      items.push({
        platform: "ozon",
        nm: r.nm,
        name: r.name,
        brand: r.brand,
        im_url: r.im_url,
        category: "",
        sold: Number(r.sold) || 0,
        price: Math.round(price * 100) / 100,
        cost: Math.round(cost * 100) / 100,
        commission: Math.round(commission * 100) / 100,
        logistics: Math.round(logistics * 100) / 100,
        acquiring: Math.round(acquiring * 100) / 100,
        tax: calcTotalTax(ozonTax, price, unitExpenses).total,
        profit: Math.round(profit * 100) / 100,
        margin: price > 0 ? Math.round((profit / price) * 10000) / 100 : 0,
      });
    }
  }

  return NextResponse.json({ items, period: { from, to } });
});
