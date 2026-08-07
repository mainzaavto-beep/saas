// GET /api/cabinets/[id]/billing — состояние подписки, тарифы, история платежей.
// Доступен всем участникам кабинета и работает при блокировке (allowLocked).
import { NextResponse } from 'next/server';
import { withCabinet } from '@/lib/withCabinet.js';
import { query } from '@/lib/db.js';
import { cabinetAccess, activePlans } from '@/lib/billing.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withCabinet(async (req, { cabinet }) => {
  const access = cabinetAccess(cabinet);
  const [plans, payments] = await Promise.all([
    activePlans(),
    query(
      `SELECT payment_id, plan_code, months, amount_rub, status, created_at, paid_until_after
         FROM billing.payments WHERE cabinet_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [cabinet.cabinet_id]
    ),
  ]);
  return NextResponse.json({
    state: access.state,
    until: access.until,
    days_left: access.daysLeft,
    grace_until: access.graceUntil,
    can_pay: cabinet.role === 'owner',
    plans,
    payments,
  });
}, { allowLocked: true });
