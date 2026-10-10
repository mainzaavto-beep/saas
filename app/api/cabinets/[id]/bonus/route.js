// /api/cabinets/[id]/bonus — премия менеджеров площадок (спека 2026-10-08 §4).
// GET: владелец — любой сотрудник программы; менеджер — только своя карточка (user_id из
// сессии, параметр запроса игнорируется — resolveBonusViewer); остальные — 403.
// POST: только владелец. Закрытый месяц — план/исключения/закрытие → 409.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery, query } from "@/lib/db.js";
import { normalizeTaxMode } from "@/lib/tax.js";
import { isValidPeriod, resolveBonusViewer } from "@/lib/bonus.js";
import { loadEmployees, loadCandidates, buildCard, buildLiveCard, isClosed } from "@/lib/bonusData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const todayMsk = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const curPeriod = () => todayMsk().slice(0, 7);
const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const numOr = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));

export const GET = withCabinet(async (req, { cabinet, session }) => {
  const url = new URL(req.url);
  const period = url.searchParams.get("period") || curPeriod();
  if (!isValidPeriod(period)) return bad("period must be YYYY-MM");

  const employees = await loadEmployees();
  const v = resolveBonusViewer({ role: cabinet.role, sessionUserId: session.user_id,
    requestedUserId: url.searchParams.get("user_id"), employees });
  if (v.mode === "denied") return bad("Раздел недоступен", 403);

  const employee = employees.find((e) => e.user_id === v.userId) || null;
  const card = employee
    ? await buildCard({ employee, period, today: todayMsk(), taxMode: normalizeTaxMode(cabinet.shopTax?.[employee.platform]) })
    : null;
  if (v.mode === "self") return NextResponse.json({ mode: "self", period, card });
  const candidates = await loadCandidates(cabinet.cabinet_id);
  return NextResponse.json({ mode: "owner", period, employees, candidates, card });
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json().catch((e) => { console.error("[bonus] POST: тело не JSON", e); return {}; });
  const uid = Number(b.user_id);
  const me = session.user_id;

  if (b.action === "employee_upsert") {
    if (!Number.isInteger(uid) || uid <= 0) return bad("user_id обязателен");
    if (!["wb", "ozon"].includes(b.platform)) return bad("platform must be wb|ozon");
    const mem = await query(`SELECT 1 FROM auth.memberships WHERE cabinet_id = $1 AND user_id = $2`, [cabinet.cabinet_id, uid]);
    if (!mem.length) return bad("пользователь не участник кабинета");
    const salary = numOr(b.salary, 40000), pct = numOr(b.bonus_pct, 0.04), thr = numOr(b.threshold, 0.65);
    if (![salary, pct, thr].every(Number.isFinite) || salary < 0 || pct < 0 || pct > 1 || thr < 0 || thr > 1)
      return bad("оклад ≥ 0, % бонуса и порог — доли 0..1");
    await tenantQuery(
      `INSERT INTO tenant.bonus_employees (cabinet_id, user_id, platform, salary, bonus_pct, threshold, is_active)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (cabinet_id, user_id) DO UPDATE SET platform = EXCLUDED.platform, salary = EXCLUDED.salary,
         bonus_pct = EXCLUDED.bonus_pct, threshold = EXCLUDED.threshold, is_active = EXCLUDED.is_active, updated_at = now()`,
      [uid, b.platform, salary, pct, thr, b.is_active !== false]);
    return NextResponse.json({ ok: true });
  }

  if (b.action === "exclusion_delete") {
    const exId = Number(b.id);
    if (!Number.isInteger(exId) || exId <= 0) return bad("id обязателен");
    const [row] = await tenantQuery(`SELECT user_id, period FROM tenant.bonus_exclusions WHERE id = $1`, [exId]);
    if (!row) return bad("исключение не найдено", 404);
    if (await isClosed(Number(row.user_id), row.period)) return bad("месяц зафиксирован", 409);
    await tenantQuery(`DELETE FROM tenant.bonus_exclusions WHERE id = $1`, [exId]);
    return NextResponse.json({ ok: true });
  }

  // Остальные действия — по сотруднику программы и месяцу.
  if (!Number.isInteger(uid) || uid <= 0) return bad("user_id обязателен");
  if (!isValidPeriod(b.period)) return bad("period must be YYYY-MM");
  const employee = (await loadEmployees()).find((e) => e.user_id === uid);
  if (!employee) return bad("сотрудник не в программе", 404);

  if (b.action === "reopen") {
    await tenantQuery(`DELETE FROM tenant.bonus_closings WHERE user_id = $1 AND period = $2`, [uid, b.period]);
    return NextResponse.json({ ok: true });
  }
  if (await isClosed(uid, b.period)) return bad("месяц зафиксирован — сначала снимите фиксацию", 409);

  if (b.action === "plan_set") {
    const s = Number(b.sales_plan), p = Number(b.profit_plan);
    if (!Number.isFinite(s) || !Number.isFinite(p) || s < 0) return bad("план продаж ≥ 0, план прибыли — число");
    await tenantQuery(
      `INSERT INTO tenant.bonus_plans (cabinet_id, user_id, period, sales_plan, profit_plan, updated_by)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5)
       ON CONFLICT (cabinet_id, user_id, period) DO UPDATE SET sales_plan = EXCLUDED.sales_plan,
         profit_plan = EXCLUDED.profit_plan, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [uid, b.period, s, p, me]);
    return NextResponse.json({ ok: true });
  }

  if (b.action === "exclusion_add") {
    const sku = Number(b.sku_key), so = numOr(b.sales_plan_off, 0), po = numOr(b.profit_plan_off, 0);
    const reason = String(b.reason || "").trim();
    if (!Number.isInteger(sku) || sku <= 0) return bad("sku_key — артикул площадки");
    if (!Number.isFinite(so) || !Number.isFinite(po) || so < 0) return bad("снятый план — числа, продажи ≥ 0");
    if (!reason) return bad("причина обязательна");
    const exists = employee.platform === "wb"
      ? await tenantQuery(`SELECT 1 FROM tenant.wb_articles WHERE nm_id = $1`, [sku])
      : await tenantQuery(`SELECT 1 FROM tenant.ozon_products WHERE product_id = $1`, [sku]);
    if (!exists.length) return bad("артикул не найден на площадке сотрудника");
    await tenantQuery(
      `INSERT INTO tenant.bonus_exclusions (cabinet_id, user_id, period, sku_key, sales_plan_off, profit_plan_off, reason, created_by)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (cabinet_id, user_id, period, sku_key) DO UPDATE SET sales_plan_off = EXCLUDED.sales_plan_off,
         profit_plan_off = EXCLUDED.profit_plan_off, reason = EXCLUDED.reason`,
      [uid, b.period, sku, so, po, reason, me]);
    return NextResponse.json({ ok: true });
  }

  if (b.action === "close") {
    const card = await buildLiveCard({ employee, period: b.period, today: todayMsk(),
      taxMode: normalizeTaxMode(cabinet.shopTax?.[employee.platform]) });
    if (card.status === "no_data") return bad("месяц ещё не начался — фиксировать нечего");
    const inserted = await tenantQuery(
      `INSERT INTO tenant.bonus_closings (cabinet_id, user_id, period, snapshot, closed_by)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3::jsonb, $4)
       ON CONFLICT (cabinet_id, user_id, period) DO NOTHING RETURNING 1`,
      [uid, b.period, JSON.stringify(card), me]);
    if (!inserted.length) return bad("месяц уже зафиксирован", 409);
    return NextResponse.json({ ok: true });
  }

  return bad("unknown action");
}, { requireRole: "owner" });
