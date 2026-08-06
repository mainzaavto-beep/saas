// POST /api/auth/verify/resend — выслать письмо с подтверждением заново.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { createToken } from '@/lib/tokens.js';
import { sendMail } from '@/lib/mailer.js';
import { query } from '@/lib/db.js';
import { hit } from '@/lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Не чаще раза в минуту на пользователя — письма стоят денег и репутации домена.
  const rl = hit(`verify-resend:user:${session.user_id}`, 1);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Письмо уже отправлено. Проверьте почту и попробуйте через минуту.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
    );
  }

  const rows = await query(`SELECT email, email_verified_at FROM auth.users WHERE user_id = $1`, [session.user_id]);
  if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (rows[0].email_verified_at) return NextResponse.json({ ok: true, already: true });

  const token = await createToken(session.user_id, 'verify_email');
  const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
  const res = await sendMail({
    to: rows[0].email,
    subject: 'Подтвердите почту в SySell',
    text: `Подтвердите адрес:\n${base}/verify?token=${token}\n\nСсылка действует 7 дней.`,
  });
  if (!res.ok) {
    return NextResponse.json({ error: 'Не удалось отправить письмо, попробуйте позже.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
