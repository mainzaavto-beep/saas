#!/usr/bin/env node
// scripts/billing-reconcile.mjs — страховка от потерянных уведомлений.
// Раз в час перезапрашивает у ЮKassa все платежи, висящие в pending, и
// дозачисляет оплаченные; висящие дольше суток помечает canceled.
// Клиент заплатил — доступ обязан открыться, даже если вебхук не дошёл.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { query } = await import('../lib/db.js');
const { creditPayment } = await import('../lib/billing-credit.js');

const pending = await query(
  `SELECT payment_id, created_at FROM billing.payments
    WHERE status = 'pending' AND created_at > now() - interval '3 days'
    ORDER BY created_at`
);
let credited = 0, failed = 0;
for (const p of pending) {
  try {
    const res = await creditPayment(p.payment_id);
    if (res.ok && !res.already) { credited++; console.log('[reconcile] зачислен', p.payment_id); }
  } catch (e) {
    failed++;
    console.error('[reconcile] ошибка', p.payment_id, e.message);
  }
}
const stale = await query(
  `UPDATE billing.payments SET status = 'canceled', updated_at = now()
    WHERE status = 'pending' AND created_at < now() - interval '1 day'
    RETURNING payment_id`
);
console.log(`[reconcile] проверено ${pending.length}, зачислено ${credited}, отменено ${stale.length}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
