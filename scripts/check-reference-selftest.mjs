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

// Отсутствующий блок маркетплейса — ошибка.
try {
  loadReference(new URL('./fixtures/reference-no-wb-block/', import.meta.url).pathname);
  check('отсутствующий блок wb отвергается', false, 'ошибки не было');
} catch (e) {
  check('отсутствующий блок wb отвергается', /блок отсутствует/i.test(e.message), e.message);
}

// Отсутствующий ключ periods — ошибка.
try {
  loadReference(new URL('./fixtures/reference-no-periods/', import.meta.url).pathname);
  check('отсутствующий periods отвергается', false, 'ошибки не было');
} catch (e) {
  check('отсутствующий periods отвергается', /periods.*пусто или отсутствует/i.test(e.message), e.message);
}

// Пустой массив periods — ошибка.
try {
  loadReference(new URL('./fixtures/reference-empty-periods/', import.meta.url).pathname);
  check('пустой periods отвергается', false, 'ошибки не было');
} catch (e) {
  check('пустой periods отвергается', /periods.*пусто или отсутствует/i.test(e.message), e.message);
}

// Строка вместо числа — ошибка.
try {
  loadReference(new URL('./fixtures/reference-string-values/', import.meta.url).pathname);
  check('строка вместо числа отвергается', false, 'ошибки не было');
} catch (e) {
  check('строка вместо числа отвергается', /должно быть число/i.test(e.message), e.message);
}

// Строка "0" вместо числа — ошибка.
try {
  loadReference(new URL('./fixtures/reference-string-zero/', import.meta.url).pathname);
  check('строка "0" вместо числа отвергается', false, 'ошибки не было');
} catch (e) {
  check('строка "0" вместо числа отвергается', /должно быть число/i.test(e.message), e.message);
}

// M1: values: {} — полнота набора ключей проверяется по REQUIRED_KEYS, а не
// по тому, что фактически лежит в JSON. Пустой объект не должен молча
// проходить (раньше проходил — TypeError вылезал только в check-reference.mjs).
try {
  loadReference(new URL('./fixtures/reference-empty-values/', import.meta.url).pathname);
  check('values: {} отвергается', false, 'ошибки не было');
} catch (e) {
  check('values: {} отвергается', /ключ отсутствует в values/i.test(e.message), e.message);
}

// M1: удалённый (не null, а отсутствующий) ключ — та же явная ошибка.
try {
  loadReference(new URL('./fixtures/reference-missing-key/', import.meta.url).pathname);
  check('удалённый ключ отвергается', false, 'ошибки не было');
} catch (e) {
  check(
    'удалённый ключ отвергается',
    /wb\.for_pay \(ключ отсутствует в values\)/.test(e.message),
    e.message
  );
}

// Compare должна работать с отрицательными числами (возвраты, штрафы).
check('отрицательная разница посчитана', (() => {
  const r = compare(1000, -50);
  return r.ok === false && r.diffRub === -1050 && Math.abs(r.diffPct - (-105)) < 0.001;
})());

// Compare на нулевом эталоне: несовпадение — 100%.
check('несовпадение на нулевом эталоне — 100%', (() => {
  const r = compare(0, 100);
  return r.ok === false && r.diffPct === 100;
})());

// Compare на нулевом эталоне и нулевом факте — совпадение.
check('совпадение нуля с нулём', compare(0, 0).ok === true);

// Малые числа: даже 0.1 рубля — это не расхождение, если меньше обоих порогов.
check('0.1 ₽ на 1 ₽ — не расхождение', compare(1, 1.1).ok === true);

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
