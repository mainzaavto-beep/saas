"use client";
import { useEffect, useState } from "react";

const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  pos: "#4ade80", neg: "#ff6b6b",
};
const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", width: "100%", colorScheme: "dark" };

export default function SettingsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  // Смена пароля
  const [oldPass, setOldPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [passMsg, setPassMsg] = useState(null);

  useEffect(() => {
    fetch("/api/profile").then(r => r.json()).then(d => d.error ? setError(d.error) : setData(d)).catch(e => setError(String(e)));
  }, []);

  if (error) return <div style={{ padding: 40, color: C.neg, fontFamily: FONT }}>{error}</div>;
  if (!data) return <div style={{ padding: 40, color: C.muted, fontFamily: FONT }}>Загрузка…</div>;

  const save = async () => {
    setSaving(true); setMsg(null);
    const r = await fetch("/api/profile", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ first_name: data.first_name, last_name: data.last_name, patronymic: data.patronymic, phone: data.phone }),
    });
    const d = await r.json();
    setMsg(r.ok ? "✅ Сохранено" : `❌ ${d.error}`);
    setSaving(false);
  };

  const changePass = async () => {
    setPassMsg(null);
    if (newPass !== confirmPass) { setPassMsg("❌ Пароли не совпадают"); return; }
    if (newPass.length < 8) { setPassMsg("❌ Минимум 8 символов"); return; }
    const r = await fetch("/api/profile", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: oldPass, new_password: newPass }),
    });
    const d = await r.json();
    if (r.ok) { setPassMsg("✅ Пароль изменён"); setOldPass(""); setNewPass(""); setConfirmPass(""); }
    else setPassMsg(`❌ ${d.error}`);
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: FONT, padding: "28px 32px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>👤 Профиль</h1>
        <a href="/" style={{ color: C.muted, fontSize: 14, textDecoration: "none" }}>← Назад</a>
      </div>

      {/* Личные данные */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 24, marginBottom: 20, maxWidth: 600 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>Личные данные</h2>
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: 12, color: C.muted }}>Фамилия
            <input value={data.last_name || ""} onChange={e => setData({ ...data, last_name: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Имя
            <input value={data.first_name || ""} onChange={e => setData({ ...data, first_name: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Отчество
            <input value={data.patronymic || ""} onChange={e => setData({ ...data, patronymic: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Телефон
            <input value={data.phone || ""} onChange={e => setData({ ...data, phone: e.target.value })} placeholder="+7 (___) ___-__-__" style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Email (нельзя изменить)
            <input value={data.email || ""} disabled style={{ ...inputStyle, opacity: 0.5 }} />
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button onClick={save} disabled={saving} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>{saving ? "Сохранение…" : "Сохранить"}</button>
          {msg && <span style={{ fontSize: 14, color: msg.startsWith("✅") ? C.pos : C.neg }}>{msg}</span>}
        </div>
      </div>

      {/* Смена пароля */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 24, maxWidth: 600 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>Смена пароля</h2>
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: 12, color: C.muted }}>Текущий пароль
            <input type="password" value={oldPass} onChange={e => setOldPass(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Новый пароль
            <input type="password" value={newPass} onChange={e => setNewPass(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Повторите новый пароль
            <input type="password" value={confirmPass} onChange={e => setConfirmPass(e.target.value)} style={inputStyle} />
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button onClick={changePass} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>Сменить пароль</button>
          {passMsg && <span style={{ fontSize: 14, color: passMsg.startsWith("✅") ? C.pos : C.neg }}>{passMsg}</span>}
        </div>
      </div>
    </div>
  );
}
