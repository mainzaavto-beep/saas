// GET /api/cabinets/[id]/articles — товары кабинета (RLS: видит только свой).
// Доступ через withCabinet: membership + сверка session_version (см. lib/withCabinet.js).
//
// С 2026-07-19 — поддерживает оба МП через ?mp=wb|ozon:
//   • mp=wb   (или без параметра) → tenant.wb_articles  (nm_id, name, brand, subject, im_url)
//   • mp=ozon                       → tenant.ozon_products (product_id, name, offer_id, brand, im_url)
// Используется в форме привязки артикула на /inventory (datalist): клиент видит
// список уже подгруженных карточек и выбирает из них, а не вводит nm_id/product_id вслепую.
import { NextResponse } from 'next/server';
import { withCabinet } from '@/lib/withCabinet.js';
import { tenantQuery } from '@/lib/db.js';

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mp = (url.searchParams.get('mp') || 'wb').toLowerCase();

  // RLS-чтение: withCabinet уже открыл withTenant-транзакцию (app.cabinet_id
  // выставлен), tenantQuery работает на том же клиенте из ALS.
  let rows;
  if (mp === 'ozon') {
    rows = await tenantQuery(
      `SELECT product_id, name, offer_id, brand, im_url
       FROM tenant.ozon_products
       ORDER BY name LIMIT 1000`
    );
  } else {
    // WB по умолчанию (backward-compat: без ?mp= — старое поведение)
    rows = await tenantQuery(
      `SELECT nm_id, name, brand, subject, im_url
       FROM tenant.wb_articles
       ORDER BY name LIMIT 1000`
    );
  }

  return NextResponse.json({ cabinet_id: cabinet.cabinet_id, mp, count: rows.length, articles: rows });
});
