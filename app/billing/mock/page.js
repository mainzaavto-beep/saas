'use client';
// /billing/mock?payment=… — заглушка платёжной формы для мок-режима.
// Реальную форму ЮKassa заменяет только когда SAAS_YOOKASSA_MOCK=1;
// вне мока страница ничего не делает.
import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function MockInner() {
  const paymentId = useSearchParams().get('payment') || '';
  const [state, setState] = useState('idle');

  async function pay() {
    setState('busy');
    const r = await fetch('/api/billing/mock-confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_id: paymentId }),
    });
    setState(r.ok ? 'done' : 'error');
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 420, padding: 32, textAlign: 'center' }}>
        <h1 style={{ fontSize: 20 }}>Тестовая оплата</h1>
        <p style={{ color: '#8a99b8', fontSize: 14 }}>Платёж {paymentId}. Настоящая форма ЮKassa появится, когда будут боевые ключи.</p>
        {state === 'done'
          ? <p style={{ color: '#2ecc71' }}>Оплачено — вернитесь в панель</p>
          : <button onClick={pay} disabled={state === 'busy'} style={{ padding: '12px 24px', borderRadius: 8, border: 'none', background: '#4f7cff', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
              {state === 'busy' ? 'Оплачиваем…' : 'Оплатить'}
            </button>}
        {state === 'error' && <p style={{ color: '#ff6b6b' }}>Не получилось</p>}
      </div>
    </div>
  );
}

export default function MockPayPage() {
  return <Suspense fallback={<div style={{ padding: 40 }}>Загрузка…</div>}><MockInner /></Suspense>;
}
