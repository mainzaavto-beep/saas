// lib/purchaseOrders.js — закупки «заказ → позиции → отправки» (спека
// docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Чистые функции, без БД.
// Себестоимость позиции = товар (эфф. курс оплат) + прочие расходы заказа + логистика отправок,
// на ОТПРАВЛЕННЫЕ штуки. Недостача при приёмке — только показ. Округление — у потребителя.
// Входы calcOrder — уже без удалённых строк (deleted_at фильтрует вызывающий).

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

export const ORDER_STATUS_LABELS = { draft: "Черновик", ordered: "Заказан", production: "В производстве", shipping: "Отгружается", closed: "Закрыт" };
export const PAY_KIND_LABELS = { prepay: "Предоплата", balance: "Доплата", other: "Прочее (доставка по Китаю и т.п.)" };
export const SHIP_STATUS_LABELS = { transit: "В пути", arrived: "Прибыла", accepted: "Принята" };

const TEXT_MAX = 300;
const txt = (v) => { const s = String(v ?? "").trim(); return s ? s.slice(0, TEXT_MAX) : null; };
const parseNum = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};
const isoDate = (v) => {
  if (v == null || v === "") return { ok: true, v: null };
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { ok: true, v: s } : { ok: false };
};
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const fail = (error) => ({ ok: false, error });

export function validateOrderInput(raw = {}) {
  const supplier = txt(raw.supplier);
  if (!supplier) return fail("укажите поставщика");
  const rate = parseNum(raw.rate_cny);
  if (Number.isNaN(rate) || (rate != null && rate <= 0)) return fail("плановый курс ¥ — число > 0 или пусто");
  const d = isoDate(raw.order_dt);
  if (!d.ok) return fail("дата заказа — ГГГГ-ММ-ДД");
  const status = raw.status == null || raw.status === "" ? "draft" : String(raw.status);
  if (!ORDER_STATUS_LABELS[status]) return fail("неизвестный статус заказа");
  return { ok: true, value: { order_no: txt(raw.order_no), supplier, supplier_contact: txt(raw.supplier_contact),
    source_country: txt(raw.source_country), category: txt(raw.category), note: txt(raw.note),
    order_dt: d.v, rate_cny: rate, status } };
}

export function validateLineInput(raw = {}) {
  const platform = raw.platform ? String(raw.platform) : null;
  if (platform && platform !== "wb" && platform !== "ozon") return fail("площадка: wb, ozon или пусто");
  let nm_id = null, product_id = null;
  if (platform === "wb") { nm_id = posInt(raw.nm_id); if (!nm_id) return fail("нет артикула WB (nm_id)"); }
  if (platform === "ozon") { product_id = posInt(raw.product_id); if (!product_id) return fail("нет товара Ozon (product_id)"); }
  const label = txt(raw.label);
  if (!label) return fail("укажите товар: артикул или название");
  const qty = Number(raw.qty);
  if (!Number.isInteger(qty) || qty <= 0) return fail("количество — целое число > 0");
  const price = parseNum(raw.price_cny) ?? 0;
  if (Number.isNaN(price) || price < 0) return fail("цена ¥ — число ≥ 0");
  const w = parseNum(raw.weight_kg);
  if (Number.isNaN(w) || (w != null && w <= 0)) return fail("вес — число > 0 или пусто");
  return { ok: true, value: { platform, nm_id, product_id, label, variant: txt(raw.variant), qty, price_cny: price,
    weight_kg: w, photo_url: txt(raw.photo_url), note: txt(raw.note) } };
}

export function validatePaymentInput(raw = {}) {
  const kind = String(raw.kind || "");
  if (!PAY_KIND_LABELS[kind]) return fail("вид оплаты: предоплата, доплата или прочее");
  const currency = raw.currency === "rub" ? "rub" : "cny";
  if (kind !== "other" && currency !== "cny") return fail("оплата товара — только в ¥");
  const amount = parseNum(raw.amount);
  if (amount == null || Number.isNaN(amount) || amount <= 0) return fail("сумма — число > 0");
  let rate = null;
  if (currency === "cny") {
    rate = parseNum(raw.rate);
    if (rate == null || Number.isNaN(rate) || rate <= 0) return fail("курс оплаты — число > 0");
  }
  const d = isoDate(raw.plan_date);
  if (!d.ok) return fail("дата оплаты — ГГГГ-ММ-ДД");
  return { ok: true, value: { kind, currency, amount, rate, plan_date: d.v, note: txt(raw.note) } };
}

export function validateShipmentInput(raw = {}) {
  const dates = {};
  for (const k of ["ship_dt", "eta", "arrived_dt"]) {
    const d = isoDate(raw[k]);
    if (!d.ok) return fail(`${k} — ГГГГ-ММ-ДД`);
    dates[k] = d.v;
  }
  const money = {};
  for (const k of ["cargo_rub", "ff_rub"]) {
    const n = parseNum(raw[k]) ?? 0;
    if (Number.isNaN(n) || n < 0) return fail("логистика — число ≥ 0");
    money[k] = n;
  }
  let lines;
  if (raw.lines !== undefined) {
    if (!Array.isArray(raw.lines)) return fail("lines — список");
    const seen = new Set();
    lines = [];
    for (const x of raw.lines) {
      const line_id = posInt(x?.line_id), q = posInt(x?.qty_shipped);
      if (!line_id) return fail("строка отправки без позиции");
      if (!q) return fail("отправлено — целое число > 0");
      if (seen.has(line_id)) return fail("позиция повторяется в отправке");
      seen.add(line_id);
      lines.push({ line_id, qty_shipped: q });
    }
  }
  return { ok: true, value: { shipment_no: txt(raw.shipment_no), carrier: txt(raw.carrier), ...dates, ...money,
    note: txt(raw.note), lines } };
}

export function checkShipQty(lines, shipmentLines, newLines, excludeShipmentId) {
  const byId = new Map(lines.map((l) => [Number(l.id), l]));
  const used = new Map();
  for (const x of shipmentLines) {
    if (excludeShipmentId != null && Number(x.shipment_id) === Number(excludeShipmentId)) continue;
    used.set(Number(x.line_id), (used.get(Number(x.line_id)) || 0) + Number(x.qty_shipped));
  }
  for (const n of newLines) {
    const l = byId.get(Number(n.line_id));
    if (!l) return `позиция ${n.line_id} не из этого заказа`;
    const total = (used.get(Number(n.line_id)) || 0) + Number(n.qty_shipped);
    if (total > Number(l.qty)) return `«${l.label || l.id}»: отправлено ${total} из заказанных ${l.qty}`;
  }
  return null;
}

export function defaultShipmentLines(lines, shipmentLines) {
  const used = new Map();
  for (const x of shipmentLines) used.set(Number(x.line_id), (used.get(Number(x.line_id)) || 0) + Number(x.qty_shipped));
  return lines
    .map((l) => ({ line_id: Number(l.id), qty_shipped: Number(l.qty) - (used.get(Number(l.id)) || 0) }))
    .filter((x) => x.qty_shipped > 0);
}

export function autoOrderStatus(current, lines, shipments, shipmentLines) {
  if (!lines.length) return current === "closed" ? "ordered" : current;
  const live = new Set(shipments.map((s) => Number(s.id)));
  const sl = shipmentLines.filter((x) => live.has(Number(x.shipment_id)));
  const fullyShipped = defaultShipmentLines(lines, sl).length === 0;
  const allAccepted = shipments.length > 0 && shipments.every((s) => s.status === "accepted");
  if (fullyShipped && allAccepted) return "closed";
  if (sl.length > 0) return "shipping";
  return current === "closed" || current === "shipping" ? "ordered" : current;
}

export function cargoRub(totalKg, usdPerKg, rateUsd) {
  return num(totalKg) * num(usdPerKg) * num(rateUsd);
}

// ---- оплаченные строки ДДС (Ruling 9): суммы только для чтения, пока в календаре стоит «оплачено» ----
export const PAID_LOCK_MSG = "оплата уже проведена в ДДС — снимите отметку «оплачено» в календаре, чтобы изменить сумму";
export const payRef = (orderId, payId) => `order:${Number(orderId)}:pay:${Number(payId)}`;
export const shipRef = (orderId, shipId, key) => `order:${Number(orderId)}:ship:${Number(shipId)}:${key}`;
const sameNum = (a, b) => numOrNull(a) === numOrNull(b);
const sameMoney = (a, b) => num(a) === num(b);

// Правка оплаты меняет сумму в ДДС? (вид/валюта/сумма/курс; дата и примечание — нет)
export function paymentAmountChanged(cur, next) {
  return cur.kind !== next.kind || cur.currency !== next.currency || !sameNum(cur.amount, next.amount) || !sameNum(cur.rate, next.rate);
}

// Ошибка правки денег отправки при оплаченных строках карго/ФФ (null — можно).
export function shipmentMoneyLockError(paid, orderId, cur, next) {
  for (const key of ["cargo", "ff"]) {
    if (paid.has(shipRef(orderId, cur.id, key)) && !sameMoney(cur[`${key}_rub`], next[`${key}_rub`])) return PAID_LOCK_MSG;
  }
  return null;
}

export function shipmentHasPaid(paid, orderId, shipId) {
  return paid.has(shipRef(orderId, shipId, "cargo")) || paid.has(shipRef(orderId, shipId, "ff"));
}
