// app/cabinets/[id]/fin-dds/ddsUi.js — общие стили и форматирование страницы ДДС (17.10.2026).
import { C, soft } from "@/lib/palette.js";

export const money = (v) => (v == null || !Number.isFinite(Number(v)) ? "—"
  : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number(v)) + " ₽");
export const signed = (type, v) => (type === "income" ? "+" : type === "expense" ? "−" : "") + money(Math.abs(Number(v)) * (type === "income" && Number(v) < 0 ? -1 : 1));
export const ruDate = (s) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : "—");
export const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export async function api(url, body) {
  const r = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const d = await r.json().catch((e) => { console.error("dds api", e); return { error: `HTTP ${r.status}` }; });
  if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

export const S = {
  input: { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}` },
  btn: { padding: "7px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` },
  primary: { padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", background: C.accent, color: "var(--accentInk)", border: "none" },
  card: { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px" },
  th: { padding: "9px 10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left", whiteSpace: "nowrap" },
  td: { padding: "7px 10px", fontSize: 13, borderBottom: `1px solid ${soft("line", 20)}`, verticalAlign: "middle" },
  num: { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 },
  modal: { background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto" },
  dot: (token) => ({ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: `var(--${token || "line"})`, marginRight: 6 }),
};
export const Field = ({ label, children }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>{label}{children}</label>
);
export function Kpi({ label, value, color }) {
  return (
    <div style={{ ...S.card, flex: "1 1 160px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink }}>{value}</div>
    </div>
  );
}
