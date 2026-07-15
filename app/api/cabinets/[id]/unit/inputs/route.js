// /api/cabinets/[id]/unit/inputs — ручные overrides для what-if («↧ в факт»).
// GET  ?platform=wb|ozon → {rows} из tenant.unit_inputs (RLS по cabinet)
// POST {platform, sku, key, value} → upsert в tenant.unit_inputs.
//   value=null = сброс (DELETE). key = имя поля из lib/unit.js (spp, cost, ...).
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") || "";
  const rows = await tenantQuery(
    `SELECT platform, sku, key, value, note, updated_at FROM tenant.unit_inputs
     ${platform ? "WHERE platform = $1" : ""} ORDER BY platform, sku, key`,
    platform ? [platform] : []
  );
  return NextResponse.json({ rows });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { platform, sku, key, value, note } = body;
  if (!platform || !sku || !key) {
    return NextResponse.json({ error: "platform + sku + key required" }, { status: 400 });
  }
  if (value == null) {
    // Сброс — удалить строку.
    await tenantQuery(
      `DELETE FROM tenant.unit_inputs WHERE platform = $1 AND sku = $2 AND key = $3`,
      [String(platform), String(sku), String(key)]
    );
    return NextResponse.json({ ok: true, cleared: true });
  }
  // Upsert (PK = cabinet_id, platform, sku, key).
  await tenantQuery(
    `INSERT INTO tenant.unit_inputs (cabinet_id, platform, sku, key, value, note)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5)
     ON CONFLICT (cabinet_id, platform, sku, key)
     DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note, updated_at = now()`,
    [String(platform), String(sku), String(key), Number(value), note ? String(note) : null]
  );
  return NextResponse.json({ ok: true });
}, { requireRole: 'manager' });
