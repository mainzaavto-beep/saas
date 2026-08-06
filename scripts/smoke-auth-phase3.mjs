#!/usr/bin/env node
// scripts/smoke-auth-phase3.mjs — смоук фазы 3: подтверждение email, сброс
// пароля, серверная инвалидация сессий.
// Использование: node scripts/smoke-auth-phase3.mjs [base_url]
// Токены берёт из «почтовой раковины» /tmp/saas-mail (SAAS_MAIL_SINK=1) —
// пока SMTP не настроен, письма пишутся туда файлами.
import pg from 'pg';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const { types } = pg;
types.setTypeParser(20, (v) => v === null ? null : Number(v));
types.setTypeParser(1700, (v) => v === null ? null : Number(v));

const BASE = process.argv[2] || 'http://localhost:3210';
const SINK_DIR = '/tmp/saas-mail';
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
const note = (msg) => console.log(`NOTE  ${msg}`);

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
  return { status: res.status, json, setCookie, cookie: setCookie.split(';')[0] || cookie };
}

// Последнее письмо для адреса из раковины: возвращает текст или null.
function lastMailFor(email) {
  if (!existsSync(SINK_DIR)) return null;
  const files = readdirSync(SINK_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => `${SINK_DIR}/${f}`)
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const body = readFileSync(files[i], 'utf8');
    if (body.includes(email)) return body;
  }
  return null;
}
const tokenFrom = (mailBody, path) => {
  const m = mailBody && mailBody.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
};

const run = Date.now();
const email = `verify-${run}@smoke.test`;
const PASS1 = 'smoke-pass-123';
const PASS2 = 'smoke-pass-456';
let cabinetId = null, userId = null;

try {
  if (process.env.SAAS_MAIL_SINK !== '1' && !process.env.SAAS_SMTP_HOST) {
    console.error('Ни SAAS_MAIL_SINK=1, ни SAAS_SMTP_HOST не заданы — писем не будет, смоук бессмысленен');
    process.exit(2);
  }

  // ── 1. Регистрация: email не подтверждён, письмо ушло ──
  const reg = await api('POST', '/api/auth/register', { body: { email, password: PASS1, first_name: 'Проверка' } });
  check('регистрация: 200', reg.status === 200, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  userId = reg.json?.user?.user_id;
  const u1 = (await q(`SELECT email_verified_at, session_version FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('email не подтверждён при регистрации', u1 && u1.email_verified_at === null, JSON.stringify(u1));
  check('session_version = 1', u1?.session_version === 1, String(u1?.session_version));
  const mail1 = lastMailFor(email);
  check('письмо с подтверждением создано', !!mail1, 'нет письма в раковине');
  const vToken = tokenFrom(mail1, '/verify');
  check('в письме ссылка /verify?token=', !!vToken, String(mail1 && mail1.slice(0, 120)));
  const tokRow = vToken ? (await q(`SELECT kind, used_at FROM auth.user_tokens WHERE user_id = $1 AND kind = 'verify_email'`, [userId]))[0] : null;
  check('токен лежит в БД непогашенным', !!tokRow && tokRow.used_at === null, JSON.stringify(tokRow));
  check('сырой токен в БД не хранится', !!vToken && !(await q(`SELECT 1 FROM auth.user_tokens WHERE token_hash = $1`, [vToken])).length);

  // ── 2. Подтверждение по токену ──
  const ver = await api('POST', '/api/auth/verify', { body: { token: vToken } });
  check('подтверждение: 200', ver.status === 200, `got ${ver.status} ${JSON.stringify(ver.json)}`);
  const u2 = (await q(`SELECT email_verified_at FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('email_verified_at проставлен', !!u2?.email_verified_at, JSON.stringify(u2));

  // ── 3. Повторное использование токена отклоняется ──
  const ver2 = await api('POST', '/api/auth/verify', { body: { token: vToken } });
  check('повторное подтверждение: 400', ver2.status === 400, `got ${ver2.status}`);

  // ── 4. Онбординг (нужен кабинет для проверок сессии) ──
  const onb = await api('POST', '/api/onboarding/start', { cookie: reg.cookie, body: { display_name: `smoke-p3-${run}`, marketplaces: ['wb'] } });
  check('онбординг: 200', onb.status === 200, `got ${onb.status} ${JSON.stringify(onb.json)}`);
  cabinetId = onb.json?.cabinet?.cabinet_id;

  // ── 5. Гейт «без подтверждения нельзя звать команду» ──
  // Активен только при SAAS_REQUIRE_VERIFIED_EMAIL=1 (включается вместе с SMTP).
  const gateOn = process.env.SAAS_REQUIRE_VERIFIED_EMAIL === '1';
  const unvEmail = `unverified-${run}@smoke.test`;
  const unv = await api('POST', '/api/auth/register', { body: { email: unvEmail, password: PASS1 } });
  const unvOnb = await api('POST', '/api/onboarding/start', { cookie: unv.cookie, body: { display_name: `smoke-p3u-${run}`, marketplaces: ['wb'] } });
  const unvCab = unvOnb.json?.cabinet?.cabinet_id;
  const inviteTry = await api('POST', `/api/cabinets/${unvCab}/invites`, { cookie: unv.cookie, body: { role: 'viewer' } });
  if (gateOn) {
    check('неподтверждённый не может создать инвайт: 403 email_unverified',
      inviteTry.status === 403 && inviteTry.json?.code === 'email_unverified', `${inviteTry.status} ${JSON.stringify(inviteTry.json)}`);
  } else {
    check('гейт выключен — инвайт создаётся: 200', inviteTry.status === 200, `${inviteTry.status} ${JSON.stringify(inviteTry.json)}`);
    note('SAAS_REQUIRE_VERIFIED_EMAIL не выставлен — гейт подтверждения email НЕ проверен (включить вместе с SMTP)');
  }
  if (unvCab) {
    await q(`DELETE FROM auth.invitations WHERE cabinet_id = $1`, [unvCab]).catch(() => {});
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [unvCab]).catch(() => {});
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [unvCab]).catch(() => {});
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [unvCab]).catch(() => {});
  }

  // ── 6. Забыли пароль: одинаковый ответ для существующего и нет ──
  const f1 = await api('POST', '/api/auth/forgot', { body: { email } });
  const f2 = await api('POST', '/api/auth/forgot', { body: { email: `nobody-${run}@smoke.test` } });
  check('forgot для существующего: 200', f1.status === 200, `got ${f1.status}`);
  check('forgot для несуществующего: тот же ответ', f2.status === f1.status && JSON.stringify(f2.json) === JSON.stringify(f1.json), `${f2.status} ${JSON.stringify(f2.json)}`);
  const mailR = lastMailFor(email);
  const rToken = tokenFrom(mailR, '/reset');
  check('письмо со ссылкой /reset?token=', !!rToken, String(mailR && mailR.slice(0, 120)));
  check('несуществующему письмо не отправлено', !lastMailFor(`nobody-${run}@smoke.test`));

  // ── 7. Сброс пароля: новый пароль работает, старая сессия мертва ──
  const beforeSessions = await api('GET', `/api/cabinets/${cabinetId}/me`, { cookie: reg.cookie });
  check('до сброса старая сессия жива', beforeSessions.status === 200, `got ${beforeSessions.status}`);
  const rst = await api('POST', '/api/auth/reset', { body: { token: rToken, password: PASS2 } });
  check('сброс пароля: 200', rst.status === 200, `got ${rst.status} ${JSON.stringify(rst.json)}`);
  const afterSessions = await api('GET', `/api/cabinets/${cabinetId}/me`, { cookie: reg.cookie });
  check('после сброса старая сессия мертва: 401', afterSessions.status === 401, `got ${afterSessions.status}`);
  const oldLogin = await api('POST', '/api/auth/login', { body: { email, password: PASS1 } });
  check('старый пароль больше не подходит: 401', oldLogin.status === 401, `got ${oldLogin.status}`);
  const newLogin = await api('POST', '/api/auth/login', { body: { email, password: PASS2 } });
  check('новый пароль работает: 200', newLogin.status === 200, `got ${newLogin.status}`);
  const u3 = (await q(`SELECT session_version FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('session_version увеличен', u3?.session_version === 2, String(u3?.session_version));

  // ── 8. Токен сброса одноразовый ──
  const rst2 = await api('POST', '/api/auth/reset', { body: { token: rToken, password: 'smoke-pass-789' } });
  check('повторный сброс тем же токеном: 400', rst2.status === 400, `got ${rst2.status}`);
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  if (cabinetId) {
    await q(`DELETE FROM auth.invitations WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  }
  await q(`DELETE FROM auth.user_tokens WHERE user_id IN (SELECT user_id FROM auth.users WHERE email LIKE $1)`, [`%-${run}@smoke.test`]).catch(cf);
  await q(`DELETE FROM auth.users WHERE email LIKE $1`, [`%-${run}@smoke.test`]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users WHERE email LIKE '%@smoke.test'");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
