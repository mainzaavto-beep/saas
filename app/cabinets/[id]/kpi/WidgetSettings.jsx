"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";
import { normalizeLayout } from "@/lib/kpiDashboard.js";

// Модалка «Настройка виджетов»: порядок (перетаскивание; стрелки ↑↓ — для телефона),
// скрытие галочкой, «+ Метрика» из каталога, сброс к стандарту.
export default function WidgetSettings({ titles, catalog, layout, onSave, onReset, onClose }) {
  const [l, setL] = useState(() => normalizeLayout(layout));
  const [drag, setDrag] = useState(null);
  const move = (from, to) => {
    if (to < 0 || to >= l.order.length) return;
    const order = [...l.order];
    const [k] = order.splice(from, 1);
    order.splice(to, 0, k);
    setL({ ...l, order });
  };
  const toggleHidden = (k) => setL({ ...l, hidden: l.hidden.includes(k) ? l.hidden.filter((x) => x !== k) : [...l.hidden, k] });
  const addExtra = (k) => setL(normalizeLayout({ ...l, extra: [...l.extra, k] }));
  const removeExtra = (k) => setL(normalizeLayout({ ...l, extra: l.extra.filter((x) => x !== k), order: l.order.filter((x) => x !== k) }));
  const notAdded = catalog.filter((c) => !l.extra.includes(c.key));
  const isExtra = (k) => catalog.some((c) => c.key === k);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: soft("ink", 40), zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, borderRadius: 12, padding: 16, width: 480, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", border: `1px solid ${C.line}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <b style={{ color: C.ink }}>Настройка виджетов</b>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>
        {l.order.map((k, i) => (
          <div key={k} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag != null) move(drag, i); setDrag(null); }}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.line}`, marginBottom: 4, background: drag === i ? soft("accent", 10) : C.surface, cursor: "grab" }}>
            <span style={{ color: C.muted }}>⠿</span>
            <input type="checkbox" checked={!l.hidden.includes(k)} onChange={() => toggleHidden(k)} title="Показывать" />
            <span style={{ flex: 1, color: C.ink, fontSize: 13 }}>{titles[k] || k}</span>
            <button onClick={() => move(i, i - 1)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted }}>↑</button>
            <button onClick={() => move(i, i + 1)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted }}>↓</button>
            {isExtra(k) && <button onClick={() => removeExtra(k)} title="Убрать метрику" style={{ background: "none", border: "none", cursor: "pointer", color: C.neg }}>✕</button>}
          </div>
        ))}
        {notAdded.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>+ Метрика</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {notAdded.map((c) => (
                <button key={c.key} onClick={() => addExtra(c.key)} style={{ padding: "4px 10px", borderRadius: 14, border: `1px solid ${C.line}`, background: C.bg, color: C.ink, cursor: "pointer", fontSize: 12 }}>+ {c.title}</button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14 }}>
          <button onClick={onReset} style={{ background: "none", border: "none", color: C.accent, cursor: "pointer" }}>Сбросить к стандарту</button>
          <button onClick={() => onSave(l)} style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: C.accent, color: "var(--accentInk)", cursor: "pointer" }}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}
