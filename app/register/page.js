'use client';
import { C } from "@/lib/palette.js";
// /register — регистрация. Поддержка инвайт-токена (?invite=TOKEN).
// Если инвайт валиден — после регистрации пользователь автоматически
// добавляется в проект с ролью manager/viewer.
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function RegisterPageWrapper() {
  return <Suspense fallback={<div style={{ padding: 40, color: C.muted }}>Загрузка…</div>}><RegisterInner /></Suspense>;
}

function RegisterInner() {

  const router = useRouter();
  const sp = useSearchParams();
  const inviteToken = sp.get('invite') || '';
  const fromInvite = sp.get('from') === 'invite';
  // Старые ссылки /register?invite=X ведут на страницу приглашения — там есть
  // ветка «у меня уже есть аккаунт». Сюда возвращаются кнопкой «Создать аккаунт»
  // (она добавляет from=invite).
  useEffect(() => {
    if (inviteToken && !fromInvite) router.replace(`/invite/${inviteToken}`);
  }, [inviteToken, fromInvite, router]);

  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState('');
  const [emailTaken, setEmailTaken] = useState(false);
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
    setEmailTaken(false);
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
          invite_token: inviteToken || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setErr(data.error || 'Ошибка регистрации');
        if (data.code === 'email_taken') setEmailTaken(true);
        return;
      }
      // Инвайт принят сервером регистрации; идём куда он сказал.
      router.push(data.next || '/onboarding');
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
        {err && <div className="err">{err}</div>}
        {emailTaken && (
          <div style={{ fontSize: 14, marginBottom: 16 }}>
            <a href={`/login${inviteToken ? `?next=${encodeURIComponent(`/invite/${inviteToken}`)}` : ''}`} style={{ color: C.accent }}>Войти в существующий аккаунт</a>
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Фамилия</label>
          <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Имя</label>
          <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} autoFocus style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Пароль (мин. 8 символов)</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Повторите пароль</label>
          <input type="password" value={password2} onChange={e => setPassword2(e.target.value)} required minLength={8} style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${password2 && password2 !== password ? C.neg : C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 }} />
          {password2 && password2 !== password && (
            <span style={{ display: "block", color: C.neg, fontSize: 12, marginTop: 4 }}>Пароли не совпадают</span>
          )}
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Создаём…" : "Создать аккаунт"}
        </button>
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 14, color: C.muted }}>
          Уже есть аккаунт? <a href="/login" style={{ color: C.accent }}>Войти</a>
        </div>
      </form>
    </div>
  );
}
