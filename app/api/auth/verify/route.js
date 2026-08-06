// POST /api/auth/verify { token } — подтвердить адрес по ссылке из письма.
import { NextResponse } from 'next/server';
import { consumeToken } from '@/lib/tokens.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  const userId = await consumeToken(body?.token, 'verify_email');
  if (!userId) {
    return NextResponse.json({ error: 'Ссылка недействительна или устарела. Запросите новую в панели.' }, { status: 400 });
  }
  await query(`UPDATE auth.users SET email_verified_at = now() WHERE user_id = $1`, [userId]);
  return NextResponse.json({ ok: true });
}
