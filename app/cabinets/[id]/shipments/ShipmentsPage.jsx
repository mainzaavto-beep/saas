"use client";
import { C, soft } from "@/lib/palette.js";

// /cabinets/[id]/shipments — Отгрузки (как документы).
//
// Отгрузка = документ: № поставки + дата + склад назначения + платформа, с составом
// из многих товаров (1 поставка → много позиций). Создаётся здесь и со страницы
// /inventory (кнопка 📦 в строке остатка → ShipmentFormModal с предзаполненной
// первой строкой), а также из «Рекомендаций» (SupplyPlanSection → черновик).
//
// С 2026-09-07 (спека «Склады 2.0» §4) документ проходит стадии
// draft → shipped → accepted|partial|rejected, может быть связан с фактом приёмки
// площадки (link_supply) и принят по строкам вручную (accept, AcceptModal).
//
// Источник: GET /api/cabinets/[id]/shipments → { docs[], totals, warehouses:{wb,ozon} }.
// Запись: POST /api/cabinets/[id]/shipments { action } — create | ship | update |
//   link_supply | accept | delete (role: manager). `update` правит шапку ЧЕРНОВИКА
//   (склад назначения, № документа, дата, примечание) — форма по кнопке «Изменить».
// Доступные позиции склада (для состава/приёмки): GET /api/cabinets/[id]/inventory → items[].
// Роль текущего пользователя (для гейтинга кнопок): GET /api/cabinets/[id]/me → { role }.
import { useEffect, useState, useCallback, useMemo } from "react";
import { ShipmentFormModal } from "./ShipmentFormModal.jsx";
import { AcceptModal } from "./AcceptModal.jsx";
import { SupplyPlanSection } from "./SupplyPlanSection.jsx";

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const num = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const dash = (v) => (v == null || v === "" ? "—" : v);

const STATUS_LABEL = { draft: "Черновик", shipped: "Отгружено", accepted: "Принято", partial: "Частично", rejected: "Отклонено" };
const STATUS_TOKEN = { draft: "muted", shipped: "accent", accepted: "pos", partial: "warn", rejected: "neg" };
const KIND_BY_PLATFORM = { wb: "wb_income", ozon: "ozon_supply_order" };

export default function ShipmentsPage({ cabinetId, embedded = false }) {
  const [data, setData] = useState(null);
  const [inv, setInv] = useState(null);  // позиции склада для состава формы/приёмки
  const [role, setRole] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [preset, setPreset] = useState(null);
  const [acceptDoc, setAcceptDoc] = useState(null); // документ, открытый в AcceptModal

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/cabinets/${cabinetId}/shipments`).then((r) => r.json()),
      fetch(`/api/cabinets/${cabinetId}/inventory`).then((r) => r.json()),
      fetch(`/api/cabinets/${cabinetId}/me`).then((r) => r.json()).catch(() => ({})),
    ])
      .then(([d, i, me]) => {
        if (d.error) setError(d.error);
        if (i.error && !d.error) setError(i.error);
        setData(d.error ? null : d);
        setInv(i.error ? null : i);
        setRole(me?.role || null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId]);

  useEffect(() => { reload(); }, [reload]);

  const docs = data?.docs || [];
  const warehouses = data?.warehouses || { wb: [], ozon: [] };
  const allItems = inv?.items || [];
  const inventoryItems = useMemo(
    () => allItems.filter((it) => (Number(it.qty) || 0) > 0),
    [allItems]
  );
  const canManage = role === "manager" || role === "owner";

  const totals = useMemo(() => {
    let qty = 0, cost = 0;
    for (const d of docs) {
      qty += Number(d.total_qty) || 0;
      cost += Number(d.total_cost) || 0;
    }
    return { docs: docs.length, total_qty: qty, total_cost: Math.round(cost * 100) / 100 };
  }, [docs]);

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (loading && !data) return <Centered>Загрузка…</Centered>;
  if (!data) return <Centered>Нет данных</Centered>;

  return (
    // embedded — страница вложена во вкладку «Поставки» /warehouses, у которой свой padding:16
    // (WarehousesPage.jsx): собственный отступ здесь дал бы двойную рамку пустоты.
    <div style={{ fontFamily: FONT, color: C.ink, padding: embedded ? 0 : "20px 28px", maxWidth: 1600, margin: "0 auto" }}>
      {!embedded && <Header />}

      <SupplyPlanSection cabinetId={cabinetId} canManage={canManage} onDocCreated={reload}
        wbWarehouses={warehouses.wb || []} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Документов" value={num(totals.docs)} accent />
        <Kpi label="Σ отгружено шт" value={num(totals.total_qty)} />
        <Kpi label="Σ себест." value={money(totals.total_cost)} color={C.neg} />
      </div>

      <div style={{ ...alertStyle, marginBottom: 14 }}>
        <strong>Отгрузки</strong> — документы поставок на маркетплейс (№ поставки + дата + склад назначения + состав товаров).
        Черновик остатка не списывает; при «Отгрузить» — списывается со склада/ФФ. Приёмка (факт площадки или руками) определяет
        итоговый статус документа.
      </div>

      {canManage && (
        <div style={{ marginBottom: 14 }}>
          <button onClick={() => { setPreset(null); setShowForm(true); }} style={primaryBtn}>+ Новая отгрузка</button>
        </div>
      )}

      {/* Таблица документов */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}></th>
              <th style={thLeft}>Статус</th>
              <th style={thLeft}>№ / связь с поставкой</th>
              <th style={thLeft}>Откуда</th>
              <th style={thLeft}>Куда</th>
              <th style={thLeft}>Дата</th>
              <th style={thR}>Σ шт</th>
              <th style={thR}>Принято Σ</th>
              <th style={thLeft}>Примечание</th>
              <th style={{ ...thLeft, textAlign: "center" }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <DocRow key={d.id} doc={d} cabinetId={cabinetId} reload={reload} canManage={canManage}
                warehouses={warehouses} onAccept={() => setAcceptDoc(d)} />
            ))}
            {docs.length === 0 && (
              <tr><td colSpan={10} style={{ padding: 24, textAlign: "center", color: C.muted }}>
                Отгрузок пока нет. Нажмите «+ Новая отгрузка», используйте «Рекомендации» выше или кнопку 📦 на странице «Остатки склад/ФФ».
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <ShipmentFormModal
          cabinetId={cabinetId}
          inventoryItems={inventoryItems}
          warehouses={warehouses}
          presetItem={preset}
          onClose={() => { setShowForm(false); setPreset(null); }}
          onDone={() => { setShowForm(false); setPreset(null); reload(); }}
        />
      )}

      {acceptDoc && (
        <AcceptModal
          cabinetId={cabinetId}
          doc={acceptDoc}
          items={allItems}
          onClose={() => setAcceptDoc(null)}
          onDone={() => { setAcceptDoc(null); reload(); }}
        />
      )}
    </div>
  );
}

// Строка документа с разворачиваемым составом.
function DocRow({ doc, cabinetId, reload, canManage, warehouses, onAccept }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  async function post(body) {
    const r = await fetch(`/api/cabinets/${cabinetId}/shipments`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "request failed");
    return d;
  }

  async function ship() {
    setBusy(true);
    try { await post({ action: "ship", id: doc.id }); reload(); }
    catch (e) { alert("Не отгрузить: " + e.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    const label = `${doc.platform === "wb" ? "WB" : "Ozon"}${doc.doc_no ? " №" + doc.doc_no : ""} от ${doc.ship_dt}`;
    if (!confirm(`Удалить черновик отгрузки ${label}?`)) return;
    setBusy(true);
    try { await post({ action: "delete", id: doc.id }); reload(); }
    catch (e) { alert("Не удалить: " + e.message); }
    finally { setBusy(false); }
  }

  const linesCount = (doc.lines || []).length;
  const acceptedLines = (doc.lines || []).filter((l) => l.qty_accepted != null);
  const acceptedSum = acceptedLines.reduce((s, l) => s + (Number(l.qty_accepted) || 0), 0);

  return (
    <>
      <tr style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
        <td style={{ padding: "8px 6px", textAlign: "center" }}>
          <button onClick={() => setOpen((v) => !v)} style={{ ...miniBtn, padding: "2px 8px" }} title={open ? "Свернуть" : "Показать состав"}>
            {open ? "▼" : "▶"}
          </button>
        </td>
        <td style={tdLeft}><StatusPill status={doc.status} /></td>
        <td style={{ ...tdLeft, minWidth: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <MpBadge platform={doc.platform} />
            <span style={{ fontWeight: 600 }}>{doc.doc_no || <span style={{ color: C.faint }}>без номера</span>}</span>
          </div>
          {/* key по mp_supply_id: связали → отвязали — компонент пересоздаётся и
              выбор кандидата берётся из свежих suggestions, а не из устаревшего state */}
          <SupplyLink key={doc.mp_supply_id ?? "none"} doc={doc} cabinetId={cabinetId} reload={reload} canManage={canManage} />
        </td>
        <td style={tdLeft}>{doc.location_name || <span style={{ color: C.faint }}>—</span>}</td>
        <td style={tdLeft}>{doc.dest_warehouse || <span style={{ color: C.faint }}>—</span>}</td>
        <td style={{ ...tdLeft, whiteSpace: "nowrap" }}>{doc.ship_dt}</td>
        <td style={{ ...tdRight, fontWeight: 700 }}>{num(doc.total_qty)}</td>
        <td style={tdRight}>
          {acceptedLines.length === 0 ? <span style={{ color: C.faint }}>—</span> : (
            <span style={{ color: acceptedSum < doc.total_qty ? C.warn : C.pos }}>{num(acceptedSum)} / {num(doc.total_qty)}</span>
          )}
        </td>
        <td style={{ ...tdLeft, color: C.faint, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {doc.note || "—"}
        </td>
        <td style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
          {canManage && doc.status_saved === "draft" && (
            <button onClick={ship} disabled={busy} style={{ ...miniBtn, color: C.accent, marginRight: 4 }} title="Отгрузить (спишет остаток)">
              {busy ? "⏳" : "🚚 Отгрузить"}
            </button>
          )}
          {canManage && doc.status_saved === "draft" && (
            <button onClick={() => setEditing((v) => !v)} style={{ ...miniBtn, marginRight: 4 }}
              title="Правка шапки черновика: склад назначения, номер, дата, примечание">
              {editing ? "✕ Отмена" : "✏️ Изменить"}
            </button>
          )}
          {canManage && doc.status_saved !== "draft" && (
            <button onClick={onAccept} style={{ ...miniBtn, color: C.pos, marginRight: 4 }} title="Ввести/поправить приёмку по строкам">
              📥 Приёмка
            </button>
          )}
          {canManage && doc.status_saved === "draft" && (
            <button onClick={remove} disabled={busy} style={{ ...miniBtn, color: C.neg }} title="Удалить черновик">
              {busy ? "⏳" : "🗑"}
            </button>
          )}
        </td>
      </tr>
      {editing && (
        <tr style={{ background: C.surfaceAlt }}>
          <td></td>
          <td colSpan={9} style={{ padding: "6px 10px 12px" }}>
            <DraftEditForm doc={doc} cabinetId={cabinetId} warehouses={warehouses}
              onClose={() => setEditing(false)}
              onDone={() => { setEditing(false); reload(); }} />
          </td>
        </tr>
      )}
      {open && linesCount > 0 && (
        <tr style={{ background: C.surfaceAlt }}>
          <td></td>
          <td colSpan={9} style={{ padding: "6px 10px 10px" }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>
              Состав отгрузки
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {(doc.lines || []).map((ln) => (
                <div key={ln.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                  <span style={{ color: C.ink }}>{ln.item_name || `позиция #${ln.ff_inventory_id}`}</span>
                  <span>
                    <span style={{ color: C.pink, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>−{num(ln.qty)} шт</span>
                    {ln.qty_accepted != null && (
                      <span style={{ marginLeft: 10, color: ln.qty_accepted < ln.qty ? C.warn : C.pos, fontVariantNumeric: "tabular-nums" }}>
                        принято {num(ln.qty_accepted)}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Правка шапки ЧЕРНОВИКА: склад назначения (из справочника своей площадки), № документа,
// дата отгрузки, примечание. POST { action:'update', ... } — сервер отклонит правку
// не-черновика (400), даже если кнопка как-то показалась.
function DraftEditForm({ doc, cabinetId, warehouses, onClose, onDone }) {
  const list = (warehouses && warehouses[doc.platform]) || [];
  const [whId, setWhId] = useState(doc.dest_warehouse_id != null ? String(doc.dest_warehouse_id) : "");
  const [docNo, setDocNo] = useState(doc.doc_no || "");
  const [shipDt, setShipDt] = useState(String(doc.ship_dt || "").slice(0, 10));
  const [note, setNote] = useState(doc.note || "");
  const [busy, setBusy] = useState(false);

  async function save() {
    const picked = whId ? list.find((w) => String(w.id) === String(whId)) : null;
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/shipments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: doc.id,
          dest_warehouse_id: picked ? picked.id : null,
          dest_warehouse: picked ? picked.name : null,
          doc_no: docNo,
          ship_dt: shipDt,
          note,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "update failed");
      onDone();
    } catch (e) { alert("Не сохранить: " + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <label style={fieldLabel}>
        Склад назначения
        <select value={whId} onChange={(e) => setWhId(e.target.value)} style={{ ...inputStyle, maxWidth: 260 }}>
          <option value="">— не выбран —</option>
          {list.map((w) => (
            <option key={w.id} value={String(w.id)}>{w.name}{w.region || w.cluster ? ` · ${w.region || w.cluster}` : ""}</option>
          ))}
        </select>
      </label>
      <label style={fieldLabel}>
        № документа
        <input value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="без номера" style={inputStyle} />
      </label>
      <label style={fieldLabel}>
        Дата отгрузки
        <input type="date" value={shipDt} onChange={(e) => setShipDt(e.target.value)} style={inputStyle} />
      </label>
      <label style={{ ...fieldLabel, flex: "1 1 220px" }}>
        Примечание
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="—" style={{ ...inputStyle, width: "100%" }} />
      </label>
      <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? "⏳" : "Сохранить"}</button>
      <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
    </div>
  );
}

// Связь документа с фактом приёмки/поставки площадки: показывает факт (если связан)
// либо подсказки кандидатов + ручной ввод номера (если нет). suggestions — топ-3 из GET.
function SupplyLink({ doc, cabinetId, reload, canManage }) {
  const [busy, setBusy] = useState(false);
  // По умолчанию — топ-1 кандидат (лучшее совпадение), «указать вручную» — последней
  // опцией в списке (решение ревью раунд 1, 2026-09-07).
  const [pick, setPick] = useState(() =>
    doc.suggestions && doc.suggestions.length > 0 ? String(doc.suggestions[0].id) : "__manual"
  );
  const [manualId, setManualId] = useState("");

  async function link(mpSupplyId) {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/shipments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "link_supply", id: doc.id, mp_supply_id: mpSupplyId, mp_supply_kind: KIND_BY_PLATFORM[doc.platform] }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "link failed");
      reload();
    } catch (e) { alert("Не связать: " + e.message); }
    finally { setBusy(false); }
  }

  async function unlink() {
    if (!confirm("Отвязать документ от поставки площадки?")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/shipments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "link_supply", id: doc.id, mp_supply_id: null, mp_supply_kind: doc.mp_supply_kind }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "unlink failed");
      reload();
    } catch (e) { alert("Не отвязать: " + e.message); }
    finally { setBusy(false); }
  }

  if (doc.supply) {
    const s = doc.supply;
    const isWb = s.kind === "wb_income";
    return (
      <div style={{ fontSize: 11, color: C.muted }}>
        Поставка №{s.number ?? s.id}{s.date ? ` от ${String(s.date).slice(0, 10)}` : ""}
        {isWb
          ? <> · принято {s.qty ?? "—"} / заявлено {s.qty_declared ?? "—"}</>
          : <> · {s.state ?? "—"} · заявлено {s.qty ?? "—"}</>}
        {canManage && (
          <button onClick={unlink} disabled={busy} style={{ ...miniBtn, marginLeft: 6, padding: "1px 6px", fontSize: 10, color: C.neg }}>
            {busy ? "⏳" : "отвязать"}
          </button>
        )}
      </div>
    );
  }

  if (!canManage) {
    return <span style={{ fontSize: 11, color: C.faint }}>не связан</span>;
  }

  const suggestions = doc.suggestions || [];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...miniSelect }}>
        {suggestions.map((c) => (
          <option key={c.id} value={c.id}>
            №{c.number ?? c.id} · {String(c.date || "").slice(0, 10)} · {c.qty ?? "—"} шт (совп. {c.score})
          </option>
        ))}
        <option value="__manual">— указать номер вручную —</option>
      </select>
      {pick === "__manual" && (
        <input value={manualId} onChange={(e) => setManualId(e.target.value)} placeholder="№ поставки/приёмки"
          style={{ ...miniSelect, width: 110 }} />
      )}
      <button onClick={() => link(pick === "__manual" ? manualId.trim() : pick)} disabled={busy || (pick === "__manual" && !manualId.trim())}
        style={{ ...miniBtn, padding: "2px 8px", fontSize: 11 }}>
        {busy ? "⏳" : "Связать"}
      </button>
    </div>
  );
}

// =====================================================================
//  Заголовок / KPI / мелочи
// =====================================================================
function Header() {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Отгрузки</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Документы поставок на маркетплейс. Одна отгрузка — много товаров. Остатки склада списываются при отгрузке.
      </p>
    </div>
  );
}
function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
function Kpi({ label, value, accent, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 140px", minWidth: 120 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ? C.accent : color || C.ink }}>{value}</div>
    </div>
  );
}
function MpBadge({ platform }) {
  const isWb = platform === "wb";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6,
      background: isWb ? soft("accent", 15) : soft("pink", 15),
      color: isWb ? C.accent : C.pink,
    }}>{isWb ? "WB" : "OZON"}</span>
  );
}
function StatusPill({ status }) {
  const token = STATUS_TOKEN[status] || "muted";
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap",
      background: soft(token, 15), color: C[token] || C.muted,
    }}>{STATUS_LABEL[status] || status}</span>
  );
}

// ---------------- Стили ----------------
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120 };
const fieldLabel = { display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3 };
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const resetBtnStyle = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const miniSelect = { padding: "2px 6px", borderRadius: 5, fontSize: 11, background: C.bg, color: C.ink, border: `1px solid ${C.line}` };
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeft = { padding: "8px 10px", verticalAlign: "middle", textAlign: "left" };
const alertStyle = { padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted };
