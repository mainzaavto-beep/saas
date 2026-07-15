'use client';
// /register — регистрация. Поддержка инвайт-токена (?invite=TOKEN).
// Если инвайт валиден — после регистрации пользователь автоматически
// добавляется в проект с ролью manager/viewer.
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function RegisterPageWrapper() {
  return <Suspense fallback={<div style={{ padding: 40, color: "#8a99b8" }}>Загрузка…</div>}><RegisterInner /></Suspense>;
}

function RegisterInner() {
  const C = {
    bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
    muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
    pos: "#4ade80", neg: "#ff6b6b",
  };
  const router = useRouter();
  const sp = useSearchParams();
  const inviteToken = sp.get('invite') || '';

  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteInfo, setInviteInfo] = useState(null); // {valid, role, cabinet_name}

  useEffect(() => {
    if (inviteToken) {
      fetch(`/api/invite/${inviteToken}`).then(r => r.json()).then(d => {
        if (d.valid) setInviteInfo(d);
        else setErr(d.error || 'Приглашение недействительно');
      }).catch(() => {});
    }
  }, [inviteToken]);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (password !== password2) { setErr('Пароли не совпадают'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, password,
          name: [lastName, firstName].filter(Boolean).join(' ') || undefined,
          first_name: firstName || undefined,
          last_name: lastName || undefined,
          invite_code: inviteCode || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || 'Ошибка регистрации'); return; }

      // Если есть инвайт-токен — принять его.
      if (inviteToken && inviteInfo?.valid && data.user_id) {
        await fetch(`/api/invite/${inviteToken}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: data.user_id }),
        });
      }

      // Редирект: если был инвайт → в проект, иначе → онбординг.
      router.push(data.next || (inviteInfo ? '/cabinets' : '/onboarding'));
      router.refresh();
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 400, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px" }}>Регистрация</h1>
        <p style={{ color: C.muted, fontSize: 14, margin: "0 0 24px" }}>
          {inviteInfo ? `Приглашение в «${inviteInfo.cabinet_name}» (${inviteInfo.role === "manager" ? "Менеджер" : "Наблюдатель"})` : "Создайте аккаунт для доступа к сервису"}
        </p>
        {err && <div style={{ background: "rgba(255,107,107,.12)", color: C.neg, padding: "10px 14px", borderRadius: 8, fontSize: 14, marginBottom: 16 }}>{err}</div>}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Фамилия</label>
          <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4, colorScheme: "dark" }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Имя</label>
          <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} autoFocus style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4, colorScheme: "dark" }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4, colorScheme: "dark" }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Пароль (мин. 8 символов)</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4, colorScheme: "dark" }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Повторите пароль</label>
          <input type="password" value={password2} onChange={e => setPassword2(e.target.value)} required minLength={8} style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${password2 && password2 !== password ? C.neg : C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4, colorScheme: "dark" }} />
          {password2 && password2 !== password && (
            <span style={{ display: "block", color: C.neg, fontSize: 12, marginTop: 4 }}>Пароли не совпадают</span>
          )}
        </div>
        {!inviteToken && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 13, color: C.muted }}>Invite-код (если есть)</label>
            <input type="text" value={inviteCode} onChange={e => setInviteCode(e.target.value)} placeholder="Для закрытой регистрации" style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4, colorScheme: "dark" }} />
          </div>
        )}
        <button type="submit" disabled={busy} style={{ width: "100%", padding: "12px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: busy ? "default" : "pointer", fontWeight: 700, fontSize: 15, fontFamily: "inherit" }}>
          {busy ? "Создаём…" : "Создать аккаунт"}
        </button>
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 14, color: C.muted }}>
          Уже есть аккаунт? <a href="/login" style={{ color: C.accent }}>Войти</a>
        </div>
      </form>
    </div>
  );
}
