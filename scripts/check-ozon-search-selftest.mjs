#!/usr/bin/env node
// scripts/check-ozon-search-selftest.mjs — чистые расчёты страницы «Поиск и запросы» (lib/ozonSearch.js), без БД.
import { aggregateSkus, buildQueryMatrix, kpiFromQueries, positionTone, weightedPosition } from '../lib/ozonSearch.js';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`); if (!cond) failed++; };

// weightedPosition: (10·100 + 30·300)/400 = 25; без спроса — среднее.
check('взвешенная позиция', weightedPosition([{ position: 10, search_users: 100 }, { position: 30, search_users: 300 }]) === 25);
check('взвешенная: нулевой спрос → среднее', weightedPosition([{ position: 10, search_users: 0 }, { position: 20, search_users: 0 }]) === 15);
check('взвешенная: пусто → null', weightedPosition([]) === null);
check('взвешенная: null позиции пропускаются', weightedPosition([{ position: null, search_users: 5 }, { position: 8, search_users: 5 }]) === 8);

// aggregateSkus
const rows = [
  { sku: 1, product_id: 11, name: 'A', article: 'a', date: '2026-09-09', position: 20, search_users: 100, view_users: 10, ctr: 1, gmv: 0 },
  { sku: 1, product_id: 11, name: 'A', article: 'a', date: '2026-09-10', position: 10, search_users: 300, view_users: 30, ctr: 1, gmv: 500 },
  { sku: 2, product_id: null, name: 'B', article: 'b', date: '2026-09-10', position: 150, search_users: 50, view_users: 1, ctr: 2, gmv: 0 },
];
const prev = [{ sku: 1, product_id: 11, date: '2026-09-02', position: 30, search_users: 100, view_users: 5, ctr: 5, gmv: 0 }];
const agg = aggregateSkus(rows, prev);
check('items: сортировка по спросу', agg.items.map((i) => i.sku).join() === '1,2', agg.items.map((i) => i.sku));
const a = agg.items[0];
check('item: позиция взвешенная 12.5', a.position === 12.5, a);
check('item: prev 30, delta +17.5 (лучше)', a.positionPrev === 30 && a.positionDelta === 17.5, a);
check('item: суммы', a.search_users === 400 && a.view_users === 40 && a.gmv === 500, a);
check('item: ctr = 40/400·100 = 10', a.ctr === 10, a);
check('item: spark по датам', JSON.stringify(a.spark) === JSON.stringify([{ date: '2026-09-09', position: 20 }, { date: '2026-09-10', position: 10 }]), a.spark);
check('item без каталога: product_id null, имя кабинета', agg.items[1].product_id === null && agg.items[1].name === 'B', agg.items[1]);
check('kpi: позиция по кабинету взвешена (12.5·400+150·50)/450', Math.abs(agg.kpi.position - 27.78) < 0.01, agg.kpi);
check('kpi: prev', agg.kpi.positionPrev === 30, agg.kpi);
check('пусто → items [] и kpi null', aggregateSkus([], []).items.length === 0 && aggregateSkus([], []).kpi.position === null);

// buildQueryMatrix
const q = [
  { query: 'карта памяти', date: '2026-09-09', position: 85, search_users: 1159, view_users: 20, ctr: 2, click_users: 2, orders: 0, gmv: 0 },
  { query: 'карта памяти', date: '2026-09-10', position: 72, search_users: 1191, view_users: 25, ctr: 2, click_users: 3, orders: 1, gmv: 900 },
  { query: 'micro sd', date: '2026-09-10', position: 95, search_users: 724, view_users: 5, ctr: 1, click_users: 0, orders: 0, gmv: 0 },
  { query: 'редкий', date: '2026-09-10', position: 3, search_users: 4, view_users: 1, ctr: 1, click_users: 0, orders: 0, gmv: 0 },
];
const dates = ['2026-09-09', '2026-09-10'];
const m = buildQueryMatrix(q, dates, {});
check('матрица: сортировка по спросу', m.rows.map((r) => r.query).join('|') === 'карта памяти|micro sd|редкий', m.rows.map((r) => r.query));
check('матрица: byDay и пропуск = null', m.rows[1].byDay['2026-09-09'] === null && m.rows[1].byDay['2026-09-10'] === 95, m.rows[1].byDay);
check('матрица: суммы и best/last', m.rows[0].search_users === 2350 && m.rows[0].orders === 1 && m.rows[0].best === 72 && m.rows[0].last === 72, m.rows[0]);
check('матрица: ctr = Σview/Σsearch·100 (2 знака)', m.rows[0].ctr === 1.91, m.rows[0]);
check('фильтр minDemand', buildQueryMatrix(q, dates, { minDemand: 100 }).rows.length === 2);
check('фильтр onlyOrders', buildQueryMatrix(q, dates, { onlyOrders: true }).rows.length === 1);

// kpiFromQueries — по последней дате
const k = kpiFromQueries(q);
check('kpi: top10 = 1 (редкий), top50 = 1', k.queriesTop10 === 1 && k.queriesTop50 === 1, k);
check('kpi: orders за период = 1', k.orders === 1, k);

// positionTone
check('tone', [positionTone(5), positionTone(25), positionTone(80), positionTone(300), positionTone(null)].join() === 'top,good,mid,low,none');

console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
