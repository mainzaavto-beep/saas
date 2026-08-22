import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import { classifyRuns } from '@/lib/opsAlerts.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Операторский allowlist (спек п.6, тот же паттерн что в /api/health) —
// jobs.collector_runs без RLS, доступ только явно перечисленным user_id.
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

  // Лёгкий запрос (индекс collector_runs_coll_fin) — баннер опрашивается со
  // всех страниц панели, поэтому окно уже, чем /api/health (48 ч вместо 14 дн).
  const rows = await query(
    `SELECT cabinet_id, collector, run_kind, status, started_at
       FROM jobs.collector_runs
      WHERE started_at > now() - interval '48 hours'
      ORDER BY started_at DESC`
  );

  return NextResponse.json({ alerts: classifyRuns(rows) });
}
