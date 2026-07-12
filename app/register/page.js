'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, invite_code: inviteCode }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || 'Ошибка регистрации'); return; }
      router.push(data.next || '/onboarding');
      router.refresh();
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Регистрация</h1>
        <p className="sub">Создайте аккаунт — подключите кабинет на следующем шаге</p>
        {err && <div className="err">{err}</div>}
        <div className="field">
          <label>Имя</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Пароль (мин. 8 символов)</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </div>
        <div className="field">
          <label>Invite-код (для регистрации по приглашению)</label>
          <input type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="Введите код, если есть" />
        </div>
        <button className="btn" disabled={busy}>{busy ? 'Создаём...' : 'Создать аккаунт'}</button>
        <div className="foot">Уже есть аккаунт? <a href="/login">Войти</a></div>
      </form>
    </div>
  );
}
