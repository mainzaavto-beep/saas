#!/usr/bin/env node
// scripts/smoke-order-matrix.mjs — смоук «Матрицы заказов» (14.10.2026). Проверяет:
//   1) /order-matrix отвечает 200 на всех окнах; итоги по дням = Σ видимых нескрытых строк;
//   2) allTotal = прямой подсчёт по tenant.wb_orders / ozon_orders (все, включая отменённые);
//   3) одна цифра со «Сводкой по товарам»: allTotal = totals.ordered за то же окно (обе площадки);
//   4) нет неактивных (item_status) строк без заказов;
//   5) hide → строка пропала, hiddenCount +1; unhide → вернулась (пишет только в кабинет #1).
// Аутентификация — sealed-cookie, как scripts/smoke-purchase-need.mjs.
// Запуск: node scripts/smoke-order-matrix.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query, withTenant, tenantQuery } = await import('../lib/db.js');
// tenant.* под RLS: без контекста кабинета pool-запрос видит 0 строк.
const tq = (sql, params) => withTenant(CAB, () => tenantQuery(sql, params));
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  if (!cond) failed++;
};
const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
const cookie = `saas_session=${encodeURIComponent(seal)}`;
const get = async (path) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { headers: { cookie } });
  return { status: r.status, data: await r.json() };
};
const post = async (body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/order-matrix`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

const inactive = new Set((await tq(`SELECT platform, nm_id, product_id FROM tenant.item_status WHERE cabinet_id = $1 AND status = 'inactive'`, [CAB]))
  .map((r) => (r.platform === 'wb' ? `wb:${r.nm_id}` : `ozon:${r.product_id}`)));

for (const days of [7, 14, 30, 60]) {
  const m = await get(`order-matrix?days=${days}&platform=all`);
  check(`days=${days}: HTTP 200 без error`, m.status === 200 && !m.data.error, `${m.status} ${m.data.error || ''}`);
  const d = m.data;
  const vis = d.rows.filter((r) => !r.hidden);
  const byDayBad = d.dates.filter((dt) => vis.reduce((a, r) => a + (r.days[dt]?.t || 0), 0) !== d.totals.byDay[dt]);
  check(`days=${days}: итоги по дням = Σ строк`, byDayBad.length === 0 && d.totals.total === vis.reduce((a, r) => a + r.total, 0), byDayBad);
  const from = d.dates[0], to = d.dates[d.dates.length - 1];
  const [wb] = await tq(`SELECT COUNT(*)::int AS n FROM tenant.wb_orders WHERE cabinet_id=$1 AND nm_id IS NOT NULL AND order_dt >= $2 AND order_dt <= $3`, [CAB, from + 'T00:00:00', to + 'T23:59:59']);
  const [oz] = await tq(`SELECT COALESCE(SUM(COALESCE(qty,1)),0)::int AS n FROM tenant.ozon_orders WHERE cabinet_id=$1 AND product_id IS NOT NULL AND order_dt >= $2 AND order_dt <= $3`, [CAB, from + 'T00:00:00', to + 'T23:59:59']);
  check(`days=${days}: allTotal = прямой подсчёт по orders (${wb.n} + ${oz.n})`, d.totals.allTotal === wb.n + oz.n, `${d.totals.allTotal}`);
  for (const pf of ['wb', 'ozon']) {
    const mp = (await get(`order-matrix?days=${days}&platform=${pf}`)).data;
    const s = (await get(`products-summary?platform=${pf}&from=${from}&to=${to}&includeInactive=1`)).data;
    check(`days=${days} ${pf}: матрица ${mp.totals.allTotal} = «Заказано» на Сводке ${s.totals?.ordered}`, mp.totals.allTotal === s.totals?.ordered);
  }
  const badInactive = d.rows.filter((r) => inactive.has(r.key) && r.total === 0 && r.todayQty === 0).map((r) => r.key);
  check(`days=${days}: нет неактивных без заказов`, badInactive.length === 0, badInactive);
}

if (CAB === 1) {
  const m0 = (await get('order-matrix?days=14')).data;
  const target = m0.rows.find((r) => !r.hidden);
  if (target) {
    const h = await post({ action: 'hide', platform: target.platform, sku: target.sku });
    const m1 = (await get('order-matrix?days=14')).data;
    check(`hide ${target.key}: пропала, hiddenCount ${m0.hiddenCount}→${m1.hiddenCount}`,
      h.status === 200 && !m1.rows.some((r) => r.key === target.key) && m1.hiddenCount === m0.hiddenCount + 1);
    const m1s = (await get('order-matrix?days=14&showHidden=1')).data;
    check('showHidden=1: скрытая видна с hidden:true', m1s.rows.find((r) => r.key === target.key)?.hidden === true);
    const uh = await post({ action: 'unhide', platform: target.platform, sku: target.sku });
    const m2 = (await get('order-matrix?days=14')).data;
    check('unhide: вернулась', uh.status === 200 && m2.rows.some((r) => r.key === target.key) && m2.hiddenCount === m0.hiddenCount);
  }
  const bad = await post({ action: 'hide', platform: 'xx', sku: 1 });
  check('hide с кривой площадкой → 400', bad.status === 400);
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
