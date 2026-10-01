#!/usr/bin/env node
// scripts/smoke-stocks-sizes.mjs — смоук /api/cabinets/N/stocks: разбивка WB по размерам
// (миграция 063, tenant.wb_daily_stock_sizes). Только чтение. Проверяет:
//   1) у товаров с размерами Σ quantity/quantity_full/in_way по размерам = строка товара;
//   2) Σ скоростей размеров = скорость товара (допуск — округление 0,01 на размер);
//   3) Σ размеров в ответе = Σ wb_daily_stock_sizes в БД на дату среза (Δ=0);
//   4) у каждого размера есть имя (не «chrt N») и валидный статус;
//   5) «К закупке, шт» (lib/supplyPlan.js, как UI): строка товара = Σ по размерам,
//      размер с неизвестной скоростью → null; supplyTargetDays задан.
// Аутентификация — sealed-cookie, как scripts/smoke-timing-30m.mjs.
// Запуск: node scripts/smoke-stocks-sizes.mjs [cabinetId=1] [baseUrl] [vel=7]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query, withTenant } = await import('../lib/db.js');
const { purchaseNeedForRow, purchaseNeedForItem } = await import('../lib/supplyPlan.js');
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
const VEL = Number(process.argv[4] || 7);

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  if (!cond) failed++;
};

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
const res = await fetch(`${BASE}/api/cabinets/${CAB}/stocks?vel=${VEL}`, { headers: { cookie: `saas_session=${encodeURIComponent(seal)}` } });
const data = await res.json();
check('HTTP 200 без error', res.status === 200 && !data.error, `${res.status} ${data.error || ''}`);

const wb = (data.items || []).filter((it) => it.platform === 'wb');
const withSizes = wb.filter((it) => it.sizes);
console.log(`      WB товаров ${wb.length}, с размерами ${withSizes.length}, размеров ${withSizes.reduce((a, it) => a + it.sizes.length, 0)}, sizesSince=${data.wbSizesSince}, dateWb=${data.dateWb}`);
check('wbSizesSince задан', !!data.wbSizesSince);
check('есть товары с размерами', withSizes.length > 0);

const sum = (arr, k) => arr.reduce((a, x) => a + (Number(x[k]) || 0), 0);
const bad = [];
for (const it of withSizes) {
  for (const k of ['quantity', 'quantity_full', 'in_way_to', 'in_way_from']) {
    if (sum(it.sizes, k) !== Number(it[k])) bad.push(`${it.sku}.${k}: ${sum(it.sizes, k)}≠${it[k]}`);
  }
  if (it.sizes.every((s) => s.velocity != null)) {
    const d = Math.abs(sum(it.sizes, 'velocity') - Number(it.velocity));
    if (d > 0.01 * it.sizes.length + 1e-9) bad.push(`${it.sku}.velocity: Σ${sum(it.sizes, 'velocity')}≠${it.velocity}`);
  }
}
check('Σ размеров = строка товара (остатки, в пути, скорость)', bad.length === 0, bad);

const STATUSES = ['out', 'critical', 'low', 'ok', 'no_sales', 'unknown'];
const badSz = withSizes.flatMap((it) => it.sizes.filter((s) => /^chrt /.test(s.size) || !STATUSES.includes(s.status)).map((s) => `${it.sku}/${s.chrt_id}:${s.size}:${s.status}`));
check('у размеров есть имя и валидный статус', badSz.length === 0, badSz);

const apiQty = sum(withSizes.flatMap((it) => it.sizes), 'quantity');
const [db] = await withTenant(CAB, async (q) => (await q(
  `SELECT COALESCE(SUM(s.quantity),0)::int AS q FROM tenant.wb_daily_stock_sizes s
   WHERE s.date = $1::date AND s.nm_id = ANY($2::bigint[])`,
  [data.dateWb, withSizes.map((it) => it.sku)])).rows);
check(`Σ доступно по размерам: API ${apiQty} = БД ${db.q}`, apiQty === Number(db.q));

const P = { leadDays: 20, targetDays: data.supplyTargetDays };
check(`supplyTargetDays задан (${data.supplyTargetDays})`, Number(data.supplyTargetDays) >= 1);
const badNeed = [];
for (const it of withSizes) {
  const parts = it.sizes.map((s) => purchaseNeedForRow(s, P));
  for (const [i, s] of it.sizes.entries()) if ((s.velocity == null) !== (parts[i] == null)) badNeed.push(`${it.sku}/${s.size}: null-правило`);
  if (parts.every((v) => v != null) && purchaseNeedForItem(it, P) !== parts.reduce((a, v) => a + v, 0)) badNeed.push(`${it.sku}: товар≠Σ`);
}
check('«К закупке»: строка товара = Σ по размерам, неизвестная скорость → —', badNeed.length === 0, badNeed);
for (const it of withSizes.slice(0, 3)) {
  console.log(`      ${it.sku} ${String(it.name).slice(0, 24)}: к закупке ${purchaseNeedForItem(it, P)} = ` +
    it.sizes.map((s) => `${s.size}:${purchaseNeedForRow(s, P)}`).join(' + ') + ` (по товару было бы ${purchaseNeedForRow(it, P)})`);
}

console.log(failed ? `ИТОГ: ${failed} FAIL` : 'ИТОГ: ALL PASS');
process.exit(failed ? 1 : 0);
