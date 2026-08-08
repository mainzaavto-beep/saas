// GET /api/cabinets/[id]/onboarding-status — идёт ли первичная загрузка.
// Лёгкий ответ для полосы в шапке: клиент опрашивает его раз в 30 секунд,
// чтобы полоса исчезла сама, без перезагрузки страницы.
//
// jobs.collect_jobs и auth.shops НЕ под RLS (rowsecurity=false — проверено
// psql'ем), rls-политики есть только на tenant.* таблицах. Поэтому используем
// query() из lib/db.js с явным cabinet_id, как это уже делает
// app/cabinets/[id]/layout.js для баннера сломанных ключей — а не tenantQuery
// (она бы просто прошла через ALS-клиент withTenant без дополнительной защиты).
// Изоляцию кабинета обеспечивает withCabinet (membership-check до вызова
// обработчика) + явное условие cabinet_id в обоих запросах ниже.
import { NextResponse } from 'next/server';
import { withCabinet } from '@/lib/withCabinet.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await query(
    `SELECT 1 FROM jobs.collect_jobs
      WHERE cabinet_id = $1 AND status = 'queued' LIMIT 1`,
    [cabinet.cabinet_id]
  );
  const broken = await query(
    `SELECT 1 FROM auth.shops
      WHERE cabinet_id = $1 AND is_active = true AND auth_state <> 'ok' LIMIT 1`,
    [cabinet.cabinet_id]
  );
  // Магазин со сломанными ключами намеренно держит задание в очереди — показывать
  // при этом «загружаем» значит врать: данные не поедут, пока клиент не починит ключи.
  return NextResponse.json({ loading: rows.length > 0 && broken.length === 0 });
});
