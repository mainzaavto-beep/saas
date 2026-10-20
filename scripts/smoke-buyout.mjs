#!/usr/bin/env node
// scripts/smoke-buyout.mjs — смоук «Процента выкупа» (11.10.2026, доп. 12.10 — финальное
// ревью и канон Ozon, задача 4). Только чтение. Проверяет:
//   1) /buyout 200; Σ размеров = товар по каждому счётчику; Σ товаров = KPI;
//   2) % = sold/resolved на каждой строке; resolved = sold+refused+returned;
//   3) выкуп Сводки (platform=all, то же окно) = выкуп страницы (platform=all) — по товарам
//      (ключ `${platform}:${nmId}`) и в итогах, И при дефолтном фильтре статуса
//      (без includeInactive), И при includeInactive=1 — иначе баг «inactive без sold, но
//      с отказами/возвратами когорты выпадает из дефолтной Сводки вместе со своими
//      счётчиками выкупа» (нашли 12.10) мог бы вернуться незамеченным (были PASS только
//      на includeInactive=1);
//   3б) то же самое отдельно для platform=ozon (страница ↔ Сводка, канон отправлений,
//      задача 4 плана «Процент выкупа — Ozon»);
//   4) недели (platform=all): 13 штук, последняя — текущая неделя (по МСК, как asOf в API).
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

const b = await get('buyout?platform=all');
check('buyout: HTTP 200 без error', b.status === 200 && !b.data.error, `${b.status} ${b.data.error || ''}`);
const { from, to, kpi, items = [] } = b.data;
console.log(`      окно ${from}..${to}: заказов ${kpi?.ordered}, доехало ${kpi?.resolved}, выкуп ${kpi?.buyoutPct} %, в пути ${kpi?.pending}`);

const badSizes = [];
for (const it of items) {
  if (!it.sizes.length) continue;
  for (const k of K) if (it.sizes.reduce((a, s) => a + s[k], 0) !== it[k]) badSizes.push(`${it.platform}:${it.nmId}.${k}`);
}
check('Σ размеров = товар', badSizes.length === 0, badSizes);
const badKpi = K.filter((k) => items.reduce((a, i) => a + i[k], 0) !== kpi[k]);
check('Σ товаров = KPI', badKpi.length === 0, badKpi);
const badPct = [kpi, ...items, ...items.flatMap((i) => i.sizes)].filter((r) =>
  r.resolved !== r.sold + r.refused + r.returned ||
  r.buyoutPct !== (r.resolved > 0 ? r2(100 * r.sold / r.resolved) : null));
check('% = sold/resolved, resolved = sold+refused+returned', badPct.length === 0, badPct.map((r) => r.nmId ?? r.size ?? 'kpi'));

// Ключ сравнения с Сводкой — platform:nmId (страница при platform=all несёт оба МП с
// общим nmId-пространством, Сводка — тот же ключ `${it.platform}:${Number(it.nm)}`).
const byKey = new Map(items.map((i) => [`${i.platform}:${Number(i.nmId)}`, i]));
const checkSummary = async (label, platform, qs, byKeyMap, wantKpi) => {
  const s = await get(`products-summary?platform=${platform}&from=${from}&to=${to}${qs}`);
  check(`products-summary platform=${platform}${qs}: HTTP 200`, s.status === 200 && !s.data.error, `${s.status} ${s.data.error || ''}`);
  const diff = [];
  for (const it of s.data.items || []) {
    const key = `${it.platform}:${Number(it.nm)}`;
    const p = byKeyMap.get(key);
    const want = p ? p.buyoutPct : null;
    if (it.buyoutPct !== want) diff.push(`${key}: сводка ${it.buyoutPct} ≠ страница ${want}`);
  }
  check(`выкуп по товарам: Сводка (${label}) = страница`, diff.length === 0, diff);
  check(`выкуп итогов: Сводка (${label}) = страница`, s.data.totals?.buyoutPct === wantKpi.buyoutPct,
    `${s.data.totals?.buyoutPct} ≠ ${wantKpi.buyoutPct}`);
};
// Дефолтный фильтр статуса (без includeInactive) — ровно то, что видит владелец на
// «Сводке по товарам» по умолчанию; именно здесь нашлась находка 1 финального ревью.
await checkSummary('all/default', 'all', '', byKey, kpi);
await checkSummary('all/includeInactive=1', 'all', '&includeInactive=1', byKey, kpi);

// WB отдельно (явная проверка, возвращена по финальному ревью 12.10.2026) — та же
// проверка, что для platform=all, но только площадка WB (своё окно то же from..to);
// ловит регрессию в WB-ветке, которую platform=all мог бы замаскировать суммой с Ozon.
const bWb = await get(`buyout?platform=wb&from=${from}&to=${to}`);
check('buyout platform=wb: HTTP 200 без error', bWb.status === 200 && !bWb.data.error, `${bWb.status} ${bWb.data.error || ''}`);
const kpiWb = bWb.data.kpi;
const byKeyWb = new Map((bWb.data.items || []).map((i) => [`${i.platform}:${Number(i.nmId)}`, i]));
console.log(`      WB ${from}..${to}: заказов ${kpiWb?.ordered}, доехало ${kpiWb?.resolved}, выкуп ${kpiWb?.buyoutPct} %, в пути ${kpiWb?.pending}`);
await checkSummary('wb/default', 'wb', '', byKeyWb, kpiWb);
await checkSummary('wb/includeInactive=1', 'wb', '&includeInactive=1', byKeyWb, kpiWb);

// Ozon отдельно (канон отправлений, задача 4 плана «Процент выкупа — Ozon», 12.10.2026) —
// та же проверка, что выше, но только площадка Ozon (своё окно то же from..to).
const bOz = await get(`buyout?platform=ozon&from=${from}&to=${to}`);
check('buyout platform=ozon: HTTP 200 без error', bOz.status === 200 && !bOz.data.error, `${bOz.status} ${bOz.data.error || ''}`);
const kpiOz = bOz.data.kpi;
const byKeyOz = new Map((bOz.data.items || []).map((i) => [`${i.platform}:${Number(i.nmId)}`, i]));
console.log(`      Ozon ${from}..${to}: заказов ${kpiOz?.ordered}, доехало ${kpiOz?.resolved}, выкуп ${kpiOz?.buyoutPct} %, в пути ${kpiOz?.pending}`);
await checkSummary('ozon/default', 'ozon', '', byKeyOz, kpiOz);
await checkSummary('ozon/includeInactive=1', 'ozon', '&includeInactive=1', byKeyOz, kpiOz);

const w = await get('buyout?series=1&platform=all');
const monday = weekStart(todayMsk());
check('недели: 13, последняя — текущая', w.data.weeks?.length === 13 && w.data.weeks[12].week === monday,
  `${w.data.weeks?.length} ${w.data.weeks?.[12]?.week} ≠ ${monday}`);

// Фильтр «Категория» (20.10.2026): категории разбивают товары без остатка — Σ по категориям =
// итог без фильтра (по каждому счётчику), строки фильтра — только своей категории, KPI = Σ строк.
for (const plat of ['all', 'wb', 'ozon']) {
  const base = await get(`buyout?platform=${plat}`);
  const cats = base.data.categories || [];
  check(`категории ${plat}: есть список`, Array.isArray(base.data.categories) && cats.length > 0, base.data.categories);
  check(`категории ${plat}: Σ товаров по категориям = товаров всего`,
    cats.reduce((a, [, n]) => a + n, 0) === base.data.items.length, `${cats.reduce((a, [, n]) => a + n, 0)} ≠ ${base.data.items.length}`);
  const sum = Object.fromEntries(K.map((k) => [k, 0]));
  for (const [c] of cats) {
    const f = await get(`buyout?platform=${plat}&cat=${encodeURIComponent(c)}`);
    for (const k of K) sum[k] += f.data.kpi[k];
    check(`  ${plat} «${c}»: строки только этой категории`, f.data.items.every((i) => i.category === c));
    const viaItems = K.every((k) => f.data.items.reduce((a, i) => a + i[k], 0) === f.data.kpi[k]);
    check(`  ${plat} «${c}»: KPI = Σ строк`, viaItems);
  }
  check(`категории ${plat}: Σ KPI по категориям = KPI без фильтра`, K.every((k) => sum[k] === base.data.kpi[k]),
    { sum, kpi: base.data.kpi });
  if (cats.length >= 2) {
    const two = await get(`buyout?platform=${plat}&cat=${encodeURIComponent(cats[0][0])}&cat=${encodeURIComponent(cats[1][0])}`);
    check(`категории ${plat}: две категории = Σ товаров двух`, two.data.items.length === cats[0][1] + cats[1][1]);
  }
}
const ws = await get(`buyout?series=1&platform=wb&cat=__нет_такой__`);
check('недели с несуществующей категорией: 13 пустых недель', ws.data.weeks?.length === 13 && ws.data.weeks.every((x) => x.ordered === 0));

// Разрез «одиночные / примерки» (20.10.2026): single + fitting = all, size + color + mixed = fitting
// по каждому счётчику KPI; дефолт fit=all совпадает с ответом без параметра.
for (const plat of ['all', 'wb', 'ozon']) {
  const g = async (fit) => (await get(`buyout?platform=${plat}&from=${from}&to=${to}&fit=${fit}`)).data;
  const [a, s, f, sz, c, m] = await Promise.all(['all', 'single', 'fitting', 'size', 'color', 'mixed'].map(g));
  const base = (await get(`buyout?platform=${plat}&from=${from}&to=${to}`)).data;
  check(`примерки ${plat}: fit=all = без параметра`, K.every((k) => a.kpi[k] === base.kpi[k]));
  const bad1 = K.filter((k) => s.kpi[k] + f.kpi[k] !== a.kpi[k]);
  check(`примерки ${plat}: одиночные + примерки = все`, bad1.length === 0, bad1);
  const bad2 = K.filter((k) => sz.kpi[k] + c.kpi[k] + m.kpi[k] !== f.kpi[k]);
  check(`примерки ${plat}: размеры + цвета + смешанные = примерки`, bad2.length === 0, bad2);
  check(`примерки ${plat}: сводка есть`, a.fitting && Number.isFinite(a.fitting.baskets), a.fitting);
  console.log(`      ${plat}: корзин-примерок ${a.fitting?.fittingBaskets} из ${a.fitting?.baskets} (${a.fitting?.basketShare} %), выкуп по заказу ${a.fitting?.basketBuyoutPct} %, ⚙ ${a.fitting?.estimated}`);
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
