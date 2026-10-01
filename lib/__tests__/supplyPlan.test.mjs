// lib/__tests__/supplyPlan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { velocityPerDay, coverageDays, needQty, purchaseNeedQty, purchaseNeedForItem, pickSources, buildSupplyPlan } from "../supplyPlan.js";

test("скорость и покрытие", () => {
  assert.equal(velocityPerDay(56, 28), 2);
  assert.equal(coverageDays(10, 4, 2), 7);
  assert.equal(coverageDays(10, 0, 0), null);
});

test("потребность с кратностью упаковки", () => {
  assert.equal(needQty({ targetDays: 30, velocity: 2, stock: 10, inTransit: 4, packQty: 12 }), 48); // 60−14=46 → 48
  assert.equal(needQty({ targetDays: 30, velocity: 2, stock: 70, inTransit: 0, packQty: null }), 0);
  assert.equal(needQty({ targetDays: 30, velocity: 0.5, stock: 0, inTransit: 0, packQty: 1 }), 15);
});

test("источник: ближний регион первым, остаток не покрыт — явно", () => {
  const sources = [
    { locationId: 5, city: "Казань", regionKeys: ["Приволжский"], available: 20 },
    { locationId: 6, city: "Москва", regionKeys: ["Центральный"], available: 50 },
  ];
  assert.deepEqual(pickSources(sources, 30, "Приволжский"), { parts: [{ locationId: 5, qty: 20 }, { locationId: 6, qty: 10 }], uncovered: 0 });
  assert.deepEqual(pickSources(sources, 100, "Центральный"), { parts: [{ locationId: 6, qty: 50 }, { locationId: 5, qty: 20 }], uncovered: 30 });
  assert.deepEqual(pickSources([], 5, "x"), { parts: [], uncovered: 5 });
});

test("план: группы по (место → склад), пропуск покрытых и без скорости", () => {
  const settings = { targetDays: 30, minDays: 14 };
  const targets = [
    { platform: "ozon", warehouseKey: "w1", warehouseName: "КАЗАНЬ_РФЦ", regionKey: "Приволжский", itemId: 1, itemName: "A", skuKey: 4988, stock: 4, inTransit: 0, ordersQty: 56, days: 28, packQty: null },
    { platform: "ozon", warehouseKey: "w2", warehouseName: "ГРИВНО_РФЦ", regionKey: "Центральный", itemId: 1, itemName: "A", skuKey: 4988, stock: 100, inTransit: 0, ordersQty: 28, days: 28, packQty: null },
    { platform: "ozon", warehouseKey: "w3", warehouseName: "УФА_РФЦ", regionKey: "Приволжский", itemId: 2, itemName: "B", skuKey: 4999, stock: 0, inTransit: 0, ordersQty: 0, days: 28, packQty: null },
  ];
  const sources = { 1: [{ locationId: 5, city: "Казань", regionKeys: ["Приволжский"], available: 30 }] };
  const plan = buildSupplyPlan({ settings, targets, sources });
  assert.equal(plan.groups.length, 1);
  const g = plan.groups[0];
  assert.equal(g.locationId, 5); assert.equal(g.warehouseKey, "w1");
  assert.deepEqual(g.lines.map((l) => [l.itemId, l.need, l.qty, l.coverageDays]), [[1, 56, 30, 2]]); // need = 30×2−4 = 56, есть 30
  assert.deepEqual(plan.uncovered, [{ itemId: 1, warehouseKey: "w1", qty: 26 }]);
});

test("план: один источник на два склада — 30 доступно, потребности 20 и 20 → 20 и 10, uncovered 10", () => {
  // Оба склада хотят по 20 шт с одинаковым coverageDays (stock=0 → 0). При равенстве coverageDays
  // порядок обработки — по убыванию need (тоже равны), затем стабильный порядок исходного массива:
  // w1 обслуживается первым и получает все 20, w2 достаётся остаток источника (10 из нужных 20).
  const settings = { targetDays: 10, minDays: 14 };
  const targets = [
    { platform: "ozon", warehouseKey: "w1", warehouseName: "А_РФЦ", regionKey: "Приволжский", itemId: 1, itemName: "A", skuKey: 1, stock: 0, inTransit: 0, ordersQty: 20, days: 10, packQty: 1 },
    { platform: "ozon", warehouseKey: "w2", warehouseName: "Б_РФЦ", regionKey: "Приволжский", itemId: 1, itemName: "A", skuKey: 1, stock: 0, inTransit: 0, ordersQty: 20, days: 10, packQty: 1 },
  ];
  const sources = { 1: [{ locationId: 9, city: "Казань", regionKeys: ["Приволжский"], available: 30 }] };
  const plan = buildSupplyPlan({ settings, targets, sources });
  assert.equal(plan.groups.length, 2);
  const byWh = Object.fromEntries(plan.groups.map((g) => [g.warehouseKey, g.lines[0]]));
  assert.equal(byWh.w1.need, 20); assert.equal(byWh.w1.qty, 20);
  assert.equal(byWh.w2.need, 20); assert.equal(byWh.w2.qty, 10);
  assert.deepEqual(plan.uncovered, [{ itemId: 1, warehouseKey: "w2", qty: 10 }]);
});

test("purchaseNeedQty: «К закупке» = ceil(v×(срок+запас) − доступно − от клиента)", () => {
  // 1,66 × 50 = 83 − 5 − 0 = 78 (в пути К клиенту не передаётся и не вычитается)
  assert.equal(purchaseNeedQty({ velocity: 1.66, available: 5, inWayFrom: 0, leadDays: 20, targetDays: 30 }), 78);
  assert.equal(purchaseNeedQty({ velocity: 1, available: 40, inWayFrom: 10, leadDays: 20, targetDays: 30 }), 0);
  assert.equal(purchaseNeedQty({ velocity: 0.1, available: 0, inWayFrom: 0, leadDays: 20, targetDays: 30 }), 5);
  assert.equal(purchaseNeedQty({ velocity: 0, available: 0, inWayFrom: 0, leadDays: 20, targetDays: 30 }), 0);
  assert.equal(purchaseNeedQty({ velocity: null, available: 3, inWayFrom: 0, leadDays: 20, targetDays: 30 }), null);
  assert.equal(purchaseNeedQty({ velocity: 0.07, available: 0, inWayFrom: 0, leadDays: 20, targetDays: 30 }), 4); // 3.5 → 4
  assert.equal(purchaseNeedQty({ velocity: 0.07, available: 0, inWayFrom: 0, leadDays: 50, targetDays: 50 }), 7); // 0.07×100 = 7.000000000000001 → 7, не 8
  assert.equal(purchaseNeedQty({ velocity: 1, available: -2, inWayFrom: 0, leadDays: 1, targetDays: 1 }), 2); // отрицательное доступно не добавляет потребность
});

test("purchaseNeedForItem: товар с размерами = Σ размеров; размер без скорости → по товару", () => {
  const p = { leadDays: 20, targetDays: 30 };
  const it = { velocity: 2, quantity: 50, in_way_from: 0, sizes: [
    { velocity: 1.5, quantity: 10, in_way_from: 2 },   // 75 − 12 = 63
    { velocity: 0.5, quantity: 40, in_way_from: 0 },   // 25 − 40 → 0
  ] };
  assert.equal(purchaseNeedForItem(it, p), 63);       // по товару было бы 100 − 50 = 50: перекос размеров виден
  assert.equal(purchaseNeedForItem({ ...it, sizes: [{ velocity: null, quantity: 1 }] }, p), 50);
  assert.equal(purchaseNeedForItem({ velocity: 1, quantity: 0, in_way_from: 0 }, p), 50);
});
