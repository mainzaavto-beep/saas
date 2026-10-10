#!/usr/bin/env node
// scripts/smoke-bonus.mjs — смоук премии менеджеров и прав (спека 2026-10-08). Только чтение.
//   1) владелец: GET /bonus 200, mode=owner;
//   2) у каждого сотрудника программы живой факт площадки = /pnl за то же окно (Δ = 0);
//   2б) фоллбек (программа пуста на cabinet #1): для каждой площадки кабинета считаем
//       карточку фиктивного сотрудника {user_id:0, salary:40000, bonus_pct:0.04,
//       threshold:0.65} за прошлый полный месяц напрямую через buildLiveCard и сверяем
//       platformFact с /pnl за то же окно — так канон факта проверяется даже без живых
//       сотрудников в программе;
//   3) если в кабинете есть manager: /bonus → только своя карточка (чужой user_id игнорируется)
//      или 403, /balance → 403, POST /bonus → 403.
// Запуск: node scripts/smoke-bonus.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query, withTenant } = await import('../lib/db.js');
const { buildLiveCard } = await import('../lib/bonusData.js');
const { normalizeTaxMode } = await import('../lib/tax.js');
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail).slice(0, 400)}`); if (!cond) failed++; };

async function cookieFor(userId) {
  const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [userId]);
  const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version, active_cabinet_id: null, touched_at: Date.now() },
    { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
  return `saas_session=${encodeURIComponent(seal)}`;
}
const call = async (cookie, path, init = {}) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { ...init, headers: { cookie, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const own = await cookieFor(owner_user_id);
const period = new Date(Date.now() + 3 * 3600e3 - 86400e3 * 15).toISOString().slice(0, 7);
const ob = await call(own, `bonus?period=${period}`);
check('владелец: /bonus 200, mode=owner', ob.status === 200 && ob.data.mode === 'owner', ob);
console.log(`      сотрудников в программе: ${ob.data.employees?.length ?? 0}, период ${period}`);

for (const e of ob.data.employees || []) {
  const c = (await call(own, `bonus?period=${period}&user_id=${e.user_id}`)).data.card;
  if (!c?.window || c.status === 'closed') { console.log(`      ${e.platform}/${e.user_id}: окно пусто или месяц закрыт — пропуск`); continue; }
  const pnl = (await call(own, `pnl?from=${c.window.from}&to=${c.window.to}`)).data;
  const mp = pnl?.[e.platform];
  check(`${e.platform}/${e.user_id}: выручка = /pnl`, mp && Math.abs(mp.revenue - c.platformFact.revenue) < 0.01, { pnl: mp?.revenue, bonus: c.platformFact.revenue });
  check(`${e.platform}/${e.user_id}: прибыль = /pnl`, mp && Math.abs(mp.profit - c.platformFact.profit) < 0.01, { pnl: mp?.profit, bonus: c.platformFact.profit });
}

// 2б. Фоллбек — программа может быть пуста (cabinet #1 сейчас без сотрудников),
// тогда проверка 2 выше ничего не проверяет. Считаем карточку фиктивного
// сотрудника напрямую через buildLiveCard (только чтение, внутри withTenant)
// за прошлый полный календарный месяц и сверяем с /pnl за то же окно — так
// канон факта площадки (wbProfitCabinet/ozProfitCabinet) проверяется всегда.
const [cabRow] = await query('SELECT marketplaces FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const platforms = (cabRow?.marketplaces || []).filter((p) => p === 'wb' || p === 'ozon');
const nowMsk = new Date(Date.now() + 3 * 3600e3);
const today = nowMsk.toISOString().slice(0, 10);
const prevMonth = new Date(Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth() - 1, 1));
const fbPeriod = `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, '0')}`;
console.log(`      фоллбек-проверка факта площадки (период ${fbPeriod}): площадки кабинета = ${platforms.join(', ') || 'нет'}`);

async function shopTaxFor(platform) {
  const rows = await query(
    `SELECT tax_mode FROM auth.shops WHERE cabinet_id = $1 AND is_active = true AND mp_code = $2 ORDER BY shop_id`,
    [CAB, platform]);
  const row = rows[rows.length - 1];
  return normalizeTaxMode(row?.tax_mode ?? null);
}

for (const platform of platforms) {
  const taxMode = await shopTaxFor(platform);
  const fakeEmployee = { user_id: 0, platform, salary: 40000, bonus_pct: 0.04, threshold: 0.65, is_active: true };
  const card = await withTenant(CAB, async () => buildLiveCard({ employee: fakeEmployee, period: fbPeriod, today, taxMode }));
  if (!card.window) { console.log(`      фоллбек ${platform}: окно пусто — пропуск`); continue; }
  const pnl = (await call(own, `pnl?from=${card.window.from}&to=${card.window.to}`)).data;
  const mp = pnl?.[platform];
  check(`фоллбек ${platform}: выручка = /pnl`, mp && Math.abs(mp.revenue - card.platformFact.revenue) < 0.01, { pnl: mp?.revenue, bonus: card.platformFact.revenue });
  check(`фоллбек ${platform}: прибыль = /pnl`, mp && Math.abs(mp.profit - card.platformFact.profit) < 0.01, { pnl: mp?.profit, bonus: card.platformFact.profit });
}

const managers = await query(`SELECT user_id FROM auth.memberships WHERE cabinet_id = $1 AND role = 'manager'`, [CAB]);
for (const { user_id } of managers) {
  const mc = await cookieFor(user_id);
  const other = (ob.data.employees || []).find((e) => Number(e.user_id) !== Number(user_id));
  const mb = await call(mc, `bonus?period=${period}${other ? `&user_id=${other.user_id}` : ''}`);
  check(`manager ${user_id}: /bonus — своя карточка или 403`,
    (mb.status === 200 && mb.data.mode === 'self' && Number(mb.data.card?.employee?.user_id) === Number(user_id)) || mb.status === 403, mb);
  check(`manager ${user_id}: /balance → 403`, (await call(mc, 'balance')).status === 403);
  check(`manager ${user_id}: POST /bonus → 403`, (await call(mc, 'bonus', { method: 'POST', body: JSON.stringify({ action: 'reopen' }) })).status === 403);
}
if (!managers.length) console.log('      менеджеров в кабинете нет — проверки доступа менеджера пропущены');

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
