// POST /api/cabinets/[id]/billing/pay { plan_code } — создать платёж.
// 🔒 Сумму берём ТОЛЬКО из billing.plans: цена из тела запроса игнорируется.
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { withCabinet } from '@/lib/withCabinet.js';
import { getSession } from '@/lib/session.js';
import { query, getPool } from '@/lib/db.js';
import { planByCode } from '@/lib/billing.js';
import { createPayment, isConfigured } from '@/lib/yookassa.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Пространство advisory-блокировок биллинга: двухаргументная форма, чтобы не
// пересечься с блокировкой онбординга (она берёт одноаргументную от user_id).
const LOCK_NS = 823001;

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

  const client = await getPool().connect();
  let locked = false;
  try {
    // Сериализуем создание платежей по кабинету: без этого два одновременных
    // клика уходят к провайдеру двумя платежами. Ждём блокировку ограниченное
    // время (lock_timeout), чтобы параллельный клик получил понятный ответ,
    // а не висел, пока провайдер молчит.
    //
    // lock_timeout ставим через SET LOCAL внутри транзакции: сервер откатывает
    // его сам при COMMIT/ROLLBACK, и соединение возвращается в пул чистым при
    // любом исходе (обычный SET — сессионный и заражал бы пул). Сессионная
    // advisory-блокировка при этом переживает COMMIT и держится до
    // pg_advisory_unlock в finally.
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '20s'");
      await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NS, cabinet.cabinet_id]);
      locked = true;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '55P03') { // lock_not_available: не дождались за lock_timeout
        console.warn('[billing/pay] не дождались блокировки', cabinet.cabinet_id, e.message);
        return NextResponse.json({ error: 'Платёж по этому проекту уже создаётся. Обновите страницу через минуту.' }, { status: 409 });
      }
      console.error('[billing/pay] сбой захвата блокировки', cabinet.cabinet_id, e);
      return NextResponse.json({ error: 'Внутренняя ошибка, попробуйте позже' }, { status: 500 });
    }

    // Свежий неоплаченный платёж по тому же тарифу переиспользуем.
    const fresh = await client.query(
      `SELECT payment_id, raw FROM billing.payments
        WHERE cabinet_id = $1 AND plan_code = $2 AND status = 'pending'
          AND created_at > now() - interval '15 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [cabinet.cabinet_id, plan.code]
    );
    const freshUrl = fresh.rows[0]?.raw?.confirmation_url;
    if (freshUrl) {
      return NextResponse.json({ payment_id: fresh.rows[0].payment_id, confirmation_url: freshUrl });
    }

    // Строка журнала пишется отдельным соединением и коммитится сразу: платёж,
    // созданный у провайдера без записи у нас, — расхождение при сверке.
    const localKey = crypto.randomUUID();
    const localId = `local-${localKey}`;
    await client.query(
      `INSERT INTO billing.payments (payment_id, cabinet_id, user_id, plan_code, months, amount_rub, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [localId, cabinet.cabinet_id, session.user_id, plan.code, plan.months, plan.price_rub]
    );

    // ЮKassa ограничивает описание платежа 128 символами: длинное название
    // проекта иначе делает оплату невозможной.
    const description = `Подписка SySell, ${plan.months} мес., проект «${cabinet.display_name}»`.slice(0, 128);

    let payment;
    try {
      payment = await createPayment({
        amountRub: plan.price_rub,
        description,
        returnUrl: `${base}/cabinets/${cabinet.cabinet_id}/billing?paid=1`,
        idempotenceKey: localKey,
        customerEmail: users[0]?.email,
      });
    } catch (e) {
      console.error('[billing/pay]', e.message);
      await client.query(
        `UPDATE billing.payments SET status = 'canceled', updated_at = now(),
                raw = coalesce(raw,'{}'::jsonb) || $2::jsonb
          WHERE payment_id = $1`,
        [localId, JSON.stringify({ error: e.message })]
      ).catch(() => {});
      return NextResponse.json({ error: 'Не удалось создать платёж, попробуйте позже' }, { status: 502 });
    }

    // Подменяем временный идентификатор на выданный провайдером. Если этот шаг
    // не пройдёт — вебхук не найдёт строку, поэтому логируем оба идентификатора.
    try {
      await client.query(
        `UPDATE billing.payments
            SET payment_id = $2, updated_at = now(),
                raw = coalesce(raw,'{}'::jsonb) || $3::jsonb
          WHERE payment_id = $1`,
        [localId, payment.id, JSON.stringify({ created: payment, confirmation_url: payment.confirmation_url })]
      );
    } catch (e) {
      console.error('[billing/pay] не удалось записать id платежа', localId, '→', payment.id, e.message);
      return NextResponse.json({ error: 'Платёж создан, но не сохранён. Напишите в поддержку.' }, { status: 500 });
    }

    return NextResponse.json({ payment_id: payment.id, confirmation_url: payment.confirmation_url });
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NS, cabinet.cabinet_id]).catch(() => {});
    }
    client.release();
  }
}, { requireRole: 'owner', requireVerifiedEmail: true, allowLocked: true });
