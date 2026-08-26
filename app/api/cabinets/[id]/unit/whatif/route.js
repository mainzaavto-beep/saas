// /api/cabinets/[id]/unit/whatif — персист строки ПРИКИДКА на /unit.
// POST {platform, itemId, inputs} → upsert в tenant.unit_whatif (миграция 046).
//   inputs=null → сброс (DELETE строки). itemId = nmId (wb) / productId (ozon).
//   inputs — объект с ключами из WHATIF_INPUTS (UnitPage.jsx), значения — числа.
// В отличие от unit/inputs («↧ в факт», построчно key/value) здесь весь
// набор what-if входов на товар хранится одним JSONB-документом.
//
// Пост-ревью (2026-08-26): валидация была нестрогой — Number.isFinite(Number(v))
// проверяла коэрцию, но в БД писался JSON.stringify(inputs) с ИСХОДНЫМИ
// значениями (строка "0.15", true, [5] проходили и ложились в JSONB своим
// типом). Теперь пишем очищенный объект (только Number(v)) и границы: тип
// значения — number|string (не boolean/array/object), диапазон [0, max] из
// того же набора, что в клиентских WHATIF_INPUTS (max в ₽ как есть; для
// asFraction-полей max=100% → 1, т.к. клиент делит на 100 перед отправкой —
// см. setOverride в UnitPage.jsx). Плюс жёсткий потолок на размер inputs —
// 2 КБ сериализованного JSON (реалистичный payload — до 8 коротких пар
// key:number, кратно меньше; 2 КБ — запас, а не расчётный лимит).
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INPUTS_JSON_BYTES = 2048;

// Разрешённые ключи и границы значений — дословно из WHATIF_INPUTS в
// UnitPage.jsx (max в исходных единицах; asFraction: true → max/100).
const ALLOWED_KEYS = {
  wb: {
    priceSeller: { max: 1000000 },
    discount: { max: 1 },
    spp: { max: 1 },
    commissionRate: { max: 1 },
    buyout: { max: 1 },
    adsRate: { max: 1 },
    cost: { max: 1000000 },
    defectRate: { max: 1 },
  },
  ozon: {
    priceOzon: { max: 1000000 },
    discount: { max: 1 },
    commissionRate: { max: 1 },
    logisticsFbo: { max: 100000 },
    adsRate: { max: 1 },
    cost: { max: 1000000 },
  },
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
  if (JSON.stringify(inputs).length > MAX_INPUTS_JSON_BYTES) {
    return NextResponse.json({ error: `inputs превышает ${MAX_INPUTS_JSON_BYTES} байт` }, { status: 400 });
  }

  const allowed = ALLOWED_KEYS[platform];
  const clean = {};
  for (const [key, raw] of Object.entries(inputs)) {
    const bounds = allowed[key];
    if (!bounds) {
      return NextResponse.json({ error: `неизвестный ключ inputs: ${key}` }, { status: 400 });
    }
    // Только number|string — boolean/array/object (в т.ч. null-значение поля) отклоняем
    // явно: Number(true)===1 и Number([5])===5 иначе тихо прошли бы коэрцию.
    if (typeof raw !== "number" && typeof raw !== "string") {
      return NextResponse.json({ error: `inputs.${key} должен быть числом` }, { status: 400 });
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > bounds.max) {
      return NextResponse.json({ error: `inputs.${key} вне диапазона [0, ${bounds.max}]` }, { status: 400 });
    }
    clean[key] = v;
  }

  // Upsert (PK = cabinet_id, platform, item_id). Пишем clean, а не исходный
  // inputs, — гарантия того, что в JSONB лежат только числа.
  await tenantQuery(
    `INSERT INTO tenant.unit_whatif (cabinet_id, platform, item_id, inputs)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3::jsonb)
     ON CONFLICT (cabinet_id, platform, item_id)
     DO UPDATE SET inputs = EXCLUDED.inputs, updated_at = now()`,
    [platform, item, JSON.stringify(clean)]
  );
  return NextResponse.json({ ok: true });
}, { requireRole: "manager" });
