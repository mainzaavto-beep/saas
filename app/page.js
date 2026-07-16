// app/page.js — визитная страница сервиса (landing).
// Если уже залогинен — редирект на список кабинетов.
import { getSession } from '@/lib/session.js';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function LandingPage() {
  const session = await getSession();
  if (session?.user_id) redirect('/cabinets');

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Шапка */}
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 32px', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 24 }}>📊</span>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.3 }}>SySell</span>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link href="/login" style={{
            padding: '8px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600,
            color: 'var(--muted)', textDecoration: 'none',
          }}>Войти</Link>
          <Link href="/register" style={{
            padding: '8px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600,
            background: 'var(--accent)', color: '#fff', textDecoration: 'none',
          }}>Начать бесплатно</Link>
        </div>
      </header>

      {/* Hero */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', textAlign: 'center', padding: '40px 24px',
      }}>
        <div style={{
          fontSize: 13, letterSpacing: 3, textTransform: 'uppercase',
          color: 'var(--accent)', fontWeight: 700, marginBottom: 16,
        }}>Сервис оцифровки продаж на маркетплейсах</div>
        <h1 style={{
          fontSize: 42, fontWeight: 800, margin: '0 0 16px', lineHeight: 1.2,
          maxWidth: 720,
        }}>
          Полная аналитика Wildberries и Ozon<br />в одном дашборде
        </h1>
        <p style={{
          fontSize: 18, color: 'var(--muted)', maxWidth: 580, margin: '0 0 32px',
          lineHeight: 1.5,
        }}>
          Выручка, прибыль, рекламные кампании, остатки, юнит-экономика и
          финансовое планирование — всё в реальном времени, автоматически.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Link href="/register" style={{
            padding: '14px 32px', borderRadius: 10, fontSize: 16, fontWeight: 700,
            background: 'var(--accent)', color: '#fff', textDecoration: 'none',
          }}>Попробовать бесплатно →</Link>
          <Link href="/login" style={{
            padding: '14px 32px', borderRadius: 10, fontSize: 16, fontWeight: 600,
            border: '1px solid var(--border)', color: 'var(--muted)', textDecoration: 'none',
          }}>Войти</Link>
        </div>
      </div>

      {/* Возможности */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 16, maxWidth: 1100, margin: '0 auto', padding: '0 24px 60px', width: '100%',
      }}>
        {[
          { icon: '📦', title: 'Сводка по товарам', desc: '27 метрик по каждому товару: заказы, продажи, выручка, прибыль, ДРР, оборачиваемость' },
          { icon: '🔍', title: 'Детальная аналитика', desc: 'Клики, корзины, конверсии воронки, позиции по ключам, продажи по складам и регионам' },
          { icon: '📐', title: 'Юнит-экономика', desc: 'What-if калькулятор: меняйте цену, СПП, комиссию — прибыль пересчитается мгновенно' },
          { icon: '💰', title: 'Финансы и ДДС', desc: 'Движение денежных средств, баланс актив/пассив, план продаж, закупки, календарь платежей' },
          { icon: '📈', title: 'Автосбор данных', desc: 'Данные с WB и Ozon собираются автоматически: заказы, финансы, реклама, остатки' },
          { icon: '🔒', title: 'Безопасность', desc: 'Мультитенантность с изоляцией данных (PostgreSQL RLS), шифрование API-ключей' },
        ].map((f) => (
          <div key={f.title} style={{
            background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '20px',
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>{f.icon}</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{f.title}</div>
            <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.5 }}>{f.desc}</div>
          </div>
        ))}
      </div>

      {/* Футер */}
      <footer style={{
        padding: '20px 32px', borderTop: '1px solid var(--border)',
        textAlign: 'center', color: '#6b7a8f', fontSize: 13,
      }}>
        © 2026 SySell · Сервис оцифровки продаж на маркетплейсах
      </footer>
    </div>
  );
}
