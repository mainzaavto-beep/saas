// /api/cabinets/[id]/kpi — «Дашборд показателей» (15.10.2026).
// GET ?from&to (YYYY-MM-DD, дефолт 7 дн по вчера) &shops=id,id &brands=… &cats=… &skus=wb:1,ozon:2
//   → { period, prevPeriod, platforms, productFilter, tiles, catalog, layout, options, errors }.
// POST { action: "save_layout", layout } | { action: "reset_layout" } — личный вид пользователя
//   (tenant.kpi_dashboard_prefs, миграция 068); user_id — только из сессии, роль не требуется.
// Данные — lib/kpiDashboardData.js, плитки — lib/kpiDashboard.js (канон, без своих формул).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { parseKpiQuery, loadKpiDashboard, readLayout, saveLayout, resetLayout } from "@/lib/kpiDashboardData.js";
import { buildTiles, CATALOG } from "@/lib/kpiDashboard.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet, session }) => {
  try {
    const opts = parseKpiQuery(new URL(req.url).searchParams);
    const d = await loadKpiDashboard(cabinet, opts);
    const tiles = buildTiles({ cur: d.cur, prev: d.prev, productFilter: d.productFilter, errors: d.errors, opexUnavailable: d.platformScoped });
    const layout = await readLayout(cabinet.cabinet_id, session.user_id);
    return NextResponse.json({
      period: d.period, prevPeriod: d.prevPeriod, platforms: d.platforms, productFilter: d.productFilter,
      tiles, catalog: CATALOG.map((t) => ({ key: t.key, title: t.title })), layout, options: d.options, errors: d.errors,
    });
  } catch (e) {
    console.error("kpi GET:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "save_layout") {
      const layout = await saveLayout(cabinet.cabinet_id, session.user_id, body.layout);
      return NextResponse.json({ ok: true, layout });
    }
    if (body.action === "reset_layout") {
      const layout = await resetLayout(cabinet.cabinet_id, session.user_id);
      return NextResponse.json({ ok: true, layout });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    console.error("kpi POST:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
