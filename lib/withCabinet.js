// lib/withCabinet.js — обёртка для API routes SaaS.
// Берёт cabinetId из URL, проверяет session + membership, устанавливает RLS
// контекст через withTenant. Оригинальный handler работает как в data-presenter
// (DatabaseSync берёт PG client из AsyncLocalStorage).
//
// Использование в route.js:
//   import { withCabinet } from '@/lib/withCabinet.js';
//   export const GET = withCabinet(async (req, { params }) => {
//     const db = new DatabaseSync('wb', { readOnly: true });
//     // ... оригинальный код data-presenter
//     return NextResponse.json({...});
//   });

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { withTenant, query } from '@/lib/db.js';

export function withCabinet(handler) {
  return async (req, ctx) => {
    // 1. Auth.
    const session = await getSession();
    if (!session?.user_id)
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    // 2. cabinetId из URL params ([id]).
    const cabinetId = Number(ctx?.params?.id);
    if (!cabinetId)
      return NextResponse.json({ error: 'cabinet_id required' }, { status: 400 });

    // 3. Membership-check (auth.memberships без RLS).
    const mem = await query(
      `SELECT m.role, c.cabinet_id, c.display_name, c.marketplaces, c.status
       FROM auth.memberships m
       JOIN auth.cabinets c ON c.cabinet_id = m.cabinet_id
       WHERE m.user_id = $1 AND m.cabinet_id = $2`,
      [session.user_id, cabinetId]
    );
    if (!mem.length)
      return NextResponse.json({ error: 'no access to cabinet' }, { status: 403 });

    // 3б. Имена магазинов на каждом МП (auth.cabinet_marketplaces).
    // Замена захардкоженным WB_SHOP/OZ_SHOP — теперь мультитенантно.
    // Прокидываем как cabinet.shop_names = { wb: "...", ozon: "...", ... }.
    const mpRows = await query(
      `SELECT mp_code, shop_name FROM auth.cabinet_marketplaces WHERE cabinet_id = $1`,
      [cabinetId]
    );
    const shop_names = {};
    for (const r of mpRows) shop_names[r.mp_code] = r.shop_name || null;

    // 4. Выполняем handler внутри RLS-транзакции (DatabaseSync найдёт client из ALS).
    try {
      return await withTenant(cabinetId, () =>
        handler(req, { ...ctx, cabinet: { ...mem[0], shop_names } })
      );
    } catch (e) {
      console.error('[withCabinet]', e.message);
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  };
}
