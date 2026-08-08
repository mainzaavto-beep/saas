// GET /api/auth/verify/status — подтверждён ли адрес текущего пользователя.
// Нужен экрану /verify-pending: клиент жмёт ссылку в письме в другой вкладке,
// а эта вкладка должна сама пустить его дальше.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await query(
    `SELECT email, (email_verified_at IS NOT NULL) AS verified FROM auth.users WHERE user_id = $1`,
    [session.user_id]
  );
  if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ verified: rows[0].verified, email: rows[0].email });
}
