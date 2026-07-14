// POST /api/onboarding/start — создать проект.
// Тело: { display_name, marketplaces?: ['wb'|'ozon', ...] } — список МП берётся
// из выбранных магазинов на фронте (unique по mp_code). Магазины (с налоговым
// режимом и API-ключами) добавляются отдельно через /shops.
//
// Этап backfill (2026-07-14): кабинет создаётся СРАЗУ в status='active' с
// заполненным marketplaces[] — чтобы воркер (читающий active + marketplaces)
// мог собирать данные. В той же транзакции создаётся job типа 'onboarding'
// (date_from = сегодня−75, date_to = вчера, status='queued') — его подхватывает
// saas-backfill таймер (orchestrator --drain-queue) и тянет историю за 75 дней.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { normalizeTaxMode } from '@/lib/tax.js';

// Сколько дней истории тянуть при подключении нового кабинета.
const BACKFILL_DAYS = 75;

export async function POST(req) {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }

  const userId = session.user_id;
  const displayName = String(body.display_name || '').trim();
  if (!displayName) return NextResponse.json({ error: 'Укажите название проекта' }, { status: 400 });

  // Дефолтный налоговый режим на кабинет (legacy, для обратной совместимости).
  // Реальные режимы — на auth.shops (per shop / per legal entity).
  const taxMode = normalizeTaxMode(body.tax_mode);

  // marketplaces[] — unique МП из выбранных магазинов (['wb'], ['wb','ozon'], ...).
  // Воркер выбирает сборщики по этому массиву. Фронт присылает unique(mps).
  // Подстраховка: дедуп + фильтр известных кодов.
  const KNOWN_MP = ['wb', 'ozon', 'ya', 'avito'];
  let marketplaces = Array.isArray(body.marketplaces)
    ? [...new Set(body.marketplaces.map(String))]
        .filter((m) => KNOWN_MP.includes(m))
    : [];

  const { getPool } = await import('@/lib/db.js');
  const pool = getPool();
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const { rows } = await cl.query(
      `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, tax_mode, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING cabinet_id, display_name, status`,
      [userId, displayName, marketplaces, JSON.stringify(taxMode)]
    );
    const cabinet = rows[0];
    await cl.query(
      'INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, cabinet_id) DO NOTHING',
      [userId, cabinet.cabinet_id, 'owner']
    );

    // Onboarding-job: backfill истории за BACKFILL_DAYS. date_to = вчера
    // (за сегодня данные ещё могут быть неполными, их доберёт ежедневный таймер).
    // Создаём в той же транзакции — либо кабинет+job вместе, либо ничего.
    const jobFrom = new Date(Date.now() - BACKFILL_DAYS * 86400000);
    const jobTo = new Date(Date.now() - 86400000); // вчера
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await cl.query(
      `INSERT INTO jobs.collect_jobs (cabinet_id, job_type, date_from, date_to, status)
       VALUES ($1, 'onboarding', $2, $3, 'queued')`,
      [cabinet.cabinet_id, fmt(jobFrom), fmt(jobTo)]
    );

    await cl.query('COMMIT');
    session.active_cabinet_id = cabinet.cabinet_id;
    await session.save();
    return NextResponse.json({ ok: true, cabinet });
  } catch (e) {
    try { await cl.query('ROLLBACK'); } catch {}
    return NextResponse.json({ error: 'Ошибка: ' + e.message }, { status: 500 });
  } finally {
    cl.release();
  }
}
