'use client';
import { C } from "@/lib/palette.js";
// /invite/[token] — страница приглашения. Три сценария:
//   аноним-новый → «Создать аккаунт» (/register?invite=<t>&from=invite),
//   аноним-с-аккаунтом → «У меня уже есть аккаунт» (/login?next=/invite/<t>),
//   залогинен → «Принять приглашение» (POST) → редирект в кабинет.
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const ROLE_LABEL = { manager: "Менеджер", viewer: "Наблюдатель" };

export default function InvitePage({ params }) {
  const token = params.token;
  const router = useRouter();
  const [invite, setInvite] = useState(null); // null = грузим; {valid,...} = ответ API
  const [me, setMe] = useState(undefined);    // undefined = грузим; null = аноним; {...} = залогинен
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/invite/${token}`)
      .then(r => r.json())
      .then(setInvite)
      .catch(() => setInvite({ valid: false, error: 'Сетевая ошибка — обновите страницу' }));
    fetch('/api/profile')
      .then(r => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
  }, [token]);

  async function accept() {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(`/api/invite/${token}`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Не удалось принять приглашение'); return; }
      router.push(`/cabinets/${d.cabinet_id}`);
      router.refresh();
    } catch { setErr('Сетевая ошибка, попробуйте ещё раз'); }
    finally { setBusy(false); }
  }

  const box = (children) => (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32, textAlign: "center" }}>
        {children}
      </div>
    </div>
  );

  if (!invite || me === undefined) return box(<p style={{ color: C.muted }}>Проверяем приглашение…</p>);

  if (!invite.valid) return box(<>
    <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Приглашение недоступно</h1>
    <p style={{ color: C.muted, fontSize: 14, margin: "0 0 20px" }}>{invite.error}</p>
    <p style={{ color: C.faint, fontSize: 13 }}>Попросите у пригласившего новую ссылку.</p>
  </>);

  const btn = { display: "block", width: "100%", padding: "12px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 15, fontFamily: "inherit", textDecoration: "none", boxSizing: "border-box" };
  const btnGhost = { ...btn, background: "transparent", color: C.accent, border: `1px solid ${C.accent}`, marginTop: 10 };

  return box(<>
    <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Приглашение в команду</h1>
    <p style={{ color: C.muted, fontSize: 14, margin: "0 0 24px" }}>
      {invite.inviter_name ? `${invite.inviter_name} приглашает вас` : "Вас приглашают"} в кабинет
      {" "}«{invite.cabinet_name}» с ролью «{ROLE_LABEL[invite.role] || invite.role}»
    </p>
    {err && <div style={{ background: "rgba(255,107,107,.12)", color: C.neg, padding: "10px 14px", borderRadius: 8, fontSize: 14, marginBottom: 16 }}>{err}</div>}
    {me ? (
      <button onClick={accept} disabled={busy} style={btn}>{busy ? "Принимаем…" : "Принять приглашение"}</button>
    ) : (
      <>
        <a href={`/register?invite=${token}&from=invite`} style={btn}>Создать аккаунт</a>
        <a href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} style={btnGhost}>У меня уже есть аккаунт</a>
      </>
    )}
  </>);
}
