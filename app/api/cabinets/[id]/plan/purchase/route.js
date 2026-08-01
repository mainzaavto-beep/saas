// /api/cabinets/[id]/plan/purchase — потребность в закупке по SKU (заявка №29).
//
// Вкладка «Потребность» страницы «План продаж»: сколько докупить на горизонте
// покрытия, чтобы выполнить план продаж.
//
// Формула (эталон fin/plan.py:purchase_need):
//   потребность шт = план продаж(шт/мес) × (coverage_days / 30)
//   к закупке шт   = max(0, потребность − остаток_сейчас)
//   бюджет руб     = к_закупке × себестоимость (cost_overrides; нет → 0)
//   дни до OOS     = остаток / (план_шт/30)   (null если план=0)
//
// Источники остатков (сверено с /api/mp-stock):
//   WB:    daily_stock (СНАПШОТ последней даты), Σ quantity_full по nm_id.
//   OZON:  daily_stock, Σ (fbo_present − fbo_reserved) по product_id.
// Источник себестоимости: tenant.cost_overrides (единый, с 2026-07-14).
//
// КОНТРАКТ фронт↔API сверен с PlanPage.jsx:Purchase: items[] + totals{}.
import { NextResponse } from "next/server";
import { DatabaseSync, tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const period = url.searchParams.get("period");
  const platform = url.searchParams.get("platform");
  const coverage = Number(url.searchParams.get("coverage")) || 45;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: "period must be YYYY-MM" }, { status: 400 });
  }
  if (!platform || !["WB", "OZON", "YA"].includes(platform)) {
    return NextResponse.json({ error: "platform must be WB|OZON|YA" }, { status: 400 });
  }

  // 1. Строки плана.
  const planRows = await tenantQuery(
    `SELECT id, nm_id, product_id, sku_label, category, platform, qty_plan
     FROM tenant.sales_plan
     WHERE period = $1 AND platform = $2 AND status = 'active'
     ORDER BY COALESCE(nm_id, 0), COALESCE(product_id, 0), sku_label`,
    [period, platform]
  );

  // 2. Остатки: последний снимок по SKU.
  //    WB: MAX(date) → Σ quantity_full. Ozon: MAX(date) → Σ (fbo_present−fbo_reserved).
  let stockMap = {};
  if (platform === "WB") {
    try {
      const db = new DatabaseSync("wb", { readOnly: true });
      const rows = await db.prepare(
        `SELECT ds.nm_id AS nm_id, SUM(ds.quantity_full) AS q
         FROM daily_stock ds
         INNER JOIN (
           SELECT MAX(date) AS d FROM daily_stock
         ) m ON ds.date = m.d
         WHERE ds.nm_id IS NOT NULL
         GROUP BY ds.nm_id`
      ).all();
      for (const r of rows) stockMap[r.nm_id] = r.q || 0;
    } catch {}
  } else if (platform === "OZON") {
    try {
      const db = new DatabaseSync("ozon", { readOnly: true });
      const rows = await db.prepare(
        `SELECT ds.product_id AS product_id, SUM(ds.fbo_present - ds.fbo_reserved) AS q
         FROM daily_stock ds
         INNER JOIN (
           SELECT MAX(date) AS d FROM daily_stock
         ) m ON ds.date = m.d
         WHERE ds.product_id IS NOT NULL
         GROUP BY ds.product_id`
      ).all();
      for (const r of rows) stockMap[r.product_id] = r.q || 0;
    } catch {}
  }

  // 3. Себестоимость единицы (актуальный override на сегодня).
  let costMap = {};
  try {
    const platKey = platform === "OZON" ? "ozon" : "wb";
    const rows = await tenantQuery(
      `SELECT DISTINCT ON (nm_id, product_id) nm_id, product_id, cost
       FROM tenant.cost_overrides
       WHERE platform = $1 AND effective_from <= current_date
       ORDER BY nm_id, product_id, effective_from DESC`,
      [platKey]
    );
    for (const r of rows) {
      const k = platform === "OZON" ? r.product_id : r.nm_id;
      if (k != null && r.cost > 0) costMap[k] = Number(r.cost);
    }
  } catch {}

  // 4. Сборка потребности.
  const items = planRows.map((row) => {
    const qtyPlan = Number(row.qty_plan) || 0;
    const key = platform === "OZON" ? row.product_id : row.nm_id;
    const hasKey = key != null;
    const stockNow = hasKey ? (stockMap[key] || 0) : 0;
    const demand = qtyPlan * coverage / 30.0;
    const qtyNeeded = Math.max(0, Math.round(demand - stockNow));
    const cost = hasKey ? (costMap[key] || 0) : 0;
    const hasCogs = cost > 0;
    const budgetRub = round2(qtyNeeded * cost) || 0;
    // Дни до OOS: null если план=0 (нет темпа продаж → «бесконечно»).
    const daysToOos = (qtyPlan > 0 && hasKey)
      ? Math.round(stockNow / (qtyPlan / 30.0) * 10) / 10
      : null;
    return {
      id: row.id,
      nm_id: row.nm_id,
      product_id: row.product_id,
      sku_label: row.sku_label,
      category: row.category,
      platform: row.platform,
      qty_plan: qtyPlan,
      stock_now: stockNow,
      coverage_days: coverage,
      qty_needed: qtyNeeded,
      budget_rub: budgetRub,
      days_to_oos: daysToOos,
      has_cogs: hasCogs,
    };
  });

  const totals = {
    qty_needed: items.reduce((s, i) => s + (i.qty_needed || 0), 0),
    budget_rub: round2(items.reduce((s, i) => s + (i.budget_rub || 0), 0)),
  };

  return NextResponse.json({ count: items.length, items, totals, coverage });
});
