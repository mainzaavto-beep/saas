'use client';
import { C } from "@/lib/palette.js";
// /reset?token=… — установка нового пароля по ссылке из письма.
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function ResetInner() {
  const router = useRouter();
  const token = useSearchParams().get('token') || '';
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (password !== password2) { setErr('Пароли не совпадают'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || 'Не удалось сменить пароль'); return; }
      router.push('/login?reset=1');
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  const input = { width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 400, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px" }}>Новый пароль</h1>
        <p style={{ color: C.muted, fontSize: 14, margin: "0 0 24px" }}>Придумайте пароль — не короче 8 символов</p>
        {err && <div className="err">{err}</div>}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Пароль</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoFocus style={input} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Повторите пароль</label>
          <input type="password" value={password2} onChange={e => setPassword2(e.target.value)} required minLength={8} style={{ ...input, border: `1px solid ${password2 && password2 !== password ? C.neg : C.line}` }} />
        </div>
        <button type="submit" disabled={busy} style={{ width: "100%", padding: "12px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: busy ? "default" : "pointer", fontWeight: 700, fontSize: 15, fontFamily: "inherit" }}>
          {busy ? "Сохраняем…" : "Сохранить пароль"}
        </button>
      </form>
    </div>
  );
}

export default function ResetPage() {
  return <Suspense fallback={<div style={{ padding: 40, color: "#8a99b8" }}>Загрузка…</div>}><ResetInner /></Suspense>;
}
