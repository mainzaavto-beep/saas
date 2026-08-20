#!/usr/bin/env node
// scripts/check-ozon-accruals-casus72-selftest.mjs — юнит-тест коррекции
// «казуса §7.2» (scripts/lib/ozonAccrualsCasus72.mjs), БЕЗ БД — тот же
// приём, что scripts/check-reference-selftest.mjs для lib/reference.js.
//
// Ревью задачи 6 плана «унификация формул прибыли» (fix-раунд, п.2)
// потребовало доказать СИНТЕТИЧЕСКИ, что структурная коррекция не глотает
// расхождение ДРУГОЙ суммы/причины — только тот конкретный казус, который
// нашёл SQL check-ozon-accruals.mjs. Три сценария ниже: (1) казус
// объясняет расхождение полностью — коррекция даёт "ok"; (2) казус
// отсутствует (n=0, amount=0) — коррекция не меняет ничего, расхождение
// остаётся видимым; (3) казус есть, но ЧАСТЬ расхождения — от ДРУГОЙ,
// непокрытой причины — после коррекции остаток по-прежнему "не ok".
import { applyCasus72 } from './lib/ozonAccrualsCasus72.mjs';
import { compare } from '../lib/reference.js';

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) failed++;
}

// ── Сценарий 1: реальные числа июля-2026, кабинет 1 (docs/ozon-accrual-
// reconciliation.md §7.2) — казус (-835,00 ₽, 4 отправления) объясняет
// расхождение "продажа"/"логистика возврата" ПОЛНОСТЬЮ. ──
{
  const oldRow = { sale: 268020.09, return_logistics: -13389.83 };
  const newRowRaw = { sale: 268855.09, return_logistics: -14224.83 };
  const casusAmount = -835.00;

  // Сырое (без коррекции) — «логистика возврата» РАСХОДИТСЯ (6,24% — это и
  // была исходная жалоба контролёра, журнал сервис-юнита краснел из-за
  // этого). «Продажа» на сырых числах уже "ok" по compare() (0,31% <
  // порога 0,5%, см. lib/reference.js TOL_PCT) — сама коррекция всё равно
  // нужна: без неё цифра "продажа" в отчёте на 835 ₽ дальше от истины, чем
  // могла бы быть, даже когда compare() формально не красит её.
  check(
    'без коррекции: "логистика возврата" расходится (сырой казус ещё не вычтен)',
    compare(oldRow.return_logistics, newRowRaw.return_logistics).ok === false,
    `compare=${JSON.stringify(compare(oldRow.return_logistics, newRowRaw.return_logistics))}`
  );

  const corrected = applyCasus72(newRowRaw, casusAmount);
  check(
    'кабинет 1, июль-2026: после коррекции "продажа" сходится с известным казусом',
    compare(oldRow.sale, corrected.sale).ok === true,
    `старое=${oldRow.sale}, скорректировано=${corrected.sale}`
  );
  check(
    'кабинет 1, июль-2026: после коррекции "логистика возврата" сходится',
    compare(oldRow.return_logistics, corrected.return_logistics).ok === true,
    `старое=${oldRow.return_logistics}, скорректировано=${corrected.return_logistics}`
  );
}

// ── Сценарий 2: реальные числа июля-2026, кабинет 1008 — казус (-99,00 ₽,
// 1 отправление). ──
{
  const oldRow = { sale: 660936.83, return_logistics: -6759.43 };
  const newRowRaw = { sale: 661035.83, return_logistics: -6858.43 };
  const corrected = applyCasus72(newRowRaw, -99.00);
  check(
    'кабинет 1008, июль-2026: после коррекции обе роли сходятся',
    compare(oldRow.sale, corrected.sale).ok === true && compare(oldRow.return_logistics, corrected.return_logistics).ok === true,
    `sale: ${oldRow.sale} vs ${corrected.sale}; return_logistics: ${oldRow.return_logistics} vs ${corrected.return_logistics}`
  );
}

// ── Сценарий 3: казус НЕ обнаружен в периоде (n=0 → amount=0) — коррекция
// обязана быть no-op, расхождение (если оно есть) остаётся видимым, а не
// прячется. ──
{
  const oldRow = { sale: 100000, return_logistics: -5000 };
  const newRowRaw = { sale: 100835, return_logistics: -5835 }; // то же смещение, что казус, но detector НЕ нашёл его в этом периоде
  const corrected = applyCasus72(newRowRaw, 0);
  check(
    'казус не найден (amount=0): коррекция — no-op',
    corrected.sale === newRowRaw.sale && corrected.return_logistics === newRowRaw.return_logistics,
    `corrected=${JSON.stringify(corrected)}`
  );
  check(
    'казус не найден: расхождение "продажа" остаётся видимым (не проглочено)',
    compare(oldRow.sale, corrected.sale).ok === false,
    `compare=${JSON.stringify(compare(oldRow.sale, corrected.sale))}`
  );
}

// ── Сценарий 4 (ключевой синтетический тест ревью): казус РЕАЛЬНО есть
// (-835 ₽, структурно найден SQL-ом), НО в "продаже" есть ДОПОЛНИТЕЛЬНОЕ,
// НЕ связанное с казусом расхождение (+5000 ₽ от какой-то другой, новой
// причины) — коррекция обязана вычесть ТОЛЬКО казус и оставить остаток
// 5000 ₽ видимым как настоящее расхождение (иначе детектор "глотает"
// чужую находку под видом уже объяснённой). ──
{
  const casusAmount = -835.00;
  const oldRow = { sale: 100000 };
  // "Как если бы" расхождение было ТОЛЬКО от казуса: newRaw = old − casusAmount = 100000 − (−835) = 100835.
  // Плюс посторонняя добавка 5000 ₽ (другая, непокрытая казусом причина).
  const newRowRaw = { sale: 100835 + 5000, return_logistics: 0 };
  const corrected = applyCasus72(newRowRaw, casusAmount);
  check(
    'казус вычтен, но посторонние 5000 ₽ остаются НЕ объяснёнными (детектор их не глотает)',
    compare(oldRow.sale, corrected.sale).ok === false,
    `старое=${oldRow.sale}, скорректировано=${corrected.sale} (ожидался остаток ≈5000 ₽, не "ok")`
  );
  const residual = Math.round((corrected.sale - oldRow.sale) * 100) / 100;
  check(
    'остаток после вычета казуса равен ИМЕННО посторонней добавке (5000 ₽), не 0 и не полной сумме',
    Math.abs(residual - 5000) < 0.01,
    `остаток=${residual}`
  );
}

console.log('');
if (failed === 0) {
  console.log('ALL PASS — коррекция «казуса §7.2» применяется только к найденной сумме, посторонние расхождения не проглатывает.');
  process.exit(0);
} else {
  console.log(`${failed} ПРОВАЛ(ОВ) — см. FAIL выше.`);
  process.exit(1);
}
