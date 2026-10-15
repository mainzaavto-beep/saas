#!/usr/bin/env node
// scripts/smoke-kpi.mjs — смоук «Дашборда показателей» (15.10.2026). Проверяет «одна цифра везде»:
//   1) /kpi отвечает 200 без errors, 24 базовые плитки на месте;
//   2) без фильтра деньги = /pnl total (прибыль, выручка, реализация, себестоимость, комиссия,
//      логистика, реклама, налог) за тот же период, Δ ≤ 0,01 ₽; маржа = /pnl margin;
//   3) тождество статей: хранение + приёмка + штрафы + прочие − компенсации = −cabinetCostsTotal /pnl;
//   4) прошлый период: plitka.prev прибыли = /pnl за prevPeriod;
//   5) штуки = Сводка (includeInactive=1): заказы шт/₽, продано, % выкупа;
//   6) магазин WB → прибыль = блок wb /pnl;
//   7) фильтр по бренду: прибыль = Σ profit строк Сводки этого бренда; кабинетные плитки unavailable;
//   8) save_layout → GET отдаёт тот же порядок; reset_layout → стандарт (пишет только кабинет #1).
// Запуск: node scripts/smoke-kpi.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  if (!cond) failed++;
};
const near = (a, b, eps = 0.011) => a != null && b != null && Math.abs(a - b) <= eps;

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 3600 });
const cookie = `saas_session=${encodeURIComponent(seal)}`;
const get = async (path) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { headers: { cookie } });
  return { status: r.status, data: await r.json() };
};
const post = async (body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/kpi`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const tile = (d, k) => d.tiles.find((t) => t.key === k);

for (const [from, to] of [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-14']]) {
  const tag = `${from}..${to}`;
  const k = await get(`kpi?from=${from}&to=${to}`);
  check(`${tag}: HTTP 200, errors пусто`, k.status === 200 && !k.data.error && k.data.errors.length === 0, k.data.error || k.data.errors);
  const d = k.data;
  check(`${tag}: 33 плитки (24 + 9)`, d.tiles.length === 33, d.tiles.length);

  const pnl = (await get(`pnl?from=${from}&to=${to}`)).data;
  const T = pnl.total;
  const pairs = [['profit', T.profit], ['revenue', T.revenue], ['realized', T.realized], ['cogs', T.cogs],
    ['commission', T.commission], ['logistics', T.logistics], ['ads', T.ads], ['tax', T.tax]];
  for (const [key, want] of pairs) check(`${tag}: ${key} = /pnl (${want})`, near(tile(d, key).value, want), tile(d, key).value);
  check(`${tag}: маржа = /pnl margin`, near(tile(d, 'profit').second.value, T.margin), [tile(d, 'profit').second.value, T.margin]);

  const net = ['storage', 'acceptance', 'penalties', 'otherDeductions'].reduce((a, x) => a + tile(d, x).value, 0) - tile(d, 'compensations').value;
  check(`${tag}: статьи кабинета = −cabinetCostsTotal (${-T.cabinetCostsTotal})`, near(net, -T.cabinetCostsTotal, 0.05), net);

  const pp = (await get(`pnl?from=${d.prevPeriod.from}&to=${d.prevPeriod.to}`)).data.total;
  check(`${tag}: прошлый период прибыль = /pnl prev (${pp.profit})`, near(tile(d, 'profit').prev, pp.profit), tile(d, 'profit').prev);

  const s = (await get(`products-summary?platform=all&from=${from}&to=${to}&includeInactive=1`)).data.totals;
  check(`${tag}: заказы шт = Сводка (${s.ordered})`, tile(d, 'orders').second.value === s.ordered, tile(d, 'orders').second.value);
  check(`${tag}: заказы ₽ = Сводка (${s.orderRub})`, near(tile(d, 'orders').value, s.orderRub, 0.05), tile(d, 'orders').value);
  check(`${tag}: продано шт = Сводка (${s.sold})`, tile(d, 'revenue').second.value === s.sold, tile(d, 'revenue').second.value);
  check(`${tag}: % выкупа = Сводка (${s.buyoutPct})`, near(tile(d, 'buyoutPct').value, s.buyoutPct), tile(d, 'buyoutPct').value);

  const wbShop = d.options.shops.find((x) => x.platform === 'wb');
  if (wbShop) {
    const w = (await get(`kpi?from=${from}&to=${to}&shops=${wbShop.id}`)).data;
    check(`${tag}: магазин WB → прибыль = /pnl wb (${pnl.wb?.profit})`, near(tile(w, 'profit').value, pnl.wb?.profit), tile(w, 'profit').value);
  }

  const brand = d.options.brands[0];
  if (brand) {
    const b = (await get(`kpi?from=${from}&to=${to}&brands=${encodeURIComponent(brand)}`)).data;
    const items = (await get(`products-summary?platform=all&from=${from}&to=${to}&includeInactive=1`)).data.items.filter((it) => (it.brand || '') === brand);
    const want = Math.round(items.reduce((a, it) => a + (it.profit || 0), 0) * 100) / 100;
    check(`${tag}: бренд «${brand}» прибыль = Σ строк Сводки (${want})`, near(tile(b, 'profit').value, want, 0.05), tile(b, 'profit').value);
    check(`${tag}: при товарном фильтре хранение недоступно`, tile(b, 'storage').unavailable === true && tile(b, 'storage').value === null);
  }
}

if (CAB === 1) {
  const order = ['roi', 'profit'];
  const s1 = await post({ action: 'save_layout', layout: { order, hidden: ['stock'], extra: ['payout'] } });
  const g = (await get('kpi?from=2026-10-01&to=2026-10-07')).data.layout;
  check('layout сохранён и читается', s1.status === 200 && g.order[0] === 'roi' && g.hidden.includes('stock') && g.extra.includes('payout'), g);
  const r = await post({ action: 'reset_layout' });
  check('reset_layout → стандарт', r.status === 200 && r.data.layout.order[0] === 'profit' && r.data.layout.extra.length === 0, r.data);
} else {
  console.log('SKIP  запись layout — только кабинет #1');
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
