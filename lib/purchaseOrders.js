// lib/purchaseOrders.js — закупки «заказ → позиции → отправки» (спека
// docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Чистые функции, без БД.
// Себестоимость позиции = товар (эфф. курс оплат) + прочие расходы заказа + логистика отправок,
// на ОТПРАВЛЕННЫЕ штуки. Недостача при приёмке — только показ. Округление — у потребителя.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// Раскидка суммы: по весу (qty × weight), если вес > 0 у ВСЕХ строк, иначе по штукам.
export function allocate(total, rows) {
  const byKey = new Map();
  const allW = rows.length > 0 && rows.every((r) => num(r.weight) > 0);
  const base = rows.map((r) => (allW ? num(r.qty) * num(r.weight) : num(r.qty)));
  const sum = base.reduce((s, x) => s + x, 0);
  if (!(sum > 0)) return { byKey, basis: allW ? "weight" : "qty", ok: false };
  rows.forEach((r, i) => byKey.set(r.key, (num(total) * base[i]) / sum));
  return { byKey, basis: allW ? "weight" : "qty", ok: true };
}

export function paymentRub(p) {
  return p.currency === "rub" ? num(p.amount) : num(p.amount) * num(p.rate);
}

export function calcOrder({ order, payments = [], lines = [], shipments = [], shipmentLines = [] }) {
  const warnings = [];
  const planRate = numOrNull(order?.rate_cny);
  const totalCny = lines.reduce((s, l) => s + num(l.qty) * num(l.price_cny), 0);

  const goodsPays = payments.filter((p) => p.kind === "prepay" || p.kind === "balance");
  const paidCny = goodsPays.reduce((s, p) => s + num(p.amount), 0);
  const paidRub = goodsPays.reduce((s, p) => s + paymentRub(p), 0);
  const remainingCny = Math.max(0, totalCny - paidCny);
  let rateEff;
  if (totalCny <= 0) rateEff = planRate ?? (paidCny > 0 ? paidRub / paidCny : 0);
  else if (paidCny > totalCny) {
    rateEff = paidRub / paidCny;
    warnings.push(`оплачено ${paidCny} ¥ — больше суммы заказа ${totalCny} ¥`);
  } else {
    if (remainingCny > 0 && planRate == null) warnings.push("не указан плановый курс заказа — неоплаченный остаток посчитан по 0");
    rateEff = (paidRub + remainingCny * (planRate ?? 0)) / totalCny;
  }

  const otherRub = payments.filter((p) => p.kind === "other").reduce((s, p) => s + paymentRub(p), 0);
  const otherAlloc = allocate(otherRub, lines.map((l) => ({ key: Number(l.id), qty: l.qty, weight: l.weight_kg })));
  if (otherRub > 0 && !otherAlloc.ok) warnings.push("прочие расходы не на что раскидать — нет позиций");

  const lineById = new Map(lines.map((l) => [Number(l.id), l]));
  const logByLine = new Map();     // line_id → Σ доли логистики
  const shippedByLine = new Map(); // line_id → Σ qty_shipped
  const acceptedByLine = new Map(); // line_id → { shipped, accepted } по принятым отправкам
  let logisticsRub = 0;
  const shipCalcs = shipments.map((s) => {
    const sl = shipmentLines.filter((x) => Number(x.shipment_id) === Number(s.id) && lineById.has(Number(x.line_id)));
    const L = num(s.cargo_rub) + num(s.ff_rub);
    logisticsRub += L;
    const al = allocate(L, sl.map((x) => ({ key: Number(x.line_id), qty: x.qty_shipped, weight: lineById.get(Number(x.line_id)).weight_kg })));
    if (L > 0 && !al.ok) warnings.push(`логистику отправки #${s.id} не на что раскидать`);
    for (const x of sl) {
      const k = Number(x.line_id);
      logByLine.set(k, (logByLine.get(k) || 0) + (al.byKey.get(k) || 0));
      shippedByLine.set(k, (shippedByLine.get(k) || 0) + num(x.qty_shipped));
      if (s.status === "accepted" && x.qty_accepted != null) {
        const a = acceptedByLine.get(k) || { shipped: 0, accepted: 0 };
        a.shipped += num(x.qty_shipped); a.accepted += num(x.qty_accepted);
        acceptedByLine.set(k, a);
      }
    }
    return { id: Number(s.id), status: s.status, logisticsRub: L, basis: al.basis,
      lines: sl.map((x) => ({ line_id: Number(x.line_id), qty_shipped: num(x.qty_shipped),
        qty_accepted: x.qty_accepted == null ? null : num(x.qty_accepted), alloc: al.byKey.get(Number(x.line_id)) || 0 })) };
  });

  const lineCalcs = lines.map((l) => {
    const id = Number(l.id);
    const qty = num(l.qty);
    const goodsUnit = num(l.price_cny) * rateEff;
    const otherUnit = qty > 0 ? (otherAlloc.byKey.get(id) || 0) / qty : 0;
    const shipped = shippedByLine.get(id) || 0;
    const logisticsUnit = shipped > 0 ? (logByLine.get(id) || 0) / shipped : null;
    const unitCost = goodsUnit + otherUnit + (logisticsUnit ?? 0);
    const acc = acceptedByLine.get(id);
    const diff = acc ? acc.shipped - acc.accepted : 0;
    const shortage = Math.max(0, diff);
    return { id, qty, sumCny: qty * num(l.price_cny), goodsUnit, otherUnit, logisticsUnit, unitCost, shipped,
      accepted: acc ? acc.accepted : 0, shortage, surplus: Math.max(0, -diff), shortageRub: shortage * unitCost };
  });
  const unitById = new Map(lineCalcs.map((l) => [l.id, l.unitCost]));
  for (const s of shipCalcs) {
    s.qty = s.lines.reduce((t, x) => t + x.qty_shipped, 0);
    s.value = s.lines.reduce((t, x) => t + x.qty_shipped * (unitById.get(x.line_id) || 0), 0);
  }

  const goodsRub = totalCny * rateEff;
  return {
    totalCny, paidCny, remainingCny, rateEff, goodsRub, otherRub, logisticsRub,
    totalRub: lineCalcs.reduce((s, l) => s + l.unitCost * l.qty, 0),
    qty: lineCalcs.reduce((s, l) => s + l.qty, 0),
    shippedQty: lineCalcs.reduce((s, l) => s + l.shipped, 0),
    acceptedQty: lineCalcs.reduce((s, l) => s + l.accepted, 0),
    shortageQty: lineCalcs.reduce((s, l) => s + l.shortage, 0),
    shortageRub: lineCalcs.reduce((s, l) => s + l.shortageRub, 0),
    warnings, lines: lineCalcs, shipments: shipCalcs,
  };
}
