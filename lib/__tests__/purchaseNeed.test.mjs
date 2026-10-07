// lib/__tests__/purchaseNeed.test.mjs — страница «Потребность» (06.10.2026):
// товар = связная компонента позиций склада и артикулов МП; остаток = МП + свой склад + в пути.
import test from "node:test";
import assert from "node:assert/strict";
import { buildPurchaseNeed } from "../purchaseNeed.js";

const opts = { windowDays: 7, horizonDays: 30 };

test("WB и Ozon одной позиции склада — одна строка, остатки и продажи суммируются", () => {
  const out = buildPurchaseNeed({
    positions: [{ id: 1, internal_name: "Камера", qty: 10, unit_cost: 500, skus: [{ platform: "wb", sku_key: 11 }, { platform: "ozon", sku_key: 22 }] }],
    mpStock: [{ platform: "wb", sku_key: 11, available: 20, inWayFrom: 2 }, { platform: "ozon", sku_key: 22, available: 5, inWayFrom: 0 }],
    orders: [{ platform: "wb", sku_key: 11, qty: 14 }, { platform: "ozon", sku_key: 22, qty: 7 }],
    ...opts,
  });
  assert.equal(out.rows.length, 1);
  const r = out.rows[0];
  assert.equal(r.mpQty, 25);
  assert.equal(r.ownQty, 10);
  assert.equal(r.transitQty, 2);
  assert.equal(r.velocity, 3); // (14 + 7) / 7
  assert.equal(r.coverageDays, 37 / 3);
  assert.equal(r.needQty, 90 - 37); // 3 × 30 − (25 + 10 + 2)
  assert.equal(r.unitCost, 500);
  assert.equal(r.needCost, 53 * 500);
  assert.deepEqual(r.skus, { wb: [11], ozon: [22] });
});

test("артикул без привязки — отдельная строка своей площадки", () => {
  const out = buildPurchaseNeed({
    positions: [],
    mpStock: [{ platform: "wb", sku_key: 11, available: 3, name: "Чехол", cost: 100 }],
    orders: [{ platform: "wb", sku_key: 11, qty: 7 }],
    ...opts,
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].name, "Чехол");
  assert.equal(out.rows[0].needQty, 27);
  assert.equal(out.rows[0].unitCost, 100);
});

test("две позиции с общим артикулом сливаются транзитивно", () => {
  const out = buildPurchaseNeed({
    positions: [
      { id: 1, internal_name: "A", qty: 4, skus: [{ platform: "wb", sku_key: 11 }] },
      { id: 2, internal_name: "A2", qty: 6, skus: [{ platform: "wb", sku_key: 11 }, { platform: "ozon", sku_key: 22 }] },
    ],
    mpStock: [], orders: [], ...opts,
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].ownQty, 10);
});

test("позиция склада без артикула — в список «без привязки», не в строки", () => {
  const out = buildPurchaseNeed({
    positions: [{ id: 5, internal_name: "Коробки", qty: 100, skus: [] }],
    mpStock: [], orders: [], ...opts,
  });
  assert.equal(out.rows.length, 0);
  assert.deepEqual(out.unlinked, [{ id: 5, name: "Коробки", qty: 100 }]);
});

test("неактивные артикулы скрыты; товар с хотя бы одним активным артикулом виден целиком", () => {
  const status = { "wb|11|0": "inactive", "wb|33|0": "inactive" };
  const out = buildPurchaseNeed({
    positions: [{ id: 1, internal_name: "A", qty: 1, skus: [{ platform: "wb", sku_key: 11 }, { platform: "ozon", sku_key: 22 }] }],
    mpStock: [{ platform: "wb", sku_key: 11, available: 5 }, { platform: "wb", sku_key: 33, available: 9 }],
    orders: [], status, ...opts,
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].mpQty, 5);
});

test("без продаж: скорость 0, хватит «—», закупать 0; пустые строки (0 остатка и 0 продаж) не показываются", () => {
  const out = buildPurchaseNeed({
    positions: [],
    mpStock: [{ platform: "wb", sku_key: 11, available: 5 }, { platform: "wb", sku_key: 12, available: 0 }],
    orders: [], ...opts,
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].velocity, 0);
  assert.equal(out.rows[0].coverageDays, null);
  assert.equal(out.rows[0].needQty, 0);
});

test("в пути на МП по документу отгрузки зачисляется товару позиции", () => {
  const out = buildPurchaseNeed({
    positions: [{ id: 1, internal_name: "A", qty: 0, skus: [{ platform: "wb", sku_key: 11 }] }],
    mpStock: [], orders: [{ platform: "wb", sku_key: 11, qty: 7 }],
    inTransit: [{ ff_inventory_id: 1, qty: 20 }], ...opts,
  });
  assert.equal(out.rows[0].transitQty, 20);
  assert.equal(out.rows[0].needQty, 10);
});

test("сортировка: сначала по «хватит на» (меньше — выше), без продаж — в конце; итоги", () => {
  const out = buildPurchaseNeed({
    positions: [],
    mpStock: [
      { platform: "wb", sku_key: 1, available: 70, cost: 10 },
      { platform: "wb", sku_key: 2, available: 7, cost: 10 },
      { platform: "wb", sku_key: 3, available: 5 },
    ],
    orders: [{ platform: "wb", sku_key: 1, qty: 7 }, { platform: "wb", sku_key: 2, qty: 7 }],
    ...opts,
  });
  assert.deepEqual(out.rows.map((r) => r.skus.wb[0]), [2, 1, 3]);
  assert.deepEqual(out.totals, { items: 3, toBuyItems: 1, needQty: 23, needCost: 230 });
});

test("горизонт меняет потребность", () => {
  const inp = { positions: [], mpStock: [{ platform: "wb", sku_key: 1, available: 0 }], orders: [{ platform: "wb", sku_key: 1, qty: 7 }] };
  assert.equal(buildPurchaseNeed({ ...inp, windowDays: 7, horizonDays: 30 }).rows[0].needQty, 30);
  assert.equal(buildPurchaseNeed({ ...inp, windowDays: 7, horizonDays: 45 }).rows[0].needQty, 45);
});

test("фильтр площадки: только артикулы и отгрузки площадки, свой склад целиком", () => {
  const inp = {
    positions: [{ id: 1, internal_name: "Камера", qty: 10, skus: [{ platform: "wb", sku_key: 11 }, { platform: "ozon", sku_key: 22 }] }],
    mpStock: [{ platform: "wb", sku_key: 11, available: 20, inWayFrom: 2 }, { platform: "ozon", sku_key: 22, available: 5 }, { platform: "ozon", sku_key: 33, available: 4 }],
    orders: [{ platform: "wb", sku_key: 11, qty: 14 }, { platform: "ozon", sku_key: 22, qty: 7 }],
    inTransit: [{ ff_inventory_id: 1, qty: 3, platform: "wb" }, { ff_inventory_id: 1, qty: 6, platform: "ozon" }],
    ...opts,
  };
  const wb = buildPurchaseNeed({ ...inp, platform: "wb" });
  assert.equal(wb.rows.length, 1);
  assert.deepEqual(wb.rows[0].skus, { wb: [11], ozon: [] });
  assert.equal(wb.rows[0].mpQty, 20);
  assert.equal(wb.rows[0].ownQty, 10);
  assert.equal(wb.rows[0].transitQty, 5);
  assert.equal(wb.rows[0].ordersQty, 14);
  const oz = buildPurchaseNeed({ ...inp, platform: "ozon" });
  assert.equal(oz.rows.length, 2);
  assert.equal(oz.rows.find((r) => r.skus.ozon[0] === 22).transitQty, 6);
  assert.equal(buildPurchaseNeed(inp).rows.length, 2);
});
