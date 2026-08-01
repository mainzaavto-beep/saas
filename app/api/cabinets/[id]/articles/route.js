// GET /api/cabinets/[id]/articles — товары кабинета (RLS: видит только свой).
// Проверяет membership (юзер имеет доступ к кабинету) + RLS-изоляция по cabinet_id.
//
// С 2026-07-19 — поддерживает оба МП через ?mp=wb|ozon:
//   • mp=wb   (или без параметра) → tenant.wb_articles  (nm_id, name, brand, subject, im_url)
//   • mp=ozon                       → tenant.ozon_products (product_id, name, offer_id, brand, im_url)
// Используется в форме привязки артикула на /inventory (datalist): клиент видит
// список уже подгруженных карточек и выбирает из них, а не вводит nm_id/product_id вслепую.
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

  const url = new URL(req.url);
  const mp = (url.searchParams.get('mp') || 'wb').toLowerCase();

  // RLS-чтение: withTenant выставит app.cabinet_id, вернёт только свои товары.
  const rows = await withTenant(cabinetId, async (q) => {
    if (mp === 'ozon') {
      const { rows } = await q(
        `SELECT product_id, name, offer_id, brand, im_url
         FROM tenant.ozon_products
         ORDER BY name LIMIT 1000`
      );
      return rows;
    }
    // WB по умолчанию (backward-compat: без ?mp= — старое поведение)
    const { rows } = await q(
      `SELECT nm_id, name, brand, subject, im_url
       FROM tenant.wb_articles
       ORDER BY name LIMIT 1000`
    );
    return rows;
  });

  return NextResponse.json({ cabinet_id: cabinetId, mp, count: rows.length, articles: rows });
}
