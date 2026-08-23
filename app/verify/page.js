'use client';
import { C } from "@/lib/palette.js";
// /verify?token=… — подтверждение адреса по ссылке из письма.
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function VerifyInner() {
  const token = useSearchParams().get('token') || '';
  const [state, setState] = useState('loading'); // loading | ok | error
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!token) { setState('error'); setErr('В ссылке нет токена'); return; }
    fetch('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok) setState('ok');
        else { setState('error'); setErr(d.error || 'Не удалось подтвердить адрес'); }
      })
      .catch(() => { setState('error'); setErr('Сетевая ошибка — обновите страницу'); });
  }, [token]);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32, textAlign: "center" }}>
        {state === 'loading' && <p style={{ color: C.muted }}>Подтверждаем адрес…</p>}
        {state === 'ok' && (<>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Почта подтверждена</h1>
          <p style={{ color: C.muted, fontSize: 14, margin: "0 0 20px" }}>Теперь доступны подключение магазинов и приглашения сотрудников.</p>
          <a href="/" className="btn" style={{ display: "block", textDecoration: "none" }}>В панель</a>
        </>)}
        {state === 'error' && (<>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Не получилось</h1>
          <p style={{ color: C.muted, fontSize: 14, margin: "0 0 20px" }}>{err}</p>
          <a href="/" style={{ color: C.accent }}>В панель</a>
        </>)}
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return <Suspense fallback={<div style={{ padding: 40, color: C.muted }}>Загрузка…</div>}><VerifyInner /></Suspense>;
}
