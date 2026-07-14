// lib/tax.js — Налоговый расчёт SaaS.
//
// Модель (per shop / per legal entity):
//   { type: 'usn_income',           rate: 6,  vat: 0 }
//   { type: 'usn_income_expenses',  rate: 15, vat: 7 }
//
// Логика:
//   usn_income           → usnTax = revenue × rate%
//   usn_income_expenses  → usnTax = max(0, revenue − expenses) × rate%,
//                          но не менее revenue × 1% (минимальный налог).
//   vat: 0 | 5 | 7 — ставка НДС (0=без НДС, 5%, 7%). Пользователь выбирает сам,
//        т.к. мы не знаем выручку за прошлый год (порог 20 млн ₽ по реформе УСН+НДС).
//        vatTax = revenue × vat% (выходной НДС с продаж).
//
// rate — редактируемая (льготные регионы: 1-6% для Доходы, 5-15% для Доходы−Расходы).
// revenue, expenses — рубли (number). round2 для рублей.

const DEFAULT_TAX_MODE = { type: "usn_income", rate: 6, vat: 0 };
const MIN_TAX_RATE = 0.01; // 1% минимальный налог для УСН Доходы−Расходы

const VALID_VAT = new Set([0, 5, 7]);

/**
 * Привести любой tax_mode (legacy {usn_pct,vat:bool} или новый {type,rate,vat:number}) к каноническому виду.
 */
export function normalizeTaxMode(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TAX_MODE };
  // Legacy {usn_pct, vat: boolean}.
  if (raw.usn_pct != null) {
    const legacyVat = raw.vat;
    const vatNum = typeof legacyVat === "boolean" ? (legacyVat ? 7 : 0)
      : (VALID_VAT.has(Number(legacyVat)) ? Number(legacyVat) : 0);
    return {
      type: raw.type === "usn_income_expenses" ? "usn_income_expenses" : "usn_income",
      rate: Number(raw.rate ?? raw.usn_pct) || 6,
      vat: vatNum,
    };
  }
  const type = raw.type === "usn_income_expenses" ? "usn_income_expenses" : "usn_income";
  let rate = Number(raw.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) rate = type === "usn_income" ? 6 : 15;
  let vat = Number(raw.vat);
  if (!VALID_VAT.has(vat)) vat = typeof raw.vat === "boolean" ? (raw.vat ? 7 : 0) : 0;
  return { type, rate, vat };
}

/**
 * Рассчитать УСН за период.
 * @param {object} taxMode — { type, rate, vat }
 * @param {number} revenue — выручка (доходы) за период
 * @param {number} [expenses=0] — расходы за период (для УСН Доходы−Расходы)
 * @returns {number} сумма УСН в рублях (round2)
 */
export function calcUsnTax(taxMode, revenue, expenses = 0) {
  const tm = normalizeTaxMode(taxMode);
  const rev = Number(revenue) || 0;
  const exp = Number(expenses) || 0;
  let tax;
  if (tm.type === "usn_income_expenses") {
    const base = Math.max(0, rev - exp);
    tax = base * (tm.rate / 100);
    // Минимальный налог 1% от доходов (всегда платится, если > расчётного).
    const minTax = rev * MIN_TAX_RATE;
    tax = Math.max(tax, minTax);
  } else {
    // usn_income
    tax = rev * (tm.rate / 100);
  }
  return Math.round(tax * 100) / 100;
}

/**
 * Рассчитать НДС за период (выходной — с продаж).
 * @param {object} taxMode — { type, rate, vat }
 * @param {number} revenue — выручка за период
 * @returns {number} сумма НДС в рублях (round2)
 */
export function calcVatTax(taxMode, revenue) {
  const tm = normalizeTaxMode(taxMode);
  const rev = Number(revenue) || 0;
  if (!tm.vat) return 0;
  return Math.round(rev * (tm.vat / 100) * 100) / 100;
}

/**
 * Рассчитать общий налог за период (УСН + НДС).
 * Обратная совместимость: calcTax = calcUsnTax (для старых вызовов, не учитывает НДС).
 * Для полного расчёта используйте calcTotalTax.
 * @param {object} taxMode
 * @param {number} revenue
 * @param {number} [expenses=0]
 * @returns {number} сумма УСН в рублях (round2)
 */
export const calcTax = calcUsnTax;

/**
 * Рассчитать общий налог (УСН + НДС).
 * @returns {{ usn: number, vat: number, total: number }}
 */
export function calcTotalTax(taxMode, revenue, expenses = 0) {
  const usn = calcUsnTax(taxMode, revenue, expenses);
  const vat = calcVatTax(taxMode, revenue);
  return { usn, vat, total: Math.round((usn + vat) * 100) / 100 };
}

/**
 * Доля УСН от выручки (для отображения «эффективная ставка»).
 */
export function effectiveTaxRate(taxMode, revenue, expenses = 0) {
  const rev = Number(revenue) || 0;
  if (rev <= 0) return 0;
  return calcUsnTax(taxMode, revenue, expenses) / rev;
}

/**
 * Описание налогового режима для UI.
 */
export function describeTaxMode(taxMode) {
  const tm = normalizeTaxMode(taxMode);
  const name = tm.type === "usn_income_expenses" ? "УСН Доходы−Расходы" : "УСН Доходы";
  let s = `${name} ${tm.rate}%`;
  if (tm.vat) s += ` + НДС ${tm.vat}%`;
  return s;
}
