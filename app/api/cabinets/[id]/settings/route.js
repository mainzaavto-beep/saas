// /api/cabinets/[id]/settings — настройки проекта (название, внешние ключи).
// Налоги теперь настраиваются на каждый магазин (auth.shops.tax_mode) — см. /shops.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { query } from "@/lib/db.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  // external_keys хранит только флаги (has_mpstats), не сами ключи.
  // settings (JSONB, миграция 055) — прочие настройки кабинета; пока это пороги
  // планирования поставок (см. lib/supplyPlanData.js readSupplySettings).
  const rows = await query(
    `SELECT external_keys, settings FROM auth.cabinets WHERE cabinet_id = $1`,
    [cabinet.cabinet_id]
  );
  const ext = rows[0]?.external_keys || {};
  const supply = readSupplyDays(rows[0]?.settings);
  return NextResponse.json({
    cabinet_id: cabinet.cabinet_id,
    display_name: cabinet.display_name,
    marketplaces: cabinet.marketplaces || [],
    status: cabinet.status,
    mpstats_token: ext.has_mpstats ? "••••••••" : "", // маска, не отдаём ключ
    supply_target_days: supply.target,
    supply_min_days: supply.min,
  });
});

// Пороги поставок из settings с дефолтами 30/14 (дубль дефолтов в
// lib/supplyPlanData.js — там же контракт зажима 1..365).
const SUPPLY_DEFAULTS = { target: 30, min: 14 };
function readSupplyDays(settings) {
  const s = settings || {};
  const t = Number(s.supply_target_days);
  const m = Number(s.supply_min_days);
  return {
    target: Number.isFinite(t) ? Math.round(t) : SUPPLY_DEFAULTS.target,
    min: Number.isFinite(m) ? Math.round(m) : SUPPLY_DEFAULTS.min,
  };
}

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
      // ::text — серверный cast bytea→text в hex-форму ('\xc30d...'), совместимый с
      // приёмником to_json($N::text). Без cast node-pg шлёт сырой bytea-буфер в text
      // → «invalid byte sequence for encoding "UTF8"». Тот же root cause, что в shops/route.js.
      const encRows = await query(`SELECT pgp_sym_encrypt($1, $2)::text AS enc`, [b.mpstats_token, encKey]);
      // Храним зашифрованный ключ + флаг в external_keys.
      sets.push(`external_keys = COALESCE(external_keys, '{}'::jsonb) || jsonb_build_object('has_mpstats', true, 'mpstats_enc', to_json($${++i}::text))`);
      vals.push(encRows[0]?.enc?.toString() || "");
    }
  }
  // Пороги планирования поставок → auth.cabinets.settings (JSONB, миграция 055).
  // Целые 1..365, минимальный запас строго меньше целевого (иначе рекомендация
  // «дозаказать» появлялась бы ровно там, где запас уже целевой).
  if (b.supply_target_days !== undefined || b.supply_min_days !== undefined) {
    const cur = readSupplyDays(
      (await query(`SELECT settings FROM auth.cabinets WHERE cabinet_id = $1`, [cabinet.cabinet_id]))[0]?.settings
    );
    const target = b.supply_target_days !== undefined ? Number(b.supply_target_days) : cur.target;
    const min = b.supply_min_days !== undefined ? Number(b.supply_min_days) : cur.min;
    for (const [name, v] of [["supply_target_days", target], ["supply_min_days", min]]) {
      if (!Number.isInteger(v) || v < 1 || v > 365) {
        return NextResponse.json({ error: `${name}: ожидается целое от 1 до 365` }, { status: 400 });
      }
    }
    if (min >= target) {
      return NextResponse.json(
        { error: "минимальный запас должен быть меньше целевого" }, { status: 400 }
      );
    }
    sets.push(`settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('supply_target_days', $${++i}::int, 'supply_min_days', $${++i}::int)`);
    vals.push(target, min);
  }

  if (!sets.length) return NextResponse.json({ error: "no fields" }, { status: 400 });
  vals.push(cabinet.cabinet_id);
  await query(`UPDATE auth.cabinets SET ${sets.join(", ")} WHERE cabinet_id = $${vals.length}`, vals);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
