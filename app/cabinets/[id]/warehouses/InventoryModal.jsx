"use client";
// app/cabinets/[id]/warehouses/InventoryModal.jsx — инвентаризация одного места (задача 6
// плана, этап 4 «Витрина»). POST /api/cabinets/[id]/warehouses { action:'inventory_adjust',
// location_id, note, lines:[{ff_inventory_id, qty_fact, qty_known}] } — только по строкам, где
// поле «факт» не очищено (пустое поле = позицию не трогаем); бэкенд (app/api/cabinets/[id]/
// warehouses/route.js) сам разносит дельты через applyMove(kind:'adjust'). Ответ
// {applied, unchanged} → тост наверх через onDone(msg); 400 { error } — показываем в модалке,
// не alert(), модалка остаётся открытой для правки.
// qty_known — ровно то число, что показано в колонке «Учёт» этой строки. Бэкенд сверяет его с
// остатком под блокировкой и отвечает 400, если пока модалка была открыта остаток уехал
// (списание FBS, перемещение соседа) — иначе «факт» затёр бы чужое движение молча.
import { useMemo, useState } from "react";
import { C } from "@/lib/palette.js";

export function InventoryModal({ cabinetId, place, items, onClose, onDone }) {
  const rows = useMemo(
    () => items.filter((it) => Number(it.location_id) === Number(place.id)),
    [items, place.id]
  );
  const [facts, setFacts] = useState(() => Object.fromEntries(rows.map((it) => [it.id, String(it.qty)])));
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const setFact = (id, v) => setFacts((f) => ({ ...f, [id]: v }));

  async function submit() {
    setError(null);
    const n = note.trim();
    if (!n) { setError("Укажите причину инвентаризации"); return; }
    const lines = [];
    for (const it of rows) {
      const raw = (facts[it.id] ?? "").trim();
      if (raw === "") continue; // не введено — не трогаем позицию
      const qty = parseInt(raw, 10);
      if (!Number.isInteger(qty) || qty < 0) { setError(`Факт по «${itemName(it)}» должен быть целым числом ≥ 0`); return; }
      lines.push({ ff_inventory_id: it.id, qty_fact: qty, qty_known: Number(it.qty) || 0 });
    }
    if (lines.length === 0) { setError("Введите факт хотя бы по одной позиции"); return; }

    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/warehouses`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "inventory_adjust", location_id: Number(place.id), note: n, lines }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { setError(d.error || "Не удалось провести инвентаризацию"); return; }
      onDone(`Проведено движений: ${d.applied}${d.unchanged ? ` (без изменений: ${d.unchanged})` : ""}`);
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={{ ...modalCard, width: 640, maxWidth: "95vw" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>📋 Инвентаризация: {place.name}</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
          Оставьте поле «факт» пустым, чтобы не трогать позицию.
        </div>

        {rows.length === 0 ? (
          <div style={{ fontSize: 12, color: C.faint, padding: "10px 4px" }}>На этом месте нет позиций.</div>
        ) : (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: C.surfaceAlt }}>
                  <th style={th}>Товар</th>
                  <th style={thR}>Учёт</th>
                  <th style={thR}>Факт</th>
                  <th style={thR}>Δ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => {
                  const raw = facts[it.id] ?? "";
                  const fact = raw.trim() === "" ? null : parseInt(raw, 10);
                  const delta = fact == null || !Number.isInteger(fact) ? null : fact - it.qty;
                  return (
                    <tr key={it.id} style={{ borderTop: `1px solid ${C.line}` }}>
                      <td style={td}>{itemName(it)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{it.qty}</td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <input
                          type="number" min={0} value={raw}
                          onChange={(e) => setFact(it.id, e.target.value)}
                          style={{ ...inputStyle, width: 90, textAlign: "right" }}
                        />
                      </td>
                      <td style={{ ...td, textAlign: "right", color: delta == null || delta === 0 ? C.faint : delta > 0 ? C.pos : C.neg, fontWeight: 600 }}>
                        {delta == null ? "—" : delta > 0 ? `+${delta}` : delta}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted, marginBottom: 12 }}>
          Причина *
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. плановая сверка, недостача при приёмке"
            style={{ ...inputStyle, width: "100%" }} />
        </label>

        {error && (
          <div style={{ fontSize: 12, color: C.neg, background: "rgba(220,50,50,0.08)", border: `1px solid ${C.neg}`, borderRadius: 6, padding: "8px 10px", marginBottom: 12 }}>
            ⚠️ {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
          <button onClick={submit} disabled={busy || rows.length === 0} style={primaryBtn}>{busy ? "⏳" : "Сохранить"}</button>
        </div>
      </div>
    </div>
  );
}

function itemName(it) {
  return it.internal_name || it.skus?.[0]?.name || `позиция #${it.id}`;
}

const th = { padding: "6px 10px", textAlign: "left", fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3 };
const thR = { ...th, textAlign: "right" };
const td = { padding: "6px 10px" };
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}` };
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const resetBtnStyle = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 1000 };
const modalCard = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, maxHeight: "92vh", overflowY: "auto" };
