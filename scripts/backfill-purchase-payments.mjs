#!/usr/bin/env node
// scripts/backfill-purchase-payments.mjs — разовая раскладка платежей по существующим партиям
// (платёжный календарь, 15.10.2026). Идемпотентно (upsert по source_ref). Только кабинет #1, если
// владелец не разрешил иное. Запуск: node scripts/backfill-purchase-payments.mjs 1
import { readFileSync } from 'node:fs';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { withTenant, tenantQuery } = await import('../lib/db.js');
const { syncPurchasePayments } = await import('../lib/paymentCalendarData.js');
const CAB = Number(process.argv[2]);
if (CAB !== 1) { console.error('только кабинет #1'); process.exit(2); }
const res = await withTenant(CAB, async () => {
  const ids = (await tenantQuery(`SELECT id FROM tenant.purchases WHERE deleted_at IS NULL ORDER BY id`)).map((r) => Number(r.id));
  let up = 0;
  for (const id of ids) up += (await syncPurchasePayments(id)).upserted;
  return { purchases: ids.length, upserted: up };
});
console.log(res);
process.exit(0);
