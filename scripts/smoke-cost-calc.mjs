#!/usr/bin/env node
// scripts/smoke-cost-calc.mjs — смоук «Калькулятора себестоимости» (спека 2026-10-22). Только кабинет #1.
// Владелец: создать расчёт → в списке с ₽/шт по формуле (пример 591,5) → обновить → «как новый» →
// удалить оба; невалидный ввод → 400; viewer (если есть) — POST 403. Свои записи убирает за собой.
// Запуск: node scripts/smoke-cost-calc.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
if (CAB !== 1) { console.error('смоук пишет в БД — только кабинет #1'); process.exit(2); }
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail).slice(0, 400)}`); if (!cond) failed++; };

async function cookieFor(userId) {
  const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [userId]);
  const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version, active_cabinet_id: null, touched_at: Date.now() },
    { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
  return `saas_session=${encodeURIComponent(seal)}`;
}
const call = async (cookie, method, body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/cost-calc`, {
    method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const own = await cookieFor(owner_user_id);
const EX = { name: '__smoke cost-calc', qty: 100, weight_kg: 0.5, price_cny: 30, china_delivery_cny: 200,
  cargo_usd_per_kg: 3.5, ff_logistics_rub: 5000, rate_cny: 12, rate_usd: 90, note: 'смоук' };
const created = [];
try {
  const g0 = await call(own, 'GET');
  check('GET 200, role owner', g0.status === 200 && g0.data.role === 'owner', g0);

  const s1 = await call(own, 'POST', { action: 'save', ...EX });
  check('save → id', s1.status === 200 && s1.data.id > 0, s1);
  created.push(s1.data.id);
  let it = (await call(own, 'GET')).data.items.find((x) => x.id === s1.data.id);
  check('в списке, 591,5 ₽/шт, итого 59 150', it && Math.abs(it.result.unitRub - 591.5) < 1e-9 && Math.abs(it.result.totalRub - 59150) < 1e-9, it);

  const g1 = (await call(own, 'GET')).data;
  check('defaults — из последнего расчёта', g1.defaults?.rate_usd === 90 && g1.defaults?.cargo_usd_per_kg === 3.5, g1.defaults);

  const u = await call(own, 'POST', { action: 'save', id: s1.data.id, ...EX, qty: 200 });
  it = (await call(own, 'GET')).data.items.find((x) => x.id === s1.data.id);
  check('обновление по id', u.status === 200 && it?.qty === 200, { u, it });

  const c = await call(own, 'POST', { action: 'save', ...EX, name: EX.name + ' копия' });
  created.push(c.data.id);
  const items = (await call(own, 'GET')).data.items;
  check('«как новый» — отдельная строка, исходный цел', c.data.id !== s1.data.id && items.some((x) => x.id === s1.data.id && x.qty === 200), c);

  check('пустое имя → 400', (await call(own, 'POST', { action: 'save', ...EX, name: ' ' })).status === 400);
  check('отрицательное → 400', (await call(own, 'POST', { action: 'save', ...EX, qty: -1 })).status === 400);
  check('чужой id → 404', (await call(own, 'POST', { action: 'save', id: 999999999, ...EX })).status === 404);

  const viewers = await query(`SELECT user_id FROM auth.memberships WHERE cabinet_id = $1 AND role = 'viewer' LIMIT 1`, [CAB]);
  if (viewers[0]) {
    const vc = await cookieFor(viewers[0].user_id);
    check('viewer: GET 200', (await call(vc, 'GET')).status === 200);
    check('viewer: POST 403', (await call(vc, 'POST', { action: 'save', ...EX })).status === 403);
  } else console.log('SKIP  viewer — в кабинете нет наблюдателя');
} finally {
  for (const id of created) {
    const d = await call(own, 'POST', { action: 'delete', id });
    check(`delete ${id}`, d.status === 200, d);
  }
  const left = (await call(own, 'GET')).data.items.filter((x) => x.name.startsWith('__smoke'));
  check('за собой убрано', left.length === 0, left);
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
