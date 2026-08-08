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
import { hit, refund, LIMITS } from '@/lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOUR_MS = 60 * 60_000;

export async function PUT(req) {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Два счётчика, оба списываются здесь же — синхронно, без единого await
  // между проверкой и инкрементом (сам hit() атомарен: читает и увеличивает
  // count одним вызовом). Гонка невозможна по построению: даже N
  // параллельных запросов увидят инкременты друг друга, а не одно и то же
  // старое значение (в отличие от связки peek()+hit() с await между ними,
  // которая тут стояла раньше — см. фикс-раунд 2 в отчёте).
  //
  // changeKey (LIMITS.emailChangeUser, 3/час) — лимит на РЕАЛЬНО успешные
  // смены. Ниже, если попытка сорвётся (400/404/409/неожиданная ошибка),
  // списанное возвращаем через refund() — клиента не наказываем за то, что
  // он всего лишь перебирает свои старые адреса, часть из которых заняты
  // (см. фикс-раунд 1: без refund единственный путь починить опечатку мог
  // запереться на час).
  //
  // attemptKey (LIMITS.emailAttemptUser, 30/час) — лимит на ЛЮБЫЕ попытки,
  // включая те, что потом вернутся через refund. Специально БЕЗ refund:
  // иначе changeKey с его refund-механикой сам по себе ничего не ограничивает
  // в ветке 409 «занято» — она возвращала бы себе бюджет каждый раз, и
  // авторизованный пользователь получил бы бесплатный оракул «угадай чужой
  // email»: любой email, любое число раз, единственная утечка информации —
  // код ответа. attemptKey это перекрывает отдельным, более щедрым лимитом.
  const changeKey = `email-change:user:${session.user_id}`;
  const attemptKey = `email-attempt:user:${session.user_id}`;

  const attemptRl = hit(attemptKey, LIMITS.emailAttemptUser, HOUR_MS);
  if (attemptRl.limited) {
    return NextResponse.json({ error: 'Слишком много попыток. Попробуйте позже.' }, { status: 429 });
  }
  const changeRl = hit(changeKey, LIMITS.emailChangeUser, HOUR_MS);
  if (changeRl.limited) {
    return NextResponse.json({ error: 'Слишком много попыток смены адреса. Попробуйте позже.' }, { status: 429 });
  }

  const b = await req.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  if (!email.includes('@') || email.length < 5) {
    refund(changeKey);
    return NextResponse.json({ error: 'Проверьте адрес — он выглядит неверным.' }, { status: 400 });
  }

  const cur = await query(`SELECT email, email_verified_at FROM auth.users WHERE user_id = $1`, [session.user_id]);
  if (!cur.length) {
    refund(changeKey);
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (cur[0].email_verified_at) {
    refund(changeKey);
    return NextResponse.json({ error: 'Адрес уже подтверждён — сменить его здесь нельзя.' }, { status: 409 });
  }

  try {
    await query(`UPDATE auth.users SET email = $1 WHERE user_id = $2`, [email, session.user_id]);
  } catch (e) {
    // Занятость адреса ловим уникальным индексом lower(email) — отдельного SELECT
    // нет намеренно: он давал бы разное время ответа для занятых и свободных
    // адресов, то есть способ перебирать чужие адреса.
    refund(changeKey);
    if (e.code === '23505') {
      return NextResponse.json({ error: 'Этот адрес уже используется.' }, { status: 409 });
    }
    throw e;
  }

  // Смена реально состоялась — changeKey остаётся списанным (не возвращаем).
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
