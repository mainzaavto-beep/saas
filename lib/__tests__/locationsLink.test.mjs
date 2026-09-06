// lib/__tests__/locationsLink.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocationUpdate } from "../locationsLink.js";

test("привязка складов и город", () => {
  const r = normalizeLocationUpdate({ wb_warehouse_id: "123", ozon_warehouse_id: null, city: " Казань " });
  assert.deepEqual(r, { ok: true, sets: ["wb_warehouse_id = $1", "ozon_warehouse_id = $2", "city = $3"], vals: [123, null, "Казань"] });
});

test("is_active и пустой город → null", () => {
  const r = normalizeLocationUpdate({ is_active: false, city: "" });
  assert.deepEqual(r, { ok: true, sets: ["city = $1", "is_active = $2"], vals: [null, false] });
});

test("нет известных полей → ошибка", () => {
  assert.deepEqual(normalizeLocationUpdate({ name: "x" }), { ok: false, error: "nothing to update" });
});

test("нечисловой склад → ошибка", () => {
  assert.deepEqual(normalizeLocationUpdate({ wb_warehouse_id: "abc" }), { ok: false, error: "wb_warehouse_id must be a number or null" });
});
