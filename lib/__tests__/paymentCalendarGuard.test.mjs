// lib/__tests__/paymentCalendarGuard.test.mjs — гарды платёжного календаря (15.10.2026).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("purchases/route.js: синхронизация платежей без глушения ошибок", () => {
  const src = read("app/api/cabinets/[id]/purchases/route.js");
  assert.match(src, /syncPurchasePayments\(/);
  assert.match(src, /archivePurchasePayments\(/);
  assert.doesNotMatch(src, /catch\s*(\(\w*\))?\s*\{\s*\}/);
});

test("payment-calendar/route.js: нет инлайн-формул выплат", () => {
  const src = read("app/api/cabinets/[id]/payment-calendar/route.js");
  assert.doesNotMatch(src, /ppvz_for_pay|accrued|finance_report|ozon_accruals/);
});

test("старый «План платежей» удалён", () => {
  assert.throws(() => read("lib/calendarCalc.js"));
});
