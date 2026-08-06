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
      // Только внутренние пути. Резолвим относительно своего origin: строковые
      // проверки обходятся через '\' (браузер трактует его как '/'), поэтому
      // сверяем именно origin результата.
      let next = '/';
      try {
        const u = new URL(rawNext, window.location.origin);
        if (u.origin === window.location.origin) next = u.pathname + u.search + u.hash;
      } catch { /* мусор в next — идём на главную */ }
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
        {params.get('reset') === '1' && !err && (
          <div className="err" style={{ background: "rgba(46,204,113,.12)", color: "#2ecc71" }}>Пароль изменён — войдите с новым паролем</div>
        )}
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
        <div className="foot"><a href="/forgot">Забыли пароль?</a></div>
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

