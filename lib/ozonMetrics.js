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

import { USN_RATE } from "./wbMetrics.js";
import { calcTotalTax } from "./tax.js";
import { ZERO_RAW_AGG } from "./profitForms.js";
export { USN_RATE };
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

// =====================================================================
//  РЕКЛАМА Ozon (канон с 2026-08-02; пер-товарный режим — с 2026-08-22,
//  задача 6 плана «Ozon per-SKU ads»).
//  Кабинетный итог (total) — Performance API отдаёт расход «кабинет × день»
//  → tenant.ozon_daily_efficiency.ad_spend (до фикса 6046d36 не собирался
//  вовсе — 401 на устаревшем формате токена, прибыль Ozon завышалась; на
//  cab #1 ~169.5к ₽ за 75 дней). ЭТО единственный источник кабинетного
//  вызова (productId=null) — он полнее пер-товарного (см. ниже) и остаётся
//  эталоном P&L.
//  Пер-товарный расход (productId) — С 2026-08-21 ЕСТЬ: миграция 043
//  (tenant.ozon_daily_sku_ad, Performance API groupBy=DATE по кампании) →
//  worker.db_pg.recompute_ozon_daily_ad пересчитывает daily_metrics.ad_spend
//  по (product_id, date). НЕ ПОЛНОЕ покрытие: кампании без товарной
//  разбивки (например «Оплата за заказ — все товары», campaign_id 27109544
//  у кабинета 1) физически не отдают per-SKU статистику Performance API —
//  их расход остаётся ТОЛЬКО в ozon_daily_efficiency, в daily_metrics его
//  нет ни на одном product_id. Проверено эмпирически (июль-2026, кабинет 1):
//  Σ daily_metrics.ad_spend (по товарам) = 33 892,01 ₽, ad_spend кабинета
//  (ozon_daily_efficiency) = 63 947,03 ₽ — покрытие 53,0%, разница ЦЕЛИКОМ
//  (до копейки) объясняется кампанией 27109544 (см. task-5-report.md, Step 4
//  плана 2026-08-21-ozon-sku-ads). Отсюда Σ ads(товар) ≤ ads(кабинета)
//  структурно, не по ошибке — «нераспределённый остаток» вычитается ТОЛЬКО
//  на кабинетном вызове (см. докстроку ozProfitProduct ниже и проверку 5
//  check-profit-canon.mjs).
// =====================================================================

export async function ozAdSpend(db, { from, to, groupByProduct = false, productId = null } = {}) {
  if (productId != null) {
    // Subquery-форма — та же причина, что у кабинетной ветки ниже (баг
    // эмулятора «агрегат после серии запросов возвращает 0», products-
    // summary:144). date в daily_metrics — DATE, .slice(0,10) на случай
    // ISO-таймстампа в to (как у кабинетной ветки).
    const r = await db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(ad_spend),0) FROM daily_metrics
                 WHERE date >= ? AND date <= ? AND product_id = ?
                 AND ad_spend IS NOT NULL) AS s`
      )
      .get(from, to.slice(0, 10), productId);
    return round2((r && r.s) || 0);
  }
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

// =====================================================================
//  КАНОНИЧЕСКИЙ СЛОЙ ПРИБЫЛИ Ozon (план «унификация формул прибыли»,
//  2026-08-20, docs/superpowers/plans/2026-08-20-profit-unification.md,
//  задача 1). Единственный источник формулы прибыли для 7 роутов панели
//  (pnl, overview, detail, products-summary, rnp-summary, plan/fact,
//  orders) — задачи 4-5 переводят роуты сюда, ЭТОТ файл формулу не знает
//  ни разу дважды.
//
//  ⚠️ ПОЧЕМУ НЕ старые агрегаты ozOrderCostsAggregate/ozOrderCostsByProduct
//  (хотя брифинг задачи 1 просил строить канон НА них — удалены задачей 6
//  как осиротевшие после переезда всех роутов на канон, ноль вызовов вне
//  их собственного определения, см. task-6-report.md): те агрегаты
//  СОЗНАТЕЛЬНО фильтровали is_return=0 — это было верно для их назначения
//  (витрина «продажи периода»), но ЛОМАЛО БЫ канон. Строка order_costs с
//  is_return=1 — не «шум», а НАСТОЯЩИЙ убыток (cost списывается,
//  cost_value_retail сознательно обнулён сборщиком —
//  worker/collectors/ozon_order_costs.py:490 — а не отсутствует).
//  Проверено эмпирически (июль-2026, кабинет 1): SUM(profit) ПО ВСЕМ
//  строкам = −38 009,19 ₽; с фильтром is_return=0 (старый агрегат) —
//  +42 785,35 ₽ — разница 80 794,54 ₽, ЦЕЛИКОМ убыток возвратов (cost
//  возвращённых товаров 63 813 ₽ + логистика возврата 16 981,54 ₽),
//  который старый агрегат тихо терял. profit-колонка order_costs УЖЕ
//  учитывает возвраты корректно (profit = SUM(accrued) − cost по ВСЕЙ
//  истории юнита, worker/collectors/ozon_order_costs.py:507) — канон
//  просто не должен выбрасывать эти строки при суммировании. Ровно тот же
//  is_return=0 фильтр объясняет исторический баг «прибыль Ozon завышена»,
//  который вскрыла проверка Task 1 (check-profit-canon.mjs).
//
//  returnLogistics — СПРАВОЧНАЯ строка (формула из docs/metrics-contract.md
//  §«Убыток по возвратам»: SUM(logistics|is_return=1) + SUM(commission|
//  is_return=1)), УЖЕ включена в общие logistics/commission выше — она НЕ
//  вычитается из profit повторно, только показывается отдельно для UI
//  («из них убыток по возвратам: N ₽»).
//
//  ads (реклама) — с 2026-08-22 (задача 6): при productId-фильтре ads =
//  РЕАЛЬНЫЙ расход товара (daily_metrics.ad_spend, миграция 043, источник
//  ozon_daily_sku_ad — см. докстрою ozAdSpend выше), а НЕ 0. Σ(ads по
//  товарам) ≤ ads(кабинета) СТРУКТУРНО (не баг): кампании без товарной
//  разбивки (напр. «Оплата за заказ — все товары», ~47% бюджета кабинета 1
//  в июле) физически не разносятся по SKU — их расход остаётся только в
//  ads(кабинета). Этот «нераспределённый остаток» = ads(кабинета) −
//  Σ ads(товар) вычитается ТОЛЬКО на кабинетном вызове (productId=null),
//  НЕ размазывается по товарам (та же логика «честно, а не размазано», что
//  была в старой версии до задачи 6). Отсюда Σ(profit по товарам) ВЫШЕ
//  (менее убыточна), чем profit(без фильтра), РОВНО на нераспределённый
//  остаток — учтено в check-profit-canon.mjs (проверка «productId-фильтр
//  аддитивен» сравнивает Σ profit(товар) МИНУС нераспределённый остаток с
//  profit(без фильтра), см. коммент там же).
//
//  tax (налог) — существующий calcTotalTax (lib/tax.js), БЕЗ изменения
//  методики. Считается на своей базе: при productId — revenue/expenses
//  ЭТОГО товара (тот же приём, что был в products-summary до канона);
//  без productId — revenue/expenses кабинета. Под usn_income (текущий
//  режим обоих кабинетов) налог = revenueNet × rate% — линеен по выручке,
//  поэтому Σ tax(товар) = tax(кабинет) ТОЧНО (проверено check-profit-canon.
//  mjs). Под usn_income_expenses (не используется сегодня, но методику
//  не трогаем) аддитивность по товарам не гарантирована — это свойство
//  самой налоговой формулы (минимальный налог 1% — не линейная функция),
//  а не баг канона.
//
//  ⚠️ spp / realized / payout — поля СИММЕТРИИ формы с WB (задача 2 плана
//  «выручка WB по цене со скидкой продавца», 2026-09-06). У Ozon:
//  spp = 0 (скидки площадки за свой счёт отдельной строкой не приходят),
//  realized = revenue (Σ cost_value_retail УЖЕ то, что заплатил покупатель;
//  отдельного «валового» поля у Ozon нет — оно было бы дублем revenue),
//  payout = revenue − commission − services − acquiring − loyalty («к
//  перечислению», ровно те вычеты, что канон Ozon и так делает в expenses/
//  profitGross). Методология Ozon этими полями НЕ меняется: ни одна формула
//  прибыли/налога их не читает — они только выравнивают форму ответа,
//  чтобы витрины (P&L, Главная) не ветвились по площадке.
//  Раньше здесь стояла оговорка про wbRevenueGross — эта функция удалена
//  вместе с переездом канона WB на валовую выручку.
// =====================================================================

// Хелпер симметрии формы с WB (см. докстроку выше) — ОДИН на все четыре
// формы агрегата Ozon, как wbAggRow у WB.
function ozNetForm(agg) {
  return {
    ...agg,
    spp: 0,
    realized: agg.revenue,
    payout: round2(agg.revenue - agg.commission - agg.services - agg.acquiring - agg.loyalty),
  };
}

// SQL агрегата order_costs БЕЗ фильтра is_return (см. докстроку выше) —
// единственное отличие от старого удалённого ozOrderCostsAggregate.
async function ozRawProfitAggregate(db, { from, to, productId } = {}) {
  const whereNm = productId != null ? "AND product_id = ?" : "";
  const params = productId != null ? [from, to, productId] : [from, to];
  const r = await db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_value_retail), 0) AS revenue,
         COALESCE(SUM(cost), 0) AS cogs,
         COALESCE(SUM(commission), 0) AS commission,
         COALESCE(SUM(services), 0) AS services,
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(acquiring), 0) AS acquiring,
         COALESCE(SUM(loyalty), 0) AS loyalty,
         COALESCE(SUM(profit), 0) AS "rawProfit",
         COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0) AS "retLogistics",
         COALESCE(SUM(commission) FILTER (WHERE is_return = 1), 0) AS "retCommission"
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ? ${whereNm}`
    )
    .get(...params);
  return ozNetForm({
    revenue: round2((r && r.revenue) || 0),
    cogs: round2((r && r.cogs) || 0),
    commission: round2((r && r.commission) || 0),
    // services — задача 3 плана «Сборы Ozon» (2026-08-25): расщеплено из
    // logistics бэкфиллом задач 1-2 (logistics_old = logistics_new +
    // services_new, profit-колонка БД не тронута) — слагаемое ДОЛЖНО войти
    // в expenses/profitGross ниже, иначе налоговая база/валовая прибыль
    // молча просядут на сумму services (см. докстроку ozProfitProduct).
    services: round2((r && r.services) || 0),
    logistics: round2((r && r.logistics) || 0),
    acquiring: round2((r && r.acquiring) || 0),
    loyalty: round2((r && r.loyalty) || 0),
    rawProfit: round2((r && r.rawProfit) || 0),
    returnLogistics: round2(((r && r.retLogistics) || 0) + ((r && r.retCommission) || 0)),
  });
}

// Batch-версия ozRawProfitAggregate: те же слагаемые, GROUP BY product_id.
// Скалярная версия остаётся (detail/plan-fact зовут по одному товару);
// инвариант «batch ≡ скаляр» держит проверка №6 check-profit-canon.mjs.
async function ozRawProfitAggregateBatch(db, { from, to } = {}) {
  const rows = await db
    .prepare(
      `SELECT
         product_id,
         COALESCE(SUM(cost_value_retail), 0) AS revenue,
         COALESCE(SUM(cost), 0) AS cogs,
         COALESCE(SUM(commission), 0) AS commission,
         COALESCE(SUM(services), 0) AS services,
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(acquiring), 0) AS acquiring,
         COALESCE(SUM(loyalty), 0) AS loyalty,
         COALESCE(SUM(profit), 0) AS "rawProfit",
         COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0) AS "retLogistics",
         COALESCE(SUM(commission) FILTER (WHERE is_return = 1), 0) AS "retCommission"
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
         AND product_id IS NOT NULL -- строки без привязки к товару не принадлежат ни одной корзине batch; периодный скаляр их видит — законное расхождение состава, не формулы
       GROUP BY product_id`
    )
    .all(from, to);
  const out = new Map();
  for (const r of rows) {
    out.set(r.product_id, ozNetForm({
      revenue: round2(r.revenue || 0),
      cogs: round2(r.cogs || 0),
      commission: round2(r.commission || 0),
      services: round2(r.services || 0), // см. коммент у ozRawProfitAggregate
      logistics: round2(r.logistics || 0),
      acquiring: round2(r.acquiring || 0),
      loyalty: round2(r.loyalty || 0),
      rawProfit: round2(r.rawProfit || 0),
      returnLogistics: round2((r.retLogistics || 0) + (r.retCommission || 0)),
    }));
  }
  return out;
}

// Дневная версия ozRawProfitAggregate: ТОТ ЖЕ SELECT (те же слагаемые, тот же
// is_return-БЕЗ-фильтра принцип — см. докстроку выше), GROUP BY день вместо
// периода целиком, для ОДНОГО товара (один SQL на весь период — не N SQL на
// N дней). Задача 6 плана «канон волна 2» (2026-08-25): заменяет detail-роуту
// ручные by-day SQL с приближением «rev−gross≈расходы» — этот агрегат даёт
// РОВНО те же поля, что скалярный ozRawProfitAggregate, посуточно, поэтому
// композиция profit(день) = rawProfit(день) − ads(день) − tax(день) (см.
// app/api/cabinets/[id]/detail/route.js, collectOzon) даёт Σ profit(день) =
// ozProfitProduct(period, productId).profit ТОЧНО под usn_income (налог
// линеен по выручке) — проверка №7 check-profit-canon.mjs.
export async function ozRawProfitByDay(db, { from, to, productId } = {}) {
  const whereNm = productId != null ? "AND product_id = ?" : "";
  const params = productId != null ? [from, to, productId] : [from, to];
  const rows = await db
    .prepare(
      `SELECT
         substr(COALESCE(sale_dt, return_dt),1,10) AS d,
         COALESCE(SUM(cost_value_retail), 0) AS revenue,
         COALESCE(SUM(cost), 0) AS cogs,
         COALESCE(SUM(commission), 0) AS commission,
         COALESCE(SUM(services), 0) AS services,
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(acquiring), 0) AS acquiring,
         COALESCE(SUM(loyalty), 0) AS loyalty,
         COALESCE(SUM(profit), 0) AS "rawProfit",
         COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0) AS "retLogistics",
         COALESCE(SUM(commission) FILTER (WHERE is_return = 1), 0) AS "retCommission"
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ? ${whereNm}
       GROUP BY substr(COALESCE(sale_dt, return_dt),1,10)`
    )
    .all(...params);
  const out = new Map();
  for (const r of rows) {
    out.set(r.d, ozNetForm({
      revenue: round2(r.revenue || 0),
      cogs: round2(r.cogs || 0),
      commission: round2(r.commission || 0),
      services: round2(r.services || 0), // см. коммент у ozRawProfitAggregate
      logistics: round2(r.logistics || 0),
      acquiring: round2(r.acquiring || 0),
      loyalty: round2(r.loyalty || 0),
      rawProfit: round2(r.rawProfit || 0),
      returnLogistics: round2((r.retLogistics || 0) + (r.retCommission || 0)),
    }));
  }
  return out;
}

// Кабинетный дневной агрегат для спарклайна Сводки; форма и слагаемые =
// ozRawProfitByDay, инвариант: Σ дней = ozRawProfitAggregate(period) —
// сверяется приёмкой задачи. ПЕРЕНОС SELECT'а ozRawProfitByDay БЕЗ
// параметра/фильтра product_id (байт-в-байт слагаемые и датировка) — задача 1
// плана «Сводка по макету» (2026-08-25).
export async function ozRawProfitCabinetByDay(db, { from, to } = {}) {
  const rows = await db
    .prepare(
      `SELECT
         substr(COALESCE(sale_dt, return_dt),1,10) AS d,
         COALESCE(SUM(cost_value_retail), 0) AS revenue,
         COALESCE(SUM(cost), 0) AS cogs,
         COALESCE(SUM(commission), 0) AS commission,
         COALESCE(SUM(services), 0) AS services,
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(acquiring), 0) AS acquiring,
         COALESCE(SUM(loyalty), 0) AS loyalty,
         COALESCE(SUM(profit), 0) AS "rawProfit",
         COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0) AS "retLogistics",
         COALESCE(SUM(commission) FILTER (WHERE is_return = 1), 0) AS "retCommission"
       FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
       GROUP BY substr(COALESCE(sale_dt, return_dt),1,10)`
    )
    .all(from, to);
  const out = new Map();
  for (const r of rows) {
    out.set(r.d, ozNetForm({
      revenue: round2(r.revenue || 0),
      cogs: round2(r.cogs || 0),
      commission: round2(r.commission || 0),
      services: round2(r.services || 0), // см. коммент у ozRawProfitAggregate
      logistics: round2(r.logistics || 0),
      acquiring: round2(r.acquiring || 0),
      loyalty: round2(r.loyalty || 0),
      rawProfit: round2(r.rawProfit || 0),
      returnLogistics: round2((r.retLogistics || 0) + (r.retCommission || 0)),
    }));
  }
  return out;
}

// Дневная композиция канона (детализация + проверка №7 исполняют ИМЕННО
// эту функцию — роут и сторож не могут разъехаться). expenses дня — те же
// слагаемые, что скаляр ozProfitProduct; profit дня = rawProfit − ad − tax.
// Σ profit(день) = ozProfitProduct(period).profit при линейном налоге
// (usn_income; при usn_income_expenses clamp/minTax нелинейны — см. §11.5
// контракта). agg — форма ozRawProfitByDay (или ZERO_RAW_AGG).
export function ozDayProfit(agg, adDay, taxMode) {
  const expenses = agg.cogs + agg.commission + agg.services + agg.logistics + agg.acquiring + agg.loyalty + adDay;
  const tax = calcTotalTax(taxMode, agg.revenue, expenses).total;
  return round2(agg.rawProfit - adDay - tax);
}

// ozProfitProduct(db, taxMode, period, productId) — товарная прибыль (канон).
// period = { cabinetId, from, to } (даты YYYY-MM-DD, включительно). cabinetId
// не участвует в SQL напрямую (DatabaseSync уже внутри RLS-транзакции нужного
// кабинета, withTenant/withCabinet) — принимается для формы контракта (её же
// используют check-скрипты и роуты задач 4-5, где cabinetId явный).
// taxMode — нормализованный режим (normalizeTaxMode из lib/tax.js), тот же
// вход, что уже используют pnl/overview/detail/products-summary/rnp-summary.
export async function ozProfitProduct(db, taxMode, { from, to } = {}, productId = null) {
  const agg = await ozRawProfitAggregate(db, { from, to, productId });
  const ads = productId == null
    ? await ozAdSpend(db, { from, to })
    : await ozAdSpend(db, { from, to, productId });
  // services — задача 3 плана «Сборы Ozon»: та же сумма, что до бэкфилла
  // задач 1-2 сидела внутри logistics (logistics_old = logistics_new +
  // services_new) — включаем её в expenses/profitGross, чтобы налоговая
  // база и валовая прибыль не просели молча после расщепления колонки.
  const expenses = agg.cogs + agg.commission + agg.services + agg.logistics + agg.acquiring + agg.loyalty + ads;
  const taxCalc = calcTotalTax(taxMode, agg.revenue, expenses);
  const profit = round2(agg.rawProfit - ads - taxCalc.total);
  return {
    revenue: agg.revenue,
    // spp/realized/payout — поля симметрии формы с WB (ozNetForm выше).
    // Ручной whitelist их терял, а ozProfitCabinet наследует этот объект
    // через {...base} — витрины (P&L «К перечислению») получали undefined.
    spp: agg.spp,
    realized: agg.realized,
    payout: agg.payout,
    cogs: agg.cogs,
    commission: agg.commission,
    services: agg.services,
    logistics: agg.logistics,
    acquiring: agg.acquiring,
    loyalty: agg.loyalty,
    returnLogistics: agg.returnLogistics,
    ads: round2(ads),
    tax: taxCalc.total,
    profit,
    // profitGross — справочная валовая прибыль (выручка минус прямые расходы
    // уровня заказа, ДО рекламы/налога); та же формула, что дубли в pnl/
    // products-summary/detail (задача 3 плана «канон волна 2») — теперь
    // отдаётся каноном напрямую, дубли переводятся на неё задачей 2.
    // services вычитается тем же приёмом, что и в expenses выше (задача 3
    // плана «Сборы Ozon») — иначе profitGross был бы завышен ровно на
    // сумму, расщеплённую бэкфиллом из logistics.
    profitGross: round2(agg.revenue - agg.cogs - agg.commission - agg.services - agg.logistics - agg.acquiring - agg.loyalty),
  };
}

// Канон по ВСЕМ товарам периода за 2 SQL (агрегат + реклама) вместо 2×N.
// Формула КАЖДОГО товара идентична ozProfitProduct(productId) — включая
// налог на товарной базе; расхождение с ним = баг (проверка №6).
export async function ozProfitProductBatch(db, taxMode, { from, to } = {}) {
  const aggs = await ozRawProfitAggregateBatch(db, { from, to });
  const ads = await ozAdSpend(db, { from, to, groupByProduct: true });
  const out = new Map();
  const ids = new Set([...aggs.keys(), ...Object.keys(ads).map(Number)]);
  for (const id of ids) {
    const agg = aggs.get(id) || ZERO_RAW_AGG; // ZERO_RAW_AGG уже несёт services:0 (lib/profitForms.js)
    const ad = round2(ads[id] || 0);
    // services — то же слагаемое, что и в скалярном ozProfitProduct выше
    // (инвариант №6 «batch ≡ скаляр» — строго та же формула).
    const expenses = agg.cogs + agg.commission + agg.services + agg.logistics + agg.acquiring + agg.loyalty + ad;
    const taxCalc = calcTotalTax(taxMode, agg.revenue, expenses);
    out.set(id, {
      ...agg,
      ads: ad,
      tax: taxCalc.total,
      profit: round2(agg.rawProfit - ad - taxCalc.total),
      profitGross: round2(agg.revenue - agg.cogs - agg.commission - agg.services - agg.logistics - agg.acquiring - agg.loyalty),
    });
  }
  return out;
}

// ── Словарь cost_type → русское имя (accrual_<id> → shared.ozon_accrual_types).
// Кэш на процесс: справочник маленький (119 строк) и статичен в рамках
// одного запуска панели/скрипта — читаем БД один раз, а не на каждую строку
// cabinetCosts. Промис (не просто Map) — защита от гонки: пока первая
// загрузка летит, параллельные вызовы (несколько строк cabinetCosts за один
// ozProfitCabinet) ждут ТОТ ЖЕ промис, а не бьют БД N раз.
let _ozAccrualLabelsPromise = null;
async function loadOzonAccrualLabels(db) {
  if (!_ozAccrualLabelsPromise) {
    _ozAccrualLabelsPromise = (async () => {
      const map = new Map();
      for (const r of await db
        .prepare(`SELECT type_id, description, name FROM shared.ozon_accrual_types`)
        .all()) {
        map.set(Number(r.type_id), r.description || r.name || null);
      }
      return map;
    })();
  }
  return _ozAccrualLabelsPromise;
}

// Разбор cost_type → { label, known }. known=false → технический ключ либо не
// формата accrual_<id>, либо type_id отсутствует в справочнике — такие статьи
// считает unknownCostTypes в ozProfitCabinet (не молча, брифинг задачи 1).
// Сегодня ВСЕ cost_type в tenant.ozon_cabinet_costs имеют вид accrual_<id>
// (worker/collectors/ozon_order_costs.py:878, сборщик другого формата не
// пишет) — ветка «не accrual_» защитная, на будущее.
async function resolveOzonCostLabel(db, costType) {
  const m = /^accrual_(\d+)$/.exec(String(costType ?? ""));
  if (m) {
    const labels = await loadOzonAccrualLabels(db);
    const name = labels.get(Number(m[1]));
    if (name) return { label: name, known: true };
  }
  return { label: `Прочее (${costType})`, known: false };
}

// ozCabinetCostLabel(db, costType) → string — русское имя статьи кабинетных
// расходов Ozon (не сырой ключ вроде accrual_93, задача 1 плана унификации
// прибыли). db нужен для первого чтения shared.ozon_accrual_types (см.
// loadOzonAccrualLabels — кэш на процесс, дальнейшие вызовы БД не бьют).
export async function ozCabinetCostLabel(db, costType) {
  return (await resolveOzonCostLabel(db, costType)).label;
}

// ozProfitCabinet(db, taxMode, period) — кабинетная прибыль (канон):
// товарная прибыль (ozProfitProduct без productId) ПЛЮС знаковая сумма
// кабинетных статей (tenant.ozon_cabinet_costs, включая accrual_% —
// Premium/RFBS/штрафы и пр., решение владельца 2026-08-20: кабинетные
// расходы вычитаются только на кабинетных страницах — P&L, Обзор — товарные
// их не видят, см. design.md).
// profit = profitProduct.profit + Σ cabinetCosts[].amount — ЗНАКОВАЯ сумма
// (ИСПРАВЛЕНО ревью задачи 1, fix-раунд: первая версия брала МОДУЛЬ каждой
// статьи, «буквально по плану», — контролёр признал формулировку плана
// своей ошибкой: положительная статья ДОЛЖНА увеличивать прибыль, а не
// уменьшать её на свой модуль). amount хранится в БД уже знаковым
// (отрицательный = расход, положительный = доход) — берём как есть, без
// Math.abs. Единственная статья с положительным знаком у кабинета 1 за
// июль-2026 — accrual_62 (RfbsClientDeliveryCharge, «Перечисление за
// доставку от покупателя», +8 955 ₽, транзитный доход RFBS) — теперь
// ДОБАВЛЯЕТСЯ к прибыли (было: вычитался модуль, −8 955 ₽ вместо +8 955 ₽ —
// расхождение 2×8 955=17 910 ₽ на этой одной статье, см. check-profit-
// canon.mjs).
export async function ozProfitCabinet(db, taxMode, period = {}) {
  const { from, to } = period;
  const base = await ozProfitProduct(db, taxMode, period, null);

  const rows = await db
    .prepare(
      `SELECT cost_type, COALESCE(SUM(amount),0) AS s
       FROM cabinet_costs
       WHERE date >= ? AND date <= ?
       GROUP BY cost_type
       ORDER BY cost_type`
    )
    .all(from, to);

  let unknownCostTypes = 0;
  const cabinetCosts = [];
  for (const row of rows) {
    const { label, known } = await resolveOzonCostLabel(db, row.cost_type);
    if (!known) unknownCostTypes++;
    cabinetCosts.push({ costType: row.cost_type, label, amount: round2(row.s) });
  }

  const signedSum = cabinetCosts.reduce((acc, c) => acc + c.amount, 0);
  const profit = round2(base.profit + signedSum);

  // cabinetCostsInfo — единый контракт с wbProfitCabinet (справочные статьи
  // вне прибыли, docs/metrics-contract.md §19); у Ozon таких статей нет.
  return { ...base, cabinetCosts, cabinetCostsInfo: [], unknownCostTypes, profit };
}
