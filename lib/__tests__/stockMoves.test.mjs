// lib/__tests__/stockMoves.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMove, normalizeTransferDoc, SIGN } from "../stockMoves.js";

test("списание получает минус, приход плюс", () => {
  const a = normalizeMove({ ffInventoryId: 5, kind: "out_fbs", qty: 2, srcKind: "wb_fbs_task", srcRef: "rid1" });
  assert.equal(a.ok, true); assert.equal(a.move.qty, -2);
  const b = normalizeMove({ ffInventoryId: 5, kind: "in", qty: 7, srcKind: "purchase", srcRef: "3" });
  assert.equal(b.move.qty, 7);
});

test("adjust требует ненулевое qty и причину", () => {
  assert.deepEqual(normalizeMove({ ffInventoryId: 1, kind: "adjust", qty: 0, srcKind: "manual", srcRef: "x", note: "y" }),
    { ok: false, error: "adjust: qty must be a non-zero integer" });
  assert.deepEqual(normalizeMove({ ffInventoryId: 1, kind: "adjust", qty: -3, srcKind: "manual", srcRef: "x" }),
    { ok: false, error: "adjust: note required" });
  const ok = normalizeMove({ ffInventoryId: 1, kind: "adjust", qty: -3, srcKind: "manual", srcRef: "x", note: "инвентаризация" });
  assert.equal(ok.ok, true); assert.equal(ok.move.qty, -3);
});

test("неизвестный kind/srcKind и дробное qty отклоняются", () => {
  assert.equal(normalizeMove({ ffInventoryId: 1, kind: "sale", qty: 1, srcKind: "manual", srcRef: "x" }).ok, false);
  assert.equal(normalizeMove({ ffInventoryId: 1, kind: "in", qty: 1, srcKind: "csv", srcRef: "x" }).ok, false);
  assert.equal(normalizeMove({ ffInventoryId: 1, kind: "in", qty: 1.5, srcKind: "purchase", srcRef: "x" }).ok, false);
  assert.equal(normalizeMove({ ffInventoryId: 0, kind: "in", qty: 1, srcKind: "purchase", srcRef: "x" }).ok, false);
});

test("movedAt по умолчанию — сейчас, ISO", () => {
  const m = normalizeMove({ ffInventoryId: 1, kind: "in", qty: 1, srcKind: "purchase", srcRef: "x" }).move;
  assert.match(m.movedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(SIGN.adjust, 0);
});

test("normalizeTransferDoc: разные места, строки без дублей", () => {
  const bad = normalizeTransferDoc({ from_location_id: 5, to_location_id: 5, lines: [{ ff_inventory_id: 1, qty: 1 }] });
  assert.deepEqual(bad, { ok: false, error: "from and to locations must differ" });
  const dup = normalizeTransferDoc({ from_location_id: 5, to_location_id: 6, lines: [{ ff_inventory_id: 1, qty: 1 }, { ff_inventory_id: "1", qty: 2 }] });
  assert.deepEqual(dup, { ok: false, error: "позиция id=1 повторяется в составе" });
  const ok = normalizeTransferDoc({ from_location_id: "5", to_location_id: 6, moved_at: "2026-09-06", note: " x ", lines: [{ ff_inventory_id: 1, qty: "3" }] });
  assert.deepEqual(ok, { ok: true, doc: { fromLocationId: 5, toLocationId: 6, movedAt: "2026-09-06", note: "x", lines: [{ ffInventoryId: 1, qty: 3 }] } });
  assert.equal(normalizeTransferDoc({ from_location_id: 5, to_location_id: 6, lines: [] }).ok, false);
});
