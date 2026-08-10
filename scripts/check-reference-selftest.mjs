// Проверка самого сторожа: правило допуска и отказ работать на незаполненном эталоне.
// Сверка, которая всегда зелёная, хуже её отсутствия — поэтому проверяем, что она краснеет.
import { compare, loadReference } from '../lib/reference.js';

let failed = 0;
const check = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${got}`}`);
  if (!cond) failed++;
};

// Допуск: значимо только если превышены ОБА порога — 1 ₽ и 0,5%.
check('копейки — не расхождение', compare(100000, 100000.4).ok === true);
check('50 копеек на сто тысяч — не расхождение', compare(100000, 100000.5).ok === true);
check('2 ₽ на сто тысяч — не расхождение (0,002%)', compare(100000, 100002).ok === true);
check('5% — расхождение', compare(100000, 105000).ok === false);
check('1000 ₽ на 1000 ₽ — расхождение', compare(1000, 2000).ok === false);
check('90 копеек на 10 ₽ — не расхождение (меньше рубля)', compare(10, 10.9).ok === true);
check('разница в рублях и процентах посчитана', (() => {
  const r = compare(1000, 1100);
  return r.ok === false && Math.abs(r.diffRub - 100) < 0.001 && Math.abs(r.diffPct - 10) < 0.001;
})());

// Незаполненный эталон не должен молча считаться нулём.
try {
  loadReference(new URL('./fixtures/reference-empty/', import.meta.url).pathname);
  check('незаполненный эталон отвергается', false, 'ошибки не было');
} catch (e) {
  check('незаполненный эталон отвергается', /не заполнен/i.test(e.message), e.message);
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
