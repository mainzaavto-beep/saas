// middleware.js (Edge) — gate: пускает только залогиненных.
// НЕ делает bcrypt / БД — только проверяет подпись iron-session cookie.
import { NextResponse } from 'next/server';
import { readSessionFromCookie } from './lib/session.js';

const PUBLIC_PATHS = ['/login', '/register'];
const PUBLIC_API = ['/api/auth/login', '/api/auth/register', '/api/auth/logout'];

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // Публичные страницы и эндпоинты — пропускаем без проверки.
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (PUBLIC_API.some((p) => pathname === p)) return NextResponse.next();
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
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
