// /api/cabinets/[id]/pnl — P&L (Сводка по прибыли) из PostgreSQL.
// Источник: wb_finance_report + ozon_order_costs.
// Поддержка: один период (period=YYYY-MM), произвольный диапазон
// (from/to), разбивка на отрезки (breakdown=week|month) как сегменты.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { calcTotalTax, normalizeTaxMode, describeCombinedTaxMode } from "@/lib/tax.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Расчёт P&L за произвольный диапазон [from, to] (YYYY-MM-DD).
// Возвращает { total, wb, ozon } с теми же полями, что раньше.
async function computePnl(from, to, mps, wbTax, ozonTax) {
  const te = to + "T23:59:59";
  // Нижнюю границу берём голой датой. rr_dt хранится строкой, и у большинства
  // строк отчёта это ровно 'YYYY-MM-DD' (10 символов). При сравнении строк
  // '2026-07-01' < '2026-07-01 00:00:00', поэтому дописанное время выбрасывало
  // из расчёта весь первый день периода (у кабинета 1 за 01.07 — 3096 ₽ расходов).
  // Верхняя граница с 'T23:59:59' работает: любая дата-префикс меньше неё.
  const fromTs = from;
  let wb = null, ozon = null;

  // WB P&L — из finance_report (диапазон по rr_dt).
  if (mps.includes("wb")) {
    const db = new DatabaseSync("wb", { readOnly: true });
    // Кабинетные расходы (№27/№28) — не привязаны к SKU, считаются по типу операции
    // и bonus_type_name. Маппинг тот же, что в сборщике wb_cabinet_costs.py:
    //   Удержание скрывает разные услуги (gotcha #148): Продвижение / Подписка /
    //   Баллы за отзывы (возврат аванса) / утилизация — разделяем по bonus_type.
    //   Возмещения (перевозка/ПВЗ) и сторно отзывов = приток → в «Прочие доходы WB».
    //   Суммы берём в нативном знаке WB (возмещения/сторно отрицательны).
    const f = await db.prepare(
      `SELECT
         SUM(CASE WHEN supplier_oper_name='Продажа' THEN retail_amount ELSE 0 END) AS sales,
         SUM(CASE WHEN supplier_oper_name='Возврат' THEN retail_amount ELSE 0 END) AS returns,
         SUM(CASE WHEN supplier_oper_name='Продажа' THEN ppvz_for_pay ELSE 0 END) AS forPaySales,
         SUM(CASE WHEN supplier_oper_name='Возврат' THEN ppvz_for_pay ELSE 0 END) AS forPayReturns,
         SUM(acquiring_fee) AS acquiring,
         SUM(delivery_rub)  AS logistics,
         SUM(CASE WHEN supplier_oper_name='Хранение' THEN storage_fee ELSE 0 END) AS storage,
         SUM(CASE WHEN supplier_oper_name='Удержание'
                       AND bonus_type_name LIKE '%Продвижение%'
                  THEN deduction ELSE 0 END) AS promotion,
         SUM(CASE WHEN supplier_oper_name='Удержание'
                       AND (bonus_type_name LIKE '%Джем%' OR bonus_type_name LIKE '%Premium Plus%')
                  THEN deduction ELSE 0 END) AS subscription,
         SUM(CASE WHEN supplier_oper_name='Штраф' THEN penalty ELSE 0 END) AS penalty,
         -- Прочие «Удержания» (всё, что не продвижение/подписка/баллы за отзывы):
         -- утилизация и разовые операции WB. Разделяем по знаку: положительные —
         -- это удержание с продавца (расход), отрицательные — выплата продавцу
         -- (например «Добровольная выплата за товары, пострадавшие…»). Раньше сюда
         -- попадала только утилизация, а выплаты не учитывались вовсе — деньги,
         -- которые WB перечислил, не показывались нигде.
         SUM(CASE WHEN supplier_oper_name='Удержание'
                       AND bonus_type_name NOT LIKE '%Продвижение%'
                       AND bonus_type_name NOT LIKE '%Джем%'
                       AND bonus_type_name NOT LIKE '%Premium Plus%'
                       AND bonus_type_name NOT LIKE '%Баллы за отзывы%'
                       AND deduction > 0
                  THEN deduction ELSE 0 END) AS deductionOther,
         SUM(CASE WHEN supplier_oper_name='Удержание'
                       AND bonus_type_name NOT LIKE '%Продвижение%'
                       AND bonus_type_name NOT LIKE '%Джем%'
                       AND bonus_type_name NOT LIKE '%Premium Plus%'
                       AND bonus_type_name NOT LIKE '%Баллы за отзывы%'
                       AND deduction < 0
                  THEN deduction ELSE 0 END) AS deductionPayouts,
         SUM(CASE WHEN supplier_oper_name='Удержание'
                       AND bonus_type_name LIKE '%Баллы за отзывы%'
                  THEN deduction ELSE 0 END) AS reviewsStorno,
         SUM(CASE WHEN supplier_oper_name LIKE 'Возмещение издержек по перевозке%'
                       OR supplier_oper_name LIKE 'Возмещение за выдачу%'
                  THEN ppvz_vw ELSE 0 END) AS refunds
       FROM finance_report
       WHERE rr_dt >= ? AND rr_dt <= ?`
    ).get(fromTs, te);

    const costRow = await db.prepare(
      `SELECT COALESCE(SUM(s.quantity * COALESCE(co.cost, 0)), 0) AS v
       FROM finance_report s
       LEFT JOIN LATERAL (
         SELECT cost FROM tenant.cost_overrides
         WHERE nm_id = s.nm_id AND platform = 'wb'
           AND effective_from <= substr(s.rr_dt,1,10)::date
         ORDER BY effective_from DESC LIMIT 1
       ) co ON true
       WHERE s.supplier_oper_name = 'Продажа' AND s.nm_id > 0
         AND s.rr_dt >= ? AND s.rr_dt <= ?`
    ).get(fromTs, te);

    const sales = Number(f.sales) || 0;
    const returns = Number(f.returns) || 0;
    const netSales = sales - Math.abs(returns);
    const costRub = Number(costRow.v) || 0;
    const commission = Math.max(0, netSales - (Number(f.forPaySales) - Math.abs(Number(f.forPayReturns))) - costRub);
    const logistics = Number(f.logistics) || 0;
    const acquiring = Number(f.acquiring) || 0;
    const storage = Number(f.storage) || 0;
    // Кабинетные расходы (№27): WB не привязывает их к SKU.
    const promotion = Number(f.promotion) || 0;
    const subscription = Number(f.subscription) || 0;
    const penalty = Number(f.penalty) || 0;
    const deductionOther = Number(f.deductionOther) || 0;
    // Прочие доходы WB = возмещения (перевозка/ПВЗ) + сторно «Баллы за отзывы»
    // + разовые выплаты продавцу, приходящие как отрицательные «Удержания».
    // WB хранит их отрицательными (приток продавцу) → берём модуль для строки «доход».
    const otherIncome = Math.abs(
      (Number(f.refunds) || 0) + (Number(f.reviewsStorno) || 0) + (Number(f.deductionPayouts) || 0)
    );
    // Налог: УСН (база = выручка без НДС) + НДС (выделение). profit вычитает total.
    // Кабинетные расходы в базу УСН не включаем (они не уменьшают налоговую базу по
    // нашей модели — это платные услуги/подписки, см. обсуждение с хозяином).
    const wbExpenses = costRub + commission + logistics + acquiring + storage;
    const wbTaxCalc = calcTotalTax(wbTax, netSales, wbExpenses);
    const tax = wbTaxCalc.total;
    const vat = wbTaxCalc.vat;

    wb = {
      sales,
      returns: Math.abs(returns),
      netSales,
      cost: costRub,
      commission,
      logistics,
      acquiring,
      storage,
      promotion,
      subscription,
      penalty,
      deductionOther,
      otherIncome,
      tax,
      vat,
      // grossProfit — валовая маржа по SKU (без кабинетных расходов), не менялся.
      grossProfit: netSales - costRub - commission - logistics - acquiring,
      // netProfit теперь реально ниже: вычитаем все кабинетные расходы.
      // otherIncome не входит в каскад (показывается отдельной строкой под чистой).
      netProfit: netSales - costRub - commission - logistics - acquiring
        - storage - promotion - subscription - penalty - deductionOther - tax,
      qtySold: Number(f.qtySold) || 0,
      forPay: (Number(f.forPaySales) || 0) - Math.abs(Number(f.forPayReturns) || 0),
    };
  }

  // Ozon P&L — из order_costs (диапазон по sale_dt как TEXT).
  if (mps.includes("ozon")) {
    const db = new DatabaseSync("ozon", { readOnly: true });
    const f = await db.prepare(
      `SELECT
         COALESCE(SUM(cost_value_retail), 0) AS sales,
         COALESCE(SUM(cost), 0) AS cost,
         COALESCE(SUM(commission), 0) AS commission,
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(acquiring), 0) AS acquiring,
         COALESCE(SUM(profit), 0) AS profit,
         COUNT(*) AS qtySold
       FROM order_costs
       WHERE is_return = 0 AND sale_dt IS NOT NULL
         AND sale_dt >= ? AND sale_dt <= ?`
    ).get(fromTs, te);

    const sales = Number(f.sales) || 0;
    const costRub = Number(f.cost) || 0;
    const commission = Number(f.commission) || 0;
    const logistics = Number(f.logistics) || 0;
    const acquiring = Number(f.acquiring) || 0;
    // Налог: УСН (база = выручка без НДС) + НДС (выделение). profit вычитает total.
    const ozExpenses = costRub + commission + logistics + acquiring;
    const ozTaxCalc = calcTotalTax(ozonTax, sales, ozExpenses);
    const tax = ozTaxCalc.total;
    const vat = ozTaxCalc.vat;
    // grossProfit = выручка − себест − комиссия − логистика − эквайринг (до налога).
    const grossProfit = sales - costRub - commission - logistics - acquiring;

    ozon = {
      sales,
      returns: 0,
      netSales: sales,
      cost: costRub,
      commission,
      logistics,
      acquiring,
      storage: 0,
      // Кабинетные расходы Ozon: источник order_costs их не даёт (нет данных
      // о подписках/штрафах в этой таблице) — вне текущей задачи, держим 0.
      promotion: 0,
      subscription: 0,
      penalty: 0,
      deductionOther: 0,
      otherIncome: 0,
      tax,
      vat,
      grossProfit,
      // netProfit = grossProfit − налог (раньше брали f.profit из БД, без вычета налога).
      netProfit: grossProfit - tax,
      qtySold: Number(f.qtySold) || 0,
      forPay: 0,
    };
  }

  // Объединение WB + Ozon.
  const total = { sales: 0, returns: 0, netSales: 0, cost: 0, commission: 0, logistics: 0, acquiring: 0, storage: 0, promotion: 0, subscription: 0, penalty: 0, deductionOther: 0, otherIncome: 0, tax: 0, vat: 0, grossProfit: 0, netProfit: 0, qtySold: 0, forPay: 0 };
  for (const mp of [wb, ozon]) {
    if (!mp) continue;
    for (const k of Object.keys(total)) total[k] += mp[k] || 0;
  }
  total.margin = total.netSales > 0 ? Math.round((total.netProfit / total.netSales) * 10000) / 100 : 0;
  return { total, wb, ozon };
}

// Разбить [from, to] на календарные отрезки. gran='month' → месяцы,
// 'week' → недели (пн-вс). Возвращает [{label, from, to}].
function splitRange(from, to, gran) {
  const [Y, M, D] = from.split("-").map(Number);
  const start = new Date(Y, M - 1, D);
  const [Y2, M2, D2] = to.split("-").map(Number);
  const end = new Date(Y2, M2 - 1, D2);
  const segs = [];
  const fmtMon = (d) => d.toLocaleDateString("ru-RU", { month: "short", year: "2-digit" });
  const fmtRu = (d) => d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });

  if (gran === "month") {
    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const s = new Date(cur);
      const e = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const fs = s < start ? start : s;
      const fe = e > end ? end : e;
      segs.push({ label: fmtMon(cur), from: ymd(fs), to: ymd(fe) });
      cur.setMonth(cur.getMonth() + 1);
    }
  } else {
    // week: пн-вс. Начинаем с понедельника, содержащего/до start.
    const cur = new Date(start);
    const wd = (cur.getDay() + 6) % 7; // 0=пн
    cur.setDate(cur.getDate() - wd);
    while (cur <= end) {
      const s = new Date(cur);
      const e = new Date(cur);
      e.setDate(s.getDate() + 6);
      const fs = s < start ? start : s;
      const fe = e > end ? end : e;
      segs.push({ label: fmtRu(s), from: ymd(fs), to: ymd(fe) });
      cur.setDate(cur.getDate() + 7);
    }
  }
  return segs;
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mps = cabinet.marketplaces || ["wb", "ozon"];

  // Налоговый режим на каждый МП (per shop / per legal entity).
  const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
  const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);

  // Параметры периода. Приоритет: from/to (диапазон), иначе period (один месяц).
  const breakdown = url.searchParams.get("breakdown") || "none"; // none|week|month
  let from = url.searchParams.get("from") || "";
  let to = url.searchParams.get("to") || "";
  const periodQ = url.searchParams.get("period") || "";

  if (!from || !to) {
    // Обратная совместимость: period=YYYY-MM → один месяц.
    const period = periodQ || new Date().toISOString().slice(0, 7);
    from = period + "-01";
    to = ymd(new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0));
  }

  // Общий итог диапазона.
  const { total, wb, ozon } = await computePnl(from, to, mps, wbTax, ozonTax);

  // Разбивка на отрезки (если запросили).
  let segments = null;
  if (breakdown !== "none") {
    const ranges = splitRange(from, to, breakdown);
    segments = [];
    for (const r of ranges) {
      const res = await computePnl(r.from, r.to, mps, wbTax, ozonTax);
      segments.push({ label: r.label, from: r.from, to: r.to, total: res.total });
    }
  }

  return NextResponse.json({ from, to, breakdown, period: periodQ, total, wb, ozon, segments,
    taxLabel: describeCombinedTaxMode(cabinet.shopTax, { short: true }),
  });
});
