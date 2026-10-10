"use client";
import { C, soft } from "@/lib/palette.js";
// /cabinets/[id]/team — команда проекта (сотрудники + приглашения).
import { useEffect, useState } from "react";


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const INP = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14 };

export default function TeamPage({ cabinetId, embedded = false }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [myRole, setMyRole] = useState(null); // 'owner' | 'manager' | 'viewer'
  const [error, setError] = useState(null);
  const [newRole, setNewRole] = useState("viewer");
  const [inviteUrl, setInviteUrl] = useState(null);
  const [copied, setCopied] = useState(false);
  const [acc, setAcc] = useState({ name: "", login: "", password: "", role: "manager" });
  const [created, setCreated] = useState(null); // { name, login, password } — показать владельцу, чтобы передать

  // Ответы читаем с проверкой r.ok: 403 у /invites для не-владельца — норма
  // (раздел скрыт через canManage), остальные ошибки показываем.
  const load = () => {
    fetch(`/api/cabinets/${cabinetId}/me`).then(r => r.json()).then(d => setMyRole(d.role || null));
    fetch(`/api/cabinets/${cabinetId}/members`).then(r => r.ok ? r.json() : { items: [] }).then(d => setMembers(d.items || []));
    fetch(`/api/cabinets/${cabinetId}/invites`).then(r => r.ok ? r.json() : { items: [] }).then(d => setInvites(d.items || []));
  };
  useEffect(() => { load(); }, [cabinetId]);
  // Менять роли / приглашать / удалять может только владелец (см. withCabinet requireRole:'owner').
  const canManage = myRole === "owner";

  const createInvite = async () => {
    setInviteUrl(null); setCopied(false); setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/invites`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    const d = await r.json();
    if (r.ok && d.url) { setInviteUrl(d.url); load(); }
    else setError(d.error || "Не удалось создать приглашение");
  };

  const copyUrl = () => {
    if (inviteUrl) { navigator.clipboard.writeText(inviteUrl); setCopied(true); }
  };

  const changeRole = async (userId, role) => {
    setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/members`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, role }),
    });
    if (!r.ok) setError((await r.json()).error || "Не удалось изменить роль");
    load();
  };

  const removeMember = async (userId) => {
    if (!confirm("Удалить сотрудника из проекта?")) return;
    setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/members?user_id=${userId}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json()).error || "Не удалось удалить сотрудника");
    load();
  };

  // Сотрудник, которого создаёт владелец: логин + пароль (lib/teamAccounts.js).
  const createAccount = async () => {
    setError(null); setCreated(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/members`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(acc),
    });
    const d = await r.json().catch((e) => { console.error("[team] POST members: ответ не JSON", e); return {}; });
    if (!r.ok) { setError(d.error || "Не удалось создать сотрудника"); return; }
    setCreated({ name: acc.name.trim(), login: acc.login.trim().toLowerCase(), password: acc.password });
    setAcc({ name: "", login: "", password: "", role: "manager" });
    load();
  };

  const setPassword = async (m) => {
    const password = prompt(`Новый пароль для «${m.name || m.email}» (минимум 8 символов):`);
    if (password == null) return;
    setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/members`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: m.user_id, password }),
    });
    const d = await r.json().catch((e) => { console.error("[team] PATCH members: ответ не JSON", e); return {}; });
    if (!r.ok) setError(d.error || "Не удалось сменить пароль");
    else alert(`Пароль изменён. Логин: ${m.email}`);
  };

  const revokeInvite = async (token) => {
    if (!confirm("Отозвать приглашение? Ссылка перестанет работать.")) return;
    setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/invites?token=${encodeURIComponent(token)}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error || "Не удалось отозвать приглашение");
    load();
  };

  const roleColor = { owner: C.accent, manager: C.pos, viewer: C.muted };
  const roleLabel = { owner: "Владелец", manager: "Менеджер", viewer: "Наблюдатель" };

  return (
    <div style={embedded
      ? { width: "100%", fontFamily: FONT, color: C.ink }
      : { width: "100%", maxWidth: 700, margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      {!embedded && <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 20px" }}>👥 Команда</h1>}
      {error && <div className="err">{error}</div>}

      {/* Сотрудники */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Сотрудники ({members.length})</h2>
        {members.map((m) => (
          <div key={m.user_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${soft("line", 20)}` }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name || m.email || "Сотрудник"}</span>
              {m.email && <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{m.email}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, color: roleColor[m.role], background: `color-mix(in srgb, ${roleColor[m.role]} 13%, transparent)` }}>{roleLabel[m.role]}</span>
              {canManage && m.role !== "owner" && (
                <>
                  <select value={m.role} onChange={e => changeRole(m.user_id, e.target.value)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 12 }}>
                    <option value="manager">Менеджер</option>
                    <option value="viewer">Наблюдатель</option>
                  </select>
                  <button onClick={() => setPassword(m)} title="Сменить пароль" style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.ink, cursor: "pointer", fontSize: 12 }}>🔑</button>
                  <button onClick={() => removeMember(m.user_id)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.neg}`, background: "transparent", color: C.neg, cursor: "pointer", fontSize: 12 }}>✕</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Создать сотрудника с логином и паролем (только владелец) */}
      {canManage && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>Создать сотрудника</h2>
          <p style={{ fontSize: 12, color: C.muted, margin: "0 0 12px" }}>Задайте логин и пароль и передайте их сотруднику. Логин — в виде имя@что-то, например wb@sysell. Восстановить пароль сам он не сможет — меняйте кнопкой 🔑.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input placeholder="Имя (Менеджер ВБ)" value={acc.name} onChange={e => setAcc({ ...acc, name: e.target.value })} style={INP} />
            <input placeholder="Логин (wb@sysell)" value={acc.login} onChange={e => setAcc({ ...acc, login: e.target.value })} style={INP} autoComplete="off" />
            <input placeholder="Пароль (от 8 символов)" value={acc.password} onChange={e => setAcc({ ...acc, password: e.target.value })} style={INP} autoComplete="new-password" />
            <select value={acc.role} onChange={e => setAcc({ ...acc, role: e.target.value })} style={INP}>
              <option value="manager">Менеджер</option>
              <option value="viewer">Наблюдатель</option>
            </select>
            <button onClick={createAccount} style={{ padding: "8px 20px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>Создать</button>
          </div>
          {created && (
            <div style={{ marginTop: 12, padding: "10px 14px", background: C.surfaceAlt, borderRadius: 8, fontSize: 13 }}>
              ✓ Создан «{created.name}». Передайте: логин <b>{created.login}</b>, пароль <b>{created.password}</b>. Вход — обычная страница входа.
            </div>
          )}
        </div>
      )}

      {/* Приглашения */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Пригласить сотрудника</h2>
        {canManage ? (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
              <select value={newRole} onChange={e => setNewRole(e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14 }}>
                <option value="manager">Менеджер</option>
                <option value="viewer">Наблюдатель</option>
              </select>
              <button onClick={createInvite} style={{ padding: "8px 20px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>Создать ссылку</button>
            </div>
            {inviteUrl && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 14px", background: C.surfaceAlt, borderRadius: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: C.muted, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inviteUrl}</span>
                <button onClick={copyUrl} style={{ padding: "4px 12px", borderRadius: 6, border: `1px solid ${C.accent}`, background: "transparent", color: C.accent, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{copied ? "✓ Скопировано" : "Копировать"}</button>
              </div>
            )}
            {invites.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: C.faint, marginBottom: 6 }}>Активные приглашения:</div>
                {invites.map(inv => (
                  <div key={inv.token} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
                    <span style={{ fontSize: 13, color: C.muted }}>
                      {roleLabel[inv.role]} — истекает {new Date(inv.expires_at).toLocaleDateString("ru-RU")}
                    </span>
                    <button onClick={() => revokeInvite(inv.token)} style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${C.neg}`, background: "transparent", color: C.neg, cursor: "pointer", fontSize: 12 }}>Отозвать</button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p style={{ color: C.muted, fontSize: 14 }}>Приглашать сотрудников может только владелец проекта.</p>
        )}
      </div>
    </div>
  );
}
