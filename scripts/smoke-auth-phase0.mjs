#!/usr/bin/env node
// scripts/smoke-auth-phase0.mjs — смоук фазы 0 auth-редизайна.
// Использование: node scripts/smoke-auth-phase0.mjs [base_url]
// Требует: поднятый сервер панели, доступ к БД (env из .env.local).
// Пишет в БД ТОЛЬКО тестовые записи (email *@smoke.test, инвайты в тестовый кабинет),
// в конце удаляет их. Боевые данные не трогает.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const BASE = process.argv[2] || 'http://localhost:3210';

// env из .env.local (как у Next)
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Прямой доступ к БД — под postgres из ~/.pgpass (у saas_app нет DELETE на auth.*).
const pgpassLine = readFileSync(`${homedir()}/.pgpass`, 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => l.split(':'))
  .find(p => p[3] === 'postgres');
if (!pgpassLine) { console.error('нет строки postgres в ~/.pgpass'); process.exit(2); }
const pool = new pg.Pool({
  host: 'localhost',
  port: Number(pgpassLine[1]) || 5432,
  database: process.env.SAAS_DB || 'saas',
  user: 'postgres',
  password: pgpassLine[4],
});
const q = (sql, p) => pool.query(sql, p).then(r => r.rows);

let failed = 0;
let cleanupFailed = false;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failed++;
}
// fetch с ручной кукой (нужно переносить set-cookie между запросами)
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
  return { status: res.status, json, cookie: setCookie.split(';')[0] || cookie };
}

const run = Date.now();
const CAB_NAME = `smoke-cab-${run}`;
let cabinetId, ownerId, tokenViewer, tokenExpired;

try {
  // ── Подготовка: тестовый владелец, кабинет, инвайты (прямо в БД) ──
  ownerId = (await q(
    `INSERT INTO auth.users (email, password_hash, name) VALUES ($1, 'x', 'Smoke Owner') RETURNING user_id`,
    [`owner-${run}@smoke.test`]
  ))[0].user_id;
  cabinetId = (await q(
    `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, status)
     VALUES ($1, $2, '{wb}', 'active') RETURNING cabinet_id`,
    [ownerId, CAB_NAME]
  ))[0].cabinet_id;
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'owner')`, [ownerId, cabinetId]);
  tokenViewer = (await q(
    `INSERT INTO auth.invitations (token, cabinet_id, role, created_by)
     VALUES (gen_random_uuid()::text, $1, 'viewer', $2) RETURNING token`,
    [cabinetId, ownerId]
  ))[0].token;
  tokenExpired = (await q(
    `INSERT INTO auth.invitations (token, cabinet_id, role, created_by, expires_at)
     VALUES (gen_random_uuid()::text, $1, 'viewer', $2, now() - interval '1 day') RETURNING token`,
    [cabinetId, ownerId]
  ))[0].token;

  // ── 1. Анонимная валидация инвайта (ловит обрыв №1: middleware 401) ──
  const v = await api('GET', `/api/invite/${tokenViewer}`);
  check('анонимный GET /api/invite/<token> отвечает 200', v.status === 200, `got ${v.status}`);
  check('...и valid=true с именем кабинета', v.json?.valid === true && v.json?.cabinet_name === CAB_NAME, JSON.stringify(v.json));

  const ve = await api('GET', `/api/invite/${tokenExpired}`);
  check('истёкший инвайт: valid=false с текстом про срок', ve.json?.valid === false && /истёк/i.test(ve.json?.error || ''), JSON.stringify(ve.json));

  // ── 2. Регистрация по инвайту без общего кода (ловит обрыв №2: SAAS_INVITE_CODE) ──
  const email = `invitee-${run}@smoke.test`;
  const reg = await api('POST', '/api/auth/register', {
    body: { email, password: 'smoke-pass-123', name: 'Smoke Invitee', invite_token: tokenViewer },
  });
  check('регистрация с invite_token без invite_code: 200', reg.status === 200, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  check('...ответ ведёт в кабинет приглашения', reg.json?.next === `/cabinets/${cabinetId}`, `next=${reg.json?.next}`);

  // ── 3. Инвайт принят сервером атомарно (membership + accepted_at) ──
  const mem = await q(
    `SELECT role FROM auth.memberships m JOIN auth.users u USING (user_id)
     WHERE u.email = $1 AND m.cabinet_id = $2`, [email, cabinetId]);
  check('membership viewer создан', mem[0]?.role === 'viewer', JSON.stringify(mem));
  const inv = await q(`SELECT accepted_at FROM auth.invitations WHERE token = $1`, [tokenViewer]);
  check('инвайт помечен принятым', !!inv[0]?.accepted_at);

  // ── 4. Регистрация без кода и без инвайта по-прежнему закрыта ──
  const regNoCode = await api('POST', '/api/auth/register', {
    body: { email: `stranger-${run}@smoke.test`, password: 'smoke-pass-123' },
  });
  check('регистрация без кода и инвайта: 403', regNoCode.status === 403, `got ${regNoCode.status}`);

  // ── 5. Вход сотрудника ведёт в кабинет по membership (ловит обрыв №3: firstCabinetOf) ──
  // Пароль invitee задан регистрацией выше; логинимся заново без куки.
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'smoke-pass-123' } });
  check('вход сотрудника: 200', login.status === 200, `got ${login.status}`);
  check('...active_cabinet_id = кабинет приглашения', login.json?.active_cabinet_id === cabinetId, `got ${login.json?.active_cabinet_id}`);
  check("...next не '/onboarding'", login.json?.next !== '/onboarding', `next=${login.json?.next}`);

  // ── 6. Повторное использование токена отклоняется ──
  const reuse = await api('POST', `/api/invite/${tokenViewer}`, { cookie: login.cookie });
  check('повторный приём того же инвайта: 403', reuse.status === 403, `got ${reuse.status}`);
} finally {
  // ── Уборка (в обратном порядке FK) ──
  await q(`DELETE FROM auth.invitations WHERE cabinet_id = $1`, [cabinetId]).catch(e => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; });
  await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(e => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; });
  await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(e => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; });
  await q(`DELETE FROM auth.users WHERE email IN ($1, $2, $3)`,
    [`owner-${run}@smoke.test`, `invitee-${run}@smoke.test`, `stranger-${run}@smoke.test`]).catch(e => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; });
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.log('\nCLEANUP: не все тестовые записи удалены, проверь auth.users WHERE email LIKE \'%@smoke.test\'');
  process.exit(1);
}
process.exit(failed ? 1 : 0);
