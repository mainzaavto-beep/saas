// =====================================================================
//  lib/wbMetrics.js — ЕДИНЫЙ СЛОЙ ИСТОЧНИКОВ МЕТРИК WB.
//
//  Канонические функции расчёта метрик Wildberries для витринных страниц
//  дашборда. Все 4 страницы (РНП, Детсводка, Сводка по товарам, Главная)
//  зовут ОДНИ И ТЕ ЖЕ функции → расхождения физически невозможны.
//
//  Источник правды по метрикам — ЭТОТ файл (решение «единый слой», 2026-07-09).
//  Раньше каждая страница писала свой SQL → грабля #61 «расхождение в 3 местах».
//
//  Чего НЕ касается этот слой (отдельные контуры):
//    • P&L /pnl — ориентируется на еженедельные финотчёты WB, своя модель
//      (остаточный метод комиссии, retail_amount). НЕ трогаем.
//    • plan/fact — per_sku_costs (другая модель).
//    • lib/unit.js calcWB — юнит-экономика на единицу (решение #3).
//
//  Каноны (зафиксированы владельцем 2026-07-09):
//    • Заказы (шт): COUNT(*) FROM orders WHERE is_cancel=0
//      (daily_metrics.orders устарел — NULL с 2026-07-01, сборщик не льёт).
//    • Комиссия: commission_percent × retail_price_withdisc_rub / 100
//      («от цены до СПП» — НЕ остаточный метод P&L).
//    • Выручка: SUM(retail_price_withdisc_rub) из finance_report Продажа
//      (НЕ retail_amount — это P&L).
//    • Прибыль: ОПЕРАЦИОННАЯ = выручка − комиссия − эквайринг − логистика −
//      лояльность(=0) − себест − реклама − УСН 6%.
//    • УСН: revenue × 0.06.
// =====================================================================

// УСН «доходы» 6% — применяется к выручке в операционной прибыли.
// Дублировался в products-summary/overview/detail (0.06); теперь общий.
export const USN_RATE = 0.06;
const round2 = (v) => Math.round((v || 0) * 100) / 100;

// Карта «склад → регион» для расчёта локальности продаж (WB склад в одноимённом
// регионе). Раньше копипастилась в rnp и detail дословно — теперь общая.
export const WAREHOUSE_REGION = {
  "Электросталь": "Московская",
  "Коледино": "Московская",
  "Тула": "Тульская",
  "Невинномысск": "Ставропольский",
  "Котовск": "Тамбовская",
  "Краснодар": "Краснодарский",
  "Самара (Новосемейкино)": "Самарская",
  "Екатеринбург - Перспективная 14": "Свердловская",
  "СПБ Шушары": "Ленинградская",
  "Казань": "Республика Татарстан",
  "Воронеж": "Воронежская",
  "Владимир": "Владимирская",
  "Сарапул": "Удмуртская",
  "Пенза": "Пензенская",
  "Волгоград": "Волгоградская",
  "Рязань (Тюшевское)": "Рязанская",
  "Калининград": "Калининградская",
  "Сургут": "Ханты-Мансийский",
};

// =====================================================================
//  ЗАКАЗЫ (шт) — COUNT(*) FROM orders WHERE is_cancel=0
// =====================================================================

// Заказы по дням: Map<"nmId|date", count>. nmIds — фильтр по списку (опц.).
export async function wbOrdersByDay(db, { from, to, nmIds } = {}) {
  const map = new Map();
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const params = nmIds && nmIds.length
    ? [from + " 00:00:00", to + " 23:59:59", ...nmIds]
    : [from + " 00:00:00", to + " 23:59:59"];
  for (const r of await db
    .prepare(
      `SELECT nm_id, substr(order_dt,1,10) AS date, COUNT(*) AS c
       FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND is_cancel = 0 ${whereNm}
       GROUP BY nm_id, substr(order_dt,1,10)`
    )
    .all(...params)) {
    map.set(r.nm_id + "|" + r.date, r.c);
  }
  return map;
}

// Итого заказов за период (один nm или все).
export async function wbOrdersCount(db, { from, to, nmId } = {}) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND is_cancel = 0
         ${nmId != null ? "AND nm_id = ?" : ""}`
    )
    .get(from + " 00:00:00", to + " 23:59:59", ...(nmId != null ? [nmId] : []));
  return r ? r.c : 0;
}

// Отмены за период (is_cancel=1) — для cancelRate Главной и детсводок.
// Пара к wbOrdersCount (который считает только is_cancel=0).
export async function wbCancelCount(db, { from, to, nmIds } = {}) {
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const params = nmIds && nmIds.length
    ? [from + " 00:00:00", to + " 23:59:59", ...nmIds]
    : [from + " 00:00:00", to + " 23:59:59"];
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND is_cancel = 1 ${whereNm}`
    )
    .get(...params);
  return r ? r.c : 0;
}

// =====================================================================
//  ЗАКАЗЫ ₽ — SUM(price_with_disc) из orders по order_dt (вкл. отмены)
// =====================================================================

export async function wbOrderRubByDay(db, { from, to, nmIds } = {}) {
  const map = new Map();
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const params = nmIds && nmIds.length
    ? [from + " 00:00:00", to + " 23:59:59", ...nmIds]
    : [from + " 00:00:00", to + " 23:59:59"];
  for (const r of await db
    .prepare(
      `SELECT nm_id, substr(order_dt,1,10) AS date, SUM(price_with_disc) AS s
       FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND price_with_disc IS NOT NULL ${whereNm}
       GROUP BY nm_id, substr(order_dt,1,10)`
    )
    .all(...params)) {
    map.set(r.nm_id + "|" + r.date, round2(r.s || 0));
  }
  return map;
}

// =====================================================================
//  ПРОДАЖИ (шт) — SUM(is_realization=1 AND price_with_disc>0) из sales
//  Грабля #98: возвраты с is_realization=1 и отрицательным price_with_disc.
// =====================================================================

export async function wbSold(db, { from, to, nmIds } = {}) {
  const out = {};
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const params = nmIds && nmIds.length
    ? [from + " 00:00:00", to + " 23:59:59", ...nmIds]
    : [from + " 00:00:00", to + " 23:59:59"];
  for (const r of await db
    .prepare(
      `SELECT nm_id, SUM(CASE WHEN is_realization=1 AND price_with_disc>0 THEN 1 ELSE 0 END) AS s
       FROM sales
       WHERE sale_dt >= ? AND sale_dt <= ? ${whereNm}
       GROUP BY nm_id`
    )
    .all(...params)) {
    out[r.nm_id] = r.s || 0;
  }
  return out;
}

// Продажи по дням: Map<"nmId|date", count>. Тот же канон, что wbSold
// (is_realization=1 AND price_with_disc>0). Раньше rnp/detail считали продажи
// через sale_id LIKE 'S%' — оба фильтра дают совпадающие числа на бою (проверено
// в smoke Этапа 4), но единый фильтр = гарантия консистентности между экранами.
export async function wbSoldByDay(db, { from, to, nmIds } = {}) {
  const map = new Map();
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const params = nmIds && nmIds.length
    ? [from + " 00:00:00", to + " 23:59:59", ...nmIds]
    : [from + " 00:00:00", to + " 23:59:59"];
  for (const r of await db
    .prepare(
      `SELECT nm_id, substr(sale_dt,1,10) AS date,
         SUM(CASE WHEN is_realization=1 AND price_with_disc>0 THEN 1 ELSE 0 END) AS s
       FROM sales
       WHERE sale_dt >= ? AND sale_dt <= ? ${whereNm}
       GROUP BY nm_id, substr(sale_dt,1,10)`
    )
    .all(...params)) {
    map.set(r.nm_id + "|" + r.date, r.s || 0);
  }
  return map;
}

// Остатки по дням: Map<"nmId|date", {wh, stock}>.
// wh = кол-во складов (COUNT DISTINCT), stock = Σ quantity_full. История
// короткая (~2 нед, gotcha) — ранние дни просто отсутствуют в Map.
export async function wbStockByDay(db, { from, to, nmIds } = {}) {
  const map = new Map();
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const params = nmIds && nmIds.length
    ? [from, to, ...nmIds]
    : [from, to];
  for (const r of await db
    .prepare(
      `SELECT nm_id, date,
         COUNT(DISTINCT warehouse) AS wh,
         SUM(quantity_full)        AS stock
       FROM daily_stock
       WHERE date >= ? AND date <= ? ${whereNm}
       GROUP BY nm_id, date`
    )
    .all(...params)) {
    map.set(r.nm_id + "|" + r.date, { wh: r.wh || 0, stock: r.stock || 0 });
  }
  return map;
}

// =====================================================================
//  ФИНАНСЫ периода — finance_report Продажа + Логистика по rr_dt
//  Комиссия = commission_percent × retail_price_withdisc_rub / 100
//  (владельческий канон «от цены до СПП», НЕ остаточный метод P&L).
// =====================================================================

export async function wbFinancePeriod(db, { from, to, nmId } = {}) {
  const whereNm = nmId != null ? "AND nm_id = ?" : "";
  const sale = await db
    .prepare(
      `SELECT
         SUM(retail_price_withdisc_rub) AS salesRub,
         SUM(commission_percent * retail_price_withdisc_rub / 100.0) AS commission,
         SUM(acquiring_fee) AS acquiring
       FROM finance_report
       WHERE supplier_oper_name='Продажа' AND nm_id IS NOT NULL AND nm_id != 0
         AND rr_dt >= ? AND rr_dt <= ? ${whereNm}`
    )
    .get(from, to + " 23:59:59", ...(nmId != null ? [nmId] : []));
  const log = await db
    .prepare(
      `SELECT SUM(delivery_rub) AS s
       FROM finance_report
       WHERE supplier_oper_name='Логистика' AND nm_id IS NOT NULL AND nm_id != 0
         AND rr_dt >= ? AND rr_dt <= ? ${whereNm}`
    )
    .get(from, to + " 23:59:59", ...(nmId != null ? [nmId] : []));
  return {
    salesRub: round2((sale && sale.salesRub) || 0),
    commission: round2((sale && sale.commission) || 0),
    acquiring: round2((sale && sale.acquiring) || 0),
    logistics: round2((log && log.s) || 0),
    loyalty: 0, // у WB нет источника лояльности в finance_report
  };
}

// Per-day вариант: Map<"nmId|date", {salesRub,commission,acquiring,logistics,loyalty}> —
// для Детсводки (один nm × дни периода, чтобы заполнить дневную матрицу).
// Группировка по дате rr_dt (DATE(rr_dt) = YYYY-MM-DD). Тот же канон, что
// wbFinancePeriod (Продажа → выручка/комиссия/эквайринг, Логистика → delivery_rub).
// Возвращает Map<"nmId|date"> (для пакетной симметрии с wbSoldByDay/wbStockByDay).
export async function wbFinanceByDay(db, { from, to, nmIds } = {}) {
  const map = new Map();
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const paramsSale = [from, to + " 23:59:59", ...(nmIds && nmIds.length ? nmIds : [])];
  // Продажа: выручка + комиссия + эквайринг по дате rr_dt.
  for (const r of await db
    .prepare(
      `SELECT nm_id, substr(rr_dt,1,10) AS d,
         SUM(retail_price_withdisc_rub) AS salesRub,
         SUM(commission_percent * retail_price_withdisc_rub / 100.0) AS commission,
         SUM(acquiring_fee) AS acquiring
       FROM finance_report
       WHERE supplier_oper_name='Продажа' AND nm_id IS NOT NULL AND nm_id != 0
         AND rr_dt >= ? AND rr_dt <= ? ${whereNm}
       GROUP BY nm_id, substr(rr_dt,1,10)`
    )
    .all(...paramsSale)) {
    map.set(`${r.nm_id}|${r.d}`, {
      salesRub: round2(r.salesRub || 0),
      commission: round2(r.commission || 0),
      acquiring: round2(r.acquiring || 0),
      logistics: 0, loyalty: 0,
    });
  }
  // Логистика: delivery_rub по дате rr_dt — мёрджим в уже созданные объекты.
  const paramsLog = [from, to + " 23:59:59", ...(nmIds && nmIds.length ? nmIds : [])];
  for (const r of await db
    .prepare(
      `SELECT nm_id, substr(rr_dt,1,10) AS d, SUM(delivery_rub) AS s
       FROM finance_report
       WHERE supplier_oper_name='Логистика' AND nm_id IS NOT NULL AND nm_id != 0
         AND rr_dt >= ? AND rr_dt <= ? ${whereNm}
       GROUP BY nm_id, substr(rr_dt,1,10)`
    )
    .all(...paramsLog)) {
    const key = `${r.nm_id}|${r.d}`;
    if (map.has(key)) map.get(key).logistics = round2(r.s || 0);
    else map.set(key, { salesRub: 0, commission: 0, acquiring: 0, logistics: round2(r.s || 0), loyalty: 0 });
  }
  return map;
}

// Batch-вариант: {nm_id: {salesRub,commission,acquiring,logistics,loyalty}} —
// для Сводки по товарам (много nm сразу, GROUP BY nm_id). Логистика отдельным
// запросом (другая операция finance_report), мёрджится в общий объект.
export async function wbFinancePeriodByNm(db, { from, to } = {}) {
  const fin = {};
  for (const r of await db
    .prepare(
      `SELECT nm_id,
         SUM(retail_price_withdisc_rub) AS salesRub,
         SUM(commission_percent * retail_price_withdisc_rub / 100.0) AS commission,
         SUM(acquiring_fee) AS acquiring
       FROM finance_report
       WHERE supplier_oper_name='Продажа' AND nm_id IS NOT NULL AND nm_id != 0
         AND rr_dt >= ? AND rr_dt <= ?
       GROUP BY nm_id`
    )
    .all(from, to + " 23:59:59")) {
    fin[r.nm_id] = {
      salesRub: round2(r.salesRub || 0),
      commission: round2(r.commission || 0),
      acquiring: round2(r.acquiring || 0),
      logistics: 0, loyalty: 0,
    };
  }
  for (const r of await db
    .prepare(
      `SELECT nm_id, SUM(delivery_rub) AS s
       FROM finance_report
       WHERE supplier_oper_name='Логистика' AND nm_id IS NOT NULL AND nm_id != 0
         AND rr_dt >= ? AND rr_dt <= ?
       GROUP BY nm_id`
    )
    .all(from, to + " 23:59:59")) {
    if (fin[r.nm_id]) fin[r.nm_id].logistics = round2(r.s || 0);
  }
  return fin;
}

// =====================================================================
//  РЕКЛАМА
//  • По 3 моделям (edinaya/ruchnaya/cliki) — daily_ad (для РНП/Детсводки).
//  • Агрегат totals — daily_metrics.ad_spend (для overview/Сводки).
// =====================================================================

// daily_metrics.ad_spend: число (без groupByNm) или {nmId: total} (batch).
export async function wbAdTotal(db, { from, to, groupByNm = false } = {}) {
  if (!groupByNm) {
    const r = await db
      .prepare(
        `SELECT SUM(ad_spend) AS s FROM daily_metrics
         WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL`
      )
      .get(from, to);
    return round2((r && r.s) || 0);
  }
  const out = {};
  for (const r of await db
    .prepare(
      `SELECT nm_id, SUM(ad_spend) AS s FROM daily_metrics
       WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL
       GROUP BY nm_id`
    )
    .all(from, to)) {
    out[r.nm_id] = round2(r.s || 0);
  }
  return out;
}

// =====================================================================
//  СЕБЕСТОИМОСТЬ — cogs.cost × sold
// =====================================================================

export async function wbUnitCost(db, nmId) {
  const r = await db.prepare(`SELECT cost FROM cogs WHERE nm_id = ?`).get(nmId);
  return r && r.cost > 0 ? r.cost : null;
}

export async function wbCostRub(db, nmId, sold) {
  const unit = wbUnitCost(db, nmId);
  return round2((unit ?? 0) * (sold || 0));
}

// =====================================================================
//  ЕДИНАЯ ОПЕРАЦИОННАЯ ПРИБЫЛЬ
//  profit = salesRub − commission − acquiring − logistics − loyalty − costRub − adSp − tax
//  tax = salesRub × USN_RATE (выручка × 6%).
// =====================================================================

export async function calcOperatingProfit({ salesRub, commission, acquiring, logistics, loyalty, costRub, adSp, taxRate = USN_RATE } = {}) {
  const tax = round2((salesRub || 0) * taxRate);
  const profit = round2(
    (salesRub || 0) - (commission || 0) - (acquiring || 0) - (logistics || 0)
    - (loyalty || 0) - (costRub || 0) - (adSp || 0) - tax
  );
  return { profit, tax };
}
