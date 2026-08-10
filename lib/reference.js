// lib/reference.js — чтение эталона и сравнение с допуском.
//
// Эталон — числа из официальных отчётов маркетплейса. Он существует, чтобы ловить
// расхождения, поэтому модуль намеренно строгий: незаполненная величина — это
// ошибка, а не ноль. Молчаливый ноль превратил бы сверку в вечнозелёную.
import { readFileSync } from 'node:fs';

// Обязательные ключи values по каждой площадке. Список — источник правды для
// полноты эталона (M1 фикс-раунда 2): раньше loadReference валидировал только
// то, что фактически присутствовало в JSON, поэтому `values: {}` или удалённый
// ключ проходили молча, а падало уже check-reference.mjs с невнятным TypeError.
//
// Ozon сокращён до одного ключа (`ad_spend`) не по ошибке: `sales`, `returns`,
// `commission`, `logistics`, `payout` сняты с 2026-08-10 (ревью «эталонные
// данные», находка I1) — они строятся на `tenant.ozon_finance_report`, а там
// SUM() по-прежнему ненадёжен для мульти-товарных операций: upsert-ключ
// (`cabinet_id`, `posting_id`, `operation_id`) не включает товар, поэтому
// строки по `items[]` одной операции схлопываются в одну (выживает
// последняя) — деньги мультитоварной операции достаются случайному товару.
// Это требует миграции ключа, отдельная работа (не путать с починенным
// 2026-08-10 дефектом sale_amount/accruals_for_sale — тот уже исправлен:
// `sale_amount` — валовая сумма продажи, `payout_amount` — чистая сумма по
// операции после вычетов комиссии и услуг; ни одна из них НЕ равна
// фактической выплате продавцу — та считается по отдельному отчёту о
// взаиморасчётах с нетто по всем типам операций за период). Требовать от
// владельца заполнить эти пять значений сейчас — дать инструкцию, которая
// не приведёт ни к какой проверке (I4). Подробности и путь восстановления —
// `reference/*/SOURCES.md` и комментарий в `scripts/check-reference.mjs`.
export const REQUIRED_KEYS = {
  wb: ['sales', 'returns', 'commission', 'logistics', 'storage', 'penalty', 'deduction', 'for_pay', 'ad_spend'],
  ozon: ['ad_spend'],
};

// Расхождение значимо, только если превышены ОБА порога: и рубль, и полпроцента.
// Один порог без другого делает сверку либо шумной на копейках, либо слепой на
// мелких величинах.
const TOL_RUB = 1;
const TOL_PCT = 0.5;

export function compare(expected, actual) {
  const e = Number(expected);
  const a = Number(actual);
  const diffRub = a - e;
  const diffPct = e === 0 ? (a === 0 ? 0 : 100) : (diffRub / e) * 100;
  const ok = Math.abs(diffRub) <= TOL_RUB || Math.abs(diffPct) <= TOL_PCT;
  return { ok, diffRub, diffPct };
}

export function loadReference(dir) {
  const path = `${dir.replace(/\/$/, '')}/expected.json`;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`эталон не читается (${path}): ${e.message}`);
  }
  const ref = JSON.parse(raw);
  const missing = [];
  for (const mp of ['wb', 'ozon']) {
    const block = ref[mp];
    if (!block) {
      missing.push(`${mp} (блок отсутствует)`);
      continue;
    }
    if (!Array.isArray(block.periods) || block.periods.length === 0) {
      missing.push(`${mp}.periods (пусто или отсутствует)`);
    } else {
      for (const p of block.periods) {
        if (!p.date_from || !p.date_to) missing.push(`${mp}.periods[].date_from/date_to`);
      }
    }
    // Полнота набора ключей проверяется по REQUIRED_KEYS, а не по тому, что
    // фактически лежит в JSON: `values: {}` и удалённый ключ обязаны давать
    // ту же понятную ошибку, что и `null` — раньше они молча проходили мимо
    // этой проверки (M1).
    const values = block.values;
    for (const key of REQUIRED_KEYS[mp]) {
      if (!values || !(key in values)) {
        missing.push(`${mp}.${key} (ключ отсутствует в values)`);
        continue;
      }
      const v = values[key];
      if (typeof v !== 'number' || isNaN(v)) {
        missing.push(`${mp}.${key} (должно быть число, получено ${typeof v})`);
      }
    }
  }
  if (missing.length) {
    throw new Error(
      `эталон не заполнен: ${missing.join(', ')}.\n`
      + `Числа берутся из официальных отчётов маркетплейса — см. ${dir}/SOURCES.md.`
    );
  }
  return ref;
}
