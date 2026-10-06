#!/usr/bin/env node
// scripts/smoke-purchase-need.mjs — смоук страницы «Потребность» (06.10.2026) и логистики WB
// в юнитке. Только чтение. Проверяет:
//   1) /purchase-need отвечает 200; итоги = Σ строк; формула «Закупить» на каждой строке;
//   2) одиночный артикул без позиции склада: «На МП» и скорость = /stocks (vel=7) — одна цифра
//      (отрицательное «доступно» Ozon — резерв больше остатка — «Потребность» считает нулём);
//   3) неактивных артикулов (tenant.item_status) в строках нет;
//   4) /unit/all: у WB-товаров с фактом логистика = F + R(1−b)/b, по кабинету
//      Σ(логистика × продано) не из воздуха (logisticsFbo задан у всех не-черновиков).
// Аутентификация — sealed-cookie, как scripts/smoke-stocks-sizes.mjs.
// Запуск: node scripts/smoke-purchase-need.mjs [cabinetId=1] [baseUrl]
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
const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
const get = async (path) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { headers: { cookie: `saas_session=${encodeURIComponent(seal)}` } });
  return { status: r.status, data: await r.json() };
};

const pn = await get('purchase-need?window=7&horizon=30');
check('purchase-need: HTTP 200 без error', pn.status === 200 && !pn.data.error, `${pn.status} ${pn.data.error || ''}`);
const rows = pn.data.rows || [];
console.log(`      строк ${rows.length}, к закупке ${pn.data.totals?.toBuyItems} поз. / ${pn.data.totals?.needQty} шт, без привязки ${pn.data.unlinked?.length}`);
const buy = rows.filter((r) => r.needQty > 0);
check('итоги = Σ строк', pn.data.totals.items === rows.length && pn.data.totals.needQty === buy.reduce((a, r) => a + r.needQty, 0));
const badF = rows.filter((r) => {
  const want = Math.max(0, Math.ceil(Math.round(r.velocity * 30 * 1e6) / 1e6 - (r.mpQty + r.ownQty + r.transitQty)));
  return want !== r.needQty;
}).map((r) => `${r.key}: ${r.needQty}`);
check('Закупить = ⌈скорость × 30 − остаток⌉ на каждой строке', badF.length === 0, badF);

const st = await get('stocks?vel=7');
const byKey = new Map((st.data.items || []).map((it) => [`${it.platform}:${Number(it.sku)}`, it]));
const solo = rows.filter((r) => r.ownQty === 0 && r.skus.wb.length + r.skus.ozon.length === 1);
const diff = [];
for (const r of solo) {
  const it = byKey.get(r.key);
  if (!it) continue;
  if (Math.max(0, Number(it.quantity)) !== r.mpQty) diff.push(`${r.key} qty ${it.quantity}≠${r.mpQty}`);
  if (Math.abs(Number(it.velocity) - r.velocity) > 0.006) diff.push(`${r.key} vel ${it.velocity}≠${r.velocity}`);
}
check(`одиночные артикулы совпадают с /stocks (${solo.length} строк)`, diff.length === 0, diff);

const inactive = new Set((await query(`SELECT platform, nm_id, product_id FROM tenant.item_status WHERE cabinet_id = $1 AND status = 'inactive'`, [CAB]))
  .map((r) => (r.platform === 'wb' ? `wb:${r.nm_id}` : `ozon:${r.product_id}`)));
const leaked = rows.filter((r) => r.ownQty === 0 && [...r.skus.wb.map((k) => `wb:${k}`), ...r.skus.ozon.map((k) => `ozon:${k}`)].every((k) => inactive.has(k))).map((r) => r.key);
check('неактивные артикулы не попали в строки', leaked.length === 0, leaked);

const un = await get('unit/all');
check('unit/all: HTTP 200', un.status === 200 && !un.data.error, un.data.error || '');
const wb = (un.data.items || []).filter((i) => i.platform === 'wb' && !i.draft);
const noF = wb.filter((i) => i.logisticsFbo == null).map((i) => i.sku);
check(`WB: логистика по факту/среднему кабинета у всех (${wb.length})`, noF.length === 0, noF);
const badL = wb.filter((i) => {
  const b = i.buyout > 0 ? i.buyout : 1;
  return Math.abs(i.logisticsFbo + i.returnLogistics * (1 - b) / b - i.logistics) > 0.02;
}).map((i) => i.sku);
check('WB: логистика = F + R(1−b)/b', badL.length === 0, badL);
const top = [...wb].filter((i) => !i.estimated).sort((a, b) => b.logistics - a.logistics).slice(0, 3)
  .map((i) => `${i.sku}: F ${i.logisticsFbo} R ${i.returnLogistics} выкуп ${(i.buyout * 100).toFixed(0)}% → ${i.logistics} ₽`);
console.log('      ' + top.join('\n      '));
process.exit(failed ? 1 : 0);
