// /api/cabinets/[id]/unit/all — единая юнит-экономика WB + Ozon.
// Перенос эталона data-presenter/api/unit/all/route.js с адаптацией под PG:
// DatabaseSync('wb'/'ozon') для таблиц маркетплейсов + tenantQuery для
// tenant.unit_inputs (RLS по cabinet). Логика calcWB/calcOzon — в lib/unit.js.
import { NextResponse } from "next/server";
import { DatabaseSync, tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { calcWB, calcOzon } from "@/lib/unit.js";
import { normalizeTaxMode } from "@/lib/tax.js";
import { statusMap } from "@/lib/finItems.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Конвертировать tax_mode {type,rate,vat} в ставки для calcWB/calcOzon.
// usnRate = rate/100 (доля). vatRate — ВЫДЕЛЕНИЕ «изнутри» цены с НДС:
//   vat/(100+vat) (для 5% → 5/105). Это совпадает с дефолтом TAX.VAT_RATE в lib/unit.js.
//   (Раньше было vat/100 = начисление сверху — ломало базу НДС/УСН, урок D14.)
function taxRates(taxMode) {
  const tm = normalizeTaxMode(taxMode);
  return { usnRate: tm.rate / 100, vatRate: tm.vat / (100 + tm.vat) };
}

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    // ?includeInactive=1 — показать и inactive (по умолчанию фильтруется только active).
    const includeInactive = url.searchParams.get("includeInactive") === "1";
    const mps = cabinet.marketplaces || ["wb", "ozon"];
    const wbRates = taxRates(cabinet.shopTax?.wb);
    const ozRates = taxRates(cabinet.shopTax?.ozon);
    const wbItems = mps.includes("wb") ? await computeWB(wbRates, { includeInactive }) : [];
    const ozonItems = mps.includes("ozon") ? await computeOzon(ozRates, { includeInactive }) : [];
    const items = [...wbItems, ...ozonItems];
    const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
    const whatif = await loadWhatif();

    const valid = items.filter((i) => !i.draft && Number.isFinite(i.profit));
    const totals = {
      count: valid.length,
      draftCount: items.length - valid.length,
      profit: Math.round(valid.reduce((a, i) => a + i.profit, 0)),
      revenue: Math.round(valid.reduce((a, i) => a + (i.revNet || 0), 0)),
      vat: Math.round(valid.reduce((a, i) => a + (i.vat || 0), 0)),
      usn: Math.round(valid.reduce((a, i) => a + (i.usn || 0), 0)),
      lossCount: valid.filter((i) => i.profit < 0).length,
      avgMargin: valid.length > 0
        ? Math.round((valid.reduce((a, i) => a + (Number.isFinite(i.margin) ? i.margin : 0), 0) / valid.length) * 1000) / 10
        : 0,
      wb: aggPlatform(valid, "wb"),
      ozon: aggPlatform(valid, "ozon"),
    };
    return NextResponse.json({ items, totals, categories, whatif });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

function aggPlatform(items, platform) {
  const arr = items.filter((i) => i.platform === platform);
  return {
    count: arr.length,
    profit: Math.round(arr.reduce((a, i) => a + i.profit, 0)),
    avgMargin: arr.length > 0
      ? Math.round((arr.reduce((a, i) => a + (Number.isFinite(i.margin) ? i.margin : 0), 0) / arr.length) * 1000) / 10
      : 0,
    lossCount: arr.filter((i) => i.profit < 0).length,
  };
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function autoWb(s) {
  const sold = s.sold || 0, returns = s.returns || 0, revGross = s.rev_gross || 0;
  const priceWithDisc = s.price_withdisc != null ? s.price_withdisc : 0;
  const avgPrice = priceWithDisc || (sold > 0 ? revGross / sold : 0);
  const ordersAll = sold + returns;
  const buyout = ordersAll > 0 ? sold / ordersAll : 0;
  const commissionRate = s.commission_pct != null && Number.isFinite(s.commission_pct) ? s.commission_pct / 100 : null;
  return { priceWb: avgPrice, buyout, commissionRate };
}

function autoOzon(s, p, cost) {
  const ordersAll = s.orders_all || 0;
  const delivered = s.delivered || 0;
  const avgPrice = s.avg_price != null && Number.isFinite(s.avg_price) ? s.avg_price : 0;
  const productPrice = p?.price != null && Number.isFinite(p.price) && p.price > 0 ? p.price : 0;
  const priceOzon = avgPrice > 0 ? avgPrice : productPrice;
  const buyout = ordersAll > 0 ? delivered / ordersAll : 0;
  const commissionRate = p.commission_pct != null && Number.isFinite(p.commission_pct) ? p.commission_pct / 100 : null;
  return { priceOzon, buyout, commissionRate, logisticsFbo: p.logistics_fbo_tariff ?? null, cost: cost ?? null };
}

// Загрузка ручных overrides из tenant.unit_inputs (RLS по cabinet).
async function loadManual(platform) {
  try {
    const rows = await tenantQuery(
      `SELECT sku, key, value, note FROM tenant.unit_inputs WHERE platform = $1`,
      [platform]
    );
    const out = {};
    for (const r of rows) {
      if (!out[r.sku]) out[r.sku] = { sku: r.sku };
      if (r.key === "name") out[r.sku].name = r.note;
      else if (r.value != null) out[r.sku][r.key] = r.value;
    }
    return out;
  } catch { return {}; }
}

// Персист what-if прикидок (tenant.unit_whatif, миграция 046) — целиком
// набор входов на товар, отдельно от «↧ в факт» (tenant.unit_inputs).
// Ответ: { wb: { nmId: inputs }, ozon: { productId: inputs } }.
async function loadWhatif() {
  try {
    const rows = await tenantQuery(
      `SELECT platform, item_id, inputs FROM tenant.unit_whatif`
    );
    const out = { wb: {}, ozon: {} };
    for (const r of rows) {
      if (out[r.platform]) out[r.platform][String(r.item_id)] = r.inputs;
    }
    return out;
  } catch { return { wb: {}, ozon: {} }; }
}

// ---------- WB ----------
async function computeWB(rates = {}, { includeInactive = false } = {}) {
  const db = new DatabaseSync("wb", { readOnly: true });
  const salesRows = await db.prepare(
    `SELECT nm_id, MAX(sa_name) AS art,
       SUM(CASE WHEN supplier_oper_name='Продажа' THEN quantity ELSE 0 END) AS sold,
       SUM(CASE WHEN supplier_oper_name='Возврат' THEN quantity ELSE 0 END) AS returns,
       SUM(CASE WHEN supplier_oper_name='Продажа' THEN retail_amount ELSE 0 END) AS rev_gross,
       AVG(CASE WHEN supplier_oper_name='Продажа' AND commission_percent IS NOT NULL THEN commission_percent END) AS commission_pct,
       AVG(CASE WHEN supplier_oper_name='Продажа' AND retail_price_withdisc_rub IS NOT NULL THEN retail_price_withdisc_rub END) AS price_withdisc
     FROM finance_report WHERE nm_id <> 0 GROUP BY nm_id`
  ).all();

  const names = {}, subjects = {}, imgs = {};
  for (const r of await db.prepare("SELECT nm_id, name, subject, im_url FROM articles").all()) {
    names[r.nm_id] = r.name;
    subjects[r.nm_id] = r.subject || null;
    if (r.im_url) imgs[r.nm_id] = r.im_url;
  }
  // Себестоимость — единый источник: tenant.cost_overrides (с 2026-07-14).
  // Актуальный override = последний с effective_from <= сегодня. DISTINCT ON
  // убирает дубли по nm_id, оставляя самую свежую запись.
  const cogs = {};
  for (const r of await db.prepare(
    `SELECT DISTINCT ON (nm_id) nm_id, cost FROM tenant.cost_overrides
     WHERE platform = 'wb' AND effective_from <= current_date
     ORDER BY nm_id, effective_from DESC`
  ).all()) cogs[r.nm_id] = r.cost > 0 ? r.cost : null;
  const prices = {};
  for (const r of await db.prepare("SELECT nm_id, price_seller, discount, price_site FROM wb_prices").all()) {
    prices[r.nm_id] = {
      priceSeller: r.price_seller > 0 ? r.price_seller : null,
      discount: r.discount != null ? r.discount / 100 : null,
      // priceBuy = реальная цена сайта (card.wb.ru, price_site, миграция 029) —
      // база налогов по решению хозяина 2026-08-02: цена, которую платит
      // покупатель (с СПП). price_buyer (discountedPrice, БЕЗ СПП) как базу
      // НЕ подаём. Нет price_site → calcWB считает через СПП: цена×(1−spp).
      priceBuy: r.price_site != null && r.price_site > 0 ? r.price_site : null,
    };
  }
  // SPP из daily_metrics — последнее не-NULL значение по nm_id.
  const sppAuto = {};
  for (const r of await db.prepare(
    `SELECT nm_id, spp FROM (
       SELECT nm_id, spp,
              ROW_NUMBER() OVER (PARTITION BY nm_id ORDER BY date DESC) AS rn
       FROM daily_metrics WHERE spp IS NOT NULL
     ) WHERE rn = 1`
  ).all()) {
    sppAuto[r.nm_id] = r.spp;
  }
  const manual = await loadManual("wb");
  // Статус SKU (active|inactive) — единый источник tenant.item_status с fallback "active"
  // (как на странице «Себестоимость» /items). По умолчанию юнитка показывает только active.
  const stat = await statusMap();

  const result = [];
  for (const s of salesRows) {
    const nm = s.nm_id;
    const name = names[nm] || s.art || String(nm);
    const input = { ...autoWb(s), spp: sppAuto[nm] ?? null, ...manual[String(nm)], sku: String(nm), name, ...rates };
    if (cogs[nm] != null) input.cost = cogs[nm];
    if (prices[nm]) {
      if (prices[nm].priceSeller != null) input.priceSeller = prices[nm].priceSeller;
      if (prices[nm].discount != null) input.discount = prices[nm].discount;
      if (prices[nm].priceBuy != null) input.priceBuy = prices[nm].priceBuy;
    }
    const r = await calcWB(input);
    r.platform = "wb";
    r.article = String(nm);
    r.category = subjects[nm] || null;
    if (imgs[nm]) r.im_url = imgs[nm];
    r.draft = !input.priceWb && !input.priceSeller;
    r.status = stat[`wb|${nm}|0`] || "active";
    result.push(r);
  }

  // Активные товары БЕЗ продаж (estimated: buyout=0.9, commission=средняя по категории).
  const usedNm = new Set(salesRows.map((s) => s.nm_id));
  const commBySubject = {};
  let allCommissions = [];
  for (const r of await db.prepare(
    `SELECT a.subject AS subject, fr.commission_percent AS pct
     FROM finance_report fr JOIN articles a ON a.nm_id = fr.nm_id
     WHERE fr.commission_percent IS NOT NULL
       AND fr.commission_percent > 0
       AND fr.supplier_oper_name = 'Продажа'`
  ).all()) {
    const pct = Number.isFinite(r.pct) ? r.pct : null;
    if (pct == null) continue;
    if (r.subject) {
      if (!commBySubject[r.subject]) commBySubject[r.subject] = [];
      commBySubject[r.subject].push(pct);
    }
    allCommissions.push(pct);
  }
  const subjAvg = {};
  for (const [subj, arr] of Object.entries(commBySubject)) {
    subjAvg[subj] = arr.reduce((a, b) => a + b, 0) / arr.length / 100;
  }
  const globalComm = allCommissions.length > 0 ? median(allCommissions) / 100 : 0.28;

  const activeNoSales = Object.keys(prices)
    .map((k) => Number(k))
    .filter((nm) => !usedNm.has(nm)
      && prices[nm]
      && prices[nm].priceSeller != null
      && prices[nm].priceSeller > 0);
  for (const nm of activeNoSales) {
    const subject = subjects[nm] || null;
    const name = names[nm] || String(nm);
    const input = {
      sku: String(nm), name,
      priceSeller: prices[nm].priceSeller,
      discount: prices[nm].discount,
      priceBuy: prices[nm].priceBuy ?? null,
      buyout: 0.9,
      commissionRate: subject && subjAvg[subject] != null ? subjAvg[subject] : globalComm,
      spp: sppAuto[nm] ?? null,
      ...manual[String(nm)],
      ...rates,
    };
    if (cogs[nm] != null) input.cost = cogs[nm];
    const r = await calcWB(input);
    r.platform = "wb";
    r.article = String(nm);
    r.category = subject;
    if (imgs[nm]) r.im_url = imgs[nm];
    r.draft = false;
    r.estimated = true; // выкуп/комиссия — оценка
    r.status = stat[`wb|${nm}|0`] || "active";
    result.push(r);
  }
  return includeInactive ? result : result.filter((r) => r.status === "active");
}

// ---------- Ozon ----------
async function computeOzon(rates = {}, { includeInactive = false } = {}) {
  const db = new DatabaseSync("ozon", { readOnly: true });
  const products = {};
  for (const r of await db.prepare(
    `SELECT product_id, offer_id, name, category, brand,
            commission_pct, logistics_fbo_tariff, price, im_url
     FROM products`
  ).all()) products[r.product_id] = r;

  const orderRows = await db.prepare(
    `SELECT product_id,
       COUNT(*) AS orders_all,
       SUM(CASE WHEN status IN ('delivered') THEN 1 ELSE 0 END) AS delivered,
       AVG(CASE WHEN status != 'cancelled' THEN price END) AS avg_price
     FROM orders WHERE product_id IS NOT NULL GROUP BY product_id`
  ).all();

  // Себестоимость — единый источник: tenant.cost_overrides (с 2026-07-14).
  const cogs = {};
  for (const r of await db.prepare(
    `SELECT DISTINCT ON (product_id) product_id, cost FROM tenant.cost_overrides
     WHERE platform = 'ozon' AND effective_from <= current_date
     ORDER BY product_id, effective_from DESC`
  ).all()) cogs[r.product_id] = r.cost > 0 ? r.cost : null;
  const manual = await loadManual("ozon");
  // Статус SKU — см. computeWB.
  const stat = await statusMap();

  // Бустинг Ozon — MAX(current_boost) на последнюю дату.
  const boostByPid = {};
  try {
    for (const r of await db.prepare(
      `SELECT product_id, MAX(current_boost) AS boost
       FROM ozon_action_products
       WHERE date = (SELECT MAX(date) FROM ozon_action_products)
         AND current_boost IS NOT NULL AND current_boost > 0
       GROUP BY product_id`
    ).all()) boostByPid[r.product_id] = r.boost;
  } catch {}

  const result = [];
  const usedIds = new Set();
  for (const s of orderRows) {
    const pid = s.product_id;
    const p = products[pid] || {};
    const name = p.name || p.offer_id || String(pid);
    const input = { ...autoOzon(s, p, cogs[pid]), boost: boostByPid[pid] ?? 0, ...manual[String(pid)], sku: String(pid), name, ...rates };
    const r = await calcOzon(input);
    r.platform = "ozon";
    r.article = p.offer_id || String(pid);
    r.category = p.category || null;
    if (p.im_url) r.im_url = p.im_url;
    r.draft = !input.priceOzon;
    r.status = stat[`ozon|0|${pid}`] || "active";
    result.push(r);
    usedIds.add(String(pid));
  }
  // Товары без продаж (draft).
  for (const [pidKey, p] of Object.entries(products)) {
    if (usedIds.has(String(pidKey))) continue;
    const pid = Number(pidKey);
    const productPrice = p.price != null && Number.isFinite(p.price) && p.price > 0 ? p.price : null;
    const input = {
      priceOzon: productPrice,
      commissionRate: p.commission_pct != null ? p.commission_pct / 100 : null,
      logisticsFbo: p.logistics_fbo_tariff ?? null,
      boost: boostByPid[pid] ?? 0,
      cost: cogs[pid] ?? null,
      sku: String(pid), name: p.name || p.offer_id || String(pid),
      ...rates,
    };
    const r = await calcOzon(input);
    r.platform = "ozon";
    r.article = p.offer_id || String(pid);
    r.category = p.category || null;
    if (p.im_url) r.im_url = p.im_url;
    r.draft = !input.priceOzon;
    r.status = stat[`ozon|0|${pid}`] || "active";
    result.push(r);
  }
  return includeInactive ? result : result.filter((r) => r.status === "active");
}
