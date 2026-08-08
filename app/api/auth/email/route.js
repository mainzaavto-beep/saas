// PUT /api/auth/email — сменить адрес, пока он не подтверждён, и выслать письмо.
//
// Обязательный аварийный выход: подтверждение закрывает и ключи, и приглашения,
// и оплату, поэтому опечатка в адресе иначе превращается в тупик — подтвердить
// нельзя, проект завести нельзя, а войти можно.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import { createToken } from '@/lib/tokens.js';
import { sendMail } from '@/lib/mailer.js';
import { hit, LIMITS } from '@/lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOUR_MS = 60 * 60_000;

export async function PUT(req) {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Окно — час, задаём явно третьим аргументом hit(): гранулярность ключа
  // сама по себе окно не определяет (см. lib/rate-limit.js).
  const rl = hit(`email-change:user:${session.user_id}`, LIMITS.emailChangeUser, HOUR_MS);
  if (rl.limited) {
    return NextResponse.json({ error: 'Слишком много попыток смены адреса. Попробуйте позже.' }, { status: 429 });
  }

  const b = await req.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  if (!email.includes('@') || email.length < 5) {
    return NextResponse.json({ error: 'Проверьте адрес — он выглядит неверным.' }, { status: 400 });
  }

  const cur = await query(`SELECT email, email_verified_at FROM auth.users WHERE user_id = $1`, [session.user_id]);
  if (!cur.length) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (cur[0].email_verified_at) {
    return NextResponse.json({ error: 'Адрес уже подтверждён — сменить его здесь нельзя.' }, { status: 409 });
  }

  try {
    await query(`UPDATE auth.users SET email = $1 WHERE user_id = $2`, [email, session.user_id]);
  } catch (e) {
    // Занятость адреса ловим уникальным индексом lower(email) — отдельного SELECT
    // нет намеренно: он давал бы разное время ответа для занятых и свободных
    // адресов, то есть способ перебирать чужие адреса.
    if (e.code === '23505') {
      return NextResponse.json({ error: 'Этот адрес уже используется.' }, { status: 409 });
    }
    throw e;
  }

  session.email = email;
  await session.save();

  const token = await createToken(session.user_id, 'verify_email');
  const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
  const res = await sendMail({
    to: email,
    subject: 'Подтвердите почту в SySell',
    text: `Подтвердите адрес:\n${base}/verify?token=${token}\n\nСсылка действует 7 дней.`,
  });
  if (!res.ok) {
    return NextResponse.json({ error: 'Адрес изменён, но письмо не ушло. Нажмите «Выслать ещё раз».' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, email });
}
