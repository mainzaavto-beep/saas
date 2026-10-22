// /api/cabinets/[id]/cost-calc — «Калькулятор себестоимости» (22.10.2026, спека
// docs/superpowers/specs/2026-10-22-cost-calculator-design.md).
// GET → { items: [ввод + result], defaults, role } — сохранённые расчёты, свежие сверху;
//   defaults — курсы/ставки/логистика из последнего сохранённого (подстановка в новый расчёт).
// POST (manager) { action: "save", id?, ...ввод } — без id создаёт, с id обновляет → { ok, id };
//   { action: "delete", id } → { ok }. Результат не храним — всегда calcCost (lib/costCalc.js).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { calcCost, parseCalcInput, CALC_FIELDS } from "@/lib/costCalc.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_KEYS = ["china_delivery_cny", "cargo_usd_per_kg", "ff_logistics_rub", "rate_cny", "rate_usd"];
const bad = (error, status = 400) => NextResponse.json({ error }, { status });

function toItem(r) {
  const it = { id: Number(r.id), name: r.name, note: r.note, created_at: r.created_at, updated_at: r.updated_at };
  for (const k of CALC_FIELDS) it[k] = Number(r[k]);
  it.result = calcCost(it);
  return it;
}

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const rows = await tenantQuery(
      `SELECT id, name, note, created_at, updated_at, ${CALC_FIELDS.join(", ")}
       FROM tenant.cost_calcs ORDER BY updated_at DESC, id DESC LIMIT 1000`);
    const items = rows.map(toItem);
    const defaults = items[0] ? Object.fromEntries(DEFAULT_KEYS.map((k) => [k, items[0][k]])) : null;
    return NextResponse.json({ items, defaults, role: cabinet.role });
  } catch (e) {
    console.error("cost-calc GET:", e);
    return bad(String(e?.message || e), 500);
  }
});

export const POST = withCabinet(async (req, { session }) => {
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "delete") {
      const id = Number(b.id);
      if (!Number.isSafeInteger(id) || id <= 0) return bad("id обязателен");
      const r = await tenantQuery(`DELETE FROM tenant.cost_calcs WHERE id = $1 RETURNING id`, [id]);
      return r.length ? NextResponse.json({ ok: true }) : bad("расчёт не найден", 404);
    }
    if (b.action === "save") {
      const p = parseCalcInput(b);
      if (p.error) return bad(p.error);
      const v = p.value;
      const vals = [v.name, v.note, ...CALC_FIELDS.map((k) => v[k])];
      if (b.id != null && b.id !== "") {
        const id = Number(b.id);
        if (!Number.isSafeInteger(id) || id <= 0) return bad("некорректный id");
        const set = ["name", "note", ...CALC_FIELDS].map((k, i) => `${k} = $${i + 1}`).join(", ");
        const r = await tenantQuery(
          `UPDATE tenant.cost_calcs SET ${set}, updated_at = now() WHERE id = $${vals.length + 1} RETURNING id`,
          [...vals, id]);
        return r.length ? NextResponse.json({ ok: true, id }) : bad("расчёт не найден", 404);
      }
      const cols = ["name", "note", ...CALC_FIELDS];
      const r = await tenantQuery(
        `INSERT INTO tenant.cost_calcs (cabinet_id, ${cols.join(", ")}, created_by)
         VALUES (current_setting('app.cabinet_id')::bigint, ${cols.map((_, i) => `$${i + 1}`).join(", ")}, $${cols.length + 1})
         RETURNING id`, [...vals, session.user_id]);
      return NextResponse.json({ ok: true, id: Number(r[0].id) });
    }
    return bad("unknown action");
  } catch (e) {
    console.error("cost-calc POST:", e);
    return bad(String(e?.message || e), 500);
  }
}, { requireRole: "manager" });
