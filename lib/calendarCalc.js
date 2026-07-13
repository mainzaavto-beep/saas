// =====================================================================
//  lib/calendarCalc.js — платёжный календарь: автономный JS-расчёт.
//  SAAS-версия: читает tenant.* через tenantQuery (PG+RLS),
//  ставки комиссий — через DatabaseSync('wb').
//
//  Перенос data-presenter/lib/calendarCalc.js (293 строки).
//  Чистая функция на чтение — НЕ пишет в БД.
// =====================================================================

import { tenantQuery, DatabaseSync } from "./db.js";

const DEFAULT_COMMISSION_RATE = 0.25;
const MONTHS_BACK_COMMISSION = 3;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

// ---------------- Дата-хелперы ----------------
function isoToDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function dateToIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function mondayOfIso(iso) {
  const d = isoToDate(iso);
  const wd = d.getDay();
  const pyWeekday = (wd + 6) % 7;
  d.setDate(d.getDate() - pyWeekday);
  return dateToIso(d);
}
function todayIso() {
  return dateToIso(new Date());
}
function weeksInMonth(year, month) {
  const weeks = [];
  let d = isoToDate(mondayOfIso(`${year}-${String(month).padStart(2, "0")}-01`));
  while (d.getMonth() + 1 < month) d.setDate(d.getDate() + 7);
  while (d.getMonth() + 1 === month) {
    weeks.push(dateToIso(d));
    d.setDate(d.getDate() + 7);
  }
  return weeks;
}

// ---------------- Чтение источников ----------------

/** {nm_id: rate} из tenant.wb_finance_report за последние N мес. */
async function commissionRates() {
  const rates = {};
  const cutoff = new Date();
  cutoff.setDate(1);
  cutoff.setDate(cutoff.getDate() - MONTHS_BACK_COMMISSION * 31);
  const cutoffIso = dateToIso(cutoff);
  try {
    const db = new DatabaseSync("wb", { readOnly: true });
    const rows = await db.prepare(
      `SELECT nm_id,
              SUM(ppvz_sales_commission) AS comm,
              SUM(CASE WHEN retail_amount > 0 THEN retail_amount ELSE 0 END) AS sales
       FROM finance_report
       WHERE rr_dt >= ? AND nm_id > 0
       GROUP BY nm_id`
    ).all(cutoffIso);
    for (const r of rows) {
      const sales = Number(r.sales);
      if (sales && sales > 0) {
        const rate = round4(Number(r.comm) / sales);
        if (rate > 0 && rate <= 0.6) rates[r.nm_id] = rate;
      }
    }
  } catch {}
  return rates;
}

/** Сальдо paid bank_transactions — стартовый баланс. */
async function startingBalance() {
  const rows = await tenantQuery(
    `SELECT type, amount FROM tenant.bank_transactions WHERE status = 'paid'`
  );
  let s = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    s += r.type === "income" ? amt : -amt;
  }
  return round2(s);
}

/** {week_iso: amount} агрегация paid bank_transactions за горизонт. */
async function factByWeek(weekIsoSet, startIso) {
  const inc = {};
  const exp = {};
  const rows = await tenantQuery(
    `SELECT date, type, amount, status FROM tenant.bank_transactions WHERE date >= $1`,
    [startIso]
  );
  for (const t of rows) {
    if (t.status !== "paid") continue;
    const wk = mondayOfIso(t.date);
    if (!weekIsoSet.has(wk)) continue;
    const amt = Number(t.amount) || 0;
    if (t.type === "income") inc[wk] = (inc[wk] || 0) + amt;
    else exp[wk] = (exp[wk] || 0) + amt;
  }
  return { inc, exp };
}

/** {week_iso: amount} расход на закупки: concrete-if-else-budget. */
async function planExpenseByWeek(weekFromIso, weekToIso) {
  const budget = {};
  const planRows = await tenantQuery(
    `SELECT week, amount, type, status FROM tenant.purchase_plan WHERE week >= $1 AND week <= $2`,
    [weekFromIso, weekToIso]
  );
  for (const r of planRows) {
    if (r.type === "purchase" && r.status === "active") {
      budget[r.week] = (budget[r.week] || 0) + (Number(r.amount) || 0);
    }
  }
  const concrete = {};
  let pays = [];
  try {
    pays = await tenantQuery(
      `SELECT due_dt, amount, status FROM tenant.purchase_payments WHERE status = 'planned'`
    );
  } catch {}
  for (const pp of pays) {
    if (!pp.due_dt) continue;
    const wk = mondayOfIso(pp.due_dt);
    if (weekFromIso && wk < weekFromIso) continue;
    if (weekToIso && wk > weekToIso) continue;
    concrete[wk] = (concrete[wk] || 0) + (Number(pp.amount) || 0);
  }
  const out = {};
  const allWeeks = new Set([...Object.keys(budget), ...Object.keys(concrete)]);
  for (const wk of allWeeks) {
    const c = concrete[wk] || 0;
    out[wk] = c > 0 ? c : budget[wk] || 0;
  }
  return out;
}

/** {week_iso: amount} поступления от продаж: sales_plan × (1−rate), сдвиг +1 мес. */
async function planIncomeByWeek(weekIsoSet) {
  const out = {};
  const rates = await commissionRates();
  let rows = [];
  try {
    rows = await tenantQuery(
      `SELECT period, nm_id, revenue_plan, status FROM tenant.sales_plan WHERE status != 'archived'`
    );
  } catch {}
  for (const r of rows) {
    const nm = r.nm_id;
    const rev = Number(r.revenue_plan) || 0;
    if (rev <= 0 || nm == null) continue;
    const rate = rates[nm] != null ? rates[nm] : DEFAULT_COMMISSION_RATE;
    const payout = rev * (1 - rate);
    const [yStr, mStr] = String(r.period).split("-");
    let y = Number(yStr);
    let m = Number(mStr);
    if (m === 12) { y += 1; m = 1; } else { m += 1; }
    const weeks = weeksInMonth(y, m);
    for (const iso of weeks) {
      if (weekIsoSet.has(iso)) {
        out[iso] = (out[iso] || 0) + payout / weeks.length;
      }
    }
  }
  return out;
}

// ---------------- Главная функция ----------------
export async function buildCalendar(horizonWeeks = 8, todayIsoArg = null) {
  if (!Number.isFinite(horizonWeeks) || horizonWeeks < 1) horizonWeeks = 8;
  horizonWeeks = Math.min(Math.round(horizonWeeks), 26);

  const today = todayIsoArg || todayIso();
  const startWeekIso = mondayOfIso(today);

  const allWeeks = [];
  const startDate = isoToDate(startWeekIso);
  for (let i = 0; i < horizonWeeks; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i * 7);
    allWeeks.push(dateToIso(d));
  }
  const weekIsoSet = new Set(allWeeks);
  const startIso = allWeeks[0];
  const lastWeekIso = allWeeks[allWeeks.length - 1];

  const starting = await startingBalance();
  const { inc: factInc, exp: factExp } = await factByWeek(weekIsoSet, startIso);
  const planExp = await planExpenseByWeek(startIso, lastWeekIso);
  const planInc = await planIncomeByWeek(weekIsoSet);

  let cumulative = starting;
  const weeks = [];
  for (const iso of allWeeks) {
    const fi = factInc[iso] || 0;
    const fe = factExp[iso] || 0;
    const pi = planInc[iso] || 0;
    const pe = planExp[iso] || 0;
    const net = fi + pi - fe - pe;
    cumulative += net;
    weeks.push({
      week: iso,
      fact_income: round2(fi),
      fact_expense: round2(fe),
      plan_income: round2(pi),
      plan_expense: round2(pe),
      net: round2(net),
      cumulative: round2(cumulative),
      at_risk: cumulative < 0,
    });
  }

  return {
    start_date: today,
    starting_balance: starting,
    weeks,
  };
}
