"use client";
import { C, soft } from "@/lib/palette.js";
import { ALERT } from "@/lib/callout.js";
import { useState, useMemo, useEffect } from "react";

// ShipmentFormModal — многострочная форма создания отгрузки (документа).
// Переиспользуется с двух страниц:
//   • /shipments — пустая форма (presetItem = null), полный выбор товаров.
//   • /inventory — presetItem = позиция из строки (первая строка уже в составе).
//
// POST /api/cabinets/[id]/shipments { action:"create", doc_no?, platform, ship_dt,
//   dest_warehouse?, note?, lines:[{ff_inventory_id, qty}] }.
// Списание остатков атомарно на бэке; при нехватке — ошибка, ничего не создаётся.
//
// inventoryItems: позиции склада с qty>0 (для выбора в составе), формат GET /inventory.
// warehouses: string[] — список имён складов для <datalist>. Если null — форма
//   подтянет его сама из GET /shipments (используется при вызове с /inventory).
const money = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";

export function ShipmentFormModal({ cabinetId, inventoryItems, warehouses, presetItem, onClose, onDone }) {
  // Шапка документа.
  const [docNo, setDocNo] = useState("");
  const [platform, setPlatform] = useState(presetItem?.skus?.[0]?.platform || "wb");
  const [shipDt, setShipDt] = useState(new Date().toISOString().slice(0, 10));
  const [destWh, setDestWh] = useState("");
  const [note, setNote] = useState("");
  // Состав: массив строк { ff_inventory_id, qty }.
  const [lines, setLines] = useState(() =>
    presetItem ? [{ ff_inventory_id: presetItem.id, qty: "" }] : []
  );
  const [busy, setBusy] = useState(false);

  // Если список складов не передан (вызов с /inventory) — тянем из GET /shipments.
  const [whList, setWhList] = useState(warehouses || null);
  useEffect(() => {
    if (warehouses || whList) return;
    fetch(`/api/cabinets/${cabinetId}/shipments`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d.warehouses)) setWhList(d.warehouses); })
      .catch(() => {});
  }, [warehouses, whList, cabinetId]);

  // Карта позиций для быстрого поиска имени/остатка по id.
  const itemById = useMemo(() => {
    const m = {};
    for (const it of inventoryItems) m[it.id] = it;
    return m;
  }, [inventoryItems]);

  const availForLine = (excludeLineIdx) => {
    // Доступные позиции для строки: все минус уже выбранные в других строках.
    const used = new Set(lines.filter((_, i) => i !== excludeLineIdx).map((l) => l.ff_inventory_id));
    return inventoryItems.filter((it) => !used.has(it.id));
  };

  function addLine() {
    // Первая ещё не выбранная позиция — preset для новой строки.
    const avail = availForLine(-1);
    setLines([...lines, { ff_inventory_id: "", qty: "" }]);
    return avail;
  }
  function setLine(i, patch) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i) {
    setLines(lines.filter((_, idx) => idx !== i));
  }

  // Автоитог по валидным строкам.
  const totalQty = lines.reduce((acc, l) => {
    const q = parseInt(l.qty, 10);
    return acc + (Number.isFinite(q) && q > 0 ? q : 0);
  }, 0);

  async function submit() {
    // Валидация строк.
    const norm = [];
    for (const [i, l] of lines.entries()) {
      const ffId = Number(l.ff_inventory_id);
      const qty = parseInt(l.qty, 10);
      if (!ffId) { alert(`Строка ${i + 1}: выберите товар`); return; }
      if (!Number.isFinite(qty) || qty < 1) { alert(`Строка ${i + 1}: введите количество ≥ 1`); return; }
      const it = itemById[ffId];
      if (it && qty > it.qty) { alert(`Строка ${i + 1}: недостаточно остатка (на складе ${it.qty} шт)`); return; }
      norm.push({ ff_inventory_id: ffId, qty });
    }
    if (norm.length === 0) { alert("Добавьте хотя бы один товар"); return; }

    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/shipments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          doc_no: docNo, platform, ship_dt: shipDt,
          dest_warehouse: destWh, note,
          lines: norm,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "create failed");
      onDone();
    } catch (e) { alert("Не создать отгрузку: " + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={{ ...modalCard, width: 620, maxWidth: "95vw" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>📦 Новая отгрузка</div>

        {/* Шапка документа */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <Field label="№ поставки (опц.)">
            <input value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="напр. WB-1234567"
              style={{ ...inputStyle, width: 160 }} />
          </Field>
          <Field label="Маркетплейс">
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={{ ...inputStyle, width: "auto" }}>
              <option value="wb">Wildberries</option>
              <option value="ozon">Ozon</option>
            </select>
          </Field>
          <Field label="Дата отгрузки">
            <input type="date" value={shipDt} onChange={(e) => setShipDt(e.target.value)} style={{ ...inputStyle, width: "auto" }} />
          </Field>
          <Field label="Склад назначения">
            <input value={destWh} onChange={(e) => setDestWh(e.target.value)} list="ship-wh-list"
              placeholder="начните вводить…" style={{ ...inputStyle, width: 200 }} />
            <datalist id="ship-wh-list">
              {(whList || []).map((w) => <option key={w} value={w} />)}
            </datalist>
          </Field>
        </div>

        {/* Состав товаров */}
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
          Состав отгрузки
        </div>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 8, background: C.surfaceAlt }}>
          {lines.length === 0 && (
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
                  {/* Текущий выбор тоже показываем, даже если он уже не в avail (для preset). */}
                  {it && !avail.includes(it) && <option value={it.id}>{itemName(it)} · {it.qty} шт</option>}
                  {avail.map((a) => (
                    <option key={a.id} value={a.id}>{itemName(a)} · {a.qty} шт</option>
                  ))}
                </select>
                <input type="number" min={1} max={maxQty} value={l.qty}
                  onChange={(e) => setLine(i, { qty: e.target.value })}
                  placeholder="шт"
                  style={{ ...inputStyle, width: 90 }} />
                <span style={{ fontSize: 11, color: C.faint, minWidth: 80 }}>
                  {it ? `макс. ${maxQty}` : ""}
                </span>
                <button onClick={() => removeLine(i)} style={{ ...miniBtn, color: C.neg, padding: "4px 8px" }} title="Убрать строку">✕</button>
              </div>
            );
          })}
          <button onClick={addLine}
            disabled={lines.length >= inventoryItems.length}
            style={{ ...miniBtn, color: C.accent, marginTop: 4 }}
            title="Добавить товар в отгрузку">
            + добавить товар
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, fontSize: 12 }}>
          <span style={{ color: C.muted }}>Комментарий (опц.)</span>
          <span style={{ fontWeight: 700 }}>Σ: {totalQty} шт</span>
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. номер партии/короб"
          style={{ ...inputStyle, width: "100%", marginTop: 4 }} />

        <div style={{
          fontSize: 11, marginTop: 10, padding: "8px 10px",
          background: ALERT.warn.background, border: ALERT.warn.border, color: ALERT.warn.color, borderRadius: 6,
        }}>
          ⚠️ Отгрузка формируется <strong>по факту отгрузки товара на маркетплейс и приёмки</strong>.
          Количество по всем строкам списывается с остатка склада/ФФ. Если на какой-то позиции не хватит остатка — документ не создастся.
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
          <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? "⏳" : "Создать отгрузку"}</button>
        </div>
      </div>
    </div>
  );
}

function itemName(it) {
  return it.sku_name || it.internal_name || `позиция #${it.id}`;
}

function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>{label}{children}</label>;
}

// ---------------- Стили ----------------
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120 };
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "#0A1A1C", border: "none" };
const resetBtnStyle = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 1000 };
const modalCard = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, width: 380, maxWidth: "90vw", maxHeight: "92vh", overflowY: "auto" };
