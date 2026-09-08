// lib/__tests__/warehousesData.test.mjs — нормализация строк адаптера витрины «Склады 2.0»
// на фикстурах, без БД (спека §5, задача 3).
import test from "node:test";
import assert from "node:assert/strict";
import { normalizePositions } from "../warehousesData.js";

test("normalizePositions: артикулы группируются по позиции, sku_key = nm_id для WB и product_id для Ozon, порядок сохранён", () => {
  const rows = [{ id: 11, internal_name: "A", qty: "10", unit_cost: "100.50", location_id: 1 }, { id: 12, internal_name: "B", qty: 0, unit_cost: null, location_id: null }];
  const skus = [
    { ff_inventory_id: 11, platform: "ozon", nm_id: null, product_id: 222, sku_name: "A-oz", im_url: null },
    { ff_inventory_id: 11, platform: "wb", nm_id: 111, product_id: null, sku_name: "A-wb", im_url: "u" },
  ];
  const out = normalizePositions(rows, skus);
  assert.deepEqual(out[0], { id: 11, internal_name: "A", qty: 10, unit_cost: 100.5, location_id: 1,
    skus: [{ platform: "ozon", sku_key: 222, name: "A-oz", im_url: null }, { platform: "wb", sku_key: 111, name: "A-wb", im_url: "u" }] });
  assert.deepEqual(out[1].skus, []);
  assert.equal(out[1].location_id, null);
});
