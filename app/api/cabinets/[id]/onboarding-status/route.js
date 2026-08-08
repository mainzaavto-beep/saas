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
import { classifyOnboarding } from '@/lib/onboardingStatus.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withCabinet(async (req, { cabinet }) => {
  // Фильтр по job_type='onboarding' — иначе daily/resync-задание того же
  // кабинета ложно считалось бы «идёт первичная загрузка» (находка №7).
  const rows = await query(
    `SELECT 1 FROM jobs.collect_jobs
      WHERE cabinet_id = $1 AND job_type = 'onboarding' AND status = 'queued' LIMIT 1`,
    [cabinet.cabinet_id]
  );
  const broken = await query(
    `SELECT 1 FROM auth.shops
      WHERE cabinet_id = $1 AND is_active = true AND auth_state <> 'ok' LIMIT 1`,
    [cabinet.cabinet_id]
  );
  // Последнее задание onboarding и было ли хоть одно успешным — см.
  // lib/onboardingStatus.js и тот же расчёт в app/cabinets/[id]/layout.js
  // (общая функция классификации, чтобы SSR и опрос не расходились).
  const history = await query(
    `SELECT
       (SELECT status FROM jobs.collect_jobs
          WHERE cabinet_id = $1 AND job_type = 'onboarding'
          ORDER BY job_id DESC LIMIT 1) AS last_status,
       EXISTS (SELECT 1 FROM jobs.collect_jobs
          WHERE cabinet_id = $1 AND job_type = 'onboarding' AND status = 'done') AS ever_succeeded`,
    [cabinet.cabinet_id]
  );
  const state = classifyOnboarding({
    hasBrokenShops: broken.length > 0,
    hasQueuedJob: rows.length > 0,
    lastJobStatus: history[0]?.last_status || null,
    everSucceeded: !!history[0]?.ever_succeeded,
  });
  // loading оставлен для обратной совместимости (старый контракт), state — новый,
  // им пользуется LoadingBanner.jsx, чтобы отличить «упало» от «просто идёт».
  return NextResponse.json({ loading: state === 'loading', state });
});
