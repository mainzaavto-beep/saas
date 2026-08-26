// /api/cabinets/[id]/unit/whatif — персист строки ПРИКИДКА на /unit.
// POST {platform, itemId, inputs} → upsert в tenant.unit_whatif (миграция 046).
//   inputs=null → сброс (DELETE строки). itemId = nmId (wb) / productId (ozon).
//   inputs — объект с ключами из WHATIF_INPUTS (UnitPage.jsx), значения — числа.
// В отличие от unit/inputs («↧ в факт», построчно key/value) здесь весь
// набор what-if входов на товар хранится одним JSONB-документом.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Разрешённые ключи — дословно из WHATIF_INPUTS в UnitPage.jsx.
const ALLOWED_KEYS = {
  wb: new Set(["priceSeller", "discount", "spp", "commissionRate", "buyout", "adsRate", "cost", "defectRate"]),
  ozon: new Set(["priceOzon", "discount", "commissionRate", "logisticsFbo", "adsRate", "cost"]),
};

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { platform, itemId, inputs } = body;

  if (platform !== "wb" && platform !== "ozon") {
    return NextResponse.json({ error: "platform должен быть 'wb' или 'ozon'" }, { status: 400 });
  }
  const item = Number(itemId);
  if (!Number.isFinite(item)) {
    return NextResponse.json({ error: "itemId должен быть числом" }, { status: 400 });
  }

  if (inputs == null) {
    // Сброс — удалить строку.
    await tenantQuery(
      `DELETE FROM tenant.unit_whatif WHERE platform = $1 AND item_id = $2`,
      [platform, item]
    );
    return NextResponse.json({ ok: true, cleared: true });
  }

  if (typeof inputs !== "object" || Array.isArray(inputs)) {
    return NextResponse.json({ error: "inputs должен быть объектом или null" }, { status: 400 });
  }
  const allowed = ALLOWED_KEYS[platform];
  for (const [key, value] of Object.entries(inputs)) {
    if (!allowed.has(key)) {
      return NextResponse.json({ error: `неизвестный ключ inputs: ${key}` }, { status: 400 });
    }
    if (!Number.isFinite(Number(value))) {
      return NextResponse.json({ error: `inputs.${key} должен быть числом` }, { status: 400 });
    }
  }

  // Upsert (PK = cabinet_id, platform, item_id).
  await tenantQuery(
    `INSERT INTO tenant.unit_whatif (cabinet_id, platform, item_id, inputs)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3::jsonb)
     ON CONFLICT (cabinet_id, platform, item_id)
     DO UPDATE SET inputs = EXCLUDED.inputs, updated_at = now()`,
    [platform, item, JSON.stringify(inputs)]
  );
  return NextResponse.json({ ok: true });
}, { requireRole: "manager" });
