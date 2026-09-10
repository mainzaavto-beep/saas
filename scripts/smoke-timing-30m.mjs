#!/usr/bin/env node
// scripts/smoke-timing-30m.mjs — смоук роута /api/cabinets/1/timing в режиме
// granularity=m30 после добавления Ozon (миграция 057, ozon_metrics_30m.py).
// Аутентификация — sealed-cookie тем же способом, что profit-snapshot.mjs
// (без записи в БД). Прод-порт 3200; второй аргумент — base_url.
// Запуск: node scripts/smoke-timing-30m.mjs [cabinetId] [baseUrl]
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
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`}`);
  if (!cond) failed++;
};

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
const cookie = `saas_session=${encodeURIComponent(seal)}`;
const get = async (qs) => {
  const res = await fetch(`${BASE}/api/cabinets/${CAB}/timing?${qs}`, { headers: { cookie } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};

// 1. Прежний режим по часам не сломан.
{ const r = await get('mp=all'); check('hour: 200 и heatmap 7×24', r.status === 200 && r.json?.heatmap?.length === 7 && r.json.heatmap[0].length === 24, r.text.slice(0, 200)); }

// 2. m30 Ozon: показы всего — есть данные за сегодня, каталог метрик Ozon.
{
  const r = await get('granularity=m30&mp=ozon&metric=views');
  check('m30 ozon views: 200', r.status === 200, r.text.slice(0, 200));
  check('m30 ozon views: total > 0', (r.json?.total || 0) > 0, r.json?.note || r.json?.total);
  check('m30 ozon: heatmap 7×48', r.json?.heatmap?.length === 7 && r.json.heatmap[0].length === 48);
  const keys = (r.json?.availableMetrics || []).map((m) => m.v);
  check('m30 ozon: в каталоге ad_spend и нет favorites', keys.includes('ad_spend') && !keys.includes('favorites'), keys);
}

// 3. m30 Ozon реклама: расход по кампаниям > 0; с фильтром по товару — честная заметка, а не «все кампании».
{
  const r = await get('granularity=m30&mp=ozon&metric=ad_spend');
  check('m30 ozon ad_spend: total > 0', (r.json?.total || 0) > 0, r.json?.note || r.json?.total);
  const f = await get('granularity=m30&mp=ozon&metric=ad_spend&brand=X');
  check('m30 ozon ad_spend + фильтр товара: total 0 и заметка', f.json?.total === 0 && /кампани/i.test(f.json?.note || ''), f.json?.note);
}

// 4. «Все МП» по заказам = WB + Ozon (оба > 0 сегодня).
{
  const all = await get('granularity=m30&mp=all&metric=orders');
  const wb = await get('granularity=m30&mp=wb&metric=orders');
  const oz = await get('granularity=m30&mp=ozon&metric=orders');
  check('m30 all orders = wb + ozon', all.json?.total === (wb.json?.total || 0) + (oz.json?.total || 0),
    { all: all.json?.total, wb: wb.json?.total, oz: oz.json?.total });
  check('m30 wb orders > 0 (WB-сборщик снова пишет)', (wb.json?.total || 0) > 0, wb.json?.note);
  const keys = (all.json?.availableMetrics || []).map((m) => m.v);
  check('m30 all: только общие метрики', JSON.stringify(keys) === JSON.stringify(['orders', 'order_sum', 'cart']), keys);
}

// 5. Метрика, которой нет у площадки (favorites у Ozon) — пусто с заметкой, не 500.
{ const r = await get('granularity=m30&mp=ozon&metric=favorites'); check('m30 ozon favorites: 200, total 0, note', r.status === 200 && r.json?.total === 0 && !!r.json?.note, r.text.slice(0, 200)); }

console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
