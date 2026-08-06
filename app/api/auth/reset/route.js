// POST /api/auth/reset { token, password } — задать новый пароль по ссылке.
// Успешная смена поднимает session_version: все ранее выданные куки умирают,
// включая те, что мог унести злоумышленник.
import { NextResponse } from 'next/server';
import { consumeToken } from '@/lib/tokens.js';
import { hashPassword } from '@/lib/auth.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  const password = String(body?.password || '');
  if (password.length < 8) return NextResponse.json({ error: 'Пароль минимум 8 символов' }, { status: 400 });

  const userId = await consumeToken(body?.token, 'reset_password');
  if (!userId) {
    return NextResponse.json({ error: 'Ссылка недействительна или устарела. Запросите новую.' }, { status: 400 });
  }
  await query(
    `UPDATE auth.users
        SET password_hash = $1, session_version = session_version + 1, updated_at = now()
      WHERE user_id = $2`,
    [hashPassword(password), userId]
  );
  return NextResponse.json({ ok: true });
}
