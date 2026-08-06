// lib/session.js — iron-session v8 для Next.js App Router.
// Паттерн (issue #594): getIronSession(cookies(), options) через cookies() из
// next/headers. Работает И в route handlers, И в серверных компонентах — единая
// точка. session.save() пишет Set-Cookie в cookies()-store корректно.
import { getIronSession, unsealData } from 'iron-session';
import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'saas_session';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 дней

export function sessionOptions() {
  return {
    password: process.env.SAAS_SESSION_SECRET,
    cookieName: SESSION_COOKIE,
    // ttl seal'а должен совпадать с maxAge куки — иначе iron-session печёт seal
    // со своим дефолтным ttl 14 дней, и украденная (или пережившая куку) сессия
    // остаётся валидной дольше заявленных 7 дней.
    ttl: MAX_AGE,
    cookieOptions: {
      httpOnly: true,
      // Secure включается только при SAAS_HTTPS=1 (prod за https/Funnel).
      // По http (локальный/dev) Secure-cookie отбрасываются — сессия не работала бы.
      secure: process.env.SAAS_HTTPS === '1',
      sameSite: 'lax',
      maxAge: MAX_AGE,
      path: '/',
    },
  };
}

// Единый геттер для route handlers И серверных компонентов.
// Использование:
//   const session = await getSession();
//   session.user_id = 1; await session.save();
export async function getSession() {
  return getIronSession(cookies(), sessionOptions());
}

// Продление сессии при активности: кука переиздаётся не чаще раза в сутки,
// иначе Set-Cookie шёл бы на каждый запрос. Вызывать ТОЛЬКО из route handlers —
// в серверных компонентах запись cookies запрещена (Next 14).
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

export async function touchSession(session) {
  if (!session?.user_id) return;
  const now = Date.now();
  if (session.touched_at && now - session.touched_at < TOUCH_AFTER_MS) return;
  session.touched_at = now;
  // Продление — не критичная операция: сбой записи куки не должен ронять
  // запрос, ради которого пользователь пришёл.
  try {
    await session.save();
  } catch (e) {
    console.error('[touchSession]', e.message);
  }
}

// Сессия + сверка версии: смена/сброс пароля увеличивает session_version в БД,
// и все ранее выданные куки перестают работать. Возвращает сессию или null.
// Старые куки без поля sv считаем первой версией (до фазы 3 счётчика не было).
export async function getLiveSession() {
  const session = await getSession();
  if (!session?.user_id) return null;
  const { query } = await import('./db.js');
  const rows = await query('SELECT session_version FROM auth.users WHERE user_id = $1', [session.user_id]);
  if (!rows.length) return null;
  if ((session.sv || 1) !== rows[0].session_version) return null;
  return session;
}

// Middleware (Edge): cookies() из next/headers недоступен в Edge runtime,
// поэтому распаковываем sealed-сессию из cookie-заголовка вручную.
export async function readSessionFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  try {
    // ttl: MAX_AGE — тот же контракт, что и у getIronSession в getSession()
    // (см. sessionOptions()): без него unsealData принимает seal до 14 дней.
    const data = await unsealData(decodeURIComponent(match[1]), {
      password: process.env.SAAS_SESSION_SECRET,
      ttl: MAX_AGE,
    });
    return data || null;
  } catch {
    return null;
  }
}
