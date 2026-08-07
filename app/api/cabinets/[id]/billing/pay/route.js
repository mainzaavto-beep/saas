// POST /api/cabinets/[id]/billing/pay { plan_code } — создать платёж.
// 🔒 Сумму берём ТОЛЬКО из billing.plans: цена из тела запроса игнорируется.
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { withCabinet } from '@/lib/withCabinet.js';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import { planByCode } from '@/lib/billing.js';
import { createPayment, isConfigured } from '@/lib/yookassa.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withCabinet(async (req, { cabinet }) => {
  if (!isConfigured()) {
    return NextResponse.json({ error: 'Приём оплаты не настроен. Напишите в поддержку.' }, { status: 503 });
  }
  const session = await getSession();
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }

  const plan = await planByCode(body?.plan_code);
  if (!plan) return NextResponse.json({ error: 'Тариф не найден' }, { status: 400 });

  const users = await query(`SELECT email FROM auth.users WHERE user_id = $1`, [session.user_id]);
  const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
  const idempotenceKey = crypto.randomUUID();

  let payment;
  try {
    payment = await createPayment({
      amountRub: plan.price_rub,
      description: `Подписка SySell, ${plan.months} мес., проект «${cabinet.display_name}»`,
      returnUrl: `${base}/cabinets/${cabinet.cabinet_id}/billing?paid=1`,
      idempotenceKey,
      customerEmail: users[0]?.email,
    });
  } catch (e) {
    console.error('[billing/pay]', e.message);
    return NextResponse.json({ error: 'Не удалось создать платёж, попробуйте позже' }, { status: 502 });
  }

  await query(
    `INSERT INTO billing.payments (payment_id, cabinet_id, user_id, plan_code, months, amount_rub, status, raw)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [payment.id, cabinet.cabinet_id, session.user_id, plan.code, plan.months, plan.price_rub,
     JSON.stringify({ created: payment })]
  );

  return NextResponse.json({ payment_id: payment.id, confirmation_url: payment.confirmation_url });
}, { requireRole: 'owner', requireVerifiedEmail: true, allowLocked: true });
