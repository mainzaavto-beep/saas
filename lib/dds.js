// lib/dds.js — чистое ядро ДДС (17.10.2026, спека docs/superpowers/specs/2026-10-17-dds-design.md).
// Без БД. Даты — строки YYYY-MM-DD, арифметика в UTC. Факт = status 'paid'.
const r2 = (x) => Math.round(x * 100) / 100;
const D = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const isoDow = (s) => ((D(s).getUTCDay() + 6) % 7) + 1;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export const NO_ACCOUNT = 0;

export const ACTIVITIES = [
  { key: "operating", label: "Операционная деятельность" },
  { key: "investing", label: "Инвестиционная деятельность" },
  { key: "financing", label: "Финансовая деятельность" },
];

export const ACCOUNT_KINDS = {
  bank_ip: "Р/с ИП", card_person: "Карта физлица", cash: "Касса", mp_wb: "Кабинет WB", mp_ozon: "Кабинет Ozon", other: "Прочее",
};

// Ключи supplier…other и mp — те же, что были у CATEGORIES календаря (цвета сохранены).
export const SYSTEM_ARTICLES = [
  { key: "mp_wb", label: "Выплата WB", direction: "income", activity: "operating", color: "pos" },
  { key: "mp_ozon", label: "Выплата Ozon", direction: "income", activity: "operating", color: "blue" },
  { key: "mp", label: "Выплата МП (прочее)", direction: "income", activity: "operating", color: "pos" },
  { key: "supplier_refund", label: "Возврат от поставщика", direction: "income", activity: "operating", color: "accent" },
  { key: "other_in", label: "Прочие поступления", direction: "income", activity: "operating", color: "line" },
  { key: "supplier", label: "Поставщик", direction: "expense", activity: "operating", color: "pink" },
  { key: "cargo", label: "Карго/логистика", direction: "expense", activity: "operating", color: "blue" },
  { key: "ff", label: "Фулфилмент", direction: "expense", activity: "operating", color: "accent" },
  { key: "tax", label: "Налоги", direction: "expense", activity: "operating", color: "warn" },
  { key: "salary", label: "Зарплата", direction: "expense", activity: "operating", color: "accent2" },
  { key: "rent", label: "Аренда", direction: "expense", activity: "operating", color: "muted" },
  { key: "subs", label: "Подписки", direction: "expense", activity: "operating", color: "faint" },
  { key: "ads", label: "Реклама", direction: "expense", activity: "operating", color: "neg" },
  { key: "other", label: "Прочее", direction: "expense", activity: "operating", color: "line" },
  { key: "equipment", label: "Оборудование", direction: "expense", activity: "investing", color: "muted" },
  { key: "owner_in", label: "Ввод собственника", direction: "income", activity: "financing", color: "accent2" },
  { key: "loan_in", label: "Займ получен", direction: "income", activity: "financing", color: "warn" },
  { key: "owner_out", label: "Вывод собственнику", direction: "expense", activity: "financing", color: "accent2" },
  { key: "loan_out", label: "Погашение займа", direction: "expense", activity: "financing", color: "warn" },
].map((a, i) => ({ ...a, sort: (i + 1) * 10 }));

// Правило = UPDATE … article_key в db/migrations/072 (менять вместе).
const EXPENSE_BY_LABEL = {
  "Поставщик": "supplier", "Закупка": "supplier", "Карго/логистика": "cargo", "Фулфилмент": "ff", "Налоги": "tax",
  "Зарплата": "salary", "ЗП": "salary", "Аренда": "rent", "Подписки": "subs", "Реклама": "ads",
};
export function articleKeyOf(category, type, platform, sourceKind) {
  if (type === "income") {
    if (sourceKind === "mp_payout" && platform === "wb") return "mp_wb";
    if (sourceKind === "mp_payout" && platform === "ozon") return "mp_ozon";
    if (category === "Выплата МП" || category === "Возврат МП") return "mp";
    return "other_in";
  }
  return EXPENSE_BY_LABEL[category] || "other";
}

const WHY = {
  purchase: "сумма, статья и контрагент правятся в закупке (партия или заказ)",
  mp_payout: "сумма выплаты: снимите «получено» и отметьте заново в «Плане поступлений»",
};
export function editRules(row) {
  if (row.source_kind === "purchase" || row.source_kind === "mp_payout") {
    return { amount: false, article: false, counterparty: false, date: true, account: true, comment: true, del: false, why: WHY[row.source_kind] };
  }
  const tr = row.type === "transfer";
  return { amount: true, article: !tr, counterparty: !tr, date: true, account: true, comment: true, del: true, why: null };
}

export function validateDdsMovement(b, { articles, accounts }, { allowArchived = [] } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) return "дата обязательна (YYYY-MM-DD)";
  if (!["income", "expense", "transfer"].includes(b.type)) return "type: income|expense|transfer";
  if (!(Number(b.amount) > 0)) return "сумма должна быть больше 0";
  const allowed = new Set(allowArchived.filter((x) => x != null).map(Number));
  const checkAcc = (id) => {
    const a = accounts.find((x) => Number(x.id) === Number(id));
    if (!a) return `счёт id=${id} не найден`;
    if (a.is_archived && !allowed.has(Number(id))) return `счёт «${a.name}» в архиве`;
    return null;
  };
  if (b.account_id != null) { const e = checkAcc(b.account_id); if (e) return e; }
  if (b.type === "transfer") {
    if (b.account_id == null || b.account_to_id == null) return "у перевода нужны оба счёта";
    if (Number(b.account_id) === Number(b.account_to_id)) return "счета перевода совпадают";
    return checkAcc(b.account_to_id);
  }
  if (b.account_to_id != null) return "счёт назначения — только у перевода";
  if (b.article_key != null) {
    const ar = articles.find((x) => x.key === b.article_key);
    if (!ar) return `статья ${b.article_key} не найдена`;
    if (ar.direction !== b.type) return `статья «${ar.label}» — для ${ar.direction === "income" ? "поступлений" : "списаний"}`;
  }
  return null;
}

const idOrNull = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
export function readDdsSettings(settings) {
  const s = settings?.dds || {};
  return {
    default_account_id: idOrNull(s.default_account_id),
    payout_account: { wb: idOrNull(s.payout_account?.wb), ozon: idOrNull(s.payout_account?.ozon) },
  };
}
export function defaultAccountFor(ds, { platform } = {}) {
  return (platform && ds.payout_account[platform]) || ds.default_account_id || null;
}

const accKey = (id) => (id == null ? NO_ACCOUNT : Number(id));
export function effects(m) {
  const a = Number(m.amount) || 0;
  if (m.type === "income") return [[accKey(m.account_id), a]];
  if (m.type === "expense") return [[accKey(m.account_id), -a]];
  if (m.type === "transfer") return [[accKey(m.account_id), -a], [accKey(m.account_to_id), a]];
  return [];
}

const isFact = (m) => !m.status || m.status === "paid";
const openDate = (a) => String(a.opening_date).slice(0, 10);

// Остаток на НАЧАЛО дня D. Счёт до opening_date — 0; операции раньше opening_date своего счёта не входят
// (стартовый остаток их уже включает). Неизвестный id счёта — в «Счёт не указан».
export function balancesAt(accounts, movements, Dday) {
  const byId = new Map(accounts.map((a) => [Number(a.id), a]));
  const out = new Map([[NO_ACCOUNT, 0]]);
  for (const a of accounts) out.set(Number(a.id), Dday >= openDate(a) ? Number(a.opening_balance) || 0 : 0);
  for (const m of movements) {
    if (!isFact(m) || !(m.date < Dday)) continue;
    for (const [k0, d] of effects(m)) {
      const acc = byId.get(k0);
      const k = acc ? k0 : NO_ACCOUNT;
      if (acc && m.date < openDate(acc)) continue;
      out.set(k, r2((out.get(k) || 0) + d));
    }
  }
  return out;
}
const sumMap = (m) => r2([...m.values()].reduce((s, x) => s + x, 0));

export function periodColumns(from, to, grain, today) {
  const cols = [];
  if (grain === "week") {
    for (let mon = addDays(from, 1 - isoDow(from)); mon <= to; mon = addDays(mon, 7)) {
      const f = mon < from ? from : mon, sun = addDays(mon, 6), t = sun > to ? to : sun;
      cols.push({ key: mon, from: f, to: t, label: `${f.slice(8)}.${f.slice(5, 7)}–${t.slice(8)}.${t.slice(5, 7)}`, partial: t >= today });
    }
    return cols;
  }
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  for (;;) {
    const mm = String(m).padStart(2, "0");
    const mFrom = `${y}-${mm}-01`;
    if (mFrom > to) break;
    const mTo = `${y}-${mm}-${String(lastDay(y, m)).padStart(2, "0")}`;
    const f = mFrom < from ? from : mFrom, t = mTo > to ? to : mTo;
    cols.push({ key: `${y}-${mm}`, from: f, to: t, label: `${MONTHS[m - 1]} ${y}`, partial: t >= today });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return cols;
}

// Report: { columns, groups[{activity,label,income[],expense[],incomeTotal[],expenseTotal[],net[],netTotal}],
//   netFlow[], netFlowTotal, opening[], openingTotal, closing[], closingTotal, adjust[], adjustTotal,
//   byAccount[{id,name,closing[]}] }. Строки статей: {key,label,color,cells[],total}; расходы — положительные числа.
export function buildReport({ articles, accounts, movements, from, to, grain, today }) {
  const columns = periodColumns(from, to, grain, today);
  const n = columns.length;
  const colOf = (date) => columns.findIndex((c) => date >= c.from && date <= c.to);
  const artMap = new Map(articles.map((a) => [a.key, a]));
  const cells = new Map(); // key → {art, cells[]}
  for (const m of movements) {
    if (!isFact(m) || m.type === "transfer") continue;
    const i = colOf(m.date);
    if (i < 0) continue;
    const key = m.article_key || (m.type === "income" ? "other_in" : "other");
    if (!cells.has(key)) {
      const art = artMap.get(key) || { key, label: key, direction: m.type, activity: "operating", color: "line", sort: 9999 };
      cells.set(key, { art, cells: Array(n).fill(0) });
    }
    cells.get(key).cells[i] = r2(cells.get(key).cells[i] + (Number(m.amount) || 0));
  }
  const rowsOf = (activity, direction) => [...cells.values()]
    .filter((x) => x.art.activity === activity && x.art.direction === direction)
    .sort((a, b) => (a.art.sort ?? 0) - (b.art.sort ?? 0) || a.art.label.localeCompare(b.art.label))
    .map((x) => ({ key: x.art.key, label: x.art.label, color: x.art.color, cells: x.cells, total: r2(x.cells.reduce((s, v) => s + v, 0)) }));
  const colSum = (rows) => Array.from({ length: n }, (_, i) => r2(rows.reduce((s, r) => s + r.cells[i], 0)));
  const groups = [];
  for (const a of ACTIVITIES) {
    const income = rowsOf(a.key, "income"), expense = rowsOf(a.key, "expense");
    if (!income.length && !expense.length) continue;
    const incomeTotal = colSum(income), expenseTotal = colSum(expense);
    const net = incomeTotal.map((v, i) => r2(v - expenseTotal[i]));
    groups.push({ activity: a.key, label: a.label, income, expense, incomeTotal, expenseTotal, net, netTotal: r2(net.reduce((s, v) => s + v, 0)) });
  }
  const netFlow = Array.from({ length: n }, (_, i) => r2(groups.reduce((s, g) => s + g.net[i], 0)));
  const startMaps = columns.map((c) => balancesAt(accounts, movements, c.from));
  const endMaps = columns.map((c) => balancesAt(accounts, movements, addDays(c.to, 1)));
  const opening = startMaps.map(sumMap), closing = endMaps.map(sumMap);
  const adjust = closing.map((c, i) => r2(c - opening[i] - netFlow[i]));
  const byAccount = [...accounts.map((a) => ({ id: Number(a.id), name: a.name })), { id: NO_ACCOUNT, name: "Счёт не указан" }]
    .map((a) => ({ ...a, closing: endMaps.map((m) => m.get(a.id) || 0) }))
    .filter((a) => a.id !== NO_ACCOUNT || a.closing.some((v) => v !== 0));
  return {
    columns, groups, netFlow, netFlowTotal: r2(netFlow.reduce((s, v) => s + v, 0)),
    opening, openingTotal: opening[0] ?? 0, closing, closingTotal: closing[n - 1] ?? 0,
    adjust, adjustTotal: r2(adjust.reduce((s, v) => s + v, 0)), byAccount,
  };
}

export function journalTotals(rows) {
  let income = 0, expense = 0;
  for (const r of rows) {
    if (r.type === "income") income += Number(r.amount) || 0;
    else if (r.type === "expense") expense += Number(r.amount) || 0;
  }
  return { income: r2(income), expense: r2(expense), net: r2(income - expense) };
}

export function redactAccounts(accounts, isOwner) {
  if (isOwner) return accounts;
  return accounts.map((a) => ({ id: Number(a.id), name: a.name, kind: a.kind, is_archived: !!a.is_archived }));
}
const OWNER_REPORT_KEYS = ["opening", "openingTotal", "closing", "closingTotal", "adjust", "adjustTotal", "byAccount"];
export function redactReport(report, isOwner) {
  if (isOwner) return report;
  const out = { ...report };
  for (const k of OWNER_REPORT_KEYS) delete out[k];
  return out;
}
