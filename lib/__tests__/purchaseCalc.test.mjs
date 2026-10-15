// lib/__tests__/purchaseCalc.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { computeExcel, balanceDueRub } from "../purchaseCalc.js";

const P = { prepay_yuan: 1000, prepay_rate: 12, qty: 100, unit_cost_yuan: 30,
  exchange_rate: 12.5, logistics_rub_per_unit: 20, logistics_rub: 5 };

test("computeExcel: формулы Excel владельца", () => {
  const f = computeExcel(P);
  assert.equal(f.N, 12000);          // L×M
  assert.equal(f.Q, 3000);           // O×P
  assert.equal(f.R, 2000);           // Q−L
  assert.equal(f.S, 24000);          // M×R
  assert.equal(f.W, 37000);          // R×U+N
  assert.equal(f.Z, 39500);          // W+(X+Y)×O
  assert.equal(f.unitCost, 395);
});

test("balanceDueRub: остаток по курсу оплаты = W − N = R×U", () => {
  assert.equal(balanceDueRub(computeExcel(P)), 25000);
});

test("computeExcel: без qty", () => {
  const f = computeExcel({ prepay_yuan: 100, prepay_rate: 10 });
  assert.equal(f.Q, null);
  assert.equal(f.unitCost, null);
});
