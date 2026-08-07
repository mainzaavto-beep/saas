// POST /api/billing/mock-confirm { payment_id } — «оплатить» в мок-режиме.
// Вне мока роут не существует: сразу 404.
import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { creditPayment } from '@/lib/billing-credit.js';
import { isMock } from '@/lib/yookassa.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  if (!isMock()) return NextResponse.json({ error: 'not found' }, { status: 404 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  const id = String(body?.payment_id || '');
  await query(
    `UPDATE billing.payments SET raw = coalesce(raw,'{}'::jsonb) || '{"mock_status":"succeeded"}'::jsonb,
            updated_at = now()
      WHERE payment_id = $1`,
    [id]
  );
  const res = await creditPayment(id);
  return NextResponse.json({ ok: res.ok });
}
