// lib/paymentCalendar.js — чистое ядро платёжного календаря и плана поступлений (15.10.2026,
// спека docs/superpowers/specs/2026-10-15-payment-calendar-design.md). Без БД.
// Даты — строки YYYY-MM-DD, арифметика в UTC (никаких локальных часовых поясов).
import { computeExcel, balanceDueRub } from "./purchaseCalc.js";
import { articleKeyOf } from "./dds.js";

// Статьи — справочник tenant.dds_articles (lib/dds.js SYSTEM_ARTICLES, lib/ddsData.js loadArticles).
// categoryOf оставлен для старых строк без article_key (метка → ключ статьи расхода).
export function categoryOf(category) {
  return articleKeyOf(category, "expense");
}

const r2 = (x) => Math.round(x * 100) / 100;
const D = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const isoDow = (s) => ((D(s).getUTCDay() + 6) % 7) + 1; // 1=Пн … 7=Вс
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12

export function monthGrid(month) {
  const first = month + "-01";
  const [y, m] = month.split("-").map(Number);
  const last = `${month}-${String(lastDay(y, m)).padStart(2, "0")}`;
  let cur = addDays(first, 1 - isoDow(first));
  const weeks = [];
  while (cur <= last) {
    const w = [];
    for (let i = 0; i < 7; i++) { w.push({ date: cur, inMonth: cur.slice(0, 7) === month }); cur = addDays(cur, 1); }
    weeks.push(w);
  }
  return weeks;
}

export function summarize(rows, { today }) {
  let planned = 0, paid = 0, overdue = 0;
  for (const r of rows) {
    const a = Number(r.amount) || 0;
    planned += a;
    if (r.status === "paid") paid += a;
    else if (r.date < today) overdue += a;
  }
  return { planned: r2(planned), paid: r2(paid), left: r2(planned - paid), overdue: r2(overdue) };
}

export function weekSummary(rows) {
  const s = summarize(rows, { today: "0000-00-00" });
  return { total: s.planned, left: s.left };
}

export function expandRecurring(tpl, from, to) {
  const start = tpl.date_from > from ? tpl.date_from : from;
  const end = tpl.date_to && tpl.date_to < to ? tpl.date_to : to;
  const out = [];
  if (start > end) return out;
  if (tpl.rule === "monthly") {
    let [y, m] = start.split("-").map(Number);
    for (;;) {
      const d = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(tpl.rule_day, lastDay(y, m))).padStart(2, "0")}`;
      if (d > end) break;
      if (d >= start) out.push(d);
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  } else if (tpl.rule === "weekly") {
    let d = addDays(start, (tpl.rule_day - isoDow(start) + 7) % 7);
    for (; d <= end; d = addDays(d, 7)) out.push(d);
  } else if (tpl.rule === "every_n_days") {
    const n = Number(tpl.every_n);
    const gap = Math.round((D(start) - D(tpl.date_from)) / 86400000);
    let d = addDays(tpl.date_from, Math.ceil(gap / n) * n);
    for (; d <= end; d = addDays(d, n)) out.push(d);
  }
  return out;
}

const firstDate = (...xs) => {
  for (const x of xs) if (x && /^\d{4}-\d{2}-\d{2}/.test(String(x))) return String(x).slice(0, 10);
  return null;
};

export function purchasePayments(p) {
  const f = computeExcel(p);
  const O = Number(p.qty) > 0 ? Number(p.qty) : 1;
  const fallback = firstDate(p.date) || new Date().toISOString().slice(0, 10);
  const arrival = firstDate(p.delivery_dt, p.plan_arrival_dt);
  const parts = [
    { key: "prepay", article: "supplier", what: "предоплата", amount: f.N, date: firstDate(p.order_dt, p.plan_order_dt) },
    { key: "balance", article: "supplier", what: "остаток", amount: balanceDueRub(f), date: firstDate(p.ship_dt, p.plan_ship_dt) },
    { key: "cargo", article: "cargo", what: "карго до МСК", amount: r2((Number(p.logistics_rub_per_unit) || 0) * O), date: arrival },
    { key: "ff", article: "cargo", what: "МСК→ФФ", amount: r2((Number(p.logistics_rub) || 0) * O), date: arrival },
  ];
  return parts
    .filter((x) => x.amount > 0)
    .map((x) => ({
      key: x.key, ref: `purchase:${p.id}:${x.key}`, article: x.article, amount: r2(x.amount),
      date: x.date || fallback, description: `Партия #${p.id} · ${x.what}`,
    }));
}

export const PAYOUT_DEFAULTS = { wb: { weekday: 3 }, ozon: { day1: 20, day2: 5 } };
const intIn = (v, lo, hi, dflt) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : dflt);

export function readPayoutSettings(settings) {
  const p = settings?.payouts || {};
  return {
    wb: { weekday: intIn(p.wb?.weekday, 1, 7, PAYOUT_DEFAULTS.wb.weekday) },
    ozon: { day1: intIn(p.ozon?.day1, 1, 28, PAYOUT_DEFAULTS.ozon.day1), day2: intIn(p.ozon?.day2, 1, 28, PAYOUT_DEFAULTS.ozon.day2) },
  };
}

// Окна выплат, чья ДАТА ВЫПЛАТЫ попадает в [from, to].
export function wbPayoutWindows(from, to, { weekday }) {
  const out = [];
  // понедельник недели, выплата за которую может прийти в from: окно на 1–2 недели раньше
  let mon = addDays(from, 1 - isoDow(from) - 14);
  for (; ; mon = addDays(mon, 7)) {
    const payDate = addDays(mon, 7 + weekday - 1);
    if (payDate > to) break;
    if (payDate >= from) out.push({ ref: `wb:${mon}`, winFrom: mon, winTo: addDays(mon, 6), payDate });
  }
  return out;
}

export function ozPayoutWindows(from, to, { day1, day2 }) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  m -= 1; if (m < 1) { m = 12; y -= 1; } // начинаем с прошлого месяца: его 16–конец платится в этом
  for (let i = 0; i < 4; i++) {
    const mm = String(m).padStart(2, "0");
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const cand = [
      { ref: `ozon:${y}-${mm}-1`, winFrom: `${y}-${mm}-01`, winTo: `${y}-${mm}-15`, payDate: `${y}-${mm}-${String(day1).padStart(2, "0")}` },
      { ref: `ozon:${y}-${mm}-2`, winFrom: `${y}-${mm}-16`, winTo: `${y}-${mm}-${String(lastDay(y, m)).padStart(2, "0")}`,
        payDate: `${ny}-${String(nm).padStart(2, "0")}-${String(day2).padStart(2, "0")}` },
    ];
    for (const c of cand) if (c.payDate >= from && c.payDate <= to) out.push(c);
    y = ny; m = nm;
  }
  return out.sort((a, b) => a.payDate.localeCompare(b.payDate));
}
