import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import { cabinetAccess, mismatchPayments } from '@/lib/billing.js';

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

  // Платежи с несошедшейся суммой (запрос — в lib/billing.js, чтобы его можно
  // было проверить тестом без операторской сессии). Пусто в норме.
  const paymentsMismatch = await mismatchPayments();

  // Магазины со сломанными ключами — вместо ежедневных писем о падении воркера.
  const shopsAuth = await query(
    `SELECT s.shop_id, s.cabinet_id, c.display_name, s.mp_code, s.shop_name,
            s.auth_state, s.auth_fail_count, s.auth_failed_at, s.auth_last_error
       FROM auth.shops s
       JOIN auth.cabinets c ON c.cabinet_id = s.cabinet_id
      WHERE s.is_active = true AND s.auth_state <> 'ok'
      ORDER BY s.auth_failed_at DESC NULLS LAST`
  );

  // Кабинет продавца Ozon: сессия истекла (auth.shops.cabinet_state, worker/cabinet_state.py) —
  // позиции по запросам и трафик из кабинета не обновляются.
  const cabinetsExpired = await query(
    `SELECT s.shop_id, s.cabinet_id, c.display_name, s.shop_name, s.cabinet_failed_at, s.cabinet_last_error
       FROM auth.shops s JOIN auth.cabinets c ON c.cabinet_id = s.cabinet_id
      WHERE s.is_active = true AND s.cabinet_state = 'expired'`
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
    shops_auth: shopsAuth,
    cabinets_expired: cabinetsExpired,
  });
}
