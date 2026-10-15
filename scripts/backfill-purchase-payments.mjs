#!/usr/bin/env node
// scripts/backfill-purchase-payments.mjs — разовая раскладка платежей по существующим партиям
// (платёжный календарь, 15.10.2026). Идемпотентно (upsert по source_ref). Только кабинет #1, если
// владелец не разрешил иное. Запуск: node scripts/backfill-purchase-payments.mjs 1
//
// Fix round 1 (15.10.2026, находка контроллера): у старых партий платежи попадали в прошлое
// со status='planned' → календарь показывал их «просроченными», хотя партия давно оплачена
// (pay_status='paid' в tenant.purchases). ТОЛЬКО В ЭТОМ разовом бэкфилле — после синхронизации
// каждой партии с pay_status='paid' переводим её ещё-planned-платежи в paid. Текущая
// синхронизация в lib/paymentCalendarData.js (syncPurchasePayments) этот статус НЕ учитывает
// (по спеке) — там платёж остаётся planned до ручной отметки в календаре.
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
  const purchases = await tenantQuery(`SELECT id, pay_status FROM tenant.purchases WHERE deleted_at IS NULL ORDER BY id`);
  let up = 0, paid = 0;
  for (const p of purchases) {
    const id = Number(p.id);
    up += (await syncPurchasePayments(id)).upserted;
    if (p.pay_status === 'paid') {
      const r = await tenantQuery(
        `UPDATE tenant.dds_movements SET status = 'paid', paid_at = now(), updated_at = now()
          WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status = 'planned' RETURNING id`,
        [`purchase:${id}:%`]);
      paid += r.length;
    }
  }
  return { purchases: purchases.length, upserted: up, markedPaid: paid };
});
console.log(res);
process.exit(0);
