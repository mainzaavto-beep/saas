// /api/cabinets/[id]/purchases — закупки (CRUD).
// Чистый перенос: tenant.purchases через tenantQuery, метаданные из DatabaseSync('wb').
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const numOr = (v, d = 0) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
function sqlSafe(v, maxLen = 200) {
  if (!v) return "";
  return String(v).slice(0, maxLen).replace(/'/g, "''");
}

// computeExcel: ИТОГО (unit_cost*qty + logistics_rub) — как в эталоне.
function computeTotal(it) {
  const unitCost = numOr(it.unit_cost, numOr(it.unit_cost_est, 0));
  const qty = numOr(it.qty, 0);
  const logRub = numOr(it.logistics_rub, 0);
  return round2(unitCost * qty + logRub);
}

function lifecycleEffective(row) {
  if (row.lifecycle_status) return row.lifecycle_status;
  return row.delivery_dt ? "arrived" : "planned";
}

const SELECT_COLS = `id, nm_id, supplier_name, qty, unit_cost, date,
  unit_cost_yuan, exchange_rate, logistics_yuan, logistics_rub,
  order_dt, delivery_dt, status, source, supplier,
  order_no, unit_cost_est, total_amount,
  plan_order_dt, plan_ship_dt, plan_arrival_dt, lifecycle_status,
  photo_url, source_country, ship_dt,
  prepay_yuan, prepay_rate, logistics_rub_per_unit, pay_status,
  inbound_logistics, paid, note`;

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const fromQ = url.searchParams.get("from") || "";
  const toQ = url.searchParams.get("to") || "";
  const supplierQ = url.searchParams.get("supplier") || "";
  const statusQ = url.searchParams.get("status") || "";
  const qQ = url.searchParams.get("q") || "";

  const conds = ["deleted_at IS NULL"];
  const params = [];
  let pi = 0;
  if (fromQ && /^\d{4}-\d{2}$/.test(fromQ)) { conds.push(`COALESCE(delivery_dt, order_dt, date) >= $${++pi}`); params.push(fromQ); }
  if (toQ && /^\d{4}-\d{2}$/.test(toQ)) { conds.push(`COALESCE(delivery_dt, order_dt, date) <= $${++pi}`); params.push(toQ); }
  if (supplierQ) { conds.push(`supplier_name = $${++pi}`); params.push(supplierQ); }
  if (statusQ === "__null__") conds.push("status IS NULL");
  else if (statusQ) { conds.push(`status = $${++pi}`); params.push(statusQ); }
  if (qQ) { conds.push(`(supplier_name ILIKE $${++pi} OR CAST(nm_id AS TEXT) ILIKE $${++pi} OR order_no ILIKE $${++pi})`); params.push(`%${qQ}%`, `%${qQ}%`, `%${qQ}%`); }
  const where = conds.join(" AND ");

  const items = await tenantQuery(
    `SELECT ${SELECT_COLS} FROM tenant.purchases WHERE ${where}
     ORDER BY COALESCE(delivery_dt, order_dt, date) DESC NULLS LAST, supplier_name`,
    params
  );

  // Фасеты
  const whereNoSup = conds.filter((c) => !c.includes("supplier_name")).join(" AND ");
  const whereNoStat = conds.filter((c) => !c.includes("status")).join(" AND ");
  const suppliers = await tenantQuery(
    `SELECT supplier_name, COUNT(*) AS n FROM tenant.purchases WHERE ${whereNoSup} GROUP BY supplier_name ORDER BY n DESC`
  );
  const statuses = await tenantQuery(
    `SELECT COALESCE(status, '') AS s, COUNT(*) AS n FROM tenant.purchases WHERE ${whereNoStat} GROUP BY 1 ORDER BY n DESC`
  );

  // Метаданные nm_id из articles
  const nmMeta = {};
  const nmIds = [...new Set(items.map((i) => i.nm_id).filter(Boolean))];
  if (nmIds.length) {
    try {
      const db = new DatabaseSync("wb", { readOnly: true });
      const placeholders = nmIds.map((_, i) => `?`).join(",");
      const metaRows = await db.prepare(`SELECT nm_id, name, im_url FROM articles WHERE nm_id IN (${placeholders})`).all(...nmIds);
      for (const m of metaRows) nmMeta[m.nm_id] = { name: m.name, im_url: m.im_url };
    } catch {}
  }

  // Totals
  let parties = 0, qtyTotal = 0, costTotal = 0, logRubTotal = 0, hasNm = 0;
  for (const it of items) {
    parties++;
    qtyTotal += numOr(it.qty, 0);
    costTotal += computeTotal(it);
    logRubTotal += numOr(it.logistics_rub, 0);
    if (it.nm_id != null) hasNm++;
  }

  return NextResponse.json({
    items: items.map((it) => ({ ...it, total: computeTotal(it), lifecycle: lifecycleEffective(it), nm_meta: nmMeta[it.nm_id] || null })),
    totals: { parties, qty: qtyTotal, costTotal: round2(costTotal), logisticsRubTotal: round2(logRubTotal), hasNm },
    facets: { suppliers, statuses },
  });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  if (b.id) {
    // UPDATE
    const sets = [];
    const vals = [];
    for (const k of ["nm_id","supplier_name","qty","unit_cost","date","unit_cost_yuan","exchange_rate",
      "logistics_yuan","logistics_rub","order_dt","delivery_dt","status","source","supplier","order_no",
      "unit_cost_est","total_amount","plan_order_dt","plan_ship_dt","plan_arrival_dt","lifecycle_status",
      "photo_url","source_country","ship_dt","prepay_yuan","prepay_rate","logistics_rub_per_unit",
      "pay_status","inbound_logistics","paid","note"]) {
      if (b[k] !== undefined) { sets.push(`${k} = $${sets.length + 1}`); vals.push(b[k] === "" ? null : b[k]); }
    }
    if (sets.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    vals.push(Number(b.id));
    await tenantQuery(`UPDATE tenant.purchases SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    return NextResponse.json({ ok: true, id: Number(b.id) });
  }
  // INSERT
  const cols = ["cabinet_id"];
  const ph = ["current_setting('app.cabinet_id')::bigint"];
  const vals = [];
  for (const k of ["nm_id","supplier_name","qty","unit_cost","date","unit_cost_yuan","exchange_rate",
    "logistics_yuan","logistics_rub","order_dt","delivery_dt","status","source","supplier","order_no",
    "unit_cost_est","total_amount","plan_order_dt","plan_ship_dt","plan_arrival_dt","lifecycle_status",
    "photo_url","source_country","ship_dt","prepay_yuan","prepay_rate","logistics_rub_per_unit",
    "pay_status","inbound_logistics","paid","note"]) {
    if (b[k] !== undefined) {
      cols.push(k);
      vals.push(b[k] === "" ? null : b[k]);
      ph.push(`$${ph.length}`);
    }
  }
  const rows = await tenantQuery(
    `INSERT INTO tenant.purchases (${cols.join(",")}) VALUES (${ph.join(",")}) RETURNING id`,
    vals
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id });
});

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(`UPDATE tenant.purchases SET deleted_at = now() WHERE id = $1`, [Number(id)]);
  return NextResponse.json({ ok: true });
});
