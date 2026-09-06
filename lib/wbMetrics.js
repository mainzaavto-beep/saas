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
//  Каноны (владелец 2026-07-09; выручка/вознаграждение/налог пересмотрены
//  2026-09-06, план «выручка WB по цене со скидкой продавца»):
//    • Заказы (шт): COUNT(*) FROM orders WHERE is_cancel=0
//      (daily_metrics.orders устарел — NULL с 2026-07-01, сборщик не льёт).
//    • Выручка (revenue): Σ cost_value_withdisc = цена со скидкой ПРОДАВЦА
//      (retail_price_withdisc_rub, она же price_with_disc ленты продаж) —
//      ВАЛОВАЯ, до СПП и до вознаграждения площадки. НЕ ppvz_for_pay
//      (так было с 20.08 по 06.09) и НЕ retail_amount.
//    • Реализовано (realized): Σ cost_value_retail (retail_amount) — столько
//      заплатил покупатель после СПП. СПП (spp) = revenue − realized.
//    • Вознаграждение WB (commission): НЕТТО = realized − payout, где
//      payout = Σ cost_value_pay (ppvz_for_pay, «к перечислению»). Это
//      ЕДИНСТВЕННЫЙ честный вычет площадки: покомпонентное разложение
//      отчёта (retail_amount − комиссия − эквайринг = ppvz_for_pay) НЕ
//      сходится НИ НА ОДНОЙ строке (проба 06.09: 478 строк июля-2026,
//      кабинет 1; отчётная комиссия часто отрицательна — WB компенсирует
//      СПП внутри ppvz_vw). Отчётные колонки отдаются как commissionReport /
//      acquiringReport / loyaltyReport — СПРАВОЧНО, в формулах не участвуют;
//      acquiring/loyalty в форме ответа = 0 (у WB они внутри commission,
//      поле держится для симметрии с Ozon).
//      Историческая формула «commission_percent × retail_price_withdisc_rub
//      / 100» осталась только в wbFinanceByDay (витринный агрегат
//      finance_report), в канон прибыли она не входит.
//    • Прибыль: ОПЕРАЦИОННАЯ = ppvz_for_pay − логистика − себест − реклама − налог
//      (модель ppvz_for_pay, урок D15, фикс 2026-07-31) — источник rawProfit
//      (SUM(profit) из order_costs) НЕ изменился; тождественно
//      revenue − spp − commission − cogs − logistics (= profitGross).
//    • Налог: база = WB_TAX_BASE (см. ниже), сейчас «реализовано»
//      (retail_amount) — доход агента за товар продавца по отчёту WB.
// =====================================================================

import { calcTotalTax } from "./tax.js";
import { ZERO_RAW_AGG } from "./profitForms.js";

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
    ? [from + "T00:00:00", to + "T23:59:59", ...nmIds]
    : [from + "T00:00:00", to + "T23:59:59"];
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
    .get(from + "T00:00:00", to + "T23:59:59", ...(nmId != null ? [nmId] : []));
  return r ? r.c : 0;
}

// Отмены за период (is_cancel=1) — для cancelRate Главной и детсводок.
// Пара к wbOrdersCount (который считает только is_cancel=0).
export async function wbCancelCount(db, { from, to, nmIds } = {}) {
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const params = nmIds && nmIds.length
    ? [from + "T00:00:00", to + "T23:59:59", ...nmIds]
    : [from + "T00:00:00", to + "T23:59:59"];
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND is_cancel = 1 ${whereNm}`
    )
    .get(...params);
  return r ? r.c : 0;
}

// =====================================================================
//  ЗАКАЗЫ ₽ — SUM(price_with_disc) из orders по order_dt (только is_cancel=0)
// =====================================================================

export async function wbOrderRubByDay(db, { from, to, nmIds } = {}) {
  const map = new Map();
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const params = nmIds && nmIds.length
    ? [from + "T00:00:00", to + "T23:59:59", ...nmIds]
    : [from + "T00:00:00", to + "T23:59:59"];
  for (const r of await db
    .prepare(
      `SELECT nm_id, substr(order_dt,1,10) AS date, SUM(price_with_disc) AS s
       FROM orders
       WHERE order_dt >= ? AND order_dt <= ? AND price_with_disc IS NOT NULL AND is_cancel = 0 ${whereNm}
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
    ? [from + "T00:00:00", to + "T23:59:59", ...nmIds]
    : [from + "T00:00:00", to + "T23:59:59"];
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
    ? [from + "T00:00:00", to + "T23:59:59", ...nmIds]
    : [from + "T00:00:00", to + "T23:59:59"];
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
//  Скалярный (`wbFinancePeriod`) и batch-по-nm (`wbFinancePeriodByNm`)
//  варианты этого агрегата удалены задачей 6 плана «унификация формул
//  прибыли» как осиротевшие (0 вызовов вне их собственного определения
//  после переезда всех роутов на `wbProfitProduct`/`wbProfitCabinet`, см.
//  task-6-report.md) — per-day вариант (`wbFinanceByDay` ниже) остаётся
//  живым, его использует Детсводка/Обзор.
// =====================================================================

// Per-day вариант: Map<"nmId|date", {salesRub,commission,acquiring,logistics,loyalty}> —
// для Детсводки (один nm × дни периода, чтобы заполнить дневную матрицу).
// Группировка по дате rr_dt (DATE(rr_dt) = YYYY-MM-DD). Тот же канон
// (Продажа → выручка/комиссия/эквайринг, Логистика → delivery_rub), что
// использовал удалённый scalar-агрегат этого блока.
// Возвращает Map<"nmId|date"> (для пакетной симметрии с wbSoldByDay/wbStockByDay).
export async function wbFinanceByDay(db, { from, to, nmIds } = {}) {
  const map = new Map();
  const whereNm = nmIds && nmIds.length
    ? `AND nm_id IN (${nmIds.map(() => "?").join(",")})`
    : "";
  const paramsSale = [from, to + "T23:59:59", ...(nmIds && nmIds.length ? nmIds : [])];
  // Продажа: выручка + комиссия + эквайринг по дате rr_dt.
  for (const r of await db
    .prepare(
      `SELECT nm_id, substr(rr_dt,1,10) AS d,
         SUM(retail_price_withdisc_rub) AS salesRub,
         SUM(commission_percent * retail_price_withdisc_rub / 100.0) AS commission,
         SUM(acquiring_fee) AS acquiring,
         SUM(ppvz_for_pay) AS forPay
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
      forPay: round2(r.forPay || 0),
      logistics: 0, loyalty: 0,
    });
  }
  // Логистика: delivery_rub по дате rr_dt — мёрджим в уже созданные объекты.
  const paramsLog = [from, to + "T23:59:59", ...(nmIds && nmIds.length ? nmIds : [])];
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
    else map.set(key, { salesRub: 0, commission: 0, acquiring: 0, forPay: 0, logistics: round2(r.s || 0), loyalty: 0 });
  }
  return map;
}

// =====================================================================
//  РЕКЛАМА
//  • По 3 моделям (edinaya/ruchnaya/cliki) — daily_ad (для РНП/Детсводки).
//  • Агрегат totals — daily_metrics.ad_spend (для overview/Сводки).
// =====================================================================

// daily_metrics.ad_spend: число (без groupByNm) или {nmId: total} (batch).
// nmId != null — режим «один товар» (задача 6 плана «Ozon per-SKU ads»,
// симметрия с ozAdSpend({productId})): та же SQL, что и groupByNm-ветка,
// но с WHERE nm_id = ? и одиночным агрегатом вместо GROUP BY.
export async function wbAdTotal(db, { from, to, groupByNm = false, nmId = null } = {}) {
  if (nmId != null) {
    const r = await db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(ad_spend),0) FROM daily_metrics
                 WHERE date >= ? AND date <= ? AND nm_id = ?
                 AND ad_spend IS NOT NULL) AS s`
      )
      .get(from, to, nmId);
    return round2((r && r.s) || 0);
  }
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
//  СЕБЕСТОИМОСТЬ — единый источник: tenant.cost_overrides (с 2026-07-14).
//  wb_cogs больше не читается. Актуальный override = последний с
//  effective_from <= сегодня. Для исторических расчётов (по дате) см. LATERAL.
// =====================================================================

export async function wbUnitCost(db, nmId) {
  const r = await db.prepare(
    `SELECT cost FROM tenant.cost_overrides
     WHERE nm_id = ? AND platform = 'wb' AND effective_from <= current_date
     ORDER BY effective_from DESC LIMIT 1`
  ).get(nmId);
  return r && r.cost > 0 ? r.cost : null;
}

export async function wbCostRub(db, nmId, sold) {
  const unit = await wbUnitCost(db, nmId);  // ⚠️ await (был пропущен → NaN)
  return round2((unit ?? 0) * (sold || 0));
}

// =====================================================================
//  calcOperatingProfit УДАЛЕНА (фикс-волна ревью унификации прибыли,
//  2026-08-20) — была объявлена как «единая функция расчёта операционной
//  прибыли», но ни разу не вызывалась ни одним роутом (grep по app/**,
//  0 вызовов; единственные упоминания — её же определение и ре-экспорт в
//  lib/ozonMetrics.js). Роль, для которой она задумывалась, теперь реально
//  исполняют wbProfitProduct/wbProfitCabinet ниже — они и вызываются всеми
//  7 роутами (см. docs/metrics-contract.md, раздел 11.1).
// =====================================================================

// =====================================================================
//  КАНОНИЧЕСКИЙ СЛОЙ ПРИБЫЛИ WB (план «унификация формул прибыли»,
//  2026-08-20, docs/superpowers/plans/2026-08-20-profit-unification.md,
//  задача 2 — симметрична задаче 1 (Ozon, lib/ozonMetrics.js). Формы
//  сигнатур и внешний контракт cabinetCosts[].amount ОДИНАКОВЫ для обеих
//  площадок; внутренняя SQL-семантика — своя (ppvz-модель).
//
//  ⚠️ ИСТОЧНИК ПРИБЫЛИ — tenant.wb_order_costs.profit (модель ppvz_for_pay,
//  урок D15, worker/collectors/wb_order_costs.py:111):
//    profit = cost_value_pay (ppvz_for_pay, «к перечислению продавцу») −
//             cost (себестоимость) − logistics.
//  rawProfit = SUM(profit) — БИТ-В-БИТ то же число, что до 06.09; переезд
//  на валовую выручку его не трогает (меняются только выручка, состав
//  вычетов в отчёте и налоговая база — см. шапку файла).
//
//  ⚠️ ТРИ ЦЕНЫ (переезд 2026-09-06, план «выручка WB по цене со скидкой
//  продавца»): revenue = Σ cost_value_withdisc (цена со скидкой продавца,
//  ВАЛОВАЯ), realized = Σ cost_value_retail (заплатил покупатель после СПП),
//  payout = Σ cost_value_pay («к перечислению»). Отсюда два вычета:
//    spp        = revenue − realized  (скидка WB за счёт площадки)
//    commission = realized − payout   (нетто-вознаграждение WB — ВЫЧЕТ)
//  Тождества (сторож check-profit-canon.mjs):
//    revenue − spp − commission = payout
//    profitGross = revenue − spp − commission − cogs − logistics = rawProfit
//  commission здесь — НЕ отчётная колонка: покомпонентное разложение
//  отчёта не сходится ни на одной строке (478 строк июля-2026, кабинет 1),
//  отчётные суммы отдаются как commissionReport/acquiringReport/
//  loyaltyReport и в формулах НЕ участвуют. acquiring/loyalty = 0 — форма
//  общая с Ozon, у WB эти статьи внутри нетто-commission.
//
//  ⚠️ НАЛОГОВАЯ БАЗА — константа WB_TAX_BASE (ниже), сейчас "realized":
//  доход продавца по отчёту WB = «реализовано» (retail_amount). Расходы для
//  УСН Доходы−Расходы = cogs + logistics + ads + commission (commission
//  вычитается из realized при переходе к payout, значит это расход).
//  Переключение базы на "revenue"/"payout" — одна строка (решение
//  бухгалтера/владельца). До 06.09 базой был payout, поэтому переезд меняет
//  рубли прибыли РОВНО на разницу налога.
//
//  ⚠️ is_return: order_costs (wb_order_costs) НЕ фильтруется по is_return —
//  ни здесь, ни в независимой сверке check-profit-canon.mjs. Возвраты
//  (is_return=1) уже несут корректный profit = −logistics (cost_value_pay
//  обнулён сборщиком, worker/collectors/wb_order_costs.py: CASE WHEN
//  is_return=1 THEN 0) — настоящий убыток, не шум. Проверено эмпирически
//  (июль-2026, кабинет 1): SUM(profit) по ВСЕМ строкам = 324 197,38 ₽;
//  с фильтром is_return=0 (гипотетическая калька Ozon-бага задачи 1) —
//  355 452,47 ₽ — заём 31 255,09 ₽ убытка возвратов был бы скрыт. Ни один
//  из СЕГОДНЯШНИХ потребителей wb_order_costs.profit (detail/rnp-summary —
//  Ozon-секции того же файла; сами WB-роуты считают деньги из
//  finance_report, не из order_costs.profit) этим багом не страдает — но
//  канон обязан не завести его заново.
//
//  ads — с 2026-08-22 (задача 6, симметрично Ozon): при nmId ads = РЕАЛЬНЫЙ
//  расход товара (tenant.wb_daily_metrics.ad_spend, уже используется
//  products-summary/rnp-summary/plan-fact через wbAdTotal(groupByNm:true)),
//  а НЕ 0. Σ(ads по товарам) МОЖЕТ БЫТЬ < ads(кабинета) СТРУКТУРНО (не баг):
//  часть ad_spend приходится на nm_id, у которых в периоде НЕТ строк
//  order_costs (кампания шла на товар без продаж/возвратов в периоде) —
//  проверено эмпирически (июль-2026, кабинет 1): 7 077,17 ₽ рекламы
//  «осиротело» на таких nm_id — те же аргументы «честно, не размазано»,
//  что у Ozon, только для другого дефицита данных. Этот «нераспределённый
//  остаток» = ads(кабинета) − Σ ads(товар) вычитается ТОЛЬКО на кабинетном
//  вызове (nmId=null), проверка 5 канон-скрипта несёт ту же поправку.
//
//  returnLogistics — СПРАВОЧНАЯ строка: SUM(logistics FILTER is_return=1),
//  УЖЕ включена в общий logistics выше (не вычитается повторно). В отличие
//  от Ozon, commission НЕ добавляется в returnLogistics — у WB commission
//  считается нетто по строкам продаж (у возвратов cost_value_retail и
//  cost_value_pay обнулены сборщиком, вклад в commission = 0), добавление
//  её сюда было бы двойным упоминанием.
// =====================================================================

// Налоговая база WB — ОДНА точка переключения (см. докстроку выше).
// "realized" — Σ cost_value_retail (по умолчанию, решение 2026-09-06);
// "revenue" — валовая по цене со скидкой продавца; "payout" — как было до
// 06.09 (Σ cost_value_pay; тогда commission из расходов исключается, она
// уже внутри базы).
export const WB_TAX_BASE = "realized";

// Список слагаемых агрегата order_costs — ОДИН на все четыре формы
// (скаляр / batch по nm / по дням / кабинет по дням). Любая правка полей
// здесь автоматически видна всем четырём — раньше список был скопирован
// 4 раза и расходился при правках.
const WB_AGG_FIELDS = `
         COALESCE(SUM(cost_value_withdisc), 0) AS revenue,
         COALESCE(SUM(cost_value_retail), 0)   AS realized,
         COALESCE(SUM(cost_value_pay), 0)      AS payout,
         COALESCE(SUM(cost), 0) AS cogs,
         COALESCE(SUM(commission), 0) AS "commissionReport",
         COALESCE(SUM(acquiring), 0) AS "acquiringReport",
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(loyalty), 0) AS "loyaltyReport",
         COALESCE(SUM(profit), 0) AS "rawProfit",
         COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0) AS "retLogistics"`;

// Маппер строки агрегата — ОДИН на все четыре формы. Здесь и только здесь
// считаются производные spp и нетто-commission (см. докстроку выше).
function wbAggRow(r) {
  const revenue = round2((r && r.revenue) || 0);
  const realized = round2((r && r.realized) || 0);
  const payout = round2((r && r.payout) || 0);
  return {
    revenue, realized, payout,
    spp: round2(revenue - realized),          // скидка WB (СПП) — ВЫЧЕТ
    commission: round2(realized - payout),    // нетто-вознаграждение WB — ВЫЧЕТ
    acquiring: 0, loyalty: 0,                 // у WB внутри commission (форма общая с Ozon)
    commissionReport: round2((r && r.commissionReport) || 0),
    acquiringReport: round2((r && r.acquiringReport) || 0),
    loyaltyReport: round2((r && r.loyaltyReport) || 0),
    cogs: round2((r && r.cogs) || 0),
    logistics: round2((r && r.logistics) || 0),
    rawProfit: round2((r && r.rawProfit) || 0),
    returnLogistics: round2((r && r.retLogistics) || 0),
  };
}

// Налог WB — ОДНА формула на все композиции (день / товар / batch / кабинет).
// База — WB_TAX_BASE; commission входит в расходы, кроме базы "payout"
// (там она уже вычтена площадкой внутри самой базы).
function wbTax(agg, ads, taxMode) {
  const base = WB_TAX_BASE === "revenue" ? agg.revenue
    : WB_TAX_BASE === "payout" ? agg.payout
    : agg.realized;
  const expenses = agg.cogs + agg.logistics + ads + (WB_TAX_BASE === "payout" ? 0 : agg.commission);
  return calcTotalTax(taxMode, base, expenses);
}

// Валовая прибыль WB: revenue − spp − commission − cogs − logistics.
// Алгебраически = payout − cogs − logistics = rawProfit (тождество-сторож).
function wbProfitGross(agg) {
  return round2(agg.revenue - agg.spp - agg.commission - agg.cogs - agg.logistics);
}

// SQL агрегата wb_order_costs БЕЗ фильтра is_return (см. докстроку выше).
async function wbRawProfitAggregate(db, { from, to, nmId } = {}) {
  const whereNm = nmId != null ? "AND nm_id = ?" : "";
  const params = nmId != null ? [from, to, nmId] : [from, to];
  const r = await db
    .prepare(
      `SELECT ${WB_AGG_FIELDS}
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ? ${whereNm}`
    )
    .get(...params);
  return wbAggRow(r);
}

// Batch-версия wbRawProfitAggregate: те же слагаемые, GROUP BY nm_id.
// Скалярная версия остаётся (detail/plan-fact зовут по одному товару);
// инвариант «batch ≡ скаляр» держит проверка №6 check-profit-canon.mjs.
async function wbRawProfitAggregateBatch(db, { from, to } = {}) {
  const rows = await db
    .prepare(
      `SELECT
         nm_id,${WB_AGG_FIELDS}
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
         AND nm_id IS NOT NULL -- строки без привязки к товару не принадлежат ни одной корзине batch; периодный скаляр их видит — законное расхождение состава, не формулы
       GROUP BY nm_id`
    )
    .all(from, to);
  const out = new Map();
  for (const r of rows) out.set(r.nm_id, wbAggRow(r));
  return out;
}

// Дневная версия wbRawProfitAggregate: ТОТ ЖЕ SELECT (те же слагаемые,
// is_return НЕ фильтруется — см. докстроку выше), GROUP BY день, для ОДНОГО
// nm_id (один SQL на весь период). Симметрично ozRawProfitByDay (задача 6
// плана «канон волна 2», 2026-08-25) — заменяет detail-роуту ручную формулу
// «прибыль дня из forPay/logistics/cost/adSp» на посуточный агрегат тех же
// полей, что скалярный wbRawProfitAggregate; композиция profit(день) =
// rawProfit(день) − ads(день) − tax(день) в detail-роуте (collectWB) даёт
// Σ profit(день) = wbProfitProduct(period, nmId).profit ТОЧНО под usn_income
// (налог линеен по выручке) — проверка №7 check-profit-canon.mjs.
export async function wbRawProfitByDay(db, { from, to, nmId } = {}) {
  const whereNm = nmId != null ? "AND nm_id = ?" : "";
  const params = nmId != null ? [from, to, nmId] : [from, to];
  const rows = await db
    .prepare(
      `SELECT
         substr(COALESCE(sale_dt, return_dt),1,10) AS d,${WB_AGG_FIELDS}
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ? ${whereNm}
       GROUP BY substr(COALESCE(sale_dt, return_dt),1,10)`
    )
    .all(...params);
  const out = new Map();
  for (const r of rows) out.set(r.d, wbAggRow(r));
  return out;
}

// Кабинетный дневной агрегат для спарклайна Сводки; форма и слагаемые =
// wbRawProfitByDay, инвариант: Σ дней = wbRawProfitAggregate(period) —
// сверяется приёмкой задачи. ПЕРЕНОС SELECT'а wbRawProfitByDay БЕЗ
// параметра/фильтра nm_id (байт-в-байт слагаемые и датировка) — задача 1
// плана «Сводка по макету» (2026-08-25).
export async function wbRawProfitCabinetByDay(db, { from, to } = {}) {
  const rows = await db
    .prepare(
      `SELECT
         substr(COALESCE(sale_dt, return_dt),1,10) AS d,${WB_AGG_FIELDS}
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
       GROUP BY substr(COALESCE(sale_dt, return_dt),1,10)`
    )
    .all(from, to);
  const out = new Map();
  for (const r of rows) out.set(r.d, wbAggRow(r));
  return out;
}

// Дневная композиция канона WB (см. ozDayProfit — здесь всё то же, кроме
// налога): база и расходы налога — общий хелпер wbTax (база WB_TAX_BASE,
// расходы cogs + logistics + ads + commission). Используется detail-роутом
// и проверкой №7 check-profit-canon.mjs.
export function wbDayProfit(agg, adDay, taxMode) {
  const tax = wbTax(agg, adDay, taxMode).total;
  return round2(agg.rawProfit - adDay - tax);
}

// wbProfitProduct(db, taxMode, period, nmId) — товарная прибыль (канон).
// period = { cabinetId, from, to } (даты YYYY-MM-DD, включительно). cabinetId
// не участвует в SQL (RLS уже на нужном кабинете) — в контракте для внешних
// потребителей (check-скрипты, роуты задач 4-5), симметрично Ozon.
// taxMode — нормализованный режим (normalizeTaxMode из lib/tax.js).
export async function wbProfitProduct(db, taxMode, { from, to } = {}, nmId = null) {
  const agg = await wbRawProfitAggregate(db, { from, to, nmId });
  const ads = nmId == null
    ? await wbAdTotal(db, { from, to })
    : await wbAdTotal(db, { from, to, nmId });
  // Налог — общий хелпер wbTax (база WB_TAX_BASE = realized, расходы
  // cogs + logistics + ads + commission; см. докстроку канона выше).
  const taxCalc = wbTax(agg, ads, taxMode);
  const profit = round2(agg.rawProfit - ads - taxCalc.total);
  return {
    ...agg,
    ads: round2(ads),
    tax: taxCalc.total,
    profit,
    // profitGross — валовая прибыль ДО рекламы/налога: выручка минус ВСЕ
    // вычеты уровня заказа (spp, нетто-вознаграждение, себестоимость,
    // логистика). Алгебраически = payout − cogs − logistics = rawProfit —
    // тождество-сторож (проверка check-profit-canon.mjs).
    profitGross: wbProfitGross(agg),
  };
}

// Канон по ВСЕМ товарам периода за 2 SQL (агрегат + реклама) вместо 2×N.
// Формула КАЖДОГО товара идентична wbProfitProduct(nmId) — включая налог
// (общий хелпер wbTax: база WB_TAX_BASE, расходы cogs+logistics+ads+
// commission); расхождение с ним = баг (проверка №6 check-profit-canon.mjs).
export async function wbProfitProductBatch(db, taxMode, { from, to } = {}) {
  const aggs = await wbRawProfitAggregateBatch(db, { from, to });
  const ads = await wbAdTotal(db, { from, to, groupByNm: true });
  const out = new Map();
  const ids = new Set([...aggs.keys(), ...Object.keys(ads).map(Number)]);
  for (const id of ids) {
    const agg = aggs.get(id) || ZERO_RAW_AGG; // ZERO_RAW_AGG несёт лишнее services:0 (Ozon-специфично, у WB безвредно — формула ниже его не читает)
    const ad = round2(ads[id] || 0);
    // Налог — тот же хелпер wbTax, что у скалярного wbProfitProduct.
    const taxCalc = wbTax(agg, ad, taxMode);
    out.set(id, {
      ...agg,
      ads: ad,
      tax: taxCalc.total,
      profit: round2(agg.rawProfit - ad - taxCalc.total),
      profitGross: wbProfitGross(agg),
    });
  }
  return out;
}

// ── Словарь cost_type → русское имя кабинетных расходов WB. Статичный
// (в отличие от ozCabinetCostLabel — там accrual_<id> резолвится через
// shared.ozon_accrual_types, БД обязательна). У WB весь набор типов
// генерируется сборщиком (worker/collectors/wb_cabinet_costs.py) из
// фиксированного CASE — 9 значений, без БД. Плановая оговорка допускает
// короткую сигнатуру без db именно для этого случая. ИСТОЧНИК ПРАВДЫ —
// этот словарь (мини-фикс 2026-08-21: app/api/cabinets/[id]/cabinet-costs/
// route.js держал собственный дубликат LABELS, из-за которого Ozon
// accrual_N показывались сырыми — роут переведён на wbCabinetCostLabel/
// ozCabinetCostLabel, локальный дубликат удалён).
const WB_COST_LABELS = {
  storage: "Хранение",
  deduction: "Удержание (прочее)", // legacy
  reviews: "Баллы за отзывы (возврат аванса)",
  deduction_other: "Удержание (прочее)",
  payout_other: "Выплаты WB (компенсации)",
  promotion: "Продвижение WB (платная услуга)",
  pvz_compensation: "Возмещение за ПВЗ",
  transport_compensation: "Возмещение перевозки",
  subscription: "Подписка Premium Plus",
  ad_unmapped: "Реклама без привязки к SKU",
  crossdocking: "Кросс-докинг",
  supply: "Приёмка / недостача",
  penalty: "Штрафы",
  other: "Прочее",
};

// wbCabinetCostLabel(costType) → string — русское имя статьи. БЕЗ db (см.
// докстроку словаря выше — статичный, план это разрешает). Незнакомый
// cost_type → «Прочее (<ключ>)», не сырым.
export function wbCabinetCostLabel(costType) {
  return WB_COST_LABELS[costType] || `Прочее (${costType})`;
}

// wbProfitCabinet(db, taxMode, period) — кабинетная прибыль (канон):
// товарная прибыль (wbProfitProduct без nmId) ПЛЮС знаковая сумма
// кабинетных статей (tenant.wb_cabinet_costs — hранение/штрафы/удержания/
// возмещения, контракт №27: не размазываются по SKU).
//
// ⚠️ ЗНАК: tenant.wb_cabinet_costs хранит суммы в НАТИВНОМ знаке WB, который
// ПРОТИВОПОЛОЖЕН конвенции Ozon (проверено эмпирически, кабинет 1,
// июль-2026, worker/collectors/wb_cabinet_costs.py): расходы (storage,
// penalty, promotion, subscription, deduction_other) хранятся
// ПОЛОЖИТЕЛЬНЫМИ; возмещения/выплаты продавцу (payout_other,
// pvz_compensation, transport_compensation, reviews-сторно) — ОТРИЦАТЕЛЬНЫМИ
// (см. докстроку wb_cabinet_costs.py: «возмещения WB кодирует
// отрицательными»). У Ozon (ozon_cabinet_costs) — наоборот: расход
// отрицателен, доход положителен. Если бы канон просто прибавлял Σamount
// «как в БД» (буквально по формуле Ozon), positive expenses (напр.
// promotion=+84 395 ₽) УВЕЛИЧИВАЛИ бы прибыль, а income (напр.
// payout_other=−68 774,48 ₽ — «Выплаты WB (компенсации)», см. память
// wb-cabinet-costs-fixed.md: 48 774 + 20 000 ₽, компенсации за товар,
// пострадавший от форс-мажора) УМЕНЬШАЛ бы её — обе ошибки наоборот.
// Канон НОРМАЛИЗУЕТ знак к единому внешнему контракту (тот же, что у
// Ozon: amount<0 — расход, amount>0 — доход/возмещение) — cabinetCosts[].
// amount = −(сырой amount из БД); формула суммирования после нормализации
// ОДИНАКОВА для обеих площадок (profit = product.profit + Σamount).
// Так канон отдаёт потребителям (задачи 4-5) единый контракт без
// platform-specific веток на знак.
export async function wbProfitCabinet(db, taxMode, period = {}) {
  const { from, to } = period;
  const base = await wbProfitProduct(db, taxMode, period, null);

  // wb_cabinet_costs хранит period_from/period_to (диапазон отчёта, обычно
  // день = день), НЕ единую дату как у Ozon — берём строки, ПЕРЕСЕКАЮЩИЕСЯ
  // с [from; to] (тот же паттерн, что уже использует collectWB в
  // app/api/cabinets/[id]/cabinet-costs/route.js).
  const rows = await db
    .prepare(
      `SELECT cost_type, COALESCE(SUM(amount),0) AS s
       FROM cabinet_costs
       WHERE period_from <= ? AND period_to >= ?
       GROUP BY cost_type
       ORDER BY cost_type`
    )
    .all(to, from);

  let unknownCostTypes = 0;
  const cabinetCosts = [];
  for (const row of rows) {
    const known = Object.prototype.hasOwnProperty.call(WB_COST_LABELS, row.cost_type);
    if (!known) unknownCostTypes++;
    // Нормализация знака — см. докстроку функции.
    cabinetCosts.push({
      costType: row.cost_type,
      label: wbCabinetCostLabel(row.cost_type),
      amount: round2(-row.s),
    });
  }

  const signedSum = cabinetCosts.reduce((acc, c) => acc + c.amount, 0);
  const profit = round2(base.profit + signedSum);

  return { ...base, cabinetCosts, unknownCostTypes, profit };
}
