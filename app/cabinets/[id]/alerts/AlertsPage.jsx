"use client";
import { C } from "@/lib/palette.js";
import { ALERT } from "@/lib/callout.js";

import { useState, useEffect } from "react";

// =====================================================================
//  /alerts — Оповещения.
//  Триггерные ситуации от агентов/брифинга: плохой отзыв, кассовый разрыв,
//  падение рейтинга, блокировка карточки и т.п. — требуют незамедлительного
//  внимания. Бейдж «новые» светится в навигации (компонент Nav.jsx).
// =====================================================================

const FONT = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

// ALERT.<tone> = { background, border ("1px solid …"), color } — см. lib/callout.js.
// Раньше здесь читались несуществующие поля .bg/.text (плашки были без цвета).
const LEVEL = {
  crit: { ...ALERT.critical, icon: "🚨", label: "критично" },
  warn: { ...ALERT.warn, icon: "⚠️", label: "внимание" },
  info: { ...ALERT.info, icon: "ℹ️", label: "инфо" },
};

const FILTERS = [
  { id: "all", label: "Все" },
  { id: "crit", label: "🚨 Критичные" },
  { id: "warn", label: "⚠️ Внимание" },
  { id: "unread", label: "✨ Новые" },
];

export default function AlertsPage({ cabinetId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/notifications`);
      const d = await r.json();
      if (d.error) setError(d.error);
      else setItems(d.items || []);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function markRead(id) {
    await fetch(`/api/cabinets/${cabinetId}/notifications`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", id }),
    });
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, read: 1 } : x)));
  }

  async function markAllRead() {
    await fetch(`/api/cabinets/${cabinetId}/notifications`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read_all" }),
    });
    setItems((xs) => xs.map((x) => ({ ...x, read: 1 })));
  }

  async function remove(id) {
    if (!confirm("Удалить оповещение?")) return;
    await fetch(`/api/cabinets/${cabinetId}/notifications?id=${id}`, { method: "DELETE" });
    setItems((xs) => xs.filter((x) => x.id !== id));
  }

  const filtered = items.filter((x) => {
    if (filter === "all") return true;
    if (filter === "unread") return !x.read;
    return x.level === filter;
  });
  const unreadCount = items.filter((x) => !x.read).length;

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>Оповещения</h1>
        {unreadCount > 0 && (
          <span style={{ background: ALERT.critical.background, color: ALERT.critical.color, fontWeight: 700, fontSize: 13, padding: "4px 11px", borderRadius: 8 }}>
            {unreadCount} новых
          </span>
        )}
        {unreadCount > 0 && (
          <button onClick={markAllRead} style={ghostBtn}>✓ Прочитать все</button>
        )}
      </div>
      <p style={{ color: C.muted, fontSize: 13, margin: "6px 0 18px" }}>
        Триггерные ситуации от агентов: плохие отзывы, кассовый разрыв, падение
        рейтинга, блокировка карточки. Требуют незамедлительного внимания.
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            style={{
              ...chipBtn,
              background: filter === f.id ? C.accent : C.surfaceAlt,
              color: filter === f.id ? "var(--accentInk)" : C.muted,
              fontWeight: filter === f.id ? 700 : 500,
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {loading && <div style={{ color: C.muted, fontSize: 14 }}>Загрузка…</div>}
      {error && <div style={{ color: ALERT.critical.color, fontSize: 13 }}>Ошибка: {error}</div>}

      {!loading && filtered.length === 0 && (
        <Card>
          <div style={{ color: C.muted, fontSize: 14, textAlign: "center", padding: 20 }}>
            {items.length === 0 ? "Оповещений пока нет 🎉" : "По фильтру ничего нет."}
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {filtered.map((n) => {
          const lv = LEVEL[n.level] || LEVEL.info;
          return (
            <div key={n.id} style={{
              background: n.read ? C.surface : lv.background,
              border: n.read ? `1px solid ${C.line}` : lv.border,
              borderLeft: !n.read ? `4px solid ${lv.color}` : (n.read ? `1px solid ${C.line}` : lv.border),
              borderRadius: 10, padding: "12px 14px",
              opacity: n.read ? 0.75 : 1,
            }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontSize: 16 }}>{lv.icon}</span>
                <span style={{ fontSize: 10, fontWeight: 800, color: lv.color, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {lv.label}
                </span>
                {n.category && (
                  <span style={{ fontSize: 11, color: C.muted, background: C.surfaceAlt, padding: "2px 7px", borderRadius: 5 }}>
                    {n.category}
                  </span>
                )}
                {n.source && (
                  <span style={{ fontSize: 11, color: C.faint }}>· {n.source}</span>
                )}
                <span style={{ fontSize: 11, color: C.faint, marginLeft: "auto" }}>
                  {fmtDate(n.ts)}
                </span>
                {!n.read && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.accent, background: "rgba(0,229,255,0.10)", padding: "1px 6px", borderRadius: 4 }}>
                    NEW
                  </span>
                )}
              </div>
              {n.title && (
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 8 }}>{n.title}</div>
              )}
              {n.message && (
                <div style={{ fontSize: 13, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>{n.message}</div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                {!n.read && (
                  <button onClick={() => markRead(n.id)} style={miniBtn(C.surfaceAlt, C.accent)}>✓ Прочитано</button>
                )}
                <button onClick={() => remove(n.id)} style={miniBtn(C.surfaceAlt, C.faint)}>✕ Удалить</button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}

const ghostBtn = { border: `1px solid ${C.line}`, background: "transparent", color: C.accent, borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const chipBtn = { border: `1px solid ${C.line}`, borderRadius: 16, padding: "5px 12px", fontSize: 13, cursor: "pointer" };
function miniBtn(bg, color) {
  return { border: "none", background: bg, color, borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
}
function Card({ children }) {
  return <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }}>{children}</div>;
}
function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}
