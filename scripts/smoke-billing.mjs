#!/usr/bin/env node
// scripts/smoke-billing.mjs — смоук оплаты подписки.
// Использование: SAAS_YOOKASSA_MOCK=1 node scripts/smoke-billing.mjs [base_url]
// Требует сервер, поднятый с SAAS_YOOKASSA_MOCK=1 (без боевых ключей ЮKassa).
// Пишет в БД только свои записи (*@smoke.test, планы smoke-*) и сам их чистит.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const { types } = pg;
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
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || cookie };
}
const reg = (email) => api('POST', '/api/auth/register', { body: { email, password: 'smoke-pass-123' } });

const run = Date.now();
const PLAN = `smoke-1m-${run}`;
let cabinetId = null, ownerCookie = null, ownerId = null, viewerCookie = null, paymentId = null;

try {
  if (process.env.SAAS_YOOKASSA_MOCK !== '1') {
    console.error('Смоук требует SAAS_YOOKASSA_MOCK=1 (и сервер, поднятый с тем же флагом)');
    process.exit(2);
  }

  // ── Подготовка: тарифный план, владелец с кабинетом ──
  await q(`INSERT INTO billing.plans (code, months, price_rub, title, sort)
           VALUES ($1, 1, 100.00, 'Смоук-месяц', 999)`, [PLAN]);
  const owner = await reg(`billowner-${run}@smoke.test`);
  ownerCookie = owner.cookie; ownerId = owner.json?.user?.user_id;
  const onb = await api('POST', '/api/onboarding/start', {
    cookie: ownerCookie, body: { display_name: `smoke-bill-${run}`, marketplaces: ['wb'] },
  });
  cabinetId = onb.json?.cabinet?.cabinet_id;
  check('подготовка: кабинет создан', !!cabinetId, JSON.stringify(onb.json));

  // ── 1. Состояние на триале ──
  const st1 = await api('GET', `/api/cabinets/${cabinetId}/billing`, { cookie: ownerCookie });
  check('состояние: trial', st1.status === 200 && st1.json?.state === 'trial', `${st1.status} ${JSON.stringify(st1.json)}`);
  check('...планы отдаются', Array.isArray(st1.json?.plans) && st1.json.plans.some(p => p.code === PLAN), JSON.stringify(st1.json?.plans));

  // ── 2. Сумма берётся с сервера, а не из запроса ──
  const pay = await api('POST', `/api/cabinets/${cabinetId}/billing/pay`, {
    cookie: ownerCookie, body: { plan_code: PLAN, amount_rub: 1 },
  });
  check('создание платежа: 200 + ссылка', pay.status === 200 && typeof pay.json?.confirmation_url === 'string', `${pay.status} ${JSON.stringify(pay.json)}`);
  paymentId = pay.json?.payment_id;
  const payRow = paymentId ? (await q(`SELECT amount_rub, status, months FROM billing.payments WHERE payment_id = $1`, [paymentId]))[0] : null;
  check('...сумма из плана (100), а не из тела запроса', Number(payRow?.amount_rub) === 100, JSON.stringify(payRow));
  check('...статус pending', payRow?.status === 'pending', String(payRow?.status));

  // ── 3. Возврат из браузера сам по себе доступ не открывает ──
  const beforeWebhook = (await q(`SELECT paid_until FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]))[0];
  check('до вебхука paid_until пуст', beforeWebhook?.paid_until === null, String(beforeWebhook?.paid_until));

  // ── 3б. Вебхук без подтверждения у провайдера не зачисляет ──
  const earlyHook = await api('POST', `/api/billing/webhook/${process.env.SAAS_YOOKASSA_WEBHOOK_SECRET}`, {
    body: { event: 'payment.succeeded', object: { id: paymentId } },
  });
  const notCredited = (await q(`SELECT paid_until FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]))[0];
  check('вебхук без подтверждения провайдера не зачисляет', earlyHook.status === 200 && notCredited?.paid_until === null, `${earlyHook.status} ${notCredited?.paid_until}`);
  const stillPending = (await q(`SELECT status FROM billing.payments WHERE payment_id = $1`, [paymentId]))[0];
  check('...платёж остаётся pending', stillPending?.status === 'pending', String(stillPending?.status));

  // Мок-провайдер: помечаем платёж оплаченным «на стороне ЮKassa». Вебхук
  // сам этого делать не должен — он обязан узнать статус перепроверкой.
  await q(`UPDATE billing.payments SET raw = coalesce(raw,'{}'::jsonb) || '{"mock_status":"succeeded"}'::jsonb WHERE payment_id = $1`, [paymentId]);

  // ── 4. Зачисление по вебхуку ──
  const hook1 = await api('POST', `/api/billing/webhook/${process.env.SAAS_YOOKASSA_WEBHOOK_SECRET}`, {
    body: { event: 'payment.succeeded', object: { id: paymentId } },
  });
  check('вебхук принят: 200', hook1.status === 200, `${hook1.status} ${JSON.stringify(hook1.json)}`);
  const afterHook = (await q(`SELECT paid_until FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]))[0];
  check('paid_until сдвинут', !!afterHook?.paid_until, String(afterHook?.paid_until));
  const payRow2 = (await q(`SELECT status, paid_until_after FROM billing.payments WHERE payment_id = $1`, [paymentId]))[0];
  check('...платёж succeeded с записанной датой', payRow2?.status === 'succeeded' && !!payRow2?.paid_until_after, JSON.stringify(payRow2));

  // ── 5. Повторный вебхук не продлевает второй раз ──
  await api('POST', `/api/billing/webhook/${process.env.SAAS_YOOKASSA_WEBHOOK_SECRET}`, {
    body: { event: 'payment.succeeded', object: { id: paymentId } },
  });
  const afterHook2 = (await q(`SELECT paid_until FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]))[0];
  check('повторный вебхук не продлил', String(afterHook2?.paid_until) === String(afterHook?.paid_until), `${afterHook?.paid_until} → ${afterHook2?.paid_until}`);

  // ── 6. Неверный секрет в URL вебхука отклоняется ──
  const badHook = await api('POST', `/api/billing/webhook/wrong-secret-000`, {
    body: { event: 'payment.succeeded', object: { id: paymentId } },
  });
  check('вебхук с чужим секретом: 404', badHook.status === 404, `got ${badHook.status}`);

  // ── 7. Состояние стало active ──
  const st2 = await api('GET', `/api/cabinets/${cabinetId}/billing`, { cookie: ownerCookie });
  check('состояние: active', st2.json?.state === 'active', JSON.stringify(st2.json?.state));
  check('...платёж виден в истории', Array.isArray(st2.json?.payments) && st2.json.payments.length === 1, JSON.stringify(st2.json?.payments));

  // ── 8. Наблюдатель не может платить ──
  const viewer = await reg(`billviewer-${run}@smoke.test`);
  viewerCookie = viewer.cookie;
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'viewer')`, [viewer.json?.user?.user_id, cabinetId]);
  const viewerPay = await api('POST', `/api/cabinets/${cabinetId}/billing/pay`, { cookie: viewerCookie, body: { plan_code: PLAN } });
  check('наблюдатель не может оплатить: 403', viewerPay.status === 403, `got ${viewerPay.status}`);
  const viewerSee = await api('GET', `/api/cabinets/${cabinetId}/billing`, { cookie: viewerCookie });
  check('...но состояние видит: 200', viewerSee.status === 200, `got ${viewerSee.status}`);

  // ── 9. Блокировка просроченного кабинета ──
  await q(`UPDATE auth.cabinets SET trial_ends_at = now() - interval '30 days', paid_until = now() - interval '10 days' WHERE cabinet_id = $1`, [cabinetId]);
  const locked = await api('GET', `/api/cabinets/${cabinetId}/members`, { cookie: ownerCookie });
  check('кабинетный API заблокирован: 402', locked.status === 402 && locked.json?.code === 'subscription_required', `${locked.status} ${JSON.stringify(locked.json)}`);
  const billingStillOpen = await api('GET', `/api/cabinets/${cabinetId}/billing`, { cookie: ownerCookie });
  check('биллинговый API доступен при блокировке', billingStillOpen.status === 200 && billingStillOpen.json?.state === 'locked', `${billingStillOpen.status} ${JSON.stringify(billingStillOpen.json?.state)}`);
  const payWhenLocked = await api('POST', `/api/cabinets/${cabinetId}/billing/pay`, { cookie: ownerCookie, body: { plan_code: PLAN } });
  check('оплатить из блокировки можно', payWhenLocked.status === 200, `got ${payWhenLocked.status}`);

  // Страницы: заблокированный кабинет уводит на оплату, сама оплата открыта.
  const lockedPage = await fetch(`${BASE}/cabinets/${cabinetId}/summary`, { headers: { cookie: ownerCookie }, redirect: 'manual' });
  check('страница кабинета при блокировке: редирект на оплату',
    lockedPage.status === 307 && (lockedPage.headers.get('location') || '').includes(`/cabinets/${cabinetId}/billing`),
    `${lockedPage.status} ${lockedPage.headers.get('location')}`);
  const billingPage = await fetch(`${BASE}/cabinets/${cabinetId}/billing`, { headers: { cookie: ownerCookie }, redirect: 'manual' });
  check('страница оплаты при блокировке открывается (нет цикла)', billingPage.status === 200, `${billingPage.status} ${billingPage.headers.get('location')}`);

  // ── 10. Отсрочка: срок вышел вчера — доступ ещё есть ──
  await q(`UPDATE auth.cabinets SET paid_until = now() - interval '1 day' WHERE cabinet_id = $1`, [cabinetId]);
  const graceCall = await api('GET', `/api/cabinets/${cabinetId}/members`, { cookie: ownerCookie });
  check('в отсрочке доступ сохраняется: 200', graceCall.status === 200, `got ${graceCall.status}`);
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
  console.error("CLEANUP: не все тестовые записи удалены, проверь billing.payments, billing.plans, auth.users");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
