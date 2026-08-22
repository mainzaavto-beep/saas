// /api/cabinets/[id]/plan/fact — план-факт по SKU за месяц (заявка №29).
//
// Главная страница «План продаж»: для каждой строки плана (sales_plan) тянет
// факт продаж/прибыли из боевых таблиц и считает % выполнения.
//
// КОНТРАКТ фронт↔API сверен с PlanPage.jsx (MonthPlan + QuarterYear.agg):
//   items[] — строки плана с полями плана И факт-полями (null для новых SKU).
//
// Модель прибыли ФАКТА = КАНОН (lib/wbMetrics.js::wbProfitProduct,
// lib/ozonMetrics.js::ozProfitProduct — задача 5 плана унификации прибыли),
// та же формула, что products-summary/rnp-summary/pnl/detail. margin_fact_rub
// = canon.profit — себестоимость факта берётся из order_costs.cost (реальная,
// НЕ плановая cost_plan) — «факт-COGS», цель задачи 5. Плановые колонки
// (qty_plan/cost_plan/revenue_plan/drr_plan/margin_plan_*) НЕ трогаются.
//
// Источники факта (сверено с lib/wbMetrics.js, lib/ozonMetrics.js):
//   WB:    order_costs (канон), sales (шт факт), daily_metrics.ad_spend
//          (реклама — с 2026-08-21/22 canon.ads на товаре РЕАЛЬНЫЙ расход,
//          не 0, план «реклама Ozon по товарам», задача 6), wb_articles
//          (имя/фото).
//   OZON:  order_costs (канон, включая шт факт), daily_metrics.ad_spend
//          (с 2026-08-22 реально заполнен по SKU из tenant.ozon_daily_
//          sku_ad, миграция 043; canon.ads на товаре тоже реальный расход),
//          ozon_products (имя/фото).
//
// Перенос эталона fin/plan.py:plan_fact() под tenantQuery (PG+RLS).
import { NextResponse } from "next/server";
import { DatabaseSync, tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { wbSold, wbAdTotal, wbProfitProduct } from "@/lib/wbMetrics.js";
import { ozAdSpend, ozProfitProduct } from "@/lib/ozonMetrics.js";
import { normalizeTaxMode } from "@/lib/tax.js";

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
  //    YA — нет источника (как в эталоне). Деньги факта — КАНОН, по строке
  //    плана (мало строк живых данных — см. докстроку файла), вызывается
  //    НИЖЕ прямо в цикле сборки items; здесь только штуки/реклама/имена
  //    (не часть канона, батчем — дёшево).
  let wbDb = null, wbSoldMap = {}, wbAd = {}, wbNames = {};
  let ozDb = null, ozSold = {}, ozAd = {}, ozNames = {};
  const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
  const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);
  const taxMode = platform === "OZON" ? ozonTax : wbTax;

  if (platform === "WB") {
    try {
      wbDb = new DatabaseSync("wb", { readOnly: true });
      wbSoldMap = await wbSold(wbDb, { from, to: toEnd.slice(0, 10) });
      wbAd = await wbAdTotal(wbDb, { from, to: toEnd.slice(0, 10), groupByNm: true });
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
      ozDb = new DatabaseSync("ozon", { readOnly: true });
      // Штуки факта (is_return=0), симметрично старому ozOrderCostsByProduct.sold —
      // деньги теперь идут через ozProfitProduct (канон), не отсюда.
      for (const r of await ozDb.prepare(
        `SELECT product_id, SUM(CASE WHEN is_return=0 THEN 1 ELSE 0 END) AS n
         FROM order_costs
         WHERE product_id IS NOT NULL
           AND substr(COALESCE(sale_dt, return_dt),1,10) >= ?
           AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
         GROUP BY product_id`
      ).all(from, to)) {
        ozSold[r.product_id] = r.n || 0;
      }
      ozAd = await ozAdSpend(ozDb, { from, to, groupByProduct: true });
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
  const items = [];
  for (const row of planRows) {
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
    // Деньги — КАНОН (wbProfitProduct/ozProfitProduct, задача 5 плана
    // унификации прибыли): margin_fact_rub = f.profit, себестоимость факта —
    // ФАКТ из order_costs.cost (f.cogs), НЕ плановая cost_plan (была
    // аппроксимацией costPlan×qtyFact) — цель задачи 5 «факт-COGS». ads
    // канона на товаре всегда 0 — ad_spend остаётся реальной информационной
    // колонкой (drr_fact/roi_fact её используют для отображения, profit её
    // больше не вычитает).
    if (is_waiting) { items.push(item); continue; }
    if (platform === "WB" && nm == null) { items.push(item); continue; }
    if (platform === "OZON" && pid == null) { items.push(item); continue; }

    const qtyFact = platform === "WB" ? (wbSoldMap[nm] || 0) : (ozSold[pid] || 0);
    const adSp = round2(platform === "WB" ? (wbAd[nm] || 0) : (ozAd[pid] || 0));
    const f = platform === "WB"
      ? await wbProfitProduct(wbDb, taxMode, { from, to: toEnd.slice(0, 10) }, nm)
      : await ozProfitProduct(ozDb, taxMode, { from, to }, pid);
    const revenueFact = round2(f.revenue) || 0;
    if (!qtyFact && !revenueFact) { items.push(item); continue; } // нулевой факт — % выполнения бессмысленен.

    const costRub = f.cogs; // ФАКТ-себестоимость (канон), не cost_plan
    const marginFactRub = f.profit;

    item.qty_fact = qtyFact;
    item.revenue_fact = revenueFact;
    item.ad_spend = adSp;
    item.drr_fact_rub = adSp;
    item.drr_fact = revenueFact > 0 ? round4(adSp / revenueFact) : null;
    item.margin_fact_rub = marginFactRub;
    item.margin_fact_pct = revenueFact > 0 ? round4(marginFactRub / revenueFact) : null;
    // ROI факт — Пр факт ₽ / Себест факт ₽ (была аппроксимация cost_plan×qty).
    item.roi_fact = (costRub > 0 && marginFactRub != null) ? round4(marginFactRub / costRub) : null;
    // % выполнения: ДРР инвертируется (ниже плана = лучше, >100% = перевыполнили).
    item.qty_fulfill = safeDiv(qtyFact, qtyPlan);
    item.revenue_fulfill = safeDiv(revenueFact, revenuePlan);
    item.margin_fulfill = safeDiv(marginFactRub, marginPlanRub);
    items.push(item);
  }

  return NextResponse.json({ count: items.length, items });
});
