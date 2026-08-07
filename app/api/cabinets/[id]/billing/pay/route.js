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

  // 1. Свежий неоплаченный платёж по этому же тарифу переиспользуем: двойной
  //    клик по «Оплатить» не должен плодить платежи у провайдера.
  const fresh = await query(
    `SELECT payment_id, raw FROM billing.payments
      WHERE cabinet_id = $1 AND plan_code = $2 AND status = 'pending'
        AND created_at > now() - interval '15 minutes'
      ORDER BY created_at DESC LIMIT 1`,
    [cabinet.cabinet_id, plan.code]
  );
  const freshUrl = fresh[0]?.raw?.confirmation_url;
  if (freshUrl) {
    return NextResponse.json({ payment_id: fresh[0].payment_id, confirmation_url: freshUrl });
  }

  // 2. Сначала строка в журнале, потом обращение к провайдеру: платёж, которого
  //    нет у нас в базе, — это расхождение при сверке. Временный идентификатор
  //    заменим на настоящий, когда провайдер его вернёт.
  const localKey = crypto.randomUUID();
  const localId = `local-${localKey}`;
  await query(
    `INSERT INTO billing.payments (payment_id, cabinet_id, user_id, plan_code, months, amount_rub, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [localId, cabinet.cabinet_id, session.user_id, plan.code, plan.months, plan.price_rub]
  );

  let payment;
  try {
    payment = await createPayment({
      amountRub: plan.price_rub,
      description: `Подписка SySell, ${plan.months} мес., проект «${cabinet.display_name}»`,
      returnUrl: `${base}/cabinets/${cabinet.cabinet_id}/billing?paid=1`,
      idempotenceKey: localKey,
      customerEmail: users[0]?.email,
    });
  } catch (e) {
    console.error('[billing/pay]', e.message);
    await query(
      `UPDATE billing.payments SET status = 'canceled', updated_at = now(),
              raw = coalesce(raw,'{}'::jsonb) || $2::jsonb
        WHERE payment_id = $1`,
      [localId, JSON.stringify({ error: e.message })]
    ).catch(() => {});
    return NextResponse.json({ error: 'Не удалось создать платёж, попробуйте позже' }, { status: 502 });
  }

  // 3. Подменяем временный идентификатор на выданный провайдером и сохраняем
  //    ссылку — по ней вернёмся при повторном клике.
  await query(
    `UPDATE billing.payments
        SET payment_id = $2, updated_at = now(),
            raw = coalesce(raw,'{}'::jsonb) || $3::jsonb
      WHERE payment_id = $1`,
    [localId, payment.id, JSON.stringify({ created: payment, confirmation_url: payment.confirmation_url })]
  );

  return NextResponse.json({ payment_id: payment.id, confirmation_url: payment.confirmation_url });
}, { requireRole: 'owner', requireVerifiedEmail: true, allowLocked: true });
