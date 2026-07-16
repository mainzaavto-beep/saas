"use client";
import { C, soft } from "@/lib/palette.js";
// /cabinets/[id]/team — команда проекта (сотрудники + приглашения).
import { useEffect, useState } from "react";


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

export default function TeamPage({ cabinetId }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [myRole, setMyRole] = useState(null); // 'owner' | 'manager' | 'viewer'
  const [error, setError] = useState(null);
  const [newRole, setNewRole] = useState("viewer");
  const [inviteUrl, setInviteUrl] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    fetch(`/api/cabinets/${cabinetId}/me`).then(r => r.json()).then(d => setMyRole(d.role || null));
    fetch(`/api/cabinets/${cabinetId}/members`).then(r => r.json()).then(d => setMembers(d.items || []));
    fetch(`/api/cabinets/${cabinetId}/invites`).then(r => r.json()).then(d => setInvites(d.items || []));
  };
  useEffect(() => { load(); }, [cabinetId]);
  // Менять роли / приглашать / удалять может только владелец (см. withCabinet requireRole:'owner').
  const canManage = myRole === "owner";

  const createInvite = async () => {
    setInviteUrl(null); setCopied(false);
    const r = await fetch(`/api/cabinets/${cabinetId}/invites`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    const d = await r.json();
    if (d.url) { setInviteUrl(d.url); load(); }
  };

  const copyUrl = () => {
    if (inviteUrl) { navigator.clipboard.writeText(inviteUrl); setCopied(true); }
  };

  const changeRole = async (userId, role) => {
    await fetch(`/api/cabinets/${cabinetId}/members`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, role }),
    });
    load();
  };

  const removeMember = async (userId) => {
    if (!confirm("Удалить сотрудника из проекта?")) return;
    await fetch(`/api/cabinets/${cabinetId}/members?user_id=${userId}`, { method: "DELETE" });
    load();
  };

  const roleColor = { owner: C.accent, manager: C.pos, viewer: C.muted };
  const roleLabel = { owner: "Владелец", manager: "Менеджер", viewer: "Наблюдатель" };

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 20px" }}>👥 Команда</h1>

      {/* Сотрудники */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Сотрудники ({members.length})</h2>
        {members.map((m) => (
          <div key={m.user_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${soft("line", 20)}` }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name || m.email}</span>
              <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{m.email}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, color: roleColor[m.role], background: `${roleColor[m.role]}22` }}>{roleLabel[m.role]}</span>
              {canManage && m.role !== "owner" && (
                <>
                  <select value={m.role} onChange={e => changeRole(m.user_id, e.target.value)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 12 }}>
                    <option value="manager">Менеджер</option>
                    <option value="viewer">Наблюдатель</option>
                  </select>
                  <button onClick={() => removeMember(m.user_id)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.neg}`, background: "transparent", color: C.neg, cursor: "pointer", fontSize: 12 }}>✕</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

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
              <button onClick={createInvite} style={{ padding: "8px 20px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>Создать ссылку</button>
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
                  <div key={inv.token} style={{ fontSize: 13, color: C.muted, padding: "4px 0" }}>
                    {roleLabel[inv.role]} — истекает {new Date(inv.expires_at).toLocaleDateString("ru-RU")}
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
