#!/usr/bin/env node
// scripts/smoke-onboarding.mjs — сквозной смоук нового пути клиента (Задача 6):
// регистрация → /verify-pending → смена адреса → подтверждение → онбординг
// открыт → мусорные ключи маркетплейса отклонены 422 mp_creds_invalid →
// подтверждённый адрес сменить нельзя.
//
// Пересекается с scripts/smoke-verify-pending.mjs (задача 5) в базовых шагах
// регистрации/подтверждения — это осознанно: без них нет сквозного пути к
// проверке ключей, ради которой писан этот файл. verify-pending остаётся
// источником истины по граничным случаям (лимиты, гонки, повторные токены);
// здесь — счастливый путь целиком плюс единственная часть, которую больше
// нигде не проверяют: реальный отказ на негодных ключах WB (422) и то, что
// после подтверждения владелец способен дойти до сохранения магазина.
//
// Использование: PGPASSFILE=/root/.pgpass-admin node scripts/smoke-onboarding.mjs http://127.0.0.1:3200
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
const email = `ob-${run}@smoke.test`;
const newEmail = `ob-changed-${run}@smoke.test`;
const takenEmail = `ob-taken-${run}@smoke.test`;
const PASS1 = 'smoke-pass-123';
let userId = null, cabinetId = null;

try {
  if (process.env.SAAS_MAIL_SINK !== '1' && !process.env.SAAS_SMTP_HOST) {
    console.error('Ни SAAS_MAIL_SINK=1, ни SAAS_SMTP_HOST не заданы — писем не будет, смоук бессмысленен');
    process.exit(2);
  }
  const masterKey = process.env.SAAS_CRED_MASTER_KEY;
  if (!masterKey) {
    console.error('SAAS_CRED_MASTER_KEY не задан — сохранение магазина невозможно, смоук бессмысленен');
    process.exit(2);
  }

  // ── 0. Подготовка: второй юзер — займёт адрес для проверки «занято» ──
  const takenReg = await api('POST', '/api/auth/register', { body: { email: takenEmail, password: PASS1 } });
  check('подготовка: второй юзер зарегистрирован (адрес будет "занят")', takenReg.status === 200, `got ${takenReg.status}`);

  // ── 1. Регистрация ведёт на /verify-pending, а не на /onboarding ──
  const reg = await api('POST', '/api/auth/register', { body: { email, password: PASS1, first_name: 'Онбординг' } });
  check('регистрация: 200', reg.status === 200, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  check('регистрация ведёт на подтверждение почты', reg.json?.next === '/verify-pending', JSON.stringify(reg.json));
  userId = reg.json?.user?.user_id;
  check('userId получен', !!userId, JSON.stringify(reg.json));

  // ── 2. Статус говорит «не подтверждён» ──
  const st = await api('GET', '/api/auth/verify/status', { cookie: reg.cookie });
  check('статус: адрес не подтверждён', st.json?.verified === false, JSON.stringify(st.json));

  // ── 3. Смена адреса до подтверждения работает и шлёт письмо на новый адрес ──
  const chg = await api('PUT', '/api/auth/email', { cookie: reg.cookie, body: { email: newEmail } });
  check('смена адреса: 200', chg.status === 200, `${chg.status} ${JSON.stringify(chg.json)}`);
  const mailAfterChange = await lastMailFor(newEmail);
  check('письмо ушло на новый адрес', mailAfterChange !== null, `нет письма для ${newEmail}`);

  // ── 4. Занятый адрес не отдаётся ──
  const busy = await api('PUT', '/api/auth/email', { cookie: reg.cookie, body: { email: takenEmail } });
  check('занятый адрес: 409', busy.status === 409, `${busy.status} ${JSON.stringify(busy.json)}`);

  // ── 5. Подтверждение по токену из письма ──
  const token = tokenFrom(mailAfterChange, '/verify');
  check('в письме есть токен подтверждения', !!token, String(mailAfterChange && mailAfterChange.slice(0, 120)));
  const ver = await api('POST', '/api/auth/verify', { body: { token } });
  check('подтверждение токеном: 200', ver.status === 200, `${ver.status} ${JSON.stringify(ver.json)}`);
  const st2 = await api('GET', '/api/auth/verify/status', { cookie: reg.cookie });
  check('после подтверждения статус verified', st2.json?.verified === true, JSON.stringify(st2.json));
  check('после подтверждения email — новый адрес', st2.json?.email === newEmail, JSON.stringify(st2.json));

  // ── 5б. Онбординг открыт: подтверждённый владелец без кабинета может дойти
  // до эндпоинта сохранения магазина (requireVerifiedEmail больше не режет).
  // Регистрация сама по себе кабинет не создаёт — заводим его напрямую,
  // как и другие смоуки, чтобы получить owner-membership для API-вызова.
  cabinetId = (await q(
    `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, status, trial_ends_at)
     VALUES ($1, $2, '{}', 'active', now() + interval '14 days') RETURNING cabinet_id`,
    [userId, `smoke-ob-cab-${run}`]
  ))[0].cabinet_id;
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'owner')`, [userId, cabinetId]);

  // ── 6. Ключи-мусор не сохраняются: 422 с кодом mp_creds_invalid ──
  // Реальный WB API (не заглушка): гарантированно отклоняет заведомо
  // некорректный токен на всех трёх проверяемых доступах (401 «token is
  // malformed» — проверено вручную на common/stats/prices эндпоинтах).
  const shop = await api('POST', `/api/cabinets/${cabinetId}/shops`, {
    cookie: reg.cookie,
    body: { mp_code: 'wb', shop_name: 'Смоук-магазин', api_creds: { wb: { token: 'garbage-not-a-real-token-' + run } } },
  });
  check('мусорные ключи отклонены', shop.status === 422 && shop.json?.code === 'mp_creds_invalid',
    `${shop.status} ${JSON.stringify(shop.json)}`);
  check('в ответе объяснено, что не так', String(shop.json?.error || '').length > 20, shop.json?.error);
  const shopRows = await q(`SELECT shop_id FROM auth.shops WHERE cabinet_id = $1`, [cabinetId]);
  check('отклонённый магазин не сохранён в БД', shopRows.length === 0, `в БД ${shopRows.length} строк`);

  // ── 7. Подтверждённый адрес сменить нельзя ──
  const chg2 = await api('PUT', '/api/auth/email', { cookie: reg.cookie, body: { email: `ob-late-${run}@smoke.test` } });
  check('смена подтверждённого адреса: 409', chg2.status === 409, `${chg2.status} ${JSON.stringify(chg2.json)}`);
} catch (e) {
  console.error('UNCAUGHT:', e);
  failed++;
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  if (cabinetId) {
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.shops WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  }
  const likePattern = `ob-%${run}%@smoke.test`;
  await q(`DELETE FROM auth.user_tokens WHERE user_id IN (SELECT user_id FROM auth.users WHERE email LIKE $1)`, [likePattern]).catch(cf);
  await q(`DELETE FROM auth.memberships WHERE user_id IN (SELECT user_id FROM auth.users WHERE email LIKE $1)`, [likePattern]).catch(cf);
  await q(`DELETE FROM auth.users WHERE email LIKE $1`, [likePattern]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users WHERE email LIKE 'ob-%@smoke.test'");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
