// POST /api/auth/register { email, password, name } → создаёт юзера, логинит.
import { NextResponse } from 'next/server';
import { registerUser } from '@/lib/auth.js';
import { getSession } from '@/lib/session.js';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  try {
    // 🔒 Invite-only: если задан SAAS_INVITE_CODE, регистрация только с правильным кодом.
    // Владелец получает код — чужие не могут зарегистрироваться. Пустой код = открыто.
    const inviteCode = process.env.SAAS_INVITE_CODE;
    if (inviteCode && body.invite_code !== inviteCode) {
      return NextResponse.json({ error: 'Неверный invite-код. Регистрация по приглашению.' }, { status: 403 });
    }
    const { user } = await registerUser(body);
    const session = await getSession();
    session.user_id = user.user_id;
    session.email = user.email;
    session.name = user.name;
    session.active_cabinet_id = null;
    await session.save();
    return NextResponse.json({ ok: true, user, next: '/onboarding' });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
