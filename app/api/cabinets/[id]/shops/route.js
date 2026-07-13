// /api/cabinets/[id]/shops — управление магазинами проекта.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { query } from "@/lib/db.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await query(
    `SELECT shop_id, mp_code, shop_name, legal_name,
            CASE WHEN api_creds_enc IS NOT NULL THEN true ELSE false END AS has_creds,
            is_active, created_at
     FROM auth.shops WHERE cabinet_id = $1 ORDER BY shop_id`,
    [cabinet.cabinet_id]
  );
  return NextResponse.json({ items: rows });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  if (!b.mp_code) return NextResponse.json({ error: "mp_code required" }, { status: 400 });

  // Шифрование API-кредов если есть.
  let apiCredsEnc = null;
  if (b.api_creds && Object.keys(b.api_creds).length > 0) {
    const masterKey = process.env.SAAS_CRED_MASTER_KEY;
    if (masterKey) {
      const rows = await query(`SELECT pgp_sym_encrypt($1, $2) AS enc`, [JSON.stringify(b.api_creds), masterKey]);
      apiCredsEnc = rows[0]?.enc;
    }
  }
  // Метаданные (не секретные).
  const apiMeta = {};
  if (b.api_creds) {
    for (const [mp, creds] of Object.entries(b.api_creds)) {
      apiMeta[mp] = {};
      for (const k of Object.keys(creds)) apiMeta[mp][`has_${k}`] = true;
    }
  }

  const rows = await query(
    `INSERT INTO auth.shops (cabinet_id, mp_code, shop_name, legal_name, api_creds, api_creds_enc)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING shop_id`,
    [cabinet.cabinet_id, b.mp_code, b.shop_name || null, b.legal_name || null,
     JSON.stringify(apiMeta), apiCredsEnc]
  );
  return NextResponse.json({ ok: true, shop_id: rows[0]?.shop_id });
});

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const shopId = url.searchParams.get("shop_id");
  if (!shopId) return NextResponse.json({ error: "shop_id required" }, { status: 400 });
  await query(`DELETE FROM auth.shops WHERE shop_id = $1 AND cabinet_id = $2`, [Number(shopId), cabinet.cabinet_id]);
  return NextResponse.json({ ok: true });
});
