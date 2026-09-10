#!/usr/bin/env node
// scripts/check-timing-30m-selftest.mjs — юнит-тест дельта-логики 30-минутной
// воронки (lib/timing30m.js), БЕЗ БД. Снимки кумулятивные: дельта слота =
// max(0, snap − предыдущий снимок того же ключа В ТОТ ЖЕ день); первый снимок
// дня = само значение. Один накопитель для нескольких источников (WB + Ozon).
import { aggregateSnapshots, emptyGrids, SLOT_COUNT, metricsForMp, M30_METRICS } from '../lib/timing30m.js';

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failed++;
}
const THU = '2026-09-10'; // четверг → byWeekday[3]

// 1. Дельта внутри дня: 10:00 → 5, 10:30 → 8 ⇒ слоты 20 и 21 = 5 и 3.
{
  const g = aggregateSnapshots([
    { key: 'A', date: THU, ts: `${THU} 10:00:00`, val: 5 },
    { key: 'A', date: THU, ts: `${THU} 10:30:00`, val: 8 },
  ]);
  check('слот 10:00 = 5', g.bySlot[20] === 5, g.bySlot);
  check('слот 10:30 = 3 (прирост)', g.bySlot[21] === 3, g.bySlot);
  check('total = 8', g.total === 8, g.total);
  check('час 10 = 8', g.byHour[10] === 8, g.byHour);
  check('четверг = 8', g.byWeekday[3] === 8, g.byWeekday);
  check('тепловая карта [чт][21] = 3', g.heatmap[3][21] === 3, g.heatmap[3]);
  check('48 слотов', g.bySlot.length === SLOT_COUNT);
}

// 2. Смена дня: счётчик сброшен в полночь — первый снимок дня = само значение, не 0.
{
  const g = aggregateSnapshots([
    { key: 'A', date: THU, ts: `${THU} 23:30:00`, val: 10 },
    { key: 'A', date: '2026-09-11', ts: '2026-09-11 00:00:00', val: 2 },
  ]);
  check('первый снимок нового дня = 2', g.bySlot[0] === 2, g.bySlot);
  check('пятница = 2', g.byWeekday[4] === 2, g.byWeekday);
}

// 3. Отрицательная дельта (корректировка МП) → 0, не отток.
{
  const g = aggregateSnapshots([
    { key: 'A', date: THU, ts: `${THU} 10:00:00`, val: 5 },
    { key: 'A', date: THU, ts: `${THU} 10:30:00`, val: 3 },
  ]);
  check('отрицательная дельта = 0', g.bySlot[21] === 0 && g.total === 5, g.bySlot);
}

// 4. Ключи независимы: у каждого свой «предыдущий снимок».
{
  const g = aggregateSnapshots([
    { key: 'A', date: THU, ts: `${THU} 10:00:00`, val: 5 },
    { key: 'A', date: THU, ts: `${THU} 10:30:00`, val: 6 },
    { key: 'B', date: THU, ts: `${THU} 10:00:00`, val: 100 },
    { key: 'B', date: THU, ts: `${THU} 10:30:00`, val: 100 },
  ]);
  check('A: +1, B: +0 ⇒ слот 10:30 = 1', g.bySlot[21] === 1, g.bySlot);
  check('total = 106', g.total === 106, g.total);
}

// 5. Общий накопитель для двух источников (WB + Ozon) — суммы складываются.
{
  const g = emptyGrids();
  aggregateSnapshots([{ key: 'wb:1', date: THU, ts: `${THU} 10:00:00`, val: 5 }], g);
  aggregateSnapshots([{ key: 'oz:1', date: THU, ts: `${THU} 10:00:00`, val: 7 }], g);
  check('WB 5 + Ozon 7 = 12 в одном слоте', g.bySlot[20] === 12 && g.total === 12, g.bySlot);
}

// 6. NULL-значение (метрика недоступна кабинету) = 0, не NaN.
{
  const g = aggregateSnapshots([{ key: 'A', date: THU, ts: `${THU} 10:00:00`, val: null }]);
  check('null → 0, deltaCount = 0', g.total === 0 && g.deltaCount === 0, g);
}

// 7. Каталог метрик по площадке: «Все МП» — только общие (заказы, заказы ₽, корзины);
//    WB — свои (клики, продажи, избранные), без показов Ozon; Ozon — показы и реклама, без избранного.
{
  const keys = (mp) => metricsForMp(mp).map((m) => m.v);
  check('all: только общие метрики', JSON.stringify(keys('all')) === JSON.stringify(['orders', 'order_sum', 'cart']), keys('all'));
  check('wb: есть clicks/favorites, нет views', keys('wb').includes('clicks') && keys('wb').includes('favorites') && !keys('wb').includes('views'), keys('wb'));
  check('ozon: есть views/ad_spend, нет favorites', keys('ozon').includes('views') && keys('ozon').includes('ad_spend') && !keys('ozon').includes('favorites'), keys('ozon'));
  check('у каждой метрики есть подпись', Object.values(M30_METRICS).every((m) => m.label));
  check('рекламные метрики помечены как кампанийные (без фильтра по товару)', M30_METRICS.ad_spend.ozAds === 'spend' && !M30_METRICS.ad_spend.oz);
}

console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
