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
//   dest_warehouse?, dest_warehouse_id?, location_id?, status:'draft'|'shipped', note?,
//   lines:[{ff_inventory_id, qty}] }.
// Списание остатков атомарно на бэке (только при status='shipped'); при нехватке — ошибка,
// ничего не создаётся.
//
// inventoryItems: позиции склада с qty>0 (для выбора в составе), формат GET /inventory
//   (каждая позиция несёт location_id/location_name — «Откуда» строится из них, отдельного
//   списка мест не запрашиваем).
// warehouses: { wb:[{id,name,region}], ozon:[{id,name,cluster}] } — справочники складов МП
//   для «Склада назначения». Если null — форма подтянет его сама из GET /shipments
//   (используется при вызове с /inventory).
const money = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const EMPTY_WH = { wb: [], ozon: [] };

export function ShipmentFormModal({ cabinetId, inventoryItems, warehouses, presetItem, onClose, onDone }) {
  // Шапка документа.
  const [docNo, setDocNo] = useState("");
  const [platform, setPlatform] = useState(presetItem?.skus?.[0]?.platform || "wb");
  const [shipDt, setShipDt] = useState(new Date().toISOString().slice(0, 10));
  const [fromLocationId, setFromLocationId] = useState(presetItem?.location_id ? String(presetItem.location_id) : "");
  const [destWhId, setDestWhId] = useState("");
  const [shipNow, setShipNow] = useState(true); // черновик / отгрузить сейчас
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
      .then((d) => { if (d.warehouses) setWhList(d.warehouses); })
      .catch(() => {});
  }, [warehouses, whList, cabinetId]);
  const whByPlatform = whList || EMPTY_WH;

  // «Откуда» строим из мест, где реально лежат позиции с остатком (inventoryItems).
  const locations = useMemo(() => {
    const m = new Map();
    for (const it of inventoryItems) {
      if (it.location_id == null) continue;
      if (!m.has(it.location_id)) {
        m.set(it.location_id, { id: it.location_id, name: it.location_name || `Место ${it.location_id}`, loc_type: it.loc_type });
      }
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [inventoryItems]);

  // Позиции выбранного места (для состава). Смена «Откуда» сбрасывает состав —
  // старые строки могли лежать на другом месте (как в TransferFormModal).
  const locItems = useMemo(
    () => (fromLocationId ? inventoryItems.filter((it) => it.location_id === Number(fromLocationId)) : []),
    [inventoryItems, fromLocationId]
  );
  function changeFrom(v) {
    setFromLocationId(v);
    setLines([]);
  }
  function changePlatform(v) {
    setPlatform(v);
    setDestWhId("");
  }

  // Карта позиций для быстрого поиска имени/остатка по id.
  const itemById = useMemo(() => {
    const m = {};
    for (const it of inventoryItems) m[it.id] = it;
    return m;
  }, [inventoryItems]);

  const availForLine = (excludeLineIdx) => {
    // Доступные позиции для строки: все на выбранном месте минус уже выбранные в других строках.
    const used = new Set(lines.filter((_, i) => i !== excludeLineIdx).map((l) => l.ff_inventory_id));
    return locItems.filter((it) => !used.has(it.id));
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

  // Выбранный склад назначения — объект из справочника (для id + отображаемого имени).
  const destWh = (whByPlatform[platform] || []).find((w) => String(w.id) === String(destWhId)) || null;

  async function submit() {
    if (!fromLocationId) { alert("Выберите место-источник («Откуда»)"); return; }
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
          location_id: Number(fromLocationId),
          dest_warehouse_id: destWh ? destWh.id : null,
          dest_warehouse: destWh ? destWh.name : null,
          status: shipNow ? "shipped" : "draft",
          note,
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
            <select value={platform} onChange={(e) => changePlatform(e.target.value)} style={{ ...inputStyle, width: "auto" }}>
              <option value="wb">Wildberries</option>
              <option value="ozon">Ozon</option>
            </select>
          </Field>
          <Field label="Дата отгрузки">
            <input type="date" value={shipDt} onChange={(e) => setShipDt(e.target.value)} style={{ ...inputStyle, width: "auto" }} />
          </Field>
          <Field label="Откуда">
            <select value={fromLocationId} onChange={(e) => changeFrom(e.target.value)} style={{ ...inputStyle, width: 190 }}>
              <option value="">— выберите место —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}{l.loc_type === "ff" ? " (ФФ)" : ""}</option>
              ))}
            </select>
          </Field>
          <Field label="Склад назначения">
            <select value={destWhId} onChange={(e) => setDestWhId(e.target.value)} style={{ ...inputStyle, width: 220 }}>
              <option value="">— склад не выбран —</option>
              {(whByPlatform[platform] || []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}{w.region ? ` · ${w.region}` : w.cluster ? ` · ${w.cluster}` : ""}</option>
              ))}
            </select>
          </Field>
        </div>

        <div style={{ display: "flex", gap: 14, marginBottom: 12, fontSize: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="radio" checked={shipNow} onChange={() => setShipNow(true)} /> Отгрузить сейчас (спишет остаток)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="radio" checked={!shipNow} onChange={() => setShipNow(false)} /> Сохранить как черновик
          </label>
        </div>

        {/* Состав товаров */}
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
          Состав отгрузки
        </div>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 8, background: C.surfaceAlt }}>
          {!fromLocationId && (
            <div style={{ fontSize: 12, color: C.faint, padding: "6px 4px" }}>
              Сначала выберите место-источник («Откуда»).
            </div>
          )}
          {fromLocationId && locItems.length === 0 && (
            <div style={{ fontSize: 12, color: C.faint, padding: "6px 4px" }}>
              На этом месте нет позиций с остатком.
            </div>
          )}
          {fromLocationId && lines.length === 0 && locItems.length > 0 && (
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
            disabled={!fromLocationId || lines.length >= locItems.length}
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
          {shipNow
            ? <>⚠️ Количество по всем строкам <strong>спишется с остатка склада/ФФ сразу</strong>. Если на какой-то позиции не хватит остатка — документ не создастся.</>
            : <>Черновик <strong>не списывает остаток</strong> — количество спишется, когда документ будет отгружен («Отгрузить» в списке отгрузок).</>}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
          <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? "⏳" : shipNow ? "Создать и отгрузить" : "Сохранить черновик"}</button>
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
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const resetBtnStyle = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 1000 };
const modalCard = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, width: 380, maxWidth: "90vw", maxHeight: "92vh", overflowY: "auto" };
