#!/usr/bin/env node
// scripts/smoke-buyout.mjs — смоук «Процента выкупа» (11.10.2026, доп. 12.10 — финальное
// ревью). Только чтение. Проверяет:
//   1) /buyout 200; Σ размеров = товар по каждому счётчику; Σ товаров = KPI;
//   2) % = sold/resolved на каждой строке; resolved = sold+refused+returned;
//   3) WB-выкуп Сводки (platform=wb, то же окно) = выкуп страницы — по товарам и в итогах,
//      И при дефолтном фильтре статуса (без includeInactive), И при includeInactive=1 —
//      иначе баг «inactive без sold, но с отказами/возвратами когорты выпадает из
//      дефолтной Сводки вместе со своими счётчиками выкупа» (нашли 12.10) мог бы
//      вернуться незамеченным (были PASS только на includeInactive=1).
//   4) недели: 13 штук, последняя — текущая неделя (по МСК, как asOf в API).
// Аутентификация — sealed-cookie, как scripts/smoke-purchase-need.mjs.
// Запуск: node scripts/smoke-buyout.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query } = await import('../lib/db.js');
const { todayMsk, weekStart } = await import('../lib/buyout.js');
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
const K = ['ordered', 'self', 'returned', 'sold', 'refused', 'cancelledPre', 'pending'];
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

const b = await get('buyout');
check('buyout: HTTP 200 без error', b.status === 200 && !b.data.error, `${b.status} ${b.data.error || ''}`);
const { from, to, kpi, items = [] } = b.data;
console.log(`      окно ${from}..${to}: заказов ${kpi?.ordered}, доехало ${kpi?.resolved}, выкуп ${kpi?.buyoutPct} %, в пути ${kpi?.pending}`);

const badSizes = [];
for (const it of items) {
  if (!it.sizes.length) continue;
  for (const k of K) if (it.sizes.reduce((a, s) => a + s[k], 0) !== it[k]) badSizes.push(`${it.nmId}.${k}`);
}
check('Σ размеров = товар', badSizes.length === 0, badSizes);
const badKpi = K.filter((k) => items.reduce((a, i) => a + i[k], 0) !== kpi[k]);
check('Σ товаров = KPI', badKpi.length === 0, badKpi);
const badPct = [kpi, ...items, ...items.flatMap((i) => i.sizes)].filter((r) =>
  r.resolved !== r.sold + r.refused + r.returned ||
  r.buyoutPct !== (r.resolved > 0 ? r2(100 * r.sold / r.resolved) : null));
check('% = sold/resolved, resolved = sold+refused+returned', badPct.length === 0, badPct.map((r) => r.nmId ?? r.size ?? 'kpi'));

const byNm = new Map(items.map((i) => [Number(i.nmId), i]));
const checkSummary = async (label, qs) => {
  const s = await get(`products-summary?platform=wb&from=${from}&to=${to}${qs}`);
  check(`products-summary${qs}: HTTP 200`, s.status === 200 && !s.data.error, `${s.status} ${s.data.error || ''}`);
  const diff = [];
  for (const it of s.data.items || []) {
    const p = byNm.get(Number(it.nm));
    const want = p ? p.buyoutPct : null;
    if (it.buyoutPct !== want) diff.push(`${it.nm}: сводка ${it.buyoutPct} ≠ страница ${want}`);
  }
  check(`выкуп по товарам: Сводка (${label}) = страница`, diff.length === 0, diff);
  check(`выкуп итогов: Сводка (${label}) = страница`, s.data.totals?.buyoutPct === kpi.buyoutPct,
    `${s.data.totals?.buyoutPct} ≠ ${kpi.buyoutPct}`);
};
// Дефолтный фильтр статуса (без includeInactive) — ровно то, что видит владелец на
// «Сводке по товарам» по умолчанию; именно здесь нашлась находка 1 финального ревью.
await checkSummary('default', '');
await checkSummary('includeInactive=1', '&includeInactive=1');

const w = await get('buyout?series=1');
const monday = weekStart(todayMsk());
check('недели: 13, последняя — текущая', w.data.weeks?.length === 13 && w.data.weeks[12].week === monday,
  `${w.data.weeks?.length} ${w.data.weeks?.[12]?.week} ≠ ${monday}`);

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
