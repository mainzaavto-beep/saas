// /api/cabinets/[id]/settings — настройки проекта (название, налоги).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { query } from "@/lib/db.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  return NextResponse.json({
    cabinet_id: cabinet.cabinet_id,
    display_name: cabinet.display_name,
    tax_mode: cabinet.tax_mode || { usn_pct: 6, vat: false },
    marketplaces: cabinet.marketplaces || [],
    status: cabinet.status,
  });
});

export const PUT = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  const sets = [];
  const vals = [];
  let i = 0;
  if (b.display_name !== undefined) { sets.push(`display_name = $${++i}`); vals.push(b.display_name); }
  if (b.tax_mode !== undefined) { sets.push(`tax_mode = $${++i}`); vals.push(JSON.stringify(b.tax_mode)); }
  if (!sets.length) return NextResponse.json({ error: "no fields" }, { status: 400 });
  vals.push(cabinet.cabinet_id);
  await query(`UPDATE auth.cabinets SET ${sets.join(", ")} WHERE cabinet_id = $${vals.length}`, vals);
  return NextResponse.json({ ok: true });
});
