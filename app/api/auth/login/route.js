// POST /api/auth/login { email, password } → логин, возвращает куда идти дальше.
import { NextResponse } from 'next/server';
import { loginUser, firstCabinetOf } from '@/lib/auth.js';
import { getSession } from '@/lib/session.js';
import { clientIp, peek, hit, reset, LIMITS } from '@/lib/rate-limit.js';

const tooMany = (retryAfter) => NextResponse.json(
  { error: 'Слишком много попыток входа. Попробуйте через минуту.' },
  { status: 429, headers: { 'Retry-After': String(retryAfter || 60) } }
);

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }

  const email = String(body?.email || '').trim().toLowerCase();
  const ip = clientIp(req);
  const acctKey = `login:acct:${email}`;
  const ipKey = `login:ip:${ip}`;

  // Считаем только НЕУДАЧНЫЕ попытки: успешный вход лимит не расходует,
  // иначе рабочий день в общем офисе (один внешний IP) упирался бы в потолок.
  const acct = peek(acctKey, LIMITS.loginAccount);
  if (acct.limited) return tooMany(acct.retryAfter);
  const byIp = peek(ipKey, LIMITS.loginIp);
  if (byIp.limited) return tooMany(byIp.retryAfter);

  try {
    const result = await loginUser({ email, password: body?.password });
    if (!result) {
      hit(acctKey, LIMITS.loginAccount);
      hit(ipKey, LIMITS.loginIp);
      console.warn('[login] неудачная попытка', email, 'ip', ip);
      return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 });
    }
    const { user } = result;
    reset(acctKey);
    const cabinet = await firstCabinetOf(user.user_id);
    const session = await getSession();
    session.user_id = user.user_id;
    session.email = user.email;
    session.name = user.name;
    session.active_cabinet_id = cabinet ? cabinet.cabinet_id : null;
    session.touched_at = Date.now();
    await session.save();
    return NextResponse.json({
      ok: true, user,
      active_cabinet_id: session.active_cabinet_id,
      next: cabinet ? '/' : '/onboarding',
    });
  } catch (e) {
    // Заблокированный аккаунт (status != active) — тот же ответ, что и неверный
    // пароль: разный текст позволял бы перебирать существующие аккаунты.
    hit(acctKey, LIMITS.loginAccount);
    hit(ipKey, LIMITS.loginIp);
    console.warn('[login]', e.message, email, 'ip', ip);
    return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 });
  }
}
