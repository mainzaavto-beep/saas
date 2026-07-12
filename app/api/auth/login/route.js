// POST /api/auth/login { email, password } → логин, возвращает куда идти дальше.
import { NextResponse } from 'next/server';
import { loginUser, firstCabinetOf } from '@/lib/auth.js';
import { getSession } from '@/lib/session.js';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  try {
    const result = await loginUser(body);
    if (!result) {
      return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 });
    }
    const { user } = result;
    const cabinet = await firstCabinetOf(user.user_id);
    const session = await getSession();
    session.user_id = user.user_id;
    session.email = user.email;
    session.name = user.name;
    session.active_cabinet_id = cabinet ? cabinet.cabinet_id : null;
    await session.save();
    return NextResponse.json({
      ok: true, user,
      active_cabinet_id: session.active_cabinet_id,
      next: cabinet ? '/' : '/onboarding',
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
