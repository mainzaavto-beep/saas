"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useRef, useState } from "react";

// Кнопка-фильтр с выпадающим списком: поиск, галочки, «Сбросить». options: [{value, label, sub?}].
export default function MultiSelect({ label, options, value, onChange, title }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  const btnRef = useRef(null);
  // Якорь выпадашки считается при открытии от реального положения кнопки (getBoundingClientRect) —
  // на узком экране (~360-390px) кнопка может стоять посередине ряда фильтров. Бинарный left:0/
  // right:0 этого не чинит: right:0 от кнопки в середине ряда уводит ЛЕВЫЙ край списка за экран
  // (clip слева). Поэтому offset — смещение относительно кнопки, которое держит сам список
  // (не кнопку) в границах [16, vw-16].
  const [dropStyle, setDropStyle] = useState({ left: 0, width: 300 });
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const toggleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const w = Math.min(300, vw - 32);
      const left = Math.max(16, Math.min(rect.left, vw - w - 16));
      setDropStyle({ left: left - rect.left, width: w });
    }
    setOpen((o) => !o);
  };
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => `${o.label} ${o.sub || ""}`.toLowerCase().includes(s)) : options;
  }, [options, q]);
  const sel = new Set(value);
  const toggle = (v) => onChange(sel.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div ref={ref} title={title} style={{ position: "relative" }}>
      <button ref={btnRef} type="button" onClick={toggleOpen} style={{
        padding: "7px 12px", borderRadius: 8, border: `1px solid ${value.length ? C.accent : C.line}`,
        background: value.length ? soft("accent", 12) : C.surface, color: C.ink, cursor: "pointer", fontSize: 13,
      }}>
        {label}{value.length ? ` · ${value.length}` : ""} ▾
      </button>
      {open && (
        <div style={{
          position: "absolute", zIndex: 20, top: "calc(100% + 4px)", maxWidth: "90vw",
          left: dropStyle.left, width: dropStyle.width,
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
