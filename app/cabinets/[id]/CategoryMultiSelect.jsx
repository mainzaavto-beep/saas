"use client";
import { C } from "@/lib/palette.js";
import { useEffect, useRef, useState } from "react";

// Общий мультивыбор категорий (вынесен из «Сводки по товарам» 20.10.2026; используют
// summary/SummaryPage.jsx и buyout/BuyoutPage.jsx). options — [[значение, счётчик]],
// selected — Set (пустой = без фильтра), setSelected — сеттер useState.
// Мультивыбор категорий галочками: кнопка "Все категории"/"N выбрано" +
// дропдаун со списком чекбоксов (счётчик товаров из facets.cat) и
// "Выбрать все"/"Сбросить". Закрытие — по клику вне контрола.
export default function CategoryMultiSelect({ options, selected, setSelected, buttonStyle }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const toggleValue = (v) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
  };

  const label = selected.size === 0 ? "Все категории" : `${selected.size} выбрано`;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...selectStyle, ...buttonStyle, minWidth: 150, textAlign: "left" }}
      >
        {label}
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20,
          minWidth: 240, maxWidth: 320, background: C.surface, border: `1px solid ${C.line}`,
          borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", overflow: "hidden",
        }}>
          <div style={{
            display: "flex", gap: 8, padding: "6px 8px", borderBottom: `1px solid ${C.line}`,
            background: C.surfaceAlt,
          }}>
            <button
              type="button"
              onClick={() => setSelected(new Set(options.map(([v]) => v)))}
              style={miniBtnStyle}
            >Выбрать все</button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              style={miniBtnStyle}
            >Сбросить</button>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {options.length === 0 && (
              <div style={{ padding: "10px 12px", fontSize: 12, color: C.muted }}>Нет данных</div>
            )}
            {options.map(([v, n]) => (
              <label
                key={v}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                  fontSize: 12.5, color: C.ink, cursor: "pointer",
                }}
              >
                <input type="checkbox" checked={selected.has(v)} onChange={() => toggleValue(v)} />
                <span style={{
                  flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} title={v}>{v}</span>
                <span style={{ color: C.faint, fontSize: 11 }}>{n}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
const miniBtnStyle = {
  padding: "3px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600,
  border: `1px solid ${C.line}`, background: "transparent", color: C.muted, fontFamily: "inherit",
};
const inputStyle = {
  padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit",
};
const selectStyle = {
  ...inputStyle,
  padding: "7px 26px 7px 10px",
  appearance: "none",
  backgroundImage: "linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)",
  backgroundPosition: "calc(100% - 14px) 50%, calc(100% - 9px) 50%",
  backgroundSize: "5px 5px, 5px 5px",
  backgroundRepeat: "no-repeat",
  cursor: "pointer",
};
