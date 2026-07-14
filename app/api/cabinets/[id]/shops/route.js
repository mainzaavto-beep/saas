// /api/cabinets/[id]/shops — управление магазинами проекта.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { query } from "@/lib/db.js";
import { normalizeTaxMode } from "@/lib/tax.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await query(
    `SELECT shop_id, mp_code, shop_name, legal_name, tax_mode,
            CASE WHEN api_creds_enc IS NOT NULL THEN true ELSE false END AS has_creds,
            is_active, created_at
     FROM auth.shops WHERE cabinet_id = $1 ORDER BY shop_id`,
    [cabinet.cabinet_id]
  );
  // Нормализовать tax_mode для фронта.
  const items = rows.map((r) => ({ ...r, tax_mode: normalizeTaxMode(r.tax_mode) }));
  return NextResponse.json({ items });
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
    `INSERT INTO auth.shops (cabinet_id, mp_code, shop_name, legal_name, api_creds, api_creds_enc, tax_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING shop_id`,
    [cabinet.cabinet_id, b.mp_code, b.shop_name || null, b.legal_name || null,
     JSON.stringify(apiMeta), apiCredsEnc, JSON.stringify(normalizeTaxMode(b.tax_mode))]
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

// PUT — обновить API-ключи и/или налоговый режим магазина.
// Тело: { shop_id, api_creds?, tax_mode? }
export const PUT = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  if (!b.shop_id) return NextResponse.json({ error: "shop_id required" }, { status: 400 });

  const sets = [];
  const vals = [];
  let i = 0;

  // API-креды (шифрование через pgcrypto).
  if (b.api_creds) {
    const encKey = process.env.SAAS_CRED_MASTER_KEY;
    if (!encKey) return NextResponse.json({ error: "SAAS_CRED_MASTER_KEY not set" }, { status: 500 });
    const encRows = await query(`SELECT pgp_sym_encrypt($1, $2) AS enc`, [JSON.stringify(b.api_creds), encKey]);
    const apiCredsEnc = encRows[0]?.enc;
    const apiMeta = {};
    for (const [mp, creds] of Object.entries(b.api_creds)) {
      apiMeta[mp] = {};
      for (const k of Object.keys(creds)) apiMeta[mp][`has_${k}`] = true;
    }
    sets.push(`api_creds = $${++i}`); vals.push(JSON.stringify(apiMeta));
    sets.push(`api_creds_enc = $${++i}`); vals.push(apiCredsEnc);
  }

  // Налоговый режим.
  if (b.tax_mode !== undefined) {
    sets.push(`tax_mode = $${++i}`);
    vals.push(JSON.stringify(normalizeTaxMode(b.tax_mode)));
  }

  if (!sets.length) return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  vals.push(Number(b.shop_id), cabinet.cabinet_id);
  await query(
    `UPDATE auth.shops SET ${sets.join(", ")} WHERE shop_id = $${vals.length - 1} AND cabinet_id = $${vals.length}`,
    vals
  );
  return NextResponse.json({ ok: true });
});
