// /api/cabinets/[id]/geography — География заказов и продаж (WB+Ozon).
// Перенос data-presenter/api/geography/route.js (314 строк) с адаптацией под PG.
// Источник: orders (заказы) + sales (продажи WB) GROUP BY okrug_name/warehouse_name.
// Ozon: только region (город), продажи = заказы (нет гео-разреза продаж).
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY = "Не указан";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mp = url.searchParams.get("mp") || "all";
  const period = url.searchParams.get("period") || "all";
  const fromQ = url.searchParams.get("from") || "";
  const toQ = url.searchParams.get("to") || "";
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const nm = url.searchParams.get("nm") || "";
  const brand = url.searchParams.get("brand") || "";
  const group = url.searchParams.get("group") || "";
  const mps = cabinet.marketplaces || ["wb", "ozon"];

  let from = fromQ, to = toQ;
  if (period !== "all" && /^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    from = `${period}-01`;
    to = `${period}-${String(lastDay).padStart(2, "0")}`;
  }

  let byRegion = [], byWarehouse = [], range = { from: null, to: null };
  const months = new Set();
  const facets = { brand: [], group: [], nm: [] };

  if (mp !== "ozon" && mps.includes("wb")) {
    const wb = await collectWB({ from, to, q, nm, brand, group });
    byRegion = mergeByName(byRegion, wb.byRegion);
    byWarehouse = mergeByName(byWarehouse, wb.byWarehouse);
    if (wb.range.from && (!range.from || wb.range.from < range.from)) range.from = wb.range.from;
    if (wb.range.to && (!range.to || wb.range.to > range.to)) range.to = wb.range.to;
    for (const m of wb.months) months.add(m);
    facets.brand = mergeFacets(facets.brand, wb.facets.brand);
    facets.group = mergeFacets(facets.group, wb.facets.group);
    facets.nm = mergeFacets(facets.nm, wb.facets.nm);
  }
  if (mp !== "wb" && mps.includes("ozon")) {
    const oz = await collectOzon({ from, to, q, nm, brand, group });
    byRegion = mergeByName(byRegion, oz.byRegion);
    byWarehouse = mergeByName(byWarehouse, oz.byWarehouse);
    if (oz.range.from && (!range.from || oz.range.from < range.from)) range.from = oz.range.from;
    if (oz.range.to && (!range.to || oz.range.to > range.to)) range.to = oz.range.to;
    for (const m of oz.months) months.add(m);
    facets.brand = mergeFacets(facets.brand, oz.facets.brand);
    facets.group = mergeFacets(facets.group, oz.facets.group);
    facets.nm = mergeFacets(facets.nm, oz.facets.nm);
  }

  byRegion.sort((a, b) => (b.ordersRub + b.salesRub) - (a.ordersRub + a.salesRub));
  byWarehouse.sort((a, b) => (b.ordersRub + b.salesRub) - (a.ordersRub + a.salesRub));

  return NextResponse.json({
    period: range,
    months: [...months].sort(),
    byRegion, byWarehouse, facets,
  });
});

// ---------- WB ----------
async function collectWB({ from, to, q, nm, brand, group }) {
  const db = new DatabaseSync("wb", { readOnly: true });
  const conds = ["o.order_dt <> ''"];
  const params = [];
  if (from) { conds.push("substr(o.order_dt,1,10) >= ?"); params.push(from); }
  if (to)   { conds.push("substr(o.order_dt,1,10) <= ?"); params.push(to); }
  if (nm)    { conds.push("o.nm_id = ?"); params.push(Number(nm)); }
  if (brand) { conds.push("o.brand = ?"); params.push(brand); }
  if (group) { conds.push("o.subject = ?"); params.push(group); }
  if (q) {
    conds.push("(LOWER(o.supplier_article) LIKE ? OR LOWER(CAST(o.nm_id AS TEXT)) LIKE ? OR LOWER(COALESCE(a.name,'')) LIKE ? OR LOWER(o.brand) LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conds.join(" AND ");
  const articleJoin = `LEFT JOIN articles a ON a.nm_id = o.nm_id`;

  const range = await db.prepare(`SELECT MIN(substr(order_dt,1,10)) a, MAX(substr(order_dt,1,10)) b FROM orders WHERE order_dt <> ''`).get();
  const monthRows = await db.prepare(`SELECT DISTINCT substr(order_dt,1,7) m FROM orders WHERE order_dt <> '' ORDER BY m`).all();
  const months = monthRows.map((r) => r.m).filter(Boolean);

  const ordersRegion = await db.prepare(
    `SELECT COALESCE(NULLIF(o.okrug_name,''),'${EMPTY}') name, COUNT(*) qty, COALESCE(SUM(o.price_with_disc),0) rub FROM orders o ${articleJoin} WHERE ${where} GROUP BY o.okrug_name`
  ).all(...params);
  const ordersWh = await db.prepare(
    `SELECT COALESCE(NULLIF(o.warehouse_name,''),'${EMPTY}') name, COUNT(*) qty, COALESCE(SUM(o.price_with_disc),0) rub FROM orders o ${articleJoin} WHERE ${where} GROUP BY o.warehouse_name`
  ).all(...params);

  // Продажи — по sale_dt.
  const sConds = ["s.sale_dt <> ''"];
  const sParams = [];
  if (from) { sConds.push("substr(s.sale_dt,1,10) >= ?"); sParams.push(from); }
  if (to)   { sConds.push("substr(s.sale_dt,1,10) <= ?"); sParams.push(to); }
  if (nm)    { sConds.push("s.nm_id = ?"); sParams.push(Number(nm)); }
  if (brand) { sConds.push("s.brand = ?"); sParams.push(brand); }
  if (group) { sConds.push("s.subject = ?"); sParams.push(group); }
  if (q) {
    sConds.push("(LOWER(s.supplier_article) LIKE ? OR LOWER(CAST(s.nm_id AS TEXT)) LIKE ? OR LOWER(COALESCE(a.name,'')) LIKE ? OR LOWER(s.brand) LIKE ?)");
    sParams.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sWhere = sConds.join(" AND ");
  const salesRegion = await db.prepare(
    `SELECT COALESCE(NULLIF(s.okrug_name,''),'${EMPTY}') name, COUNT(*) qty, COALESCE(SUM(s.finished_price),0) rub FROM sales s LEFT JOIN articles a ON a.nm_id = s.nm_id WHERE ${sWhere} GROUP BY s.okrug_name`
  ).all(...sParams);
  const salesWh = await db.prepare(
    `SELECT COALESCE(NULLIF(s.warehouse_name,''),'${EMPTY}') name, COUNT(*) qty, COALESCE(SUM(s.finished_price),0) rub FROM sales s LEFT JOIN articles a ON a.nm_id = s.nm_id WHERE ${sWhere} GROUP BY s.warehouse_name`
  ).all(...sParams);

  // Фасеты.
  const facetRows = await db.prepare(`SELECT o.brand, o.subject, o.nm_id, o.supplier_article, a.name FROM orders o LEFT JOIN articles a ON a.nm_id = o.nm_id WHERE o.order_dt <> ''`).all();
  const facets = buildFacets(facetRows, "wb");

  return {
    byRegion: zipGeo(ordersRegion, salesRegion),
    byWarehouse: zipGeo(ordersWh, salesWh),
    range: { from: range?.a || null, to: range?.b || null },
    months, facets,
  };
}

// ---------- Ozon ----------
async function collectOzon({ from, to, q, nm, brand, group }) {
  const db = new DatabaseSync("ozon", { readOnly: true });
  const conds = ["o.order_dt <> ''"];
  const params = [];
  if (from) { conds.push("substr(o.order_dt,1,10) >= ?"); params.push(from); }
  if (to)   { conds.push("substr(o.order_dt,1,10) <= ?"); params.push(to); }
  if (nm)    { conds.push("o.product_id = ?"); params.push(Number(nm)); }
  if (brand) { conds.push("p.brand = ?"); params.push(brand); }
  if (group) { conds.push("p.category = ?"); params.push(group); }
  if (q) {
    conds.push("(LOWER(o.offer_id) LIKE ? OR LOWER(CAST(o.product_id AS TEXT)) LIKE ? OR LOWER(COALESCE(p.name,'')) LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conds.join(" AND ");
  const articleJoin = `LEFT JOIN products p ON p.product_id = o.product_id`;

  const range = await db.prepare(`SELECT MIN(substr(order_dt,1,10)) a, MAX(substr(order_dt,1,10)) b FROM orders WHERE order_dt <> ''`).get();
  const monthRows = await db.prepare(`SELECT DISTINCT substr(order_dt,1,7) m FROM orders WHERE order_dt <> '' ORDER BY m`).all();
  const months = monthRows.map((r) => r.m).filter(Boolean);

  const ordersRegion = await db.prepare(
    `SELECT COALESCE(NULLIF(o.region,''),'${EMPTY}') name, COUNT(*) qty, COALESCE(SUM(o.total),0) rub FROM orders o ${articleJoin} WHERE ${where} GROUP BY o.region`
  ).all(...params);
  const ordersWh = await db.prepare(
    `SELECT COALESCE(NULLIF(o.warehouse,''),'${EMPTY}') name, COUNT(*) qty, COALESCE(SUM(o.total),0) rub FROM orders o ${articleJoin} WHERE ${where} GROUP BY o.warehouse`
  ).all(...params);

  const facetRows = await db.prepare(`SELECT o.product_id, p.brand, p.category, p.name, o.offer_id FROM orders o LEFT JOIN products p ON p.product_id = o.product_id WHERE o.order_dt <> ''`).all();
  const facets = buildFacets(facetRows, "ozon");

  return {
    byRegion: zipGeo(ordersRegion, ordersRegion), // Ozon: продажи = заказы (нет гео продаж)
    byWarehouse: zipGeo(ordersWh, ordersWh),
    range: { from: range?.a || null, to: range?.b || null },
    months, facets,
  };
}

// ---------- хелперы ----------
function zipGeo(orders, sales) {
  const map = new Map();
  for (const o of orders) {
    map.set(o.name, { name: o.name, ordersRub: o.rub || 0, ordersQty: o.qty || 0, salesRub: 0, salesQty: 0 });
  }
  for (const s of sales) {
    const cur = map.get(s.name) || { name: s.name, ordersRub: 0, ordersQty: 0, salesRub: 0, salesQty: 0 };
    cur.salesRub = s.rub || 0; cur.salesQty = s.qty || 0;
    map.set(s.name, cur);
  }
  return [...map.values()];
}

function mergeByName(a, b) {
  const map = new Map();
  for (const r of a) map.set(r.name, { ...r });
  for (const r of b) {
    const cur = map.get(r.name) || { name: r.name, ordersRub: 0, ordersQty: 0, salesRub: 0, salesQty: 0 };
    cur.ordersRub += r.ordersRub || 0; cur.ordersQty += r.ordersQty || 0;
    cur.salesRub += r.salesRub || 0; cur.salesQty += r.salesQty || 0;
    map.set(r.name, cur);
  }
  return [...map.values()];
}

function buildFacets(rows, mp) {
  const brands = new Map(), groups = new Map(), nms = new Map();
  for (const r of rows) {
    if (mp === "wb") {
      if (r.brand) brands.set(r.brand, (brands.get(r.brand) || 0) + 1);
      if (r.subject) groups.set(r.subject, (groups.get(r.subject) || 0) + 1);
      if (r.nm_id) nms.set(r.nm_id, { label: r.supplier_article || r.name || String(r.nm_id), count: (nms.get(r.nm_id)?.count || 0) + 1 });
    } else {
      if (r.brand) brands.set(r.brand, (brands.get(r.brand) || 0) + 1);
      if (r.category) groups.set(r.category, (groups.get(r.category) || 0) + 1);
      if (r.product_id) nms.set(r.product_id, { label: r.offer_id || r.name || String(r.product_id), count: (nms.get(r.product_id)?.count || 0) + 1 });
    }
  }
  const toOpts = (m, isNm) => {
    if (isNm) return [...nms.entries()].map(([id, v]) => ({ id, label: v.label, count: v.count })).sort((a, b) => b.count - a.count);
    return [...m.entries()].map(([k, n]) => ({ value: k, count: n })).sort((a, b) => b.count - a.count);
  };
  return { brand: toOpts(brands, false), group: toOpts(groups, false), nm: toOpts(nms, true) };
}

function mergeFacets(a, b) {
  const map = new Map(a.map((x) => [x.value || x.id, x]));
  for (const x of b) {
    const key = x.value || x.id;
    const cur = map.get(key);
    if (cur) cur.count = (cur.count || 0) + (x.count || 0);
    else map.set(key, x);
  }
  return [...map.values()].sort((a, b) => (b.count || 0) - (a.count || 0));
}
