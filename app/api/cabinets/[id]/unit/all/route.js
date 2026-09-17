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
import { defaultPeriod } from "@/lib/period.js";

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
      wb: { ...aggPlatform(valid, "wb"), usnDefault: round4(wbRates.usnRate) },
      ozon: { ...aggPlatform(valid, "ozon"), usnDefault: round4(ozRates.usnRate) },
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

// Дефолтная ставка УСН кабинета (фракция) — тот же источник, что и колонка
// «УСН» в calcWB/calcOzon (taxRates(cabinet.shopTax.<platform>) выше). Отдаётся
// в totals.<platform>.usnDefault (задача 2026-08-27-unit-modes/1, §3 плана) —
// клиент (UnitPage.jsx) сеет дефолт «Ставки УСН, %» из неё, а не хардкодом.
function round4(v) {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
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

// Авто-входы Ozon: цена продавца из каталога (products.price = marketing_seller_price,
// решение владельца 17.09.2026), каталожные ставки — только как fallback (факт
// из начислений подмешивается в computeOzon поверх).
function autoOzon(p, cost) {
  const productPrice = p?.price != null && Number.isFinite(p.price) && p.price > 0 ? p.price : 0;
  const commissionRate = p?.commission_pct != null && Number.isFinite(p.commission_pct) ? p.commission_pct / 100 : null;
  return { priceOzon: productPrice, commissionRate, logisticsFbo: p?.logistics_fbo_tariff ?? null, cost: cost ?? null };
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
// Модель уровня WB (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §3):
// факты за 30 дней ПО ВЧЕРА из начислений (order_costs) одним batch-SQL —
// комиссия/эквайринг (доли от цены), прямая логистика F на проданную штуку,
// логистика невыкупа R на одну невыкупленную (is_return=1: цена 0, парной
// продажи нет), % выкупа b = продано/(продано+невыкупы), справочная
// средняя цена проданного. Соинвест — из снимков кабинета tenant.ozon_prices
// (source='cabinet'), последний день; нет снимка → null («—», не 0%).
async function computeOzon(rates = {}, { includeInactive = false } = {}) {
  const db = new DatabaseSync("ozon", { readOnly: true });
  const products = {};
  for (const r of await db.prepare(
    `SELECT product_id, offer_id, name, category, brand,
            commission_pct, logistics_fbo_tariff, price, im_url
     FROM products`
  ).all()) products[r.product_id] = r;

  const cogs = {};
  for (const r of await db.prepare(
    `SELECT DISTINCT ON (product_id) product_id, cost FROM tenant.cost_overrides
     WHERE platform = 'ozon' AND effective_from <= current_date
     ORDER BY product_id, effective_from DESC`
  ).all()) cogs[r.product_id] = r.cost > 0 ? r.cost : null;
  const manual = await loadManual("ozon");
  const stat = await statusMap();

  // Факты окна. ABS(SUM(...)) — суммы в конвенции площадки, модель ждёт положительные ₽.
  const { from: winFrom, to: winTo } = defaultPeriod(30);
  const facts = {};
  let totRet = 0, totReturns = 0, totAcq = 0, totRetail = 0;
  for (const r of await db.prepare(
    `SELECT product_id,
        COALESCE(SUM(qty) FILTER (WHERE is_return = 0), 0)            AS sold,
        COALESCE(SUM(qty) FILTER (WHERE is_return = 1), 0)            AS returns,
        ABS(COALESCE(SUM(logistics) FILTER (WHERE is_return = 0), 0)) AS log_fwd,
        ABS(COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0)) AS log_ret,
        ABS(COALESCE(SUM(commission) FILTER (WHERE is_return = 0), 0)) AS comm_sum,
        ABS(COALESCE(SUM(acquiring) FILTER (WHERE is_return = 0), 0))  AS acq_sum,
        COALESCE(SUM(cost_value_retail) FILTER (WHERE is_return = 0), 0) AS retail_sum
      FROM order_costs
      WHERE product_id IS NOT NULL
        AND substr(COALESCE(sale_dt, return_dt), 1, 10) >= ?
        AND substr(COALESCE(sale_dt, return_dt), 1, 10) <= ?
      GROUP BY product_id`
  ).all(winFrom, winTo)) {
    facts[r.product_id] = r;
    totRet += r.log_ret; totReturns += r.returns; totAcq += r.acq_sum; totRetail += r.retail_sum;
  }
  const cabinetR = totReturns > 0 ? totRet / totReturns : 0;
  const cabinetAcq = totRetail > 0 ? totAcq / totRetail : 0.015;

  // Соинвест из снимков кабинета (миграция 059: source='cabinet'). Колонки source
  // до миграции нет; упавший SELECT переводит ОБЩУЮ транзакцию запроса в aborted
  // (withTenant без SAVEPOINT) и молча роняет loadWhatif() дальше по хендлеру —
  // поэтому сначала безопасная проверка наличия колонки, и только потом запрос.
  const boostByPid = {};
  const hasSource = (await db.prepare(
    `SELECT 1 AS ok FROM information_schema.columns
     WHERE table_schema = 'tenant' AND table_name = 'ozon_prices' AND column_name = 'source'`
  ).all()).length > 0;
  if (hasSource) {
    for (const r of await db.prepare(
      `SELECT product_id, marketing_seller_price AS sp, marketing_price AS mp
       FROM ozon_prices
       WHERE source = 'cabinet'
         AND date = (SELECT MAX(date) FROM ozon_prices WHERE source = 'cabinet')`
    ).all()) {
      if (r.sp > 0 && r.mp > 0 && r.mp <= r.sp) boostByPid[r.product_id] = 1 - r.mp / r.sp;
    }
  }

  // Факт-входы одного товара поверх каталожных; null там, где факта нет.
  function factInputs(pid) {
    const f = facts[pid];
    if (!f || !(f.sold > 0)) return null;
    return {
      commissionRate: f.retail_sum > 0 ? f.comm_sum / f.retail_sum : null,
      acquiringRate: f.retail_sum > 0 ? f.acq_sum / f.retail_sum : null,
      logisticsFbo: f.log_fwd / f.sold,
      returnLogistics: f.returns > 0 ? f.log_ret / f.returns : cabinetR,
      buyout: f.sold / (f.sold + f.returns),
      priceFact: f.retail_sum > 0 ? f.retail_sum / f.sold : null,
    };
  }

  const result = [];
  for (const [pidKey, p] of Object.entries(products)) {
    const pid = Number(pidKey);
    const fact = factInputs(pid);
    const input = {
      ...autoOzon(p, cogs[pid]),
      acquiringRate: cabinetAcq,
      returnLogistics: cabinetR,
      buyout: 1,
      ...(fact ? Object.fromEntries(Object.entries(fact).filter(([, v]) => v != null)) : {}),
      boost: boostByPid[pid] ?? null,
      ...manual[String(pid)], // ручной override (unit_inputs) — старше факта
      sku: String(pid), name: p.name || p.offer_id || String(pid), ...rates,
    };
    const r = calcOzon(input);
    r.platform = "ozon";
    r.article = p.offer_id || String(pid);
    r.category = p.category || null;
    if (p.im_url) r.im_url = p.im_url;
    r.draft = !input.priceOzon;
    r.status = stat[`ozon|0|${pid}`] || "active";
    // «⚙ оценка» — факта за окно нет ИЛИ есть продажи без выручки (retail_sum=0,
    // commissionRate=null): комиссия/логистика каталожные, эквайринг/невыкуп — по кабинету.
    if ((!fact || fact.commissionRate == null) && manual[String(pid)]?.logisticsFbo == null) r.estimated = true;
    result.push(r);
  }
  return includeInactive ? result : result.filter((r) => r.status === "active");
}
