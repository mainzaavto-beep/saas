'use client';
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || 'Ошибка входа'); return; }
      const rawNext = params.get('next') || data.next || '/';
      // Только внутренние пути: внешний ?next= (открытый редирект) — вектор фишинга.
      const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
      router.push(next);
      router.refresh();
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Вход</h1>
        <p className="sub">Аналитика для продавцов WB и Ozon</p>
        {err && <div className="err">{err}</div>}
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label>Пароль</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button className="btn" disabled={busy}>{busy ? 'Вход...' : 'Войти'}</button>
        <div className="foot">Нет аккаунта? <a href="/register">Зарегистрироваться</a></div>
      </form>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams требует Suspense-границы для статической генерации (Next 14).
  return (
    <Suspense fallback={<div className="auth-wrap" />}>
      <LoginForm />
    </Suspense>
  );
}

