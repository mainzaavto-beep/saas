#!/usr/bin/env node
// scripts/check-ozon-accruals.mjs — сверка старого (tenant.ozon_finance_report,
// /v3/finance/transaction/list) и нового (tenant.ozon_accruals,
// /v1/finance/accrual/by-day) источников финансов Ozon по ролям (задача 5
// плана «переезд финансов Ozon на методы начислений»,
// .superpowers/sdd/2026-08-11-ozon-accrual-migration/, docs/ozon-accrual-reconciliation.md).
//
// Подключение — ТОЛЬКО под saas_ro (readonlyPgConfig, см. scripts/check-reference.mjs):
// сверке не нужны права на запись, admin-креды здесь не используются.
//
// ═══════════════════════════════════════════════════════════════════════════
// Роли и их вывод — прямое продолжение таблицы «код → роль»
// docs/ozon-accrual-reconciliation.md §5 (задача 1). Ничего не переизобретено:
// ═══════════════════════════════════════════════════════════════════════════
//   • продажа            = POSTING, type_id IS NULL, accrued > 0 (блок commission
//                           продающего постинга) + логистика этого же постинга
//                           (type_id 32/29/98 — «продажа (логистика в составе)»,
//                           §5). Старое: payout_amount группы «Доставка покупателю».
//   • возврат             = POSTING, type_id IS NULL, accrued < 0 (тот же блок
//                           commission, но со знаком минус — возврат денег за
//                           отправление). Роль НЕ была подтверждена в задаче 1
//                           (в дне-образце 2026-08-05 возвратов не встретилось);
//                           подтверждена здесь, на июле 2026: 18 строк, −31 887,98 ₽
//                           — совпадает с старой группой «Получение возврата,
//                           отмены, невыкупа от покупателя» день-в-день, рубль-в-рубль.
//   • логистика возврата  = POSTING, type_id IN (32,29,45,59,98) БЕЗ блока commission
//                           того же accrual_id (постинг — чистый возврат, продающей
//                           строки нет). Старое: payout_amount группы «Доставка и
//                           обработка возврата, отмены, невыкупа».
//   • эквайринг           = ITEM, type_id = 1 (Acquiring, §5). Старое: payout_amount
//                           группы «Оплата эквайринга». Сходится точно (сумма — да,
//                           количество строк — нет: старое агрегирует по операции,
//                           новое — по товару внутри операции; это ожидаемо и не
//                           расхождение денег).
//   • доход от доставки   = NON_ITEM, type_id = 62 (RfbsClientDeliveryCharge — нет в
//                           таблице §5, потому что не встретился в дне-образце
//                           задачи 1). Подтверждён здесь: 45 строк, 8 955,00 ₽ —
//                           совпадает с старой группой «Перечисление за доставку
//                           от покупателя» день-в-день, рубль-в-рубль.
//   • прочее              = все остальные type_id обеих категорий ITEM/NON_ITEM,
//                           не разбираемые сегодня worker/collectors/ozon_order_costs.py
//                           (§5: реклама, продвижение, отзывы, страхование,
//                           упаковка, подписка Premium, кросс-докинг и т.п.) —
//                           считается остаточно (итог минус пять явных ролей),
//                           а не перечислением отдельных type_id: список кодов
//                           «прочего» растёт с каждым новым месяцем данных
//                           (в июле 2026 их на порядок больше, чем в дне-образце
//                           задачи 1), перечислять их поимённо здесь бессмысленно.
//
// ─── Известное объяснённое расхождение (не бага, но и не 0) ───────────────
// Постинги с НУЛЕВОЙ стоимостью товара (accruals_for_sale = commission_amount = 0
// в старой таблице) не получают блок commission в новом источнике вовсе — эвристика
// «есть блок commission → продажа» не может отличить такой постинг от чистого
// возврата (у него тоже нет блока commission), поэтому его логистика (type_id
// 32/29/45/59/98) попадает в «логистика возврата» вместо «продажа». Продажа
// занижена, логистика возврата настолько же завышена (по модулю), сумма обеих
// ролей вместе — и итог — не меняется. Разобрано и объяснено до постинга в
// docs/ozon-accrual-reconciliation.md §7.2 (на июле-2026: 4 постинга/835,00 ₽
// кабинет 1, 1 постинг/99,00 ₽ кабинет 1008 — эти числа НЕ хардкожены здесь,
// см. ниже).
//
// ⚠️ Ревью задачи 6 плана «унификация формул прибыли» (fix-раунд, п.2,
// .superpowers/sdd/2026-08-20-profit-unification/task-6-report.md):
// СТРУКТУРНЫЙ детектор вместо фиксированных −835/−99. `casusSql` ниже
// заново находит постинги-казус КАЖДЫЙ ПРОГОН, любым месяцем/кабинетом —
// join старого источника (нулевая `accruals_for_sale`/`commission_amount`
// по всем строкам "Доставка покупателю" одного `posting_id`) с новым
// (его логистика в бакете "логистика возврата" — `NOT is_sale`, через
// `unit_number = posting_id`). Найденная Σ применяется через ЧИСТУЮ функцию
// `applyCasus72` (scripts/lib/ozonAccrualsCasus72.mjs) — она НЕ угадывает
// сумму сама, только вычитает уже найденную; юнит-тест без БД —
// scripts/check-ozon-accruals-casus72-selftest.mjs (проверяет в т.ч., что
// ПОСТОРОННЕЕ, не покрытое казусом расхождение НЕ проглатывается). Если
// казус в периоде НЕ обнаружен (0 постингов) — коррекция не применяется
// (0 — не «подгонка под 0», а честный результат SQL).
//
// Использование: node scripts/check-ozon-accruals.mjs [cabinet_id] [date_from] [date_to]
// По умолчанию — июль 2026, кабинет 1 (период брифа задачи 5, полностью
// покрытый ОБОИМИ источниками: старая tenant.ozon_finance_report содержит
// данные только с 2026-05-01 по 2026-08-15 — см. проверку покрытия ниже).
import pg from 'pg';
import { compare } from '../lib/reference.js';
import { readonlyPgConfig } from './lib/pgpass.mjs';
import { applyCasus72 } from './lib/ozonAccrualsCasus72.mjs';

const cabinetId = Number(process.argv[2] || 1);
const dateFrom = process.argv[3] || '2026-07-01';
const dateTo = process.argv[4] || '2026-07-31';

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const fmtRub = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const pool = new pg.Pool(readonlyPgConfig());

let oldRow, newRow, coverage, newCoverage, casus;
try {
  // ── покрытие старого источника: предупреждаем, а не молчим, если период
  //    выходит за границы того, что реально лежит в tenant.ozon_finance_report ──
  const covSql = `
    SELECT min(substr(operation_dt, 1, 10)) AS min_dt, max(substr(operation_dt, 1, 10)) AS max_dt
    FROM tenant.ozon_finance_report WHERE cabinet_id = $1`;
  ({ rows: [coverage] } = await pool.query(covSql, [cabinetId]));

  // ── покрытие НОВОГО источника (F6 ревью fixwave, .superpowers/sdd/
  //    2026-08-11-ozon-accrual-migration/): та же самая проверка, симметрично
  //    tenant.ozon_accruals — сборщик собирает год истории, но не факт, что
  //    прогон уже дошёл до запрошенного периода (или период вовсе позже
  //    заморозки/раньше первого сбора) ──
  const newCovSql = `SELECT min(date)::text AS min_dt, max(date)::text AS max_dt FROM tenant.ozon_accruals WHERE cabinet_id = $1`;
  ({ rows: [newCoverage] } = await pool.query(newCovSql, [cabinetId]));

  // ── старое: пять именованных групп operation_type_name (worker/collectors/
  //    ozon_order_costs.py — OP_SALE/OP_RETURN/OP_RETURN_LOGISTICS/OP_ACQUIRING/
  //    OP_DELIVERY_INCOME) + общий итог, прочее — остаточно ──
  const oldSql = `
    SELECT
      COALESCE(sum(payout_amount) FILTER (WHERE operation_type_name = 'Доставка покупателю'), 0) AS sale,
      COALESCE(sum(payout_amount) FILTER (WHERE operation_type_name = 'Получение возврата, отмены, невыкупа от покупателя'), 0) AS return_,
      COALESCE(sum(payout_amount) FILTER (WHERE operation_type_name = 'Доставка и обработка возврата, отмены, невыкупа'), 0) AS return_logistics,
      COALESCE(sum(payout_amount) FILTER (WHERE operation_type_name = 'Оплата эквайринга'), 0) AS acquiring,
      COALESCE(sum(payout_amount) FILTER (WHERE operation_type_name = 'Перечисление за доставку от покупателя'), 0) AS delivery_income,
      COALESCE(sum(payout_amount), 0) AS total,
      count(*) AS n
    FROM tenant.ozon_finance_report
    WHERE cabinet_id = $1 AND substr(operation_dt, 1, 10) BETWEEN $2 AND $3`;
  ({ rows: [oldRow] } = await pool.query(oldSql, [cabinetId, dateFrom, dateTo]));

  // ── новое: роль по таблице «код → роль» (§5), see комментарий в шапке файла.
  //    has_sale — по каждому POSTING accrual_id: есть ли строка commission с
  //    положительной суммой (значит, постинг — продажа, а не возврат) ──
  const newSql = `
    WITH posting_sale_flag AS (
      SELECT cabinet_id, accrual_id, bool_or(type_id IS NULL AND accrued > 0) AS is_sale
      FROM tenant.ozon_accruals
      WHERE cabinet_id = $1 AND date BETWEEN $2 AND $3 AND accrued_category = 'POSTING'
      GROUP BY 1, 2
    )
    SELECT
      COALESCE(sum(a.accrued) FILTER (WHERE a.accrued_category = 'POSTING' AND a.type_id IS NULL AND a.accrued > 0), 0)
        + COALESCE(sum(a.accrued) FILTER (WHERE a.accrued_category = 'POSTING' AND a.type_id IN (32, 29, 98) AND f.is_sale), 0) AS sale,
      COALESCE(sum(a.accrued) FILTER (WHERE a.accrued_category = 'POSTING' AND a.type_id IS NULL AND a.accrued < 0), 0) AS return_,
      COALESCE(sum(a.accrued) FILTER (WHERE a.accrued_category = 'POSTING' AND a.type_id IN (32, 29, 45, 59, 98) AND NOT f.is_sale), 0) AS return_logistics,
      COALESCE(sum(a.accrued) FILTER (WHERE a.accrued_category = 'ITEM' AND a.type_id = 1), 0) AS acquiring,
      COALESCE(sum(a.accrued) FILTER (WHERE a.accrued_category = 'NON_ITEM' AND a.type_id = 62), 0) AS delivery_income,
      COALESCE(sum(a.accrued), 0) AS total,
      count(*) AS n
    FROM tenant.ozon_accruals a
    LEFT JOIN posting_sale_flag f ON f.cabinet_id = a.cabinet_id AND f.accrual_id = a.accrual_id
    WHERE a.cabinet_id = $1 AND a.date BETWEEN $2 AND $3`;
  ({ rows: [newRow] } = await pool.query(newSql, [cabinetId, dateFrom, dateTo]));

  // ── СТРУКТУРНЫЙ детектор «казуса §7.2» (см. докстроку файла выше) ──
  // Шаг 1: старый источник — posting_id, где ВСЕ строки "Доставка
  // покупателю" в периоде дают нулевую accruals_for_sale И нулевую
  // commission_amount (товар в отправлении ничего не стоит — платится
  // только доставка).
  // Шаг 2: join в новый источник по unit_number = posting_id — их
  // логистика (type_id 32/29/45/59/98), которая при текущей эвристике
  // (NOT is_sale, т.к. commission-блока нет вовсе) осела в "логистика
  // возврата". Σ accrued этих строк — и есть сумма казуса ЗА ЭТОТ прогон
  // (не хардкод; период/кабинет могут дать 0, 1, 4, 40 постингов).
  // ⚠️ $2/$3 используются здесь И в текстовом контексте (substr(...) BETWEEN),
  // И в контексте колонки date (date BETWEEN) — postgres извлечённый (extended
  // protocol) тип параметра единый на весь statement; без явного ::date каста
  // ниже он выводится как text из первого употребления и падает на "date >=
  // text" во втором. В newSql/covSql этой коллизии нет (там $2/$3 участвуют
  // только в одном типе контекста за раз) — здесь оба контекста впервые
  // встретились в одном запросе, поэтому касты нужны только тут.
  const casusSql = `
    WITH zero_postings AS (
      SELECT posting_id
      FROM tenant.ozon_finance_report
      WHERE cabinet_id = $1 AND substr(operation_dt, 1, 10) BETWEEN $2 AND $3
        AND operation_type_name = 'Доставка покупателю'
      GROUP BY posting_id
      HAVING sum(accruals_for_sale) = 0 AND sum(commission_amount) = 0
    ),
    posting_sale_flag AS (
      SELECT cabinet_id, accrual_id, bool_or(type_id IS NULL AND accrued > 0) AS is_sale
      FROM tenant.ozon_accruals
      WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date AND accrued_category = 'POSTING'
      GROUP BY 1, 2
    )
    SELECT count(DISTINCT a.accrual_id) AS n, COALESCE(sum(a.accrued), 0) AS amount
    FROM tenant.ozon_accruals a
    JOIN posting_sale_flag f ON f.cabinet_id = a.cabinet_id AND f.accrual_id = a.accrual_id
    WHERE a.cabinet_id = $1 AND a.date BETWEEN $2::date AND $3::date
      AND a.accrued_category = 'POSTING' AND a.type_id IN (32, 29, 45, 59, 98)
      AND NOT f.is_sale
      AND a.unit_number IN (SELECT posting_id FROM zero_postings)`;
  ({ rows: [casus] } = await pool.query(casusSql, [cabinetId, dateFrom, dateTo]));
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.message}`);
  await pool.end().catch(() => {});
  process.exit(3);
} finally {
  await pool.end().catch(() => {});
}

console.log(`Сверка Ozon: старое (tenant.ozon_finance_report) vs новое (tenant.ozon_accruals)`);
console.log(`Кабинет ${cabinetId}, период ${dateFrom}..${dateTo}`);
console.log('');

// ── покрытие старого источника ──
const oldCoverageOk = coverage && coverage.min_dt && coverage.max_dt
  && dateFrom >= coverage.min_dt && dateTo <= coverage.max_dt;
if (!coverage || !coverage.min_dt) {
  console.log('ВНИМАНИЕ: в tenant.ozon_finance_report нет ни одной строки по этому кабинету — старый источник недоступен, все "старые" значения ниже будут 0, это НЕ ноль по деньгам, а отсутствие данных.');
} else if (!oldCoverageOk) {
  console.log(`ВНИМАНИЕ: старый источник покрывает только ${coverage.min_dt}..${coverage.max_dt}, запрошенный период выходит за эти границы — "старые" суммы ниже НЕДОСТОВЕРНЫ (частичное или нулевое покрытие), не считать расхождение багом без проверки покрытия.`);
} else {
  console.log(`Покрытие старого источника: ${coverage.min_dt}..${coverage.max_dt} — запрошенный период внутри, сверка достоверна.`);
}

// ── покрытие НОВОГО источника — симметрично (F6 ревью fixwave) ──
const newCoverageOk = newCoverage && newCoverage.min_dt && newCoverage.max_dt
  && dateFrom >= newCoverage.min_dt && dateTo <= newCoverage.max_dt;
if (!newCoverage || !newCoverage.min_dt) {
  console.log('ВНИМАНИЕ: в tenant.ozon_accruals нет ни одной строки по этому кабинету — новый источник недоступен, все "новые" значения ниже будут 0, это НЕ ноль по деньгам, а отсутствие данных.');
} else if (!newCoverageOk) {
  console.log(`ВНИМАНИЕ: новый источник покрывает только ${newCoverage.min_dt}..${newCoverage.max_dt}, запрошенный период выходит за эти границы — "новые" суммы ниже НЕДОСТОВЕРНЫ (частичное или нулевое покрытие), не считать расхождение багом без проверки покрытия.`);
} else {
  console.log(`Покрытие нового источника: ${newCoverage.min_dt}..${newCoverage.max_dt} — запрошенный период внутри, сверка достоверна.`);
}
console.log('');

// ── Казус §7.2 — структурно найден (см. докстроку файла и casusSql выше).
// Печатается ВСЕГДА (0 постингов — тоже видимая, честная строка, не
// молчание), корректирует "продажа"/"логистика возврата" ДО сравнения с
// compare() — чистой функцией applyCasus72, которая не может случайно
// объяснить постороннее расхождение (проверено юнит-тестом без БД,
// scripts/check-ozon-accruals-casus72-selftest.mjs). ──
const casusN = Number(casus?.n) || 0;
const casusAmount = num(casus?.amount);
let newRowForCompare = newRow;
if (casusN > 0) {
  console.log(
    `ℹ️  известный казус §7.2 (docs/ozon-accrual-reconciliation.md): ${casusN} отправлени${casusN === 1 ? 'е' : 'й'} `
    + `с нулевой стоимостью товара, чья логистика (type_id 32/29/45/59/98) не получила блок commission в новом `
    + `источнике — ${fmtRub(casusAmount)} ₽ структурно осели в роли "логистика возврата" вместо "продажа". `
    + `Вычтено из сравнения ниже (роли скорректированы: продажа ${casusAmount >= 0 ? '+' : ''}${fmtRub(casusAmount)} ₽, `
    + `логистика возврата ${casusAmount >= 0 ? '-' : '+'}${fmtRub(Math.abs(casusAmount))} ₽).`
  );
  newRowForCompare = applyCasus72(newRow, casusAmount);
} else {
  console.log('ℹ️  известный казус §7.2: 0 отправлений в этом периоде — коррекция не применялась (не 0 по подгонке, а честный результат SQL).');
}
console.log('');

const roles = [
  { key: 'sale', name: 'продажа' },
  { key: 'return_', name: 'возврат' },
  { key: 'return_logistics', name: 'логистика возврата' },
  { key: 'acquiring', name: 'эквайринг' },
  { key: 'delivery_income', name: 'доход от доставки' },
];

const rows = [];
let sumOldExplicit = 0;
let sumNewExplicit = 0;
for (const r of roles) {
  const oldV = num(oldRow[r.key]);
  const newV = num(newRowForCompare[r.key]);
  sumOldExplicit += oldV;
  sumNewExplicit += newV;
  rows.push({ name: r.name, oldV, newV });
}
// прочее — остаточно, а не перечислением type_id (см. шапку файла)
rows.push({
  name: 'прочее',
  oldV: num(oldRow.total) - sumOldExplicit,
  newV: num(newRow.total) - sumNewExplicit,
});
rows.push({ name: 'ИТОГО', oldV: num(oldRow.total), newV: num(newRow.total) });

console.log(
  pad('роль', 22) + padL('старое, ₽', 16) + padL('новое, ₽', 16)
  + padL('разница, ₽', 14) + padL('разница, %', 12) + '  вердикт'
);

let diffCount = 0;
for (const row of rows) {
  const { ok, diffRub, diffPct } = compare(row.oldV, row.newV);
  const isTotal = row.name === 'ИТОГО';
  if (!ok && !isTotal) diffCount++;
  console.log(
    pad(row.name, 22) + padL(fmtRub(row.oldV), 16) + padL(fmtRub(row.newV), 16)
    + padL(fmtRub(diffRub), 14) + padL(diffPct.toFixed(2) + '%', 12)
    + '  ' + (ok ? 'ok' : 'РАСХОЖДЕНИЕ') + (isTotal ? '  (=Σ ролей выше)' : '')
  );
}

console.log('');
console.log(`старое: ${oldRow.n} строк tenant.ozon_finance_report; новое: ${newRow.n} строк tenant.ozon_accruals`
  + ' (разное число строк ожидаемо — старое агрегирует по операции, новое — по товару/услуге внутри операции; сравниваются только суммы).');

console.log('');
if (diffCount === 0) {
  console.log('ALL PASS — расхождений по ролям нет.');
} else {
  console.log(`${diffCount} РАСХОЖДЕНИЕ(Й) — см. объяснение в шапке файла и docs/ozon-accrual-reconciliation.md (раздел задачи 5) для каждой отмеченной роли; необъяснённое расхождение — самостоятельная находка, не часть ожидаемого результата.`);
}

// F6 ревью fixwave: непокрытие периода ЛЮБЫМ источником (старым или новым) —
// повод для ненулевого exit само по себе, даже если diffCount случайно вышел
// нулевым (напр. период вовсе без данных с обеих сторон, 0 = 0). Прятать
// недостоверность за успешным кодом было бы хуже, чем громко её показать
// (тот же принцип, что и у старой проверки покрытия — см. §7.4
// docs/ozon-accrual-reconciliation.md).
if (diffCount === 0 && !(oldCoverageOk && newCoverageOk)) {
  console.log('Расхождений по ролям нет, но период не полностью покрыт хотя бы одним источником (см. ВНИМАНИЕ выше) — считать сверку достоверной нельзя, код возврата ненулевой.');
}
process.exit(diffCount || !(oldCoverageOk && newCoverageOk) ? 1 : 0);
