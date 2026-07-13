// app/cabinets/page.js — список кабинетов пользователя (после логина).
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
      minHeight: '100vh', background: '#0b1220', color: '#e8edf7',
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
          <span style={{ fontSize: 18, fontWeight: 800 }}>MP Analytics</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#8a99b8' }}>{session.email}</span>
          <Link href="/onboarding" style={{
            padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: '1px solid #243049', color: '#8a99b8', textDecoration: 'none',
          }}>+ Кабинет</Link>
          <form action="/api/auth/logout" method="post" style={{ display: 'inline' }}>
            <button type="submit" style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: '1px solid #243049', background: 'transparent', color: '#8a99b8',
              cursor: 'pointer', fontFamily: 'inherit',
            }}>Выйти</button>
          </form>
        </div>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px' }}>Ваши кабинеты</h1>
      <p style={{ color: '#8a99b8', fontSize: 14, margin: '0 0 24px' }}>
        Выберите кабинет, чтобы открыть аналитику.
      </p>

      {cabinets.length === 0 ? (
        <div style={{
          background: '#131c2e', border: '1px dashed #243049', borderRadius: 12,
          padding: 40, textAlign: 'center', color: '#8a99b8',
        }}>
          <p>Кабинетов пока нет.</p>
          <Link href="/onboarding" style={{
            display: 'inline-block', marginTop: 12, padding: '10px 24px',
            borderRadius: 8, background: '#4f8cff', color: '#fff',
            textDecoration: 'none', fontWeight: 600,
          }}>Подключить первый →</Link>
        </div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16,
        }}>
          {cabinets.map((c) => (
            <Link key={c.cabinet_id} href={`/cabinets/${c.cabinet_id}`} style={{
              background: '#131c2e', border: '1px solid #243049', borderRadius: 12,
              padding: 20, textDecoration: 'none', color: '#e8edf7', display: 'block',
            }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>
                {c.display_name || `Кабинет #${c.cabinet_id}`}
              </div>
              <div style={{ color: '#8a99b8', fontSize: 13, marginTop: 6 }}>
                {(c.marketplaces || []).map((m) => m.toUpperCase()).join(' + ')} · {c.status}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
