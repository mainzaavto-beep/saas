'use client';
import { useEffect, useState } from 'react';

export default function VerifyPendingPage({ initialEmail }) {
  const [email, setEmail] = useState(initialEmail);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialEmail);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Клиент открывает письмо в другой вкладке — эта должна сама пустить дальше.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await fetch('/api/auth/verify/status', { cache: 'no-store' });
        const j = await r.json();
        if (j?.verified) window.location.href = '/onboarding';
      } catch { /* сеть моргнула — попробуем через 15 секунд */ }
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const resend = async () => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      const r = await fetch('/api/auth/verify/resend', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setMsg('Письмо отправлено ещё раз.');
      else setErr(j.error || 'Не удалось отправить письмо.');
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setErr(''); setMsg('');
    const next = draft.trim();
    if (!next.includes('@') || next.length < 5) { setErr('Проверьте адрес — он выглядит неверным.'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setEmail(j.email || next); setEditing(false); setMsg('Адрес изменён, письмо отправлено.'); }
      else setErr(j.error || 'Не удалось изменить адрес.');
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Подтвердите почту</h1>
        <p className="sub">Мы отправили письмо на <b>{email}</b>. Перейдите по ссылке из письма — эта страница откроется дальше сама.</p>
        {editing ? (
          <div className="field">
            <label>Новый адрес</label>
            <input type="email" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="ваш@адрес" autoFocus />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="btn" disabled={busy} onClick={save} style={{ flex: 1 }}>
                {busy ? 'Сохраняем…' : 'Сохранить и выслать'}
              </button>
              <button
                type="button"
                className="btn secondary"
                style={{ flex: 1 }}
                onClick={() => { setEditing(false); setDraft(email); setErr(''); }}
              >
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <button type="button" className="btn" disabled={busy} onClick={resend} style={{ flex: 1 }}>
              {busy ? 'Отправляем…' : 'Выслать ещё раз'}
            </button>
            <button type="button" className="btn secondary" onClick={() => setEditing(true)} style={{ flex: 1 }}>
              Ошиблись в адресе?
            </button>
          </div>
        )}
        {msg && <div className="err" style={{ background: 'rgba(46,204,113,.12)', color: '#2ecc71' }}>{msg}</div>}
        {err && <div className="err">{err}</div>}
        <div className="foot">Письма нет? Проверьте папку «Спам».</div>
      </div>
    </div>
  );
}
