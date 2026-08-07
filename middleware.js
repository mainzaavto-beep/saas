// middleware.js (Edge) — gate: пускает только залогиненных.
// НЕ делает bcrypt / БД — только проверяет подпись iron-session cookie.
import { NextResponse } from 'next/server';
import { readSessionFromCookie } from './lib/session.js';

const PUBLIC_PATHS = ['/', '/login', '/register', '/invite', '/verify', '/forgot', '/reset', '/billing'];
const PUBLIC_API = ['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/auth/verify', '/api/auth/forgot', '/api/auth/reset'];
// /api/invite/<token> публичен: GET — валидация инвайта до регистрации,
// POST сам проверяет сессию (401 внутри роута).
// /api/billing/<...> — вебхук ЮKassa (секрет в URL) и мок-подтверждение
// (сам себя закрывает 404 вне мок-режима); внутри роуты не доверяют вызывающему.
const PUBLIC_API_PREFIXES = ['/api/invite/', '/api/billing/'];

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // Публичные страницы и эндпоинты — пропускаем без проверки.
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (PUBLIC_API.some((p) => pathname === p)) return NextResponse.next();
  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  // Next-внутренности и статика.
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }

  const session = await readSessionFromCookie(req.headers.get('cookie') || '');
  if (!session || !session.user_id) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    // Сохраняем и путь, и параметры: без search человек после входа терял
    // фильтры/период, с которыми пришёл по ссылке.
    const target = pathname + req.nextUrl.search;
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', target);
    return NextResponse.redirect(url);
  }
  // Отдаём текущий путь серверным компонентам: в App Router layout иначе его
  // не видит (x-invoke-path — внутренний заголовок Next и наружу не приходит).
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
