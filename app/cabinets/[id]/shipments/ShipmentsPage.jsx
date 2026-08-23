"use client";
import { C, soft } from "@/lib/palette.js";

// /cabinets/[id]/shipments — Отгрузки (как документы).
//
// Отгрузка = документ: № поставки + дата + склад назначения + платформа, с составом
// из многих товаров (1 поставка → много позиций). Создаётся здесь и со страницы
// /inventory (кнопка 📦 в строке остатка → ShipmentFormModal с предзаполненной
// первой строкой).
//
// Источник: GET /api/cabinets/[id]/shipments → { docs[], totals, warehouses[] }.
// Запись: POST /api/cabinets/[id]/shipments { action:"create" | "delete" }.
// Доступные позиции склада (для состава): GET /api/cabinets/[id]/inventory → items[].
//
// Склад назначения = TEXT с подсказками из собранных данных WB/Ozon (datalist).
// Списание остатков атомарно: при нехватке на любой строке — весь документ откатывается.
import { useEffect, useState, useCallback, useMemo } from "react";
import { ShipmentFormModal } from "./ShipmentFormModal.jsx";

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const num = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const dash = (v) => (v == null || v === "" ? "—" : v);

export default function ShipmentsPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [inv, setInv] = useState(null);  // позиции склада для состава формы
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [preset, setPreset] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/cabinets/${cabinetId}/shipments`).then((r) => r.json()),
      fetch(`/api/cabinets/${cabinetId}/inventory`).then((r) => r.json()),
    ])
      .then(([d, i]) => {
        if (d.error) setError(d.error);
        if (i.error && !d.error) setError(i.error);
        setData(d.error ? null : d);
        setInv(i.error ? null : i);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId]);

  useEffect(() => { reload(); }, [reload]);

  const docs = data?.docs || [];
  const warehouses = data?.warehouses || [];
  const inventoryItems = useMemo(
    () => (inv?.items || []).filter((it) => (Number(it.qty) || 0) > 0),
    [inv]
  );

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
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1500, margin: "0 auto" }}>
      <Header />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Документов" value={num(totals.docs)} accent />
        <Kpi label="Σ отгружено шт" value={num(totals.total_qty)} />
        <Kpi label="Σ себест." value={money(totals.total_cost)} color={C.neg} />
      </div>

      <div style={{ ...alertStyle, marginBottom: 14 }}>
        <strong>Отгрузки</strong> — документы поставок на маркетплейс (№ поставки + дата + склад назначения + состав товаров).
        Создать можно и здесь, и со страницы «Остатки склад/ФФ» (кнопка 📦 в строке).
        Складские остатки уменьшаются автоматически; при нехватке — документ не создаётся.
      </div>

      <div style={{ marginBottom: 14 }}>
        <button onClick={() => { setPreset(null); setShowForm(true); }} style={primaryBtn}>+ Новая отгрузка</button>
      </div>

      {/* Таблица документов */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}></th>
              <th style={thLeft}>№ поставки</th>
              <th style={thLeft}>Дата</th>
              <th style={thLeft}>МП</th>
              <th style={thLeft}>Склад назначения</th>
              <th style={thR}>Строк</th>
              <th style={thR}>Σ шт</th>
              <th style={thR}>Σ себест. ₽</th>
              <th style={thLeft}>Примечание</th>
              <th style={{ ...thLeft, textAlign: "center" }}></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <DocRow key={d.id} doc={d} cabinetId={cabinetId} reload={reload} />
            ))}
            {docs.length === 0 && (
              <tr><td colSpan={10} style={{ padding: 24, textAlign: "center", color: C.muted }}>
                Отгрузок пока нет. Нажмите «+ Новая отгрузка» или используйте кнопку 📦 на странице «Остатки склад/ФФ».
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
    </div>
  );
}

// Строка документа с разворачиваемым составом.
function DocRow({ doc, cabinetId, reload }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    const label = `${doc.platform === "wb" ? "WB" : "Ozon"}${doc.doc_no ? " №" + doc.doc_no : ""} от ${doc.ship_dt}`;
    if (!confirm(`Удалить отгрузку ${label}?\nКоличество по всем строкам вернётся на склад.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/shipments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: doc.id }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "delete failed");
      reload();
    } catch (e) { alert("Не удалить: " + e.message); }
    finally { setBusy(false); }
  }

  const linesCount = (doc.lines || []).length;

  return (
    <>
      <tr style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
        <td style={{ padding: "8px 6px", textAlign: "center" }}>
          <button onClick={() => setOpen((v) => !v)} style={{ ...miniBtn, padding: "2px 8px" }} title={open ? "Свернуть" : "Показать состав"}>
            {open ? "▼" : "▶"}
          </button>
        </td>
        <td style={{ padding: "8px 10px", fontWeight: 600 }}>{doc.doc_no || <span style={{ color: C.faint }}>—</span>}</td>
        <td style={{ ...tdLeft, whiteSpace: "nowrap" }}>{doc.ship_dt}</td>
        <td style={tdLeft}>
          <MpBadge platform={doc.platform} />
        </td>
        <td style={tdLeft}>{doc.dest_warehouse || <span style={{ color: C.faint }}>—</span>}</td>
        <td style={tdRight}>{num(linesCount)}</td>
        <td style={{ ...tdRight, fontWeight: 700 }}>{num(doc.total_qty)}</td>
        <td style={{ ...tdRight, fontWeight: 700, color: C.neg }}>{money(doc.total_cost)}</td>
        <td style={{ ...tdLeft, color: C.faint, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {doc.note || "—"}
        </td>
        <td style={{ padding: "8px 10px", textAlign: "center" }}>
          <button onClick={remove} disabled={busy} style={{ ...miniBtn, color: C.neg }} title="Удалить отгрузку (вернуть qty на склад)">
            {busy ? "⏳" : "🗑"}
          </button>
        </td>
      </tr>
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
                  <span style={{ color: C.pink, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>−{num(ln.qty)} шт</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
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
        Документы поставок на маркетплейс. Одна отгрузка — много товаров. Остатки склада списываются автоматически.
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

// ---------------- Стили ----------------
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120 };
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const resetBtnStyle = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeft = { padding: "8px 10px", verticalAlign: "middle", textAlign: "left" };
const alertStyle = { padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted };
