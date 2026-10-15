#!/usr/bin/env node
// scripts/smoke-payment-calendar.mjs — смоук платёжного календаря и плана поступлений (15.10.2026).
// Проверяет:
//   1) GET expense/income 200; Σ строк API месяца = Σ dds_movements (не-архивных) за месяц в БД;
//      недели по 7 дней, начинаются с понедельника;
//   2) платежи партий закупок: ≤4 строк на партию; Σ платежей ПОЛНОСТЬЮ planned-партии = calc_Z
//      (пропускаем партии с отрицательным остатком — лог «balance»-плечо туда не попадает по дизайну,
//      см. lib/paymentCalendar.js purchasePayments: .filter(x => x.amount > 0));
//   3) повторная раскладка повторов не плодит новых строк (идемпотентность по source_ref);
//   4) (только кабинет #1, обратимо) create → mark_paid → unmark → delete.
// Аутентификация — sealed-cookie, как scripts/smoke-deliveries.mjs.
// Запуск: node scripts/smoke-payment-calendar.mjs [cabinetId=1] [baseUrl]
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
const post = async (body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/payment-calendar`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

const month = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
for (const kind of ['expense', 'income']) {
  const r = await get(`payment-calendar?month=${month}&kind=${kind}`);
  check(`GET ${kind} 200`, r.status === 200, r.data);
  const items = r.data.weeks.flatMap((w) => w.days).flatMap((d) => d.items).filter((x) => x.date.slice(0, 7) === month && x.id);
  const [{ s }] = await tq(`SELECT COALESCE(SUM(amount),0)::float8 AS s FROM tenant.dds_movements
     WHERE status <> 'archived' AND type = $1 AND substr(date,1,7) = $2`, [kind, month]);
  const fromApi = Math.round(items.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  check(`${kind}: Σ строк API = Σ dds_movements за месяц`, Math.abs(fromApi - s) < 0.01, { fromApi, s });
  check(`${kind}: недели по 7 дней, начинаются с понедельника`,
    r.data.weeks.every((w) => w.days.length === 7 && new Date(w.days[0].date + 'T00:00:00Z').getUTCDay() === 1));
}

// платежи партий: ≤4 на партию, Σ planned-строк полностью-плановой партии = calc_Z
// (партии с calc_balance_due < 0 пропускаем — лог «остаток» не создаётся вовсе, т.к.
// purchasePayments отфильтровывает неположительные суммы по дизайну — сумма строк тогда
// заведомо меньше Z, это не баг).
// ?archived=1 — у кабинета #1 все партии завершены («Доставлено на склад», часть 1 модуля);
// без этого параметра /purchases отдаёт пустой список и проверка вообще не выполняется.
const pur = await get('purchases?archived=1');
for (const p of pur.data.items.slice(0, 20)) {
  const rows = await tq(`SELECT amount::float8 AS a, status FROM tenant.dds_movements
     WHERE source_kind='purchase' AND source_ref LIKE $1 AND status <> 'archived'`, [`purchase:${p.id}:%`]);
  check(`партия ${p.id}: ≤4 платежей`, rows.length <= 4, rows.length);
  if (rows.length && rows.every((x) => x.status === 'planned') && Number(p.calc_balance_due) >= 0) {
    const s = Math.round(rows.reduce((a, x) => a + x.a, 0) * 100) / 100;
    check(`партия ${p.id}: Σ платежей = Z`, Math.abs(s - p.calc_Z) < 0.05, { s, Z: p.calc_Z });
  }
}

// повторная раскладка не добавляет строк
const cnt = async () => (await tq(`SELECT count(*)::int AS n FROM tenant.dds_movements WHERE source_kind='recurring' AND status<>'archived'`))[0].n;
const n1 = await cnt(); await get(`payment-calendar?month=${month}&kind=expense`); const n2 = await cnt();
check('повторы идемпотентны', n1 === n2, { n1, n2 });

// (только #1, обратимо) create → mark_paid → unmark → delete
if (CAB === 1) {
  const c = await post({ action: 'create', type: 'expense', date: `${month}-28`, amount: 1.23, category: 'Прочее', description: 'smoke' });
  check('create', c.status === 200 && c.data.id, c.data);
  check('mark_paid', (await post({ action: 'mark_paid', id: c.data.id })).status === 200);
  check('unmark', (await post({ action: 'unmark', id: c.data.id })).status === 200);
  check('delete', (await post({ action: 'delete', id: c.data.id })).status === 200);
}

console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
