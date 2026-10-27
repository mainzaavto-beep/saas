"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useState } from "react";
import PurchasesPage from "./PurchasesPage";
import { ORDER_STATUS_LABELS } from "@/lib/purchaseOrders.js";

// /cabinets/[id]/fin-purchases — закупки заказами (спека 2026-10-27-purchase-orders-design.md §4):
// список заказов + вкладка «Архив до 16.10» (старые партии, только чтение).

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const ddmm = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const inp = { padding: "6px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
const STATUS_TONE = { draft: "muted", ordered: "accent", production: "warn", shipping: "blue", closed: "pos" };

export default function OrdersPage({ cabinetId }) {
  const [tab, setTab] = useState("orders");
  const [f, setF] = useState({ status: "", supplier: "", category: "", closed: false });
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ status: f.status, supplier: f.supplier, category: f.category, closed: f.closed ? "1" : "" });
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders?${qs}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d); setErr(null);
    } catch (e) { console.error("purchase-orders load", e); setErr(String(e.message || e)); }
  }, [cabinetId, f]);
  useEffect(() => { if (tab === "orders") reload(); }, [reload, tab]);

  async function createOrder() {
    const supplier = prompt("Поставщик");
    if (!supplier || !supplier.trim()) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", supplier, order_dt: new Date().toISOString().slice(0, 10) }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert(d.error || `Ошибка ${r.status}`); return; }
      window.location.href = `/cabinets/${cabinetId}/fin-purchases/${d.id}`;
    } catch (e) { console.error("purchase-orders create", e); alert(String(e.message || e)); }
  }

  const items = data?.items || [];
  const canEdit = data && data.role !== "viewer";
  const tabBtn = (v, l) => (
    <button onClick={() => setTab(v)} style={{ padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13,
      border: `1px solid ${tab === v ? C.accent : C.line}`, background: tab === v ? soft("accent", 15) : "transparent", color: C.ink }}>{l}</button>
  );

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>Закупки</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>{tabBtn("orders", "Заказы")}{tabBtn("archive", "Архив до 16.10")}</div>
      {tab === "archive" ? <PurchasesPage cabinetId={cabinetId} readOnly /> : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
            <input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} placeholder="Поставщик или № заказа" style={{ ...inp, minWidth: 220 }} list="po-suppliers" />
            <datalist id="po-suppliers">{(data?.suppliers || []).map((s) => <option key={s} value={s} />)}</datalist>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={inp}>
              <option value="">Все статусы</option>
              {Object.entries(ORDER_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={inp}>
              <option value="">Все категории</option>
              {(data?.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label style={{ fontSize: 13 }}><input type="checkbox" checked={f.closed} onChange={(e) => setF({ ...f, closed: e.target.checked })} /> закрытые</label>
            {canEdit && <button onClick={createOrder} style={{ ...inp, marginLeft: "auto", cursor: "pointer", borderColor: C.accent }}>+ Заказ</button>}
          </div>
          {err && <div style={{ color: C.neg, marginBottom: 12 }}>Ошибка: {err}</div>}
          {!data && !err && <div style={{ color: C.muted }}>Загрузка…</div>}
          {data && !items.length && <div style={{ color: C.muted }}>Заказов нет. Нажмите «+ Заказ».</div>}
          {items.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ color: C.muted, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
                <th style={{ padding: 8, width: 44 }} />
                <th style={{ padding: 8 }}>Заказ</th>
                <th style={{ padding: 8 }}>Дата</th>
                <th style={{ padding: 8, textAlign: "right" }}>Позиций / шт</th>
                <th style={{ padding: 8, textAlign: "right" }}>Сумма</th>
                <th style={{ padding: 8 }}>Оплачено</th>
                <th style={{ padding: 8, textAlign: "right" }}>Отправлено / принято</th>
                <th style={{ padding: 8, textAlign: "right" }}>Себест./шт</th>
                <th style={{ padding: 8 }}>Статус</th>
              </tr></thead>
              <tbody>
                {items.map((o) => {
                  const pct = o.totalCny > 0 ? Math.min(100, (o.paidCny / o.totalCny) * 100) : 0;
                  return (
                    <tr key={o.id} onClick={() => { window.location.href = `/cabinets/${cabinetId}/fin-purchases/${o.id}`; }}
                      style={{ cursor: "pointer", borderBottom: `1px solid ${soft("line", 50)}` }}>
                      <td style={{ padding: 8 }}>{o.photo && <img src={o.photo} alt="" style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 6 }} />}</td>
                      <td style={{ padding: 8 }}><b>{o.supplier}</b>{o.order_no && <span style={{ color: C.muted }}> · {o.order_no}</span>}{o.category && <div style={{ color: C.muted, fontSize: 12 }}>{o.category}</div>}</td>
                      <td style={{ padding: 8 }}>{ddmm(o.order_dt)}</td>
                      <td style={{ padding: 8, textAlign: "right" }}>{o.lines} / {nf0.format(o.qty)}</td>
                      <td style={{ padding: 8, textAlign: "right" }}>{nf2.format(o.totalCny)} ¥<div style={{ color: C.muted, fontSize: 12 }}>{nf0.format(o.totalRub)} ₽</div></td>
                      <td style={{ padding: 8, minWidth: 140 }}>
                        <div style={{ fontSize: 12 }}>{nf0.format(o.paidCny)} из {nf0.format(o.totalCny)} ¥</div>
                        <div style={{ height: 4, background: soft("line", 60), borderRadius: 2 }}><div style={{ width: `${pct}%`, height: 4, background: C.pos, borderRadius: 2 }} /></div>
                      </td>
                      <td style={{ padding: 8, textAlign: "right" }}>{nf0.format(o.shippedQty)} / {nf0.format(o.acceptedQty)}{o.shortageQty > 0 && <div style={{ color: C.neg, fontSize: 12 }}>недостача {o.shortageQty}</div>}</td>
                      <td style={{ padding: 8, textAlign: "right" }}>{o.avgUnitCost == null ? "—" : `${nf0.format(o.avgUnitCost)} ₽`}</td>
                      <td style={{ padding: 8 }}><span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12, background: soft(STATUS_TONE[o.status] || "muted", 18) }}>{ORDER_STATUS_LABELS[o.status] || o.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
