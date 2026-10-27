// lib/__tests__/deliveries.test.mjs — «Доставлено на склад» (15.10.2026).
import test from "node:test";
import assert from "node:assert/strict";
import { receiptTotals, receiptStatus, validateLine, buildDeliveries, buildShipmentDeliveries, filterDeliveries } from "../deliveries.js";

test("receiptTotals: заказано / принято / расхождение", () => {
  assert.deepEqual(receiptTotals({ qty: "510" }, [{ qty_accepted: 250 }, { qty_accepted: 255 }]),
    { ordered: 510, accepted: 505, diff: -5 });
  assert.deepEqual(receiptTotals({ qty: null }, []), { ordered: 0, accepted: 0, diff: 0 });
  assert.deepEqual(receiptTotals({ qty: 10 }, [{ qty_accepted: 12 }]), { ordered: 10, accepted: 12, diff: 2 });
});

test("receiptStatus", () => {
  assert.equal(receiptStatus({ receipt_done_at: null }), "waiting");
  assert.equal(receiptStatus({ receipt_done_at: "2026-10-15T10:00:00Z" }), "done");
  assert.equal(receiptStatus({ legacy_at: "2026-10-16" }), "legacy");
  // legacy_at имеет приоритет даже если receipt_done_at заполнен (на практике взаимоисключимы — миграция 071).
  assert.equal(receiptStatus({ legacy_at: "2026-10-16", receipt_done_at: "2026-09-01T00:00:00Z" }), "legacy");
});

test("validateLine: каталог WB", () => {
  const r = validateLine({ platform: "wb", nm_id: "123", label: " Камера ", qty_accepted: "5", note: "" });
  assert.deepEqual(r, { ok: true, line: { platform: "wb", nm_id: 123, product_id: null, label: "Камера", qty_accepted: 5, note: null } });
});

test("validateLine: каталог Ozon и ручной ввод", () => {
  assert.equal(validateLine({ platform: "ozon", product_id: 77, label: "Рег", qty_accepted: 0 }).line.product_id, 77);
  const m = validateLine({ platform: "", label: "сердечко белое S", qty_accepted: 3, note: " брак 1 " });
  assert.deepEqual(m.line, { platform: null, nm_id: null, product_id: null, label: "сердечко белое S", qty_accepted: 3, note: "брак 1" });
});

test("validateLine: ошибки", () => {
  assert.equal(validateLine({ label: "x", qty_accepted: -1 }).ok, false);
  assert.equal(validateLine({ label: "x", qty_accepted: 1.5 }).ok, false);
  assert.equal(validateLine({ label: "x", qty_accepted: "" }).ok, false);
  assert.equal(validateLine({ label: "  ", qty_accepted: 1 }).ok, false);
  assert.equal(validateLine({ platform: "wb", label: "x", qty_accepted: 1 }).ok, false);   // нет nm_id
  assert.equal(validateLine({ platform: "ozon", product_id: 0, label: "x", qty_accepted: 1 }).ok, false);
  assert.equal(validateLine({ platform: "ali", label: "x", qty_accepted: 1 }).ok, false);
  assert.equal(validateLine({ label: "x".repeat(301), qty_accepted: 1 }).ok, false);
});

test("buildDeliveries: группировка строк, итоги, счётчики, фото", () => {
  const purchases = [
    { id: 2, supplier_name: "Сердечко", category: "Бельё", qty: 510, photo_url: null, im_url: "wb.jpg", delivered_at: "2026-10-10", receipt_done_at: null },
    { id: 1, supplier_name: "Камера", category: null, qty: 100, photo_url: "own.jpg", im_url: "wb2.jpg", delivered_at: "2026-10-01", receipt_done_at: "2026-10-05T00:00:00Z" },
  ];
  const lines = [
    { id: 10, purchase_id: 2, qty_accepted: 250, label: "белое" },
    { id: 11, purchase_id: 1, qty_accepted: 100, label: "кам" },
    { id: 12, purchase_id: 2, qty_accepted: 255, label: "чёрное" },
  ];
  const { items, totals } = buildDeliveries(purchases, lines);
  assert.deepEqual(items.map((i) => i.id), [2, 1]);
  assert.deepEqual(items[0].lines.map((l) => l.id), [10, 12]);
  assert.equal(items[0].accepted, 505);
  assert.equal(items[0].diff, -5);
  assert.equal(items[0].status, "waiting");
  assert.equal(items[0].photo, "wb.jpg");
  assert.equal(items[1].photo, "own.jpg");
  assert.equal(items[1].name, "Камера");
  assert.deepEqual(totals, { waiting: 1, done: 1, legacy: 0 });
});

test("buildDeliveries: архив «до 16.10» — status legacy, считается отдельно", () => {
  const purchases = [
    { id: 3, supplier_name: "Старая партия", qty: 50, delivered_at: "2026-06-25", receipt_done_at: null, legacy_at: "2026-10-16" },
    { id: 4, supplier_name: "Новая партия", qty: 20, delivered_at: "2026-10-16", receipt_done_at: null, legacy_at: null },
  ];
  const { items, totals } = buildDeliveries(purchases, []);
  assert.equal(items.find((i) => i.id === 3).status, "legacy");
  assert.equal(items.find((i) => i.id === 4).status, "waiting");
  assert.deepEqual(totals, { waiting: 1, done: 0, legacy: 1 });
});

test("filterDeliveries: статус и поиск по партии и строкам", () => {
  const items = [
    { id: 1, name: "Сердечко", status: "waiting", lines: [{ label: "белое S" }] },
    { id: 2, name: "Камера", status: "done", lines: [] },
  ];
  assert.deepEqual(filterDeliveries(items, { status: "waiting" }).map((i) => i.id), [1]);
  assert.deepEqual(filterDeliveries(items, { status: "all", q: "БЕЛОЕ" }).map((i) => i.id), [1]);
  assert.deepEqual(filterDeliveries(items, { status: "all", q: "кам" }).map((i) => i.id), [2]);
  assert.equal(filterDeliveries(items, {}).length, 2);
});

test("filterDeliveries: архив «до 16.10» скрыт из all/waiting/done, виден только по status=legacy", () => {
  const items = [
    { id: 1, name: "Сердечко", status: "waiting", lines: [] },
    { id: 2, name: "Камера", status: "done", lines: [] },
    { id: 3, name: "Старая партия", status: "legacy", lines: [] },
  ];
  assert.deepEqual(filterDeliveries(items, { status: "all" }).map((i) => i.id), [1, 2]);
  assert.deepEqual(filterDeliveries(items, {}).map((i) => i.id), [1, 2]);
  assert.deepEqual(filterDeliveries(items, { status: "waiting" }).map((i) => i.id), [1]);
  assert.deepEqual(filterDeliveries(items, { status: "done" }).map((i) => i.id), [2]);
  assert.deepEqual(filterDeliveries(items, { status: "legacy" }).map((i) => i.id), [3]);
  assert.deepEqual(filterDeliveries(items, { status: "legacy", q: "старая" }).map((i) => i.id), [3]);
});

test("buildShipmentDeliveries: прибывшая — ждёт, принятая — учтено; принято по умолчанию = отправлено", () => {
  const ships = [
    { id: 5, order_id: 7, order_no: "A-1", supplier: "hanyou", category: "Камеры", shipment_no: "TRK", status: "arrived", arrived_dt: "2026-10-25", accepted_at: null },
    { id: 6, order_id: 7, order_no: "A-1", supplier: "hanyou", category: "Камеры", shipment_no: null, status: "accepted", arrived_dt: "2026-10-26", accepted_at: "2026-10-27" },
  ];
  const lines = [
    { id: 1, shipment_id: 5, line_id: 10, label: "камера", variant: null, qty_shipped: 40, qty_accepted: null, photo: "p.jpg" },
    { id: 2, shipment_id: 6, line_id: 10, label: "камера", variant: null, qty_shipped: 30, qty_accepted: 28, photo: null },
  ];
  const [a, b] = buildShipmentDeliveries(ships, lines);
  assert.equal(a.key, "s5");
  assert.equal(a.status, "waiting");
  assert.equal(a.ordered, 40);
  assert.equal(a.accepted, 40);
  assert.equal(a.photo, "p.jpg");
  assert.match(a.name, /hanyou · A-1 · TRK/);
  assert.equal(b.status, "done");
  assert.equal(b.diff, -2);
});
