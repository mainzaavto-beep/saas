import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { NextResponse } from "next/server";
import { wbAdTotal, wbProfitProductBatch, wbRawProfitCabinetByDay } from "@/lib/wbMetrics.js";
import { ozProfitProductBatch, ozRawProfitCabinetByDay } from "@/lib/ozonMetrics.js";
import { normalizeTaxMode } from "@/lib/tax.js";
import { statusMap } from "@/lib/finItems.js";
import { ZERO_PROFIT } from "@/lib/profitForms.js";
import { defaultPeriod } from "@/lib/period.js";

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
    const { items, totals } = await buildTotals(cabinet, platform, from, to, includeInactive, stat);

    const days = from && to
      ? Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1)
      : 1;

    // Досчёт производных полей (нужны объединённые данные).
    for (const it of items) {
      it.buyoutPct = (it.sold + it.returns + it.cancelled) > 0
        ? round2(100 * it.sold / (it.sold + it.returns + it.cancelled)) : null;
      it.avgOrdersDay = round2(it.ordered / days);
      it.avgCheck = it.ordered ? round2(it.orderRub / it.ordered) : null;
      it.commissionPct = it.salesRub ? round2(100 * Math.abs(it.commission) / it.salesRub) : null;
      it.avgProfit = it.sold ? round2(it.profit / it.sold) : null;
      it.margin = it.salesRub ? round2(100 * it.profit / it.salesRub) : null;
      it.roi = it.costRub ? round2(100 * it.profit / it.costRub) : null;
      it.drr = it.adSpend && it.salesRub ? round2(100 * it.adSpend / it.salesRub) : null;
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
    // держит равенство Σ profitSpark ≈ totals-канон ads (сверяется приёмкой).
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

    return NextResponse.json({
      count: items.length,
      period: { from, to, days },
      totals,
      prevTotals,
      prevPeriod,
      profitSpark,
      items,
      shops: { wb: cabinet.shop_names?.wb, ozon: cabinet.shop_names?.ozon },
      methodology: "ОПЕРАТИВНЫЙ срез: штуки/выручка из ежедневных продаж (sales), расходы — по средним ставкам из order_costs. Возможно небольшое расхождение (≈5-10%) с финальным недельным финотчётом WB (там в «Сводке по прибыли»).",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});


function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

function aggTotals(items) {
  const t = {
    ordered: 0, sold: 0, cancelled: 0, returns: 0, selfBuyout: 0,
    orderRub: 0, salesRub: 0, costRub: 0, commission: 0, logistics: 0,
    acquiring: 0, loyalty: 0, tax: 0, profit: 0, adSpend: 0, stock: 0,
    returnLogistics: 0,
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
  }
  t.buyoutPct = (t.sold + t.returns + t.cancelled) > 0
    ? round2(100 * t.sold / (t.sold + t.returns + t.cancelled)) : null;
  t.margin = t.salesRub ? round2(100 * t.profit / t.salesRub) : null;
  t.avgCheck = t.ordered ? round2(t.orderRub / t.ordered) : null;
  return t;
}

// Сдвиг даты 'YYYY-MM-DD' на N дней в UTC (независимо от часового пояса
// сервера) — для prev-окна (задача 1 плана «Сводка по макету», 2026-08-25).
function shiftDateUTC(dateStr, deltaDays) {
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
async function buildTotals(cabinet, platform, from, to, includeInactive, stat) {
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
      // Товар с продажами/возвратами за период → показываем ВСЕГДА (независимо от статуса).
      // Товар без активности → только если active. Это сохраняет свежие продажи снятого
      // товара, но убирает inactive-мусор без продаж.
      const hasActivity = (it.sold || 0) + (it.returns || 0) > 0;
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
    totals.profit = round2((totals.profit || 0) - Math.max(0, round2(fullAd - sumItemAd)));
    if (totals.salesRub) totals.margin = round2(100 * totals.profit / totals.salesRub);
  }

  return { items, totals };
}

// ---------- WB ----------
async function collectWB(from, toEnd, shopName, taxMode) {
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
  // "YYYY-MM-DD 23:59:59"; lib ждёт дату без времени (добавляет сам).

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

  // 3а) СВЕЖИЕ продажи из sales — за весь период по sale_dt.
  // ⚠️ Грабля #98: WB шлёт возвраты в этой же таблице с is_realization=1, но
  // ОТРИЦАТЕЛЬНЫМ price_with_disc (напр. +4134 продажа, −4134 возврат тем же
  // srid). is_realization=1 НЕ отличает продажу от возврата — смотрим по знаку
  // суммы. sold = COUNT(price_with_disc>0) — чистые отгрузки; возвраты в этом
  // счётчике НЕ участвуют (они показываются отдельно колонкой «Возвраты» из
  // отстающего order_costs). salesRub = SUM(price_with_disc) — нетто-выручка
  // (возвраты уже вычтены знаком минус, это корректно для финансов).
  const fresh = {};
  for (const r of await db.prepare(
    `SELECT nm_id,
       SUM(CASE WHEN is_realization=1 AND price_with_disc > 0 THEN 1 ELSE 0 END) AS sold,
       SUM(CASE WHEN is_realization=1 THEN price_with_disc ELSE 0 END) AS salesRub
     FROM sales
     WHERE sale_dt>=? AND sale_dt<=? AND nm_id IS NOT NULL
     GROUP BY nm_id`
  ).all(from, toEnd)) {
    // salesRub = цена ДО СПП (price_with_disc). СПП — скидка WB покупателю,
    // компенсируется продавцу через payment_sale_amount, поэтому реальная
    // выручка продавца = price_with_disc, а не finished_price (с СПП).
    fresh[r.nm_id] = { sold: r.sold || 0, salesRub: r.salesRub || 0 };
  }

  // 3б) Хранение (storage_fee) НЕ включаем в profitClean: у WB оно идёт с nm_id=0
  // и не привязано к товару (контракт №27). Размазывать по SKU = искажать маржу.
  // Эти суммы показываются ОТДЕЛЬНО — в плитке «Кабинетные расходы» (роут /api/cabinet-costs),
  // без разнесения по товарам. См. закрытие follow-up №27.2 (AGENTS.md §6.5).

  // 4) Остатки: средний за период + на последнюю дату периода.
  const stockAvg = {};
  const stockEnd = {};
  const stockRows = await db.prepare(
    `SELECT nm_id, date, SUM(quantity_full) AS q
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
  // ИЛИ заказы за период ИЛИ свежие продажи в sales — чтобы видеть все активные SKU.
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
  for (const nmRaw of Object.keys(fresh)) addStub(Number(nmRaw));

  // Деньги — КАНОН (wbProfitProduct, задача 5 плана унификации прибыли), по
  // товару. adSpend — РЕАЛЬНЫЙ per-SKU расход (данные у WB есть физически,
  // wbAdTotal groupByNm) — с 2026-08-22 canon.ads при nmId тоже РЕАЛЬНЫЙ
  // расход, не 0 (план «реклама Ozon по товарам», задача 6/7, симметрично
  // Ozon, см. докстроку wbProfitProduct), profit его теперь вычитает.
  // Один batch-вызов на ВЕСЬ каталог вместо 2×N скалярных (задача 3 плана
  // «канон волна 2») — SQL-число теперь не растёт с числом товаров.
  const profitBatch = await wbProfitProductBatch(db, taxMode, { from, to: toEnd.slice(0, 10) });
  const out = [];
  for (const r of rows) {
    const nm = r.nm;
    const o = ord[nm] || { ordered: 0, cancelled: 0, orderRub: 0 };
    // СВЕЖИЕ штуки из sales (до 20.06). Если sales нет — fallback на order_costs.
    const fr = fresh[nm];
    const sold = fr ? fr.sold : (r.sold || 0);
    const f = profitBatch.get(nm) || ZERO_PROFIT;
    // orderRub — сумма ЗАКАЗОВ из orders.price_with_disc (блок 2), НЕ канон.
    const orderRub = o.orderRub || 0;
    const avgStock = stockAvg[nm] ?? 0;
    const avgDailySales = sold / days;
    // Инварианта: ordered >= sold + cancelled. ⚠️ returns НЕ прибавляем к sold:
    // возвращённый товар УЖЕ входит в sold (это была отгрузка с price>0, потом
    // её сторнировали возвратом). Прибавить returns = двойной счёт того же srid.
    const returns = r.returns || 0;
    const cancelled = o.cancelled || 0;
    const minOrdered = sold + cancelled;
    const ordered = Math.max(o.ordered || 0, minOrdered);
    const adSp = ad[nm] || 0;
    out.push({
      nm, sa: r.sa || String(nm), barcode: r.barcode || null,
      name: r.name || r.sa || String(nm), brand: r.brand || "", grp: r.grp || "",
      cat: r.cat || "", im_url: r.im_url || null, platform: "wb", shop: shopName,
      ordered, cancelled,
      sold, returns, selfBuyout: r.selfBuyout || 0,
      orderRub: round2(orderRub), salesRub: f.revenue,
      costRub: f.cogs,
      commission: f.commission, logistics: f.logistics, acquiring: f.acquiring, loyalty: f.loyalty,
      // returnLogistics — СПРАВОЧНАЯ строка канона (уже внутри logistics
      // выше, не вычитается повторно — см. докстроку wbProfitProduct).
      returnLogistics: f.returnLogistics,
      adSpend: round2(adSp),
      tax: f.tax, profit: f.profit,
      stock: stockEnd[nm] ?? 0, avgStock: round2(avgStock), avgDailySales: round2(avgDailySales),
      unitCost: unitCost[nm] ?? null,
    });
  }
  return out;
}

// ---------- Ozon ----------
async function collectOzon(from, toEnd, shopName, taxMode) {
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
  const ord = {};
  for (const r of await db.prepare(
    `SELECT product_id,
            SUM(CASE WHEN is_cancel=0 THEN 1 ELSE 0 END) AS ordered,
            SUM(CASE WHEN is_cancel=1 THEN 1 ELSE 0 END) AS cancelled,
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
      orderRub: round2(o.orderRub), salesRub: f.revenue,
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
