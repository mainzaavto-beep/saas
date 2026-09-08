import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { wbSalesLocalityByWarehouse } from "@/lib/geoMetrics.js";
import { velocityPerDay, VELOCITY_WINDOW_DAYS } from "@/lib/stockCoverage.js";

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
//  velocity = SUM(orders за окно) / ДЛИНУ окна (канон lib/stockCoverage.js,
//  velocityPerDay). До 2026-09-08 делили на дни-с-продажами — это завышало скорость
//  редко продающихся товаров и держало в одном файле две правды о velocity (карточки
//  товаров и рекомендации перевозки считали по-разному). Нет продаж → velocity=0 →
//  status='no_sales' (классификация не изменилась: продаж нет ⇔ скорость 0).
//  Окно карточек товара выбирает пользователь (?vel=7|14|30|60); рекомендации
//  перевозки жёстко считают по каноническому окну VELOCITY_WINDOW_DAYS = 28 дней —
//  это тот же helper, что у плана поставок (/supply-plan).
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

    // Эффективность складов WB (вкладка «Эффективность»): оборачиваемость,
    // локальность, продажи по складам + кластерные агрегаты + рекомендации.
    // Только WB (Ozon — единый склад FBO, не применимо).
    const efficiency = await buildWarehouseEfficiency(vel);

    // Тренд остатков по складам (склад × день) — для drill-down во вкладке «Склады».
    const warehouseTrend = await warehouseTrendAll();

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
      // Вкладка 5: эффективность складов (byWarehouse/byCluster) + рекомендации (только WB)
      efficiency,
      // Тренд остатков по складам (склад × день) — drill-down во вкладке «Склады»
      warehouseTrend,
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

  // velocity по nm_id: SUM(orders) за окно / ДЛИНУ окна (канон velocityPerDay).
  // WB metrics.orders — уже чистые (is_cancel не применим к metrics; продажи считаются там).
  const velRows = await db.prepare(
    `SELECT nm_id, SUM(orders) AS ord
     FROM daily_metrics
     WHERE date >= current_date - ?::int
     GROUP BY nm_id`
  ).all(vel);
  const velBySku = {};
  for (const r of velRows) velBySku[r.nm_id] = velocityPerDay(r.ord, vel);
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
    `SELECT s.warehouse,
            s.quantity,
            s.quantity_full,
            s.items,
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
     ORDER BY s.quantity_full DESC NULLS LAST`
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

  // velocity Ozon через daily_metrics.orders (симметрично WB, тот же канон).
  const velRows = await db.prepare(
    `SELECT product_id, SUM(orders) AS ord
     FROM daily_metrics
     WHERE date >= current_date - ?::int
     GROUP BY product_id`
  ).all(vel);
  const velBySku = {};
  for (const r of velRows) velBySku[r.product_id] = velocityPerDay(r.ord, vel);
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
            ROUND(SUM(st.fbo_present * COALESCE(pp.price, 0))::numeric, 2) AS value_retail
     FROM (
       SELECT warehouse,
              SUM(fbo_present - fbo_reserved) AS quantity,
              SUM(fbo_present) AS quantity_full,
              COUNT(DISTINCT product_id) AS items
       FROM daily_stock WHERE date = ? GROUP BY warehouse
     ) s
     LEFT JOIN daily_stock st ON st.warehouse = s.warehouse AND st.date = ?
     LEFT JOIN LATERAL (
       -- MAX(price) per product_id вынесен в подзапрос (внешний SUM по складу).
       SELECT product_id, MAX(price) AS price FROM products GROUP BY product_id
     ) pp ON pp.product_id = st.product_id
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

// ---------- Тренд остатков по складам (склад × день) ----------
// Для drill-down во вкладке «Склады»: клик на склад → график остатка этого
// склада по дням. Решётка маленькая (~10 складов × ~7 дат = 70 строк на МП),
// поэтому отдаём в основном ответе, без отдельного запроса.
// Группируем по (date, warehouse) — SUM схлопнет множественные nm_id/склад
// (а после фикса wb_stocks и множественные chrtId) в одну сумму на склад-день.
async function warehouseTrendAll() {
  const wbDb = new DatabaseSync("wb", { readOnly: true });
  const wbRows = await wbDb.prepare(
    `SELECT date AS d, warehouse AS w, SUM(quantity_full) AS t
     FROM daily_stock GROUP BY date, warehouse ORDER BY date, warehouse`
  ).all();
  const ozDb = new DatabaseSync("ozon", { readOnly: true });
  const ozRows = await ozDb.prepare(
    `SELECT date AS d, warehouse AS w, SUM(fbo_present) AS t
     FROM daily_stock GROUP BY date, warehouse ORDER BY date, warehouse`
  ).all();
  return {
    wb: wbRows.map((r) => ({ date: r.d, warehouse: r.w, total: Number(r.t) || 0 })),
    ozon: ozRows.map((r) => ({ date: r.d, warehouse: r.w, total: Number(r.t) || 0 })),
  };
}

// =====================================================================
//  Эффективность складов WB (вкладка «Эффективность складов»).
//
//  Метрики по каждому складу (только WB; Ozon — единый склад FBO, не применимо):
//    • Остаток (шт + себест. ₽) — из daily_stock на свежую дату.
//    • Продажи (шт + ₽) — из wb_sales.warehouse_name за период vel.
//    • Доля склада в выручке — продажи склада / Σ продаж.
//    • Оборачиваемость (дни) — остаток / (продажи/день). Аппроксимация days_to_oos:
//      при текущей скорости продаж за vel дней, сегодняшнего остатка хватит на N
//      дней. Строгая оборачиваемость периода невозможна — мало истории снимков (3 шт).
//    • Локальность % — доля продаж, где кластер покупателя (= cluster okrug_name)
//      совпадает с кластером склада (= region). Карта region_to_cluster согласует
//      8 раздельных ФО покупателя с 7 укрупнёнными кластерами складов.
//
//  Агрегаты по кластерам (byCluster): Σ остатков, Σ продаж, средние оборачиваемость
//  и локальность. Отвечает на «в каком кластере концентрируется выручка».
//
//  ⚠️ Терминологическая грабля (зафиксирована в миграции 026): regionName склада
//  (7 укрупнённых) ≠ okrug_name покупателя (8 раздельных ФО). region_to_cluster
//  решает это; без карты local_pct считался бы некорректно.
// =====================================================================
async function buildWarehouseEfficiency(vel) {
  const db = new DatabaseSync("wb", { readOnly: true });

  // 1) Остатки по складам на свежую дату + кластер + себест.
  const stockByWh = await db.prepare(
    `SELECT COALESCE(w.name, st.warehouse) AS warehouse,
            w.region AS cluster,
            SUM(st.quantity_full) AS qty,
            ROUND(SUM(st.quantity_full * COALESCE(co.cost, 0))::numeric, 2) AS value_cost
     FROM daily_stock st
     CROSS JOIN (SELECT MAX(date) AS d FROM daily_stock) s_max
     LEFT JOIN shared.wb_warehouses w ON w.id = st.warehouse_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE nm_id = st.nm_id AND platform = 'wb'
         AND effective_from <= COALESCE(st.date, current_date)
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
     WHERE st.date = s_max.d
     GROUP BY COALESCE(w.name, st.warehouse), w.region`
  ).all();

  // 2) Продажи по складам за vel дней + локальные продажи.
  // Локальность: cluster покупателя (= cluster of okrug_name или region_name через
  // region_to_cluster) совпадает с cluster склада (= wh.region через wb_warehouses).
  // СНГ: при пустом okrug_name берём region_name (там субъект СНГ). Карта содержит
  // оба типа ключей — okrug_name (для РФ) и субъект (для СНГ). Двойной LEFT JOIN:
  // сначала пытаемся по okrug_name, если пусто — по region_name.
  //
  // ⚠ Мэтчинг склада: wb_sales.warehouse_name часто РАСХОДИТСЯ с wb_warehouses.name
  // (WB отдаёт разные имена в разных API: «Самара (Новосемейкино)» vs «Новосемейкино»,
  // «СПБ Шушары» vs «Склад СПБ Шушары Московское»). Точный JOIN теряет ~18% выручки.
  // Решение: LATERAL с приоритетом — точное совпадение, иначе подстрока (LIMIT 1).
  // Это связывает кластер склада с продажами, где бы он ни фигурировал под другим именем.
  // Вынесено в lib/geoMetrics.js (wbSalesLocalityByWarehouse) — переиспользуется
  // каноном «Географии» (задача 2, спека geography-v2 §3). SQL не менялся,
  // сверено бит-в-бит смоуком scripts (см. task-2-report).
  const salesByWh = await wbSalesLocalityByWarehouse(db, { sinceDays: vel });

  // 3) Сшиваем остатки и продажи по имени склада, считаем производные метрики.
  // Кластер берём из остатков (если есть), иначе из продаж (LATERAL-мэтчинг).
  const salesMap = new Map();
  let totalSalesRub = 0;
  for (const s of salesByWh) {
    salesMap.set(s.warehouse, s);
    totalSalesRub += Number(s.sales_rub) || 0;
  }
  const byWarehouse = [];
  for (const st of stockByWh) {
    const sa = salesMap.get(st.warehouse) || {};
    const qty = Number(st.qty) || 0;
    const valueCost = Number(st.value_cost) || 0;
    const salesQty = Number(sa.sales_qty) || 0;
    const salesRub = Number(sa.sales_rub) || 0;
    const localQty = Number(sa.local_qty) || 0;
    const cluster = st.cluster || sa.cluster || null;
    // Оборачиваемость: остаток / (продажи/день). При vel дней окна: продажи/день = salesQty/vel.
    const turnoverDays = salesQty > 0 ? qty / (salesQty / vel) : null;
    const localPct = salesQty > 0 ? round2((localQty * 100) / salesQty) : null;
    byWarehouse.push({
      warehouse: st.warehouse,
      cluster,
      qty,
      value_cost: round2(valueCost),
      sales_qty: salesQty,
      sales_rub: round2(salesRub),
      share_pct: totalSalesRub > 0 ? round2((salesRub * 100) / totalSalesRub) : 0,
      turnover_days: turnoverDays == null ? null : round2(turnoverDays),
      local_pct: localPct,
    });
  }
  // Склады с продажами, но без остатка (товар уже распродан) — добавим отдельно.
  for (const sa of salesByWh) {
    if (stockByWh.some((s) => s.warehouse === sa.warehouse)) continue;
    const salesQty = Number(sa.sales_qty) || 0;
    const salesRub = Number(sa.sales_rub) || 0;
    const localQty = Number(sa.local_qty) || 0;
    byWarehouse.push({
      warehouse: sa.warehouse,
      cluster: sa.cluster || null,
      qty: 0,
      value_cost: 0,
      sales_qty: salesQty,
      sales_rub: round2(salesRub),
      share_pct: totalSalesRub > 0 ? round2((salesRub * 100) / totalSalesRub) : 0,
      turnover_days: 0,  // остатка нет → 0 дней
      local_pct: salesQty > 0 ? round2((localQty * 100) / salesQty) : null,
    });
  }

  // 4) Агрегаты по кластерам.
  const clusterMap = new Map();
  for (const w of byWarehouse) {
    const key = w.cluster || "Прочее";
    if (!clusterMap.has(key)) {
      clusterMap.set(key, { cluster: key, wh_count: 0, qty: 0, value_cost: 0, sales_qty: 0, sales_rub: 0, local_qty: 0, _turnover_sum: 0, _turnover_n: 0, _local_sum: 0, _local_n: 0 });
    }
    const c = clusterMap.get(key);
    c.wh_count += 1;
    c.qty += w.qty;
    c.value_cost += w.value_cost;
    c.sales_qty += w.sales_qty;
    c.sales_rub += w.sales_rub;
    c.local_qty += Math.round((w.local_pct == null ? 0 : (w.local_pct / 100) * w.sales_qty));
    if (w.turnover_days != null) { c._turnover_sum += w.turnover_days; c._turnover_n += 1; }
    if (w.local_pct != null) { c._local_sum += w.local_pct; c._local_n += 1; }
  }
  const byCluster = [...clusterMap.values()].map((c) => ({
    cluster: c.cluster,
    wh_count: c.wh_count,
    qty: c.qty,
    value_cost: round2(c.value_cost),
    sales_qty: c.sales_qty,
    sales_rub: round2(c.sales_rub),
    share_pct: totalSalesRub > 0 ? round2((c.sales_rub * 100) / totalSalesRub) : 0,
    avg_turnover_days: c._turnover_n > 0 ? round2(c._turnover_sum / c._turnover_n) : null,
    avg_local_pct: c._local_n > 0 ? round2(c._local_sum / c._local_n) : null,
  })).sort((a, b) => (b.sales_rub || 0) - (a.sales_rub || 0));

  // 5) Рекомендации по перевозке — блок внутри вкладки. Окно скорости у них
  // каноническое (28 дней), не пользовательское ?vel — см. buildReallocRecommendations.
  const realloc = await buildReallocRecommendations();

  return { byWarehouse, byCluster, realloc };
}


//    • tenant.wb_daily_stock — остатки по складам (с warehouse_id, миграция 025)
//    • tenant.wb_daily_metrics.orders — velocity (продаж/день) по nm_id
//    • shared.wb_warehouses — справочник складов (id→name)
//    • shared.wb_transit_tariffs — тарифы (transit→dest, boxTariff, palletTariff)
//
//  Алгоритм (детерминированный, без ML):
//    Для каждого nm_id с velocity>0 — распределение остатка по складам. Кандидат
//    на перевозку = пара (from, to) где: from-склад держит избыток (≥40% от
//    total SKU), to-склад того же SKU имеет дефицит (qty ≤ 7 дней по доле velocity
//    от общего), И между ними есть тариф (transit=from.name, dest=to.name).
//    Кол-во к перевозке = половина избытка from (упрощённо; габаритов товара
//    нет — реальный коробочный расчёт невозможен). Тариф = boxTariff[0].value
//    (диапазон 0–1500г, базовый).
//
//  КАНОН покрытия (с 2026-09-08, финальное ревью этапа 3): скорость = заказы за
//  VELOCITY_WINDOW_DAYS (28 календарных дней) / 28 — общий helper velocityPerDay из
//  lib/stockCoverage.js, тот же, что у плана поставок /supply-plan. Остаток берём
//  ДОСТУПНЫЙ (daily_stock.quantity), а не полный (quantity_full с зарезервированным):
//  зарезервированное покупателем перевезти нельзя. Раньше здесь делили на
//  дни-с-продажами и считали по quantity_full — цифры блока «Рекомендации к
//  перемещению» после смены канона другие, это не баг.
//
//  ⚠️ Допущения (явно в UI): WB не отдаёт regional velocity → рекомендация про
//  ВЫРАВНИВАНИЕ распределения, не про «где купят быстрее». Тариф — за коробку
//  0–1500г; кол-во коробок селлер считает сам.
// =====================================================================
async function buildReallocRecommendations() {
  const db = new DatabaseSync("wb", { readOnly: true });

  // Полные пути shared.* — convertSql их не трогает (negative lookbehind на точку).
  // Один запрос: разворот nm × warehouse + velocity + маппинг имени + тариф-пары.
  const rows = await db.prepare(
    `WITH
      -- Последняя дата снимка остатков WB.
      s_max AS (SELECT MAX(date) AS d FROM daily_stock),
      -- Остатки по (nm, warehouse) на свежую дату + имя склада из справочника.
      -- quantity = ДОСТУПНО (канон покрытия), не quantity_full.
      sk AS (
        SELECT st.nm_id,
               st.warehouse            AS wh_from_name,
               COALESCE(wfw.name, st.warehouse) AS wh_from_canon,
               st.warehouse_id         AS wh_from_id,
               SUM(st.quantity)        AS qty_from
        FROM daily_stock st
        CROSS JOIN s_max
        LEFT JOIN shared.wb_warehouses wfw ON wfw.id = st.warehouse_id
        WHERE st.date = s_max.d
        GROUP BY st.nm_id, st.warehouse, st.warehouse_id, wfw.name
      ),
      -- velocity по nm_id: SUM(orders) за каноническое окно; делится на длину окна
      -- уже в JS (velocityPerDay), чтобы формула жила в одном месте.
      vel AS (
        SELECT nm_id, SUM(orders) AS ord
        FROM daily_metrics
        WHERE date >= current_date - ?::int
        GROUP BY nm_id
      ),
      -- Тотал по SKU + сколько складов + distribute target per wh.
      sku_totals AS (
        SELECT nm_id,
               SUM(qty_from) AS qty_total,
               COUNT(*)      AS wh_count
        FROM sk GROUP BY nm_id
      )
    SELECT
        sk.nm_id,
        COALESCE(a.name, CAST(sk.nm_id AS TEXT)) AS name,
        COALESCE(a.subject, '') AS category,
        sk.wh_from_id,
        sk.wh_from_canon                       AS from_warehouse,
        t.tar_dest_canon                       AS to_warehouse,
        sk.qty_from,
        st_total.qty_total,
        v.ord,
        t.pallet_tariff,
        t.box_first_value                      AS box_tariff_rub
    FROM sk
    JOIN sku_totals st_total ON st_total.nm_id = sk.nm_id
    LEFT JOIN vel v ON v.nm_id = sk.nm_id
    LEFT JOIN articles a ON a.nm_id = sk.nm_id
    -- JOIN к тарифам: from — транзитный источник (canon-имя), dest — все прочие
    -- склады того же SKU (декартово по парам тарифа, конкретный dest выберем ниже).
    JOIN LATERAL (
      SELECT tt.transit_warehouse_name      AS tar_src,
             tt.destination_warehouse_name  AS tar_dest_raw,
             wtd.name                       AS tar_dest_canon,
             tt.pallet_tariff,
             -- boxTariff = [{from,to,value}...]; берём value первой записи (0–1500г).
             (tt.box_tariff->0->>'value')::numeric AS box_first_value
      FROM shared.wb_transit_tariffs tt
      LEFT JOIN shared.wb_warehouses wtd ON wtd.name = tt.destination_warehouse_name
      WHERE tt.transit_warehouse_name = sk.wh_from_canon
    ) t ON true
    WHERE COALESCE(v.ord, 0) > 0                  -- только продающиеся товары
      AND st_total.qty_total > 0
      -- Избыток на from-складе: ≥40% остатка SKU ИЛИ (на 1 складе >60% при wh_count>1)
      AND (sk.qty_from * 100.0 / st_total.qty_total >= 40
           OR (st_total.wh_count > 1 AND sk.qty_from * 100.0 / st_total.qty_total > 60))
    ORDER BY sk.qty_from DESC`
  ).all(VELOCITY_WINDOW_DAYS);

  // Фильтрация в JS: оставляем только пары, где dest — реальный склад этого SKU
  // (с дефицитом), и расчёт финальных полей. SQL дал все тариф-направления от
  // from-склада; тут мэтчим на склады SKU из того же набора.
  // Строим карту: nm_id → Set каноничных имён складов этого SKU.
  const skuWh = new Map();
  for (const r of rows) {
    if (!skuWh.has(r.nm_id)) skuWh.set(r.nm_id, new Set());
    skuWh.get(r.nm_id).add(r.wh_from_canon);
  }

  // Карта дефицита: для каждого SKU — какие склады (canon) НЕ присутствуют
  // (= qty 0, явный дефицит). Это кандидаты-назначения.
  // normalizeWh() убирает суффикс «: Питание» и пр. — WB в тарифах даёт
  // по 2 записи на склад (обычный + поставочный), физически это один склад.
  // Без нормализации каждая пара плодит дубли («Рязань (Тюшевское)» и «...: Питание»).
  const normalizeWh = (name) => (name || "").replace(/\s*:\s*Питание\s*$/i, "").trim();

  const recs = [];
  const seen = new Set();  // дедуп (nm, from, to_normalized)
  for (const r of rows) {
    const whSet = skuWh.get(r.nm_id);
    const dest = r.to_warehouse;
    if (!dest || !whSet) continue;
    const destNorm = normalizeWh(dest);
    if (!destNorm) continue;
    // Назначение должно быть складом, где этого SKU НЕТ (дефицит).
    // Сравниваем по нормализованному имени — иначе «Волгоград» vs «Волгоград: Питание»
    // прошло бы как разные склады, хотя физически один.
    const whSetNorm = new Set([...whSet].map(normalizeWh));
    if (whSetNorm.has(destNorm)) continue;
    // Не везти «к самому себе» (имя-двойник без id).
    if (destNorm === normalizeWh(r.from_warehouse)) continue;

    const key = `${r.nm_id}|${normalizeWh(r.from_warehouse)}|${destNorm}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const vel = velocityPerDay(r.ord, VELOCITY_WINDOW_DAYS);
    const qtyFrom = Number(r.qty_from) || 0;
    const qtyTotal = Number(r.qty_total) || 0;

    // ── Фильтр «не истощай источник» (правило хозяина, 2026-07-18) ──────
    // Если на складе-источнике ≤ 4 шт И при текущей velocity он протянет ≤ 8 дней —
    // везти с него НЕЛЬЗЯ (источник сам на грани OOS). velocity=0 (нет продаж) →
    // «протянет бесконечно» → фильтр пропускает (неходовой товар, излишек по времени).
    // ⚠ WB не отдаёт regional velocity — берем общую по SKU как аппроксимацию
    // (предполагаем равномерное распределение продаж). Реально days_to_oos_склада
    // может быть меньше у более «ходовых» складов — это ограничение данных WB.
    const SOURCE_QTY_CAP = 4;
    const SOURCE_DAY_CAP = 8;
    if (qtyFrom <= SOURCE_QTY_CAP && vel > 0) {
      const sourceDays = qtyFrom / vel;
      if (sourceDays <= SOURCE_DAY_CAP) continue;  // истощаемый источник — пропускаем
    }

    // Кол-во к перевозке = половина избытка from, но не меньше 1 и не больше
    // избытка сверх 30% (чтобы не обобрать склад-источник в ноль).
    const excess = Math.max(0, qtyFrom - qtyTotal * 0.3);
    const qtyToMove = Math.max(1, Math.round(excess / 2));
    // Дней до OOS по всему SKU (приоритизация).
    const daysToOos = vel > 0 ? qtyTotal / vel : null;
    const boxTariff = r.box_tariff_rub != null ? Number(r.box_tariff_rub) : null;
    const palletTariff = r.pallet_tariff != null ? Number(r.pallet_tariff) : null;

    // Причина (человекочитаемо).
    const fromSharePct = qtyTotal > 0 ? Math.round((qtyFrom * 100) / qtyTotal) : 0;
    let reason = `На «${r.from_warehouse}» ${fromSharePct}% остатка SKU, на «${destNorm}» — 0.`;
    if (daysToOos != null) {
      reason += ` Запас всего SKU ~${Math.round(daysToOos)} дн.`;
    }

    recs.push({
      nm_id: Number(r.nm_id),
      name: r.name,
      category: r.category,
      from_warehouse: r.from_warehouse,
      to_warehouse: destNorm,
      qty_to_move: qtyToMove,
      box_tariff_rub: boxTariff,
      pallet_tariff_rub: palletTariff,
      days_to_oos: daysToOos == null ? null : round2(daysToOos),
      reason,
    });
  }
  // Сортировка: критичные (days_to_oos мал) первыми; null (нет продаж по окну) — в конец.
  recs.sort((a, b) => {
    const da = a.days_to_oos == null ? Infinity : a.days_to_oos;
    const db = b.days_to_oos == null ? Infinity : b.days_to_oos;
    if (da !== db) return da - db;
    return (b.qty_to_move || 0) - (a.qty_to_move || 0);
  });
  // Потолок, чтобы не раздувать список (UI всё равно показывает всё, но API — разумно).
  return recs.slice(0, 50);
}

