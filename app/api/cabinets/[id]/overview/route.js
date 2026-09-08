// /api/cabinets/[id]/overview — НАСТОЯЩИЙ overview из data-presenter (PostgreSQL+RLS).
// Полный перенос: все KPI, lossMakers, lowStock, noCogs.
import { NextResponse } from "next/server";
import { DatabaseSync, tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { defaultPeriod } from "@/lib/period.js";
import {
  wbOrdersCount, wbCancelCount, wbSold, wbProfitCabinet,
  wbFinanceByDay, wbOrdersByDay, wbOrderRubByDay, wbProfitProductBatch,
  wbRawProfitCabinetByDay,
} from "@/lib/wbMetrics.js";
import { ozOrdersByDay, ozProfitCabinet, ozRawProfitCabinetByDay } from "@/lib/ozonMetrics.js";
import { normalizeTaxMode, describeCombinedTaxMode } from "@/lib/tax.js";
import { loadWarehouseSignals } from "@/lib/warehousesData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// revenue — валовая у ОБЕИХ площадок (спека «WB: выручка по цене со скидкой»,
// 2026-09-06): у WB это Σ cost_value_withdisc (цена со скидкой продавца).
// Справочное поле revenueGross (Σ cost_value_retail) удалено вместе с
// wbRevenueGross — «реализовано» теперь живёт в канонe как c.realized.
// netPay — «к перечислению» из канона (c.payout) у обеих площадок; прежний
// локальный SQL по finance_report (ppvz_for_pay Продажа − |Возврат|) удалён:
// он давал ту же величину другой датировкой (rr_dt против датировки канона)
// и был вторым источником правды. Дневной ряд netPay в timeseries ниже —
// ИЗ ТОГО ЖЕ канона (wbRawProfitCabinetByDay/ozRawProfitCabinetByDay),
// поэтому Σ столбиков графика = карточка KPI.
// sold — с 06.09 из order_costs (wbSold переехал с ленты sales, «одна цифра
// везде»): те же штуки, что показывает Сводка по товарам.
// services — статья «Сборы Ozon» (§3.3 docs/metrics-contract.md, волна
// 2026-08-25): расщеплено из logistics бэкфиллом задач 1-2 плана «Сборы
// Ozon» — сборы физически теперь СВОЯ колонка order_costs, не часть
// logistics. У WB поле остаётся 0 (collectWb его не заполняет — своей
// статьи «сборы» у WB нет).
const zeroKpi = () => ({
  revenue: 0, sold: 0, commission: 0, services: 0, logistics: 0, acquiring: 0, loyalty: 0,
  costRub: 0, adSp: 0, tax: 0, profit: 0, orders: 0, cancelCnt: 0, orderRub: 0,
  netPay: 0, storage: 0,
});

// Профиль KPI (revenue/commission/.../tax/profit) — канон (wbProfitCabinet,
// задача 4 плана унификации прибыли), вместо прежнего компонентного
// пересчёта. Остальные поля (sold, orders, cancelCnt, orderRub, netPay,
// storage) — витринные метрики вне периметра канона, считаются как раньше.
async function collectWb(db, from, to, toEnd, taxMode) {
  const k = zeroKpi();
  const c = await wbProfitCabinet(db, taxMode, { from, to });
  k.revenue = c.revenue;
  k.netPay = c.payout;
  k.commission = c.commission;
  k.acquiring = c.acquiring;
  k.logistics = c.logistics;
  k.loyalty = c.loyalty;
  k.costRub = c.cogs;
  k.adSp = c.ads;
  k.tax = c.tax;
  k.profit = c.profit;

  k.sold = Object.values(await wbSold(db, { from, to })).reduce((a, b) => a + b, 0);

  k.storage = (await db.prepare(
    `SELECT COALESCE(SUM(storage_fee),0) AS v FROM finance_report
     WHERE supplier_oper_name = 'Хранение' AND rr_dt >= ? AND rr_dt <= ?`
  ).get(from, toEnd)).v || 0;

  k.orders = await wbOrdersCount(db, { from, to });
  k.cancelCnt = await wbCancelCount(db, { from, to });
  // Сумма заказов в рублях (price_with_disc по не отменённым) — цена со скидкой
  // продавца, БЕЗ СПП. Это стандартная «сумма заказов» в отчётах МП. Отличается
  // от revenue канона (продажи по цене со скидкой продавца за период): часть
  // заказов отменяется/не выкупается, поэтому orderRub не равен revenue.
  k.orderRub = (await db.prepare(
    `SELECT COALESCE(SUM(price_with_disc),0) AS v FROM orders
     WHERE is_cancel = 0 AND order_dt >= ? AND order_dt <= ?`
  ).get(from, toEnd)).v || 0;

  return k;
}

async function collectOzon(db, from, to, toEnd, taxMode) {
  const k = zeroKpi();
  const c = await ozProfitCabinet(db, taxMode, { from, to });
  k.revenue = c.revenue;
  // payout Ozon = revenue − commission − services − acquiring − loyalty
  // (lib/ozonMetrics.js:ozNetForm); до спеки 2026-09-06 «к перечислению» у
  // Ozon на главной не было вовсе (оставался 0 из zeroKpi).
  k.netPay = c.payout;
  k.costRub = c.cogs;
  k.commission = c.commission;
  k.services = c.services;
  k.logistics = c.logistics;
  k.acquiring = c.acquiring;
  k.loyalty = c.loyalty;
  k.adSp = c.ads;
  k.tax = c.tax;
  k.profit = c.profit;

  k.sold = (await db.prepare(
    `SELECT COUNT(*) AS c FROM order_costs
     WHERE is_return = 0
       AND COALESCE(sale_dt, return_dt) IS NOT NULL
       AND substr(COALESCE(sale_dt, return_dt),1,10) >= ?
       AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?`
  ).get(from, to)).c || 0;

  k.orders = (await db.prepare(
    `SELECT COUNT(*) AS c FROM orders
     WHERE is_cancel = 0 AND substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ?`
  ).get(from, to)).c || 0;
  k.cancelCnt = (await db.prepare(
    `SELECT COUNT(*) AS c FROM orders
     WHERE is_cancel = 1 AND substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ?`
  ).get(from, to)).c || 0;
  // Сумма заказов в рублях (price по не отменённым).
  k.orderRub = (await db.prepare(
    `SELECT COALESCE(SUM(price),0) AS v FROM orders
     WHERE is_cancel = 0 AND substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ?`
  ).get(from, to)).v || 0;

  return k;
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mps = cabinet.marketplaces || ['wb', 'ozon'];
  const mp = url.searchParams.get("mp") || "all";

  const fromQ = url.searchParams.get("from") || "";
  const toQ = url.searchParams.get("to") || "";
  const def = defaultPeriod(30);
  const to = toQ || def.to;
  const from = fromQ || def.from;
  const toEnd = to + "T23:59:59";

  // Налоговый режим на каждый МП (per shop / per legal entity).
  const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
  const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);

  const parts = [];
  if (mp !== "ozon" && mps.includes('wb')) {
    const db = new DatabaseSync('wb', { readOnly: true });
    parts.push(await collectWb(db, from, to, toEnd, wbTax));
  }
  if (mp !== "wb" && mps.includes('ozon')) {
    const db = new DatabaseSync('ozon', { readOnly: true });
    parts.push(await collectOzon(db, from, to, toEnd, ozonTax));
  }

  const k = zeroKpi();
  for (const p of parts) {
    for (const key of Object.keys(k)) k[key] += p[key] || 0;
  }
  k.profit = Math.round(k.profit * 100) / 100;
  const margin = k.revenue > 0 ? (k.profit / k.revenue) * 100 : 0;
  const cancelRate =
    k.orders + k.cancelCnt > 0 ? (k.cancelCnt / (k.orders + k.cancelCnt)) * 100 : 0;
  // services (§3.3 контракта, «Сборы Ozon») — реальный расход, который ДО
  // волны 2026-08-25 маскировался внутри k.logistics; без явного сложения
  // здесь expenses систематически недосчитывает ровно эту сумму (пост-
  // ревью: MiniStat «Логистика» усох, деньги исчезли с главной).
  const expenses = k.commission + k.services + k.logistics + k.storage;

  // --- lossMakers / noCogsCount: WB-only. lowStock — обеих площадок, см. ниже (сигналы склада). ---
  let lossMakers = [];
  let lowStock = [];
  let noCogsCount = 0;
  if (mp !== "ozon" && mps.includes('wb')) {
    const db = new DatabaseSync('wb', { readOnly: true });

    // lossMakers — КАНОН (задача 5 плана «канон волна 2», 2026-08-25). Раньше
    // здесь был отдельный ad-hoc пересчёт (finance_report/логистика/реклама/
    // cost_overrides, формула на ppvz_for_pay) — дубль формулы канона со
    // своим списком багов. Теперь источник — wbProfitProductBatch, тот же
    // канон, что /summary и /rnp-summary: кандидаты = записи Map с
    // profit < 0 за тот же период, сортировка по возрастанию profit, top-5.
    //
    // СОСТАВ ВИДЖЕТА МЕНЯЕТСЯ (ожидаемо, задокументировано для владельца):
    //  1) канон-база — order_costs (wbRawProfitAggregate), а не собственная
    //     агрегация finance_report: выручка = Σ cost_value_withdisc (цена со
    //     скидкой продавца, спека 2026-09-06), из неё вычитаются СПП и
    //     нетто-вознаграждение WB — прежний ppvz_for_pay это теперь НЕ база,
    //     а результат (payout = revenue − spp − commission). Числа по общим
    //     товарам отличаются от старых (другой источник, другие слагаемые);
    //  2) товары БЕЗ строки в cost_overrides раньше .filter()-ом молча
    //     выпадали из списка целиком (виджет «нет убыточных» на деле часто
    //     означал «не знаем себестоимость» — false negative). Теперь такие
    //     товары остаются кандидатами (canon.cogs для них = 0, значит
    //     profit завышен относительно реальности) и помечаются
    //     costMissing: true — честнее, но требует бейджа в UI (шаг 2).
    const profitBatch = await wbProfitProductBatch(db, wbTax, { from, to });
    const lmName = {};
    for (const r of await db.prepare("SELECT nm_id, name FROM articles").all()) lmName[r.nm_id] = r.name;

    const candidates = [...profitBatch.entries()]
      .filter(([, f]) => f.profit < 0)
      .sort((a, b) => a[1].profit - b[1].profit)
      .slice(0, 5);

    // costMissing — ОДИН batch-SQL по множеству nm кандидатов (не N+1):
    // true, если для nm нет актуальной строки cost_overrides (cost > 0,
    // effective_from <= сегодня) — та же логика, что раньше отсекала товар
    // целиком, теперь только помечает.
    const candIds = candidates.map(([nm]) => nm);
    const withCost = new Set();
    if (candIds.length > 0) {
      for (const r of await db.prepare(
        `SELECT DISTINCT nm_id FROM tenant.cost_overrides
         WHERE platform = 'wb' AND cost > 0 AND effective_from <= current_date
           AND nm_id = ANY($1::bigint[])`
      ).all(candIds)) withCost.add(r.nm_id);
    }

    // Допущение: costMissing = «нет строки в cost_overrides» — тот же
    // предикат, каким старый код молча отсекал товар. Слепое пятно (строка
    // заведена ПОЗЖЕ периода продаж → cogs=0 при costMissing=false)
    // существовало и раньше; теперь товар хотя бы виден.
    lossMakers = candidates.map(([nm, f]) => ({
      nm_id: nm,
      name: lmName[nm] || String(nm),
      profit: f.profit,
      costMissing: !withCost.has(nm),
    }));

    noCogsCount = (await db.prepare(
      `SELECT COUNT(DISTINCT s.nm_id) AS c
       FROM finance_report s
       LEFT JOIN LATERAL (
         SELECT cost FROM tenant.cost_overrides
         WHERE nm_id = s.nm_id AND platform = 'wb'
           AND effective_from <= substr(s.rr_dt,1,10)::date
         ORDER BY effective_from DESC LIMIT 1
       ) co ON true
       WHERE s.supplier_oper_name = 'Продажа' AND s.nm_id > 0
         AND (co.cost IS NULL OR co.cost <= 0) AND s.rr_dt >= ? AND s.rr_dt <= ?`
    ).get(from, toEnd)).c || 0;
  }

  // --- Временной ряд для графика на Главной (по дням). ---
  // WB: выручка, маржинальная прибыль (sales − commission − acquiring − logistics −
  //   loyalty; БЕЗ себестоимости/рекламы/налога — их нет в finance_report по дням),
  //   заказы (шт), сумма заказов (₽), комиссия, к перечислению (канон, payout).
  // Ozon: заказы, выручка, комиссия, к перечислению (канон, payout); прибыли
  //   per-day нет в данных.
  //   Склеиваем по дате WB + Ozon, сортируем по возрасту.
  const TS_KEYS = ["revenue", "profit", "orders", "orderRub", "commission", "netPay"];
  const tsByDate = new Map(); // date -> {revenue, profit, ...}
  const tsSet = (d, patch) => {
    if (!tsByDate.has(d)) {
      const o = {}; for (const k of TS_KEYS) o[k] = 0; tsByDate.set(d, o);
    }
    const o = tsByDate.get(d);
    for (const key of Object.keys(patch)) o[key] = (o[key] || 0) + (patch[key] || 0);
  };
  if (mp !== "ozon" && mps.includes('wb')) {
    const db = new DatabaseSync('wb', { readOnly: true });
    // finance_report/wbFinanceByDay остаётся ИСТОЧНИКОМ ДВУХ рядов —
    // revenue и маржинальной profit (датировка rr_dt; расхождение датировки
    // с каноном order_costs известно и осознанно отложено). Ряд commission
    // отсюда УБРАН: там «отчётная» комиссия commission_percent ×
    // retail_price_withdisc_rub, тогда как KPI несёт НЕТТО-вознаграждение
    // канона (realized − payout) — Σ столбиков не сходилась с карточкой
    // «Комиссии» (kpi.expensesBreakdown.commission).
    // Теперь commission берётся ниже из wbRawProfitCabinetByDay — ровно тем
    // же приёмом, каким на канон переехал netPay.
    const fin = await wbFinanceByDay(db, { from, to });
    for (const [key, v] of fin) {
      const d = key.split("|")[1];
      const profit = (v.salesRub || 0) - (v.commission || 0) - (v.acquiring || 0)
        - (v.logistics || 0) - (v.loyalty || 0);
      tsSet(d, {
        revenue: v.salesRub || 0,
        profit,
      });
    }
    const ord = await wbOrdersByDay(db, { from, to });
    for (const [key, c] of ord) tsSet(key.split("|")[1], { orders: c });
    // Сумма заказов ₽ (price_with_disc) по дням.
    const ordRub = await wbOrderRubByDay(db, { from, to });
    for (const [key, s] of ordRub) tsSet(key.split("|")[1], { orderRub: s });
    // К перечислению по дням — КАНОН (wbRawProfitCabinetByDay → payout =
    // Σ cost_value_pay). Раньше здесь был свой SQL по finance_report
    // (ppvz_for_pay: Продажа(+), Возврат(−)) с датировкой rr_dt — после
    // переезда KPI netPay на канон (c.payout, датировка sale_dt/return_dt
    // order_costs) Σ столбиков перестала сходиться с карточкой. Теперь оба
    // числа — один SELECT с одной датировкой: Σ days.netPay = kpi.netPay.
    // Комиссия по дням — тот же КАНОН и тот же SELECT, что netPay:
    // agg.commission = realized − payout (нетто-вознаграждение WB), ровно та
    // цифра, что стоит в KPI («Комиссии» = kpi.expensesBreakdown.commission).
    for (const [d, agg] of await wbRawProfitCabinetByDay(db, { from, to })) {
      tsSet(d, { netPay: agg.payout || 0, commission: agg.commission || 0 });
    }
  }
  if (mp !== "wb" && mps.includes('ozon')) {
    const db = new DatabaseSync('ozon', { readOnly: true });
    const ord = await ozOrdersByDay(db, { from, to });
    for (const [key, c] of ord) tsSet(key.split("|")[1], { orders: c });
    // К перечислению по дням — КАНОН (ozRawProfitCabinetByDay → payout =
    // revenue − commission − services − acquiring − loyalty, ozNetForm).
    // Раньше у Ozon дневного «перечисления» не было вовсе, а KPI netPay был
    // нулём; теперь KPI = c.payout, поэтому и ряд должен его нести, иначе
    // Σ столбиков < карточки на всю Ozon-часть.
    for (const [d, agg] of await ozRawProfitCabinetByDay(db, { from, to })) {
      tsSet(d, { netPay: agg.payout || 0 });
    }
    // Ozon: выручка + комиссия per-day из order_costs (cost_value_retail, commission).
    // Прибыль по дням не считаем (нет данных per-day).
    for (const r of await db.prepare(
      `SELECT substr(COALESCE(sale_dt, return_dt),1,10) AS d,
              SUM(CASE WHEN is_return=0 THEN cost_value_retail ELSE 0 END) AS rev,
              SUM(CASE WHEN is_return=0 THEN commission ELSE 0 END) AS com
       FROM order_costs
       WHERE COALESCE(sale_dt, return_dt) IS NOT NULL
         AND substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
       GROUP BY substr(COALESCE(sale_dt, return_dt),1,10)`
    ).all(from, to)) {
      tsSet(r.d, { revenue: r.rev || 0, commission: r.com || 0 });
    }
  }
  const timeseries = [...tsByDate.entries()]
    .map(([date, v]) => {
      const o = { date };
      for (const k of TS_KEYS) o[k] = Math.round((v[k] || 0) * 100) / 100;
      return o;
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // Сигналы склада (Склады 2.0, этап 4) — тот же расчёт, что вкладка /warehouses; канон 28/28,
  // остаток «доступно». Виджет «Заканчиваются на складе» с 2026-09-08 считает по нему (обе
  // площадки, с местом/складом) — раньше был отдельный WB-only расчёт по дням с продажами.
  //
  // Блок стоит ПОСЛЕДНИМ и обёрнут в SAVEPOINT намеренно. withCabinet держит ОДНУ транзакцию
  // на запрос (withTenant, lib/db.js:187-207): любая ошибка SQL внутри переводит транзакцию
  // в aborted, и все ПОСЛЕДУЮЩИЕ запросы падают с «current transaction is aborted» — то есть
  // сломанные склады уронили бы всю Главную, хотя catch ниже их «проглатывает». SAVEPOINT
  // откатывает только этот блок: KPI и график, посчитанные выше, остаются валидны, а Главная
  // просто рисуется без секции складов.
  let warehouses = [];
  try {
    await tenantQuery("SAVEPOINT wh_signals", []);
    try {
      warehouses = await loadWarehouseSignals(cabinet.cabinet_id);
      await tenantQuery("RELEASE SAVEPOINT wh_signals", []);
    } catch (e) {
      console.error("[overview] warehouse signals failed:", e?.message || e);
      warehouses = [];
      await tenantQuery("ROLLBACK TO SAVEPOINT wh_signals", []);
      await tenantQuery("RELEASE SAVEPOINT wh_signals", []);
    }
  } catch (e) {
    // Сюда попадаем, только если сам SAVEPOINT/ROLLBACK не прошёл — транзакция уже мертва,
    // спасать нечего: отдаём Главную без складов, дальше упадёт (и откатится) withCabinet.
    console.error("[overview] warehouse signals savepoint failed:", e?.message || e);
    warehouses = [];
  }
  const lowSig = warehouses.find((s) => s.kind === "low_coverage");
  lowStock = (lowSig?.items || []).map((x) => ({ name: x.name, where: x.where, qty: x.qty, days_to_oos: x.coverage, itemKey: x.itemKey, colKey: x.colKey }));

  return NextResponse.json({
    period: { from, to },
    mp,
    kpi: {
      revenue: Math.round(k.revenue * 100) / 100,
      netPay: Math.round(k.netPay * 100) / 100,
      // profit — полная каноническая прибыль (после рекламы и налога).
      // До волны 3 поле звалось grossProfit и коллидировало с
      // pnl.grossProfit (валовая ДО рекламы/налога) — одно имя, две разные
      // величины; переименовано в честное.
      profit: k.profit,
      margin,
      cogsSold: Math.round(k.costRub * 100) / 100,
      adSpend: Math.round(k.adSp * 100) / 100,
      tax: Math.round(k.tax * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      expensesBreakdown: {
        logistics: Math.round(k.logistics * 100) / 100,
        // services — «Сборы Ozon» (§3.3 контракта); у WB всегда 0 (нет
        // своей статьи, см. докстроку zeroKpi выше).
        services: Math.round(k.services * 100) / 100,
        commission: Math.round(k.commission * 100) / 100,
        storage: Math.round(k.storage * 100) / 100,
        penalties: 0,
      },
      orders: k.orders,
      orderRub: Math.round(k.orderRub * 100) / 100,
      cancelRate,
      sold: k.sold,
    },
    alerts: { lossMakers, lowStock, noCogsCount, warehouses },
    timeseries,
    taxLabel: describeCombinedTaxMode(cabinet.shopTax, { short: true }),
  });
});
