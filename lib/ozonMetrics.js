// =====================================================================
//  lib/ozonMetrics.js — ЕДИНЫЙ СЛОЙ ИСТОЧНИКОВ МЕТРИК Ozon.
//
//  Канонические функции расчёта метрик Ozon для витринных страниц дашборда.
//  Все 4 страницы (РНП, Детсводка, Сводка по товарам, Главная) зовут ОДНИ И
//  ТЕ ЖЕ функции → расхождения физически невозможны.
//
//  Источник правды по метрикам — ЭТОТ файл (решение «единый слой», 2026-07-09).
//
//  Каноны (зафиксированы владельцем 2026-07-09):
//    • Заказы (шт): COUNT(*) FROM orders WHERE is_cancel=0 (канон с WB).
//      (daily_metrics.orders у Ozon заполнен, но для единообразия с WB и
//      согласованности с Сводкой/Главной — берём COUNT из orders.)
//    • Реклама: daily_metrics.ad_spend (НЕ per_sku_costs — это plan/fact).
//      (daily_ad у Ozon пустая — нет колонки model/atbs.)
//    • Выручка/прибыль: order_costs по COALESCE(sale_dt, return_dt), is_return=0.
//      revenue = Σ cost_value_retail; profitGross = Σ order_costs.profit (валовая).
//    • Прибыль: ОПЕРАЦИОННАЯ = profitGross − реклама − УСН 6% (revenue × 0.06).
//    • Буст (соинвест, аналог СПП): MAX(current_boost) из ozon_action_products
//      по последней дате всей таблицы, add_mode IN (MANUAL,AUTO), boost>0.
//    • Цена: products.price (в daily_metrics всегда NULL, gotcha #204).
//    • Рейтинг: feedback_summary.rating (в daily_metrics пусто).
// =====================================================================

import { USN_RATE, calcOperatingProfit } from "./wbMetrics.js";
export { USN_RATE, calcOperatingProfit };
const round2 = (v) => Math.round((v || 0) * 100) / 100;

// =====================================================================
//  ЗАКАЗЫ (шт) — COUNT(*) FROM orders WHERE is_cancel=0
// =====================================================================

export async function ozOrdersByDay(db, { from, to, productIds } = {}) {
  const map = new Map();
  const whereNm = productIds && productIds.length
    ? `AND product_id IN (${productIds.map(() => "?").join(",")})`
    : "";
  const params = productIds && productIds.length
    ? [from + "T00:00:00", to + "T23:59:59", ...productIds]
    : [from + "T00:00:00", to + "T23:59:59"];
  for (const r of await db
    .prepare(
      `SELECT product_id, substr(order_dt,1,10) AS date, COUNT(*) AS c
       FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND is_cancel = 0 ${whereNm}
       GROUP BY product_id, substr(order_dt,1,10)`
    )
    .all(...params)) {
    map.set(r.product_id + "|" + r.date, r.c);
  }
  return map;
}

export async function ozOrdersCount(db, { from, to, productId } = {}) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND is_cancel = 0
         ${productId != null ? "AND product_id = ?" : ""}`
    )
    .get(from + "T00:00:00", to + "T23:59:59", ...(productId != null ? [productId] : []));
  return r ? r.c : 0;
}

// =====================================================================
//  ЗАКАЗЫ ₽ — SUM(total) из orders по order_dt
// =====================================================================

export async function ozOrdersSumByDay(db, { from, to, productIds } = {}) {
  const map = new Map();
  const whereNm = productIds && productIds.length
    ? `AND product_id IN (${productIds.map(() => "?").join(",")})`
    : "";
  const params = productIds && productIds.length
    ? [from + "T00:00:00", to + "T23:59:59", ...productIds]
    : [from + "T00:00:00", to + "T23:59:59"];
  for (const r of await db
    .prepare(
      `SELECT product_id, substr(order_dt,1,10) AS date, SUM(total) AS s
       FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND total IS NOT NULL ${whereNm}
       GROUP BY product_id, substr(order_dt,1,10)`
    )
    .all(...params)) {
    map.set(r.product_id + "|" + r.date, round2(r.s || 0));
  }
  return map;
}

// =====================================================================
//  order_costs — агрегат финансов периода (выручка/комиссия/.../прибыль)
//  Дата = COALESCE(sale_dt, return_dt), продажи is_return=0.
//  productId — один товар; без него — весь агрегат (без группировки).
// =====================================================================

export async function ozOrderCostsAggregate(db, { from, to, productId } = {}) {
  const whereNm = productId != null ? "AND product_id = ?" : "";
  const r = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN is_return=0 THEN cost_value_retail ELSE 0 END) AS revenue,
         SUM(CASE WHEN is_return=0 THEN cost            ELSE 0 END) AS cost,
         SUM(CASE WHEN is_return=0 THEN commission      ELSE 0 END) AS commission,
         SUM(CASE WHEN is_return=0 THEN logistics       ELSE 0 END) AS logistics,
         SUM(CASE WHEN is_return=0 THEN acquiring       ELSE 0 END) AS acquiring,
         SUM(CASE WHEN is_return=0 THEN loyalty         ELSE 0 END) AS loyalty,
         SUM(CASE WHEN is_return=0 THEN profit          ELSE 0 END) AS profitGross
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ? ${whereNm}`
    )
    .get(from, to, ...(productId != null ? [productId] : []));
  return {
    revenue: round2((r && r.revenue) || 0),
    cost: round2((r && r.cost) || 0),
    commission: round2((r && r.commission) || 0),
    logistics: round2((r && r.logistics) || 0),
    acquiring: round2((r && r.acquiring) || 0),
    loyalty: round2((r && r.loyalty) || 0),
    profitGross: round2((r && r.profitGross) || 0),
  };
}

// Продажи (шт) по дням: COUNT(order_costs is_return=0) по sale_dt.
export async function ozSoldByDay(db, { from, to, productId } = {}) {
  const map = new Map();
  const whereNm = productId != null ? "AND product_id = ?" : "";
  for (const r of await db
    .prepare(
      `SELECT substr(sale_dt,1,10) AS d, COUNT(*) AS cnt
       FROM order_costs
       WHERE sale_dt IS NOT NULL
         AND substr(sale_dt,1,10) >= ? AND substr(sale_dt,1,10) <= ?
         AND is_return = 0 ${whereNm}
       GROUP BY substr(sale_dt,1,10)`
    )
    .all(from, to, ...(productId != null ? [productId] : []))) {
    map.set(r.d, r.cnt);
  }
  return map;
}

// Batch-вариант order_costs: {product_id: {revenue,cost,commission,...}} —
// для Сводки по товарам (много product_id сразу). GROUP BY product_id.
export async function ozOrderCostsByProduct(db, { from, to } = {}) {
  const out = {};
  for (const r of await db
    .prepare(
      `SELECT product_id,
         SUM(CASE WHEN is_return=0 THEN cost_value_retail ELSE 0 END) AS revenue,
         SUM(CASE WHEN is_return=0 THEN cost            ELSE 0 END) AS cost,
         SUM(CASE WHEN is_return=0 THEN commission      ELSE 0 END) AS commission,
         SUM(CASE WHEN is_return=0 THEN logistics       ELSE 0 END) AS logistics,
         SUM(CASE WHEN is_return=0 THEN acquiring       ELSE 0 END) AS acquiring,
         SUM(CASE WHEN is_return=0 THEN loyalty         ELSE 0 END) AS loyalty,
         SUM(CASE WHEN is_return=0 THEN profit          ELSE 0 END) AS profitGross,
         SUM(CASE WHEN is_return=0 THEN 1 ELSE 0 END) AS sold,
         SUM(CASE WHEN is_return=1 THEN 1 ELSE 0 END) AS returns
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
         AND product_id IS NOT NULL
       GROUP BY product_id`
    )
    .all(from, to)) {
    out[r.product_id] = {
      revenue: round2(r.revenue || 0),
      cost: round2(r.cost || 0),
      commission: round2(r.commission || 0),
      logistics: round2(r.logistics || 0),
      acquiring: round2(r.acquiring || 0),
      loyalty: round2(r.loyalty || 0),
      profitGross: round2(r.profitGross || 0),
      sold: r.sold || 0,
      returns: r.returns || 0,
    };
  }
  return out;
}

// =====================================================================
//  РЕКЛАМА Ozon (канон с 2026-08-02).
//  ⚠️ Пер-товарного расхода у Ozon НЕТ: Performance API отдаёт расход только
//  «кабинет × день» → tenant.ozon_daily_efficiency.ad_spend (до фикса 6046d36
//  не собирался вовсе — 401 на устаревшем формате токена, прибыль Ozon
//  завышалась; на cab #1 ~169.5к ₽ за 75 дней). Итоговый расход (total) берём
//  из ozon_daily_efficiency; groupByProduct читает daily_metrics.ad_spend —
//  он ПУСТ до появления пер-SKU источника (асинхронные отчёты Performance,
//  в очереди), т.е. по товарам реклама Ozon пока не разносится (аналогично
//  кабинетным расходам WB, контракт №27).
// =====================================================================

export async function ozAdSpend(db, { from, to, groupByProduct = false } = {}) {
  if (!groupByProduct) {
    // date в ozon_daily_efficiency — DATE; сравнение с 'YYYY-MM-DD' корректно.
    // Subquery-форма — из-за бага эмулятора «агрегат после серии запросов
    // возвращает 0» (см. products-summary:144).
    const r = await db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(ad_spend),0) FROM ozon_daily_efficiency
                 WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL) AS s`
      )
      .get(from, to.slice(0, 10));
    return round2((r && r.s) || 0);
  }
  const out = {};
  for (const r of await db
    .prepare(
      `SELECT product_id, SUM(ad_spend) AS s FROM daily_metrics
       WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL
       GROUP BY product_id`
    )
    .all(from, to)) {
    out[r.product_id] = round2(r.s || 0);
  }
  return out;
}
