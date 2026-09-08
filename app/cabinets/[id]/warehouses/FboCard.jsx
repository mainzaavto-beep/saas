"use client";
// app/cabinets/[id]/warehouses/FboCard.jsx — карточка FBO-склада маркетплейса во вкладке
// «Места» (задача 6 плана). Контракт — GET ?tab=places → fboWarehouses[] (buildPlaceCards в
// lib/warehousesMetrics.js): регион/кластер склада в данных не приходит — вне рамок задачи,
// показываем только площадку и имя (см. бриф §FboCard).
import { C, soft } from "@/lib/palette.js";

const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const fmtCoverage = (c) => (c == null ? "—" : `${Math.round(c)} дн`);
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("ru-RU") : "—");

const STATUS_LABEL = { draft: "Черновик", shipped: "Отгружено", accepted: "Принято", partial: "Частично", rejected: "Отклонено" };

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 8 };
const pill = (token) => ({ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700, background: soft(token, 15), color: C[token] || C.ink });
const metricBox = { display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12 };
const metricLabel = { color: C.faint, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.3 };

function Metric({ label, value, danger }) {
  return (
    <div>
      <div style={metricLabel}>{label}</div>
      <div style={{ fontWeight: 600, color: danger ? C.neg : C.ink }}>{value}</div>
    </div>
  );
}

export function FboCard({ fbo, minDays, onOpenSupplies }) {
  const { platform, name, items, units, inTransit, velocity, coverage, low = [], openDocs = [] } = fbo;
  const danger = coverage != null && minDays != null && coverage < minDays;
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700 }}>{name}</div>
          <div style={{ fontSize: 11, color: C.faint }}>{platform === "wb" ? "WB" : "Ozon"} · FBO-склад</div>
        </div>
        {danger && <span style={pill("neg")}>ниже минимума</span>}
      </div>

      <div style={metricBox}>
        <Metric label="Позиций" value={num(items)} />
        <Metric label="Единиц" value={`${num(units)} (+в пути ${num(inTransit)})`} />
        <Metric label="Скорость" value={`${num(velocity)} шт/дн`} />
        <Metric label="Покрытие" value={fmtCoverage(coverage)} danger={danger} />
      </div>

      {low.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 4 }}>Ниже минимума</div>
          {low.map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: C.warn }}>
              {l.name}: {num(l.stock)} шт, покрытие {fmtCoverage(l.coverage)}
            </div>
          ))}
        </div>
      )}

      {openDocs.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 4 }}>Открытые поставки</div>
          {openDocs.map((d) => (
            <button key={d.id} onClick={onOpenSupplies}
              style={{ display: "block", background: "none", border: "none", padding: "2px 0", cursor: "pointer", fontSize: 12, color: C.accent, textAlign: "left" }}>
              #{d.id} · {STATUS_LABEL[d.status] || d.status} · {fmtDate(d.ship_dt || d.shipped_at)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
