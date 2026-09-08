// scripts/lib/ozonAccrualsStorno.mjs — структурная коррекция «сторно начисления»
// (docs/ozon-accrual-reconciliation.md §7.6) для scripts/check-ozon-accruals.mjs.
//
// Механизм (найден понедельничным сторожем 07.09.2026 на августе-2026, кабинет 1,
// постинг 0113758630-0567-3): Ozon начислил продажу (accrual A: commission-блок
// +1 219, логистика −163), затем СТОРНИРОВАЛ её отдельной операцией «Доставка
// покупателю — отмена начисления» (accrual B = зеркало A: блок −1 219, логистика
// +163) и начислил заново (accrual C = копия A). Деньги сходятся: A + B + C = A.
//
// Старый источник (tenant.ozon_finance_report) видит B как СВОЙ тип операции
// «… — отмена начисления» и кладёт весь её payout (−1 056) в «прочее». Новый
// источник (tenant.ozon_accruals) типа операции не знает: эвристика ролей
// (check-ozon-accruals.mjs) видит отрицательный commission-блок → «возврат»
// (−1 219), а логистику accrual без продающего блока → «логистика возврата»
// (+163). Итог по всем ролям не меняется — спор о роли, не расхождение денег.
// Канон прибыли (worker/collectors/ozon_order_costs.py) сторно переживает сам:
// «допуск полного сторно через пару commission-блоков», is_return=0, прибыль
// та же, что без сторно — панель верна, правка нужна только сторожу.
//
// ЧИСТАЯ функция (без БД), как applyCasus72: N/суммы сторно находит SQL в
// check-ozon-accruals.mjs (join старого источника — операции «… — отмена
// начисления» — с новым по operation_id = accrual_id, они совпадают); функция
// только ПРИМЕНЯЕТ найденные суммы. Коррекция АДДИТИВНАЯ: постороннее
// расхождение остаётся видимым (селф-тест scripts/check-ozon-accruals-storno-
// selftest.mjs).

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Переносит суммы сторно-операций из ролей «возврат» / «логистика возврата»
 * нового источника в остаточное «прочее» (там их держит старый источник).
 *
 * @param {{return_: number, return_logistics: number}} newRow — сырые роли
 *   нового источника ДО коррекции (ключи как в check-ozon-accruals.mjs).
 * @param {{block: number, logistics: number}} storno — Σ accrued сторно-accrual'ов
 *   периода: block — commission-блок (type_id IS NULL, обычно < 0, осел в
 *   «возврат»); logistics — логистика (type_id 32/29/45/59/98, NOT is_sale,
 *   обычно > 0, осела в «логистика возврата»). Нули при n=0 — коррекция
 *   ничего не меняет.
 * @returns {{return_: number, return_logistics: number}} — скорректированные роли;
 *   «прочее» в caller'е считается остаточно (итог − явные роли), поэтому
 *   перенесённые суммы оказываются там автоматически.
 */
export function applyStorno(newRow, storno) {
  const block = Number(storno?.block) || 0;
  const logistics = Number(storno?.logistics) || 0;
  return {
    ...newRow,
    return_: round2(newRow.return_ - block),
    return_logistics: round2(newRow.return_logistics - logistics),
  };
}
