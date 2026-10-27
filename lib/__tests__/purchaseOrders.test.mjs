// lib/__tests__/purchaseOrders.test.mjs — заказ → позиции → отправки (спека 2026-10-27-purchase-orders-design.md §2).
import test from "node:test";
import assert from "node:assert/strict";
import { allocate, calcOrder, paymentRub } from "../purchaseOrders.js";

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
