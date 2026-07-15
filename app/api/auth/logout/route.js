// POST /api/auth/logout → чистит сессию и редиректит на /login.
//
// Вызывается из <form action="/api/auth/logout" method="post"> (топбар,
// список проектов, профиль-хаб). Возвращать JSON было нельзя — браузер при
// form-POST показывает сырой {"ok":true,...} вместо перехода.
//
// Решение: HTTP 303 See Other. Это единственный код, при котором браузер
// гарантированно переключается с POST на GET для целевого URL (RFC 7231 §6.4.4).
// 301/302 с POST браузеры исторически переотправляют как POST, что привело бы
// к повторному заходу на logout. 303 — стандарт для «post → redirect → get».
//
// Удаление cookie: getSession() (lib/session.js) оборачивает iron-session поверх
// cookies()-store route handler'а; session.destroy() пишет в этот store
// cookie с maxAge=0. Но Response.redirect из store сам по себе set-cookie не
// переносит — поэтому чистим cookie явно и приклеиваем заголовок к редиректу.
import { cookies } from 'next/headers';
import { getSession, SESSION_COOKIE, sessionOptions } from '@/lib/session.js';

export async function POST() {
  const session = await getSession();
  session.destroy(); // чистит cookieStore[SESSION_COOKIE] (maxAge=0)

  // Явная очистка cookie в текущем cookies()-store — гарантия, что редирект-ответ
  // унесёт Set-Cookie с maxAge=0 (браузер удалит куку сессии).
  const ck = cookies();
  ck.set(SESSION_COOKIE, '', { ...sessionOptions().cookieOptions, maxAge: 0 });

  return new Response(null, {
    status: 303,
    headers: { Location: '/login' },
  });
}

// GET — на всякий случай (если кто-то перейдёт по ссылке logout напрямую).
export async function GET() {
  return POST();
}
