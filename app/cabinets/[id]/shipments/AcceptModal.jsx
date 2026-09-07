"use client";
import { C, soft } from "@/lib/palette.js";
import { ALERT } from "@/lib/callout.js";
import { useState, useMemo } from "react";

// AcceptModal — приёмка документа отгрузки (спека «Склады 2.0» §4.2–4.3).
//
// POST /api/cabinets/[id]/shipments { action:'accept', id, accepted:[{line_id,qty_accepted}] }.
// Сервер жёстко проверяет qty_accepted ≤ qty строки документа (принять больше отгруженного
// нельзя — это опечатка либо чужая поставка); пустое значение = null (сброс отметки).
//
// Предзаполнение из факта WB (doc.supply.lines_by_nm[nm]) — только если у строки есть
// привязка к nm_id (ищем в items[].skus). Если nm не определён — поле остаётся пустым,
// значение не выдумывается. Для уже сохранённого qty_accepted (повторное открытие модалки)
// приоритет у сохранённого значения — WB-факт не затирает ручную правку.
//
// items: ВСЕ позиции склада (не только qty>0) — GET /inventory items[], нужны привязки skus[].
export function AcceptModal({ cabinetId, doc, items, onClose, onDone }) {
  const itemById = useMemo(() => {
    const m = {};
    for (const it of items || []) m[it.id] = it;
    return m;
  }, [items]);

  const supply = doc.supply;
  const isWbIncome = supply?.kind === "wb_income";

  // nm_id по строке документа (для сверки с фактом WB). null, если привязки нет.
  const nmOf = (line) => {
    const it = itemById[line.ff_inventory_id];
    if (!it) return null;
    const wbSku = (it.skus || []).find((s) => s.platform === "wb" && s.nm_id != null);
    if (wbSku) return wbSku.nm_id;
    return it.platform === "wb" && it.nm_id != null ? it.nm_id : null;
  };

  const [rows, setRows] = useState(() =>
    (doc.lines || []).map((l) => {
      let init = l.qty_accepted != null ? String(l.qty_accepted) : "";
      if (init === "" && isWbIncome) {
        const nm = nmOf(l);
        const fact = nm != null ? supply.lines_by_nm?.[nm] : null;
        if (fact != null) init = String(fact);
      }
      return { line_id: l.id, value: init };
    })
  );
  const [busy, setBusy] = useState(false);

  function setVal(lineId, v) {
    setRows((r) => r.map((row) => (row.line_id === lineId ? { ...row, value: v } : row)));
  }

  async function submit() {
    const accepted = [];
    for (const [i, row] of rows.entries()) {
      const line = doc.lines.find((l) => l.id === row.line_id);
      if (row.value.trim() === "") { accepted.push({ line_id: row.line_id, qty_accepted: null }); continue; }
      const q = Number(row.value);
      if (!Number.isInteger(q) || q < 0) { alert(`Строка ${i + 1}: количество должно быть целым ≥ 0`); return; }
      if (line && q > Number(line.qty)) {
        alert(`Строка ${i + 1}: принято ${q} > отгружено ${line.qty}`); return;
      }
      accepted.push({ line_id: row.line_id, qty_accepted: q });
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/shipments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept", id: doc.id, accepted }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "accept failed");
      onDone();
    } catch (e) { alert("Не сохранить приёмку: " + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={{ ...modalCard, width: 640, maxWidth: "95vw" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
          📥 Приёмка — {doc.platform === "wb" ? "WB" : "Ozon"}{doc.doc_no ? ` №${doc.doc_no}` : ""} от {doc.ship_dt}
        </div>

        {supply ? (
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            Поставка {isWbIncome ? "WB" : "Ozon"} №{supply.number ?? supply.id}
            {supply.date ? ` от ${String(supply.date).slice(0, 10)}` : ""}
            {isWbIncome && supply.date_close ? `, закрыта ${String(supply.date_close).slice(0, 10)}` : ""}
            {isWbIncome ? ` · статус ${supply.status ?? "—"}` : ` · статус ${supply.state ?? "—"}`}
            {!isWbIncome ? ` · заявлено всего ${supply.qty ?? "—"} шт (Ozon не отдаёт разбивку по товарам)` : ""}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 10 }}>
            Документ не связан с поставкой площадки — приёмка вводится вручную.
          </div>
        )}

        <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
                <th style={{ ...th, textAlign: "left" }}>Товар</th>
                <th style={th}>Заявлено (документ)</th>
                {isWbIncome && <th style={th}>WB: принято / заявлено</th>}
                <th style={th}>Принято</th>
              </tr>
            </thead>
            <tbody>
              {(doc.lines || []).map((l) => {
                const row = rows.find((r) => r.line_id === l.id);
                const nm = isWbIncome ? nmOf(l) : null;
                const factAcc = nm != null ? supply.lines_by_nm?.[nm] : null;
                const factDecl = nm != null ? supply.declared_by_nm?.[nm] : null;
                const diff = factAcc != null && factDecl != null ? factAcc - factDecl : null;
                return (
                  <tr key={l.id} style={{ borderTop: `1px solid ${soft("line", 20)}` }}>
                    <td style={{ padding: "6px 8px" }}>{l.item_name || `позиция #${l.ff_inventory_id}`}</td>
                    <td style={{ ...td, textAlign: "right" }}>{l.qty}</td>
                    {isWbIncome && (
                      <td style={{ ...td, textAlign: "right", color: C.faint }}>
                        {nm == null
                          ? <span title="nm_id не привязан к позиции">—</span>
                          : <>
                              {factAcc ?? "—"} / {factDecl ?? "—"}
                              {diff != null && (
                                <span style={{ marginLeft: 6, color: diff < 0 ? C.neg : C.pos, fontWeight: 700 }}>
                                  Δ{diff > 0 ? "+" : ""}{diff}
                                </span>
                              )}
                            </>}
                      </td>
                    )}
                    <td style={{ padding: "4px 8px", textAlign: "right" }}>
                      <input type="number" min={0} max={l.qty} value={row?.value ?? ""}
                        onChange={(e) => setVal(l.id, e.target.value)}
                        placeholder="—"
                        style={{ ...inputStyle, width: 90, textAlign: "right" }} />
                    </td>
                  </tr>
                );
              })}
              {(!doc.lines || doc.lines.length === 0) && (
                <tr><td colSpan={isWbIncome ? 4 : 3} style={{ padding: 16, textAlign: "center", color: C.muted }}>
                  В документе нет строк.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{
          fontSize: 11, marginTop: 10, padding: "8px 10px",
          background: ALERT.info.background, border: ALERT.info.border, color: ALERT.info.color, borderRadius: 6,
        }}>
          Принято не может превышать заявленное по строке документа. Пустое поле — отметка «не введено»
          (статус документа не станет «принято/частично», пока не заполнены все строки).
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
          <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? "⏳" : "Сохранить приёмку"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Стили ----------------
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}` };
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const resetBtnStyle = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const th = { padding: "8px", fontWeight: 600, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3, textAlign: "right" };
const td = { padding: "6px 8px" };
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 1000 };
const modalCard = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, width: 380, maxWidth: "90vw", maxHeight: "92vh", overflowY: "auto" };
