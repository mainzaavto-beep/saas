// /api/cabinets/[id]/detail — детальная сводка по ОДНОМУ товару (WB или Ozon).
// Полный перенос эталона data-presenter/api/products/detail/route.js (865 строк)
// с адаптацией под PostgreSQL (DatabaseSync + withCabinet + RLS).
// Пустые таблицы (daily_stock, feedback_summary, cards_glue, item_keywords) —
// graceful fallback (null/пусто), не падают.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import {
  WAREHOUSE_REGION, USN_RATE,
  wbOrdersByDay, wbOrderRubByDay, wbSoldByDay, wbStockByDay,
  wbFinancePeriod, wbFinanceByDay, wbUnitCost,
} from "@/lib/wbMetrics.js";
import { ozOrderCostsAggregate } from "@/lib/ozonMetrics.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RU_WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function weekdayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return RU_WEEKDAYS[d.getDay()];
}

function wbDateList(from, to) {
  const list = [];
  for (let d = new Date(from + "T00:00:00"); d <= new Date(to + "T00:00:00"); d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    list.push(`${y}-${m}-${da}`);
  }
  return list;
}

function wbRegionOf(wh) {
  return wh ? WAREHOUSE_REGION[wh.trim()] || null : null;
}

function buildSalesByLoc(saleRows, regionOf) {
  const byWarehouse = new Map();
  const byCluster = new Map();
  let total = 0, localTotal = 0;
  for (const r of saleRows) {
    total += 1;
    const wh = (r.warehouse_name || "").trim();
    const cl = (r.okrug_name || "").trim() || "Не указан";
    const whReg = regionOf(wh);
    const isLocal = whReg && (r.region_name || "").includes(whReg);
    if (isLocal) localTotal += 1;
    if (!byWarehouse.has(wh)) byWarehouse.set(wh, { count: 0, local: 0 });
    const w = byWarehouse.get(wh);
    w.count += 1; if (isLocal) w.local += 1;
    if (!byCluster.has(cl)) byCluster.set(cl, { count: 0, local: 0 });
    const cobj = byCluster.get(cl);
    cobj.count += 1; if (isLocal) cobj.local += 1;
  }
  const toItems = (map) => [...map.entries()]
    .map(([name, v]) => ({
      name, count: v.count,
      share: total > 0 ? Math.round((v.count / total) * 1000) / 10 : null,
      localPct: v.count > 0 ? Math.round((v.local / v.count) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.count - a.count);
  return {
    total, localTotal,
    localPct: total > 0 ? Math.round((localTotal / total) * 1000) / 10 : null,
    byWarehouse: toItems(byWarehouse),
    byCluster: toItems(byCluster),
    byCity: [],
  };
}

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const platform = url.searchParams.get("platform") || "wb";
    const nmRaw = url.searchParams.get("nm");
    if (!nmRaw) return NextResponse.json({ error: "не указан nm" }, { status: 400 });
    const nm = Number(nmRaw);
    if (!Number.isFinite(nm)) return NextResponse.json({ error: "nm должен быть числом" }, { status: 400 });

    const now = new Date();
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let from = url.searchParams.get("from");
    let to = url.searchParams.get("to");
    if (!from || !to) {
      let maxDt = "";
      try {
        const mpDb = platform === "ozon" ? "ozon" : "wb";
        maxDt = (await new DatabaseSync(mpDb, { readOnly: true }).prepare("SELECT MAX(order_dt) AS m FROM orders").get())?.m || "";
      } catch {}
      if (maxDt) {
        if (!to) to = String(maxDt).slice(0, 10);
        if (!from) {
          const d = new Date(String(maxDt).slice(0, 10) + "T00:00:00");
          d.setDate(d.getDate() - 29);
          from = ymd(d);
        }
      } else {
        if (!to) to = ymd(now);
        if (!from) { const d = new Date(now); d.setDate(d.getDate() - 29); from = ymd(d); }
      }
    }
    const toEnd = to + "T23:59:59";
    const shopName = platform === "ozon" ? (cabinet.shop_names?.ozon || null) : (cabinet.shop_names?.wb || null);

    const result = platform === "ozon"
      ? await collectOzon(nm, from, to, toEnd, shopName)
      : await collectWB(nm, from, to, toEnd, shopName);

    if (!result.product) {
      return NextResponse.json({ error: `товар ${nm} не найден` }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

// =====================================================================
//  WB
// =====================================================================
async function collectWB(nm, from, to, toEnd, shopName) {
  const db = new DatabaseSync("wb", { readOnly: true });

  // 1) Идентификация (articles + orders для sa/barcode/cat).
  const art = await db.prepare(`SELECT nm_id, name, brand, subject, im_url FROM articles WHERE nm_id = ?`).get(nm) || null;
  if (!art) return { period: { from, to }, product: null };
  const ordInfo = await db.prepare(
    `SELECT MAX(supplier_article) AS sa, MAX(barcode) AS barcode, MAX(category) AS cat FROM orders WHERE nm_id = ?`
  ).get(nm) || {};

  // 1б) Склейки + рейтинг (могут быть пусты — graceful).
  let glue = {};
  try { glue = await db.prepare(`SELECT imt_id, imt_nm_count FROM wb_cards_glue WHERE nm_id = ?`).get(nm) || {}; } catch {}
  let fbNm = {};
  try { fbNm = await db.prepare(`SELECT rating, feedbacks_count FROM wb_feedback_summary WHERE scope='nm' AND key_id = ?`).get(nm) || {}; } catch {}
  let fbImt = {};
  if (glue.imt_id) {
    try { fbImt = await db.prepare(`SELECT rating, feedbacks_count FROM wb_feedback_summary WHERE scope='imt' AND key_id = ?`).get(glue.imt_id) || {}; } catch {}
  }

  const product = {
    nm, name: art.name || String(nm), sa: ordInfo.sa || null, barcode: ordInfo.barcode || null,
    brand: art.brand || "", cat: ordInfo.cat || "", grp: art.subject || "",
    shop: shopName, im_url: art.im_url || null, platform: "wb",
    imt_id: glue.imt_id ?? null, imt_nm_count: glue.imt_nm_count ?? null,
    rating_nm: fbNm.rating ?? null, rating_nm_count: fbNm.feedbacks_count ?? null,
    rating_imt: fbImt.rating ?? null, rating_imt_count: fbImt.feedbacks_count ?? null,
  };

  // 2) daily_metrics — дневные метрики.
  //    price/spp в daily_metrics пустые → обогащаем из wb_orders (последние по дате).
  //    Берём AVG(spp) и MAX(total_price), MAX(discount_percent), MAX(price_with_disc)
  //    по дням — WB отдаёт их в каждом заказе, они стабильны в пределах дня.
  const metricRows = await db.prepare(
    `SELECT m.date, m.orders, m.clicks, m.cart, m.rating, m.ad_spend,
            o.total_price AS price_seller, o.discount_percent, o.price_with_disc, o.spp
     FROM daily_metrics m
     LEFT JOIN (
       SELECT substr(order_dt,1,10) AS d,
              MAX(total_price) AS total_price,
              MAX(discount_percent) AS discount_percent,
              MAX(price_with_disc) AS price_with_disc,
              ROUND(AVG(spp)) AS spp
       FROM orders WHERE nm_id = ? AND is_cancel = 0
         AND spp IS NOT NULL
       GROUP BY substr(order_dt,1,10)
     ) o ON o.d = m.date::text
     WHERE m.nm_id = ? AND m.date::text >= ? AND m.date::text <= ?
     ORDER BY m.date`
  ).all(nm, nm, from, to);

  // 2а) wb_prices — цена продавца (если daily_metrics не покрыла все дни).
  const priceRow = await db.prepare(
    `SELECT price_seller, discount, spp_auto FROM wb_prices WHERE nm_id = ?`
  ).get(nm) || {};

  // 2б) feedback_history (может быть пуста — graceful).
  const fbHistNm = new Map();
  try {
    for (const r of await db.prepare(`SELECT date, rating, feedbacks_count FROM wb_feedback_history WHERE scope='nm' AND key_id=? AND date>=? AND date<=?`).all(nm, from, to)) {
      fbHistNm.set(r.date, { rating: r.rating, count: r.feedbacks_count });
    }
  } catch {}
  const fbHistImt = new Map();
  if (glue.imt_id) {
    try {
      for (const r of await db.prepare(`SELECT date, rating, feedbacks_count FROM wb_feedback_history WHERE scope='imt' AND key_id=? AND date>=? AND date<=?`).all(glue.imt_id, from, to)) {
        fbHistImt.set(r.date, { rating: r.rating, count: r.feedbacks_count });
      }
    } catch {}
  }

  // 3) daily_ad — реклама по 3 моделям.
  const adRows = await db.prepare(
    `SELECT date, model, views, clicks, atbs, orders, spend FROM daily_ad WHERE nm_id = ? AND date >= ? AND date <= ?`
  ).all(nm, from, to);
  const adByDate = new Map();
  for (const r of adRows) {
    if (!adByDate.has(r.date)) adByDate.set(r.date, {});
    adByDate.get(r.date)[r.model] = r;
  }

  // 4) daily_stock — последний снимок (может быть пуст — graceful).
  let stockRows = [];
  let stockTotal = 0;
  let stockDateRow = null;
  try {
    // Последний снимок периода (упрощено: без коррелированного подзапроса,
    // который ломался под PG из-за convertSql переименования таблицы).
    stockRows = await db.prepare(
      `SELECT warehouse, SUM(quantity_full) AS quantity FROM daily_stock WHERE nm_id = ? AND date = (SELECT MAX(date) FROM daily_stock WHERE nm_id = ? AND date >= ? AND date <= ?) GROUP BY warehouse`
    ).all(nm, nm, from, to);
    stockRows.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    stockTotal = stockRows.reduce((s, w) => s + (w.quantity || 0), 0);
    stockDateRow = await db.prepare(`SELECT MAX(date) AS d FROM daily_stock WHERE nm_id = ? AND date >= ? AND date <= ?`).get(nm, from, to);
  } catch {}

  // 5) sales — продажи для локаций.
  let wbSales = { total: 0, localPct: null, byWarehouse: [], byCluster: [], byCity: [] };
  try {
    const saleRows = await db.prepare(
      `SELECT warehouse_name, region_name, okrug_name FROM sales WHERE sale_id LIKE 'S%' AND sale_dt >= ? AND sale_dt <= ? AND nm_id = ? AND warehouse_name IS NOT NULL`
    ).all(from + "T00:00:00", toEnd, nm);
    wbSales = buildSalesByLoc(saleRows, wbRegionOf);
  } catch {}

  // 4d) Декомпозиция рекламы (Σ по моделям за день).
  const adBreakRows = await db.prepare(
    `SELECT date, COALESCE(SUM(orders), 0) AS orders, COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(atbs), 0) AS atbs FROM daily_ad WHERE date >= ? AND date <= ? AND nm_id = ? AND (orders IS NOT NULL OR clicks IS NOT NULL OR atbs IS NOT NULL) GROUP BY date`
  ).all(from, to, nm);
  const adBreakByDate = new Map();
  for (const r of adBreakRows) adBreakByDate.set(r.date, { orders: r.orders, clicks: r.clicks, atbs: r.atbs });

  // 4e-g) Per-day через единый слой (wbMetrics lib).
  const prefix = nm + "|";
  const stripKey = (m) => {
    const out = new Map();
    for (const [k, v] of m) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
    return out;
  };
  const orderSumByDate = stripKey(await wbOrderRubByDay(db, { from, to, nmIds: [nm] }));
  const ordersCountByDate = stripKey(await wbOrdersByDay(db, { from, to, nmIds: [nm] }));
  const salesDayByDate = stripKey(await wbSoldByDay(db, { from, to, nmIds: [nm] }));
  const stockDayByDate = stripKey(await wbStockByDay(db, { from, to, nmIds: [nm] }));
  const finByDate = stripKey(await wbFinanceByDay(db, { from, to, nmIds: [nm] }));

  // 5б) Финансы периода.
  const fin = await wbFinancePeriod(db, { from, to, nmId: nm });
  const unitCost = await wbUnitCost(db, nm);

  // 6) Сборка days.
  const dateList = wbDateList(from, to);
  const dayMap = new Map(metricRows.map((r) => [r.date, r]));
  const SUM_KEYS = [
    "orders", "clicks", "cart",
    "ad_edinaya_views", "ad_edinaya_clicks", "ad_edinaya_atbs", "ad_edinaya_orders", "ad_edinaya_spend",
    "ad_ruchnaya_views", "ad_ruchnaya_clicks", "ad_ruchnaya_atbs", "ad_ruchnaya_orders", "ad_ruchnaya_spend",
    "ad_cliki_views", "ad_cliki_clicks", "ad_cliki_atbs", "ad_cliki_orders", "ad_cliki_spend",
    "orders_ad", "orders_organic", "clicks_ad", "clicks_organic", "cart_ad", "cart_organic",
    "sales", "wh_count", "stock",
  ];
  const totals = {};
  for (const k of SUM_KEYS) totals[k] = 0;
  totals.orders_plan = null;
  totals.orders_sum = 0;
  const lastSnap = { price: null, spp: null, rating: null };
  let lastSnapDate = "";

  const days = dateList.map((date) => {
    const m = dayMap.get(date) || {};
    const a = adByDate.get(date) || {};
    const e = a.edinaya || {}, ru = a.ruchnaya || {}, cl = a.cliki || {};
    const ad = adBreakByDate.get(date) || {};
    const mk = (total, adPart) => (total != null ? Math.max(0, total - (adPart ?? 0)) : null);
    const fd = finByDate.get(date);
    const dayRevenue = fd ? fd.salesRub : null;
    const daySold = salesDayByDate.has(date) ? salesDayByDate.get(date) : null;
    const dayCost = (fd && daySold != null) ? Math.round(((unitCost ?? 0) * daySold) * 100) / 100 : null;
    const dayAdSp = Math.round(((e.spend || 0) + (ru.spend || 0) + (cl.spend || 0)) * 100) / 100;
    const dayProfit = (fd && dayRevenue != null)
      ? Math.round((dayRevenue - (fd.commission || 0) - (fd.acquiring || 0) - (fd.logistics || 0) - (fd.loyalty || 0) - (dayCost || 0) - dayAdSp - Math.round(dayRevenue * USN_RATE * 100) / 100) * 100) / 100
      : null;
    const ordersTotal = ordersCountByDate.has(date) ? ordersCountByDate.get(date) : null;
    const clicksTotal = m.clicks ?? null;
    const cartTotal = m.cart ?? null;
    const day = {
      date, weekday: weekdayOf(date),
      orders: ordersTotal, orders_ad: ad.orders ?? null,
      orders_organic: ordersTotal != null ? mk(ordersTotal, ad.orders ?? 0) : null,
      orders_plan: null, orders_plan_month: null,
      orders_sum: orderSumByDate.get(date) ?? null,
      clicks: m.clicks ?? null, clicks_ad: ad.clicks ?? null,
      clicks_organic: clicksTotal != null ? mk(clicksTotal, ad.clicks ?? 0) : null,
      cart: m.cart ?? null, cart_ad: ad.atbs ?? null,
      cart_organic: cartTotal != null ? mk(cartTotal, ad.atbs ?? 0) : null,
      sales: salesDayByDate.get(date) ?? null,
      wh_count: stockDayByDate.has(date) ? stockDayByDate.get(date).wh : null,
      stock: stockDayByDate.has(date) ? stockDayByDate.get(date).stock : null,
      revenue: dayRevenue, cost: dayCost,
      commission: fd ? fd.commission : null,
      logistics: fd ? fd.logistics : null,
      acquiring: fd ? fd.acquiring : null,
      profit: dayProfit,
      // Цены из orders (price_seller=total_price, price_with_disc=цена со скидкой,
      // spp=% СПП). price_with_spp = price_with_disc × (1 - spp/100).
      price: m.price_seller ?? priceRow.price_seller ?? null,
      discount: m.discount_percent ?? priceRow.discount ?? null,
      spp: m.spp ?? null,
      price_with_disc: m.price_with_disc ?? null,
      price_with_spp: (m.price_with_disc != null && m.spp != null)
        ? Math.round(m.price_with_disc * (1 - m.spp / 100) * 100) / 100 : null,
      rating: m.rating ?? null,
      rating_nm: fbHistNm.has(date) ? fbHistNm.get(date).rating : null,
      rating_nm_count: fbHistNm.has(date) ? fbHistNm.get(date).count : null,
      rating_imt: fbHistImt.has(date) ? fbHistImt.get(date).rating : null,
      rating_imt_count: fbHistImt.has(date) ? fbHistImt.get(date).count : null,
      ad_edinaya_spend: e.spend ?? null, ad_edinaya_views: e.views ?? null,
      ad_edinaya_clicks: e.clicks ?? null, ad_edinaya_atbs: e.atbs ?? null, ad_edinaya_orders: e.orders ?? null,
      ad_ruchnaya_spend: ru.spend ?? null, ad_ruchnaya_views: ru.views ?? null,
      ad_ruchnaya_clicks: ru.clicks ?? null, ad_ruchnaya_atbs: ru.atbs ?? null, ad_ruchnaya_orders: ru.orders ?? null,
      ad_cliki_spend: cl.spend ?? null, ad_cliki_views: cl.views ?? null,
      ad_cliki_clicks: cl.clicks ?? null, ad_cliki_atbs: cl.atbs ?? null, ad_cliki_orders: cl.orders ?? null,
    };
    for (const k of SUM_KEYS) if (day[k] != null) totals[k] += day[k];
    if (day.orders_sum != null) totals.orders_sum += day.orders_sum;
    for (const k of ["price", "spp", "rating"]) {
      if (day[k] != null && date >= lastSnapDate) { lastSnap[k] = day[k]; lastSnapDate = date; }
    }
    return day;
  });

  totals.price = lastSnap.price != null ? Math.round(lastSnap.price) : null;
  totals.spp = lastSnap.spp != null ? Math.round(lastSnap.spp * 100) / 100 : null;
  totals.rating = lastSnap.rating != null ? Math.round(lastSnap.rating * 100) / 100 : null;
  // price_with_spp + discount в totals (последний снимок).
  const lastDay = days.length > 0 ? days[days.length - 1] : {};
  totals.discount = lastDay.discount ?? null;
  totals.price_with_disc = lastDay.price_with_disc ?? null;
  totals.price_with_spp = lastDay.price_with_spp ?? null;
  for (const k of SUM_KEYS) if (k.endsWith("spend")) totals[k] = Math.round(totals[k] * 100) / 100;

  const sold = totals.sales || 0;
  const salesRub = fin.salesRub;
  const costRub = Math.round(((unitCost ?? 0) * sold) * 100) / 100;
  const adSp = Math.round(((totals.ad_edinaya_spend || 0) + (totals.ad_ruchnaya_spend || 0) + (totals.ad_cliki_spend || 0)) * 100) / 100;
  const tax = Math.round(salesRub * USN_RATE * 100) / 100;
  totals.revenue = salesRub; totals.cost = costRub;
  totals.commission = fin.commission; totals.logistics = fin.logistics;
  totals.acquiring = fin.acquiring; totals.loyalty = 0;
  totals.adSpend = adSp; totals.tax = tax;
  totals.profit = Math.round((salesRub - fin.commission - fin.acquiring - fin.logistics - 0 - costRub - adSp - tax) * 100) / 100;

  // 7) Ключевые слова (могут быть пусты — graceful).
  const kwByDay = new Map();
  try {
    for (const r of await db.prepare(`SELECT date, keyword, position, is_ad, traffic FROM wb_item_keywords WHERE nm_id = ? AND date >= ? AND date <= ? AND position > 0`).all(nm, from, to)) {
      if (!kwByDay.has(r.keyword)) kwByDay.set(r.keyword, {});
      kwByDay.get(r.keyword)[r.date] = { position: r.position, is_ad: r.is_ad, traffic: r.traffic };
    }
  } catch {}
  const keywords = [...kwByDay.keys()].map((kw) => {
    const daysMap = kwByDay.get(kw) || {};
    const positions = dateList.map((d) => (daysMap[d] ? daysMap[d].position : null));
    const valid = positions.filter((p) => p != null);
    const last = [...valid].reverse().find((p) => p != null) ?? null;
    const traffics = dateList.map((d) => (daysMap[d] ? daysMap[d].traffic : null)).filter((t) => t != null && t > 0);
    return {
      keyword: kw, positions, last_position: last,
      avg_position: valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length * 10) / 10 : null,
      traffic_avg: traffics.length ? Math.round(traffics.reduce((a, b) => a + b, 0) / traffics.length) : null,
      traffic_last: traffics.length ? traffics[traffics.length - 1] : null,
      is_ad_last: Object.values(daysMap).slice(-1)[0]?.is_ad ?? 0,
    };
  }).filter((k) => k.last_position != null);

  return {
    period: { from, to, days: dateList.length },
    product, totals, days,
    stocks: { items: stockRows, total: stockTotal, snapshotDate: stockDateRow?.d || null },
    sales: wbSales, keywords,
    fin: {
      revenue: totals.revenue, cost: totals.cost, commission: totals.commission,
      logistics: totals.logistics, acquiring: totals.acquiring, loyalty: totals.loyalty,
      adSpend: totals.adSpend, tax: totals.tax, profit: totals.profit,
    },
  };
}

// =====================================================================
//  Ozon
// =====================================================================
async function collectOzon(nm, from, to, toEnd, shopName) {
  const db = new DatabaseSync("ozon", { readOnly: true });

  const p = await db.prepare(
    `SELECT product_id, offer_id, name, barcode, category, brand, im_url, price, old_price FROM products WHERE product_id = ?`
  ).get(nm) || null;
  if (!p) return { period: { from, to }, product: null };

  const product = {
    nm, name: p.name || String(nm), sa: p.offer_id || null, barcode: p.barcode || null,
    brand: p.brand || "", cat: p.category || "", grp: p.category || "",
    shop: shopName, im_url: p.im_url || null, platform: "ozon",
    price: p.price ?? null, old_price: p.old_price ?? null,
  };

  // Соинвест/буст (может быть пуст — graceful).
  try {
    const boostRow = await db.prepare(
      `SELECT MAX(current_boost) AS boost, COUNT(*) AS active_actions FROM ozon_action_products WHERE product_id = ? AND add_mode IN ('MANUAL','AUTO') AND current_boost IS NOT NULL AND current_boost > 0 AND date = (SELECT MAX(date) FROM ozon_action_products WHERE product_id = ?)`
    ).get(nm, nm) || {};
    product.boost = boostRow.boost != null ? Math.round(boostRow.boost * 100) / 100 : null;
    product.active_actions = boostRow.active_actions ?? 0;
  } catch { product.boost = null; product.active_actions = 0; }

  // daily_metrics.
  const metricRows = await db.prepare(
    `SELECT date, orders, clicks, cart, rating, price, ad_spend, ad_views, ad_clicks, ad_orders FROM daily_metrics WHERE product_id = ? AND date >= ? AND date <= ? ORDER BY date`
  ).all(nm, from, to);

  // Рейтинг (может быть пуст — graceful).
  try {
    const fbSnap = await db.prepare(`SELECT rating, feedbacks_count FROM ozon_feedback_summary WHERE product_id = ?`).get(nm) || {};
    product.rating_nm = fbSnap.rating != null ? Math.round(fbSnap.rating * 100) / 100 : null;
    product.rating_nm_count = fbSnap.feedbacks_count ?? null;
  } catch { product.rating_nm = null; product.rating_nm_count = null; }
  product.rating_imt = null; product.rating_imt_count = null; product.imt_nm_count = null;

  const fbHistNm = new Map();
  try {
    for (const r of await db.prepare(`SELECT date, rating, feedbacks_count FROM ozon_feedback_history WHERE product_id = ? AND date >= ? AND date <= ?`).all(nm, from, to)) {
      fbHistNm.set(r.date, { rating: r.rating, count: r.feedbacks_count });
    }
  } catch {}

  // Остатки (может быть пуст — graceful).
  let stockRows = []; let stockTotal = 0; let stockDateRow = null;
  try {
    stockRows = await db.prepare(
      `SELECT warehouse, SUM(fbo_present - fbo_reserved) AS quantity FROM daily_stock WHERE date = (SELECT MAX(date) FROM daily_stock WHERE product_id = ?) AND product_id = ? GROUP BY warehouse`
    ).all(nm, nm);
    stockRows.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    stockTotal = stockRows.reduce((s, w) => s + (w.quantity || 0), 0);
    stockDateRow = await db.prepare(`SELECT MAX(date) AS d FROM daily_stock WHERE product_id = ?`).get(nm);
  } catch {}

  // Города доставки.
  let byCity = []; let ordTotal = 0;
  try {
    const ordLoc = await db.prepare(
      `SELECT region AS name, COUNT(*) AS count FROM orders WHERE product_id = ? AND substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ? GROUP BY region ORDER BY count DESC`
    ).all(nm, from, toEnd);
    ordTotal = ordLoc.reduce((s, r) => s + (r.count || 0), 0);
    byCity = ordLoc.filter((r) => r.name).map((r) => ({
      name: r.name, count: r.count,
      share: ordTotal > 0 ? Math.round((r.count / ordTotal) * 1000) / 10 : null,
    }));
  } catch {}

  // Финансы периода.
  const finPeriod = await ozOrderCostsAggregate(db, { from, to, productId: nm });

  // Динамика по дням.
  const profitByDay = new Map();
  for (const r of await db.prepare(
    `SELECT substr(sale_dt,1,10) AS d, SUM(profit) AS p FROM order_costs WHERE product_id = ? AND sale_dt IS NOT NULL AND substr(sale_dt,1,10) >= ? AND substr(sale_dt,1,10) <= ? AND is_return = 0 GROUP BY substr(sale_dt,1,10)`
  ).all(nm, from, to)) {
    profitByDay.set(r.d, Math.round((r.p || 0) * 100) / 100);
  }
  const revenueByDay = new Map();
  for (const r of await db.prepare(
    `SELECT substr(sale_dt,1,10) AS d, SUM(cost_value_retail * qty) AS s FROM order_costs WHERE product_id = ? AND sale_dt IS NOT NULL AND substr(sale_dt,1,10) >= ? AND substr(sale_dt,1,10) <= ? AND is_return = 0 GROUP BY substr(sale_dt,1,10)`
  ).all(nm, from, to)) {
    revenueByDay.set(r.d, Math.round((r.s || 0) * 100) / 100);
  }
  const soldByDay = new Map();
  for (const r of await db.prepare(
    `SELECT substr(sale_dt,1,10) AS d, COUNT(*) AS cnt FROM order_costs WHERE product_id = ? AND sale_dt IS NOT NULL AND substr(sale_dt,1,10) >= ? AND substr(sale_dt,1,10) <= ? AND is_return = 0 GROUP BY substr(sale_dt,1,10)`
  ).all(nm, from, to)) {
    soldByDay.set(r.d, r.cnt);
  }
  const orderSumByDay = new Map();
  for (const r of await db.prepare(
    `SELECT substr(order_dt,1,10) AS d, SUM(total) AS s FROM orders WHERE product_id = ? AND order_dt IS NOT NULL AND substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ? AND is_cancel = 0 GROUP BY substr(order_dt,1,10)`
  ).all(nm, from, to)) {
    orderSumByDay.set(r.d, Math.round((r.s || 0) * 100) / 100);
  }

  // Сборка days.
  const dateList = wbDateList(from, to);
  const dayMap = new Map(metricRows.map((r) => [r.date, r]));
  const totals = {
    orders: 0, clicks: 0, cart: 0, ad_spend: 0, ad_views: 0, ad_clicks: 0, ad_orders: 0,
    orders_sum: 0, revenue: Math.round((finPeriod.revenue || 0) * 100) / 100,
    profit: 0, profitGross: finPeriod.profitGross,
  };
  let lastRating = null;

  const days = dateList.map((date) => {
    const m = dayMap.get(date) || {};
    const price = m.price ?? p.price ?? null;
    const rev = revenueByDay.has(date) ? revenueByDay.get(date) : null;
    const grossDay = profitByDay.has(date) ? profitByDay.get(date) : null;
    const adDay = m.ad_spend ?? 0;
    const taxDay = rev != null ? Math.round(rev * USN_RATE * 100) / 100 : 0;
    const profit = grossDay != null ? Math.round((grossDay - adDay - taxDay) * 100) / 100 : null;
    const fb = fbHistNm.get(date);
    const ratingNm = fb ? fb.rating : null;
    if (ratingNm != null) lastRating = ratingNm;
    const day = {
      date, weekday: weekdayOf(date),
      orders: m.orders ?? null, clicks: m.clicks ?? null, cart: m.cart ?? null,
      price, boost: product.boost,
      sold: soldByDay.has(date) ? soldByDay.get(date) : null,
      rating: m.rating ?? null, rating_nm: ratingNm, rating_nm_count: fb ? fb.count : null,
      rating_imt: null, rating_imt_count: null,
      ad_spend: m.ad_spend ?? null, ad_views: m.ad_views ?? null,
      ad_clicks: m.ad_clicks ?? null, ad_orders: m.ad_orders ?? null,
      orders_ad: m.ad_orders ?? 0,
      orders_organic: m.orders != null ? (m.orders - (m.ad_orders ?? 0)) : null,
      orders_sum: orderSumByDay.has(date) ? orderSumByDay.get(date) : null,
      revenue: rev, profit,
    };
    for (const k of ["orders", "clicks", "cart", "ad_spend", "ad_views", "ad_clicks", "ad_orders"]) {
      if (day[k] != null) totals[k] += day[k];
    }
    totals.orders_ad = (totals.orders_ad || 0) + (day.orders_ad || 0);
    totals.orders_organic = (totals.orders_organic || 0) + (day.orders_organic || 0);
    if (day.sold != null) totals.sold = (totals.sold || 0) + day.sold;
    if (day.orders_sum != null) totals.orders_sum += day.orders_sum;
    return day;
  });

  totals.price = p.price != null ? Math.round(p.price) : null;
  totals.old_price = p.old_price != null ? Math.round(p.old_price) : null;
  totals.boost = product.boost;
  totals.rating = lastRating != null ? Math.round(lastRating * 100) / 100 : null;
  totals.rating_nm = product.rating_nm;
  totals.rating_nm_count = product.rating_nm_count;
  for (const k of ["ad_spend", "ad_views", "ad_clicks", "ad_orders", "orders_sum"]) {
    totals[k] = Math.round(totals[k] * 100) / 100;
  }
  totals.tax = Math.round((totals.revenue || 0) * USN_RATE * 100) / 100;
  totals.profit = Math.round(((totals.profitGross || 0) - (totals.ad_spend || 0) - totals.tax) * 100) / 100;

  return {
    period: { from, to, days: dateList.length },
    product, totals, days,
    stocks: { items: stockRows, total: stockTotal, snapshotDate: stockDateRow?.d || null },
    sales: { total: ordTotal, localPct: null, byWarehouse: [], byCluster: [], byCity },
    fin: {
      revenue: totals.revenue, cost: Math.round((finPeriod.cost || 0) * 100) / 100,
      commission: Math.round((finPeriod.commission || 0) * 100) / 100,
      logistics: Math.round((finPeriod.logistics || 0) * 100) / 100,
      acquiring: Math.round((finPeriod.acquiring || 0) * 100) / 100,
      loyalty: Math.round((finPeriod.loyalty || 0) * 100) / 100,
      adSpend: totals.ad_spend, tax: totals.tax, profit: totals.profit,
    },
  };
}
