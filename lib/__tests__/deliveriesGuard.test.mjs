// lib/__tests__/deliveriesGuard.test.mjs — «✓ Доставлено» — конечная точка (спека 2026-10-15 §2.3):
// complete_to_stock больше не пишет в остатки склада/ФФ и журнал движений.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../app/api/cabinets/[id]/purchases/route.js", import.meta.url), "utf8");

function block(action) {
  const start = src.indexOf(`b.action === "${action}"`);
  assert.ok(start > 0, `нет блока ${action}`);
  // блок заканчивается на первом «return NextResponse.json({ ok: true» после начала
  const end = src.indexOf("return NextResponse.json({ ok: true", start);
  assert.ok(end > start, "нет успешного ответа в блоке");
  return src.slice(start, end);
}

test("complete_to_stock не трогает ff_inventory / ff_inventory_skus / applyMove", () => {
  const b = block("complete_to_stock");
  assert.ok(!/ff_inventory/.test(b), "блок пишет в ff_inventory");
  assert.ok(!/applyMove/.test(b), "блок вызывает applyMove");
  assert.ok(/delivered_at/.test(b), "блок не ставит delivered_at");
  assert.ok(/archived\s*=\s*true/.test(b), "блок не архивирует партию");
});
