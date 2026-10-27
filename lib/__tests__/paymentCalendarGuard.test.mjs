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

test("заказы закупки: ДДС пишется только через paymentCalendarData", () => {
  // lib/purchaseOrdersData.js легитимно ЧИТАЕТ tenant.dds_movements (статус оплат, loadOrderView) —
  // для него запрещаем только запись, иначе регексп ложно падает на чтении (см. task-6-brief.md).
  for (const p of ["app/api/cabinets/[id]/purchase-orders/route.js", "app/api/cabinets/[id]/deliveries/route.js"]) {
    const src = read(p);
    assert.doesNotMatch(src, /dds_movements/, `${p} пишет dds_movements напрямую`);
  }
  assert.doesNotMatch(read("lib/purchaseOrdersData.js"), /(INSERT INTO|UPDATE|DELETE FROM)\s+tenant\.dds_movements/,
    "lib/purchaseOrdersData.js пишет dds_movements напрямую");
  assert.match(read("app/api/cabinets/[id]/purchase-orders/route.js"), /syncOrderPayments\(/);
});
