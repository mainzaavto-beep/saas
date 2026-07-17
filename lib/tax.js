// lib/tax.js — Налоговый расчёт SaaS.
//
// Модель (per shop / per legal entity):
//   { type: 'usn_income',           rate: 6,  vat: 0 }
//   { type: 'usn_income_expenses',  rate: 15, vat: 7 }
//
// ⚠️ КОРРЕКТНАЯ МОДЕЛЬ НДС+УСН (реформа 2025, фикс 2026-07-17, урок D14):
// WB/Ozon отдают выручку С НДС (сумма, что заплатил покупатель). Поэтому:
//   • НДС ВЫДЕЛЯЕТСЯ «изнутри» цены:  vat = revenue × vat/(100+vat)
//     (для 5%: × 5/105; для 7%: × 7/107). При vat=0 → 0.
//   • УСН считается от ВЫРУЧКИ БЕЗ НДС: usn = (revenue − vat) × rate%
//     (поступивший НДС не признаётся доходом по ст. 248/346.15 НК РФ).
//   • expenses (для УСН Доходы−Расходы) вычитаются уже из выручки без НДС.
//   • Минимальный налог 1% — тоже от выручки без НДС.
//
//   usn_income           → usnTax = max(0, revenueNet − expenses) × rate%   // expenses=0 по умолчанию
//   usn_income_expenses  → usnTax = max(0, revenueNet − expenses) × rate%,
//                          но не менее revenueNet × 1% (минимальный налог).
//   vat: 0 | 5 | 7 — ставка НДС, выбирает пользователь (порог 60 млн ₽ / реформа).
//
// ⚠️ ВХОДНОЙ НДС от поставщиков НЕ учитывается (себестоимость cost_overrides
//    считается чистой). Ставка 7% (право на вычет) и 5% (без вычета) тут не
//    различаются — считаем только ИСХОДЯЩИЙ НДС с продаж.
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
 * База = выручка БЕЗ НДС (НДС автоматически вычитается через calcVatTax).
 * Это backward-compatible: при vat=0 база = revenue (поведение прежнее).
 * @param {object} taxMode — { type, rate, vat }
 * @param {number} revenue — выручка (с НДС, как отдают МП) за период
 * @param {number} [expenses=0] — расходы за период (для УСН Доходы−Расходы)
 * @returns {number} сумма УСН в рублях (round2)
 */
export function calcUsnTax(taxMode, revenue, expenses = 0) {
  const tm = normalizeTaxMode(taxMode);
  const revGross = Number(revenue) || 0;
  const exp = Number(expenses) || 0;
  // База УСН = выручка без НДС (НДС не есть доход).
  const vat = _vatAmount(tm, revGross);
  const revNet = revGross - vat;
  let tax;
  if (tm.type === "usn_income_expenses") {
    const base = Math.max(0, revNet - exp);
    tax = base * (tm.rate / 100);
    // Минимальный налог 1% от доходов (без НДС) — всегда платится, если > расчётного.
    const minTax = revNet * MIN_TAX_RATE;
    tax = Math.max(tax, minTax);
  } else {
    // usn_income
    tax = revNet * (tm.rate / 100);
  }
  return Math.round(tax * 100) / 100;
}

/**
 * Рассчитать НДС за период — выделение «изнутри» цены с НДС.
 * WB/Ozon отдают выручку с НДС → выделяем долю НДС: revenue × vat/(100+vat).
 * @param {object} taxMode — { type, rate, vat }
 * @param {number} revenue — выручка с НДС за период
 * @returns {number} сумма НДС в рублях (round2)
 */
export function calcVatTax(taxMode, revenue) {
  const tm = normalizeTaxMode(taxMode);
  return _vatAmount(tm, Number(revenue) || 0);
}

// Внутренний расчёт суммы НДС по уже-нормализованному режиму.
// vat=0 → 0; иначе revGross × vat/(100+vat) (выделение «изнутри» цены с НДС).
function _vatAmount(tm, revGross) {
  if (!tm.vat) return 0;
  return Math.round(revGross * (tm.vat / (100 + tm.vat)) * 100) / 100;
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
 * Рассчитать общий налог (УСН + НДС) за период.
 * УСН здесь считается от выручки БЕЗ НДС (как в calcUsnTax), НДС — выделение.
 * profit = revenue − ... − result.total  (вычитать сумму УСН+НДС).
 * @returns {{ usn: number, vat: number, total: number, revenueNet: number }}
 */
export function calcTotalTax(taxMode, revenue, expenses = 0) {
  const usn = calcUsnTax(taxMode, revenue, expenses);
  const vat = calcVatTax(taxMode, revenue);
  const revenueNet = (Number(revenue) || 0) - vat;
  return { usn, vat, total: Math.round((usn + vat) * 100) / 100, revenueNet };
}

/**
 * Доля УСН от выручки без НДС (для отображения «эффективная ставка»).
 * УСН платится с выручки за вычетом НДС → делим на revenueNet, не на gross.
 */
export function effectiveTaxRate(taxMode, revenue, expenses = 0) {
  const { revenueNet } = calcTotalTax(taxMode, revenue, expenses);
  if (revenueNet <= 0) return 0;
  return calcUsnTax(taxMode, revenue, expenses) / revenueNet;
}

/**
 * Описание налогового режима для UI.
 * short=true → компактная подпись для плитки («УСН 6%», «УСН 6% + НДС 5%»).
 */
export function describeTaxMode(taxMode, { short = false } = {}) {
  const tm = normalizeTaxMode(taxMode);
  const name = short
    ? "УСН"
    : (tm.type === "usn_income_expenses" ? "УСН Доходы−Расходы" : "УСН Доходы");
  let s = short ? `${name} ${tm.rate}%` : `${name} ${tm.rate}%`;
  if (tm.vat) s += ` + НДС ${tm.vat}%`;
  return s;
}

/**
 * Комбинированная подпись для нескольких МП (WB+Ozon).
 * Если режимы одинаковые — одна строка; если разные — обе через «/».
 * Для UI-лейблов на дашборде, где налоговый режим может отличаться по МП.
 * @param {{wb?:object, ozon?:object}|null} shopTax — из cabinet.shopTax
 * @param {object} [opts] — { short }
 * @returns {string}
 */
export function describeCombinedTaxMode(shopTax, opts = {}) {
  if (!shopTax) return describeTaxMode(null, opts);
  const wb = describeTaxMode(shopTax.wb, opts);
  const oz = describeTaxMode(shopTax.ozon, opts);
  if (!shopTax.wb && !shopTax.ozon) return describeTaxMode(null, opts);
  if (!shopTax.wb) return oz;
  if (!shopTax.ozon) return wb;
  return wb === oz ? wb : `${wb} / ${oz}`;
}
