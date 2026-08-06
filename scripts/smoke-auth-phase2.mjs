#!/usr/bin/env node
// scripts/smoke-auth-phase2.mjs — смоук фазы 2: открытая регистрация, триал,
// ограничение попыток, сохранение next, продление сессии.
// Использование: node scripts/smoke-auth-phase2.mjs [base_url]
// Пишет в БД только записи *@smoke.test и сам их чистит (прямой SQL — под postgres
// из ~/.pgpass: у saas_app осознанно нет DELETE на auth.*).
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const { types } = pg;
// Те же парсеры типов, что в lib/db.js — bigint/numeric как Number.
types.setTypeParser(20, (v) => v === null ? null : Number(v));
types.setTypeParser(1700, (v) => v === null ? null : Number(v));

const BASE = process.argv[2] || 'http://localhost:3210';
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
async function api(method, path, { body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') || '';
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, setCookie, cookie: setCookie.split(';')[0] || cookie, headers: res.headers };
}

const run = Date.now();
let cabinetId = null;

try {
  // ── 1. Открытая регистрация: без invite_code и без токена ──
  const email = `open-${run}@smoke.test`;
  const reg = await api('POST', '/api/auth/register', {
    body: { email, password: 'smoke-pass-123', first_name: 'Иван', last_name: 'Петров' },
  });
  check('открытая регистрация без кода: 200', reg.status === 200, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  const userId = reg.json?.user?.user_id;

  // ── 2. Имя и фамилия сохранены ──
  const u = (await q(`SELECT first_name, last_name, name, email FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('first_name/last_name сохранены', u?.first_name === 'Иван' && u?.last_name === 'Петров', JSON.stringify(u));

  // ── 3. Дубль email в другом регистре — 409 с человеческим текстом ──
  const dup = await api('POST', '/api/auth/register', {
    body: { email: email.toUpperCase(), password: 'smoke-pass-123' },
  });
  check('дубль email (другой регистр): 409', dup.status === 409, `got ${dup.status} ${JSON.stringify(dup.json)}`);
  check('...текст человеческий, без деталей БД', typeof dup.json?.error === 'string' && !/duplicate key|constraint|violates/i.test(dup.json.error), String(dup.json?.error));
  check('...код email_taken для клиента', dup.json?.code === 'email_taken', String(dup.json?.code));

  // ── 4. Онбординг ставит пробный период ──
  const onb = await api('POST', '/api/onboarding/start', {
    cookie: reg.cookie, body: { display_name: `smoke-proj-${run}`, marketplaces: ['wb'] },
  });
  check('онбординг: 200', onb.status === 200, `got ${onb.status} ${JSON.stringify(onb.json)}`);
  cabinetId = onb.json?.cabinet?.cabinet_id;
  const cab = (await q(`SELECT trial_ends_at FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]))[0];
  const days = cab?.trial_ends_at ? Math.round((new Date(cab.trial_ends_at) - Date.now()) / 86400000) : null;
  check('...trial_ends_at ≈ +14 дней', days === 14, `got ${days} (${cab?.trial_ends_at})`);
  check('...кабинет вернул trial_ends_at в ответе', !!onb.json?.cabinet?.trial_ends_at, JSON.stringify(onb.json?.cabinet));

  // ── 5. Сессия не переиздаётся на каждый запрос (rolling раз в сутки) ──
  const me = await api('GET', `/api/cabinets/${cabinetId}/me`, { cookie: reg.cookie });
  check('withCabinet-роут отвечает 200', me.status === 200, `got ${me.status}`);
  check('...сессия не переиздана (нет Set-Cookie)', !me.setCookie, String(me.setCookie).slice(0, 60));

  // ── 6. Успешный вход лимит не расходует: 6 подряд успешных входов ──
  let allOk = true;
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/api/auth/login', { body: { email, password: 'smoke-pass-123' } });
    if (r.status !== 200) { allOk = false; check(`успешный вход #${i + 1}: 200`, false, `got ${r.status}`); break; }
  }
  check('6 успешных входов подряд не блокируются', allOk);

  // ── 7. Перебор пароля: 6-я неудачная попытка — 429 ──
  const victim = `victim-${run}@smoke.test`;
  await api('POST', '/api/auth/register', { body: { email: victim, password: 'smoke-pass-123' } });
  let sawLimited = null;
  for (let i = 1; i <= 6; i++) {
    const r = await api('POST', '/api/auth/login', { body: { email: victim, password: 'wrong-pass-000' } });
    if (r.status === 429) { sawLimited = i; break; }
    if (r.status !== 401) { check(`неудачный вход #${i}: 401`, false, `got ${r.status}`); break; }
  }
  check('перебор пароля упирается в лимит на 6-й попытке', sawLimited === 6, `сработало на попытке ${sawLimited}`);

  // ── 8. Правильный пароль под лимитом тоже отбивается (лимит на аккаунт) ──
  const blocked = await api('POST', '/api/auth/login', { body: { email: victim, password: 'smoke-pass-123' } });
  check('под лимитом даже верный пароль: 429', blocked.status === 429, `got ${blocked.status}`);
  check('...ответ содержит Retry-After', !!blocked.headers.get('retry-after'), String(blocked.headers.get('retry-after')));

  // ── 9. middleware сохраняет query в next ──
  const guarded = await fetch(`${BASE}/cabinets/${cabinetId}/summary?period=month`, { redirect: 'manual' });
  const loc = guarded.headers.get('location') || '';
  check('редирект на /login с сохранением query', loc.includes('/login?next=') && decodeURIComponent(loc).includes(`/cabinets/${cabinetId}/summary?period=month`), loc);
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  if (cabinetId) {
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  }
  await q(`DELETE FROM auth.users WHERE email LIKE $1`, [`%-${run}@smoke.test`]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users WHERE email LIKE '%@smoke.test'");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
