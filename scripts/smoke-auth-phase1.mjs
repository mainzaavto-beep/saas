#!/usr/bin/env node
// scripts/smoke-auth-phase1.mjs — смоук фазы 1 auth: страница и правила приёма инвайтов.
// Использование: node scripts/smoke-auth-phase1.mjs [base_url]
// Пишет в БД только записи *@smoke.test и сам их чистит (прямой SQL — под postgres
// через lib/pgpass.mjs, нужен PGPASSFILE: у saas_app осознанно нет DELETE на auth.*).
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { adminPgConfig } from './lib/pgpass.mjs';

const { types } = pg;
// Те же парсеры типов, что в lib/db.js — bigint/numeric как Number.
types.setTypeParser(20, (v) => v === null ? null : Number(v));
types.setTypeParser(1700, (v) => v === null ? null : Number(v));

const BASE = process.argv[2] || 'http://localhost:3210';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Прямой доступ к БД — через общий хелпер (нужен PGPASSFILE=/root/.pgpass-admin).
const pool = new pg.Pool(adminPgConfig());
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
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || cookie };
}
// Регистрация вспомогательного юзера через API (общий код из env — фаза 2 его уберёт,
// тогда параметр станет не нужен).
const reg = (email, name) => api('POST', '/api/auth/register', {
  body: { email, password: 'smoke-pass-123', name, invite_code: process.env.SAAS_INVITE_CODE || undefined },
});

const run = Date.now();
let cabinetId, ownerId, ownerCookie, tokViewer, tokViewer2, tokManager, tokExpired;

try {
  // ── Подготовка: владелец через API (нужна сессия), кабинет и инвайты — SQL ──
  const regOwner = await reg(`owner-${run}@smoke.test`, 'Smoke Owner');
  check('подготовка: регистрация владельца 200', regOwner.status === 200, `got ${regOwner.status} ${JSON.stringify(regOwner.json)}`);
  ownerCookie = regOwner.cookie;
  ownerId = regOwner.json?.user?.user_id;
  cabinetId = (await q(
    `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, status, trial_ends_at)
     VALUES ($1, $2, '{wb}', 'active', now() + interval '14 days') RETURNING cabinet_id`,
    [ownerId, `smoke-cab-${run}`]
  ))[0].cabinet_id;
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'owner')`, [ownerId, cabinetId]);
  const mkInv = (role) => q(
    `INSERT INTO auth.invitations (token, cabinet_id, role, created_by)
     VALUES (gen_random_uuid()::text, $1, $2, $3) RETURNING token`,
    [cabinetId, role, ownerId]
  ).then(r => r[0].token);
  tokViewer = await mkInv('viewer');
  tokViewer2 = await mkInv('viewer');
  tokManager = await mkInv('manager');
  tokExpired = (await q(
    `INSERT INTO auth.invitations (token, cabinet_id, role, created_by, expires_at)
     VALUES (gen_random_uuid()::text, $1, 'viewer', $2, now() - interval '1 day') RETURNING token`,
    [cabinetId, ownerId]
  ))[0].token;

  // ── 1. GET отдаёт имя пригласившего ──
  const g = await api('GET', `/api/invite/${tokViewer}`);
  check('GET инвайта: valid=true + inviter_name', g.json?.valid === true && g.json?.inviter_name === 'Smoke Owner', JSON.stringify(g.json));

  // ── 2. Страница /invite/<token> публична ──
  const page = await fetch(`${BASE}/invite/${tokViewer}`, { redirect: 'manual' });
  check('страница /invite/<token> анониму: 200', page.status === 200, `got ${page.status}`);

  // ── 3. Анонимный POST — 401 ──
  const anonPost = await api('POST', `/api/invite/${tokViewer}`);
  check('анонимный POST: 401', anonPost.status === 401, `got ${anonPost.status}`);

  // ── 4. Существующий залогиненный юзер принимает инвайт ──
  const regEmp = await reg(`emp-${run}@smoke.test`, 'Smoke Emp');
  const empId = regEmp.json?.user?.user_id;
  const acc = await api('POST', `/api/invite/${tokViewer}`, { cookie: regEmp.cookie });
  check('приём существующим юзером: ok + cabinet_id', acc.status === 200 && acc.json?.ok === true && acc.json?.cabinet_id === cabinetId, JSON.stringify(acc.json));
  const memRole = (await q(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [empId, cabinetId]))[0]?.role;
  check('...membership viewer создан', memRole === 'viewer', String(memRole));

  // ── 5. Повторный POST того же токена тем же юзером — идемпотентное «уже участник» ──
  const acc2 = await api('POST', `/api/invite/${tokViewer}`, { cookie: regEmp.cookie });
  check('повторный приём: 200 already_member', acc2.status === 200 && acc2.json?.already_member === true, `${acc2.status} ${JSON.stringify(acc2.json)}`);

  // ── 6. Владелец открывает СВОЙ viewer-токен — роль не падает, токен не сгорает ──
  const own = await api('POST', `/api/invite/${tokViewer2}`, { cookie: ownerCookie });
  check('owner + свой viewer-токен: already_member', own.status === 200 && own.json?.already_member === true, `${own.status} ${JSON.stringify(own.json)}`);
  const ownerRole = (await q(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [ownerId, cabinetId]))[0]?.role;
  check('...роль owner не тронута', ownerRole === 'owner', String(ownerRole));
  const tok2Acc = (await q(`SELECT accepted_at FROM auth.invitations WHERE token = $1`, [tokViewer2]))[0]?.accepted_at;
  check('...токен не сожжён', tok2Acc == null, String(tok2Acc));

  // ── 7. Апгрейд: viewer принимает manager-инвайт ──
  const up = await api('POST', `/api/invite/${tokManager}`, { cookie: regEmp.cookie });
  check('viewer принимает manager-инвайт: role=manager', up.status === 200 && up.json?.role === 'manager', `${up.status} ${JSON.stringify(up.json)}`);
  const upRole = (await q(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [empId, cabinetId]))[0]?.role;
  check('...в БД manager', upRole === 'manager', String(upRole));

  // ── 8. Истёкший токен не-участнику — 403 ──
  const regOut = await reg(`out-${run}@smoke.test`, 'Smoke Out');
  const exp = await api('POST', `/api/invite/${tokExpired}`, { cookie: regOut.cookie });
  check('истёкший токен: 403', exp.status === 403, `got ${exp.status} ${JSON.stringify(exp.json)}`);

  // ── 8б. Сожжённый токен (tokViewer принят emp'ом ранее) для постороннего — 403 ──
  const burned = await api('POST', `/api/invite/${tokViewer}`, { cookie: regOut.cookie });
  check('сожжённый токен постороннему: 403 «Уже использовано»', burned.status === 403 && /использовано/i.test(burned.json?.error || ''), `${burned.status} ${JSON.stringify(burned.json)}`);

  // ── 9. Создание инвайта отдаёт ссылку нового формата ──
  const inv = await api('POST', `/api/cabinets/${cabinetId}/invites`, { cookie: ownerCookie, body: { role: 'viewer' } });
  check('ссылка инвайта ведёт на /invite/<token>', typeof inv.json?.url === 'string' && inv.json.url.endsWith(`/invite/${inv.json?.token}`), String(inv.json?.url));

  // ── 9б. Отзыв приглашения владельцем — токен должен перестать работать ──
  const revoke = await api('DELETE', `/api/cabinets/${cabinetId}/invites?token=${inv.json?.token}`, { cookie: ownerCookie });
  check('отзыв приглашения владельцем: 200', revoke.status === 200, `got ${revoke.status} ${JSON.stringify(revoke.json)}`);
  const afterRevoke = await api('GET', `/api/invite/${inv.json?.token}`);
  check('...после отзыва токен недействителен', afterRevoke.status === 404 && afterRevoke.json?.valid === false, `${afterRevoke.status} ${JSON.stringify(afterRevoke.json)}`);

  // ── 10. Контакты команды скрыты от viewer, видны owner ──
  const regV = await reg(`v-${run}@smoke.test`, 'Smoke V');
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'viewer')`, [regV.json?.user?.user_id, cabinetId]);
  const memsV = await api('GET', `/api/cabinets/${cabinetId}/members`, { cookie: regV.cookie });
  check('members для viewer: email/phone скрыты', memsV.status === 200 && (memsV.json?.items || []).length > 0 && (memsV.json.items).every(i => i.email == null && i.phone == null), JSON.stringify((memsV.json?.items || []).slice(0, 2)));
  const memsO = await api('GET', `/api/cabinets/${cabinetId}/members`, { cookie: ownerCookie });
  check('members для owner: email видны', memsO.status === 200 && (memsO.json?.items || []).some(i => i.email), 'owner не видит email');
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  await q(`DELETE FROM auth.invitations WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  await q(`DELETE FROM auth.users WHERE email LIKE $1`, [`%-${run}@smoke.test`]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users WHERE email LIKE '%@smoke.test'");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
