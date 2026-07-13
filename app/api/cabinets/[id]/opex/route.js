// /api/cabinets/[id]/opex — CRUD сопутствующих расходов.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const periodQ = url.searchParams.get("period") || "";
  const categoryQ = url.searchParams.get("category") || "";
  const domainQ = url.searchParams.get("domain") || "";

  const conds = ["status != 'deleted'"];
  const params = [];
  if (periodQ) { conds.push("period = $" + (params.length + 1)); params.push(periodQ); }
  if (categoryQ) { conds.push("category = $" + (params.length + 1)); params.push(categoryQ); }
  if (domainQ) { conds.push("domain = $" + (params.length + 1)); params.push(domainQ); }

  const items = await tenantQuery(
    `SELECT id, period, category, amount, note, status, counterparty, op_date,
            domain, source, included_in_cogs, created_at, updated_at
     FROM tenant.opex WHERE ${conds.join(" AND ")}
     ORDER BY period DESC, category, op_date DESC NULLS LAST`,
    params
  );
  // Фасеты
  const categories = await tenantQuery(
    `SELECT category, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total
     FROM tenant.opex WHERE status = 'active' GROUP BY category ORDER BY total DESC`
  );
  // Totals
  let total = 0;
  for (const it of items) total += Number(it.amount) || 0;
  return NextResponse.json({ items, totals: { count: items.length, total: round2(total) }, facets: { categories } });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  const cols = ["cabinet_id"];
  const ph = ["current_setting('app.cabinet_id')::bigint"];
  const vals = [];
  for (const k of ["period","category","amount","note","status","counterparty","op_date",
    "domain","source","included_in_cogs"]) {
    if (b[k] !== undefined) {
      cols.push(k);
      vals.push(b[k] === "" ? null : b[k]);
      ph.push(`$${ph.length}`);
    }
  }
  if (b.id) {
    const sets = cols.slice(1).map((c, i) => `${c} = $${i + 1}`).join(", ");
    await tenantQuery(`UPDATE tenant.opex SET ${sets}, updated_at = now() WHERE id = $${vals.length + 1}`, [...vals, Number(b.id)]);
    return NextResponse.json({ ok: true, id: Number(b.id) });
  }
  const rows = await tenantQuery(
    `INSERT INTO tenant.opex (${cols.join(",")}) VALUES (${ph.join(",")}) RETURNING id`,
    vals
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id });
});

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(`UPDATE tenant.opex SET status = 'deleted', updated_at = now() WHERE id = $1`, [Number(id)]);
  return NextResponse.json({ ok: true });
});
