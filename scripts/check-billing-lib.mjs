#!/usr/bin/env node
// scripts/check-billing-lib.mjs — прямые проверки lib/billing.js без сервера.
// Закрывает два места, которые смоуки не видят: разбор SAAS_GRACE_DAYS и
// запрос о платежах с несошедшейся суммой (он питает блок на /health, куда
// смоук не попадёт — там операторский allowlist).
// Использование: node scripts/check-billing-lib.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const { types } = pg;
types.setTypeParser(20, (v) => v === null ? null : Number(v));
types.setTypeParser(1700, (v) => v === null ? null : Number(v));

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const pgpass = readFileSync(`${homedir()}/.pgpass`, 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split(':'))
  .find(p => p[3] === 'postgres');
if (!pgpass) { console.error('нет строки postgres в ~/.pgpass'); process.exit(2); }
const pool = new pg.Pool({
  host: 'localhost', port: Number(pgpass[1]) || 5432,
  database: process.env.SAAS_DB || 'saas', user: 'postgres', password: pgpass[4],
});
const q = (sql, p) => pool.query(sql, p).then(r => r.rows);

let failed = 0, cleanupFailed = false;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failed++;
};

// GRACE_DAYS читается на импорте модуля, поэтому каждый вариант проверяем
// в отдельном процессе с нужным окружением.
function graceWith(envValue) {
  const env = { ...process.env };
  if (envValue === undefined) delete env.SAAS_GRACE_DAYS;
  else env.SAAS_GRACE_DAYS = envValue;
  const out = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    "const m = await import('./lib/billing.js'); console.log(m.GRACE_DAYS);",
  ], { env, cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  return Number(out.trim().split('\n').pop());
}

const run = Date.now();
let userId = null, cabinetId = null;

try {
  // ── 1. Разбор SAAS_GRACE_DAYS ──
  check('не задан → 3 дня', graceWith(undefined) === 3, String(graceWith(undefined)));
  check('пустая строка → 3 дня (а не ноль)', graceWith('') === 3, String(graceWith('')));
  check('пробелы → 3 дня', graceWith('   ') === 3, String(graceWith('   ')));
  check('мусор → 3 дня', graceWith('abc') === 3, String(graceWith('abc')));
  check('отрицательное → 3 дня', graceWith('-1') === 3, String(graceWith('-1')));
  check('явный ноль → 0 дней', graceWith('0') === 0, String(graceWith('0')));
  check('число → оно же', graceWith('7') === 7, String(graceWith('7')));

  // ── 2. Запрос о платежах с несошедшейся суммой ──
  const { mismatchPayments } = await import('../lib/billing.js');
  const before = await mismatchPayments();
  check('в норме расхождений нет', before.length === 0, `найдено ${before.length}`);

  userId = (await q(
    `INSERT INTO auth.users (email, password_hash) VALUES ($1, 'x') RETURNING user_id`,
    [`mismatch-${run}@smoke.test`]
  ))[0].user_id;
  cabinetId = (await q(
    `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, status, trial_ends_at)
     VALUES ($1, $2, '{wb}', 'active', now() + interval '14 days') RETURNING cabinet_id`,
    [userId, `smoke-mismatch-${run}`]
  ))[0].cabinet_id;
  const paymentId = `smoke-mismatch-${run}`;
  await q(
    `INSERT INTO billing.payments (payment_id, cabinet_id, user_id, plan_code, months, amount_rub, status, raw)
     VALUES ($1, $2, $3, 'smoke', 1, 100.00, 'mismatch', '{"mismatch":{"expected":100,"got":777}}'::jsonb)`,
    [paymentId, cabinetId, userId]
  );

  const after = await mismatchPayments();
  const row = after.find((r) => r.payment_id === paymentId);
  check('платёж со статусом mismatch попадает в выборку', !!row, `вернулось ${after.length} строк`);
  check('...с названием проекта', row?.display_name === `smoke-mismatch-${run}`, String(row?.display_name));
  check('...с нашей ценой', Number(row?.amount_rub) === 100, String(row?.amount_rub));
  check('...с деталями расхождения', row?.mismatch?.got === 777 && row?.mismatch?.expected === 100, JSON.stringify(row?.mismatch));

  // Платежи в других статусах в выборку не попадают.
  await q(`UPDATE billing.payments SET status = 'succeeded' WHERE payment_id = $1`, [paymentId]);
  const afterFix = await mismatchPayments();
  check('успешный платёж в выборку не попадает', !afterFix.some((r) => r.payment_id === paymentId), 'платёж остался в списке');
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  if (cabinetId) {
    await q(`DELETE FROM billing.payments WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  }
  if (userId) await q(`DELETE FROM auth.users WHERE user_id = $1`, [userId]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users и billing.payments");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
