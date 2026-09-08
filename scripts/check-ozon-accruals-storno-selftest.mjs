#!/usr/bin/env node
// scripts/check-ozon-accruals-storno-selftest.mjs — юнит-тест коррекции
// «сторно начисления» (scripts/lib/ozonAccrualsStorno.mjs), БЕЗ БД — тот же
// приём, что check-ozon-accruals-casus72-selftest.mjs. Три сценария:
// (1) сторно объясняет расхождение полностью — после коррекции обе роли "ok"
// и «прочее» сходится; (2) сторно нет (нули) — коррекция ничего не меняет;
// (3) сторно есть, но ЧАСТЬ расхождения — от ДРУГОЙ причины — остаток виден.
import { applyStorno } from './lib/ozonAccrualsStorno.mjs';
import { compare } from '../lib/reference.js';

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) failed++;
}
const other = (row, explicit) => Math.round((row.total - explicit(row)) * 100) / 100;
const explicitSum = (r) => r.sale + r.return_ + r.return_logistics + r.acquiring + r.delivery_income;

// ── Сценарий 1: реальные числа августа-2026, кабинет 1 (§7.6): сторно
// 0113758630-0567-3 — блок −1 219,00 в «возврат», логистика +163,00 в
// «логистика возврата»; старое держит −1 056,00 в «прочее». ──
{
  const oldRow = { sale: 1866668.89, return_: -172303.25, return_logistics: -39150.77,
    acquiring: -26737.56, delivery_income: 0, total: 1100450.15 };
  const newRaw = { sale: 1866668.89, return_: -173522.25, return_logistics: -38987.77,
    acquiring: -26737.56, delivery_income: 0, total: 1100450.15 };
  const storno = { block: -1219.00, logistics: 163.00 };

  check('без коррекции: «возврат» расходится', compare(oldRow.return_, newRaw.return_).ok === false);
  check('без коррекции: «прочее» расходится на 1 056,00',
    Math.abs((other(newRaw, explicitSum) - other(oldRow, explicitSum)) - 1056.00) < 0.005,
    `Δпрочее=${other(newRaw, explicitSum) - other(oldRow, explicitSum)}`);

  const fixed = applyStorno(newRaw, storno);
  check('после коррекции: «возврат» = старое', compare(oldRow.return_, fixed.return_).ok && Math.abs(fixed.return_ - oldRow.return_) < 0.005, `fixed=${fixed.return_}`);
  check('после коррекции: «логистика возврата» = старое', Math.abs(fixed.return_logistics - oldRow.return_logistics) < 0.005, `fixed=${fixed.return_logistics}`);
  check('после коррекции: «прочее» сходится (перенос ушёл в остаток)',
    Math.abs(other(fixed, explicitSum) - other(oldRow, explicitSum)) < 0.005,
    `Δпрочее=${other(fixed, explicitSum) - other(oldRow, explicitSum)}`);
  check('итог не тронут', fixed.total === newRaw.total);
}

// ── Сценарий 2: сторно нет — нули не меняют ничего. ──
{
  const row = { return_: -100.5, return_logistics: -20.25 };
  const fixed = applyStorno(row, { block: 0, logistics: 0 });
  check('n=0: роли без изменений', fixed.return_ === row.return_ && fixed.return_logistics === row.return_logistics);
  const fixed2 = applyStorno(row, undefined);
  check('n=0 (undefined): роли без изменений', fixed2.return_ === row.return_ && fixed2.return_logistics === row.return_logistics);
}

// ── Сценарий 3: сторно + постороннее расхождение −5 000 в «возврат» — после
// коррекции остаток −5 000 остаётся РАСХОЖДЕНИЕМ (не проглатывается). ──
{
  const oldRet = -172303.25;
  const newRet = -173522.25 - 5000;
  const fixed = applyStorno({ return_: newRet, return_logistics: -38987.77 }, { block: -1219, logistics: 163 });
  check('постороннее расхождение остаётся видимым', compare(oldRet, fixed.return_).ok === false,
    `compare=${JSON.stringify(compare(oldRet, fixed.return_))}`);
  check('остаток ровно −5 000', Math.abs((fixed.return_ - oldRet) + 5000) < 0.005, `Δ=${fixed.return_ - oldRet}`);
}

console.log(failed ? `${failed} FAIL` : 'ALL PASS');
process.exit(failed ? 1 : 0);
