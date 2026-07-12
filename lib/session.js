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

// Middleware (Edge): cookies() из next/headers недоступен в Edge runtime,
// поэтому распаковываем sealed-сессию из cookie-заголовка вручную.
export async function readSessionFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  try {
    const data = await unsealData(decodeURIComponent(match[1]), {
      password: process.env.SAAS_SESSION_SECRET,
    });
    return data || null;
  } catch {
    return null;
  }
}
