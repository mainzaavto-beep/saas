// /api/cabinets/[id]/settings — настройки проекта (название, внешние ключи).
// Налоги теперь настраиваются на каждый магазин (auth.shops.tax_mode) — см. /shops.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { query } from "@/lib/db.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  // external_keys хранит только флаги (has_mpstats), не сами ключи.
  const rows = await query(`SELECT external_keys FROM auth.cabinets WHERE cabinet_id = $1`, [cabinet.cabinet_id]);
  const ext = rows[0]?.external_keys || {};
  return NextResponse.json({
    cabinet_id: cabinet.cabinet_id,
    display_name: cabinet.display_name,
    marketplaces: cabinet.marketplaces || [],
    status: cabinet.status,
    mpstats_token: ext.has_mpstats ? "••••••••" : "", // маска, не отдаём ключ
  });
});

export const PUT = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  const sets = [];
  const vals = [];
  let i = 0;
  if (b.display_name !== undefined) { sets.push(`display_name = $${++i}`); vals.push(b.display_name); }
  // MPStats — шифруем если передан (не маска).
  if (b.mpstats_token !== undefined && b.mpstats_token !== "" && !b.mpstats_token.startsWith("•")) {
    const encKey = process.env.SAAS_CRED_MASTER_KEY;
    if (encKey) {
      const encRows = await query(`SELECT pgp_sym_encrypt($1, $2) AS enc`, [b.mpstats_token, encKey]);
      // Храним зашифрованный ключ + флаг в external_keys.
      sets.push(`external_keys = COALESCE(external_keys, '{}'::jsonb) || jsonb_build_object('has_mpstats', true, 'mpstats_enc', to_json($${++i}::text))`);
      vals.push(encRows[0]?.enc?.toString() || "");
    }
  }
  if (!sets.length) return NextResponse.json({ error: "no fields" }, { status: 400 });
  vals.push(cabinet.cabinet_id);
  await query(`UPDATE auth.cabinets SET ${sets.join(", ")} WHERE cabinet_id = $${vals.length}`, vals);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
