'use client';
import { C } from "@/lib/palette.js";
// /forgot — запрос ссылки для сброса пароля.
import { useState } from 'react';

export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await fetch('/api/auth/forgot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || 'Не удалось отправить письмо'); return; }
      setSent(true);
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  const card = { width: "100%", maxWidth: 400, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32 };
  const wrap = { minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 };

  if (sent) return (
    <div style={wrap}><div style={{ ...card, textAlign: "center" }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Проверьте почту</h1>
      <p style={{ color: C.muted, fontSize: 14, margin: "0 0 20px" }}>Если такой аккаунт есть, мы отправили письмо со ссылкой. Она действует 1 час.</p>
      <a href="/login" style={{ color: C.accent }}>Вернуться ко входу</a>
    </div></div>
  );

  return (
    <div style={wrap}>
      <form onSubmit={submit} style={card}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px" }}>Забыли пароль?</h1>
        <p style={{ color: C.muted, fontSize: 14, margin: "0 0 24px" }}>Укажите email — пришлём ссылку для смены пароля</p>
        {err && <div className="err">{err}</div>}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 }} />
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Отправляем…" : "Прислать ссылку"}
        </button>
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 14, color: C.muted }}>
          Вспомнили? <a href="/login" style={{ color: C.accent }}>Войти</a>
        </div>
      </form>
    </div>
  );
}
