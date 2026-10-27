// lib/__tests__/purchaseOrders.test.mjs — заказ → позиции → отправки (спека 2026-10-27-purchase-orders-design.md §2).
import test from "node:test";
import assert from "node:assert/strict";
import { allocate, calcOrder, paymentRub, validateOrderInput, validateLineInput, validatePaymentInput, validateShipmentInput,
  checkShipQty, defaultShipmentLines, autoOrderStatus, cargoRub, PAID_LOCK_MSG, payRef, shipRef, paymentAmountChanged,
  shipmentMoneyLockError, shipmentHasPaid } from "../purchaseOrders.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// Пример спеки §2.
const EX = () => ({
  order: { id: 1, rate_cny: 11.9 },
  payments: [
    { id: 1, kind: "prepay", currency: "cny", amount: 4000, rate: 11.46 },
    { id: 2, kind: "other", currency: "cny", amount: 300, rate: 11.5 },
  ],
  lines: [
    { id: 10, qty: 70, price_cny: 150, weight_kg: 0.3 },   // камера
    { id: 11, qty: 200, price_cny: 12.5, weight_kg: 0.1 }, // бельё
  ],
  shipments: [
    { id: 100, status: "accepted", cargo_rub: 12000, ff_rub: 4000 },
    { id: 101, status: "transit", cargo_rub: 5000, ff_rub: 0 },
  ],
  shipmentLines: [
    { shipment_id: 100, line_id: 10, qty_shipped: 40, qty_accepted: 38 },
    { shipment_id: 100, line_id: 11, qty_shipped: 200, qty_accepted: 200 },
    { shipment_id: 101, line_id: 10, qty_shipped: 30, qty_accepted: null },
  ],
});

test("allocate: по весу, если вес у всех", () => {
  const r = allocate(16000, [{ key: 10, qty: 40, weight: 0.3 }, { key: 11, qty: 200, weight: 0.1 }]);
  assert.equal(r.basis, "weight");
  close(r.byKey.get(10), 6000);
  close(r.byKey.get(11), 10000);
});

test("allocate: вес не у всех → по штукам", () => {
  const r = allocate(1000, [{ key: 1, qty: 30, weight: 0.5 }, { key: 2, qty: 70, weight: null }]);
  assert.equal(r.basis, "qty");
  close(r.byKey.get(1), 300);
  close(r.byKey.get(2), 700);
});

test("allocate: пустая база → ok:false", () => {
  assert.equal(allocate(500, []).ok, false);
});

test("paymentRub: ¥ × курс, ₽ как есть", () => {
  close(paymentRub({ currency: "cny", amount: 100, rate: 11.5 }), 1150);
  close(paymentRub({ currency: "rub", amount: 700, rate: null }), 700);
});

test("calcOrder: пример спеки — курс, товар, логистика, прочее", () => {
  const r = calcOrder(EX());
  close(r.totalCny, 13000);
  close(r.paidCny, 4000);
  close(r.remainingCny, 9000);
  close(r.rateEff, (4000 * 11.46 + 9000 * 11.9) / 13000);
  const cam = r.lines.find((l) => l.id === 10);
  const lin = r.lines.find((l) => l.id === 11);
  close(cam.goodsUnit, 150 * r.rateEff);
  close(cam.logisticsUnit, 11000 / 70);
  close(lin.logisticsUnit, 50);
  close(cam.otherUnit, 3450 * 21 / 41 / 70);
  close(lin.otherUnit, 3450 * 20 / 41 / 200);
  close(cam.unitCost, cam.goodsUnit + cam.otherUnit + cam.logisticsUnit);
  assert.equal(cam.shipped, 70);
});

test("calcOrder: инвариант — полностью отправленный заказ сходится до копейки", () => {
  const r = calcOrder(EX());
  const sum = r.lines.reduce((s, l) => s + l.unitCost * l.qty, 0);
  close(sum, r.goodsRub + r.otherRub + r.logisticsRub, 1e-6);
  close(r.totalRub, sum, 1e-6);
  close(r.logisticsRub, 21000);
  close(r.otherRub, 3450);
});

test("calcOrder: недостача только по принятым отправкам, на себестоимость не влияет", () => {
  const r = calcOrder(EX());
  const cam = r.lines.find((l) => l.id === 10);
  assert.equal(cam.accepted, 38);
  assert.equal(cam.shortage, 2);
  close(cam.shortageRub, 2 * cam.unitCost);
  assert.equal(r.shortageQty, 2);
  close(cam.logisticsUnit, 11000 / 70); // недостача не поднимает логистику
});

test("calcOrder: излишек показывается, недостачи нет", () => {
  const ex = EX();
  ex.shipmentLines[1].qty_accepted = 205;
  const lin = calcOrder(ex).lines.find((l) => l.id === 11);
  assert.equal(lin.surplus, 5);
  assert.equal(lin.shortage, 0);
});

test("calcOrder: ничего не отправлено → logisticsUnit null, unitCost без логистики", () => {
  const ex = EX();
  ex.shipments = []; ex.shipmentLines = [];
  const cam = calcOrder(ex).lines.find((l) => l.id === 10);
  assert.equal(cam.logisticsUnit, null);
  close(cam.unitCost, cam.goodsUnit + cam.otherUnit);
});

test("calcOrder: переплата → курс по оплатам и предупреждение", () => {
  const ex = EX();
  ex.payments.push({ id: 3, kind: "balance", currency: "cny", amount: 10000, rate: 12 });
  const r = calcOrder(ex);
  close(r.rateEff, (4000 * 11.46 + 10000 * 12) / 14000);
  close(r.remainingCny, 0);
  assert.ok(r.warnings.some((w) => /больше суммы заказа/.test(w)));
});

test("calcOrder: прочее в ₽; плановый курс не указан → предупреждение", () => {
  const ex = EX();
  ex.order.rate_cny = null;
  ex.payments[1] = { id: 2, kind: "other", currency: "rub", amount: 1000, rate: null };
  const r = calcOrder(ex);
  close(r.otherRub, 1000);
  close(r.rateEff, (4000 * 11.46) / 13000);
  assert.ok(r.warnings.some((w) => /плановый курс/.test(w)));
});

test("calcOrder: стоимость отправки в пути (value) = Σ шт × себестоимость", () => {
  const r = calcOrder(EX());
  const s = r.shipments.find((x) => x.id === 101);
  const cam = r.lines.find((l) => l.id === 10);
  close(s.value, 30 * cam.unitCost);
  assert.equal(s.qty, 30);
});

test("calcOrder: пустой заказ", () => {
  const r = calcOrder({ order: { id: 1, rate_cny: 12 }, payments: [], lines: [], shipments: [], shipmentLines: [] });
  assert.equal(r.totalCny, 0);
  assert.equal(r.rateEff, 12);
  assert.equal(r.lines.length, 0);
});

test("validateOrderInput: поставщик обязателен, курс > 0 или пусто, дата ISO", () => {
  assert.equal(validateOrderInput({ supplier: " " }).ok, false);
  assert.equal(validateOrderInput({ supplier: "A", rate_cny: -1 }).ok, false);
  assert.equal(validateOrderInput({ supplier: "A", order_dt: "27.10.2026" }).ok, false);
  assert.equal(validateOrderInput({ supplier: "A", status: "nope" }).ok, false);
  const v = validateOrderInput({ supplier: " hanyou ", rate_cny: "11,9", order_dt: "2026-10-27" });
  assert.equal(v.ok, true);
  assert.equal(v.value.supplier, "hanyou");
  assert.equal(v.value.rate_cny, 11.9);
  assert.equal(v.value.status, "draft");
});

test("validateLineInput: артикул или текст, qty целое > 0, вес пусто или > 0", () => {
  assert.equal(validateLineInput({ label: "", qty: 1 }).ok, false);
  assert.equal(validateLineInput({ label: "x", qty: 0 }).ok, false);
  assert.equal(validateLineInput({ label: "x", qty: 1.5 }).ok, false);
  assert.equal(validateLineInput({ label: "x", qty: 1, weight_kg: 0 }).ok, false);
  assert.equal(validateLineInput({ platform: "wb", label: "x", qty: 1 }).ok, false);
  const v = validateLineInput({ platform: "ozon", product_id: "55", label: "Трусы", variant: "M", qty: "10", price_cny: "12,5", weight_kg: "" });
  assert.equal(v.ok, true);
  assert.deepEqual([v.value.product_id, v.value.nm_id, v.value.qty, v.value.price_cny, v.value.weight_kg], [55, null, 10, 12.5, null]);
});

test("validatePaymentInput: товар только в ¥ с курсом; прочее в ₽ без курса", () => {
  assert.equal(validatePaymentInput({ kind: "prepay", currency: "rub", amount: 1 }).ok, false);
  assert.equal(validatePaymentInput({ kind: "prepay", amount: 1 }).ok, false); // нет курса
  assert.equal(validatePaymentInput({ kind: "prepay", amount: 0, rate: 11 }).ok, false);
  const a = validatePaymentInput({ kind: "prepay", amount: "4000", rate: "11.46", plan_date: "2026-10-01" });
  assert.equal(a.ok, true);
  assert.equal(a.value.currency, "cny");
  const b = validatePaymentInput({ kind: "other", currency: "rub", amount: 700, rate: 5 });
  assert.equal(b.ok, true);
  assert.equal(b.value.rate, null);
});

test("validateShipmentInput: деньги ≥ 0, строки без дублей", () => {
  assert.equal(validateShipmentInput({ cargo_rub: -1 }).ok, false);
  assert.equal(validateShipmentInput({ lines: [{ line_id: 1, qty_shipped: 1 }, { line_id: 1, qty_shipped: 2 }] }).ok, false);
  assert.equal(validateShipmentInput({ lines: [{ line_id: 1, qty_shipped: 0 }] }).ok, false);
  const v = validateShipmentInput({ shipment_no: "TRK1", cargo_rub: "12000", lines: [{ line_id: "10", qty_shipped: "40" }] });
  assert.equal(v.ok, true);
  assert.equal(v.value.ff_rub, 0);
  assert.deepEqual(v.value.lines, [{ line_id: 10, qty_shipped: 40 }]);
  assert.equal(validateShipmentInput({ note: "x" }).value.lines, undefined);
});

test("checkShipQty: нельзя отправить больше заказанного (с учётом других отправок)", () => {
  const lines = [{ id: 10, qty: 70, label: "камера" }];
  const sl = [{ shipment_id: 100, line_id: 10, qty_shipped: 40 }];
  assert.equal(checkShipQty(lines, sl, [{ line_id: 10, qty_shipped: 30 }], null), null);
  assert.match(checkShipQty(lines, sl, [{ line_id: 10, qty_shipped: 31 }], null), /камера/);
  assert.equal(checkShipQty(lines, sl, [{ line_id: 10, qty_shipped: 70 }], 100), null); // правка той же отправки
  assert.match(checkShipQty(lines, sl, [{ line_id: 99, qty_shipped: 1 }], null), /не из этого заказа/);
});

test("defaultShipmentLines: только неотправленные остатки", () => {
  const lines = [{ id: 10, qty: 70 }, { id: 11, qty: 200 }];
  const sl = [{ shipment_id: 100, line_id: 10, qty_shipped: 40 }, { shipment_id: 100, line_id: 11, qty_shipped: 200 }];
  assert.deepEqual(defaultShipmentLines(lines, sl), [{ line_id: 10, qty_shipped: 30 }]);
});

test("autoOrderStatus: закрыт, когда всё отправлено и всё принято; иначе откат из closed", () => {
  const lines = [{ id: 10, qty: 70 }];
  const ships = [{ id: 100, status: "accepted" }];
  const full = [{ shipment_id: 100, line_id: 10, qty_shipped: 70 }];
  assert.equal(autoOrderStatus("shipping", lines, ships, full), "closed");
  assert.equal(autoOrderStatus("closed", lines, [{ id: 100, status: "arrived" }], full), "shipping");
  assert.equal(autoOrderStatus("ordered", lines, ships, [{ shipment_id: 100, line_id: 10, qty_shipped: 10 }]), "shipping");
  assert.equal(autoOrderStatus("ordered", lines, [], []), "ordered");
  assert.equal(autoOrderStatus("draft", [], [], []), "draft");
});

test("cargoRub: кг × $/кг × курс $", () => {
  close(cargoRub(50, 3.5, 90), 15750);
});

// ---- оплаченные строки ДДС: суммы только для чтения (Ruling 9) ----
test("payRef/shipRef — формат source_ref как в orderPayments", () => {
  assert.equal(payRef("12", 3), "order:12:pay:3");
  assert.equal(shipRef(12, "5", "cargo"), "order:12:ship:5:cargo");
});

test("paymentAmountChanged: дата и примечание — не сумма; вид/валюта/сумма/курс — сумма", () => {
  const cur = { kind: "prepay", currency: "cny", amount: 1000, rate: 11.5, plan_date: "2026-10-01", note: null };
  assert.equal(paymentAmountChanged(cur, { ...cur, plan_date: "2026-11-01", note: "x" }), false);
  assert.equal(paymentAmountChanged(cur, { ...cur, amount: 1001 }), true);
  assert.equal(paymentAmountChanged(cur, { ...cur, rate: 11.6 }), true);
  assert.equal(paymentAmountChanged(cur, { ...cur, kind: "balance" }), true);
  const rub = { kind: "other", currency: "rub", amount: 500, rate: null };
  assert.equal(paymentAmountChanged(rub, { ...rub }), false);
  assert.equal(paymentAmountChanged(rub, { ...rub, currency: "cny", rate: 11 }), true);
});

test("shipmentMoneyLockError: оплачено карго — карго не меняется, ФФ можно", () => {
  const paid = new Set([shipRef(7, 9, "cargo")]);
  const cur = { id: 9, cargo_rub: 1500, ff_rub: null };
  assert.equal(shipmentMoneyLockError(paid, 7, cur, { cargo_rub: 1500, ff_rub: 300 }), null);
  assert.equal(shipmentMoneyLockError(paid, 7, cur, { cargo_rub: 1600, ff_rub: 0 }), PAID_LOCK_MSG);
  // null из БД и 0 после валидации — одно и то же
  const paidFf = new Set([shipRef(7, 9, "ff")]);
  assert.equal(shipmentMoneyLockError(paidFf, 7, cur, { cargo_rub: 1, ff_rub: 0 }), null);
  assert.equal(shipmentMoneyLockError(new Set(), 7, cur, { cargo_rub: 0, ff_rub: 0 }), null);
});

test("shipmentHasPaid: любая из двух строк отправки", () => {
  assert.equal(shipmentHasPaid(new Set([shipRef(1, 2, "ff")]), 1, 2), true);
  assert.equal(shipmentHasPaid(new Set([shipRef(1, 3, "ff")]), 1, 2), false);
  assert.equal(shipmentHasPaid(new Set([payRef(1, 2)]), 1, 2), false);
});
