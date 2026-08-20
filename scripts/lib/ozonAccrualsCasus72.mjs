// scripts/lib/ozonAccrualsCasus72.mjs — структурная коррекция «казуса §7.2»
// (docs/ozon-accrual-reconciliation.md §7.2) для scripts/check-ozon-accruals.mjs.
//
// Механизм (см. §7.2 полностью): отправления с НУЛЕВОЙ стоимостью товара
// (в старом источнике — sum(accruals_for_sale)=0 И sum(commission_amount)=0
// по всем строкам "Доставка покупателю" этого posting_id) не получают блок
// commission в новом источнике (`tenant.ozon_accruals`, accrued_category=
// 'POSTING', type_id IS NULL) вовсе — эвристика «есть commission-блок →
// продажа» (см. check-ozon-accruals.mjs, posting_sale_flag/is_sale) не может
// отличить такой постинг от чистого возврата, поэтому его логистика
// (type_id 32/29/45/59/98) попадает в роль «логистика возврата» вместо
// «продажа». Деньги не теряются (см. §7.2: «сумма обеих ролей вместе — и
// итог — не меняется») — это спор о том, в какую роль их положить, не
// расхождение денег.
//
// ЧИСТАЯ функция (без БД) — специально вынесена из check-ozon-accruals.mjs,
// чтобы её можно было протестировать unit-тестом без живого подключения
// (scripts/check-ozon-accruals-casus72-selftest.mjs), тот же приём, что
// lib/reference.js::compare() + scripts/check-reference-selftest.mjs.
// N/сумму казуса вычисляет SQL в check-ozon-accruals.mjs (структурный
// join старого источника — zero-value postings — с новым — их логистика в
// бакете «логистика возврата»); эта функция только ПРИМЕНЯЕТ уже вычисленную
// сумму, ничего сама не ищет и не угадывает.
//
// ⚠️ Коррекция АДДИТИВНАЯ, не «подгонка под ответ»: если после неё
// remains расхождение (казус объясняет не всё), это остаётся видно —
// compare() в вызывающем коде по-прежнему сравнивает старое с
// СКОРРЕКТИРОВАННЫМ новым, а не форсирует "ok" при любом входе. Смотри
// scripts/check-ozon-accruals-casus72-selftest.mjs — синтетический тест
// специально проверяет, что ПОСТОРОННЕЕ расхождение (другая сумма/причина)
// НЕ проглатывается коррекцией.

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Применяет коррекцию «казуса §7.2» к сырым ролям «продажа»/«логистика
 * возврата» нового источника.
 *
 * @param {{sale: number, return_logistics: number}} newRow — сырые роли нового
 *   источника ДО коррекции (те же ключи, что использует check-ozon-
 *   accruals.mjs: sale, return_logistics).
 * @param {number} casusAmount — Σ accrued (знаковая, обычно отрицательная)
 *   логистики отправлений-казуса, структурно осевшая в «логистика
 *   возврата» вместо «продажа» — вычислена SQL-ом caller'а. 0, если казус
 *   в периоде не обнаружен (n=0) — тогда коррекция не меняет ничего.
 * @returns {{sale: number, return_logistics: number}} — скорректированные роли.
 */
export function applyCasus72(newRow, casusAmount) {
  const amount = Number(casusAmount) || 0;
  return {
    ...newRow,
    // Деньги казуса ошибочно ОТСУТСТВУЮТ в «продаже» (не учтены, т.к. нет
    // commission-блока) — возвращаем их обратно.
    sale: round2(newRow.sale + amount),
    // Те же деньги ошибочно ПРИСУТСТВУЮТ в «логистике возврата» — убираем.
    return_logistics: round2(newRow.return_logistics - amount),
  };
}
