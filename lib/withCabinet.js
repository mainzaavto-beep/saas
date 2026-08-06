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
//
// Роли (opts.requireRole) — иерархия owner(3) ≥ manager(2) ≥ viewer(1):
//   export const POST = withCabinet(handler, { requireRole: 'manager' });
// Если вызывающий имеет уровень НИЖЕ требуемого → 403 «Недостаточно прав».
// Без opts (или без requireRole) — доступно любой роли (только membership-check).
// Уровни: viewer — только чтение; manager — товары/реклама/себестоимость + всё чтение;
// owner — добавляет финансы/настройки/команду. GET-эндпоинты обычно без requireRole.

import { NextResponse } from 'next/server';
import { getSession, touchSession } from '@/lib/session.js';
import { withTenant, query } from '@/lib/db.js';

// Иерархия уровней ролей для requireRole-проверок.
const ROLE_LEVEL = { owner: 3, manager: 2, viewer: 1 };

export function withCabinet(handler, opts) {
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

    // Активность пользователя — продлеваем сессию (не чаще раза в сутки).
    await touchSession(session);

    // 3б. Имена магазинов + налоговый режим на каждом МП (auth.shops).
    // Замена захардкоженным WB_SHOP/OZ_SHOP — теперь мультитенантно.
    // Прокидываем как cabinet.shop_names = { wb: "...", ozon: "...", ... }.
    const mpRows = await query(
      `SELECT mp_code, shop_name, tax_mode
       FROM auth.shops
       WHERE cabinet_id = $1 AND is_active = true
       ORDER BY shop_id`,
      [cabinetId]
    );
    const shop_names = {};
    const shopTax = {};
    for (const r of mpRows) {
      shop_names[r.mp_code] = r.shop_name || null;
      // Один режим на МП (если несколько shop одного МП — берём последний, обычно он один).
      shopTax[r.mp_code] = r.tax_mode || null;
    }

    // 4. Проверка роли вызывающего (requireRole из opts). До входа в withTenant —
    //    нет смысла открывать транзакцию, если доступ всё равно запрещён.
    if (opts?.requireRole) {
      const need = ROLE_LEVEL[opts.requireRole];
      const have = ROLE_LEVEL[mem[0].role] || 0;
      if (have < need) {
        return NextResponse.json({ error: "Недостаточно прав" }, { status: 403 });
      }
    }

    // 5. Выполняем handler внутри RLS-транзакции (DatabaseSync найдёт client из ALS).
    try {
      return await withTenant(cabinetId, () =>
        handler(req, { ...ctx, cabinet: { ...mem[0], shop_names, shopTax } })
      );
    } catch (e) {
      console.error('[withCabinet]', e.message);
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  };
}
