import BalancePage from './BalancePage';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
export const dynamic = 'force-dynamic';
// «Баланс» — только владелец (спека 2026-10-08 §1). API тоже 403 — это витрина.
export default async function Page({ params }) {
  const cabinetId = Number(params.id);
  const session = await getSession();
  const mem = session?.user_id
    ? await query('SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2', [session.user_id, cabinetId])
    : [];
  if (mem[0]?.role !== 'owner') {
    return <div style={{ padding: 32, color: 'var(--muted)' }}>Нет доступа: раздел «Баланс» доступен только владельцу.</div>;
  }
  return <BalancePage cabinetId={cabinetId} />;
}
