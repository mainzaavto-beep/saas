"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useRef, useState } from "react";

// Кнопка-фильтр с выпадающим списком: поиск, галочки, «Сбросить». options: [{value, label, sub?}].
export default function MultiSelect({ label, options, value, onChange, title }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => `${o.label} ${o.sub || ""}`.toLowerCase().includes(s)) : options;
  }, [options, q]);
  const sel = new Set(value);
  const toggle = (v) => onChange(sel.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div ref={ref} title={title} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(!open)} style={{
        padding: "7px 12px", borderRadius: 8, border: `1px solid ${value.length ? C.accent : C.line}`,
        background: value.length ? soft("accent", 12) : C.surface, color: C.ink, cursor: "pointer", fontSize: 13,
      }}>
        {label}{value.length ? ` · ${value.length}` : ""} ▾
      </button>
      {open && (
        <div style={{
          position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, width: 300, maxWidth: "90vw",
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 8,
          boxShadow: `0 8px 24px ${soft("ink", 15)}`,
        }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" style={{
            width: "100%", boxSizing: "border-box", padding: "6px 8px", marginBottom: 6, borderRadius: 6,
            border: `1px solid ${C.line}`, background: C.bg, color: C.ink,
          }} />
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {shown.length === 0 && <div style={{ color: C.muted, fontSize: 12, padding: 6 }}>Ничего не найдено</div>}
            {shown.map((o) => (
              <label key={o.value} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 6px", cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={sel.has(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}{o.sub && <span style={{ color: C.muted, fontSize: 11 }}> · {o.sub}</span>}</span>
              </label>
            ))}
          </div>
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])} style={{ marginTop: 6, background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 12 }}>
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}
