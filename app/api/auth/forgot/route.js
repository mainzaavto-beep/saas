// POST /api/auth/forgot { email } — выслать ссылку для сброса пароля.
// Ответ одинаков для существующего и несуществующего адреса: иначе форма
// превращается в проверялку «есть ли такой аккаунт».
import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { createToken } from '@/lib/tokens.js';
import { sendMail } from '@/lib/mailer.js';
import { clientIp, hit } from '@/lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OK = { ok: true, message: 'Если такой аккаунт есть, мы отправили письмо со ссылкой.' };

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  const email = String(body?.email || '').trim().toLowerCase();

  const rl = hit(`forgot:ip:${clientIp(req)}`, 10);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Слишком много запросов. Попробуйте через минуту.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
    );
  }

  const rows = await query(
    `SELECT user_id, email FROM auth.users WHERE lower(email) = $1 AND status = 'active'`,
    [email]
  );
  if (rows.length) {
    try {
      const token = await createToken(rows[0].user_id, 'reset_password');
      const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
      await sendMail({
        to: rows[0].email,
        subject: 'Восстановление пароля в SySell',
        text: `Чтобы задать новый пароль, перейдите по ссылке:\n${base}/reset?token=${token}\n\nСсылка действует 1 час и работает один раз. Если вы не запрашивали смену пароля — просто удалите это письмо, пароль останется прежним.`,
      });
    } catch (e) {
      console.error('[forgot]', e.message);
    }
  }
  return NextResponse.json(OK);
}
