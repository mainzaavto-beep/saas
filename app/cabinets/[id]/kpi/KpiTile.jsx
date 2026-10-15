"use client";
import { C, soft } from "@/lib/palette.js";

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
export function fmt(v, unit) {
  if (v == null) return "—";
  if (unit === "pct") return `${nf2.format(v)} %`;
  if (unit === "pcs") return `${nf0.format(v)} шт`;
  return `${nf0.format(v)} ₽`;
}
const TONE_BG = { good: () => soft("pos", 14), bad: () => soft("neg", 14), neutral: () => soft("accent", 6) };

// Плитка: основная цифра (+ вторая), прошлый период, дельта со стрелкой, значок раскрытия.
export default function KpiTile({ tile, onOpen }) {
  const t = tile;
  const arrow = t.delta?.abs > 0 ? "↗" : t.delta?.abs < 0 ? "↘" : "";
  const dColor = t.tone === "good" ? C.pos : t.tone === "bad" ? C.neg : C.muted;
  const canOpen = t.breakdown.length > 0;
  return (
    <div
      onClick={canOpen ? () => onOpen(t) : undefined}
      title={t.hint || undefined}
      style={{
        background: TONE_BG[t.tone](), border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px",
        minHeight: 104, cursor: canOpen ? "pointer" : "default", display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 13, color: C.ink }}>
        <span>{t.title}{t.hint && <span style={{ color: C.muted }}> ⓘ</span>}</span>
        {canOpen && <span style={{ fontSize: 11, color: C.muted, border: `1px solid ${C.line}`, borderRadius: 6, padding: "0 6px" }}>▢ {t.breakdown.length}</span>}
      </div>
      {t.error ? (
        <div style={{ color: C.neg, fontSize: 14 }}>ошибка загрузки</div>
      ) : (
        <div style={{ fontSize: 22, fontWeight: 700, color: C.ink, fontVariantNumeric: "tabular-nums" }}>
          {fmt(t.value, t.unit)}
          {t.second && t.second.value != null && <span style={{ fontSize: 15, fontWeight: 600 }}> / {fmt(t.second.value, t.second.unit)}</span>}
        </div>
      )}
      {t.unavailable && <div style={{ fontSize: 11, color: C.muted }}>не делится по товарам</div>}
      {!t.error && !t.unavailable && t.prev != null && (
        <div style={{ fontSize: 12, color: C.muted, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span>{fmt(t.prev, t.unit)}</span>
          {t.delta && (
            <span style={{ color: dColor, border: `1px solid ${soft(t.tone === "good" ? "pos" : t.tone === "bad" ? "neg" : "line", 40)}`, borderRadius: 6, padding: "0 6px" }}>
              {t.delta.abs > 0 ? "+" : ""}{t.unit === "pct" ? `${nf2.format(t.delta.abs)} п.п.` : fmt(t.delta.abs, t.unit)}
              {t.delta.pct != null && ` (${t.delta.pct > 0 ? "+" : ""}${nf2.format(t.delta.pct)}%)`} {arrow}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
