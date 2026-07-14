// POST /api/onboarding/start — создать проект.
// Тело: { display_name, usn_pct, vat } — магазины добавляются отдельно через /shops.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';

export async function POST(req) {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }

  const userId = session.user_id;
  const displayName = String(body.display_name || '').trim();
  if (!displayName) return NextResponse.json({ error: 'Укажите название проекта' }, { status: 400 });

  const usnPct = Number(body.usn_pct ?? 6);
  if (Number.isNaN(usnPct) || usnPct < 0 || usnPct > 100) return NextResponse.json({ error: 'Некорректная ставка УСН' }, { status: 400 });
  const taxMode = { usn_pct: usnPct, vat: !!body.vat };

  const { getPool } = await import('@/lib/db.js');
  const pool = getPool();
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const { rows } = await cl.query(
      `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, tax_mode, status)
       VALUES ($1, $2, '{}', $3, 'provisioning')
       RETURNING cabinet_id, display_name, status`,
      [userId, displayName, JSON.stringify(taxMode)]
    );
    const cabinet = rows[0];
    await cl.query(
      'INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, cabinet_id) DO NOTHING',
      [userId, cabinet.cabinet_id, 'owner']
    );
    await cl.query('COMMIT');
    session.active_cabinet_id = cabinet.cabinet_id;
    await session.save();
    return NextResponse.json({ ok: true, cabinet });
  } catch (e) {
    try { await cl.query('ROLLBACK'); } catch {}
    return NextResponse.json({ error: 'Ошибка: ' + e.message }, { status: 500 });
  } finally { cl.release(); }
}
