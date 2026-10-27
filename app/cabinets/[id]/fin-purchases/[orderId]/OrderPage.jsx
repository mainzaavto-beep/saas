"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useState } from "react";
import { ORDER_STATUS_LABELS } from "@/lib/purchaseOrders.js";
import { inp, btn } from "./styles";
import OrderLines from "./OrderLines";
import OrderPayments from "./OrderPayments";
import OrderShipments from "./OrderShipments";

// Карточка заказа закупки (спека 2026-10-27-purchase-orders-design.md §4). Все цифры — calc из API
// (lib/purchaseOrders.js calcOrder), клиент ничего не пересчитывает.

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 });
const HEAD_FIELDS = [
  ["supplier", "Поставщик"], ["order_no", "№ заказа"], ["supplier_contact", "Контакт"], ["source_country", "Где"],
  ["category", "Категория"], ["order_dt", "Дата", "date"], ["rate_cny", "План. курс ¥"],
];

export default function OrderPage({ cabinetId, orderId }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders?id=${orderId}`);
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setD(j); setErr(null);
    } catch (e) { console.error("order load", e); setErr(String(e.message || e)); }
  }, [cabinetId, orderId]);
  useEffect(() => { reload(); }, [reload]);

  const post = useCallback(async (action, body = {}) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, order_id: orderId, ...body }),
      });
      const j = await r.json();
      if (!r.ok || j.error) { alert(j.error || `Ошибка ${r.status}`); return false; }
      await reload();
      return true;
    } catch (e) { console.error("order post", e); alert(String(e.message || e)); return false; }
    finally { setBusy(false); }
  }, [cabinetId, orderId, reload]);

  if (err) return <div style={{ fontFamily: FONT, padding: 28, color: C.neg }}>Ошибка: {err}</div>;
  if (!d) return <div style={{ fontFamily: FONT, padding: 28, color: C.muted }}>Загрузка…</div>;
  const { order, calc } = d;
  const canEdit = d.role !== "viewer";
  // «Закрыт» выставляет только сервер (refreshOrderStatus) — пункт в селекте не предлагаем,
  // кроме случая, когда заказ уже закрыт (тогда показываем как текущее значение, без возможности выбрать).
  const statusOptions = Object.entries(ORDER_STATUS_LABELS).filter(([k]) => k !== "closed" || order.status === "closed");

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px" }}>
      <a href={`/cabinets/${cabinetId}/fin-purchases`} style={{ color: C.muted, fontSize: 13 }}>← Закупки</a>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", margin: "8px 0 16px" }}>
        <div style={{ flex: "1 1 520px" }}>
          <h1 style={{ fontSize: 22, margin: "0 0 10px" }}>{order.supplier}{order.order_no ? ` · ${order.order_no}` : ""}</h1>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
            {HEAD_FIELDS.map(([k, l, type]) => (
              <label key={k} style={{ fontSize: 12, color: C.muted }}>{l}
                <input key={`${k}:${order[k] ?? ""}`} type={type || "text"} defaultValue={order[k] ?? ""} disabled={!canEdit || busy}
                  style={{ ...inp, width: "100%", display: "block" }}
                  onBlur={(e) => { const v = e.target.value; if (v !== String(order[k] ?? "")) post("update", { [k]: v }); }} />
              </label>
            ))}
            <label style={{ fontSize: 12, color: C.muted }}>Статус
              <select value={order.status} disabled={!canEdit || busy || order.status === "closed"} style={{ ...inp, width: "100%", display: "block" }}
                onChange={(e) => post("update", { status: e.target.value })}>
                {statusOptions.map(([k, l]) => <option key={k} value={k} disabled={k === "closed"}>{l}</option>)}
              </select>
            </label>
          </div>
          <label style={{ fontSize: 12, color: C.muted, display: "block", marginTop: 8 }}>Примечание
            <input key={`note:${order.note ?? ""}`} defaultValue={order.note ?? ""} disabled={!canEdit || busy} style={{ ...inp, width: "100%", display: "block" }}
              onBlur={(e) => { if (e.target.value !== (order.note ?? "")) post("update", { note: e.target.value }); }} />
          </label>
        </div>
        <div style={{ flex: "0 0 300px", padding: 14, borderRadius: 10, background: soft("accent", 6), fontSize: 13, lineHeight: 1.7 }}>
          <div>Сумма: <b>{nf2.format(calc.totalCny)} ¥</b> · {nf0.format(calc.goodsRub)} ₽</div>
          <div>Эфф. курс: {nf4.format(calc.rateEff)}</div>
          <div>Оплачено: {nf2.format(calc.paidCny)} ¥ · осталось {nf2.format(calc.remainingCny)} ¥</div>
          <div>Прочие расходы: {nf0.format(calc.otherRub)} ₽</div>
          <div>Логистика: {nf0.format(calc.logisticsRub)} ₽</div>
          <div>Себестоимость всего: <b>{nf0.format(calc.totalRub)} ₽</b>{calc.qty > 0 ? ` · ср. ${nf0.format(calc.totalRub / calc.qty)} ₽/шт` : ""}</div>
          <div>Отправлено {nf0.format(calc.shippedQty)} из {nf0.format(calc.qty)} · принято {nf0.format(calc.acceptedQty)}</div>
          {calc.shortageQty > 0 && <div style={{ color: C.neg }}>Недостача: {nf0.format(calc.shortageQty)} шт · {nf0.format(calc.shortageRub)} ₽</div>}
          {canEdit && <button style={{ ...btn, marginTop: 8, color: C.neg, borderColor: C.neg }} disabled={busy}
            onClick={async () => { if (confirm("Удалить заказ целиком? Плановые платежи уйдут из календаря.") && await post("delete")) window.location.href = `/cabinets/${cabinetId}/fin-purchases`; }}>Удалить заказ</button>}
        </div>
      </div>
      {calc.warnings.length > 0 && (
        <div style={{ padding: 10, borderRadius: 8, background: soft("warn", 15), color: C.warn, fontSize: 13, marginBottom: 14 }}>
          {calc.warnings.map((w) => <div key={w}>⚠ {w}</div>)}
        </div>
      )}
      <OrderLines cabinetId={cabinetId} d={d} post={post} busy={busy} canEdit={canEdit} />
      <OrderPayments d={d} post={post} busy={busy} canEdit={canEdit} />
      <OrderShipments d={d} post={post} busy={busy} canEdit={canEdit} />
    </div>
  );
}
