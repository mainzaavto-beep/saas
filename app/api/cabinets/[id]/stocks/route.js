import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
//  /api/cabinets/[id]/stocks — раздел «Сводка по товарам → Склады и индексы».
//
//  Отличие от /mp-stock: здесь фокус не на срезе остатков по nm_id, а на:
//    • распределении остатков по складам МП (% , доля мёртвого стока);
//    • индексах OOS по товарам — дней до out-of-stock, оборачиваемость;
//    • динамике остатков по дням (история);
//    • финансах по складам (мёртвый капитал).
//
//  Один GET возвращает всё для 4 вкладок страницы (чтобы UI не дёргал 4 роута).
//  Query: ?vel=7|14|30|60 — окно расчёта velocity (продаж/день), дефолт 7.
//
//  Источники (RLS по cabinet_id через DatabaseSync):
//    WB:   daily_stock (остатки по складам) + daily_metrics.orders (velocity)
//          + cost_overrides (себест) + wb_prices (цена) + articles (имя/кат)
//    Ozon: daily_stock (FBO по складам) + daily_metrics.orders (velocity)
//          + cost_overrides (себест) + products.price (цена) + products (имя/кат)
//
//  velocity = SUM(orders за vel дней) / GREATEST(число дней с продажами, 1) —
//  деление на дни-с-продажами (а не на vel) делает показатель устойчивым к
//  провалам/новым товарам. Нет продаж → velocity=0 → status='no_sales'.
// =====================================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const qp = req ? new URL(req.url).searchParams : null;
    // Окно velocity: 7/14/30/60 (по согласованию с хозяином — выбирается на странице).
    const velRaw = parseInt(qp?.get("vel"), 10);
    const vel = [7, 14, 30, 60].includes(velRaw) ? velRaw : 7;

    const wb = await collectWB(vel);
    const oz = await collectOzon(vel);

    const allItems = [...wb.items, ...oz.items];
    const allWarehouses = [...wb.byWarehouse, ...oz.byWarehouse];

    // OOS-статус по каждому товару (сортировка: срочные сверху, no_sales в конце).
    const itemsWithStatus = allItems
      .map((it) => enrichOos(it))
      .sort(oosSort);

    // Мёртвый капитал = Σ себест. товаров без продаж (velocity=0) с остатком > 0.
    const deadCapital = round2(
      itemsWithStatus
        .filter((it) => it.status === "no_sales" && (it.quantity_full || 0) > 0)
        .reduce((acc, it) => acc + (it.value_cost || 0), 0)
    );

    const totals = {
      wb: aggTotals(wb.items),
      ozon: aggTotals(oz.items),
      all: aggTotals(allItems),
    };
    // dead_capital добавляем в каждый totals-блок по своему МП.
    totals.wb.dead_capital = round2(itemsWithStatus
      .filter((it) => it.platform === "wb" && it.status === "no_sales" && (it.quantity_full || 0) > 0)
      .reduce((a, it) => a + (it.value_cost || 0), 0));
    totals.ozon.dead_capital = round2(itemsWithStatus
      .filter((it) => it.platform === "ozon" && it.status === "no_sales" && (it.quantity_full || 0) > 0)
      .reduce((a, it) => a + (it.value_cost || 0), 0));
    totals.all.dead_capital = deadCapital;

    return NextResponse.json({
      date: wb.date || oz.date || null,
      dateWb: wb.date,
      dateOzon: oz.date,
      velocityWindow: vel,
      wbTooShort: wb.tooShort,
      // Вкладка 1: распределение по складам
      byWarehouse: allWarehouses,
      // Вкладка 2: индексы OOS
      items: itemsWithStatus,
      // Вкладка 3: динамика остатков
      dynamics: { wb: wb.dynamics, ozon: oz.dynamics },
      // Вкладка 4 + KPI
      totals,
      deadCapital,
      categories: [...new Set(allItems.map((i) => i.category).filter(Boolean))].sort(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

// ---------- Сводный итог по списку items (для KPI) ----------
function aggTotals(items) {
  const t = { items: 0, quantity_full: 0, value_cost: 0, value_retail: 0 };
  for (const it of items) {
    t.items += 1;
    t.quantity_full += it.quantity_full || 0;
    t.value_cost += it.value_cost || 0;
    t.value_retail += it.value_retail || 0;
  }
  t.value_cost = round2(t.value_cost);
  t.value_retail = round2(t.value_retail);
  return t;
}

// ---------- OOS: считаем velocity/days_to_oos/status ----------
function enrichOos(it) {
  const qty = Number(it.quantity_full) || 0;
  const velocity = Number(it.velocity) || 0;
  let daysToOos = null;
  let status;
  if (qty <= 0) {
    status = "out";
  } else if (velocity <= 0) {
    status = "no_sales";
  } else {
    daysToOos = qty / velocity;
    status = daysToOos < 7 ? "critical" : daysToOos < 30 ? "low" : "ok";
  }
  return { ...it, days_to_oos: daysToOos == null ? null : round2(daysToOos), status };
}

// Сортировка OOS: out → critical → low → ok → no_sales; внутри — по days_to_oos ASC.
const OOS_ORDER = { out: 0, critical: 1, low: 2, ok: 3, no_sales: 4 };
function oosSort(a, b) {
  const sa = OOS_ORDER[a.status] ?? 9;
  const sb = OOS_ORDER[b.status] ?? 9;
  if (sa !== sb) return sa - sb;
  // Внутри no_sales — по убыванию замороженного капитала (самые дорогие сверху).
  if (a.status === "no_sales") return (b.value_cost || 0) - (a.value_cost || 0);
  // out — по anything stable (по имени).
  if (a.status === "out") return String(a.name).localeCompare(String(b.name));
  // Остальные — по days_to_oos ASC (срочные сверху).
  return (a.days_to_oos ?? Infinity) - (b.days_to_oos ?? Infinity);
}

// =====================================================================
//  WB
// =====================================================================
async function collectWB(vel) {
  const db = new DatabaseSync("wb", { readOnly: true });
  const date = await resolveStockDate(db);
  if (!date) return { date: null, items: [], byWarehouse: [], dynamics: [], tooShort: true };

  // Остатки по nm_id (агрегировано по всем складам) + имя/себест/цена.
  const stockRows = (await db.prepare(
    `SELECT st.nm_id AS sku,
            COALESCE(a.name, CAST(st.nm_id AS TEXT)) AS name,
            COALESCE(a.brand, '') AS brand,
            COALESCE(a.subject, '') AS category,
            st.quantity,
            st.quantity_full,
            st.in_way_to,
            st.in_way_from,
            COALESCE(co.cost, 0) AS cost,
            ROUND((st.quantity_full * COALESCE(co.cost, 0))::numeric, 2) AS value_cost,
            COALESCE(m.price, 0) AS price,
            ROUND((st.quantity_full * COALESCE(m.price, 0))::numeric, 2) AS value_retail
     FROM (
       SELECT nm_id,
              SUM(quantity)      AS quantity,
              SUM(quantity_full) AS quantity_full,
              SUM(in_way_to)     AS in_way_to,
              SUM(in_way_from)   AS in_way_from
       FROM daily_stock WHERE date = ? GROUP BY nm_id
     ) st
     LEFT JOIN articles a ON a.nm_id = st.nm_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE nm_id = st.nm_id AND platform = 'wb'
         AND effective_from <= COALESCE(?, current_date)
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
     LEFT JOIN (
       SELECT nm_id,
              ROUND((price_seller * (1 - COALESCE(discount, 0) / 100.0))::numeric, 0) AS price
       FROM wb_prices
     ) m ON m.nm_id = st.nm_id`
  ).all(date, date)).map((it) => ({ ...it, platform: "wb", article: String(it.sku) }));

  // velocity по nm_id за vel дней: SUM(orders) / GREATEST(число дней с продажами, 1).
  // WB metrics.orders — уже чистые (is_cancel не применим к metrics; продажи считаются там).
  const velRows = await db.prepare(
    `SELECT nm_id,
            SUM(orders) AS ord,
            COUNT(DISTINCT date) FILTER (WHERE orders > 0) AS days
     FROM daily_metrics
     WHERE date >= current_date - ?
     GROUP BY nm_id`
  ).all(vel);
  const velBySku = {};
  for (const r of velRows) {
    const days = Number(r.days) || 0;
    velBySku[r.nm_id] = days > 0 ? (Number(r.ord) || 0) / days : 0;
  }
  const items = stockRows.map((it) => ({
    ...it,
    velocity: round2(velBySku[it.sku] || 0),
  }));

  // byWarehouse: остаток + стоимость по складам (для вкладок «Склады» и «Финансы»).
  const byWarehouse = await byWarehouseWB(db, date);

  // dynamics: Σ quantity_full по дням. Если история < 7 дней — tooShort=true (UI скроет график).
  const dynDates = await db.prepare(
    `SELECT COUNT(DISTINCT date) AS n FROM daily_stock`
  ).get();
  const tooShort = (Number(dynDates?.n) || 0) < 7;
  let dynamics = [];
  if (!tooShort) {
    dynamics = (await db.prepare(
      `SELECT date AS d, SUM(quantity_full) AS total
       FROM daily_stock GROUP BY date ORDER BY date`
    ).all()).map((r) => ({ date: r.d, total: Number(r.total) || 0 }));
  }

  return { date, items, byWarehouse, dynamics, tooShort };
}

// Распределение по складам WB с долей %, себестоимостью и реализацией.
async function byWarehouseWB(db, date) {
  // Сначала общий знаменатель — Σ quantity_full по всем складам WB на дату.
  const totalRow = await db.prepare(
    `SELECT COALESCE(SUM(quantity_full), 0) AS t FROM daily_stock WHERE date = ?`
  ).get(date);
  const totalFull = Number(totalRow?.t) || 0;

  const rows = await db.prepare(
    `SELECT w.warehouse,
            w.quantity,
            w.quantity_full,
            w.items,
            w.value_cost,
            w.value_retail
     FROM (
       SELECT warehouse,
              SUM(quantity)      AS quantity,
              SUM(quantity_full) AS quantity_full,
              COUNT(DISTINCT nm_id) AS items
       FROM daily_stock WHERE date = ? GROUP BY warehouse
     ) s
     LEFT JOIN LATERAL (
       SELECT
         ROUND(SUM(st.quantity_full * COALESCE(co.cost, 0))::numeric, 2) AS value_cost,
         ROUND(SUM(st.quantity_full * COALESCE(m.price, 0))::numeric, 2) AS value_retail
       FROM daily_stock st
       LEFT JOIN LATERAL (
         SELECT cost FROM tenant.cost_overrides
         WHERE nm_id = st.nm_id AND platform = 'wb'
           AND effective_from <= COALESCE(?, current_date)
         ORDER BY effective_from DESC LIMIT 1
       ) co ON true
       LEFT JOIN (
         SELECT nm_id, ROUND((price_seller * (1 - COALESCE(discount, 0) / 100.0))::numeric, 0) AS price
         FROM wb_prices
       ) m ON m.nm_id = st.nm_id
       WHERE st.warehouse = s.warehouse AND st.date = ?
     ) w ON true
     ORDER BY w.quantity_full DESC NULLS LAST`
  ).all(date, date, date);

  return rows.map((r) => ({
    platform: "wb",
    warehouse: r.warehouse,
    quantity: Number(r.quantity) || 0,
    quantity_full: Number(r.quantity_full) || 0,
    items: Number(r.items) || 0,
    value_cost: Number(r.value_cost) || 0,
    value_retail: Number(r.value_retail) || 0,
    share_pct: totalFull > 0 ? round2((Number(r.quantity_full) * 100) / totalFull) : 0,
  }));
}

// =====================================================================
//  Ozon (симметрично WB)
// =====================================================================
async function collectOzon(vel) {
  const db = new DatabaseSync("ozon", { readOnly: true });
  const date = await resolveStockDate(db);
  if (!date) return { date: null, items: [], byWarehouse: [], dynamics: [], tooShort: true };

  const stockRows = (await db.prepare(
    `SELECT st.product_id AS sku,
            COALESCE(MAX(p.name), MAX(p.offer_id), CAST(st.product_id AS TEXT)) AS name,
            COALESCE(MAX(p.brand), '') AS brand,
            COALESCE(MAX(p.category), '') AS category,
            MAX(p.offer_id) AS offer_id,
            st.quantity,
            st.quantity_full,
            COALESCE(co.cost, 0) AS cost,
            ROUND((st.quantity_full * COALESCE(co.cost, 0))::numeric, 2) AS value_cost,
            COALESCE(MAX(p.price), 0) AS price,
            ROUND((st.quantity_full * COALESCE(MAX(p.price), 0))::numeric, 2) AS value_retail
     FROM (
       SELECT product_id,
              SUM(fbo_present - fbo_reserved) AS quantity,
              SUM(fbo_present) AS quantity_full
       FROM daily_stock WHERE date = ? GROUP BY product_id
     ) st
     LEFT JOIN products p ON p.product_id = st.product_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE product_id = st.product_id AND platform = 'ozon'
         AND effective_from <= COALESCE(?, current_date)
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
     GROUP BY st.product_id, st.quantity, st.quantity_full, co.cost`
  ).all(date, date)).map((it) => ({
    ...it,
    in_way_to: 0,
    in_way_from: 0,
    platform: "ozon",
    article: it.offer_id || String(it.sku),
  }));

  // velocity Ozon через daily_metrics.orders (симметрично WB).
  const velRows = await db.prepare(
    `SELECT product_id,
            SUM(orders) AS ord,
            COUNT(DISTINCT date) FILTER (WHERE orders > 0) AS days
     FROM daily_metrics
     WHERE date >= current_date - ?
     GROUP BY product_id`
  ).all(vel);
  const velBySku = {};
  for (const r of velRows) {
    const days = Number(r.days) || 0;
    velBySku[r.product_id] = days > 0 ? (Number(r.ord) || 0) / days : 0;
  }
  const items = stockRows.map((it) => ({
    ...it,
    velocity: round2(velBySku[it.sku] || 0),
  }));

  const byWarehouse = await byWarehouseOzon(db, date);

  const dynDates = await db.prepare(`SELECT COUNT(DISTINCT date) AS n FROM daily_stock`).get();
  const tooShort = (Number(dynDates?.n) || 0) < 7;
  let dynamics = [];
  if (!tooShort) {
    dynamics = (await db.prepare(
      `SELECT date AS d, SUM(fbo_present) AS total
       FROM daily_stock GROUP BY date ORDER BY date`
    ).all()).map((r) => ({ date: r.d, total: Number(r.total) || 0 }));
  }

  return { date, items, byWarehouse, dynamics, tooShort };
}

async function byWarehouseOzon(db, date) {
  const totalRow = await db.prepare(
    `SELECT COALESCE(SUM(fbo_present), 0) AS t FROM daily_stock WHERE date = ?`
  ).get(date);
  const totalFull = Number(totalRow?.t) || 0;

  const rows = await db.prepare(
    `SELECT s.warehouse,
            s.quantity,
            s.quantity_full,
            s.items,
            ROUND(SUM(st.fbo_present * COALESCE(co.cost, 0))::numeric, 2) AS value_cost,
            ROUND(SUM(st.fbo_present * COALESCE(MAX(p.price), 0))::numeric, 2) AS value_retail
     FROM (
       SELECT warehouse,
              SUM(fbo_present - fbo_reserved) AS quantity,
              SUM(fbo_present) AS quantity_full,
              COUNT(DISTINCT product_id) AS items
       FROM daily_stock WHERE date = ? GROUP BY warehouse
     ) s
     LEFT JOIN daily_stock st ON st.warehouse = s.warehouse AND st.date = ?
     LEFT JOIN products p ON p.product_id = st.product_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE product_id = st.product_id AND platform = 'ozon'
         AND effective_from <= COALESCE(?, current_date)
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
     GROUP BY s.warehouse, s.quantity, s.quantity_full, s.items
     ORDER BY s.quantity_full DESC`
  ).all(date, date, date);

  return rows.map((r) => ({
    platform: "ozon",
    warehouse: r.warehouse,
    quantity: Number(r.quantity) || 0,
    quantity_full: Number(r.quantity_full) || 0,
    items: Number(r.items) || 0,
    value_cost: Number(r.value_cost) || 0,
    value_retail: Number(r.value_retail) || 0,
    share_pct: totalFull > 0 ? round2((Number(r.quantity_full) * 100) / totalFull) : 0,
  }));
}

// ---------- Общая: определить дату среза (MAX date) ----------
async function resolveStockDate(db) {
  const r = await db.prepare("SELECT MAX(date) AS d FROM daily_stock").get();
  return r?.d || null;
}
