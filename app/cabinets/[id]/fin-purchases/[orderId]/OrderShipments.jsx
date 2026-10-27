"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";
import { SHIP_STATUS_LABELS, cargoRub } from "@/lib/purchaseOrders.js";
import { inp, btn } from "./styles";

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

// Отправки заказа: состав «позиция → шт», логистика до МСК / МСК→ФФ (помощник $/кг), «✓ Прибыла».
export default function OrderShipments({ d, post, busy, canEdit }) {
  const lineBy = new Map(d.lines.map((l) => [Number(l.id), l]));
  const calcBy = new Map(d.calc.shipments.map((s) => [s.id, s]));
  return (
    <section>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Отправки</h2>
      {d.shipments.map((s) => (
        <Shipment key={s.id} s={s} c={calcBy.get(Number(s.id))} sl={d.shipmentLines.filter((x) => Number(x.shipment_id) === Number(s.id))}
          lineBy={lineBy} post={post} busy={busy} canEdit={canEdit} />
      ))}
      {canEdit && <button style={{ ...btn, borderColor: C.accent }} disabled={busy}
        onClick={() => post("ship_add", {})}>+ Отправка (всё неотправленное)</button>}
    </section>
  );
}

function Shipment({ s, c, sl, lineBy, post, busy, canEdit }) {
  const [kg, setKg] = useState({ usd: "", rate: "" });
  const locked = s.status === "accepted";
  const totalKg = sl.reduce((t, x) => t + x.qty_shipped * (Number(lineBy.get(Number(x.line_id))?.weight_kg) || 0), 0);
  const field = (k, l, w, type = "text") => (
    <label style={{ fontSize: 12, color: C.muted }}>{l}
      <input key={`${k}:${s[k] ?? ""}`} type={type} defaultValue={s[k] ?? ""} disabled={!canEdit || busy} style={{ ...inp, width: w, display: "block" }}
        onBlur={(e) => { if (e.target.value !== String(s[k] ?? "")) post("ship_update", { id: s.id, [k]: e.target.value }); }} />
    </label>
  );
  const setQty = (lineId, v) => {
    const lines = sl.map((x) => ({ line_id: Number(x.line_id), qty_shipped: Number(x.line_id) === lineId ? Number(v) : x.qty_shipped }))
      .filter((x) => x.qty_shipped > 0);
    post("ship_update", { id: s.id, lines });
  };
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <b style={{ alignSelf: "center" }}>#{s.id}</b>
        <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12, alignSelf: "center",
          background: soft(s.status === "accepted" ? "pos" : s.status === "arrived" ? "warn" : "accent", 18) }}>{SHIP_STATUS_LABELS[s.status]}</span>
        {field("shipment_no", "Трек / №", 120)}{field("carrier", "Перевозчик", 120)}
        {field("ship_dt", "Отправлена", 140, "date")}{field("eta", "Ожидается", 140, "date")}{field("arrived_dt", "Прибыла", 140, "date")}
        {field("cargo_rub", "До МСК, ₽", 100)}{field("ff_rub", "МСК→ФФ, ₽", 100)}
      </div>
      {canEdit && (
        <div style={{ fontSize: 12, color: C.muted, margin: "8px 0" }}>
          Карго по весу: {nf2.format(totalKg)} кг ×
          <input value={kg.usd} onChange={(e) => setKg({ ...kg, usd: e.target.value })} placeholder="$/кг" style={{ ...inp, width: 60, margin: "0 4px" }} />×
          <input value={kg.rate} onChange={(e) => setKg({ ...kg, rate: e.target.value })} placeholder="курс $" style={{ ...inp, width: 60, margin: "0 4px" }} />
          = {nf0.format(cargoRub(totalKg, kg.usd, kg.rate))} ₽
          <button style={{ ...btn, marginLeft: 6 }} disabled={busy || !(cargoRub(totalKg, kg.usd, kg.rate) > 0)}
            onClick={() => post("ship_update", { id: s.id, cargo_rub: Math.round(cargoRub(totalKg, kg.usd, kg.rate) * 100) / 100 })}>→ в «До МСК»</button>
          {totalKg === 0 && <span> (вес у позиций не указан)</span>}
        </div>
      )}
      <table style={{ borderCollapse: "collapse", fontSize: 13, marginTop: 6 }}>
        <thead><tr style={{ color: C.muted, textAlign: "left" }}>
          <th style={{ padding: 4 }}>Позиция</th><th style={{ padding: 4, textAlign: "right" }}>Шт</th>
          <th style={{ padding: 4, textAlign: "right" }}>Логистика, ₽</th><th style={{ padding: 4, textAlign: "right" }}>Принято</th>
        </tr></thead>
        <tbody>
          {sl.map((x) => {
            const l = lineBy.get(Number(x.line_id));
            const a = c?.lines.find((y) => y.line_id === Number(x.line_id));
            return (
              <tr key={x.id}>
                <td style={{ padding: 4 }}>{l?.label}{l?.variant ? ` · ${l.variant}` : ""}</td>
                <td style={{ padding: 4, textAlign: "right" }}>
                  {locked || !canEdit ? x.qty_shipped : <input key={`q:${x.qty_shipped}`} type="number" min={0} defaultValue={x.qty_shipped} disabled={busy}
                    style={{ ...inp, width: 70, textAlign: "right" }} onBlur={(e) => { if (Number(e.target.value) !== x.qty_shipped) setQty(Number(x.line_id), e.target.value); }} />}
                </td>
                <td style={{ padding: 4, textAlign: "right" }}>{nf0.format(a?.alloc || 0)}</td>
                <td style={{ padding: 4, textAlign: "right" }}>{x.qty_accepted == null ? "—" : x.qty_accepted}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Логистика делится {c?.basis === "weight" ? "по весу" : "по штукам (вес указан не у всех позиций)"}.</div>
      {canEdit && (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {s.status === "transit" && <button style={{ ...btn, borderColor: C.pos, color: C.pos }} disabled={busy} onClick={() => post("ship_arrived", { id: s.id })}>✓ Прибыла</button>}
          {s.status === "arrived" && <button style={btn} disabled={busy} onClick={() => post("ship_unarrived", { id: s.id })}>↩ В пути</button>}
          {s.status === "arrived" && <span style={{ fontSize: 12, color: C.muted, alignSelf: "center" }}>ждёт приёмки на «Доставлено на склад»</span>}
          {!locked && <button style={{ ...btn, marginLeft: "auto" }} disabled={busy} onClick={() => confirm("Удалить отправку?") && post("ship_delete", { id: s.id })}>Удалить</button>}
        </div>
      )}
    </div>
  );
}
