// lib/productsSummaryData.js — строки и итоги «Сводки по товарам» (перенос из
// app/api/cabinets/[id]/products-summary/route.js, 15.10.2026, без изменения логики):
// единый расчёт для Сводки и «Дашборда показателей» (lib/kpiDashboardData.js).
// Деньги каждой строки — канон *ProfitProductBatch; итоги — aggTotals + довычет
// нераспределённой рекламы (buildTotals). Импорты относительные — модуль грузят
// и node-скрипты (scripts/smoke-*.mjs).
import { DatabaseSync } from "./db.js";
import { wbAdTotal, wbProfitProductBatch } from "./wbMetrics.js";
import { ozProfitProductBatch } from "./ozonMetrics.js";
import { normalizeTaxMode } from "./tax.js";
import { ZERO_PROFIT } from "./profitForms.js";
import { aggregateBuyout, todayMsk } from "./buyout.js";
import { loadWbBuyoutRows, loadOzonBuyoutRows } from "./buyoutData.js";

export function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

export function aggTotals(items) {
  const t = {
    ordered: 0, sold: 0, cancelled: 0, returns: 0, selfBuyout: 0,
    buyoutSold: 0, buyoutResolved: 0,
    orderRub: 0, salesRub: 0, costRub: 0, commission: 0, logistics: 0,
    acquiring: 0, loyalty: 0, tax: 0, profit: 0, adSpend: 0, stock: 0,
    returnLogistics: 0,
    // «Три цены» канона (спека 2026-09-06) — аддитивны, есть у обеих
    // площадок (у Ozon spp = 0, realized = salesRub).
    spp: 0, realized: 0, payout: 0,
    // services («Сборы Ozon», задача 4 плана «Сборы Ozon») — только Ozon-
    // строки несут i.services (WB-строки — undefined → 0, безвредно).
    services: 0,
  };
  for (const i of items) {
    t.ordered += i.ordered || 0;
    t.sold += i.sold || 0;
    t.cancelled += i.cancelled || 0;
    t.returns += i.returns || 0;
    t.selfBuyout += i.selfBuyout || 0;
    t.buyoutSold += i.buyoutSold || 0;
    t.buyoutResolved += i.buyoutResolved || 0;
    t.orderRub += i.orderRub || 0;
    t.salesRub += i.salesRub || 0;
    t.costRub += i.costRub || 0;
    t.commission += i.commission || 0;
    t.logistics += i.logistics || 0;
    t.acquiring += i.acquiring || 0;
    t.loyalty += i.loyalty || 0;
    t.tax += i.tax || 0;
    t.profit += i.profit || 0;
    t.adSpend += i.adSpend || 0;
    t.stock += i.stock || 0;
    t.returnLogistics += i.returnLogistics || 0;
    t.services += i.services || 0;
    t.spp += i.spp || 0;
    t.realized += i.realized || 0;
    t.payout += i.payout || 0;
  }
  t.buyoutPct = t.buyoutResolved > 0 ? round2(100 * t.buyoutSold / t.buyoutResolved) : null;
  t.margin = t.salesRub ? round2(100 * t.profit / t.salesRub) : null;
  t.avgCheck = t.ordered ? round2(t.orderRub / t.ordered) : null;
  // ДРР итогов — та же пара баз, что у item.drr/item.drrSales выше (решение
  // владельца 08.09.2026): drr от заказов (основной), drrSales от продаж.
  // Перезаписывается ниже в buildTotals ПОСЛЕ довычета кабинетного остатка
  // рекламы (totals.adSpend меняется на fullAd) — см. коммент там.
  t.drr = t.adSpend && t.orderRub ? round2(100 * t.adSpend / t.orderRub) : null;
  t.drrSales = t.adSpend && t.salesRub ? round2(100 * t.adSpend / t.salesRub) : null;
  return t;
}

// Сдвиг даты 'YYYY-MM-DD' на N дней в UTC (независимо от часового пояса
// сервера) — для prev-окна (задача 1 плана «Сводка по макету», 2026-08-25).
export function shiftDateUTC(dateStr, deltaDays) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// buildTotals(cabinet, platform, from, to, includeInactive, stat) — ЕДИНЫЙ
// источник totals (задача 1 плана «Сводка по макету», 2026-08-25). Тело —
// ПЕРЕНОС без изменений того, что раньше жило прямо в GET: сбор items
// (collectWB/collectOzon) → фильтр статуса (симметрично /api/unit/all) →
// aggTotals → довычет НЕРАСПРЕДЕЛЁННОГО остатка кабинетной рекламы (канон
// задачи 5 плана унификации прибыли + задачи 6/7 плана «реклама Ozon по
// товарам», см. исходные комментарии ниже — сохранены байт-в-байт). Вызывается
// дважды из GET: за текущее окно (totals) и за prev-окно (prevTotals) —
// СТРОГО тем же кодом, а не копией.
export async function buildTotals(cabinet, platform, from, to, includeInactive, stat) {
  const toEnd = to ? to + "T23:59:59" : "";

  let items = [];
  const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
  const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);
  if (platform !== "ozon") items = items.concat(await collectWB(from, toEnd, cabinet.shop_names?.wb, wbTax));
  if (platform !== "wb")   items = items.concat(await collectOzon(from, toEnd, cabinet.shop_names?.ozon, ozonTax));

  // ⚠️ ФИЛЬТР СТАТУСА 2026-07-23 (симметрично /api/unit/all): показываем active-товары
  // (из products, fallback "active") ПЛЮС товары С продажами/возвратами за период
  // (даже inactive — чтобы не терять свежие продажи снятого с продаж товара). Раньше
  // addStub по products добавлял ВСЕ 88 ozon-артикулов, включая 34 inactive без продаж.
  if (!includeInactive) {
    items = items.filter((it) => {
      const key = `${it.platform}|${it.platform === "ozon" ? 0 : it.nm}|${it.platform === "ozon" ? it.nm : 0}`;
      const status = stat[key] || "active";
      it.status = status;
      // Товар с продажами/возвратами ИЛИ с заказами когорты (включая отказы/возвраты
      // без продажи — buyoutResolved) за период → показываем ВСЕГДА (независимо от
      // статуса). Товар без активности → только если active. Это сохраняет свежие
      // продажи снятого товара, но убирает inactive-мусор без продаж.
      // ⚠️ Фикс 2026-10-12 (финальное ревью «Процент выкупа»): раньше hasActivity не
      // учитывал buyoutResolved/ordered — inactive-товар с отказами/возвратами когорты,
      // но без sale-датированного sold, выпадал из Сводки целиком вместе со своими
      // счётчиками выкупа → totals Сводки и страницы «Процент выкупа» расходились
      // (live: 333/603 на странице vs 333/602 в Сводке, nm 721030807 — 1 заказ, 1 отказ).
      const hasActivity = (it.sold || 0) + (it.returns || 0) > 0
        || (it.buyoutResolved || 0) > 0
        || (it.ordered || 0) > 0;
      return hasActivity || status === "active";
    });
  } else {
    // includeInactive: обогащаем статусом, но не фильтруем (для отладки/сверки).
    for (const it of items) {
      const key = `${it.platform}|${it.platform === "ozon" ? 0 : it.nm}|${it.platform === "ozon" ? it.nm : 0}`;
      it.status = stat[key] || "active";
    }
  }

  const totals = aggTotals(items);

  // unallocatedAds — нераспределённый остаток кабинетной рекламы (fullAd −
  // Σ item.adSpend, снизу зажат нулём), вычисляется ниже вместе с довычетом
  // totals.profit. По умолчанию 0 (period может быть пуст — см. `if (from &&
  // to)` ниже). Вынесено отдельной переменной для ответа GET (задача 8 плана
  // «geo-canon-vitrina», строка «Не разнесено по товарам», инцидент 05.09) —
  // ЧИСЛО НЕ ПЕРЕСЧИТЫВАЕТСЯ заново, это ровно то, что и раньше вычиталось
  // из totals.profit молча.
  let unallocatedAds = 0;

  // ⚠️ КАНОН (задача 5 плана унификации прибыли; формула ads переписана
  // задачей 6/7 плана «реклама Ozon по товарам», 2026-08-21/22): it.profit
  // = canon profitProduct(nm/pid).profit, где ads(товар) ТЕПЕРЬ реальный
  // per-SKU расход (не 0) — Σ(item.profit) уже содержит Σ item.adSpend.
  // Чтобы totals.profit сходился с pnl.profit (товарная часть = profitProduct
  // БЕЗ productId, где ПОЛНАЯ ads(кабинета) вычитается ОДИН раз) — см.
  // check-profit-canon.mjs, проверка 5 «productId-фильтр аддитивен»:
  // Σ profit(товар) − (ads(кабинета) − Σ ads(товар)) = profit(без фильтра).
  // Довычитаем здесь ТОЛЬКО нераспределённый остаток (fullAd − Σ item.
  // adSpend, снизу зажат нулём — округления не должны давать отрицательный
  // довычет), а не всю fullAd целиком (иначе Σ item.adSpend вычлась бы
  // ДВАЖДЫ — один раз внутри item.profit, второй раз здесь). item.adSpend
  // остаётся реальным per-SKU расходом для ДРР/CPA/ROMI (решение владельца,
  // шлюз docs/profit-unification-delta.md → задача 6 плана «реклама Ozon по
  // товарам»).
  //
  // logistics больше НЕ пересчитывается отдельным «полным» блоком (в отличие
  // от рекламы): canon-логистика каждого товара — это ПРЯМАЯ сумма
  // order_costs.logistics ЗА ЭТОТ nm/product_id (не finance_report-агрегат,
  // который создавал запись только для nm с «Продажей» и терял logistics-
  // only nm) — rows строится из ВСЕХ nm/product_id, когда-либо встречавшихся
  // в order_costs (см. коммент у SQL rows ниже), поэтому Σ(item.logistics)
  // уже полна и аддитивна сама по себе (проверено check-profit-canon.mjs,
  // «слагаемые аддитивны»), никакого top-up не требуется.
  if (from && to) {
    // ⚠️ Грабля SAAS (та же что с logistics): отдельный prepare().get() для
    // агрегата после предыдущих запросов в транзакции возвращает 0 (баг
    // эмулятора DatabaseSync поверх node-postgres). Решение: считать через
    // subquery в одном запросе. fullAd = Σ ad_spend из daily_metrics за период.
    let fullAd = 0;
    // ⚠️ ФИКС 2026-07-23: каждый блок — в своём platform-гарде, симметрично
    // logistics-блоку ниже (там уже есть `if (platform !== "ozon")`). Раньше
    // WB-ad блок был БЕЗ гарда → при platform=ozon к totals.profit вычиталась
    // ВСЯ WB-реклама (≈81к на cabinet #1) → profit показывал ≈−45к вместо
    // реальных +1.8к. Баг: +36к (profitClean) − 81к (WB ad) = −45 651.
    if (platform !== "ozon") {
      try {
        const wbad = await new DatabaseSync("wb", {readOnly:true}).prepare(
          `SELECT (SELECT COALESCE(SUM(ad_spend),0) FROM daily_metrics
                   WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL) AS s`
        ).get(from, toEnd);
        fullAd += (wbad && wbad.s) || 0;
      } catch (e) { console.error('[products-summary] WB ad пересчёт:', e.message); }
    }
    if (platform !== "wb") {
      try {
        // ⚠️ 2026-08-02: было — реклама Ozon существовала только «кабинет×день»
        // (ozon_daily_efficiency; per-SKU daily_metrics.ad_spend ПУСТ, до
        // фикса 6046d36 расход не собирался вовсе — прибыль завышалась).
        // С 2026-08-22 per-SKU расход реально заполняется (tenant.ozon_daily_
        // sku_ad, миграция 043, план «реклама Ozon по товарам») и уже вычтен
        // внутри item.profit — здесь по-прежнему вычитаем кабинетный fullAd
        // из totals, но только НЕРАСПРЕДЕЛЁННЫЙ остаток (см. коммент блока
        // выше), не всю сумму. date — DATE, сравниваем с 'YYYY-MM-DD'.
        const ozad = await new DatabaseSync("ozon", {readOnly:true}).prepare(
          `SELECT (SELECT COALESCE(SUM(ad_spend),0) FROM ozon_daily_efficiency
                   WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL) AS s`
        ).get(from, to);
        fullAd += (ozad && ozad.s) || 0;
      } catch (e) { console.error('[products-summary] Ozon ad пересчёт:', e.message); }
    }
    // Σ item.adSpend ДО перезаписи totals.adSpend кабинетной суммой ниже —
    // нужна, чтобы довычесть только нераспределённый остаток (см. коммент
    // блока выше), а не всю fullAd целиком.
    const sumItemAd = totals.adSpend;
    totals.adSpend = round2(fullAd);
    // item.profit (канон) ТЕПЕРЬ включает рекламу товара — довычитаем
    // только нераспределённую часть кабинетной рекламы (fullAd − Σ item.
    // adSpend), чтобы totals.profit = pnl.profit (товарная часть).
    unallocatedAds = Math.max(0, round2(fullAd - sumItemAd));
    totals.profit = round2((totals.profit || 0) - unallocatedAds);
    if (totals.salesRub) totals.margin = round2(100 * totals.profit / totals.salesRub);
    // totals.adSpend только что перезаписан ПОЛНОЙ кабинетной рекламой (fullAd,
    // строка выше) — пересчитываем drr/drrSales на неё же (решение владельца
    // 08.09.2026), иначе они остались бы посчитаны на Σ item.adSpend из aggTotals.
    totals.drr = totals.adSpend && totals.orderRub ? round2(100 * totals.adSpend / totals.orderRub) : null;
    totals.drrSales = totals.adSpend && totals.salesRub ? round2(100 * totals.adSpend / totals.salesRub) : null;
  }

  return { items, totals, unallocatedAds };
}

// ---------- WB ----------
export async function collectWB(from, toEnd, shopName, taxMode) {
  const db = new DatabaseSync("wb", {readOnly:true});
  // Дней в периоде — для среднедневных показателей.
  const days = Math.max(1, Math.round((new Date(toEnd.slice(0, 10)) - new Date(from)) / 86400000) + 1);

  // 1) Штуки из order_costs (продажи/возвраты по srid) + идентификация (articles/orders).
  const rows = await db.prepare(
    `SELECT
       oc.nm_id                AS nm,
       MAX(o.barcode)          AS barcode,
       MAX(o.category)         AS cat,
       MAX(a.name)             AS name,
       MAX(a.brand)            AS brand,
       MAX(a.subject)          AS grp,
       MAX(a.im_url)           AS im_url,
       MAX(o.supplier_article) AS sa,
       -- штуки
       SUM(CASE WHEN oc.is_return=0 AND oc.sale_dt>=? AND oc.sale_dt<=? THEN 1 ELSE 0 END) AS sold,
       SUM(CASE WHEN oc.is_return=1 AND oc.return_dt>=? AND oc.return_dt<=? THEN 1 ELSE 0 END) AS returns,
       SUM(CASE WHEN oc.sale_dt>=? AND oc.sale_dt<=? THEN oc.self_buyout ELSE 0 END) AS selfBuyout
     FROM order_costs oc
     LEFT JOIN orders o   ON o.srid = oc.srid
     LEFT JOIN articles a ON a.nm_id = oc.nm_id
     WHERE oc.nm_id IS NOT NULL
     GROUP BY oc.nm_id`
  ).all(from, toEnd, from, toEnd, from, toEnd);

  // 1б) ДЕНЬГИ — КАНОН (wbProfitProduct, задача 5 плана унификации прибыли),
  // вызывается НИЖЕ по каждому nm (в цикле сборки). orderRub (сумма ЗАКАЗОВ)
  // считаем НЕ отсюда, а из orders.price_with_disc — см. блок 2. Заказы из
  // orders включают отмены → дают честную «сумму заказов». toEnd =
  // "YYYY-MM-DDT23:59:59" — именно с "T", а не с пробелом: сравнение с sale_dt
  // текстовое, а sale_dt хранится в ISO-виде ("YYYY-MM-DDThh:mm:ss"), и по
  // лексикографике "T" (0x54) > любой цифры — с пробелом (0x20 < цифр) граница
  // отрезала бы весь последний день. Канон (lib) ждёт дату БЕЗ времени —
  // ему передаём toEnd.slice(0, 10).

  // 2) Заказано/отмен по orders + сумма ЗАКАЗОВ (orderRub = SUM(price_with_disc)
  // по всем заказам, включая отмены — это честная «сумма заказов», отличная от
  // salesRub по продажам). Своей агрегацией: order_costs не хранит отмены.
  const ord = {};
  for (const r of await db.prepare(
    `SELECT nm_id,
       COUNT(*) AS ordered,
       SUM(CASE WHEN is_cancel=1 THEN 1 ELSE 0 END) AS cancelled,
       SUM(price_with_disc) AS orderRub
     FROM orders
     WHERE order_dt>=? AND order_dt<=? AND nm_id IS NOT NULL
     GROUP BY nm_id`
  ).all(from, toEnd)) {
    ord[r.nm_id] = {
      ordered: r.ordered, cancelled: r.cancelled,
      orderRub: r.orderRub || 0,
    };
  }

  // 3) Реклама за период по SKU — единый канон (lib/wbMetrics.js).
  const ad = await wbAdTotal(db, { from, to: toEnd.slice(0, 10), groupByNm: true });

  // 3а) СВЕЖИЕ продажи из sales — блок УДАЛЁН (спека «WB: выручка по цене со
  // скидкой», 2026-09-06). Штуки «Продано» теперь берутся из ТОГО ЖЕ
  // источника, что и деньги — order_costs (блок 1, sold по sale_dt): лента
  // sales отставала/опережала order_costs по своей датировке, из-за чего
  // «Продано, шт» не билось с «Выручкой» той же строки. Один источник —
  // одна правда.

  // 3б) Хранение (storage_fee) НЕ включаем в profitClean: у WB оно идёт с nm_id=0
  // и не привязано к товару (контракт №27). Размазывать по SKU = искажать маржу.
  // Эти суммы показываются ОТДЕЛЬНО — в плитке «Кабинетные расходы» (роут /api/cabinet-costs),
  // без разнесения по товарам. См. закрытие follow-up №27.2 (AGENTS.md §6.5).

  // 4) Остатки: средний за период + на последнюю дату периода.
  //    Канон остатка — «доступно» (wb_daily_stock.quantity, как /stocks и Ozon
  //    fbo_present − fbo_reserved), НЕ quantity_full (тот включает «в пути» к/от
  //    клиента) — решение владельца 15.10.2026.
  const stockAvg = {};
  const stockEnd = {};
  const stockRows = await db.prepare(
    `SELECT nm_id, date, SUM(quantity) AS q
     FROM daily_stock WHERE date>=? AND date<=?
     GROUP BY nm_id, date`
  ).all(from, toEnd);
  const byNm = {};
  for (const r of stockRows) {
    if (!byNm[r.nm_id]) byNm[r.nm_id] = [];
    byNm[r.nm_id].push({ date: r.date, q: r.q || 0 });
  }
  for (const [nm, arr] of Object.entries(byNm)) {
    const sorted = arr.sort((a, b) => a.date.localeCompare(b.date));
    const avg = sorted.reduce((s, x) => s + x.q, 0) / Math.max(1, sorted.length);
    stockAvg[nm] = avg;
    stockEnd[nm] = sorted[sorted.length - 1].q;
  }

  // 5) Себестоимость единицы (для налога-базы это не нужно, но храним).
  //    Единый источник — tenant.cost_overrides (с 2026-07-14): актуальный override
  //    на сегодня = последний с effective_from <= current_date. DISTINCT ON убирает
  //    дубли по nm_id, оставляя самую свежую запись.
  const unitCost = {};
  for (const r of await db.prepare(
    `SELECT DISTINCT ON (nm_id) nm_id, cost FROM tenant.cost_overrides
     WHERE platform = 'wb' AND effective_from <= current_date
     ORDER BY nm_id, effective_from DESC`
  ).all()) {
    unitCost[r.nm_id] = r.cost > 0 ? r.cost : null;
  }

  // Объединяем. Товар попадает в выдачу, если у него есть order_costs (продажа/возврат)
  // ИЛИ заказы за период — чтобы видеть все активные SKU (лента sales как
  // третий источник убрана вместе с блоком 3а).
  // Финансовые поля-заглушки не нужны: деньги для КАЖДОЙ строки (включая
  // добавленные здесь) считаются каноном ниже, по nm — см. цикл сборки.
  const seen = new Set(rows.map((r) => r.nm));
  const addStub = (key) => {
    if (!seen.has(key)) {
      rows.push({
        nm: key, barcode: null, cat: null, name: null, brand: null, grp: null, im_url: null, sa: null,
        sold: 0, returns: 0, selfBuyout: 0,
      });
      seen.add(key);
    }
  };
  for (const nmRaw of Object.keys(ord)) addStub(Number(nmRaw));

  // Деньги — КАНОН (wbProfitProduct, задача 5 плана унификации прибыли), по
  // товару. adSpend — РЕАЛЬНЫЙ per-SKU расход (данные у WB есть физически,
  // wbAdTotal groupByNm) — с 2026-08-22 canon.ads при nmId тоже РЕАЛЬНЫЙ
  // расход, не 0 (план «реклама Ozon по товарам», задача 6/7, симметрично
  // Ozon, см. докстроку wbProfitProduct), profit его теперь вычитает.
  // Один batch-вызов на ВЕСЬ каталог вместо 2×N скалярных (задача 3 плана
  // «канон волна 2») — SQL-число теперь не растёт с числом товаров.
  // % выкупа — КАНОН lib/buyout.js (спека 2026-10-11): когорта заказов окна по дате
  // заказа, судьба каждого srid. Одна цифра со страницей «Процент выкупа».
  const asOf = todayMsk(); // МСК, не UTC сервера — заказы датированы МСК (фикс 2026-10-12)
  const buyoutByNm = new Map(
    aggregateBuyout(await loadWbBuyoutRows(from, toEnd.slice(0, 10)), asOf).items.map((b) => [b.nmId, b])
  );
  const profitBatch = await wbProfitProductBatch(db, taxMode, { from, to: toEnd.slice(0, 10) });
  const out = [];
  for (const r of rows) {
    const nm = r.nm;
    const o = ord[nm] || { ordered: 0, cancelled: 0, orderRub: 0 };
    // Штуки «Продано» — из order_costs (блок 1), ТОТ ЖЕ источник, что деньги
    // строки (f.revenue). Прежний fallback на ленту sales удалён (спека
    // 2026-09-06): два источника с разной датировкой расходились.
    const sold = r.sold || 0;
    const f = profitBatch.get(nm) || ZERO_PROFIT;
    // orderRub — сумма ЗАКАЗОВ из orders.price_with_disc (блок 2), НЕ канон.
    const orderRub = o.orderRub || 0;
    const avgStock = stockAvg[nm] ?? 0;
    const avgDailySales = sold / days;
    // ⚠️ returns НЕ прибавляем к sold: возвращённый товар УЖЕ входит в sold
    // (это была отгрузка с price>0, потом её сторнировали возвратом).
    // Прибавить returns = двойной счёт того же srid.
    const returns = r.returns || 0;
    const cancelled = o.cancelled || 0;
    // инвариант ordered ≥ sold верен за всё время, не внутри окна (продажи
    // периода по заказам прошлого периода) — фикс 06.09
    const ordered = o.ordered || 0;
    const adSp = ad[nm] || 0;
    out.push({
      nm, sa: r.sa || String(nm), barcode: r.barcode || null,
      name: r.name || r.sa || String(nm), brand: r.brand || "", grp: r.grp || "",
      cat: r.cat || "", im_url: r.im_url || null, platform: "wb", shop: shopName,
      ordered, cancelled,
      sold, returns, selfBuyout: r.selfBuyout || 0,
      buyoutSold: buyoutByNm.get(Number(nm))?.sold || 0,
      buyoutResolved: buyoutByNm.get(Number(nm))?.resolved || 0,
      orderRub: round2(orderRub), salesRub: f.revenue,
      // «Три цены» канона (спека 2026-09-06): salesRub = продажи по цене со
      // скидкой продавца, spp = скидка WB, realized = заплатил покупатель,
      // payout = к перечислению. commission — нетто-вознаграждение WB (вычет).
      spp: f.spp, realized: f.realized, payout: f.payout,
      costRub: f.cogs,
      commission: f.commission, logistics: f.logistics, acquiring: f.acquiring, loyalty: f.loyalty,
      // returnLogistics — СПРАВОЧНАЯ строка канона (уже внутри logistics
      // выше, не вычитается повторно — см. докстроку wbProfitProduct).
      returnLogistics: f.returnLogistics,
      adSpend: round2(adSp),
      tax: f.tax, profit: f.profit,
      profitGross: f.profitGross, // валовая (до рекламы/налога) — канон wbProfitProductBatch; для «Дашборда показателей»
      stock: stockEnd[nm] ?? 0, avgStock: round2(avgStock), avgDailySales: round2(avgDailySales),
      unitCost: unitCost[nm] ?? null,
    });
  }
  return out;
}

// ---------- Ozon ----------
export async function collectOzon(from, toEnd, shopName, taxMode) {
  const db = new DatabaseSync("ozon", {readOnly:true});
  const to = toEnd.slice(0, 10); // канон (ozProfitProduct) ждёт даты без времени
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const rows = await db.prepare(
    `SELECT
       oc.product_id           AS nm,
       MAX(p.barcode)          AS barcode,
       MAX(p.name)             AS name,
       MAX(p.brand)            AS brand,
       MAX(p.category)         AS grp,
       MAX(p.im_url)           AS im_url,
       MAX(p.offer_id)         AS sa,
       -- ⚠️ ФИКС 2026-06-25 (грабля #134): у Ozon order_costs = ЕДИНСТВЕННЫЙ достоверный
       -- источник по фактическим продажам. Таблица sales содержит ТОЛЬКО отмены/
       -- возвраты (delivered-продажи туда НЕ попадают), orders — только последние
       -- ~2 недели. Раньше дашборд брал sold/salesRub из sales → получал 0/мизер и
       -- радикально занижал картину (sold=14 vs реальных 128, salesRub=47k vs 454k,
       -- profit=+4k vs реальных −20k). Теперь sold/returns/profit/компоненты → ВСЁ
       -- из order_costs, единая дата через COALESCE(sale_dt, return_dt) (фикс в
       -- efficiency.py, грабля #131): 52 возврата с NULL sale_dt учитываются в
       -- правильном месяце (по return_dt), а не теряются.
       SUM(CASE WHEN oc.is_return=0 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN 1 ELSE 0 END) AS sold,
       SUM(CASE WHEN oc.is_return=1 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN 1 ELSE 0 END) AS returns,
       SUM(CASE WHEN substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.self_buyout ELSE 0 END) AS selfBuyout,
       -- orderRub убран из этого запроса (считается отдельно из orders — симметрично
       -- WB, см. ниже). Раньше здесь был SUM(cost_value_retail) для is_return=0, что
       -- давало orderRub==salesRub — визуально нелогично (заказы=продажи). Грабля #137.
       SUM(CASE WHEN oc.is_return=0 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.cost_value_retail ELSE 0 END) AS salesRub,
       SUM(CASE WHEN oc.is_return=0 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.cost            ELSE 0 END) AS costRub,
       SUM(CASE WHEN oc.is_return=0 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.commission      ELSE 0 END) AS commission,
       SUM(CASE WHEN oc.is_return=0 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.logistics       ELSE 0 END) AS logistics,
       SUM(CASE WHEN oc.is_return=0 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.acquiring       ELSE 0 END) AS acquiring,
       SUM(CASE WHEN oc.is_return=0 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.loyalty         ELSE 0 END) AS loyalty,
       -- ⚠️ ФИКС 2026-07-23: возвратные убытки. Трактовка хозяина: себестоимость
       -- возвращённого товара НЕ списываем (он физически вернулся на склад), но
       -- логистика возврата + комиссия Ozon за возврат — это реальный расход,
       -- который ДОЛЖЕН входить в profit. Раньше возвраты (is_return=1) вообще
       -- не учитывались → на cabinet #1 ~34к (логистика 24к + комиссия 10к за 30д)
       -- «исчезали», а profit был завышен и минус на worst-товарах был необъясним.
       SUM(CASE WHEN oc.is_return=1 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.logistics       ELSE 0 END) AS rLogistics,
       SUM(CASE WHEN oc.is_return=1 AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.commission      ELSE 0 END) AS rCommission,
       SUM(CASE WHEN substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.profit ELSE 0 END) AS profit
     FROM order_costs oc
     LEFT JOIN products p ON p.product_id = oc.product_id
     WHERE oc.product_id IS NOT NULL
       AND COALESCE(oc.sale_dt, oc.return_dt) IS NOT NULL
     GROUP BY oc.product_id`
  ).all(from, toEnd, from, toEnd,          // sold, returns
        from, toEnd,                       // selfBuyout
        from, toEnd,                       // salesRub
        from, toEnd,                       // costRub
        from, toEnd, from, toEnd, from, toEnd, from, toEnd,  // commission, logistics, acquiring, loyalty
        from, toEnd,                       // rLogistics
        from, toEnd,                       // rCommission
        from, toEnd);                      // profit

  // ⚠️ ФИКС 2026-06-25 (грабля #137): orderRub (сумма ЗАКАЗОВ) для Ozon считаем из
  // таблицы `orders` — симметрично WB (где orderRub = SUM(price_with_disc) из orders).
  // Раньше здесь была заглушка ord={}, и orderRub брали из order_costs.cost_value_retail
  // — это давало orderRub==salesRub (визуально нелогично: «заказы=продажи»).
  //
  // ОГРАНИЧЕНИЕ (важно для интерпретации): у Ozon таблица `orders` содержит только
  // последние ~2 недели (живые отправления в обработке). Поэтому orderRub за полный
  // месяц будет НИЖЕ реальности — он отражает только те заказы, что ещё видит API.
  // Это симметрично WB, где orderRub тоже может быть неполным для самых свежих дней.
  // salesRub же (из order_costs/finance_report) — полный и достоверный.
  //
  // Считаем orderRub = SUM(price * qty) из orders по order_dt. У Ozon цена хранится
  // в `price` (за единицу), `qty` — количество. Не все строки имеют order_dt в
  // периоде — фильтруем по substr(order_dt,1,10).
  // «Заказано» (решение владельца 14.10.2026): ВСЕ заказы, включая отменённые, в штуках —
  // как у WB выше (COUNT(*) без фильтра) и на «Матрице заказов» (ozOrdersAllByDay). До
  // 14.10 у Ozon было «без отмен и в отправлениях» — та же колонка на двух площадках
  // значила разное; orderRub и avgCheck = orderRub/ordered теперь на одной базе.
  const ord = {};
  for (const r of await db.prepare(
    `SELECT product_id,
            SUM(COALESCE(qty,1)) AS ordered,
            SUM(CASE WHEN is_cancel=1 THEN COALESCE(qty,1) ELSE 0 END) AS cancelled,
            SUM(price * qty) AS orderRub
     FROM orders
     WHERE substr(order_dt,1,10)>=? AND substr(order_dt,1,10)<=?
       AND product_id IS NOT NULL
     GROUP BY product_id`
  ).all(from, toEnd)) {
    ord[r.product_id] = { ordered: r.ordered || 0, cancelled: r.cancelled || 0, orderRub: r.orderRub || 0 };
  }

  const ad = {};
  for (const r of await db.prepare(
    `SELECT product_id, COALESCE(SUM(ad_spend),0) AS s
     FROM daily_metrics WHERE date>=? AND date<=? AND ad_spend IS NOT NULL
     GROUP BY product_id`
  ).all(from, toEnd)) {
    ad[r.product_id] = r.s;
  }

  // ⚠️ ФИКС 2026-06-25 (грабля #134): блок `freshOz` из таблицы sales УБРАН. У Ozon
  // sales содержит ТОЛЬКО отмены/возвраты (delivered-продажи туда НЕ попадают — они
  // идут в order_costs). Использование sales как первоисточника sold/salesRub давало
  // 0/мизер и маскировало реальные продажи. Теперь sold/returns/salesRub/profit берутся
  // напрямую из order_costs (в SQL-запросе выше, через COALESCE(sale_dt,return_dt)).
  // См. /api/agent/chat/route.js note: «sales — май (отмены); order_costs — продажи».

  // Хранение/услуги (services_amount у Ozon: удержание, отрицательное) НЕ включаем
  // в profitClean: по SKU не привязано (№27). Показываются отдельно в плитке
  // «Кабинетные расходы» (роут /api/cabinet-costs). См. follow-up №27.2.

  const stockAvg = {}, stockEnd = {}, stockDate = {};
  // ⚠️ ФИКС 2026-06-25 (грабля #139): остаток у Ozon = СНАПШОТ «по состоянию на <дату>»,
  // а не диапазон. Решение владельца: показывать ПОСЛЕДНИЙ доступный снимок ВСЕГДА
  // (даже для периода «май»), с пометкой даты снимка. У Ozon API не отдаёт историю —
  // сейчас только 1 снимок (25.06 после фикса #135 убрал ложные нули). Через неделю
  // накопится 7 дней, и для недавних периодов дата снимка будет близка к концу периода.
  // stockEnd = MAX(date) без ограничения по toEnd. stockDate = дата этого снимка.
  // stockAvg остаётся средним по доступным дням в диапазоне [from, to] (для оборачиваемости).
  const endRows = await db.prepare(
    `SELECT ds.product_id, SUM(ds.fbo_present - ds.fbo_reserved) AS q, MAX(ds.date) AS d
     FROM daily_stock ds
     INNER JOIN (
       SELECT product_id, MAX(date) AS d FROM daily_stock GROUP BY product_id
     ) m ON ds.product_id = m.product_id AND ds.date = m.d
     GROUP BY ds.product_id`
  ).all();
  let lastSnapshotDate = null;
  for (const r of endRows) {
    stockEnd[r.product_id] = r.q || 0;
    if (r.d && (!lastSnapshotDate || r.d > lastSnapshotDate)) lastSnapshotDate = r.d;
  }
  // stockAvg: среднее по доступным дням в диапазоне [from, toEnd] (для оборачиваемости).
  const stockAvgRows = await db.prepare(
    `SELECT product_id, date, SUM(fbo_present - fbo_reserved) AS q
     FROM daily_stock WHERE date>=? AND date<=?
     GROUP BY product_id, date`
  ).all(from, toEnd);
  const byNm = {};
  for (const r of stockAvgRows) {
    const k = r.product_id;
    if (!byNm[k]) byNm[k] = [];
    byNm[k].push({ date: r.date, q: r.q || 0 });
  }
  for (const [nm, arr] of Object.entries(byNm)) {
    const sorted = arr.sort((a, b) => a.date.localeCompare(b.date));
    const avg = sorted.reduce((s, x) => s + x.q, 0) / Math.max(1, sorted.length);
    stockAvg[nm] = avg;
  }
  // Дата снимка (одинакова для всех товаров — последний прогон stocks.py).
  if (lastSnapshotDate) stockDate._ozon = lastSnapshotDate;

  // Единый источник себестоимости — tenant.cost_overrides (с 2026-07-14):
  // актуальный override на сегодня = последний с effective_from <= current_date.
  // DISTINCT ON убирает дубли по product_id, оставляя самую свежую запись.
  const unitCost = {};
  for (const r of await db.prepare(
    `SELECT DISTINCT ON (product_id) product_id, cost FROM tenant.cost_overrides
     WHERE platform = 'ozon' AND effective_from <= current_date
     ORDER BY product_id, effective_from DESC`
  ).all()) {
    unitCost[r.product_id] = r.cost > 0 ? r.cost : null;
  }

  // ⚠️ ФИКС 2026-07-23: добавляем ВСЕ товары из ozon_products (симметрично WB
  // addStub в collectWB). Раньше список собирался только из order_costs → 43 из 88
  // артикулов (без продаж в периоде) были невидимы в Сводке. Теперь каждый товар
  // из products попадает в выдачу, даже с нулями (как на WB).
  const seen = new Set(rows.map((r) => r.nm));
  try {
    for (const r of await db.prepare(
      `SELECT product_id AS nm, barcode, name, brand, category AS grp, im_url, offer_id AS sa
       FROM products`
    ).all()) {
      if (!seen.has(r.nm)) {
        rows.push({
          nm: r.nm, barcode: r.barcode || null, name: r.name || null,
          brand: r.brand || null, grp: r.grp || null, im_url: r.im_url || null, sa: r.sa || null,
          sold: 0, returns: 0, selfBuyout: 0,
        });
        seen.add(r.nm);
      }
    }
  } catch (e) { console.error('[products-summary] Ozon products addStub:', e.message); }

  // Деньги — КАНОН (ozProfitProduct, задача 5 плана унификации прибыли), по
  // товару (SUM(order_costs.profit) БЕЗ фильтра is_return — возвраты внутри,
  // возвратный убыток УЖЕ в returnLogistics/logistics/commission, см.
  // докстроку ozProfitProduct). adSpend — daily_metrics.ad_spend по SKU
  // (с 2026-08-22 реально заполняется, tenant.ozon_daily_sku_ad, миграция
  // 043, план «реклама Ozon по товарам») остаётся информационной колонкой
  // ДЛЯ ДРР/ROI витрины, но с 2026-08-21/22 canon.ads при productId — РЕАЛЬНЫЙ
  // расход (не 0), profit его теперь вычитает.
  // Один batch-вызов на ВЕСЬ каталог вместо 2×N скалярных (задача 3 плана
  // «канон волна 2») — SQL-число теперь не растёт с числом товаров.
  const profitBatch = await ozProfitProductBatch(db, taxMode, { from, to });
  // % выкупа Ozon — КАНОН lib/buyout.js (ведро на отправление, утверждён владельцем
  // 12.10.2026, задача 4 плана): та же когорта и формула, что на странице «Процент
  // выкупа», а не отдельное смешение популяций.
  const asOf = todayMsk();
  const ozBuyoutByPid = new Map(
    aggregateBuyout(await loadOzonBuyoutRows(from, to), asOf).items.map((b) => [b.nmId, b])
  );
  const out = [];
  for (const r of rows) {
    const nm = r.nm;
    const sold = r.sold || 0;
    const returns = r.returns || 0;
    const f = profitBatch.get(nm) || ZERO_PROFIT;
    const adSp = ad[nm] || 0;
    const avgStock = stockAvg[nm] ?? 0;
    const avgDailySales = sold / days;
    // profitGross — из канона (ozProfitProduct.profitGross), задача 2 плана
    // «канон волна 2»; локальная формула-дубль удалена.
    const profitGross = f.profitGross;
    // orderRub и ordered/cancelled — из таблицы orders (фикс #137). orderRub = сумма
    // ЗАКАЗОВ (симметрично WB), НЕ равен salesRub (который из order_costs = доставки).
    // Ограничение: у Ozon orders покрывают только последние ~2 недели — orderRub за
    // полный месяц будет неполным. ordered = реальные заказы из orders.
    const o = ord[nm] || { ordered: 0, cancelled: 0, orderRub: 0 };
    out.push({
      nm, sa: r.sa || String(nm), barcode: r.barcode || null,
      name: r.name || r.sa || String(nm), brand: r.brand || "", grp: r.grp || "",
      // cat = grp (p.category) для Ozon: каталог у нас одноуровневый (нет
      // отдельной иерархии категория/группа, как o.category/a.subject у WB).
      // Раньше cat всегда был "" → фильтр «Категория» на Сводке пустовал
      // для Ozon (owner-жалоба). Честно отражаем структуру: категория=группа.
      cat: r.grp || "", im_url: r.im_url || null, platform: "ozon", shop: shopName,
      ordered: o.ordered, cancelled: o.cancelled,
      sold, returns, selfBuyout: r.selfBuyout || 0,
      buyoutSold: ozBuyoutByPid.get(Number(nm))?.sold || 0,
      buyoutResolved: ozBuyoutByPid.get(Number(nm))?.resolved || 0,
      orderRub: round2(o.orderRub), salesRub: f.revenue,
      // Симметрия формы с WB (lib/ozonMetrics.js:ozNetForm): spp = 0 (СПП у
      // Ozon нет), realized = revenue, payout = revenue − commission −
      // services − acquiring − loyalty.
      spp: f.spp, realized: f.realized, payout: f.payout,
      costRub: f.cogs,
      commission: f.commission, logistics: f.logistics, acquiring: f.acquiring, loyalty: f.loyalty,
      // services («Сборы Ozon», задача 4 плана «Сборы Ozon») — отзывы,
      // рассрочка, упаковка, размещение, утилизация и прочие позаказные
      // сборы; из канона (ozProfitProductBatch → ...agg), рядом с logistics.
      services: f.services,
      // returnLogistics — СПРАВОЧНАЯ строка канона (уже внутри logistics/
      // commission выше, не вычитается повторно — см. докстроку ozProfitProduct).
      returnLogistics: f.returnLogistics,
      adSpend: round2(adSp),
      tax: f.tax, profit: f.profit, profitGross,
      stock: stockEnd[nm] ?? 0, avgStock: round2(avgStock), avgDailySales: round2(avgDailySales),
      stockDate: stockDate._ozon || null, // дата снимка остатков Ozon (грабля #139)
      unitCost: unitCost[nm] ?? null,
    });
  }
  return out;
}
