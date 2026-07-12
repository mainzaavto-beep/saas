import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { NextResponse } from "next/server";
import {
  wbFinancePeriodByNm, wbSold, wbAdTotal, wbUnitCost, calcOperatingProfit, USN_RATE as WB_USN,
} from "@/lib/wbMetrics.js";
import {
  ozOrderCostsByProduct, ozAdSpend, calcOperatingProfit as ozCalcProfit,
} from "@/lib/ozonMetrics.js";

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
//    cogs          — себестоимость единицы (контракт №12: cost>0)
//
//  ⚠️ МЕТОДОЛОГИЯ: цифры считаются прозрачно из боевых БД по нашим формулам
//  (решение владельца) и МОГУТ расходиться с выгрузкой Mpassistant на 5–30%
//  из-за разной трактовки (окна данных, отношение к отменам, формула %выкупа).
// =====================================================================

const USN_RATE = WB_USN; // из lib/wbMetrics.js (единый канон)




export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const platform = url.searchParams.get("platform") || "all"; // all|wb|ozon
    const fromQ = url.searchParams.get("from") || "";           // YYYY-MM-DD
    const toQ = url.searchParams.get("to") || "";

    // Дефолтный период: последние 30 дней от MAX(order_dt) по обеим БД.
    // Если MAX пустой (нет данных / RLS ничего не видит) — fallback на сегодня.
    let from = fromQ, to = toQ;
    if (!from || !to) {
      let maxDt = "";
      try { maxDt = await new DatabaseSync("wb", {readOnly:true}).prepare("SELECT MAX(order_dt) AS m FROM orders").get()?.m || ""; } catch {}
      try { const oz = await new DatabaseSync("ozon", {readOnly:true}).prepare("SELECT MAX(order_dt) AS m FROM orders").get()?.m || ""; if (oz > maxDt) maxDt = oz; } catch {}
      if (maxDt) {
        if (!to) to = maxDt.slice(0, 10);
        if (!from) {
          const d = new Date(maxDt);
          d.setDate(d.getDate() - 29);
          from = d.toISOString().slice(0, 10);
        }
      } else {
        // Fallback: нет данных — последние 30 дней от сегодня (не пустая строка!).
        if (!to) to = new Date().toISOString().slice(0, 10);
        if (!from) from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
      }
    }
    const toEnd = to ? to + "T23:59:59" : "";

    let items = [];
    if (platform !== "ozon") items = items.concat(await collectWB(from, toEnd, cabinet.shop_names?.wb));
    if (platform !== "wb")   items = items.concat(await collectOzon(from, toEnd, cabinet.shop_names?.ozon));

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

    const totals = aggTotals(items);

    // ⚠ Правка 2026-06-27: totals.adSpend пересчитываем честно — ВСЯ реклама
    // периода из daily_metrics (WB+Ozon), а не сумма по строкам товаров.
    // aggTotals теряет рекламу по товарам без строки (нет продаж в периоде),
    // что давало расхождение ~2к₽ с /api/overview. Реклама = расход периода
    // (потрачена независимо от продаж), поэтому весь объём должен входить в
    // totals. После пересчёта adSpend пересчитываем и profit (старая сумма
    // рекламы занижала прибыль на величину потерянной рекламы).
    if (from && to) {
      let fullAd = 0;
      try {
        fullAd += await new DatabaseSync("wb", {readOnly:true}).prepare(
          `SELECT COALESCE(SUM(ad_spend),0) AS s FROM daily_metrics
           WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL`
        ).get(from, toEnd).s || 0;
      } catch (e) { console.error('[products-summary] WB ad пересчёт:', e.message); }
      try {
        fullAd += await new DatabaseSync("ozon", {readOnly:true}).prepare(
          `SELECT COALESCE(SUM(ad_spend),0) AS s FROM daily_metrics
           WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL`
        ).get(from, toEnd).s || 0;
      } catch (e) { console.error('[products-summary] Ozon ad пересчёт:', e.message); }
      if (platform === "wb") {
        // Только WB: переоткрыли ozon-БД выше для all — для wb отдельно.
        fullAd = await new DatabaseSync("wb", {readOnly:true}).prepare(
          `SELECT COALESCE(SUM(ad_spend),0) AS s FROM daily_metrics
           WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL`
        ).get(from, toEnd).s || 0;
      } else if (platform === "ozon") {
        fullAd = await new DatabaseSync("ozon", {readOnly:true}).prepare(
          `SELECT COALESCE(SUM(ad_spend),0) AS s FROM daily_metrics
           WHERE date >= ? AND date <= ? AND ad_spend IS NOT NULL`
        ).get(from, toEnd).s || 0;
      }
      const adDelta = round2(fullAd - (totals.adSpend || 0));
      totals.adSpend = round2(fullAd);
      // Прибыль уменьшается на дельту рекламы (больше рекламы учли → меньше profit).
      totals.profit = round2((totals.profit || 0) - adDelta);

      // ⚠ Правка 2026-07-09 (Этап 2 единого слоя метрик): totals.logistics для WB
      // тоже пересчитываем честно — ВСЯ логистика периода из finance_report
      // (операция «Логистика», все nm>0), а не сумма по строкам товаров.
      // aggTotals теряет логистику по nm БЕЗ продажи в периоде (wbFinancePeriodByNm
      // создаёт запись только для nm с Продажей → логистика nm-без-продажи не
      // попадает в items). Симметрично adSpend выше. Без этого Сводка расходилась
      // с Главной на ~466₽ за июль (gotcha раскрыта при сверке Этапа 2). Логистика —
      // расход периода (доставка состоялась), учитываем весь объём. УСН и маржа
      // от выручки, а не логистики → пересчёта tax/margin по логистике не требуется.
      if (platform !== "ozon") {
        try {
          // ⚠️ Грабля SAAS: отдельный prepare().get() для этого агрегата после
          // предыдущих запросов в транзакции возвращает 0 (баг эмулятора
          // DatabaseSync поверх pg). Решение: считать через subquery в одном
          // запросе — так работает корректно. logsum = Σ delivery_rub операция
          // 'Логистика', все nm>0 за период.
          const dbg = await new DatabaseSync("wb", {readOnly:true}).prepare(
            `SELECT (SELECT COALESCE(SUM(delivery_rub),0) FROM finance_report
                     WHERE supplier_oper_name='Логистика' AND nm_id IS NOT NULL AND nm_id != 0
                       AND rr_dt >= ? AND rr_dt <= ?) AS logsum`
          ).get(from, toEnd);
          const fullLog = dbg.logsum || 0;
          const logDelta = round2(fullLog - (totals.logistics || 0));
          totals.logistics = round2(fullLog);
          totals.profit = round2((totals.profit || 0) - logDelta);
        } catch (e) { console.error('[products-summary] logistics пересчёт упал:', e.message); }
      }
      if (totals.salesRub) totals.margin = round2(100 * totals.profit / totals.salesRub);
    }

    return NextResponse.json({
      count: items.length,
      period: { from, to, days },
      totals,
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
  }
  t.buyoutPct = (t.sold + t.returns + t.cancelled) > 0
    ? round2(100 * t.sold / (t.sold + t.returns + t.cancelled)) : null;
  t.margin = t.salesRub ? round2(100 * t.profit / t.salesRub) : null;
  t.avgCheck = t.ordered ? round2(t.orderRub / t.ordered) : null;
  return t;
}

// ---------- WB ----------
async function collectWB(from, toEnd, shopName) {
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

  // 1б) ДЕНЬГИ из finance_report — единый канон (lib/wbMetrics.js).
  //   - salesRub = SUM(retail_price_withdisc_rub) — выручка ДО СПП
  //   - commission = SUM(commission_percent × retail_price_withdisc_rub / 100)
  //     (владелец: «комиссия считается от цены до СПП», не ppvz_sales_commission!)
  //   - acquiring = SUM(acquiring_fee), logistics = SUM(delivery_rub) операция 'Логистика'
  // ⚠️ orderRub (сумма ЗАКАЗОВ) считаем НЕ здесь, а из orders.price_with_disc —
  // см. блок 2. Заказы из orders включают отмены → дают честную «сумму заказов».
  // toEnd = "YYYY-MM-DD 23:59:59"; lib ждёт дату без времени (добавляет сам).
  const fin = await wbFinancePeriodByNm(db, { from, to: toEnd.slice(0, 10) });

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
  const unitCost = {};
  for (const r of await db.prepare(`SELECT nm_id, cost FROM cogs`).all()) {
    unitCost[r.nm_id] = r.cost > 0 ? r.cost : null;
  }

  // Объединяем. Товар попадает в выдачу, если у него есть order_costs (продажа/возврат)
  // ИЛИ заказы за период ИЛИ свежие продажи в sales — чтобы видеть все активные SKU.
  const seen = new Set(rows.map((r) => r.nm));
  const addStub = (key) => {
    if (!seen.has(key)) {
      rows.push({
        nm: key, barcode: null, cat: null, name: null, brand: null, grp: null, im_url: null, sa: null,
        sold: 0, returns: 0, selfBuyout: 0, orderRub: 0, salesRub: 0, costRub: 0,
        commission: 0, logistics: 0, acquiring: 0, loyalty: 0, profit: 0,
      });
      seen.add(key);
    }
  };
  for (const nmRaw of Object.keys(ord)) addStub(Number(nmRaw));
  for (const nmRaw of Object.keys(fresh)) addStub(Number(nmRaw));

  return rows.map((r) => {
    const nm = r.nm;
    const o = ord[nm] || { ordered: 0, cancelled: 0, orderRub: 0 };
    // СВЕЖИЕ штуки из sales (до 20.06). Если sales нет — fallback на order_costs.
    const fr = fresh[nm];
    const sold = fr ? fr.sold : (r.sold || 0);
    // ДЕНЬГИ напрямую из finance_report (правильная формула по доке WB):
    //   salesRub = SUM(retail_price_withdisc_rub) — выручка ДО СПП
    //   commission = SUM(commission_percent × retail_price_withdisc_rub / 100)
    //     (владелец: «комиссия считается от цены до СПП»).
    const f = fin[nm] || {};
    const salesRub = f.salesRub || 0;
    // orderRub — сумма ЗАКАЗОВ из orders.price_with_disc (блок 2), НЕ из finance_report.
    const orderRub = o.orderRub || 0;
    const commission = round2(f.commission || 0);
    const acquiring  = round2(f.acquiring || 0);
    const logistics  = round2(f.logistics || 0);
    const loyalty    = round2(f.loyalty || 0);
    const tax = round2(salesRub * USN_RATE);
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
    const costRub = round2((unitCost[nm] ?? 0) * sold);
    // ЧИСТАЯ прибыль по SKU = выручка − все расходы. Хранение сюда НЕ входит —
    // оно не привязано к товару (№27), показывается в плитке «Кабинетные расходы».
    const profitClean = round2(
      salesRub - commission - acquiring - logistics - loyalty - costRub - adSp - tax
    );
    return {
      nm, sa: r.sa || String(nm), barcode: r.barcode || null,
      name: r.name || r.sa || String(nm), brand: r.brand || "", grp: r.grp || "",
      cat: r.cat || "", im_url: r.im_url || null, platform: "wb", shop: shopName,
      ordered, cancelled,
      sold, returns, selfBuyout: r.selfBuyout || 0,
      orderRub: round2(orderRub), salesRub: round2(salesRub),
      costRub,
      commission, logistics, acquiring, loyalty,
      adSpend: round2(adSp),
      tax, profit: profitClean,
      stock: stockEnd[nm] ?? 0, avgStock: round2(avgStock), avgDailySales: round2(avgDailySales),
      unitCost: unitCost[nm] ?? null,
    };
  });
}

// ---------- Ozon ----------
async function collectOzon(from, toEnd, shopName) {
  const db = new DatabaseSync("ozon", {readOnly:true});
  const days = Math.max(1, Math.round((new Date(toEnd.slice(0, 10)) - new Date(from)) / 86400000) + 1);
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
       SUM(CASE WHEN substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)>=? AND substr(COALESCE(oc.sale_dt,oc.return_dt),1,10)<=? THEN oc.profit ELSE 0 END) AS profit
     FROM order_costs oc
     LEFT JOIN products p ON p.product_id = oc.product_id
     WHERE oc.product_id IS NOT NULL
       AND COALESCE(oc.sale_dt, oc.return_dt) IS NOT NULL
     GROUP BY oc.product_id`
  ).all(from, toEnd, from, toEnd,
        from, toEnd,
        from, toEnd,
        from, toEnd,
        from, toEnd, from, toEnd, from, toEnd, from, toEnd,
        from, toEnd);

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

  const unitCost = {};
  for (const r of await db.prepare(`SELECT product_id, cost FROM cogs`).all()) {
    unitCost[r.product_id] = r.cost > 0 ? r.cost : null;
  }

  // Добавляем все активные SKU (из order_costs). freshOz убран (грабля #134).
  // Все активные товары уже попадают через GROUP BY oc.product_id в SQL-запросе.
  const seen = new Set(rows.map((r) => r.nm));

  return rows.map((r) => {
    const nm = r.nm;
    // ФИКС #134: ВСЕ числа берём напрямую из order_costs (как profit в SQL-запросе),
    // а не из sales (там нет delivered-продаж у Ozon). sold/returns/salesRub/profit
    // уже посчитаны в SQL через COALESCE(sale_dt, return_dt) — корректный месяц.
    const sold = r.sold || 0;
    const returns = r.returns || 0;
    const salesRub = r.salesRub || 0;
    // Расходы берем напрямую из order_costs (уже посчитаны агрегатом за период по
    // sale_dt), без пересчёта ставок. Это даёт точную копейку-в-копейку с эталоном
    // P&L из efficiency.py (Σprofit = −20k за июнь, а не +4k как раньше).
    const commission = round2(r.commission || 0);
    const acquiring  = round2(r.acquiring || 0);
    const logistics  = round2(r.logistics || 0);
    const loyalty    = round2(r.loyalty || 0);
    const costRub    = round2(r.costRub || 0);
    const tax = round2(salesRub * USN_RATE);
    const avgStock = stockAvg[nm] ?? 0;
    const avgDailySales = sold / days;
    const adSp = ad[nm] || 0;
    // profitClean = ОПЕРАЦИОННАЯ прибыль (правка 2026-06-26): та же формула, что в
    // collectWB — выручка − себест − комиссия − логистика − эквайринг − лояльность −
    // реклама − УСН 6%. Раньше здесь было просто order_costs.profit (валовая, без
    // рекламы/налога) → Ozon и WB считали прибыль по-разному внутри Сводки, и План
    // продаж не сходился с Сводкой. Теперь единая операционная прибыль для обеих МП.
    // Готовый order_costs.profit оставляем справочно как profitGross (валовая, до
    // рекламы/налога) — иногда полезно видеть валовую маржу отдельно.
    const profitGross = round2(r.profit || 0);
    const profitClean = round2(
      salesRub - commission - acquiring - logistics - loyalty - costRub - adSp - tax
    );
    // orderRub и ordered/cancelled — из таблицы orders (фикс #137). orderRub = сумма
    // ЗАКАЗОВ (симметрично WB), НЕ равен salesRub (который из order_costs = доставки).
    // Ограничение: у Ozon orders покрывают только последние ~2 недели — orderRub за
    // полный месяц будет неполным. ordered = реальные заказы из orders.
    const o = ord[nm] || { ordered: 0, cancelled: 0, orderRub: 0 };
    return {
      nm, sa: r.sa || String(nm), barcode: r.barcode || null,
      name: r.name || r.sa || String(nm), brand: r.brand || "", grp: r.grp || "",
      cat: "", im_url: r.im_url || null, platform: "ozon", shop: shopName,
      ordered: o.ordered, cancelled: o.cancelled,
      sold, returns, selfBuyout: r.selfBuyout || 0,
      orderRub: round2(o.orderRub), salesRub: round2(salesRub),
      costRub,
      commission, logistics, acquiring, loyalty,
      adSpend: round2(adSp),
      tax, profit: profitClean, profitGross,
      stock: stockEnd[nm] ?? 0, avgStock: round2(avgStock), avgDailySales: round2(avgDailySales),
      stockDate: stockDate._ozon || null, // дата снимка остатков Ozon (грабля #139)
      unitCost: unitCost[nm] ?? null,
    };
  });
}
