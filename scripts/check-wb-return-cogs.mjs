#!/usr/bin/env node
// scripts/check-wb-return-cogs.mjs — SQL-приёмка политики возвратного COGS WB
// (владелец, 2026-08-21, дословная цитата, тот же день/решение, что Ozon
// коммит 5a3221d): «В возвратах должна учитываться только расходка на них,
// себестоимость не учитывается, потому что часть из них идут заново в
// продажу». worker/collectors/wb_order_costs.py::_aggregate_sql теперь
// зануляет cost ЯВНО (CASE WHEN is_return=1 THEN 0, не NULL) — этот скрипт
// проверяет РЕЗУЛЬТАТ на реальных данных (тест чистой функции невозможен:
// в отличие от Ozon (build_order_costs — чистая Python-функция,
// scripts/check-ozon-profit-calc.py), WB-сборщик — чистый SQL без
// выделяемой чистой функции, см. докстроку wb_order_costs.py).
//
// Подключение — ТОЛЬКО saas_ro (readonlyPgConfig): сторожу не нужны права
// на запись, ничего не пишет.
//
// До фикса (найдено разведкой задачи): join cost_overrides в SQL не был
// условен на is_return — cost возврата списывался как обычно, хотя
// комментарий сборщика утверждал обратное (docs/metrics-contract.md §7,
// ДО правки: «нужен отдельный SQL-аудит wb_order_costs на строках
// is_return=1»). Проверка 1 — прямой регресс-щит на это: без CASE-фикса
// она красная на любом кабинете со строками is_return=1 И совпадающим
// cost_overrides (кабинет 1 — 114 строк / 119 756 ₽ до фикса).
//
// Проверки (все кабинеты с строками wb_order_costs, найденные динамически):
//   1. is_return=1 → cost == 0 (не NULL, не что-либо ещё) БЕЗ ИСКЛЮЧЕНИЙ.
//   2. is_return=1 → profit == round(cost_value_pay − 0 − logistics, 2)
//      (формула сборщика применена ПОСЛЕ зануления cost — не «фантомная»
//      прибыль, реальная arithmetic-проверка построчно).
//   3. is_return=0 → cost НЕ форсится (может быть и 0 через cost_overrides,
//      и ненулевым — проверка лишь в том, что CASE не зацепил продажные
//      строки: COUNT(is_return=0 AND cost IS NULL) не регрессирует сам
//      CASE — информационная строка, не повод для FAIL).
//   4. Дублей (cabinet_id, srid) нет — идемпотентность апсерта не нарушена.
//
// Использование:
//   node scripts/check-wb-return-cogs.mjs
//   node scripts/check-wb-return-cogs.mjs --cabinet 1
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';

function parseArgs(argv) {
  const out = { cabinet: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cabinet') out.cabinet = Number(argv[++i]);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const fmtRub = (n) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TOL = 0.01;

const pool = new pg.Pool(readonlyPgConfig());
let failures = 0;
function verdict(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

try {
  const cabinets = args.cabinet
    ? [args.cabinet]
    : (await pool.query(`SELECT DISTINCT cabinet_id FROM tenant.wb_order_costs ORDER BY cabinet_id`)).rows.map((r) => r.cabinet_id);

  console.log('Сторож политики возвратного COGS WB (владелец, 2026-08-21) — кабинеты: ' + cabinets.join(', '));
  console.log('');

  for (const cabinetId of cabinets) {
    console.log(`─── Кабинет ${cabinetId} ───`);

    // ── Проверка 1: is_return=1 → cost == 0, явно (не NULL) ──
    const { rows: [badCost] } = await pool.query(
      `SELECT count(*) AS n, COALESCE(SUM(cost),0) AS sum_cost
       FROM tenant.wb_order_costs
       WHERE cabinet_id = $1 AND is_return = 1 AND (cost IS NULL OR cost <> 0)`,
      [cabinetId]
    );
    const { rows: [retTotal] } = await pool.query(
      `SELECT count(*) AS n FROM tenant.wb_order_costs WHERE cabinet_id = $1 AND is_return = 1`,
      [cabinetId]
    );
    verdict(
      'is_return=1 → cost == 0 явно (CASE WHEN is_return=1 THEN 0, не NULL) без исключений',
      Number(badCost.n) === 0,
      `нарушений: ${badCost.n} из ${retTotal.n} возвратных строк, Σcost нарушений=${fmtRub(num(badCost.sum_cost))} ₽`
    );

    // ── Проверка 2: is_return=1 → profit == round(cost_value_pay − 0 − logistics, 2) ──
    const { rows: [badProfit] } = await pool.query(
      `SELECT count(*) AS n
       FROM tenant.wb_order_costs
       WHERE cabinet_id = $1 AND is_return = 1
         AND ABS(profit - ROUND((COALESCE(cost_value_pay,0) - COALESCE(logistics,0))::numeric, 2)) > $2`,
      [cabinetId, TOL]
    );
    verdict(
      'is_return=1 → profit == round(cost_value_pay − 0(cost) − logistics, 2) построчно',
      Number(badProfit.n) === 0,
      `нарушений формулы: ${badProfit.n} из ${retTotal.n}`
    );

    // ── Проверка 3 (информационная, не FAIL): is_return=0 не задет CASE'ом ──
    const { rows: [saleInfo] } = await pool.query(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE cost IS NULL) AS null_cost_n,
              COALESCE(SUM(cost),0) AS sum_cost
       FROM tenant.wb_order_costs WHERE cabinet_id = $1 AND is_return = 0`,
      [cabinetId]
    );
    console.log(
      `INFO — продажные строки (is_return=0): ${saleInfo.n}, из них cost IS NULL: ${saleInfo.null_cost_n}, `
      + `Σcost=${fmtRub(num(saleInfo.sum_cost))} ₽ (не форсится политикой возвратов, справочно)`
    );

    // ── Проверка 4: дублей (cabinet_id, srid) нет ──
    const { rows: [dup] } = await pool.query(
      `SELECT count(*) AS n FROM (
         SELECT srid FROM tenant.wb_order_costs WHERE cabinet_id = $1 GROUP BY srid HAVING count(*) > 1
       ) d`,
      [cabinetId]
    );
    verdict('дублей (cabinet_id, srid) нет', Number(dup.n) === 0, `дублирующихся srid: ${dup.n}`);

    console.log('');
  }
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.stack || e.message}`);
  await pool.end().catch(() => {});
  process.exit(3);
} finally {
  await pool.end().catch(() => {});
}

if (failures === 0) {
  console.log('ALL PASS — политика возвратного COGS WB применена без исключений, дублей нет.');
  process.exit(0);
} else {
  console.log(`ИТОГО ${failures} РАСХОЖДЕНИЕ(Й) — см. блоки выше.`);
  process.exit(1);
}
