// GET /api/cabinets/[id]/articles — товары кабинета (RLS: видит только свой).
// Проверяет membership (юзер имеет доступ к кабинету) + RLS-изоляция по cabinet_id.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query, withTenant } from '@/lib/db.js';

export async function GET(req, { params }) {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const cabinetId = Number(params.id);
  // Проверка: юзер имеет membership к этому кабинету.
  const mem = await query(
    `SELECT m.role FROM auth.memberships m
     WHERE m.user_id = $1 AND m.cabinet_id = $2`,
    [session.user_id, cabinetId]
  );
  if (!mem.length) return NextResponse.json({ error: 'no access to cabinet' }, { status: 403 });

  // RLS-чтение: withTenant выставит app.cabinet_id, вернёт только свои товары.
  const rows = await withTenant(cabinetId, async (q) => {
    const { rows } = await q(
      'SELECT nm_id, name, brand, subject, im_url FROM tenant.wb_articles ORDER BY name LIMIT 500'
    );
    return rows;
  });
  return NextResponse.json({ cabinet_id: cabinetId, count: rows.length, articles: rows });
}
