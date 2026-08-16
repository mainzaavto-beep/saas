#!/usr/bin/env node
// scripts/check-ozon-profit-delta.mjs — помесячная дельта прибыли Ozon:
// старая модель (tenant.ozon_order_costs, боевая, метод transaction/list) vs
// новая модель (tenant.ozon_order_costs_shadow, метод начислений accrual/by-day)
// — задача 4 плана «переезд финансов Ozon на методы начислений»
// (.superpowers/sdd/2026-08-15-ozon-profit-switch/, docs/ozon-profit-switch-delta.md).
//
// Подключение — ТОЛЬКО под saas_ro (readonlyPgConfig): сверке не нужны права
// на запись, admin-креды здесь не используются. Пишет данные исключительно
// сборщик worker/collectors/ozon_order_costs.py --target-table
// tenant.ozon_order_costs_shadow (см. отчёт задачи 4).
//
// ⚠️ ВАЖНАЯ НАХОДКА (не бага скрипта, свойство данных): старый источник
// (tenant.ozon_finance_report, откуда строилась боевая tenant.ozon_order_costs
// методом v1) в БД покрывает только 2026-05-01..2026-08-16 — то же самое
// ограничение уже зафиксировано в scripts/check-ozon-accruals.mjs (шапка
// файла, задача 5 плана «переезд финансов на начисления»). Для месяцев ДО
// 2026-05 «старой» прибыли в боевой таблице попросту нет (0 строк) — это НЕ
// значит «прибыль была нулевой», это означает «сравнивать не с чем», и
// колонки diff в этих строках отмечены "н/д", а не как 0%/0₽ совпадение.
//
// ⚠️ ЗАГРЯЗНЕНИЕ БОЕВЫХ ДАННЫХ v2 (см. docs/ozon-profit-switch-delta.md,
// раздел «Ранний деплой v2»): плановый systemd-таймер saas-worker уже
// подхватил переписанный сборщик (коммит fc8e2e5, 2026-08-16 16:54:29 MSK) и
// прогнал его БЕЗ --target-table (боевая таблица) в ближайший тик (17:05:58
// MSK) — это переписало 2026-08-14 и 2026-08-15 в tenant.ozon_order_costs
// уже НОВОЙ моделью. Месяц 2026-08 в таблице ниже помечен "v2-загрязнение":
// его "старая" колонка на самом деле частично (2 из 15 дней месяца) уже
// новая — сравнение в этом месяце занижает истинную дельту.
import pg from 'pg';
import { compare } from '../lib/reference.js';
import { readonlyPgConfig } from './lib/pgpass.mjs';
import { NONITEM_PROMO_TYPE_IDS } from './lib/ozon-promo-type-ids.mjs';

const CABINETS = [1, 1008];

// Месяцы покрытия начислений (2025-08-14 — первый день истории tenant.ozon_accruals,
// см. отчёт задачи 2 плана; вчера — конец покрытия задачи 4, сегодняшний день
// сознательно не пересчитывается, см. бриф задачи 4). Список совпадает с
// чанками прогона shadow (см. отчёт задачи 4).
const MONTHS = [
  ['2025-08', '2025-08-14', '2025-08-31'],
  ['2025-09', '2025-09-01', '2025-09-30'],
  ['2025-10', '2025-10-01', '2025-10-31'],
  ['2025-11', '2025-11-01', '2025-11-30'],
  ['2025-12', '2025-12-01', '2025-12-31'],
  ['2026-01', '2026-01-01', '2026-01-31'],
  ['2026-02', '2026-02-01', '2026-02-28'],
  ['2026-03', '2026-03-01', '2026-03-31'],
  ['2026-04', '2026-04-01', '2026-04-30'],
  ['2026-05', '2026-05-01', '2026-05-31'],
  ['2026-06', '2026-06-01', '2026-06-30'],
  ['2026-07', '2026-07-01', '2026-07-31'],
  ['2026-08', '2026-08-01', '2026-08-15'],
];

// Месяцы, чья боевая (old) tenant.ozon_order_costs частично уже переписана
// v2-кодом плановым прогоном таймера (см. шапку файла) — найдено запросом к
// jobs.collector_runs (первый run_kind='main' после коммита fc8e2e5) и
// updated_at боевой таблицы (см. отчёт задачи 4).
const V2_CONTAMINATED_MONTHS = new Set(['2026-08']);

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const fmtRub = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const pool = new pg.Pool(readonlyPgConfig());

async function monthRow(cabinetId, ym, dateFrom, dateTo) {
  const oldSql = `SELECT COALESCE(sum(profit),0) AS profit, count(*) AS n
    FROM tenant.ozon_order_costs WHERE cabinet_id=$1 AND sale_dt BETWEEN $2 AND $3`;
  const newSql = `SELECT COALESCE(sum(profit),0) AS profit, count(*) AS n
    FROM tenant.ozon_order_costs_shadow WHERE cabinet_id=$1 AND sale_dt BETWEEN $2 AND $3`;
  const cabSql = `SELECT COALESCE(sum(amount),0) AS amount, count(*) AS n
    FROM tenant.ozon_cabinet_costs WHERE cabinet_id=$1 AND cost_type LIKE 'accrual\\_%' AND date BETWEEN $2 AND $3`;
  const promoSql = `SELECT COALESCE(sum(accrued),0) AS amount, count(*) AS n
    FROM tenant.ozon_accruals WHERE cabinet_id=$1 AND type_id = ANY($2::int[]) AND date BETWEEN $3 AND $4`;

  const [{ rows: [oldR] }, { rows: [newR] }, { rows: [cabR] }, { rows: [promoR] }] = await Promise.all([
    pool.query(oldSql, [cabinetId, dateFrom, dateTo]),
    pool.query(newSql, [cabinetId, dateFrom, dateTo]),
    pool.query(cabSql, [cabinetId, dateFrom, dateTo]),
    pool.query(promoSql, [cabinetId, [...NONITEM_PROMO_TYPE_IDS], dateFrom, dateTo]),
  ]);

  return {
    ym, dateFrom, dateTo,
    oldProfit: num(oldR.profit), oldN: Number(oldR.n),
    newProfit: num(newR.profit), newN: Number(newR.n),
    cabAccrual: num(cabR.amount), cabAccrualN: Number(cabR.n),
    promo: num(promoR.amount), promoN: Number(promoR.n),
    contaminated: V2_CONTAMINATED_MONTHS.has(ym),
  };
}

let allRows;
try {
  allRows = [];
  for (const cabinetId of CABINETS) {
    for (const [ym, dateFrom, dateTo] of MONTHS) {
      allRows.push(await monthRow(cabinetId, ym, dateFrom, dateTo));
    }
  }
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.message}`);
  await pool.end().catch(() => {});
  process.exit(3);
} finally {
  await pool.end().catch(() => {});
}

console.log('Дельта прибыли Ozon: старая модель (tenant.ozon_order_costs, боевая) vs новая модель');
console.log('(tenant.ozon_order_costs_shadow, метод начислений) — помесячно, по кабинету.');
console.log('');
console.log('⚠️ Месяцы ДО 2026-05 не имеют старых данных в БД (нет tenant.ozon_finance_report за');
console.log('   этот период) — колонка "старая" = 0/0 строк означает "нечего сравнивать", НЕ');
console.log('   "прибыль была нулевой". diff в этих строках помечен н/д.');
console.log('⚠️ Месяц(ы) с пометкой [v2] — боевая (старая) таблица частично уже переписана новым');
console.log('   кодом плановым прогоном воркера (см. шапку файла) — сравнение в них занижено.');
console.log('');

for (const cabinetId of CABINETS) {
  console.log(`─── Кабинет ${cabinetId} ───`);
  console.log(
    pad('месяц', 10) + padL('старое ₽ (n)', 22) + padL('новое ₽ (n)', 22)
    + padL('разница ₽', 14) + padL('разница %', 11) + padL('accrual_% ₽', 14) + padL('promo ₽', 14)
  );
  let sumOldComparable = 0, sumNewComparable = 0, sumNewAll = 0;
  const rows = allRows.filter((_r, i) => Math.floor(i / MONTHS.length) === CABINETS.indexOf(cabinetId));
  for (const r of rows) {
    const hasOld = r.oldN > 0;
    const { diffRub, diffPct } = hasOld ? compare(r.oldProfit, r.newProfit) : { diffRub: null, diffPct: null };
    const tag = r.contaminated ? ' [v2]' : '';
    console.log(
      pad(r.ym + tag, 10)
      + padL(`${fmtRub(r.oldProfit)} (${r.oldN})`, 22)
      + padL(`${fmtRub(r.newProfit)} (${r.newN})`, 22)
      + padL(hasOld ? fmtRub(diffRub) : 'н/д', 14)
      + padL(hasOld ? diffPct.toFixed(1) + '%' : 'н/д', 11)
      + padL(fmtRub(r.cabAccrual), 14)
      + padL(fmtRub(r.promo), 14)
    );
    sumNewAll += r.newProfit;
    if (hasOld) { sumOldComparable += r.oldProfit; sumNewComparable += r.newProfit; }
  }
  const { diffRub: totalDiff, diffPct: totalDiffPct } = compare(sumOldComparable, sumNewComparable);
  console.log(
    pad('ИТОГО за год (новая модель, все 13 мес.)', 32) + padL(fmtRub(sumNewAll), 22)
  );
  console.log(
    pad('ИТОГО сопоставимых мес. (2026-05..2026-08)', 32)
    + padL(`${fmtRub(sumOldComparable)} → ${fmtRub(sumNewComparable)}`, 34)
    + padL(fmtRub(totalDiff), 14)
    + padL(totalDiffPct.toFixed(1) + '%', 11)
  );
  console.log('');
}

console.log('Готово. Данные для docs/ozon-profit-switch-delta.md — таблица шага 2.');
process.exit(0);
