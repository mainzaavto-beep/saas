#!/usr/bin/env node
// scripts/smoke-dds.mjs — смоук ДДС (журнал, отчёт, счета, статьи) (17.10.2026).
// Проверяет:
//   1) отчёт и журнал месяца с фактом (последний месяц с paid-строками, не обязательно текущий —
//      на кабинете #1 сентябрь/октябрь бывают пустыми, сверка 0=0 ничего не доказывает) сходятся
//      (поступления/списания);
//   2) конец периода N = начало N+1; начало + поток + adjust = конец;
//   3) Σ остатков на сегодня = Σ стартов счетов + Σ движения (прямым SQL, с правилом opening_date);
//   4) оплаченные расходы месяца с фактом в платёжном календаре = выбытия отчёта за тот же месяц;
//   5) у каждой paid-строки есть статья, либо это перевод;
//   6) (только кабинет #1, обратимо) перевод и попытка операции с чужой статьёй: create → в журнале → delete.
// Аутентификация — sealed-cookie, как scripts/smoke-payment-calendar.mjs.
// Запуск: node scripts/smoke-dds.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query, withTenant, tenantQuery } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
const tq = (sql, params = []) => withTenant(CAB, () => tenantQuery(sql, params));

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  if (!cond) failed++;
};
const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
const cookie = `saas_session=${encodeURIComponent(seal)}`;
const get = async (path) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { headers: { cookie } });
  return { status: r.status, data: await r.json() };
};

const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const lastOf = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const nextOf = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };
const r2 = (x) => Math.round(x * 100) / 100;

// Месяц с фактом: на кабинете #1 сентябрь/октябрь бывают без paid-строк (проверка 0=0 ничего не
// доказывала, ревью 17.10.2026) — берём последний месяц, где paid-строки реально есть.
const [{ m: lastPaidMonth }] = await tq(`SELECT max(substr(date,1,7)) AS m FROM tenant.dds_movements WHERE status = 'paid'`);
check('есть месяц с оплаченными строками', !!lastPaidMonth, { lastPaidMonth });
const month = lastPaidMonth || today.slice(0, 7);
const nextMonth = nextOf(month);
console.log(`месяц с фактом: ${month}`);

// 1) отчёт и журнал месяца с фактом сходятся (report охватывает month+nextMonth — второй столбец
// нужен ниже проверке 2 для «конец N = начало N+1»)
const rep = await get(`dds?view=report&from=${month}-01&to=${lastOf(nextMonth)}&grain=month`);
check('report 200', rep.status === 200, rep.data);
const jr = await get(`dds?view=journal&from=${month}-01&to=${lastOf(month)}`);
check('journal 200', jr.status === 200, jr.data);
const inc = r2(rep.data.groups.reduce((s, g) => s + g.incomeTotal[0], 0));
const exp = r2(rep.data.groups.reduce((s, g) => s + g.expenseTotal[0], 0));
check('журнал месяца с фактом = колонка отчёта (поступления)', Math.abs(inc - jr.data.totals.income) < 0.01, { inc, j: jr.data.totals.income });
check('журнал месяца с фактом = колонка отчёта (списания)', Math.abs(exp - jr.data.totals.expense) < 0.01, { exp, j: jr.data.totals.expense });

// 2) конец N = начало N+1; начало + поток + вне статей = конец
check('конец месяца с фактом = начало следующего', Math.abs(rep.data.closing[0] - rep.data.opening[1]) < 0.01, rep.data);
check('начало + поток + adjust = конец', rep.data.columns.every((_, i) =>
  Math.abs(rep.data.opening[i] + rep.data.netFlow[i] + rep.data.adjust[i] - rep.data.closing[i]) < 0.01));

// 3) Σ остатков на сегодня = Σ стартов + Σ движения (прямым SQL, с правилом opening_date)
const refs = await get('dds-refs');
const sumBal = r2(Object.values(refs.data.balances).reduce((s, x) => s + x, 0));
const [{ s }] = await tq(`
  WITH a AS (SELECT id, opening_balance, opening_date::text AS od FROM tenant.dds_accounts),
  e AS (
    SELECT m.account_id AS acc, m.date, CASE m.type WHEN 'income' THEN m.amount ELSE -m.amount END AS d FROM tenant.dds_movements m WHERE m.status='paid'
    UNION ALL SELECT m.account_to_id, m.date, m.amount FROM tenant.dds_movements m WHERE m.status='paid' AND m.type='transfer')
  SELECT ((SELECT COALESCE(SUM(opening_balance),0) FROM a WHERE od <= $1)
        + (SELECT COALESCE(SUM(e.d),0) FROM e LEFT JOIN a ON a.id = e.acc WHERE e.date <= $1 AND (a.id IS NULL OR e.date >= a.od)))::float8 AS s`, [today]);
check('Σ остатков = Σ стартов + Σ движения', Math.abs(sumBal - s) < 0.01, { sumBal, s });

// 4) оплаченные расходы месяца с фактом в календаре = выбытия отчёта за тот же месяц
const cal = await get(`payment-calendar?month=${month}&kind=expense`);
check('календарь: оплачено = выбытия отчёта месяца с фактом', Math.abs(cal.data.totals.paid - r2(rep.data.groups.reduce((s, g) => s + g.expenseTotal[0], 0))) < 0.01,
  { cal: cal.data.totals.paid });

// 5) у каждой paid-строки есть статья либо это перевод
const [{ n }] = await tq(`SELECT COUNT(*)::int AS n FROM tenant.dds_movements WHERE status='paid' AND type<>'transfer' AND article_key IS NULL`);
check('paid без статьи = 0', n === 0, { n });

// 6) (только кабинет #1, обратимо) перевод и ручная операция: create → в журнале → delete
if (CAB === 1 && refs.data.accounts.filter((a) => !a.is_archived).length >= 2) {
  const [a1, a2] = refs.data.accounts.filter((a) => !a.is_archived);
  const post = async (body) => { const r = await fetch(`${BASE}/api/cabinets/${CAB}/dds`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const t = await post({ action: 'create', type: 'transfer', date: today, amount: 1.23, account_id: a1.id, account_to_id: a2.id, description: 'smoke-dds' });
  check('перевод создан', t.status === 200 && t.data.id, t.data);
  const before = sumBal;
  const after = r2(Object.values((await get('dds-refs')).data.balances).reduce((s, x) => s + x, 0));
  check('перевод не меняет Σ остатков', Math.abs(after - before) < 0.01, { before, after });
  const bad = await post({ action: 'create', type: 'expense', date: today, amount: 5, article_key: 'mp_wb' });
  check('статья чужого направления → 400', bad.status === 400, bad.data);
  const d = await post({ action: 'delete', id: t.data.id });
  check('перевод удалён', d.status === 200, d.data);
  const [{ arch }] = await tq(`SELECT (status='archived') AS arch FROM tenant.dds_movements WHERE id=$1`, [t.data.id]);
  check('перевод в архиве', arch === true);
}

console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
