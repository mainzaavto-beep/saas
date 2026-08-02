import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Операторский allowlist (спек п.6): jobs.collector_runs без RLS, поэтому доступ
// только явно перечисленным user_id (SAAS_OPS_USER_IDS="1,2" в .env.local).
function isOps(userId) {
  const ids = (process.env.SAAS_OPS_USER_IDS || '')
    .split(',').map((s) => Number(s.trim())).filter(Boolean);
  return ids.includes(Number(userId));
}

export async function GET() {
  const session = await getSession();
  if (!session?.user_id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isOps(session.user_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const days = 14;
  const runs = await query(
    `SELECT r.id, r.cabinet_id, c.display_name, r.collector, r.run_kind,
            r.date_from, r.date_to, r.status, r.error, r.started_at, r.finished_at
     FROM jobs.collector_runs r
     LEFT JOIN auth.cabinets c ON c.cabinet_id = r.cabinet_id
     WHERE r.started_at >= now() - make_interval(days => $1)
     ORDER BY r.started_at DESC`,
    [days]
  );
  return NextResponse.json({ days, runs });
}
