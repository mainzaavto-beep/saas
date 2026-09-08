"use client";
import { C } from "@/lib/palette.js";
import { ALERT } from "@/lib/callout.js";
import { useState, useMemo } from "react";

// TransferFormModal — перемещение товара между местами хранения (ФФ→ФФ, склад→ФФ …).
// Спека «Склады 2.0» §3.6. Документ: откуда, куда, дата, комментарий, строки.
//
// POST /api/cabinets/[id]/transfers { action:"create", from_location_id, to_location_id,
//   moved_at, note?, lines:[{ff_inventory_id, qty}] }.
// На бэке — движения transfer_out/transfer_in через журнал; при нехватке остатка
// документ не создаётся вовсе (предпроверка → 400).
//
// items: позиции склада (формат GET /inventory) — фильтруются по выбранному «откуда».
// locations: справочник мест (id, name, loc_type).
// fromLocationId (опц.) — предвыбор «откуда» (задача 6 плана, карточка места на /warehouses);
// без пропа поведение прежнее (пустой выбор).
export function TransferFormModal({ cabinetId, items, locations, onClose, onDone, fromLocationId }) {
  const [fromId, setFromId] = useState(fromLocationId ? String(fromLocationId) : "");
  const [toId, setToId] = useState("");
  const [movedAt, setMovedAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);

  // Позиции, доступные к перемещению: лежат на месте-источнике и есть остаток.
  const srcItems = useMemo(
    () => (fromId ? items.filter((it) => it.location_id === Number(fromId) && it.qty > 0) : []),
    [items, fromId]
  );
  const itemById = useMemo(() => {
    const m = {};
    for (const it of srcItems) m[it.id] = it;
    return m;
  }, [srcItems]);

  // Смена источника обнуляет состав: старые позиции лежат на другом месте.
  function changeFrom(v) {
    setFromId(v);
    setLines([]);
    if (v && String(toId) === String(v)) setToId("");
  }

  const availForLine = (excludeLineIdx) => {
    const used = new Set(lines.filter((_, i) => i !== excludeLineIdx).map((l) => Number(l.ff_inventory_id)));
    return srcItems.filter((it) => !used.has(it.id));
  };
  const setLine = (i, patch) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLine = (i) => setLines(lines.filter((_, idx) => idx !== i));
  const addLine = () => setLines([...lines, { ff_inventory_id: "", qty: "" }]);

  const totalQty = lines.reduce((acc, l) => {
    const q = parseInt(l.qty, 10);
    return acc + (Number.isFinite(q) && q > 0 ? q : 0);
  }, 0);

  async function submit() {
    if (!fromId) { alert("Выберите место-источник"); return; }
    if (!toId) { alert("Выберите место назначения"); return; }
    if (Number(fromId) === Number(toId)) { alert("Места «откуда» и «куда» должны различаться"); return; }
    const norm = [];
    for (const [i, l] of lines.entries()) {
      const ffId = Number(l.ff_inventory_id);
      const qty = parseInt(l.qty, 10);
      if (!ffId) { alert(`Строка ${i + 1}: выберите товар`); return; }
      if (!Number.isFinite(qty) || qty < 1) { alert(`Строка ${i + 1}: введите количество ≥ 1`); return; }
      const it = itemById[ffId];
      if (it && qty > it.qty) { alert(`Строка ${i + 1}: недостаточно остатка (на месте ${it.qty} шт)`); return; }
      norm.push({ ff_inventory_id: ffId, qty });
    }
    if (norm.length === 0) { alert("Добавьте хотя бы один товар"); return; }

    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/transfers`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          from_location_id: Number(fromId), to_location_id: Number(toId),
          moved_at: movedAt, note, lines: norm,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "create failed");
      onDone();
    } catch (e) { alert("Не переместить: " + e.message); }
    finally { setBusy(false); }
  }

  const locOptions = (exclude) => ["stock", "ff"].map((t) => {
    const locs = locations.filter((l) => l.loc_type === t && String(l.id) !== String(exclude));
    if (!locs.length) return null;
    return (
      <optgroup key={t} label={t === "stock" ? "Склады" : "Фулфилмент"}>
        {locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </optgroup>
    );
  });

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={{ ...modalCard, width: 620, maxWidth: "95vw" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>⇄ Перемещение между местами</div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <Field label="Откуда">
            <select value={fromId} onChange={(e) => changeFrom(e.target.value)} style={{ ...inputStyle, width: 200 }}>
              <option value="">— выберите место —</option>
              {locOptions(null)}
            </select>
          </Field>
          <Field label="Куда">
            <select value={toId} onChange={(e) => setToId(e.target.value)} style={{ ...inputStyle, width: 200 }}>
              <option value="">— выберите место —</option>
              {locOptions(fromId)}
            </select>
          </Field>
          <Field label="Дата перемещения">
            <input type="date" value={movedAt} onChange={(e) => setMovedAt(e.target.value)}
              style={{ ...inputStyle, width: "auto" }} />
          </Field>
        </div>

        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
          Состав перемещения
        </div>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 8, background: C.surfaceAlt }}>
          {!fromId && (
            <div style={{ fontSize: 12, color: C.faint, padding: "6px 4px" }}>
              Сначала выберите место-источник.
            </div>
          )}
          {fromId && srcItems.length === 0 && (
            <div style={{ fontSize: 12, color: C.faint, padding: "6px 4px" }}>
              На этом месте нет позиций с остатком.
            </div>
          )}
          {fromId && lines.length === 0 && srcItems.length > 0 && (
            <div style={{ fontSize: 12, color: C.faint, padding: "6px 4px" }}>
              Добавьте хотя бы один товар.
            </div>
          )}
          {lines.map((l, i) => {
            const it = itemById[l.ff_inventory_id];
            const maxQty = it?.qty || 0;
            const avail = availForLine(i);
            return (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <select value={l.ff_inventory_id} onChange={(e) => setLine(i, { ff_inventory_id: Number(e.target.value) })}
                  style={{ ...inputStyle, flex: 1, minWidth: 200 }}>
                  <option value="">— выберите товар —</option>
                  {avail.map((a) => (
                    <option key={a.id} value={a.id}>{itemName(a)} · {a.qty} шт</option>
                  ))}
                </select>
                <input type="number" min={1} max={maxQty} value={l.qty}
                  onChange={(e) => setLine(i, { qty: e.target.value })}
                  placeholder="шт" style={{ ...inputStyle, width: 90 }} />
                <span style={{ fontSize: 11, color: C.faint, minWidth: 80 }}>
                  {it ? `макс. ${maxQty}` : ""}
                </span>
                <button onClick={() => removeLine(i)} style={{ ...miniBtn, color: C.neg, padding: "4px 8px" }}
                  title="Убрать строку">✕</button>
              </div>
            );
          })}
          <button onClick={addLine}
            disabled={!fromId || lines.length >= srcItems.length}
            style={{ ...miniBtn, color: C.accent, marginTop: 4 }}
            title="Добавить товар в перемещение">
            + строка
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, fontSize: 12 }}>
          <span style={{ color: C.muted }}>Комментарий (опц.)</span>
          <span style={{ fontWeight: 700 }}>Σ: {totalQty} шт</span>
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. перевоз на ФФ, короб №3"
          style={{ ...inputStyle, width: "100%", marginTop: 4 }} />

        <div style={{
          fontSize: 11, marginTop: 10, padding: "8px 10px",
          background: ALERT.info.background, border: ALERT.info.border, color: ALERT.info.color, borderRadius: 6,
        }}>
          Перемещение <strong>мгновенное</strong> (без стадии «в пути»): количество списывается с позиции
          на месте-источнике и приходуется на месте назначения. Если на какой-то строке не хватит остатка —
          документ не создастся.
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
          <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? "⏳" : "Переместить"}</button>
        </div>
      </div>
    </div>
  );
}

function itemName(it) {
  return it.internal_name || it.sku_name || `позиция #${it.id}`;
}

function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>{label}{children}</label>;
}

// ---------------- Стили (как в ShipmentFormModal) ----------------
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120 };
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const resetBtnStyle = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 1000 };
const modalCard = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, width: 380, maxWidth: "90vw", maxHeight: "92vh", overflowY: "auto" };
