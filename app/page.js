// app/page.js — защищённая главная (stub дашборда). Серверный компонент.
// Читает сессию, показывает кабинеты юзера + RLS-демо (видит только свой товар).
import { getSession } from '@/lib/session.js';
import { query, withTenant } from '@/lib/db.js';
import { redirect } from 'next/navigation';

export default async function HomePage() {
  const session = await getSession();
  if (!session?.user_id) redirect('/login');

  // Список кабинетов юзера (без-тенантно, auth.*).
  const cabinets = await query(
    `SELECT c.cabinet_id, c.display_name, c.marketplaces, c.status
     FROM auth.cabinets c
     JOIN auth.memberships m ON m.cabinet_id = c.cabinet_id
     WHERE m.user_id = $1 AND c.status <> 'deleted'
     ORDER BY c.cabinet_id`,
    [session.user_id]
  );

  // RLS-демо: под активным кабинетом видим только его товары.
  let demoRows = [];
  if (session.active_cabinet_id) {
    demoRows = await withTenant(session.active_cabinet_id, async (q) => {
      const { rows } = await q('SELECT cabinet_id, nm_id, name FROM tenant.wb_articles ORDER BY nm_id LIMIT 20');
      return rows;
    });
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">📊 MP Analytics</div>
        <a href="/" className="active">Главная</a>
        <a href="/onboarding">+ Кабинет</a>
        <div style={{ marginTop: 24, fontSize: 12, color: 'var(--muted)' }}>
          {session.email}
        </div>
        <form action="/api/auth/logout" method="post" style={{ marginTop: 12 }}>
          <button type="submit" className="btn secondary" style={{ padding: '8px' }}>Выйти</button>
        </form>
      </aside>
      <main className="main">
        <h2>Привет, {session.name || session.email} 👋</h2>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          Выберите кабинет, чтобы увидеть аналитику, или подключите новый.
        </p>

        <h3 style={{ marginTop: 24 }}>Ваши кабинеты</h3>
        {cabinets.length === 0 ? (
          <div className="placeholder">
            Кабинетов пока нет. <a href="/onboarding">Подключить первый →</a>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginTop: 12 }}>
            {cabinets.map((c) => (
              <a key={c.cabinet_id} href={`/cabinets/${c.cabinet_id}`} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, textDecoration: 'none', color: 'var(--text)', display: 'block' }}>
                <strong>{c.display_name || `Кабинет #${c.cabinet_id}`}</strong>
                <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
                  {(c.marketplaces || []).join(' + ').toUpperCase()} · {c.status}
                </div>
                {c.cabinet_id === session.active_cabinet_id && (
                  <span style={{ color: 'var(--accent2)', fontSize: 12 }}>● активный</span>
                )}
              </a>
            ))}
          </div>
        )}

        {session.active_cabinet_id && (
          <>
            <h3 style={{ marginTop: 28 }}>🔒 Изоляция данных (RLS-демо)</h3>
            <p style={{ color: 'var(--muted)', marginTop: 0, fontSize: 14 }}>
              Запрос к <code>tenant.wb_articles</code> под кабинетом #{session.active_cabinet_id}.
              Видны только товары ЭТОГО кабинета:
            </p>
            <div className="placeholder" style={{ textAlign: 'left' }}>
              {demoRows.length === 0 ? (
                <span style={{ color: 'var(--muted)' }}>Товаров пока нет (сбор = Этап 3).</span>
              ) : (
                <table style={{ width: '100%', color: 'var(--text)' }}>
                  <tbody>
                    {demoRows.map((r) => (
                      <tr key={r.nm_id}>
                        <td style={{ padding: '6px 12px', color: 'var(--muted)' }}>cabinet #{r.cabinet_id} · nm {r.nm_id}</td>
                        <td style={{ padding: '6px 12px' }}>{r.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
