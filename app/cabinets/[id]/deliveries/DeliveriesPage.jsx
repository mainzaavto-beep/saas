"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useState } from "react";
import ReceiptPanel from "./ReceiptPanel";

// /cabinets/[id]/deliveries — «Доставлено на склад» (15.10.2026, спека
// docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md): партии из «Закупок» после
// «✓ Доставлено» → приёмка ФФ по артикулам → «✓ Учтено по артикулам». Конечная точка.

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const ddmmyyyy = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const FILTERS = [
  { v: "waiting", l: "Ждут приёмки" },
  { v: "done", l: "Учтено" },
  { v: "all", l: "Все" },
  { v: "legacy", l: "Архив (до 16.10)" },
];

export default function DeliveriesPage({ cabinetId }) {
  const [status, setStatus] = useState("waiting");
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/deliveries?status=${status}&q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d); setErr(null);
    } catch (e) { console.error("deliveries load", e); setErr(String(e.message || e)); }
  }, [cabinetId, status, q]);

  useEffect(() => { reload(); }, [reload]);

  const items = data?.items || [];
  const totals = data?.totals || { waiting: 0, done: 0, legacy: 0 };

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>Доставлено на склад</h1>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 16 }}>
        Партии из «Закупок», доставленные на фулфилмент. После приёмки ФФ внесите, сколько принято по каждому
        артикулу, и отметьте «Учтено по артикулам». Эти цифры никуда дальше не передаются.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button key={f.v} onClick={() => setStatus(f.v)}
            style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13,
              border: `1px solid ${status === f.v ? C.accent : C.line}`,
              background: status === f.v ? soft("accent", 15) : "transparent", color: C.ink }}>
            {f.l}{f.v === "waiting" ? ` · ${totals.waiting}` : f.v === "done" ? ` · ${totals.done}` : f.v === "legacy" ? ` · ${totals.legacy}` : ""}
          </button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по партии или артикулу"
          style={{ marginLeft: "auto", padding: "6px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
            background: C.surface, color: C.ink, minWidth: 260 }} />
      </div>
      {err && <div style={{ color: C.neg, marginBottom: 12 }}>Ошибка: {err}</div>}
      {!data && !err && <div style={{ color: C.muted }}>Загрузка…</div>}
      {data && !items.length && <div style={{ color: C.muted }}>Нет партий по фильтру.</div>}
      {items.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: C.muted, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={{ padding: 8, width: 48 }} />
              <th style={{ padding: 8 }}>Партия</th>
              <th style={{ padding: 8 }}>Категория</th>
              <th style={{ padding: 8 }}>Доставлено</th>
              <th style={{ padding: 8, textAlign: "right" }}>Заказано</th>
              <th style={{ padding: 8, textAlign: "right" }}>Принято</th>
              <th style={{ padding: 8, textAlign: "right" }}>Расхождение</th>
              <th style={{ padding: 8 }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <Row key={it.id} it={it} open={open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)}
                cabinetId={cabinetId} role={data.role} onChanged={reload} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Row({ it, open, onToggle, cabinetId, role, onChanged }) {
  const done = it.status === "done";
  const legacy = it.status === "legacy";
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer", borderBottom: `1px solid ${soft("line", 50)}`,
        background: open ? soft("accent", 6) : "transparent", opacity: legacy ? 0.75 : 1 }}>
        <td style={{ padding: 8 }}>
          {it.photo ? <img src={it.photo} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6 }} /> : null}
        </td>
        <td style={{ padding: 8, fontWeight: 500 }}>{it.name}</td>
        <td style={{ padding: 8, color: C.muted }}>{it.category || "—"}</td>
        <td style={{ padding: 8 }}>{ddmmyyyy(it.delivered_at)}</td>
        <td style={{ padding: 8, textAlign: "right" }}>{nf0.format(it.ordered)}</td>
        <td style={{ padding: 8, textAlign: "right" }}>{it.lines.length ? nf0.format(it.accepted) : "—"}</td>
        <td style={{ padding: 8, textAlign: "right", color: it.lines.length && it.diff !== 0 ? C.neg : C.muted }}>
          {it.lines.length ? (it.diff > 0 ? "+" : "") + nf0.format(it.diff) : "—"}
        </td>
        <td style={{ padding: 8 }}>
          {legacy ? (
            <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12,
              background: soft("muted", 18), color: C.muted }}>
              архив до 16.10
            </span>
          ) : (
            <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12,
              background: soft(done ? "pos" : "warn", 18), color: done ? C.pos : C.warn }}>
              {done ? "✓ Учтено по артикулам" : "Ждёт приёмки"}
            </span>
          )}
        </td>
      </tr>
      {open && (
        <tr><td colSpan={8} style={{ padding: "8px 8px 16px 56px", background: soft("accent", 4) }}>
          <ReceiptPanel cabinetId={cabinetId} item={it} role={role} onChanged={onChanged} />
        </td></tr>
      )}
    </>
  );
}
