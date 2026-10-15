// lib/purchaseCalc.js — формулы «Себес товара» (Excel-модель владельца) +
// остаток к оплате поставщику. Вынесено из app/api/cabinets/[id]/purchases/route.js
// (задача 2 платёжного календаря, 2026-10-15) — единый источник, никаких
// инлайн-копий формул денег в роутах.

export const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
export const numOr = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// =====================================================================
//  Excel-формулы «Себес товара» (считаются НА СЕРВЕРЕ из вводных полей).
//  Эталон: data-presenter/app/api/purchases/route.js:computeExcel
//    N = L × M           (Сумма аванса ₽ = предоплата¥ × курс аванса)
//    Q = O × P           (Сумма ¥ = кол-во × цена за ед ¥)
//    R = Q − L           (Остаток оплаты ¥)
//    S = M × R           (Остаток оплаты ₽ = курс АВАНСА × остаток¥)
//    V = P × U           (Цена за ед ₽)
//    W = R × U + N       (Сумма ₽ оплаченная)
//    Z = W + (X + Y) × O (ИТОГО; X и Y — ₽ ЗА ЕДИНИЦУ, ×O = за партию)
//    AA = Z / O          (Себестоимость за ед → unit_cost = W/O + X + Y)
//  L=prepay_yuan, M=prepay_rate, O=qty, P=unit_cost_yuan, U=exchange_rate,
//  X=logistics_rub_per_unit (Логист. до МСК, ₽/ед), Y=logistics_rub (Логист.
//  МСК→ФФ, ₽/ед). Решение 2026-07-15: X и Y оба «за ед» (раньше код считал
//  их «за партию» и не умножал на O → AA занижался на величину логистики).
// =====================================================================
export function computeExcel(input) {
  const L = numOr(input.prepay_yuan) || 0;
  const M = numOr(input.prepay_rate) || 0;
  const O = numOr(input.qty);
  const P = numOr(input.unit_cost_yuan) || 0;
  const U = numOr(input.exchange_rate) || 0;
  const X = numOr(input.logistics_rub_per_unit) || 0;
  const Y = numOr(input.logistics_rub) || 0;
  const hasQty = O != null && O > 0;
  const N = L * M;
  const Q = hasQty ? O * P : null;
  const R = hasQty ? (Q - L) : -L;
  const S = M * R;
  const V = hasQty ? P * U : null;
  const W = R * U + N;
  // X и Y — за единицу; за партию = (X+Y)×O.
  const Z = hasQty ? W + (X + Y) * O : W + X + Y;
  const unitCost = hasQty ? Z / O : null;
  return {
    N: round2(N), Q: hasQty ? round2(Q) : null, R: round2(R), S: round2(S),
    V: hasQty ? round2(V) : null, W: round2(W), Z: round2(Z),
    unitCost: unitCost != null ? round2(unitCost) : null,
  };
}

// Остаток к оплате поставщику — по курсу ОПЛАТЫ U (R×U = W − N), решение владельца 15.10.2026:
// сумма «предоплата + остаток» сходится с W, а значит платежи партии — с её себестоимостью Z.
// Колонка S (= M×R, курс аванса) остаётся формулой Excel владельца, но не «остатком к оплате».
export function balanceDueRub(calc) {
  return round2((calc.W ?? 0) - (calc.N ?? 0));
}
