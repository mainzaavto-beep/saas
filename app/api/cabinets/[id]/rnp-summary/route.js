import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { NextResponse } from "next/server";
import { wbProfitProduct } from "@/lib/wbMetrics.js";
import { ozProfitProduct } from "@/lib/ozonMetrics.js";
import { normalizeTaxMode } from "@/lib/tax.js";
import { tenantQuery } from "@/lib/db.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
//  /api/rnp-summary — «Рука на пульсе» (оперативная сводка по товарам).
//
//  Колонки (на товар):
//    • Заказы факт/план            — факт COUNT(orders, is_cancel=0);
//                                    план = sales_plan × (дней пересеч. / дней в месяце)
//    • CTR % + динамика ▲▼          — рекламный: 100×ad_clicks/ad_views (daily_metrics)
//    • ДРР % факт/план              — факт 100×ad_spend/salesRub; план = sales_plan.drr_plan
//    • ДРР ₽ факт/план              — факт SUM(ad_spend); план = drr_plan × revenue_plan_prop
//    • Скидка за счёт МП %          — WB: AVG(orders.spp); Ozon: соинвест из
//      снимков ozon_prices (1 − marketing_price/marketing_seller_price);
//      буст из акций — НЕ соинвест (решение хозяина 2026-08-02)
//    • Прибыль факт/план            — операционная; план = revenue_plan_prop × margin_plan_pct
//    • Оборачиваемость, дн          — lastStock / (sold5/5) по последним 5 дням от конца периода
//    • Рейтинг ★ + динамика ▲▼      — AVG(daily_metrics.rating) (feedbackRating, сглаженный)
//
//  Канон финансов = тот же, что в /products-summary и pnl (lib/wbMetrics.js
//  ::wbProfitProduct, lib/ozonMetrics.js::ozProfitProduct — задача 5 плана
//  унификации прибыли) — profitFact на товар = canon.profit (ads=0 на
//  товаре, кабинетная реклама вычитается из totals единым блоком ниже).
//  adSpend в строках — реальный per-SKU расход (daily_metrics), информационная
//  колонка, profit больше не вычитает.
//
//  Динамика (CTR, рейтинг): текущий период vs предыдущий период той же длины.
//  prevTo = from − 1 день, prevFrom = prevTo − (days−1).
//
//  ⚠️ rating = feedbackRating из воронки WB (сглаженный). Честный рейтинг по
//  отзывам не собирается (сборщик wb_cards.py не портирован) — пометка в UI.
// =====================================================================

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const platform = url.searchParams.get("platform") || "all"; // all|wb|ozon
    const fromQ = url.searchParams.get("from") || "";
    const toQ = url.searchParams.get("to") || "";

    // Дефолтный период РНП: последние 7 дней от MAX(order_dt) по обеим БД.
    // (оперативный горизонт). Fallback — 7 дней от сегодня, если данных нет.
    let from = fromQ, to = toQ;
    if (!from || !to) {
      let maxDt = "";
      try { maxDt = (await new DatabaseSync("wb", { readOnly: true }).prepare("SELECT MAX(order_dt) AS m FROM orders").get())?.m || ""; } catch (e) { console.error("rnp-summary: MAX(order_dt) wb", e); }
      try { const oz = (await new DatabaseSync("ozon", { readOnly: true }).prepare("SELECT MAX(order_dt) AS m FROM orders").get())?.m || ""; if (oz > maxDt) maxDt = oz; } catch (e) { console.error("rnp-summary: MAX(order_dt) ozon", e); }
      if (maxDt) {
        if (!to) to = maxDt.slice(0, 10);
        if (!from) {
          const d = new Date(maxDt);
          d.setDate(d.getDate() - 6); // 7 дней включая крайний
          from = d.toISOString().slice(0, 10);
        }
      } else {
        if (!to) to = new Date().toISOString().slice(0, 10);
        if (!from) from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
      }
    }
    const toEnd = to + "T23:59:59";

    const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
    // Предыдущий период той же длины (для динамики CTR/рейтинга).
    const prevTo = addDays(from, -1);
    const prevToEnd = prevTo + "T23:59:59";
    const prevFrom = addDays(prevTo, -(days - 1));

    let items = [];
    const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
    const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);
    if (platform !== "ozon") items = items.concat(
      await collectWB(from, toEnd, prevFrom, prevToEnd, cabinet.shop_names?.wb, wbTax)
    );
    if (platform !== "wb")   items = items.concat(
      await collectOzon(from, toEnd, prevFrom, prevToEnd, prevTo, cabinet.shop_names?.ozon, ozonTax)
    );

    // План (пропорция от месяца) — общий хелпер, per-SKU по nm_id/product_id.
    const planWb = platform !== "ozon" ? await proportionalPlan(from, to, "wb") : {};
    const planOz = platform !== "wb"   ? await proportionalPlan(from, to, "ozon") : {};

    // Досчёт плана в поля item + тренд-маркеры.
    for (const it of items) {
      const plan = it.platform === "wb" ? planWb[it.nm] : planOz[it.nm];
      it.orderedPlan = plan ? round2(plan.qty) : null;
      it.profitPlan = plan ? round2(plan.revenue * plan.margin) : null;
      it.drrPctPlan = plan && plan.revenue > 0 && plan.drr != null ? round2(plan.drr * 100) : null;
      it.drrRubPlan = plan ? round2(plan.drr * plan.revenue) : null;
      // Динамика (только там, где есть prev).
      it.ctrTrend = trendOf(it.ctrPct, it.ctrPrevPct);
      it.ratingTrend = trendOf(it.rating, it.ratingPrev);
      it.mpDiscountTrend = trendOf(it.mpDiscount, it.mpDiscountPrev);
    }

    // Сортировка: по выручке вниз.
    items.sort((a, b) => (b.salesRub || 0) - (a.salesRub || 0));

    const totals = aggTotals(items);

    // ⚠️ КАНОН (задача 5 плана унификации прибыли, симметрично products-
    // summary; формула ads переписана задачей 6/7 плана «реклама Ozon по
    // товарам», 2026-08-21/22): it.profitFact = canon profitProduct(nm/pid).
    // profit, где ads(товар) ТЕПЕРЬ реальный per-SKU расход (не 0) —
    // Σ(item.profitFact) уже содержит Σ item.adSpend. Довычитаем здесь ТОЛЬКО
    // нераспределённый остаток кабинетной рекламы (fullAd − Σ item.adSpend,
    // снизу зажат нулём), а не всю fullAd целиком (иначе Σ item.adSpend
    // вычлась бы дважды), чтобы totals.profitFact = pnl.profit (товарная
    // часть) и products-summary.Σprofit — «один период = одна цифра» (шаг 5
    // плана). totals.adSpend (Σ item.adSpend, реальный per-SKU расход, не
    // перезаписывается ниже, в отличие от products-summary) остаётся
    // информационной колонкой.
    if (from && to) {
      let fullAd = 0;
      if (platform !== "ozon") {
        try {
          const wbad = await new DatabaseSync("wb", { readOnly: true }).prepare(
            `SELECT (SELECT COALESCE(SUM(ad_spend),0) FROM daily_metrics
                     WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL) AS s`
          ).get(from, toEnd);
          fullAd += (wbad && wbad.s) || 0;
        } catch (e) { console.error('[rnp-summary] WB ad пересчёт:', e.message); }
      }
      if (platform !== "wb") {
        try {
          const ozad = await new DatabaseSync("ozon", { readOnly: true }).prepare(
            `SELECT (SELECT COALESCE(SUM(ad_spend),0) FROM ozon_daily_efficiency
                     WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL) AS s`
          ).get(from, to);
          fullAd += (ozad && ozad.s) || 0;
        } catch (e) { console.error('[rnp-summary] Ozon ad пересчёт:', e.message); }
      }
      totals.profitFact = round2((totals.profitFact || 0) - Math.max(0, round2(fullAd - (totals.adSpend || 0))));
    }

    return NextResponse.json({
      count: items.length,
      period: { from, to, days, prevFrom, prevTo },
      totals,
      items,
      shops: { wb: cabinet.shop_names?.wb, ozon: cabinet.shop_names?.ozon },
      methodology:
        "Оперативная сводка. Финансы — тот же канон, что в «Сводке по товарам». " +
        "CTR рекламный (ad_clicks/ad_views). Рейтинг — сглаженный feedbackRating WB " +
        "(честные отзывы не собираются). План — пропорция от месячного sales_plan. " +
        "Динамика: текущий период vs предыдущий той же длины.",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

// ---------- хелперы периода ----------
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
// Тренд: up/down/flat/none. Порог flat — 2% относительного (или 0.05 абс. для рейтинга).
function trendOf(cur, prev) {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return "none";
  if (prev === 0) return cur > 0 ? "up" : cur < 0 ? "down" : "flat";
  const d = cur - prev;
  const rel = Math.abs(d / prev);
  if (rel < 0.02 && Math.abs(d) < 0.05) return "flat";
  return d > 0 ? "up" : "down";
}

function aggTotals(items) {
  const t = {
    orderedFact: 0, orderedPlan: 0,
    salesRub: 0, profitFact: 0, profitPlan: 0,
    adSpend: 0, adClicks: 0, adViews: 0,
  };
  for (const i of items) {
    t.orderedFact += i.orderedFact || 0;
    t.orderedPlan += i.orderedPlan || 0;
    t.salesRub += i.salesRub || 0;
    t.profitFact += i.profitFact || 0;
    t.profitPlan += i.profitPlan || 0;
    t.adSpend += i.adSpend || 0;
    t.adClicks += i.adClicks || 0;
    t.adViews += i.adViews || 0;
  }
  t.ctrPct = t.adViews ? round2(100 * t.adClicks / t.adViews) : null;
  t.drrPct = t.salesRub ? round2(100 * t.adSpend / t.salesRub) : null;
  return t;
}

// ---------- ПЛАН (пропорция от месяца) ----------
// sales_plan.period = 'YYYY-MM'. Для периода, пересекающего несколько месяцев,
// план = Σ по месяцам (план_мес × дней_пересеч / дней_в_месяце).
// Возвращает { nmId: { qty, revenue, drr (дробь), margin (дробь) } }.
async function proportionalPlan(from, to, platform) {
  const out = {};
  // Все строки плана для периодов-месяцев, пересекающих [from, to].
  const months = monthsInRange(from, to);
  if (months.length === 0) return out;
  const rows = await tenantQuery(
    `SELECT period, nm_id, product_id, sku_label,
            qty_plan, revenue_plan, drr_plan, margin_plan_pct
     FROM tenant.sales_plan
     WHERE status = 'active' AND LOWER(platform) = $1
       AND period = ANY($2::text[])`,
    [platform, months]
  );
  for (const r of rows) {
    const m = r.period; // YYYY-MM
    const [yy, mm] = m.split("-").map(Number);
    const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); // дней в месяце
    // Пересечение [from,to] с [m-01, m-dim].
    const mFrom = `${m}-01`;
    const mTo = `${m}-${String(dim).padStart(2, "0")}`;
    const inter = overlapDays(Math.max(from, mFrom), Math.min(to, mTo));
    if (inter <= 0) continue;
    const share = inter / dim;
    const key = r.nm_id || r.product_id || r.sku_label;
    if (key == null) continue;
    const k = Number(key);
    if (!out[k]) out[k] = { qty: 0, revenue: 0, drr: 0, margin: 0 };
    out[k].qty += (r.qty_plan || 0) * share;
    out[k].revenue += (Number(r.revenue_plan) || 0) * share;
    // drr/margin — доли (в sales_plan хранятся как дроби, см. plan/route.js _toFraction).
    // Берём последнюю ненулевую (взвешивать по выручке избыточно для оперативной сводки).
    if (Number(r.drr_plan) > 0) out[k].drr = Number(r.drr_plan);
    if (Number(r.margin_plan_pct) > 0) out[k].margin = Number(r.margin_plan_pct);
  }
  return out;
}
function monthsInRange(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function overlapDays(a, b) {
  if (a > b) return 0;
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.round((db - da) / 86400000) + 1;
}

// ---------- WB ----------
async function collectWB(from, toEnd, prevFrom, prevToEnd, shopName, taxMode) {
  const db = new DatabaseSync("wb", { readOnly: true });
  const to = toEnd.slice(0, 10);

  // 1) Заказы (шт) из orders — канон COUNT(is_cancel=0).
  const ordered = {};
  for (const r of await db.prepare(
    `SELECT nm_id, COUNT(*) AS n FROM orders
     WHERE order_dt >= ? AND order_dt <= ? AND is_cancel = 0 AND nm_id IS NOT NULL
     GROUP BY nm_id`
  ).all(from, toEnd)) {
    ordered[r.nm_id] = r.n || 0;
  }

  // 2) Товары с активностью в order_costs периода — универсум для денег
  // ниже (КАНОН, wbProfitProduct на каждый nm — задача 5 плана унификации
  // прибыли; сама сумма money считается ПОЗЖЕ, в цикле сборки).
  const finKeys = new Set();
  for (const r of await db.prepare(
    `SELECT DISTINCT nm_id FROM order_costs
     WHERE nm_id IS NOT NULL AND (
       (sale_dt IS NOT NULL AND sale_dt >= ? AND sale_dt <= ?) OR
       (return_dt IS NOT NULL AND return_dt >= ? AND return_dt <= ?)
     )`
  ).all(from, toEnd, from, toEnd)) {
    // String(...) — ключи ОБЯЗАНЫ быть той же формы, что Object.keys(ordered)/
    // Object.keys(dm) ниже (объектные ключи в JS ВСЕГДА строки); Set смешанных
    // типов (число 831685664 vs строка "831685664") даёт ДВА разных элемента
    // для одного и того же товара → item дублируется в выдаче, totals вдвое-
    // и-больше завышаются (найдено --verify задачи 5: rnp Σ разошёлся с
    // канон на всю сумму лишних дублей).
    finKeys.add(String(r.nm_id));
  }

  // 3) Реклама + CTR + рейтинг из daily_metrics (текущий период).
  const dm = {};
  for (const r of await db.prepare(
    `SELECT nm_id,
        SUM(ad_spend) AS spend, SUM(ad_clicks) AS clicks, SUM(ad_views) AS views,
        AVG(rating)   AS rating
     FROM daily_metrics
     WHERE date >= ? AND date <= ? AND nm_id IS NOT NULL
     GROUP BY nm_id`
  ).all(from, toEnd)) {
    dm[r.nm_id] = {
      spend: r.spend || 0, clicks: r.clicks || 0, views: r.views || 0,
      rating: r.rating != null ? round2(r.rating) : null,
    };
  }

  // 4) CTR + рейтинг предыдущего периода (для динамики).
  const dmp = {};
  for (const r of await db.prepare(
    `SELECT nm_id,
        SUM(ad_clicks) AS clicks, SUM(ad_views) AS views, AVG(rating) AS rating
     FROM daily_metrics
     WHERE date >= ? AND date <= ? AND nm_id IS NOT NULL
     GROUP BY nm_id`
  ).all(prevFrom, prevToEnd)) {
    dmp[r.nm_id] = {
      ctrPct: r.views ? round2(100 * (r.clicks || 0) / r.views) : null,
      rating: r.rating != null ? round2(r.rating) : null,
    };
  }

  // 5) СПП — AVG(orders.spp) за период (единственный рабочий источник).
  const spp = {};
  for (const r of await db.prepare(
    `SELECT nm_id, AVG(spp) AS s FROM orders
     WHERE order_dt >= ? AND order_dt <= ? AND spp IS NOT NULL AND nm_id IS NOT NULL
     GROUP BY nm_id`
  ).all(from, toEnd)) {
    spp[r.nm_id] = r.s != null ? round2(r.s) : null;
  }
  // 5б) СПП предыдущего периода — для стрелки динамики (по образцу CTR/rating, блок 4).
  const sppPrev = {};
  for (const r of await db.prepare(
    `SELECT nm_id, AVG(spp) AS s FROM orders
     WHERE order_dt >= ? AND order_dt <= ? AND spp IS NOT NULL AND nm_id IS NOT NULL
     GROUP BY nm_id`
  ).all(prevFrom, prevToEnd)) {
    sppPrev[r.nm_id] = r.s != null ? round2(r.s) : null;
  }
  // 5в) Fallback СПП (с 2026-08-02) для артикулов БЕЗ заказов в периоде, по
  //     приоритету: (1) реальная цена сайта price_site (card.wb.ru, миграция
  //     029): 1 − price_site/priceCabinet; (2) последний известный СПП из
  //     заказов за 60 дней. ⚠️ price_buyer (discountedPrice) для этого НЕ
  //     годится — НЕ включает СПП (доказано: nm 1181386677, API=8911 ₽,
  //     сайт=6344 ₽). Оценка помечается mpDiscountEst (⚙), динамика не даётся.
  const sppFromSite = {};
  try {
    for (const r of await db.prepare(
      `SELECT nm_id, price_seller, discount, price_site FROM wb_prices
       WHERE price_site > 0 AND price_seller > 0`
    ).all()) {
      const cab = r.price_seller * (1 - (r.discount || 0) / 100);
      // допуск 2% на округление price_site до рубля (СПП прижимается к 0)
      if (cab > 0 && r.price_site <= cab * 1.02) {
        sppFromSite[r.nm_id] = Math.max(0, round2(100 * (1 - r.price_site / cab)));
      }
    }
  } catch (e) { console.error("rnp-summary: spp from price_site", e); }
  const sppLastKnown = {};
  try {
    for (const r of await db.prepare(
      `SELECT DISTINCT ON (nm_id) nm_id, spp FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND spp IS NOT NULL AND nm_id IS NOT NULL
       ORDER BY nm_id, order_dt DESC`
    ).all(addDays(from, -60), toEnd)) {
      sppLastKnown[r.nm_id] = round2(r.spp);
    }
  } catch (e) { console.error("rnp-summary: spp last-known fallback", e); }

  // Себестоимость (costRub) — теперь берётся из канона (f.cogs, ниже в цикле
  // сборки), поэтому отдельный unitCost×soldAll здесь больше не нужен.

  // 6б) Продано (шт) из sales за последние 5 дней от конца периода — для оборачиваемости.
  const last5From = addDays(to, -4);
  const last5FromEnd = last5From + "T00:00:00";
  const sold5 = {};
  for (const r of await db.prepare(
    `SELECT nm_id,
        SUM(CASE WHEN is_realization=1 AND price_with_disc > 0 THEN 1 ELSE 0 END) AS n
     FROM sales
     WHERE sale_dt >= ? AND sale_dt <= ? AND nm_id IS NOT NULL
     GROUP BY nm_id`
  ).all(last5FromEnd, toEnd)) {
    sold5[r.nm_id] = r.n || 0;
  }

  // 7) Остаток: последний снимок daily_stock на конец периода (quantity_full по складам).
  const stockEnd = {};
  for (const r of await db.prepare(
    `SELECT ds.nm_id, SUM(ds.quantity_full) AS q
     FROM daily_stock ds
     INNER JOIN (SELECT nm_id, MAX(date) AS d FROM daily_stock GROUP BY nm_id) m
       ON ds.nm_id = m.nm_id AND ds.date = m.d
     GROUP BY ds.nm_id`
  ).all()) {
    stockEnd[r.nm_id] = r.q || 0;
  }

  // 8) Идентификация (articles).
  const ident = {};
  for (const r of await db.prepare(
    `SELECT DISTINCT ON (nm_id) nm_id, name, brand, subject, im_url,
            (SELECT supplier_article FROM orders o WHERE o.nm_id = a.nm_id LIMIT 1) AS sa
     FROM articles a`
  ).all()) {
    ident[r.nm_id] = r;
  }

  // Объединение всех nm, у которых есть любой показатель.
  const keys = new Set([
    ...Object.keys(ordered), ...finKeys, ...Object.keys(dm),
    ...Object.keys(spp), ...Object.keys(sold5), ...Object.keys(stockEnd),
  ]);

  // Деньги — КАНОН (wbProfitProduct, задача 5 плана унификации прибыли), по
  // товару. adSp остаётся РЕАЛЬНЫМ per-SKU расходом (тот же источник, что и
  // раньше — daily_metrics) для ДРР/ROI — с 2026-08-21/22 (план «реклама
  // Ozon по товарам», задача 6) profit его снова вычитает (canon.ads при
  // nmId — реальный расход, не 0).
  const out = [];
  for (const k of keys) {
    const nm = Number(k);
    const f = await wbProfitProduct(db, taxMode, { from, to }, nm);
    const d = dm[nm] || {};
    const dp = dmp[nm] || {};
    const id = ident[nm] || {};
    const salesRub = f.revenue || 0;
    const adSp = round2(d.spend || 0);
    const ctrPct = d.views ? round2(100 * (d.clicks || 0) / d.views) : null;
    const s5 = sold5[nm] || 0;
    const avgDaily5 = s5 / 5;
    const turnoverDays = avgDaily5 > 0 ? Math.round((stockEnd[nm] || 0) / avgDaily5) : null;
    out.push({
      nm, sa: id.sa || String(nm),
      name: id.name || id.sa || String(nm), brand: id.brand || "",
      grp: id.subject || "", im_url: id.im_url || null,
      platform: "wb", shop: shopName,
      orderedFact: ordered[nm] || 0,
      salesRub,
      ctrPct, ctrPrevPct: dp.ctrPct != null ? dp.ctrPct : null,
      drrPctFact: salesRub ? round2(100 * adSp / salesRub) : null,
      drrRubFact: adSp,
      mpDiscount: spp[nm] != null ? round2(spp[nm])
        : (sppFromSite[nm] != null ? sppFromSite[nm]
        : (sppLastKnown[nm] != null ? sppLastKnown[nm] : null)),
      // est: значение не из заказов периода; prev не даём — динамика по
      // разным методологиям была бы враньём.
      mpDiscountEst: spp[nm] == null && (sppFromSite[nm] != null || sppLastKnown[nm] != null) || undefined,
      mpDiscountPrev: spp[nm] != null && sppPrev[nm] != null ? round2(sppPrev[nm]) : null,
      profitFact: f.profit,
      turnoverDays,
      rating: d.rating, ratingPrev: dp.rating != null ? dp.rating : null,
      adSpend: adSp, adClicks: d.clicks || 0, adViews: d.views || 0,
    });
  }
  return out;
}

// ---------- Ozon ----------
async function collectOzon(from, toEnd, prevFrom, prevToEnd, prevTo, shopName, taxMode) {
  const db = new DatabaseSync("ozon", { readOnly: true });
  const to = toEnd.slice(0, 10);

  // 1) Заказы (шт) из orders.
  const ordered = {};
  for (const r of await db.prepare(
    `SELECT product_id, SUM(CASE WHEN is_cancel=0 THEN 1 ELSE 0 END) AS n
     FROM orders
     WHERE substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ?
       AND product_id IS NOT NULL
     GROUP BY product_id`
  ).all(from, toEnd)) {
    ordered[r.product_id] = r.n || 0;
  }

  // 2) Товары с активностью в order_costs периода — универсум для денег
  // ниже (КАНОН, ozProfitProduct на каждый product_id — задача 5 плана
  // унификации прибыли; money считается ПОЗЖЕ, в цикле сборки).
  const finKeys = new Set();
  for (const r of await db.prepare(
    `SELECT DISTINCT product_id FROM order_costs
     WHERE product_id IS NOT NULL
       AND substr(COALESCE(sale_dt, return_dt),1,10) >= ?
       AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?`
  ).all(from, to)) {
    // String(...) — см. коммент у finKeys в collectWB выше (Set смешанных
    // типов число/строка дублирует товар в выдаче).
    finKeys.add(String(r.product_id));
  }

  // 3) Реклама + CTR + рейтинг (текущий период).
  const dm = {};
  for (const r of await db.prepare(
    `SELECT product_id,
        SUM(ad_spend) AS spend, SUM(ad_clicks) AS clicks, SUM(ad_views) AS views,
        AVG(rating)   AS rating
     FROM daily_metrics
     WHERE date >= ? AND date <= ? AND product_id IS NOT NULL
     GROUP BY product_id`
  ).all(from, toEnd)) {
    dm[r.product_id] = {
      spend: r.spend || 0, clicks: r.clicks || 0, views: r.views || 0,
      rating: r.rating != null ? round2(r.rating) : null,
    };
  }

  // 4) CTR + рейтинг предыдущего периода.
  const dmp = {};
  for (const r of await db.prepare(
    `SELECT product_id,
        SUM(ad_clicks) AS clicks, SUM(ad_views) AS views, AVG(rating) AS rating
     FROM daily_metrics
     WHERE date >= ? AND date <= ? AND product_id IS NOT NULL
     GROUP BY product_id`
  ).all(prevFrom, prevToEnd)) {
    dmp[r.product_id] = {
      ctrPct: r.views ? round2(100 * (r.clicks || 0) / r.views) : null,
      rating: r.rating != null ? round2(r.rating) : null,
    };
  }

  // 5) Соинвест Ozon — ЧЕСТНОЕ «н/д» (грабля, доказано probe'ами 2026-08-02 на
  //    «карта 64»: кабинет показывает цену покупателя 764 при цене продавца
  //    1120, но размер соинвеста НЕ отдаётся продавцовским API НИГДЕ):
  //    • /v5/product/info/prices — цены витрины нет (грабля #57, marketing_price
  //      мёртв); • current_boost из акций — сила БУСТА показов, не соинвест
  //      (эластичная кривая 1383₽↔15…1012₽↔75 сошлась точно);
  //    • financial_data заказов — перечисляет акции «Скидка (за счёт Озон) —
  //      AI benefit system (Mesh)» БЕЗ сумм, price = цена продавца;
  //    • витрина ozon.ru — антибот (307-челлендж даже через прокси).
  //    Показывать 0% из снимков ozon_prices — ЛОЖЬ (соинвест есть, размер
  //    скрыт) → по правилу о финансах отдаём null («—» в UI), не ноль.
  //    Снимки ozon_prices продолжаем собирать (история цен полезна сама по себе).
  const boost = {};
  const boostPrev = {};

  // 6) Продано за последние 5 дней (order_costs) — для оборачиваемости.
  const last5From = addDays(to, -4);
  const sold5 = {};
  for (const r of await db.prepare(
    `SELECT product_id,
        SUM(CASE WHEN is_return=0 THEN 1 ELSE 0 END) AS n
     FROM order_costs
     WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
       AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
       AND product_id IS NOT NULL
     GROUP BY product_id`
  ).all(last5From, toEnd)) {
    sold5[r.product_id] = r.n || 0;
  }

  // 7) Остаток: последний снимок daily_stock (fbo_present − reserved).
  const stockEnd = {};
  for (const r of await db.prepare(
    `SELECT ds.product_id, SUM(ds.fbo_present - ds.fbo_reserved) AS q
     FROM daily_stock ds
     INNER JOIN (SELECT product_id, MAX(date) AS d FROM daily_stock GROUP BY product_id) m
       ON ds.product_id = m.product_id AND ds.date = m.d
     GROUP BY ds.product_id`
  ).all()) {
    stockEnd[r.product_id] = r.q || 0;
  }

  // 8) Идентификация (products).
  const ident = {};
  for (const r of await db.prepare(
    `SELECT product_id, name, brand, category, im_url, offer_id AS sa FROM products`
  ).all()) {
    ident[r.product_id] = r;
  }

  const keys = new Set([
    ...Object.keys(ordered), ...finKeys, ...Object.keys(dm),
    ...Object.keys(sold5), ...Object.keys(stockEnd),
  ]);

  // Деньги — КАНОН (ozProfitProduct, задача 5 плана унификации прибыли), по
  // товару. adSp — daily_metrics.ad_spend (сегодня у Ozon пуст по SKU, как и
  // раньше) остаётся информационной колонкой, profit её не вычитает.
  const out = [];
  for (const k of keys) {
    const nm = Number(k);
    const f = await ozProfitProduct(db, taxMode, { from, to }, nm);
    const d = dm[nm] || {};
    const dp = dmp[nm] || {};
    const id = ident[nm] || {};
    const salesRub = f.revenue || 0;
    const adSp = round2(d.spend || 0);
    const ctrPct = d.views ? round2(100 * (d.clicks || 0) / d.views) : null;
    const s5 = sold5[nm] || 0;
    const avgDaily5 = s5 / 5;
    const turnoverDays = avgDaily5 > 0 ? Math.round((stockEnd[nm] || 0) / avgDaily5) : null;
    out.push({
      nm, sa: id.sa || String(nm),
      name: id.name || id.sa || String(nm), brand: id.brand || "",
      grp: id.category || "", im_url: id.im_url || null,
      platform: "ozon", shop: shopName,
      orderedFact: ordered[nm] || 0,
      salesRub,
      ctrPct, ctrPrevPct: dp.ctrPct != null ? dp.ctrPct : null,
      drrPctFact: salesRub ? round2(100 * adSp / salesRub) : null,
      drrRubFact: adSp,
      mpDiscount: boost[nm] != null ? boost[nm] : null,
      mpDiscountPrev: boostPrev[nm] != null ? boostPrev[nm] : null,
      profitFact: f.profit,
      turnoverDays,
      rating: d.rating, ratingPrev: dp.rating != null ? dp.rating : null,
      adSpend: adSp, adClicks: d.clicks || 0, adViews: d.views || 0,
    });
  }
  return out;
}
