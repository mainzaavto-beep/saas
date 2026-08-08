#!/usr/bin/env node
// Проверка Задачи 5: /verify-pending, GET /api/auth/verify/status,
// PUT /api/auth/email (смена неподтверждённого адреса), гейт /onboarding.
// Использование: node smoke-verify-pending.mjs http://127.0.0.1:3200
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { adminPgConfig } from './lib/pgpass.mjs';
import { lastMailFor, tokenFrom } from './lib/mail-verify.mjs';

const { types } = pg;
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const BASE = process.argv[2] || 'http://127.0.0.1:3200';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const pool = new pg.Pool(adminPgConfig());
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);

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
  return { status: res.status, json, setCookie, cookie: setCookie.split(';')[0] || cookie, location: res.headers.get('location') };
}

const run = Date.now();
const email = `vp-${run}@smoke.test`;
const email2 = `vp-changed-${run}@smoke.test`;
const emailTaken = `vp-taken-${run}@smoke.test`;
const PASS1 = 'smoke-pass-123';
let userId = null, takenUserId = null;

try {
  if (process.env.SAAS_MAIL_SINK !== '1' && !process.env.SAAS_SMTP_HOST) {
    console.error('Ни SAAS_MAIL_SINK=1, ни SAAS_SMTP_HOST не заданы — писем не будет, смоук бессмысленен');
    process.exit(2);
  }

  // ── 0. Второй пользователь — понадобится для проверки «адрес занят» ──
  const takenReg = await api('POST', '/api/auth/register', { body: { email: emailTaken, password: PASS1 } });
  check('регистрация второго юзера (для проверки занятости): 200', takenReg.status === 200, `got ${takenReg.status}`);
  takenUserId = takenReg.json?.user?.user_id;

  // ── 1. Регистрация: редирект next теперь на /verify-pending ──
  const reg = await api('POST', '/api/auth/register', { body: { email, password: PASS1, first_name: 'Проверка' } });
  check('регистрация: 200', reg.status === 200, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  check('next === /verify-pending', reg.json?.next === '/verify-pending', JSON.stringify(reg.json?.next));
  userId = reg.json?.user?.user_id;

  // ── 2. /verify-pending без сессии — 307/302 на /login ──
  const pendingNoSession = await api('GET', '/verify-pending');
  check('/verify-pending без сессии редиректит', [301, 302, 307, 308].includes(pendingNoSession.status), `got ${pendingNoSession.status}`);

  // ── 3. /onboarding с сессией неподтверждённого — редирект на /verify-pending ──
  const onbUnverified = await api('GET', '/onboarding', { cookie: reg.cookie });
  check('/onboarding для неподтверждённого редиректит на /verify-pending',
    [301, 302, 307, 308].includes(onbUnverified.status) && (onbUnverified.location || '').includes('/verify-pending'),
    `${onbUnverified.status} location=${onbUnverified.location}`);

  // ── 4. GET /api/auth/verify/status без сессии — 401 ──
  const statusNoAuth = await api('GET', '/api/auth/verify/status');
  check('status без сессии: 401', statusNoAuth.status === 401, `got ${statusNoAuth.status}`);

  // ── 5. GET /api/auth/verify/status с сессией — verified:false, email верный ──
  const status1 = await api('GET', '/api/auth/verify/status', { cookie: reg.cookie });
  check('status: 200', status1.status === 200, `got ${status1.status}`);
  check('status: verified=false', status1.json?.verified === false, JSON.stringify(status1.json));
  check('status: email совпадает', status1.json?.email === email, JSON.stringify(status1.json));

  // ── 6. PUT /api/auth/email без сессии — 401 ──
  const putNoAuth = await api('PUT', '/api/auth/email', { body: { email: email2 } });
  check('PUT /api/auth/email без сессии: 401', putNoAuth.status === 401, `got ${putNoAuth.status}`);

  // ── 7. PUT /api/auth/email с явно неверным адресом — 400 ──
  const putBad = await api('PUT', '/api/auth/email', { cookie: reg.cookie, body: { email: 'x' } });
  check('PUT /api/auth/email мусорный адрес: 400', putBad.status === 400, `got ${putBad.status}`);

  // ── 8. PUT /api/auth/email на уже занятый адрес — 409, адрес не поменялся ──
  const putTaken = await api('PUT', '/api/auth/email', { cookie: reg.cookie, body: { email: emailTaken } });
  check('PUT /api/auth/email занятый адрес: 409', putTaken.status === 409, `got ${putTaken.status} ${JSON.stringify(putTaken.json)}`);
  const afterTakenTry = (await q(`SELECT email FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('адрес не изменился после попытки занять чужой', afterTakenTry?.email === email, JSON.stringify(afterTakenTry));

  // ── 9. Старый токен подтверждения (с регистрации) жив и валиден на этот момент ──
  const oldMail = lastMailFor(email);
  const oldToken = tokenFrom(oldMail, '/verify');
  check('в письме регистрации есть токен', !!oldToken, String(oldMail && oldMail.slice(0, 120)));

  // ── 10. Успешная смена адреса (аварийный выход — счастливый путь) ──
  const putOk = await api('PUT', '/api/auth/email', { cookie: reg.cookie, body: { email: `  ${email2.toUpperCase()}  ` } });
  check('PUT /api/auth/email успех: 200', putOk.status === 200, `got ${putOk.status} ${JSON.stringify(putOk.json)}`);
  check('ответ содержит нормализованный (trim+lower) email', putOk.json?.email === email2, JSON.stringify(putOk.json));
  const afterChange = (await q(`SELECT email, email_verified_at FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('в БД email реально сменился', afterChange?.email === email2, JSON.stringify(afterChange));
  check('email_verified_at всё ещё пуст (адрес новый — тоже неподтверждён)', afterChange?.email_verified_at === null, JSON.stringify(afterChange));

  // ── 11. Новое письмо ушло НА НОВЫЙ адрес ──
  const newMail = lastMailFor(email2);
  check('письмо с подтверждением ушло на новый адрес', !!newMail, 'нет письма для ' + email2);
  const newToken = tokenFrom(newMail, '/verify');
  check('в новом письме есть токен', !!newToken, String(newMail && newMail.slice(0, 120)));
  check('новый токен отличается от старого', !!newToken && newToken !== oldToken, `old=${oldToken} new=${newToken}`);

  // ── 12. Старый токен (со старого адреса) больше не годится ──
  const oldVerifyTry = await api('POST', '/api/auth/verify', { body: { token: oldToken } });
  check('старый токен погашен createToken() — подтверждение им отклонено', oldVerifyTry.status !== 200, `got ${oldVerifyTry.status} ${JSON.stringify(oldVerifyTry.json)}`);

  // ── 13. status теперь отражает новый email ──
  const status2 = await api('GET', '/api/auth/verify/status', { cookie: reg.cookie });
  check('status: email обновился до нового адреса', status2.json?.email === email2, JSON.stringify(status2.json));
  check('status: verified всё ещё false', status2.json?.verified === false, JSON.stringify(status2.json));

  // ── 14. Подтверждение НОВЫМ токеном на НОВЫЙ адрес — работает ──
  const verNew = await api('POST', '/api/auth/verify', { body: { token: newToken } });
  check('подтверждение новым токеном: 200', verNew.status === 200, `got ${verNew.status} ${JSON.stringify(verNew.json)}`);
  const afterVerify = (await q(`SELECT email, email_verified_at FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('email_verified_at проставлен', !!afterVerify?.email_verified_at, JSON.stringify(afterVerify));

  // ── 15. После подтверждения смена адреса через PUT закрыта (409) ──
  // Отдельный свежий юзер: у reg.cookie к этому моменту уже 3 PUT-попытки
  // (шаги 7, 8, 10) — лимит в час съеден, и проверка 409 была бы заслонена
  // 429. Здесь важно поймать именно ветку «уже подтверждён», а не лимит.
  const email3 = `vp-verified-${run}@smoke.test`;
  const reg3 = await api('POST', '/api/auth/register', { body: { email: email3, password: PASS1 } });
  check('регистрация третьего юзера (для проверки «уже подтверждён»): 200', reg3.status === 200, `got ${reg3.status}`);
  const mail3 = lastMailFor(email3);
  const token3 = tokenFrom(mail3, '/verify');
  const ver3 = await api('POST', '/api/auth/verify', { body: { token: token3 } });
  check('подтверждение третьего юзера: 200', ver3.status === 200, `got ${ver3.status}`);
  const putAfterVerify = await api('PUT', '/api/auth/email', { cookie: reg3.cookie, body: { email: `vp-late-${run}@smoke.test` } });
  check('PUT /api/auth/email после подтверждения: 409', putAfterVerify.status === 409, `got ${putAfterVerify.status} ${JSON.stringify(putAfterVerify.json)}`);

  // ── 16. /verify-pending для уже подтверждённого редиректит на /onboarding ──
  const pendingVerified = await api('GET', '/verify-pending', { cookie: reg.cookie });
  check('/verify-pending подтверждённого редиректит на /onboarding',
    [301, 302, 307, 308].includes(pendingVerified.status) && (pendingVerified.location || '').includes('/onboarding'),
    `${pendingVerified.status} location=${pendingVerified.location}`);

  // ── 17. /onboarding для подтверждённого больше НЕ редиректит на /verify-pending ──
  const onbVerified = await api('GET', '/onboarding', { cookie: reg.cookie });
  check('/onboarding для подтверждённого отдаёт страницу (200), не редирект',
    onbVerified.status === 200, `got ${onbVerified.status} location=${onbVerified.location}`);

  // ── 18. Лимит попыток смены адреса: свежий юзер, N+1-я попытка в пределах часа блокируется ──
  const limitEmail = `vp-limit-${run}@smoke.test`;
  const limitReg = await api('POST', '/api/auth/register', { body: { email: limitEmail, password: PASS1 } });
  check('регистрация юзера для проверки лимита: 200', limitReg.status === 200, `got ${limitReg.status}`);
  const limitUserId = limitReg.json?.user?.user_id;
  const limit = Number(process.env.SAAS_RL_EMAIL_CHANGE_USER) || 3;
  let lastStatus = null;
  for (let i = 0; i < limit; i++) {
    const r = await api('PUT', '/api/auth/email', { cookie: limitReg.cookie, body: { email: `vp-limit-${run}-${i}@smoke.test` } });
    lastStatus = r.status;
    check(`смена адреса #${i + 1}/${limit} в пределах лимита: 200`, r.status === 200, `got ${r.status} ${JSON.stringify(r.json)}`);
  }
  const overLimit = await api('PUT', '/api/auth/email', { cookie: limitReg.cookie, body: { email: `vp-limit-${run}-over@smoke.test` } });
  check(`попытка #${limit + 1} блокируется лимитом: 429`, overLimit.status === 429, `got ${overLimit.status} ${JSON.stringify(overLimit.json)}`);
  const limitUserRow = (await q(`SELECT email FROM auth.users WHERE user_id = $1`, [limitUserId]))[0];
  check('адрес после блокировки НЕ изменился на "over"-вариант', !limitUserRow?.email?.includes('-over@'), JSON.stringify(limitUserRow));
} catch (e) {
  console.error('UNCAUGHT:', e);
  failed++;
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  // Удаляем по префиксу run — покрывает и смену адреса (email поменялся),
  // и все vp-limit-*-N адреса.
  const likePattern = `vp-%${run}%@smoke.test`;
  await q(`DELETE FROM auth.user_tokens WHERE user_id IN (SELECT user_id FROM auth.users WHERE email LIKE $1)`, [likePattern]).catch(cf);
  await q(`DELETE FROM auth.memberships WHERE user_id IN (SELECT user_id FROM auth.users WHERE email LIKE $1)`, [likePattern]).catch(cf);
  await q(`DELETE FROM auth.users WHERE email LIKE $1`, [likePattern]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users WHERE email LIKE 'vp-%@smoke.test'");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
