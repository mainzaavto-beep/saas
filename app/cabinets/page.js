// app/cabinets/page.js — список проектов пользователя (после логина).
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function CabinetsPage() {
  const session = await getSession();
  if (!session?.user_id) redirect('/login');

  const cabinets = await query(
    `SELECT c.cabinet_id, c.display_name, c.marketplaces, c.status
     FROM auth.cabinets c
     JOIN auth.memberships m ON m.cabinet_id = c.cabinet_id
     WHERE m.user_id = $1 AND c.status <> 'deleted'
     ORDER BY c.cabinet_id`,
    [session.user_id]
  );

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      padding: '24px 32px',
    }}>
      {/* Шапка */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 32,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 24 }}>📊</span>
          <span style={{ fontSize: 18, fontWeight: 800 }}>SySell</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link href="/settings" style={{
            padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: '1px solid var(--border)', color: 'var(--muted)', textDecoration: 'none',
          }}>👤 Профиль</Link>
          <Link href="/onboarding" style={{
            padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: '1px solid var(--border)', color: 'var(--muted)', textDecoration: 'none',
          }}>+ Проект</Link>
          <form action="/api/auth/logout" method="post" style={{ display: 'inline' }}>
            <button type="submit" style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)',
              cursor: 'pointer', fontFamily: 'inherit',
            }}>Выйти</button>
          </form>
        </div>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px' }}>Ваши проекты</h1>
      <p style={{ color: 'var(--muted)', fontSize: 14, margin: '0 0 24px' }}>
        Выберите проект, чтобы открыть аналитику.
      </p>

      {cabinets.length === 0 ? (
        <div style={{
          background: 'var(--panel)', border: '1px dashed var(--border)', borderRadius: 12,
          padding: 40, textAlign: 'center', color: 'var(--muted)',
        }}>
          <p>Проектов пока нет.</p>
          <Link href="/onboarding" style={{
            display: 'inline-block', marginTop: 12, padding: '10px 24px',
            borderRadius: 8, background: 'var(--accent)', color: '#fff',
            textDecoration: 'none', fontWeight: 600,
          }}>Создать первый →</Link>
        </div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16,
        }}>
          {cabinets.map((c) => (
            <Link key={c.cabinet_id} href={`/cabinets/${c.cabinet_id}`} style={{
              background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12,
              padding: 20, textDecoration: 'none', color: 'var(--text)', display: 'block',
            }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>
                {c.display_name || `Проект #${c.cabinet_id}`}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
                {(c.marketplaces || []).map((m) => m.toUpperCase()).join(' + ')} · {c.status}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
