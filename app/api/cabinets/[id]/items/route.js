// /api/cabinets/[id]/items — список товаров с себестоимостью (WB+Ozon).
// Полный перенос эталона data-presenter/api/items/route.js:
//   - GET: фильтры mp/brand/category/group/status/q, обогащение cost_overrides/
//     groups/status, возврат { items, totals, facets }
//   - POST: создать override себестоимости (замена старого upsert cogs).
// Смежные endpoint'ы: /items/cost, /items/status, /items/group, /items/history,
// /items/cost/[overrideId] (PUT/DELETE) — отдельные файлы.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import {
  listGroups, membersMap, statusMap, getCostOverride, upsertCostOverride,
} from "@/lib/finItems.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mpQ = (url.searchParams.get("mp") || "").toLowerCase();
  const brandQ = url.searchParams.get("brand") || "";
  const categoryQ = url.searchParams.get("category") || "";
  const groupQ = url.searchParams.get("group") || "";
  const statusQ = url.searchParams.get("status") || "";
  const qQ = url.searchParams.get("q") || "";
  const mps = cabinet.marketplaces || ["wb", "ozon"];
  const today = new Date().toISOString().slice(0, 10);

  // Enrichment-карты из tenant.* (один проход, bulk).
  const groups = await listGroups();
  const gName = {};
  for (const g of groups) gName[g.id] = g.name;
  const gMem = await membersMap();
  const gStat = await statusMap();

  // --- WB: articles + cost_overrides (base_cost) ---
  const wbItems = [];
  if (mpQ !== "ozon" && mps.includes("wb")) {
    const db = new DatabaseSync("wb", { readOnly: true });
    let sql = `SELECT a.nm_id, a.name, a.brand, a.subject, a.im_url,
                      co.cost AS base_cost
                 FROM articles a
                 LEFT JOIN LATERAL (
                   SELECT cost FROM tenant.cost_overrides
                   WHERE nm_id = a.nm_id AND platform = 'wb'
                     AND effective_from <= current_date
                   ORDER BY effective_from DESC LIMIT 1
                 ) co ON true`;
    const where = [];
    if (brandQ) where.push(`a.brand = '${sq(brandQ)}'`);
    if (categoryQ) where.push(`a.subject = '${sq(categoryQ)}'`);
    if (qQ) {
      const s = sq(qQ);
      where.push(`(a.name LIKE '%${s}%' OR CAST(a.nm_id AS TEXT) LIKE '%${s}%' OR COALESCE(a.brand,'') LIKE '%${s}%')`);
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY a.nm_id";
    let rows = [];
    try { rows = await db.prepare(sql).all(); } catch {}
    // has_sales: nm с продажами (за любой период).
    let soldSet = new Set();
    try {
      const sold = await db.prepare(`SELECT DISTINCT nm_id FROM finance_report WHERE quantity > 0`).all();
      soldSet = new Set(sold.map((r) => r.nm_id));
    } catch {}
    for (const r of rows) {
      const key = `wb|${r.nm_id || 0}|0`;
      const ov = await getCostOverride("wb", r.nm_id, null, today);
      const cost = ov ? ov.cost : r.base_cost;
      const groupId = gMem[key] || null;
      wbItems.push({
        platform: "wb", nm_id: r.nm_id, product_id: null,
        name: r.name || String(r.nm_id), brand: r.brand || null,
        category: r.subject || null, im_url: r.im_url || null,
        base_cost: r.base_cost ?? null, cost: cost ?? null,
        cost_source: ov ? "override" : cost != null ? "cogs" : null,
        effective_from: ov ? ov.effective_from : null,
        group_id: groupId, group_name: groupId ? gName[groupId] || null : null,
        status: gStat[key] || "active",
        has_sales: soldSet.has(r.nm_id),
      });
    }
  }

  // --- Ozon: products + cost_overrides (base_cost) ---
  const ozItems = [];
  if (mpQ !== "wb" && mps.includes("ozon")) {
    const db = new DatabaseSync("ozon", { readOnly: true });
    let sql = `SELECT p.product_id, p.name, p.brand, p.category, p.im_url, p.visibility,
                      co.cost AS base_cost
                 FROM products p
                 LEFT JOIN LATERAL (
                   SELECT cost FROM tenant.cost_overrides
                   WHERE product_id = p.product_id AND platform = 'ozon'
                     AND effective_from <= current_date
                   ORDER BY effective_from DESC LIMIT 1
                 ) co ON true`;
    const where = [];
    if (brandQ) where.push(`p.brand = '${sq(brandQ)}'`);
    if (categoryQ) where.push(`p.category = '${sq(categoryQ)}'`);
    if (qQ) {
      const s = sq(qQ);
      where.push(`(p.name LIKE '%${s}%' OR CAST(p.product_id AS TEXT) LIKE '%${s}%' OR COALESCE(p.brand,'') LIKE '%${s}%')`);
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY p.product_id";
    let rows = [];
    try { rows = await db.prepare(sql).all(); } catch {}
    let soldSet = new Set();
    try {
      const sold = await db.prepare(`SELECT DISTINCT product_id FROM sales WHERE qty > 0`).all();
      soldSet = new Set(sold.map((r) => r.product_id));
    } catch {}
    for (const r of rows) {
      const key = `ozon|0|${r.product_id || 0}`;
      const ov = await getCostOverride("ozon", null, r.product_id, today);
      const cost = ov ? ov.cost : r.base_cost;
      const groupId = gMem[key] || null;
      ozItems.push({
        platform: "ozon", nm_id: null, product_id: r.product_id,
        name: r.name || String(r.product_id), brand: r.brand || null,
        category: r.category || null, im_url: r.im_url || null,
        visibility: r.visibility || null,
        base_cost: r.base_cost ?? null, cost: cost ?? null,
        cost_source: ov ? "override" : cost != null ? "cogs" : null,
        effective_from: ov ? ov.effective_from : null,
        group_id: groupId, group_name: groupId ? gName[groupId] || null : null,
        status: gStat[key] || "active",
        has_sales: soldSet.has(r.product_id),
      });
    }
  }

  // --- Объединение ---
  let items = [...wbItems, ...ozItems];

  // Фильтры по group/status (после объединения — это fin-данные).
  if (groupQ && /^\d+$/.test(groupQ)) {
    const gid = Number(groupQ);
    items = items.filter((i) => i.group_id === gid);
  }
  if (statusQ === "active" || statusQ === "inactive") {
    items = items.filter((i) => i.status === statusQ);
  }

  // Фасеты (из исходного объединения до group/status-фильтров).
  const brandsCount = {}, categoriesCount = {};
  for (const it of [...wbItems, ...ozItems]) {
    if (it.brand) brandsCount[it.brand] = (brandsCount[it.brand] || 0) + 1;
    if (it.category) categoriesCount[it.category] = (categoriesCount[it.category] || 0) + 1;
  }
  const facets = {
    brands: Object.entries(brandsCount).map(([brand, n]) => ({ brand, n })).sort((a, b) => b.n - a.n),
    categories: Object.entries(categoriesCount).map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n),
    groups,
  };

  // Итоги (из финальной отфильтрованной выборки).
  const totals = items.reduce((acc, it) => {
    acc.total += 1;
    if (it.cost != null && it.cost > 0) { acc.withCost += 1; acc.avgCostSum += it.cost; }
    if (it.cost_source === "override") acc.overrides += 1;
    if (it.status === "active") acc.active += 1;
    if (it.group_id) acc.grouped += 1;
    return acc;
  }, { total: 0, withCost: 0, avgCostSum: 0, overrides: 0, active: 0, grouped: 0 });
  totals.avgCost = totals.withCost > 0 ? Math.round((totals.avgCostSum / totals.withCost) * 100) / 100 : 0;

  return NextResponse.json({ items, totals, facets, filters: { mp: mpQ, brand: brandQ, group: groupQ, status: statusQ, q: qQ } });
});

// Безопасная строка для inline-SQL (эталон использует sqlSafe).
function sq(v, maxLen = 100) {
  if (!v) return "";
  return String(v).slice(0, maxLen).replace(/'/g, "''");
}

// POST — создать/обновить override себестоимости (замена старого upsert cogs).
// Тело: { platform, nm_id|product_id, cost, effective_from, note }
export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { platform, nm_id, product_id, cost, effective_from, note } = body;
  if (!platform || cost == null || !effective_from) {
    return NextResponse.json({ error: "platform + cost + effective_from required" }, { status: 400 });
  }
  const ov = await upsertCostOverride({ platform, nm_id, product_id, cost, effective_from, note });
  return NextResponse.json({ ok: true, override: ov });
}, { requireRole: 'manager' });
