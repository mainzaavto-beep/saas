// /api/cabinets/[id]/self-buyouts — CRUD самовыкупов.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const fromQ = url.searchParams.get("from") || "";
  const toQ = url.searchParams.get("to") || "";

  const conds = [];
  const params = [];
  if (fromQ) { conds.push("claim_dt >= $" + (params.length + 1)); params.push(fromQ); }
  if (toQ) { conds.push("claim_dt <= $" + (params.length + 1)); params.push(toQ); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";

  const items = await tenantQuery(
    `SELECT * FROM tenant.self_buyouts ${where} ORDER BY claim_dt DESC NULLS LAST, id DESC`,
    params
  );

  let totalCost = 0;
  for (const it of items) totalCost += Number(it.total) || 0;

  return NextResponse.json({ items, totals: { count: items.length, total: round2(totalCost) } });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  const cols = ["cabinet_id"];
  const ph = ["current_setting('app.cabinet_id')::bigint"];
  const vals = [];
  for (const k of ["claim_dt","nm_id","seller_article","qty","price","wb_discount","spp",
    "commission_pct","constructor_pct","logistics_unit","buyout_price","tax_pct","total","source"]) {
    if (b[k] !== undefined) {
      cols.push(k);
      vals.push(b[k] === "" ? null : b[k]);
      ph.push(`$${ph.length}`);
    }
  }
  if (b.id) {
    const sets = cols.slice(1).map((c, i) => `${c} = $${i + 1}`).join(", ");
    await tenantQuery(`UPDATE tenant.self_buyouts SET ${sets} WHERE id = $${vals.length + 1}`, [...vals, Number(b.id)]);
    return NextResponse.json({ ok: true, id: Number(b.id) });
  }
  const rows = await tenantQuery(
    `INSERT INTO tenant.self_buyouts (${cols.join(",")}) VALUES (${ph.join(",")}) RETURNING id`,
    vals
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id });
}, { requireRole: 'owner' });

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(`DELETE FROM tenant.self_buyouts WHERE id = $1`, [Number(id)]);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
