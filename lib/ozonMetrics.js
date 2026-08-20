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
import { calcTotalTax } from "./tax.js";
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

// =====================================================================
//  КАНОНИЧЕСКИЙ СЛОЙ ПРИБЫЛИ Ozon (план «унификация формул прибыли»,
//  2026-08-20, docs/superpowers/plans/2026-08-20-profit-unification.md,
//  задача 1). Единственный источник формулы прибыли для 7 роутов панели
//  (pnl, overview, detail, products-summary, rnp-summary, plan/fact,
//  orders) — задачи 4-5 переводят роуты сюда, ЭТОТ файл формулу не знает
//  ни разу дважды.
//
//  ⚠️ ПОЧЕМУ НЕ ozOrderCostsAggregate/ozOrderCostsByProduct (хотя брифинг
//  просит строить канон НА них): те агрегаты СОЗНАТЕЛЬНО фильтруют
//  is_return=0 (комментарий у ozOrderCostsAggregate) — это верно для их
//  назначения (витрина «продажи периода»), но ЛОМАЕТ канон. Строка
//  order_costs с is_return=1 — не «шум», а НАСТОЯЩИЙ убыток (cost
//  списывается, cost_value_retail сознательно обнулён сборщиком —
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
//  ads (реклама) — ТОЛЬКО кабинетная сумма (Performance API Ozon не даёт
//  пер-SKU расход, см. докстрою ozAdSpend выше). При productId-фильтре
//  ads = 0 (честно, а не «размазано» — данных нет физически): попытка
//  вычесть кабинетную рекламу из ОДНОГО товара исказила бы его прибыль
//  сильнее, чем просто её не показать. Из-за этого Σ(ads по товарам) = 0,
//  а не ads кабинета, поэтому Σ(profit по товарам) ВЫШЕ (менее убыточна),
//  чем profit(без фильтра), РОВНО на ads кабинета — учтено в check-profit-
//  canon.mjs (проверка «productId-фильтр аддитивен» сравнивает Σ profit
//  (товар) МИНУС ads(кабинета) с profit(без фильтра), а не голый
//  Σ profit(товар) — иначе проверка была бы математически невыполнима при
//  любой ненулевой рекламе, см. коммент там же).
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
// =====================================================================

// SQL агрегата order_costs БЕЗ фильтра is_return (см. докстроку выше) —
// единственное отличие от ozOrderCostsAggregate.
async function ozRawProfitAggregate(db, { from, to, productId } = {}) {
  const whereNm = productId != null ? "AND product_id = ?" : "";
  const params = productId != null ? [from, to, productId] : [from, to];
  const r = await db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_value_retail), 0) AS revenue,
         COALESCE(SUM(cost), 0) AS cogs,
         COALESCE(SUM(commission), 0) AS commission,
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
  return {
    revenue: round2((r && r.revenue) || 0),
    cogs: round2((r && r.cogs) || 0),
    commission: round2((r && r.commission) || 0),
    logistics: round2((r && r.logistics) || 0),
    acquiring: round2((r && r.acquiring) || 0),
    loyalty: round2((r && r.loyalty) || 0),
    rawProfit: round2((r && r.rawProfit) || 0),
    returnLogistics: round2(((r && r.retLogistics) || 0) + ((r && r.retCommission) || 0)),
  };
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
  const ads = productId == null ? await ozAdSpend(db, { from, to }) : 0;
  const expenses = agg.cogs + agg.commission + agg.logistics + agg.acquiring + agg.loyalty + ads;
  const taxCalc = calcTotalTax(taxMode, agg.revenue, expenses);
  const profit = round2(agg.rawProfit - ads - taxCalc.total);
  return {
    revenue: agg.revenue,
    cogs: agg.cogs,
    commission: agg.commission,
    logistics: agg.logistics,
    acquiring: agg.acquiring,
    loyalty: agg.loyalty,
    returnLogistics: agg.returnLogistics,
    ads: round2(ads),
    tax: taxCalc.total,
    profit,
  };
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

  return { ...base, cabinetCosts, unknownCostTypes, profit };
}
