// =====================================================================
//  lib/calendarCalc.js — платёжный календарь: автономный JS-расчёт (2026-06-27).
//
//  Перенос эталона `financial_agent/fin/payment_calendar.py:build_calendar`
//  на JavaScript, чтобы дашборд стал автономным (решение #137 в чистом виде).
//  Python остаётся как эталон для периодической сверки (?engine=python).
//
//  Контракт (тот же, что у Python): {
//    start_date, starting_balance, weeks:[{
//      week, fact_income, fact_expense, plan_income, plan_expense,
//      net, cumulative, at_risk }]
//  }
//
//  Формулы (дословно из payment_calendar.py + purchase_outflow.py):
//   • starting = Σ(income) − Σ(expense) из bank_transactions WHERE status='paid'
//   • fact_inc/fact_exp по неделям из paid bank_transactions за горизонт
//   • plan_exp = concrete(purchase_payments) IF >0 ELSE budget(purchase_plan)
//     (правило «заменить, не сложить», №2026-06-24)
//   • plan_inc = sales_plan.revenue × (1 − commissionRate), со сдвигом +1 месяц,
//     поровну на число понедельников месяца поступления
//   • net = (fact_inc+plan_inc) − (fact_exp+plan_exp)
//   • cumulative = starting + Σ net (нарастающим)
//   • at_risk = cumulative < 0
//
//  Константы: DEFAULT_COMMISSION_RATE=0.25, окно комиссий = 3 мес,
//  валидация ставки 0 < rate ≤ 0.6.
//
//  ЧИСТАЯ функция на чтение — НЕ пишет в БД.
// =====================================================================

import { getFinDb } from "./finDb.js";

const FIN_DB_PATH = process.env.FIN_DB_PATH || "/opt/agentsDB/fin_data.db";
const WB_DB_PATH = process.env.WB_DB_PATH || "/opt/agentsDB/wb_data.db";

const DEFAULT_COMMISSION_RATE = 0.25; // payment_calendar.py:24
const MONTHS_BACK_COMMISSION = 3; // payment_calendar.py:62,66
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

// ---------------- Дата-хелперы (JS Date → ISO-понедельники) ----------------

/** ISO 'YYYY-MM-DD' → Date (локальная полночь). */
async function isoToDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
/** Date → ISO 'YYYY-MM-DD'. */
async function dateToIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
/** ISO даты → ISO её понедельника (как python: d - timedelta(days=d.weekday())). */
async function mondayOfIso(iso) {
  const d = isoToDate(iso);
  const wd = d.getDay(); // 0=Sun..6=Sat → python weekday(): 0=Mon..6=Sun
  const pyWeekday = (wd + 6) % 7; // Mon=0..Sun=6
  d.setDate(d.getDate() - pyWeekday);
  return dateToIso(d);
}
async function todayIso() {
  return dateToIso(new Date());
}
/** Понедельники, начинающиеся в указанном месяце (для распределения payout).
 *  Дословный перенос _weeks_in_month (payment_calendar.py:50-59). */
async function weeksInMonth(year, month /* 1..12 */) {
  const weeks = [];
  let d = isoToDate(mondayOfIso(`${year}-${String(month).padStart(2, "0")}-01`));
  // Сдвигаем до входа в целевой месяц (как python: while d.month < month: d += 7)
  while (d.getMonth() + 1 < month) d.setDate(d.getDate() + 7);
  while (d.getMonth() + 1 === month) {
    weeks.push(dateToIso(d));
    d.setDate(d.getDate() + 7);
  }
  return weeks;
}

// ---------------- Чтение источников ----------------

/** {nm_id: rate} из wb_data.db.finance_report за последние N мес.
 *  Валидация: 0 < rate ≤ 0.6 (payment_calendar.py:62-85). */
async function commissionRates() {
  const rates = {};
  const cutoff = new Date();
  cutoff.setDate(1);
  cutoff.setDate(cutoff.getDate() - MONTHS_BACK_COMMISSION * 31);
  const cutoffIso = dateToIso(cutoff);
  let db = null;
  try {
    db = new DatabaseSync(WB_DB_PATH, { readOnly: true });
    const rows = await db
      .prepare(
        `SELECT nm_id,
                  SUM(ppvz_sales_commission) AS comm,
                  SUM(CASE WHEN retail_amount > 0 THEN retail_amount ELSE 0 END) AS sales
           FROM finance_report
           WHERE rr_dt >= ? AND nm_id > 0
           GROUP BY nm_id`
      )
      .all(cutoffIso);
    for (const r of rows) {
      const sales = Number(r.sales);
      if (sales && sales > 0) {
        const rate = round4(Number(r.comm) / sales);
        if (rate > 0 && rate <= 0.6) rates[r.nm_id] = rate;
      }
    }
  } catch {
    // БД недоступна / нет таблицы → пустые ставки (fallback на DEFAULT).
  } finally {
    if (db) db.close();
  }
  return rates;
}

/** Сальдо paid bank_transactions — стартовый баланс (payment_calendar.py:97-101). */
async function startingBalance(db) {
  const rows = await db
    .prepare(`SELECT type, amount FROM bank_transactions WHERE status = 'paid'`)
    .all();
  let s = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    s += r.type === "income" ? amt : -amt;
  }
  return round2(s);
}

/** {week_iso: amount} агрегация paid bank_transactions за горизонт (payment_calendar.py:108-118). */
async function factByWeek(db, weekIsoSet, startIso) {
  const inc = {};
  const exp = {};
  const rows = await db
    .prepare(`SELECT date, type, amount, status FROM bank_transactions WHERE date >= ?`)
    .all(startIso);
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

/** {week_iso: amount} расход на закупки по правилу concrete-if-else-budget
 *  (purchase_outflow.py:purchase_outflow_by_week). */
async function planExpenseByWeek(db, weekFromIso, weekToIso) {
  // БЮДЖЕТ: purchase_plan type=purchase, status=active.
  const budget = {};
  const planRows = await db
    .prepare(
      `SELECT week, amount, type, status FROM purchase_plan
       WHERE week >= ? AND week <= ?`
    )
    .all(weekFromIso, weekToIso);
  for (const r of planRows) {
    if (r.type === "purchase" && r.status === "active") {
      budget[r.week] = (budget[r.week] || 0) + (Number(r.amount) || 0);
    }
  }
  // CONCRETE: purchase_payments status=planned по due_dt → по неделям.
  const concrete = {};
  let pays = [];
  try {
    pays = await db
      .prepare(`SELECT due_dt, amount, status FROM purchase_payments WHERE status = 'planned'`)
      .all();
  } catch {
    pays = []; // таблицы нет → concrete пусто → откат к budget.
  }
  for (const pp of pays) {
    if (!pp.due_dt) continue;
    const wk = mondayOfIso(pp.due_dt);
    if (weekFromIso && wk < weekFromIso) continue;
    if (weekToIso && wk > weekToIso) continue;
    concrete[wk] = (concrete[wk] || 0) + (Number(pp.amount) || 0);
  }
  // Склейка: concrete если >0, иначе budget.
  const out = {};
  const allWeeks = new Set([...Object.keys(budget), ...Object.keys(concrete)]);
  for (const wk of allWeeks) {
    const c = concrete[wk] || 0;
    out[wk] = c > 0 ? c : budget[wk] || 0;
  }
  return out;
}

/** {week_iso: amount} поступления от продаж: sales_plan × (1−rate), сдвиг +1 мес,
 *  поровну на число понедельников месяца поступления (payment_calendar.py:130-146). */
async function planIncomeByWeek(db, weekIsoSet) {
  const out = {};
  const rates = commissionRates();
  let rows = [];
  try {
    rows = await db
      .prepare(`SELECT period, nm_id, revenue_plan, status FROM sales_plan WHERE status != 'archived'`)
      .all();
  } catch {
    rows = [];
  }
  for (const r of rows) {
    const nm = r.nm_id;
    const rev = Number(r.revenue_plan) || 0;
    if (rev <= 0 || nm == null) continue;
    const rate = rates[nm] != null ? rates[nm] : DEFAULT_COMMISSION_RATE;
    const payout = rev * (1 - rate);
    // Период поступления = месяц продажи + 1.
    const [yStr, mStr] = String(r.period).split("-");
    let y = Number(yStr);
    let m = Number(mStr);
    if (m === 12) {
      y += 1;
      m = 1;
    } else {
      m += 1;
    }
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

/** Склейка платёжного календаря. Перенос build_calendar (payment_calendar.py:88-166).
 *  todayIsoArg — для тестов; по умолчанию сегодня. */
export async function buildCalendar(horizonWeeks = 8, todayIsoArg = null) {
  if (!Number.isFinite(horizonWeeks) || horizonWeeks < 1) horizonWeeks = 8;
  horizonWeeks = Math.min(Math.round(horizonWeeks), 26);

  const today = todayIsoArg || todayIso();
  const startWeekIso = mondayOfIso(today);

  // Сетка недель: [startWeek, startWeek+7, ...].
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

  // Все чтения fin_data.db — одно соединение RO.
  const db = getFinDb();
  try {
    const starting = startingBalance(db);
    const { inc: factInc, exp: factExp } = factByWeek(db, weekIsoSet, startIso);
    const planExp = planExpenseByWeek(db, startIso, lastWeekIso);
    const planInc = planIncomeByWeek(db, weekIsoSet);

    // Сборка недель (payment_calendar.py:148-161).
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
  } finally {
    db.close();
  }
}
