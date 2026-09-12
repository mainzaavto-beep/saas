import { NextResponse } from "next/server";
import { DatabaseSync, query } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { defaultPeriod } from "@/lib/period.js";
import { aggregateSkus, buildQueryMatrix, kpiFromQueries } from "@/lib/ozonSearch.js";
// =====================================================================
//  «Поиск и запросы» (Ozon) — позиции по поисковым запросам из кабинета продавца.
//  Источники: tenant.ozon_sku_search_daily (сводка SKU × день, канон позиции) и
//  tenant.ozon_search_queries_daily (SKU × день × запрос). Все расчёты —
//  lib/ozonSearch.js, здесь только чтение БД. Заказы/GMV — «по запросу».
// =====================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function prevWindow(from, to) {
  const f = new Date(from + "T00:00:00Z"), t = new Date(to + "T00:00:00Z");
  const days = Math.round((t - f) / 86400000) + 1;
  const pt = new Date(f.getTime() - 86400000), pf = new Date(pt.getTime() - (days - 1) * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  return { from: ymd(pf), to: ymd(pt) };
}
function dateList(from, to) {
  const out = []; const d = new Date(from + "T00:00:00Z"); const t = new Date(to + "T00:00:00Z");
  for (; d <= t; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const dflt = defaultPeriod(14);
    const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from") : dflt.from;
    const to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to") : dflt.to;
    const sku = url.searchParams.get("sku") || "";
    const prev = prevWindow(from, to);
    const db = new DatabaseSync("ozon", { readOnly: true });

    const shop = (await query(
      `SELECT cabinet_state, cabinet_profile_dir FROM auth.shops WHERE cabinet_id = $1 AND mp_code = 'ozon' AND is_active = true LIMIT 1`,
      [cabinet.cabinet_id])).at(0) || {};
    const cab = { state: shop.cabinet_state || "none", hasProfile: !!shop.cabinet_profile_dir };

    if (!sku) {
      const rows = await db.prepare(
        `SELECT s.sku, s.product_id, COALESCE(p.name, s.name) AS name, COALESCE(p.offer_id, s.article) AS article, p.im_url,
                s.date::text AS date, s.position, s.search_users, s.view_users, s.ctr, s.gmv
           FROM ozon_sku_search_daily s LEFT JOIN products p ON p.product_id = s.product_id
          WHERE s.date >= ? AND s.date <= ? ORDER BY s.sku, s.date`).all(from, to);
      const prevRows = await db.prepare(
        `SELECT sku, product_id, date::text AS date, position, search_users, view_users, ctr, gmv
           FROM ozon_sku_search_daily WHERE date >= ? AND date <= ? ORDER BY sku, date`).all(prev.from, prev.to);
      const { items, kpi } = aggregateSkus(rows, prevRows);
      const qrows = await db.prepare(
        `SELECT query, date::text AS date, position, search_users, orders FROM ozon_search_queries_daily WHERE date >= ? AND date <= ?`).all(from, to);
      Object.assign(kpi, kpiFromQueries(qrows));
      const imByPid = Object.fromEntries(rows.filter((r) => r.im_url).map((r) => [r.product_id, r.im_url]));
      for (const it of items) it.im_url = imByPid[it.product_id] || null;
      return NextResponse.json({ period: { from, to, prev }, cabinet: cab, kpi, items });
    }

    const minDemand = Number(url.searchParams.get("minDemand") || 0) || 0;
    const onlyOrders = url.searchParams.get("onlyOrders") === "1";
    const qrows = await db.prepare(
      `SELECT query, date::text AS date, position, search_users, view_users, ctr, click_users, orders, gmv
         FROM ozon_search_queries_daily WHERE sku = ? AND date >= ? AND date <= ? ORDER BY date`).all(sku, from, to);
    const prod = await db.prepare(
      `SELECT COALESCE(p.name, s.name) AS name, COALESCE(p.offer_id, s.article) AS article, p.im_url
         FROM ozon_sku_search_daily s LEFT JOIN products p ON p.product_id = s.product_id
        WHERE s.sku = ? ORDER BY s.date DESC LIMIT 1`).get(sku) || {};
    const matrix = buildQueryMatrix(qrows, dateList(from, to), { minDemand, onlyOrders });
    return NextResponse.json({ period: { from, to, prev }, sku, product: prod, matrix, kpi: kpiFromQueries(qrows) });
  } catch (e) {
    console.error("[search] ошибка:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
});
