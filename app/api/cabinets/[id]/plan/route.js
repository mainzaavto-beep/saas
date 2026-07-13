// /api/cabinets/[id]/plan — CRUD строк sales_plan.
// Перенос data-presenter/api/plan/route.js под tenantQuery (PG+RLS).
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const period = url.searchParams.get("period");
  const platform = url.searchParams.get("platform");
  const includeArchived = url.searchParams.get("archived") === "1";

  const conds = ["status != 'deleted'"];
  const params = [];
  if (!includeArchived) conds.push("status = 'active'");
  if (period) { conds.push("period = $" + (params.length + 1)); params.push(period); }
  if (platform) { conds.push("platform = $" + (params.length + 1)); params.push(platform); }

  const rows = await tenantQuery(
    `SELECT id, period, platform, nm_id, product_id, sku_label, category,
            qty_plan, revenue_plan, drr_plan, margin_plan_pct, buyout_rate_plan,
            price_no_spp, cost_plan, launch_date, is_new_sku, status, approved,
            note, created_at, updated_at
     FROM tenant.sales_plan WHERE ${conds.join(" AND ")}
     ORDER BY platform, COALESCE(nm_id, 0), COALESCE(product_id, 0), sku_label`,
    params
  );
  return NextResponse.json({ count: rows.length, items: rows });
});

function _toFraction(v) {
  if (v == null || v === "") return 0;
  let s = String(v).trim().replace("%", "");
  let n = Number(s);
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) > 1) n = n / 100;
  return n;
}

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  for (const f of ["period", "platform", "sku_label"]) {
    if (body[f] == null || body[f] === "") return NextResponse.json({ error: `Missing field: ${f}` }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(body.period)) return NextResponse.json({ error: "period must be YYYY-MM" }, { status: 400 });
  if (!["WB", "OZON", "YA"].includes(body.platform)) return NextResponse.json({ error: "platform must be WB|OZON|YA" }, { status: 400 });

  const nmId = body.nm_id != null && body.nm_id !== "" ? Number(body.nm_id) : null;
  const productId = body.product_id != null && body.product_id !== "" ? Number(body.product_id) : null;
  const skuLabel = String(body.sku_label);
  const category = body.category ?? null;
  const qtyPlan = Number(body.qty_plan) || 0;
  const priceNoSpp = body.price_no_spp != null && body.price_no_spp !== "" ? Number(body.price_no_spp) : null;
  let revenuePlan;
  if (priceNoSpp != null && Number.isFinite(priceNoSpp)) {
    revenuePlan = Math.round(qtyPlan * priceNoSpp * 100) / 100;
  } else {
    revenuePlan = Number(body.revenue_plan) || 0;
  }
  const costPlan = body.cost_plan != null && body.cost_plan !== "" ? Number(body.cost_plan) : null;
  const drrPlan = _toFraction(body.drr_plan);
  const marginPlanPct = _toFraction(body.margin_plan_pct);
  const buyoutRatePlan = body.buyout_rate_plan == null ? null : _toFraction(body.buyout_rate_plan);
  const launchDate = body.launch_date ?? null;
  const isNewSku = body.is_new_sku ? 1 : 0;
  const status = body.status ?? "active";
  const approved = body.approved ? 1 : 0;
  const note = body.note ?? null;

  const vals = [body.period, body.platform, nmId, productId, skuLabel, category,
    qtyPlan, revenuePlan, drrPlan, marginPlanPct, buyoutRatePlan, priceNoSpp, costPlan,
    launchDate, isNewSku, status, approved, note];

  if (body.id) {
    await tenantQuery(
      `UPDATE tenant.sales_plan SET
        sku_label=$1, category=$2, qty_plan=$3, revenue_plan=$4, drr_plan=$5,
        margin_plan_pct=$6, buyout_rate_plan=$7, price_no_spp=$8, cost_plan=$9,
        launch_date=$10, is_new_sku=$11, status=$12, approved=$13,
        note=$14, product_id=$15, updated_at=now()
       WHERE id=$16`,
      [skuLabel, category, qtyPlan, revenuePlan, drrPlan, marginPlanPct, buyoutRatePlan,
       priceNoSpp, costPlan, launchDate, isNewSku, status, approved, note, productId, Number(body.id)]
    );
    return NextResponse.json({ ok: true, id: body.id });
  }

  // Check existing for upsert
  let existing = null;
  if (nmId != null) {
    existing = await tenantQuery(`SELECT id FROM tenant.sales_plan WHERE period=$1 AND platform=$2 AND nm_id=$3 AND status='active'`, [body.period, body.platform, nmId]);
  } else if (productId != null) {
    existing = await tenantQuery(`SELECT id FROM tenant.sales_plan WHERE period=$1 AND platform=$2 AND product_id=$3 AND status='active'`, [body.period, body.platform, productId]);
  } else {
    existing = await tenantQuery(`SELECT id FROM tenant.sales_plan WHERE period=$1 AND platform=$2 AND sku_label=$3 AND nm_id IS NULL AND product_id IS NULL AND status='active'`, [body.period, body.platform, skuLabel]);
  }

  if (existing.length > 0) {
    await tenantQuery(
      `UPDATE tenant.sales_plan SET
        category=$1, qty_plan=$2, revenue_plan=$3, drr_plan=$4, margin_plan_pct=$5,
        buyout_rate_plan=$6, price_no_spp=$7, cost_plan=$8,
        launch_date=$9, is_new_sku=$10, approved=$11, note=$12, updated_at=now()
       WHERE id=$13`,
      [category, qtyPlan, revenuePlan, drrPlan, marginPlanPct, buyoutRatePlan,
       priceNoSpp, costPlan, launchDate, isNewSku, approved, note, existing[0].id]
    );
    return NextResponse.json({ ok: true, id: existing[0].id, updated: true });
  }

  const rows = await tenantQuery(
    `INSERT INTO tenant.sales_plan (cabinet_id, period, platform, nm_id, product_id, sku_label, category,
       qty_plan, revenue_plan, drr_plan, margin_plan_pct, buyout_rate_plan, price_no_spp, cost_plan,
       launch_date, is_new_sku, status, approved, note, created_at, updated_at)
     VALUES (current_setting('app.cabinet_id')::bigint,
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now(), now())
     RETURNING id`,
    vals
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id, created: true });
});

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(`UPDATE tenant.sales_plan SET status='archived', updated_at=now() WHERE id=$1`, [id]);
  return NextResponse.json({ ok: true });
});
