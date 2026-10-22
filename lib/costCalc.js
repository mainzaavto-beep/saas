// lib/costCalc.js — калькулятор себестоимости с доставкой из Китая (спека
// docs/superpowers/specs/2026-10-22-cost-calculator-design.md). Чистые функции без БД: страница
// считает на лету, API — для списка сохранённых. Прикидка, не учёт: с «Закупками» не связана.
// Вес — за 1 шт (кг), карго — $/кг, доставка по Китаю — ¥ за партию, карго → ФФ — ₽ за партию.

export const CALC_FIELDS = ["qty", "weight_kg", "price_cny", "china_delivery_cny",
  "cargo_usd_per_kg", "ff_logistics_rub", "rate_cny", "rate_usd"];

export const COST_LINES = [
  { key: "goods", label: "Товар" },
  { key: "china", label: "Доставка по Китаю" },
  { key: "cargo", label: "Карго" },
  { key: "ff", label: "Карго → ФФ" },
];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function calcCost(input = {}) {
  const v = Object.fromEntries(CALC_FIELDS.map((k) => [k, num(input[k])]));
  const qty = v.qty;
  const rub = {
    goods: v.price_cny * qty * v.rate_cny,
    china: v.china_delivery_cny * v.rate_cny,
    cargo: v.weight_kg * qty * v.cargo_usd_per_kg * v.rate_usd,
    ff: v.ff_logistics_rub,
  };
  const totalRub = rub.goods + rub.china + rub.cargo + rub.ff;
  return {
    weightTotal: v.weight_kg * qty,
    totalRub,
    unitRub: qty > 0 ? totalRub / qty : null,
    lines: COST_LINES.map(({ key, label }) => ({
      key, label, rub: rub[key],
      perUnit: qty > 0 ? rub[key] / qty : null,
      share: totalRub > 0 ? rub[key] / totalRub : null,
    })),
  };
}

// Тело POST → чистый ввод. Пустое поле = 0; отрицательное/нечисловое — ошибка.
export function parseCalcInput(b) {
  const name = String(b?.name ?? "").trim();
  if (!name) return { error: "укажите товар" };
  if (name.length > 200) return { error: "название длиннее 200 символов" };
  const value = { name, note: String(b?.note ?? "").trim().slice(0, 1000) };
  for (const k of CALC_FIELDS) {
    const raw = b?.[k];
    const n = raw === "" || raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0) return { error: `поле ${k}: нужно число ≥ 0` };
    value[k] = n;
  }
  return { value };
}
