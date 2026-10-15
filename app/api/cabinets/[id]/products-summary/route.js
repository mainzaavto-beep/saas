import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { NextResponse } from "next/server";
import { wbRawProfitCabinetByDay, WB_COST_INFO_ONLY } from "@/lib/wbMetrics.js";
import { ozRawProfitCabinetByDay } from "@/lib/ozonMetrics.js";
import { statusMap } from "@/lib/finItems.js";
import { defaultPeriod } from "@/lib/period.js";
import { buildTotals, round2, shiftDateUTC } from "@/lib/productsSummaryData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
//  /api/products-summary — сводка по товарам (WB+Ozon) в стиле Mpassistant.
//
//  Агрегирует по каждому товару за период:
//    • штуки: заказано / продано / отмен / возвраты / самовыкупы / %выкупа
//    • деньги: выручка / себест. / комиссия / логистика / эквайринг /
//              лояльность / налог / прибыль / маржа (из order_costs)
//    • эффективность: ROI / ДРР / ROMI / CPA / оборачиваемость / остаток
//
//  Источники:
//    order_costs  — основа (profit+компоненты по каждому заказу, заявка №23/№24)
//    orders       — штуки заказано/отмен, склад/регион/баркод/размер
//    articles/products — имя/бренд/категория/фото
//    daily_metrics — ad_spend по SKU за период (для ДРР/CPA/ROMI)
//    daily_stock   — средний остаток и остаток на конец периода
//    cost_overrides — себестоимость единицы (единый источник, с 2026-07-14)
//
//  ⚠️ МЕТОДОЛОГИЯ: цифры считаются прозрачно из боевых БД по нашим формулам
//  (решение владельца) и МОГУТ расходиться с выгрузкой Mpassistant на 5–30%
//  из-за разной трактовки (окна данных, отношение к отменам, формула %выкупа).
// =====================================================================

const USN_RATE = 0.06; // legacy — не используется (налог через calcUsnTax из lib/tax.js)




export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const platform = url.searchParams.get("platform") || "all"; // all|wb|ozon
    const fromQ = url.searchParams.get("from") || "";           // YYYY-MM-DD
    const toQ = url.searchParams.get("to") || "";
    // ?includeInactive=1 — показать и inactive (по умолчанию фильтруется только active,
    // симметрично /api/unit/all). Но товары С продажами/возвратами за период показываются
    // ВСЕГДА (даже inactive) — чтобы не потерать свежие продажи снятого с продаж товара.
    const includeInactive = url.searchParams.get("includeInactive") === "1";

    // Дефолтный период: последние 30 дней от MAX(order_dt) по обеим БД.
    // Если MAX пустой (нет данных / RLS ничего не видит) — fallback на сегодня.
    let from = fromQ, to = toQ;
    if (!from || !to) {
      let maxDt = "";
      try { maxDt = (await new DatabaseSync("wb", {readOnly:true}).prepare("SELECT MAX(order_dt) AS m FROM orders").get())?.m || ""; } catch (e) { console.error("products-summary: MAX(order_dt) wb", e); }
      try { const oz = (await new DatabaseSync("ozon", {readOnly:true}).prepare("SELECT MAX(order_dt) AS m FROM orders").get())?.m || ""; if (oz > maxDt) maxDt = oz; } catch (e) { console.error("products-summary: MAX(order_dt) ozon", e); }
      if (maxDt) {
        if (!to) to = maxDt.slice(0, 10);
        if (!from) {
          const d = new Date(maxDt);
          d.setDate(d.getDate() - 29);
          from = d.toISOString().slice(0, 10);
        }
      } else {
        // Fallback: нет данных — последние 30 дней ПО ВЧЕРА (не пустая строка!).
        // Сегодня финансово недособрано (задача «дефолты по вчера», 2026-08-25).
        const def = defaultPeriod(30);
        if (!to) to = def.to;
        if (!from) from = def.from;
      }
    }
    const toEnd = to ? to + "T23:59:59" : "";

    // ⚠️ ФИЛЬТР СТАТУСА 2026-07-23 (симметрично /api/unit/all): показываем active-товары
    // (из products, fallback "active") ПЛЮС товары С продажами/возвратами за период
    // (даже inactive — чтобы не терять свежие продажи снятого с продаж товара). Раньше
    // addStub по products добавлял ВСЕ 88 ozon-артикулов, включая 34 inactive без продаж.
    // Статус не зависит от окна — считаем один раз, buildTotals переиспользует
    // и для текущего, и для prev-окна.
    const stat = await statusMap();

    // items+totals — ЕДИНЫЙ путь buildTotals (задача 1 плана «Сводка по
    // макету», 2026-08-25): та же последовательность (collect → фильтр
    // статуса → aggTotals → довычет нераспределённой рекламы), что раньше
    // жила прямо в GET, вынесена в функцию и переиспользуется ниже для
    // prevTotals — БЕЗ копирования тела.
    const { items, totals, unallocatedAds } = await buildTotals(cabinet, platform, from, to, includeInactive, stat);

    const days = from && to
      ? Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1)
      : 1;

    // Досчёт производных полей (нужны объединённые данные).
    for (const it of items) {
      it.buyoutPct = it.buyoutResolved > 0 ? round2(100 * it.buyoutSold / it.buyoutResolved) : null;
      it.avgOrdersDay = round2(it.ordered / days);
      it.avgCheck = it.ordered ? round2(it.orderRub / it.ordered) : null;
      it.commissionPct = it.salesRub ? round2(100 * Math.abs(it.commission) / it.salesRub) : null;
      it.avgProfit = it.sold ? round2(it.profit / it.sold) : null;
      it.margin = it.salesRub ? round2(100 * it.profit / it.salesRub) : null;
      it.roi = it.costRub ? round2(100 * it.profit / it.costRub) : null;
      // ДРР (решение владельца 08.09.2026): реклама приносит ЗАКАЗЫ, поэтому
      // основной ДРР = реклама ÷ сумма ЗАКАЗОВ (orderRub), не продаж — иначе
      // нельзя понять расход на заказы, которые реклама реально принесла.
      // drrSales (от продаж, salesRub) — вторая, отдельная цифра, контракт
      // §15.3. Тон пилла в UI (SummaryPage.jsx::drrPillTone) сравнивает
      // drrSales с margin (обе на одной базе — % от salesRub), а показывает drr.
      it.drr = it.adSpend && it.orderRub ? round2(100 * it.adSpend / it.orderRub) : null;
      it.drrSales = it.adSpend && it.salesRub ? round2(100 * it.adSpend / it.salesRub) : null;
      it.cpa = it.adSpend && it.sold ? round2(it.adSpend / it.sold) : null;
      it.romi = it.adSpend ? round2(100 * it.profit / it.adSpend) : null;
      it.turnoverDays = it.avgDailySales > 0 ? Math.round(it.avgStock / it.avgDailySales) : null;
    }

    // Сортировка: по выручке вниз (топ-товары сверху).
    items.sort((a, b) => (b.salesRub || 0) - (a.salesRub || 0));

    // totals уже посчитан buildTotals (канон ads/profit top-up — см. докстроку
    // buildTotals ниже, перенесена туда без изменений вместе с блоком fullAd).

    // prevTotals — то же окно длиной N, СТРОГО тем же кодом (buildTotals),
    // стыком назад: prev_to = from−1, prev_from = prev_to−(N−1) (GC плана
    // «Сводка по макету», задача 1). N — длина текущего окна в днях.
    let prevTotals = null;
    let prevPeriod = null;
    if (from && to) {
      const N = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
      const prevTo = shiftDateUTC(from, -1);
      const prevFrom = shiftDateUTC(prevTo, -(N - 1));
      const prevBuild = await buildTotals(cabinet, platform, prevFrom, prevTo, includeInactive, stat);
      prevTotals = prevBuild.totals;
      prevPeriod = { from: prevFrom, to: prevTo };
    }

    // profitSpark — дневной ряд «rawProfit − реклама», ДО налога (задача 1
    // плана «Сводка по макету», 2026-08-25). Кабинетные by-day агрегаты —
    // ПЕРЕНОС SELECT'ов *RawProfitByDay БЕЗ product-фильтра (ozRawProfitCabinetByDay/
    // wbRawProfitCabinetByDay, lib/ozonMetrics.js, lib/wbMetrics.js). Реклама
    // по дням — ТЕ ЖЕ таблицы, что fullAd внутри buildTotals (WB: daily_metrics
    // GROUP BY date; Ozon: ozon_daily_efficiency, уже один ряд в день) —
    // те же слагаемые, что видит totals.adSpend (fullAd) и кабинетная
    // ozAdSpend(groupByProduct:false). Σ profitSpark по построению равна
    // (Σ rawProfit периода − Σ ads периода), сверенным ЭТИМИ ЖЕ helpers'ами
    // без GROUP BY (арифметическая сверка группировки с собой, приёмка
    // задачи 1 плана) — это НЕ независимая проверка против totals.profit
    // (тот канон — после-налоговый, с per-SKU рекламой внутри item.profit
    // и довычетом остатка, другая формула, контракт §15.2).
    // profit(день) = round2(rawWb(день) + rawOz(день) − ad(день)); дни без
    // движения = 0 (ряд идёт по ВСЕМ датам окна, не только по дням с активностью).
    let profitSpark = [];
    if (from && to) {
      const wbByDay = platform !== "ozon"
        ? await wbRawProfitCabinetByDay(new DatabaseSync("wb", {readOnly:true}), { from, to })
        : new Map();
      const ozByDay = platform !== "wb"
        ? await ozRawProfitCabinetByDay(new DatabaseSync("ozon", {readOnly:true}), { from, to })
        : new Map();

      const adByDay = new Map();
      if (platform !== "ozon") {
        try {
          const rows = await new DatabaseSync("wb", {readOnly:true}).prepare(
            `SELECT date::text AS d, COALESCE(SUM(ad_spend),0) AS s
             FROM daily_metrics WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL
             GROUP BY date`
          ).all(from, toEnd);
          for (const r of rows) adByDay.set(r.d, (adByDay.get(r.d) || 0) + (r.s || 0));
        } catch (e) { console.error('[products-summary] WB ad по дням:', e.message); }
      }
      if (platform !== "wb") {
        try {
          const rows = await new DatabaseSync("ozon", {readOnly:true}).prepare(
            `SELECT date::text AS d, COALESCE(SUM(ad_spend),0) AS s
             FROM ozon_daily_efficiency WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL
             GROUP BY date`
          ).all(from, to);
          for (const r of rows) adByDay.set(r.d, (adByDay.get(r.d) || 0) + (r.s || 0));
        } catch (e) { console.error('[products-summary] Ozon ad по дням:', e.message); }
      }

      const N = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
      for (let i = 0; i < N; i++) {
        const d = shiftDateUTC(from, i);
        const rawWb = wbByDay.get(d)?.rawProfit || 0;
        const rawOz = ozByDay.get(d)?.rawProfit || 0;
        const adDay = adByDay.get(d) || 0;
        profitSpark.push({ date: d, profit: round2(rawWb + rawOz - adDay) });
      }
    }

    // unallocated — «Не разнесено по товарам» (задача 8 плана «geo-canon-
    // vitrina», обещание владельцу 05.09: увидел «−16 663» в итогах при
    // плюсовых строках без объяснения — это была реклама Ozon кабинета за
    // день, не разнесённая по товарам per-SKU отчётом, который отставал на
    // 2 дня из-за 429). Правило: расхождение «итог ≠ Σ строк» не молчит.
    //   ads — unallocatedAds из buildTotals (ЧИСЛО НЕ ПЕРЕСЧИТЫВАЕТСЯ,
    //     ровно тот же довычет, что уже уходил в totals.profit молча).
    //   cabinetCosts — Σ cabinetCosts.amount (канон-знак wbProfitCabinet/
    //     ozProfitCabinet), минимальный прямой запрос — полный вызов канона
    //     здесь избыточен (он бы ещё раз посчитал profitProduct(null) целиком
    //     только ради Σ amount).
    //   note — по сырым таблицам Ozon-рекламы (ozon_daily_campaign_ad,
    //     ozon_daily_sku_ad — НЕ daily_metrics/ozon_daily_efficiency, те уже
    //     пересчитанные агрегаты, лаг сборщика виден только в первоисточниках).
    const [cabinetCostsUnalloc, unallocNote] = from && to
      ? await Promise.all([
          unallocatedCabinetCosts(platform, from, to),
          ozonSkuAdLagNote(platform, from, to),
        ])
      : [0, null];

    return NextResponse.json({
      count: items.length,
      period: { from, to, days },
      totals,
      prevTotals,
      prevPeriod,
      profitSpark,
      unallocated: { ads: unallocatedAds || 0, cabinetCosts: cabinetCostsUnalloc, note: unallocNote },
      items,
      shops: { wb: cabinet.shop_names?.wb, ozon: cabinet.shop_names?.ozon },
      methodology: "Штуки и рубли — из финансовых строк маркетплейса (order_costs), а не из ежедневной ленты продаж: строка появляется, когда площадка отдала финансовые поля заказа, поэтому сегодня/вчера могут быть занижены примерно на сутки. Выручка WB — по цене со скидкой продавца (до СПП); «К перечислению» у Ozon — расчётно (выручка − вознаграждение − сборы − эквайринг − лояльность, без логистики). «Заказано» — из ленты заказов и считается по дате заказа, поэтому на коротком окне может быть меньше «Продано»: в периоде продаются заказы прошлых периодов; у Ozon лента заказов хранит только последние ~2 недели, за месяц сумма заказов занижена.",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});


// unallocatedCabinetCosts — Σ cabinetCosts.amount (кабинетные расходы №27,
// БЕЗ привязки к товару: хранение/удержание/подписка и пр.) за окно, тем же
// знаком-каноном, что wbProfitCabinet/ozProfitCabinet (lib/wbMetrics.js,
// lib/ozonMetrics.js) — расход<0, доход/возмещение>0. Минимальный ПРЯМОЙ
// запрос (не вызов wbProfitCabinet/ozProfitCabinet целиком): те функции
// сперва считают profitProduct(null) по ВСЕМУ кабинету — дорогая и здесь
// не нужная работа, если нужна только Σ amount по типам расходов. Источник
// для UI-секции «Кабинетные расходы» ниже на этой же странице (/api/cabinets/
// [id]/cabinet-costs) остаётся отдельным (даёт разбивку по типам) — здесь
// нужна только итоговая цифра для строки «Не разнесено по товарам» (задача 8
// плана «geo-canon-vitrina»).
async function unallocatedCabinetCosts(platform, from, to) {
  let sum = 0;
  if (platform !== "ozon") {
    try {
      const rows = await new DatabaseSync("wb", { readOnly: true }).prepare(
        `SELECT cost_type, COALESCE(SUM(amount),0) AS s FROM cabinet_costs
         WHERE period_from <= ? AND period_to >= ?
         GROUP BY cost_type`
      ).all(to, from);
      // WB amount — сырой знак (расход>0, возмещение<0); канон-знак = −amount
      // (см. wbProfitCabinet, lib/wbMetrics.js). Справочные статьи
      // (WB_COST_INFO_ONLY — оплата рекламы удержанием, уже учтена в рекламе
      // кампаний) в кабинетные не входят, как и в каноне (§19 контракта).
      for (const r of rows) {
        if (WB_COST_INFO_ONLY.has(r.cost_type)) continue;
        sum += -(Number(r.s) || 0);
      }
    } catch (e) { console.error('[products-summary] WB unallocatedCabinetCosts:', e.message); }
  }
  if (platform !== "wb") {
    try {
      const r = await new DatabaseSync("ozon", { readOnly: true }).prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM cabinet_costs
         WHERE date >= ? AND date <= ?`
      ).get(from, to);
      // Ozon amount уже канон-знак (расход<0, доход>0) — без инверсии
      // (см. ozProfitCabinet, lib/ozonMetrics.js).
      sum += (r && r.s) || 0;
    } catch (e) { console.error('[products-summary] Ozon unallocatedCabinetCosts:', e.message); }
  }
  return round2(sum);
}

// ozonSkuAdLagNote — сигнал «per-SKU реклама Ozon дозревает» (инцидент 05.09:
// владелец увидел «−16 663» в итогах без объяснения — это была реклама Ozon
// кабинета за 04.09, при этом ozon_daily_sku_ad (миграция 043) за тот день
// был ПУСТ из-за 429 у Performance API, хотя ozon_daily_campaign_ad
// (миграция 039, то же окно) уже показывал 16 662,95 ₽ расхода). Смотрим
// СЫРЫЕ таблицы напрямую, а не daily_metrics/ozon_daily_efficiency — те уже
// пересчитанные агрегаты (worker.db_pg.recompute_ozon_daily_ad), лаг
// сборщика виден только в первоисточниках. Последние 2 дня окна — по одному
// разу дня достаточно, чтобы поймать типичный лаг сборщика (1-2 дня).
async function ozonSkuAdLagNote(platform, from, to) {
  if (platform === "wb") return null; // Ozon-специфичный сигнал
  try {
    const d1 = shiftDateUTC(to, -1);
    const checkFrom = d1 < from ? from : d1; // не выходим за левую границу окна
    const db = new DatabaseSync("ozon", { readOnly: true });
    const rows = await db.prepare(
      `SELECT c.date AS d, COALESCE(c.spend,0) AS campaign_spend, COALESCE(s.sku_spend,0) AS sku_spend
       FROM (SELECT date, SUM(spend) AS spend FROM tenant.ozon_daily_campaign_ad
             WHERE date >= ? AND date <= ? GROUP BY date) c
       LEFT JOIN (SELECT date, SUM(spend) AS sku_spend FROM tenant.ozon_daily_sku_ad
             WHERE date >= ? AND date <= ? GROUP BY date) s ON s.date = c.date`
    ).all(checkFrom, to, checkFrom, to);
    const lagging = rows.some((r) => (r.campaign_spend || 0) > 0 && (r.sku_spend || 0) === 0);
    return lagging ? "per-SKU реклама Ozon дозревает" : null;
  } catch (e) {
    console.error('[products-summary] ozonSkuAdLagNote:', e.message);
    return null;
  }
}

