// /api/cabinets/[id]/plan/fact — план-факт по SKU за месяц (заявка №29).
//
// Главная страница «План продаж»: для каждой строки плана (sales_plan) тянет
// факт продаж/прибыли из боевых таблиц и считает % выполнения.
//
// КОНТРАКТ фронт↔API сверен с PlanPage.jsx (MonthPlan + QuarterYear.agg):
//   items[] — строки плана с полями плана И факт-полями (null для новых SKU).
//
// Модель прибыли = КАНОН SaaS (как products-summary/route.js): операционная
// прибыль пересчитывается из компонентов с правильным НДС+УСН (calcTotalTax,
// урок D14). Цифры факта согласованы с P&L/Сводкой по товарам. Готовый
// order_costs.profit не используем (он не учитывает НДС → завышен).
//
// Источники (сверено с lib/wbMetrics.js, lib/ozonMetrics.js):
//   WB:    finance_report (выручка/комиссия/логистика), sales (шт),
//          daily_metrics.ad_spend (реклама), articles (имя/фото),
//          cost_overrides (себест).
//   OZON:  order_costs (выручка/себест/расходы/шт — грабля #134, НЕ sales),
//          daily_metrics.ad_spend, products (имя/фото), cost_overrides.
//
// Перенос эталона fin/plan.py:plan_fact() под tenantQuery (PG+RLS).
import { NextResponse } from "next/server";
import { DatabaseSync, tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { wbFinancePeriodByNm, wbSold, wbAdTotal } from "@/lib/wbMetrics.js";
import { ozOrderCostsByProduct, ozAdSpend } from "@/lib/ozonMetrics.js";
import { calcTotalTax, normalizeTaxMode } from "@/lib/tax.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const round4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const safeDiv = (num, den) => (!den ? null : round4(num / den));

// period 'YYYY-MM' → ['YYYY-MM-01', 'YYYY-MM-DD' (последний день месяца)].
function monthBounds(period) {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(y, m, 0).getDate(); // m уже 1-базируется: Date(y, m, 0) = последний день m-1... нет
  // new Date(y, m, 0).getDate() даёт последний день месяца m (т.к. день 0 = последний предыдущего).
  return [`${period}-01`, `${period}-${String(last).padStart(2, "0")}`];
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const period = url.searchParams.get("period");
  const platform = url.searchParams.get("platform");
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: "period must be YYYY-MM" }, { status: 400 });
  }
  if (!platform || !["WB", "OZON", "YA"].includes(platform)) {
    return NextResponse.json({ error: "platform must be WB|OZON|YA" }, { status: 400 });
  }

  // 1. Строки плана (status='active', не archived).
  const planRows = await tenantQuery(
    `SELECT id, period, platform, nm_id, product_id, sku_label, category,
            qty_plan, buyout_rate_plan, revenue_plan, drr_plan, margin_plan_pct,
            price_no_spp, cost_plan, launch_date, is_new_sku, status, approved
     FROM tenant.sales_plan
     WHERE period = $1 AND platform = $2 AND status = 'active'
     ORDER BY COALESCE(nm_id, 0), COALESCE(product_id, 0), sku_label`,
    [period, platform]
  );

  const [from, to] = monthBounds(period);
  const toEnd = to + "T23:59:59";

  // 2. Предзагрузка факта за период (один проход по источнику, не построчно).
  //    YA — нет источника (как в эталоне).
  let wbFin = {}, wbSoldMap = {}, wbAd = {}, wbNames = {};
  let ozMap = {}, ozAd = {}, ozNames = {};
  const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
  const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);
  const taxMode = platform === "OZON" ? ozonTax : wbTax;

  if (platform === "WB") {
    try {
      const db = new DatabaseSync("wb", { readOnly: true });
      wbFin = await wbFinancePeriodByNm(db, { from, to: toEnd.slice(0, 10) });
      wbSoldMap = await wbSold(db, { from, to: toEnd.slice(0, 10) });
      wbAd = await wbAdTotal(db, { from, to: toEnd.slice(0, 10), groupByNm: true });
    } catch (e) { /* БД WB может быть пуста/нет данных — факт = null, не падаем. */ }
    // Имена/фото/категория из wb_articles (вне DatabaseSync-мапа, raw tenant).
    try {
      const rows = await tenantQuery(
        `SELECT nm_id, name, subject, im_url FROM tenant.wb_articles`
      );
      for (const r of rows) wbNames[r.nm_id] = { name: r.name, cat: r.subject, im: r.im_url };
    } catch {}
  } else if (platform === "OZON") {
    try {
      const db = new DatabaseSync("ozon", { readOnly: true });
      ozMap = await ozOrderCostsByProduct(db, { from, to });
      ozAd = await ozAdSpend(db, { from, to, groupByProduct: true });
    } catch (e) {}
    try {
      const rows = await tenantQuery(
        `SELECT product_id, name, category, im_url FROM tenant.ozon_products`
      );
      for (const r of rows) ozNames[r.product_id] = { name: r.name, cat: r.category, im: r.im_url };
    } catch {}
  }

  // 3. Сборка строк план-факт.
  const today = new Date().toISOString().slice(0, 10);
  const items = planRows.map((row) => {
    const nm = row.nm_id;
    const pid = row.product_id;
    const is_new = Boolean(row.is_new_sku) || (nm == null && pid == null);
    // Новый SKU, старт ещё не наступил → факт не считаем (ждём launch_date).
    let is_waiting = is_new;
    if (row.launch_date) {
      const ld = String(row.launch_date).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(ld) && today < ld) is_waiting = true;
    }

    // Производные поля ПЛАНА (согласованы с сохранением в plan/route.js).
    const qtyPlan = Number(row.qty_plan) || 0;
    const priceNoSpp = row.price_no_spp != null && row.price_no_spp !== "" ? Number(row.price_no_spp) : null;
    const revenuePlan = (priceNoSpp != null && Number.isFinite(priceNoSpp))
      ? round2(qtyPlan * priceNoSpp)
      : round2(Number(row.revenue_plan) || 0);
    const drrPlan = Number(row.drr_plan) || 0;
    const marginPlanPct = Number(row.margin_plan_pct) || 0;
    const drrPlanRub = round2((revenuePlan || 0) * drrPlan);
    const marginPlanRub = round2((revenuePlan || 0) * marginPlanPct);
    const buyoutRatePlan = row.buyout_rate_plan != null ? Number(row.buyout_rate_plan) : null;
    const qtyOrdersPlan = (buyoutRatePlan != null && buyoutRatePlan > 0)
      ? Math.round(qtyPlan / buyoutRatePlan) : qtyPlan;
    const costPlan = row.cost_plan != null && row.cost_plan !== "" ? Number(row.cost_plan) : null;
    const costTotalPlan = (costPlan != null && costPlan > 0 && qtyPlan > 0) ? round2(costPlan * qtyPlan) : null;
    const roiPlan = (costTotalPlan != null && costTotalPlan > 0 && marginPlanRub != null)
      ? round4(marginPlanRub / costTotalPlan) : null;

    // Имя/фото/категория из справочника МП (с fallback на sku_label).
    let name = null, imUrl = null, category = row.category || null;
    if (platform === "WB" && nm != null && wbNames[nm]) {
      name = wbNames[nm].name;
      if (!category) category = wbNames[nm].cat;
      imUrl = wbNames[nm].im;
    } else if (platform === "OZON" && pid != null && ozNames[pid]) {
      name = ozNames[pid].name;
      if (!category) category = ozNames[pid].cat;
      imUrl = ozNames[pid].im;
    }

    const item = {
      id: row.id,
      platform: row.platform,
      nm_id: nm,
      product_id: pid,
      sku_label: row.sku_label,
      category,
      name,
      im_url: imUrl,
      is_new,
      is_waiting,
      approved: Boolean(row.approved),
      launch_date: row.launch_date,
      // ПЛАН
      qty_plan: qtyPlan,
      qty_orders_plan: qtyOrdersPlan,
      buyout_rate_plan: buyoutRatePlan,
      price_no_spp: priceNoSpp,
      cost_plan: costPlan,
      cost_total_plan: costTotalPlan,
      revenue_plan: revenuePlan,
      drr_plan: drrPlan,
      drr_plan_rub: drrPlanRub,
      margin_plan_pct: marginPlanPct,
      margin_plan_rub: marginPlanRub,
      roi_plan: roiPlan,
      // ФАКТ (заполним ниже; для new/waiting — null)
      qty_fact: null,
      revenue_fact: null,
      ad_spend: null,
      drr_fact: null,
      drr_fact_rub: null,
      margin_fact_pct: null,
      margin_fact_rub: null,
      roi_fact: null,
      // % выполнения
      qty_fulfill: null,
      revenue_fulfill: null,
      margin_fulfill: null,
    };

    // 4. ФАКТ — только для обрабатываемых SKU (не new/waiting) с источником.
    if (is_waiting) return item;
    let f = null, ad = 0;
    if (platform === "WB" && nm != null && wbFin[nm]) {
      f = wbFin[nm];
      ad = wbAd[nm] || 0;
    } else if (platform === "OZON" && pid != null && ozMap[pid]) {
      f = ozMap[pid];
      ad = ozAd[pid] || 0;
    }
    if (!f) return item; // нет факта — оставляем null.

    const qtyFact = platform === "WB" ? (wbSoldMap[nm] || 0) : (f.sold || 0);
    const revenueFact = round2(f.salesRub != null ? f.salesRub : f.revenue) || 0;
    if (!qtyFact && !revenueFact) return item; // нулевой факт — % выполнения бессмысленен.

    // Расходы из компонентов (канон SaaS). WB: fin.commission/logistics/acquiring.
    // OZON: f.cost/commission/logistics/acquiring/loyalty (уже из order_costs).
    const commission = round2(f.commission || 0);
    const acquiring = round2(f.acquiring || 0);
    const logistics = round2(f.logistics || 0);
    const loyalty = round2(f.loyalty || 0);
    // Себестоимость: per-SKU из cost_overrides нет на строке плана — используем
    // cost_plan (плановая) как аппроксимацию для ROI факта (задокументировано).
    const costRub = round2(((costPlan || 0)) * qtyFact) || 0;
    const adSp = round2(ad);
    const itemExpenses = (commission || 0) + (acquiring || 0) + (logistics || 0) + (loyalty || 0) + costRub + adSp;
    const tax = calcTotalTax(taxMode, revenueFact, itemExpenses).total;
    // ЧИСТАЯ операционная прибыль = выручка − все расходы − налог (как products-summary).
    const marginFactRub = round2(
      revenueFact - (commission || 0) - (acquiring || 0) - (logistics || 0) - (loyalty || 0) - costRub - adSp - tax
    );

    item.qty_fact = qtyFact;
    item.revenue_fact = revenueFact;
    item.ad_spend = adSp;
    item.drr_fact_rub = adSp;
    item.drr_fact = revenueFact > 0 ? round4(adSp / revenueFact) : null;
    item.margin_fact_rub = marginFactRub;
    item.margin_fact_pct = revenueFact > 0 ? round4(marginFactRub / revenueFact) : null;
    // ROI факт — Пр факт ₽ / (Себест × Факт шт). Использует cost_plan (аппроксимация).
    item.roi_fact = (costRub > 0 && marginFactRub != null) ? round4(marginFactRub / costRub) : null;
    // % выполнения: ДРР инвертируется (ниже плана = лучше, >100% = перевыполнили).
    item.qty_fulfill = safeDiv(qtyFact, qtyPlan);
    item.revenue_fulfill = safeDiv(revenueFact, revenuePlan);
    item.margin_fulfill = safeDiv(marginFactRub, marginPlanRub);
    return item;
  });

  return NextResponse.json({ count: items.length, items });
});
