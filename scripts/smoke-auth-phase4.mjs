#!/usr/bin/env node
// scripts/smoke-auth-phase4.mjs — смоук фазы 4: гигиена входа и текстов.
// Использование: node scripts/smoke-auth-phase4.mjs [base_url]
// Пишет в БД только записи *@smoke.test и сам их чистит.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { adminPgConfig } from './lib/pgpass.mjs';
import { verifyEmailViaSink } from './lib/mail-verify.mjs';

const { types } = pg;
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
  return { status: res.status, json, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || cookie };
}
const reg = (email) => api('POST', '/api/auth/register', { body: { email, password: 'smoke-pass-123' } });

const run = Date.now();
let cabinetId = null, ownerCookie = null, ownerId = null, mgrId = null, mgrCookie = null;

try {
  if (process.env.SAAS_MAIL_SINK !== '1' && !process.env.SAAS_SMTP_HOST) {
    console.error('Ни SAAS_MAIL_SINK=1, ни SAAS_SMTP_HOST не заданы — писем не будет, смоук бессмысленен');
    process.exit(2);
  }

  // ── Подготовка: владелец с кабинетом и менеджер в нём ──
  const owner = await reg(`p4owner-${run}@smoke.test`);
  ownerCookie = owner.cookie; ownerId = owner.json?.user?.user_id;
  // Оплата (проверка 6 ниже) требует подтверждённой почты владельца при
  // SAAS_REQUIRE_VERIFIED_EMAIL=1 — подтверждаем тем же путём, что и живой
  // клиент: письмо из раковины → POST /api/auth/verify.
  await verifyEmailViaSink(api, `p4owner-${run}@smoke.test`);
  const onb = await api('POST', '/api/onboarding/start', {
    cookie: ownerCookie, body: { display_name: `smoke-p4-${run}`, marketplaces: ['wb'] },
  });
  cabinetId = onb.json?.cabinet?.cabinet_id;
  check('подготовка: кабинет создан', !!cabinetId, JSON.stringify(onb.json));
  const mgr = await reg(`p4mgr-${run}@smoke.test`);
  mgrCookie = mgr.cookie; mgrId = mgr.json?.user?.user_id;
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'manager')`, [mgrId, cabinetId]);

  // ── 1. Выход только по POST ──
  const logoutGet = await fetch(`${BASE}/api/auth/logout`, { headers: { cookie: ownerCookie }, redirect: 'manual' });
  check('GET на выход отклоняется (405)', logoutGet.status === 405, `got ${logoutGet.status}`);
  const stillIn = await api('GET', `/api/cabinets/${cabinetId}/me`, { cookie: ownerCookie });
  check('...сессия после GET жива', stillIn.status === 200, `got ${stillIn.status}`);
  const logoutPost = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie: ownerCookie }, redirect: 'manual' });
  check('POST на выход работает (303 на /login)', logoutPost.status === 303 && (logoutPost.headers.get('location') || '').includes('/login'), `${logoutPost.status} ${logoutPost.headers.get('location')}`);

  // ── 2. Отметка о последнем входе ──
  const beforeLogin = (await q(`SELECT last_login_at FROM auth.users WHERE user_id = $1`, [ownerId]).catch(() => [{}]))[0];
  check('до входа last_login_at пуст', beforeLogin?.last_login_at === null, String(beforeLogin?.last_login_at));
  const relog = await api('POST', '/api/auth/login', { body: { email: `p4owner-${run}@smoke.test`, password: 'smoke-pass-123' } });
  check('вход: 200', relog.status === 200, `got ${relog.status}`);
  ownerCookie = relog.cookie;
  const afterLogin = (await q(`SELECT last_login_at FROM auth.users WHERE user_id = $1`, [ownerId]).catch(() => [{}]))[0];
  check('...last_login_at проставлен', !!afterLogin?.last_login_at, String(afterLogin?.last_login_at));

  // ── 3. Заблокированный аккаунт неотличим от неверного пароля ──
  const victim = `p4blocked-${run}@smoke.test`;
  const v = await reg(victim);
  await q(`UPDATE auth.users SET status = 'suspended' WHERE user_id = $1`, [v.json?.user?.user_id]);
  const blockedTry = await api('POST', '/api/auth/login', { body: { email: victim, password: 'smoke-pass-123' } });
  const wrongPass = await api('POST', '/api/auth/login', { body: { email: `p4ghost-${run}@smoke.test`, password: 'whatever-000' } });
  check('заблокированный аккаунт: 401 как при неверном пароле', blockedTry.status === 401, `got ${blockedTry.status}`);
  check('...текст ответа совпадает с обычной ошибкой входа',
    JSON.stringify(blockedTry.json) === JSON.stringify(wrongPass.json),
    `${JSON.stringify(blockedTry.json)} vs ${JSON.stringify(wrongPass.json)}`);

  // Время ответа тоже не должно выдавать, есть ли такой аккаунт: сегодня
  // несуществующий email отвечает мгновенно, живой — после проверки пароля.
  //
  // Первый вызов /api/auth/login после старта сервера идёт по «холодному»
  // пути (компиляция маршрута, прогрев пула соединений) и завышает замер на
  // порядок — это шум измерения, а не сигнал об утечке. Поэтому один
  // прогревочный запрос отбрасываем, а дальше берём медиану из пяти попыток.
  await api('POST', '/api/auth/login', { body: { email: `p4warmup-${run}@smoke.test`, password: 'whatever-000' } });
  const timeIt = async (email, password) => {
    const t = [];
    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      await api('POST', '/api/auth/login', { body: { email, password } });
      t.push(Date.now() - started);
    }
    return t.sort((a, b) => a - b)[2]; // медиана из пяти
  };
  const tGhost = await timeIt(`p4ghost2-${run}@smoke.test`, 'whatever-000');
  const tReal = await timeIt(`p4owner-${run}@smoke.test`, 'wrong-pass-000');
  check('время ответа не выдаёт существование аккаунта',
    Math.abs(tReal - tGhost) < 60 && tGhost > 15,
    `несуществующий ${tGhost}мс, существующий ${tReal}мс`);

  // ── 4. Ошибки управления командой — по-русски ──
  const badRole = await api('PUT', `/api/cabinets/${cabinetId}/members`, {
    cookie: ownerCookie, body: { user_id: ownerId, role: 'manager' },
  });
  check('смена роли владельца запрещена: 403', badRole.status === 403, `got ${badRole.status}`);
  check('...текст по-русски', /[а-яА-Я]/.test(badRole.json?.error || ''), String(badRole.json?.error));
  const noSuch = await api('PUT', `/api/cabinets/${cabinetId}/members`, {
    cookie: ownerCookie, body: { user_id: 999999999, role: 'viewer' },
  });
  check('несуществующий участник: текст по-русски', /[а-яА-Я]/.test(noSuch.json?.error || ''), String(noSuch.json?.error));
  const noFields = await api('PUT', `/api/cabinets/${cabinetId}/members`, { cookie: ownerCookie, body: {} });
  check('пустой запрос: текст по-русски', /[а-яА-Я]/.test(noFields.json?.error || ''), String(noFields.json?.error));

  // ── 4б. Операторская страница закрыта для обычного клиента ──
  // На /health видны все кабинеты, сроки подписок и платежи с расхождениями —
  // туда пускает только allowlist SAAS_OPS_USER_IDS.
  const healthAnon = await api('GET', '/api/health');
  check('/api/health анониму: 401', healthAnon.status === 401, `got ${healthAnon.status}`);
  const healthUser = await api('GET', '/api/health', { cookie: ownerCookie });
  check('/api/health обычному клиенту: 403', healthUser.status === 403, `got ${healthUser.status} ${JSON.stringify(healthUser.json)}`);
  check('...и никаких данных в ответе', !healthUser.json?.billing && !healthUser.json?.payments_mismatch && !healthUser.json?.runs, JSON.stringify(healthUser.json));

  // ── 5. Менеджер не может оплачивать подписку ──
  const mgrPay = await api('POST', `/api/cabinets/${cabinetId}/billing/pay`, {
    cookie: mgrCookie, body: { plan_code: 'whatever' },
  });
  check('менеджер не может оплатить: 403', mgrPay.status === 403, `got ${mgrPay.status} ${JSON.stringify(mgrPay.json)}`);

  // ── 6. Платёж с несошедшейся суммой виден как требующий разбора ──
  const planCode = `smoke-p4-${run}`;
  await q(`INSERT INTO billing.plans (code, months, price_rub, title, sort) VALUES ($1, 1, 100.00, 'Смоук-п4', 999)`, [planCode]);
  const pay = await api('POST', `/api/cabinets/${cabinetId}/billing/pay`, { cookie: ownerCookie, body: { plan_code: planCode } });
  const payId = pay.json?.payment_id;
  check('платёж создан', !!payId, JSON.stringify(pay.json));
  // «Провайдер» подтверждает оплату, но на другую сумму (наша цена 100).
  await q(`UPDATE billing.payments SET raw = coalesce(raw,'{}'::jsonb) || '{"mock_status":"succeeded","mock_amount_rub":777}'::jsonb WHERE payment_id = $1`, [payId]);
  await api('POST', `/api/billing/webhook/${process.env.SAAS_YOOKASSA_WEBHOOK_SECRET}`, {
    body: { event: 'payment.succeeded', object: { id: payId } },
  });
  const mism = (await q(`SELECT status, paid_until_after FROM billing.payments WHERE payment_id = $1`, [payId]))[0];
  check('несовпадение суммы: статус mismatch', mism?.status === 'mismatch', JSON.stringify(mism));
  check('...подписка не продлена', mism?.paid_until_after === null, String(mism?.paid_until_after));
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  if (cabinetId) {
    await q(`DELETE FROM billing.payments WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  }
  await q(`DELETE FROM billing.plans WHERE code LIKE 'smoke-%'`).catch(cf);
  await q(`DELETE FROM auth.user_tokens WHERE user_id IN (SELECT user_id FROM auth.users WHERE email LIKE $1)`, [`%-${run}@smoke.test`]).catch(cf);
  await q(`DELETE FROM auth.users WHERE email LIKE $1`, [`%-${run}@smoke.test`]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users, billing.plans, billing.payments");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
