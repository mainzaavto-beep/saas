// lib/__tests__/deliveriesGuard.test.mjs — «✓ Доставлено» — конечная точка (спека 2026-10-15 §2.3):
// complete_to_stock больше не пишет в остатки склада/ФФ и журнал движений.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../app/api/cabinets/[id]/purchases/route.js", import.meta.url), "utf8");

test("старые партии — архив: POST и DELETE роута purchases отвечают 410 и ничего не пишут", () => {
  assert.match(src, /status:\s*410/);
  assert.doesNotMatch(src, /INSERT INTO tenant\.purchases|UPDATE tenant\.purchases|ff_inventory|applyMove/);
});
