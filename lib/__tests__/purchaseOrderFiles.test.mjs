// lib/__tests__/purchaseOrderFiles.test.mjs — документы заказа закупки (накладные карго/фабрик): правила файла
// и гард «только владелец» (решение владельца 30.10.2026: менеджеры не видят ни файлы, ни контакт поставщика).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateFileMeta, contentDisposition, MAX_FILE_BYTES, stripOwnerOnly } from "../purchaseOrderFiles.js";

test("валидный PDF карго", () => {
  const v = validateFileMeta({ name: "Накладная карго.PDF", size: 1000, kind: "cargo" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { file_name: "Накладная карго.PDF", mime: "application/pdf", kind: "cargo", inline: true });
});

test("тип берётся по расширению, не по присланному mime", () => {
  assert.equal(validateFileMeta({ name: "a.xlsx", size: 5, kind: "factory" }).value.mime,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(validateFileMeta({ name: "a.xlsx", size: 5, kind: "factory" }).value.inline, false);
  assert.equal(validateFileMeta({ name: "фото.jpeg", size: 5, kind: "other" }).value.mime, "image/jpeg");
});

test("запрещённые типы и html/svg — отказ", () => {
  for (const name of ["x.html", "x.svg", "x.exe", "x", "x.js"]) {
    assert.equal(validateFileMeta({ name, size: 5, kind: "cargo" }).ok, false, name);
  }
});

test("размер: 0 и больше 10 МБ — отказ, ровно 10 МБ — можно", () => {
  assert.equal(validateFileMeta({ name: "a.pdf", size: 0, kind: "cargo" }).ok, false);
  assert.equal(validateFileMeta({ name: "a.pdf", size: MAX_FILE_BYTES + 1, kind: "cargo" }).ok, false);
  assert.equal(validateFileMeta({ name: "a.pdf", size: MAX_FILE_BYTES, kind: "cargo" }).ok, true);
});

test("тип документа только cargo/factory/other", () => {
  assert.equal(validateFileMeta({ name: "a.pdf", size: 1, kind: "x" }).ok, false);
});

test("имя файла: путь и управляющие символы вырезаются", () => {
  assert.equal(validateFileMeta({ name: "C:\\tmp\\../evil\r\n.pdf", size: 1, kind: "cargo" }).value.file_name, "evil.pdf");
});

test("Content-Disposition: кириллица через filename*, ascii-запасной без кавычек", () => {
  const h = contentDisposition("Накладная \"1\".pdf", false);
  assert.match(h, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  assert.ok(h.includes(encodeURIComponent("Накладная")));
  assert.match(contentDisposition("a.pdf", true), /^inline;/);
});

test("stripOwnerOnly: не владельцу контакт поставщика не отдаётся", () => {
  const o = { supplier: "Фабрика", supplier_contact: "wechat 123" };
  assert.equal(stripOwnerOnly(o, "manager").supplier_contact, undefined);
  assert.equal(stripOwnerOnly(o, "viewer").supplier_contact, undefined);
  assert.equal(stripOwnerOnly(o, "owner").supplier_contact, "wechat 123");
  assert.equal(o.supplier_contact, "wechat 123", "исходный объект не мутируется");
});

const ROUTE = new URL("../../app/api/cabinets/[id]/purchase-orders/files/route.js", import.meta.url);
test("роут файлов: каждый метод — requireRole 'owner'", () => {
  const src = readFileSync(ROUTE, "utf8");
  const methods = [...src.matchAll(/export const (GET|POST|PUT|DELETE|PATCH)\s*=/g)].length;
  const guards = [...src.matchAll(/requireRole:\s*['"]owner['"]/g)].length;
  assert.ok(methods > 0);
  assert.equal(guards, methods);
});

test("общий роут заказов: файлы не читает, контакт режет по роли", () => {
  const src = readFileSync(new URL("../../app/api/cabinets/[id]/purchase-orders/route.js", import.meta.url), "utf8");
  assert.ok(!/purchase_order_files/.test(src), "purchase-orders не должен трогать файлы");
  assert.ok(/stripOwnerOnly\(/.test(src), "GET заказа должен резать контакт для не-владельца");
  const data = readFileSync(new URL("../purchaseOrdersData.js", import.meta.url), "utf8");
  assert.ok(!/purchase_order_files/.test(data), "loadOrder/listOrders не должны отдавать файлы");
});
