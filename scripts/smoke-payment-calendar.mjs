#!/usr/bin/env node
// scripts/smoke-payment-calendar.mjs — смоук платёжного календаря и плана поступлений (15.10.2026).
// Проверяет:
//   1) GET expense/income 200; Σ строк API месяца = Σ dds_movements (не-архивных) за месяц в БД;
//      недели по 7 дней, начинаются с понедельника;
//   2) платежи партий закупок (активные + архивные, дедуп по id): ≤4 строк на партию; Σ платежей
//      ПОЛНОСТЬЮ planned-партии = calc_Z (пропускаем партии с отрицательным остатком — лог
//      «balance»-плечо туда не попадает по дизайну, см. lib/paymentCalendar.js purchasePayments:
//      .filter(x => x.amount > 0));
//   3) (только кабинет #1, обратимо) шаблон повтора: recurring_save → GET материализует 1..4
//      planned-строки → повтор GET не плодит новых → удалённая дата не возвращается, правленная
//      «только эту» не дублируется, правка шаблона пересоздаёт неправленные строки → recurring_delete
//      архивирует будущие planned;
//      create → mark_paid → unmark → delete.
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
  check(`${kind}: canEdit=true для владельца`, r.data.canEdit === true, r.data.canEdit);
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
// Активные и архивные — ОБА списка: у кабинета #1 сейчас все партии архивны («Доставлено
// на склад», часть 1 модуля), но без ?archived=1 активные партии других кабинетов/будущего
// состояния пропали бы из проверки молча. Дедуп по id (партия не бывает в обоих списках).
const [purActive, purArchived] = await Promise.all([get('purchases'), get('purchases?archived=1')]);
const purById = new Map([...(purActive.data.items || []), ...(purArchived.data.items || [])].map((p) => [p.id, p]));
for (const p of [...purById.values()].slice(0, 20)) {
  const rows = await tq(`SELECT amount::float8 AS a, status FROM tenant.dds_movements
     WHERE source_kind='purchase' AND source_ref LIKE $1 AND status <> 'archived'`, [`purchase:${p.id}:%`]);
  check(`партия ${p.id}: ≤4 платежей`, rows.length <= 4, rows.length);
  if (rows.length && rows.every((x) => x.status === 'planned') && Number(p.calc_balance_due) >= 0) {
    const s = Math.round(rows.reduce((a, x) => a + x.a, 0) * 100) / 100;
    check(`партия ${p.id}: Σ платежей = Z`, Math.abs(s - p.calc_Z) < 0.05, { s, Z: p.calc_Z });
  }
}

// (только #1, обратимо) create → mark_paid → unmark → delete; шаблон повтора — реальная
// идемпотентность (на #1 шаблонов 0, пустой count ничего бы не проверял) + отмена.
if (CAB === 1) {
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const rc = await post({ action: 'recurring_save', type: 'expense', amount: 1.11, category: 'Прочее',
    description: 'smoke-recurring', rule: 'monthly', rule_day: 28, date_from: today });
  check('recurring_save', rc.status === 200 && rc.data.id, rc.data);
  const rcId = rc.data.id;
  const countRecurring = async () => (await tq(
    `SELECT count(*)::int AS n FROM tenant.dds_movements WHERE source_ref LIKE $1 AND status <> 'archived'`,
    [`recurring:${rcId}:%`]))[0].n;
  await get(`payment-calendar?month=${month}&kind=expense`); // материализует шаблон в dds_movements
  const r1 = await countRecurring();
  check('recurring: материализовано 1..4 строки', r1 >= 1 && r1 <= 4, r1);
  await get(`payment-calendar?month=${month}&kind=expense`); // повтор — не плодит новых строк
  const r2 = await countRecurring();
  check('recurring: повторная раскладка не плодит строк', r1 === r2, { r1, r2 });

  // C1: удалённая дата не возвращается, «изменить только этот» не дублирует, правка шаблона
  // пересоздаёт неправленные строки по новому правилу и не трогает правленную.
  const occ = await tq(`SELECT id::int AS id, date, source_ref FROM tenant.dds_movements
     WHERE source_ref LIKE $1 AND status <> 'archived' ORDER BY date`, [`recurring:${rcId}:%`]);
  const refRows = (ref) => tq(`SELECT status, source_kind FROM tenant.dds_movements WHERE source_ref = $1`, [ref]);
  if (occ.length >= 2) {
    const [A, B] = occ;
    check('recurring: delete одной даты', (await post({ action: 'delete', id: A.id })).status === 200);
    await get(`payment-calendar?month=${A.date.slice(0, 7)}&kind=expense`);
    const ra = await refRows(A.source_ref);
    check('recurring: удалённая дата не вернулась после GET', ra.length === 1 && ra[0].status === 'archived', ra);
    check('recurring: update одной даты (сумма)', (await post({ action: 'update', id: B.id, amount: 2.22 })).status === 200);
    await get(`payment-calendar?month=${B.date.slice(0, 7)}&kind=expense`);
    const rb = (await refRows(B.source_ref)).filter((x) => x.status !== 'archived');
    check('recurring: правленная дата — ровно одна строка', rb.length === 1 && rb[0].source_kind === 'manual', rb);
    // правка шаблона: день 28 → 27
    const sv = await post({ action: 'recurring_save', id: rcId, type: 'expense', amount: 1.11, category: 'Прочее',
      description: 'smoke-recurring', rule: 'monthly', rule_day: 27, date_from: today });
    check('recurring_save (правка шаблона)', sv.status === 200, sv.data);
    await get(`payment-calendar?month=${month}&kind=expense`);
    const regen = await tq(`SELECT date, source_kind FROM tenant.dds_movements
       WHERE source_ref LIKE $1 AND status <> 'archived'`, [`recurring:${rcId}:%`]);
    const gen = regen.filter((x) => x.source_kind === 'recurring');
    check('recurring: правка шаблона пересоздала строки по новому правилу',
      gen.length >= 1 && gen.every((x) => x.date.slice(8) === '27'), regen);
    check('recurring: правленная строка пережила правку шаблона',
      (await refRows(B.source_ref)).filter((x) => x.status !== 'archived').length === 1);
    check('cleanup: delete правленной строки', (await post({ action: 'delete', id: B.id })).status === 200);
  } else check('recurring: ≥2 строк для проверки delete/update', false, occ.length);
  check('recurring_delete', (await post({ action: 'recurring_delete', id: rcId })).status === 200);
  const r3 = await countRecurring();
  check('recurring: удаление архивирует будущие planned-строки', r3 === 0, r3);

  // валидация (ничего не пишется): rule_day/every_n вне диапазона → 400, правка несуществующего
  // шаблона → 404, выплата без даты YYYY-MM-DD → 400
  check('recurring_save: rule_day 32 → 400', (await post({ action: 'recurring_save', type: 'expense', amount: 1, rule: 'monthly', rule_day: 32, date_from: today })).status === 400);
  check('recurring_save: weekly rule_day 8 → 400', (await post({ action: 'recurring_save', type: 'expense', amount: 1, rule: 'weekly', rule_day: 8, date_from: today })).status === 400);
  check('recurring_save: every_n 366 → 400', (await post({ action: 'recurring_save', type: 'expense', amount: 1, rule: 'every_n_days', every_n: 366, date_from: today })).status === 400);
  check('recurring_save: неактивный шаблон → 404', (await post({ action: 'recurring_save', id: rcId, type: 'expense', amount: 1, rule: 'monthly', rule_day: 1, date_from: today })).status === 404);
  check('receive_payout: дата не YYYY-MM-DD → 400', (await post({ action: 'receive_payout', ref: 'wb:smoke', platform: 'wb', date: 'x', amount: -5 })).status === 400);

  const c = await post({ action: 'create', type: 'expense', date: `${month}-28`, amount: 1.23, category: 'Прочее', description: 'smoke' });
  check('create', c.status === 200 && c.data.id, c.data);
  check('mark_paid', (await post({ action: 'mark_paid', id: c.data.id })).status === 200);
  check('unmark', (await post({ action: 'unmark', id: c.data.id })).status === 200);
  check('delete', (await post({ action: 'delete', id: c.data.id })).status === 200);
}

console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
