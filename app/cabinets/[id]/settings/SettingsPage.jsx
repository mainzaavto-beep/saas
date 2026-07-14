"use client";
// /cabinets/[id]/settings — настройки проекта (название, налоги, магазины, API).
import { useEffect, useState } from "react";

const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  pos: "#4ade80", neg: "#ff6b6b",
};
const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", colorScheme: "dark" };

export default function SettingsPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [shops, setShops] = useState([]);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/settings`).then(r => r.json()).then(d => d.error ? setError(d.error) : setData(d));
    fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
  }, [cabinetId]);

  if (error) return <div style={{ padding: 40, color: C.neg, fontFamily: FONT }}>{error}</div>;
  if (!data) return <div style={{ padding: 40, color: C.muted, fontFamily: FONT }}>Загрузка…</div>;

  const save = async () => {
    setMsg(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: data.display_name, tax_mode: data.tax_mode }),
    });
    setMsg(r.ok ? "✅ Сохранено" : "❌ Ошибка");
  };

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 20px" }}>⚙️ Настройки проекта</h1>

      {/* Общие */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Общие</h2>
        <label style={{ fontSize: 12, color: C.muted }}>Название проекта
          <input value={data.display_name || ""} onChange={e => setData({ ...data, display_name: e.target.value })} style={{ ...inputStyle, width: "100%", marginTop: 4 }} />
        </label>
        <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
          <label style={{ fontSize: 12, color: C.muted }}>УСН %
            <input type="number" value={data.tax_mode?.usn_pct ?? 6} onChange={e => setData({ ...data, tax_mode: { ...data.tax_mode, usn_pct: Number(e.target.value) } })} style={{ ...inputStyle, width: 80, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={data.tax_mode?.vat ?? false} onChange={e => setData({ ...data, tax_mode: { ...data.tax_mode, vat: e.target.checked } })} />
            С НДС
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button onClick={save} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>Сохранить</button>
          {msg && <span style={{ fontSize: 14, color: msg.startsWith("✅") ? C.pos : C.neg }}>{msg}</span>}
        </div>
      </div>

      {/* Магазины */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Магазины (интеграции)</h2>
        {shops.length === 0 ? (
          <p style={{ color: C.muted, fontSize: 14 }}>Магазинов нет. Добавьте через онбординг.</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {shops.map((s) => (
              <div key={s.shop_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: C.surfaceAlt, borderRadius: 8 }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{s.shop_name || `Магазин #${s.shop_id}`}</span>
                  <span style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: s.mp_code === "wb" ? "rgba(79,140,255,0.15)" : "rgba(249,115,22,0.15)", color: s.mp_code === "wb" ? C.accent : "#f97316" }}>{s.mp_code.toUpperCase()}</span>
                  {s.legal_name && <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{s.legal_name}</span>}
                  {s.has_creds && <span style={{ marginLeft: 8, fontSize: 11, color: C.pos }}>🔑 Ключи есть</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Внешние сервисы */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Внешние сервисы</h2>
        <p style={{ color: C.muted, fontSize: 13, margin: "0 0 12px" }}>API-ключи для расширенной аналитики. Хранятся зашифрованными.</p>
        <label style={{ fontSize: 12, color: C.muted }}>MPStats API-ключ
          <input type="password" value={data.mpstats_token || ""} onChange={e => setData({ ...data, mpstats_token: e.target.value })} placeholder="Для сбора позиций по поисковым запросам" style={{ ...inputStyle, width: "100%", marginTop: 4 }} />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button onClick={save} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}
