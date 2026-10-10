// /api/cabinets/[id]/plan/targets — KPI-цели квартал/год (заявка №29).
//
// Вкладка «Квартал-Год» страницы «План продаж»: целевые показатели на период
// вида 'YYYY-QN' (квартал) по платформе. Хранятся в tenant.plan_targets.
//
// КОНВЕРСИЯ ПРОЦЕНТ↔ДОЛЯ: в БД margin_target_pct/drr_target — ДОЛИ (0.09=9%),
// как и sales_plan.margin_plan_pct. Фронт (TargetField) отображает ПРОЦЕНТЫ
// (×100) и шлёт проценты. PUT применяет _toFraction (abs>1 → /100) — тот же
// хелпер, что в plan/route.js. GET отдаёт доли; фронт делает ×100 для UI.
// Без этого цель 9% сохранялась бы как 9 (=900%) и показывалась 900%.
//
// КОНТРАКТ фронт↔API сверен с PlanPage.jsx:KpiTargetsEditor.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function _toFraction(v) {
  if (v == null || v === "") return 0;
  let s = String(v).trim().replace("%", "");
  let n = Number(s);
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) > 1) n = n / 100;
  return n;
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const targetPeriod = url.searchParams.get("period"); // 'YYYY-QN'
  const platform = url.searchParams.get("platform");
  if (!targetPeriod || !/^\d{4}-Q[1-4]$/.test(targetPeriod)) {
    return NextResponse.json({ error: "period must be YYYY-QN" }, { status: 400 });
  }
  if (!platform || !["WB", "OZON", "YA"].includes(platform)) {
    return NextResponse.json({ error: "platform must be WB|OZON|YA" }, { status: 400 });
  }

  const rows = await tenantQuery(
    `SELECT target_period, platform, revenue_target, margin_target_pct,
            profit_target, drr_target, note, updated_at
     FROM tenant.plan_targets
     WHERE target_period = $1 AND platform = $2`,
    [targetPeriod, platform]
  );
  return NextResponse.json({ count: rows.length, items: rows });
});

export const PUT = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  for (const f of ["target_period", "platform"]) {
    if (body[f] == null || body[f] === "") return NextResponse.json({ error: `Missing field: ${f}` }, { status: 400 });
  }
  if (!/^\d{4}-Q[1-4]$/.test(body.target_period)) {
    return NextResponse.json({ error: "target_period must be YYYY-QN" }, { status: 400 });
  }
  if (!["WB", "OZON", "YA"].includes(body.platform)) {
    return NextResponse.json({ error: "platform must be WB|OZON|YA" }, { status: 400 });
  }

  const revenueTarget = Number(body.revenue_target) || 0;
  const marginTargetPct = _toFraction(body.margin_target_pct);
  const profitTarget = Number(body.profit_target) || 0;
  const drrTarget = _toFraction(body.drr_target);
  const note = body.note ?? null;

  await tenantQuery(
    `INSERT INTO tenant.plan_targets (cabinet_id, target_period, platform,
        revenue_target, margin_target_pct, profit_target, drr_target, note, updated_at)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (cabinet_id, target_period, platform) DO UPDATE SET
        revenue_target = EXCLUDED.revenue_target,
        margin_target_pct = EXCLUDED.margin_target_pct,
        profit_target = EXCLUDED.profit_target,
        drr_target = EXCLUDED.drr_target,
        note = EXCLUDED.note,
        updated_at = now()`,
    [body.target_period, body.platform, revenueTarget, marginTargetPct, profitTarget, drrTarget, note]
  );
  return NextResponse.json({ ok: true });
}, { requireRole: 'manager' });
