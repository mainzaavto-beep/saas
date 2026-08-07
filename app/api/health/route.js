import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import { cabinetAccess } from '@/lib/billing.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Операторский allowlist (спек п.6): jobs.collector_runs без RLS, поэтому доступ
// только явно перечисленным user_id (SAAS_OPS_USER_IDS="1,2" в .env.local).
function isOps(userId) {
  const ids = (process.env.SAAS_OPS_USER_IDS || '')
    .split(',').map((s) => Number(s.trim())).filter(Boolean);
  return ids.includes(Number(userId));
}

export async function GET() {
  const session = await getSession();
  if (!session?.user_id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isOps(session.user_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const days = 14;
  const runs = await query(
    `SELECT r.id, r.cabinet_id, c.display_name, r.collector, r.run_kind,
            r.date_from, r.date_to, r.status, r.error, r.started_at, r.finished_at
     FROM jobs.collector_runs r
     LEFT JOIN auth.cabinets c ON c.cabinet_id = r.cabinet_id
     WHERE r.started_at >= now() - make_interval(days => $1)
     ORDER BY r.started_at DESC`,
    [days]
  );

  // Подписки — только владельцу сервиса (allowlist уже проверен выше).
  const billing = await query(
    `SELECT c.cabinet_id, c.display_name, c.trial_ends_at, c.paid_until,
            p.created_at AS last_payment_at, p.amount_rub AS last_payment_amount
       FROM auth.cabinets c
       LEFT JOIN LATERAL (
         SELECT created_at, amount_rub FROM billing.payments
          WHERE cabinet_id = c.cabinet_id AND status = 'succeeded'
          ORDER BY created_at DESC LIMIT 1
       ) p ON true
      WHERE c.status <> 'deleted'
      ORDER BY c.cabinet_id`
  );

  // Платежи, где сумма провайдера разошлась с нашей ценой: деньги не зачислены,
  // нужен ручной разбор. Пусто в норме — если непусто, это видно сразу.
  const paymentsMismatch = await query(
    `SELECT p.payment_id, p.cabinet_id, c.display_name, p.amount_rub, p.raw->'mismatch' AS mismatch, p.created_at
       FROM billing.payments p
       JOIN auth.cabinets c ON c.cabinet_id = p.cabinet_id
      WHERE p.status = 'mismatch'
      ORDER BY p.created_at DESC LIMIT 50`
  );

  return NextResponse.json({
    days,
    runs,
    billing: billing.map((b) => ({
      cabinet_id: b.cabinet_id,
      display_name: b.display_name,
      state: cabinetAccess(b).state,
      until: cabinetAccess(b).until,
      last_payment_at: b.last_payment_at,
      last_payment_amount: b.last_payment_amount,
    })),
    payments_mismatch: paymentsMismatch,
  });
}
