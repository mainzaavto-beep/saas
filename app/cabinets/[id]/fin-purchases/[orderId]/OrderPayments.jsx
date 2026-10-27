"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";
import { PAY_KIND_LABELS, PAID_LOCK_MSG } from "@/lib/purchaseOrders.js";
import { inp, btn } from "./styles";

const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const EMPTY = { kind: "prepay", currency: "cny", amount: "", rate: "", plan_date: "" };

// Оплаты заказа: каждая — строка календаря (статус «оплачено» — из ДДС, правится в календаре).
export default function OrderPayments({ d, post, busy, canEdit }) {
  const [add, setAdd] = useState(EMPTY);
  const ddsBy = new Map(d.dds.map((x) => [x.source_ref, x]));
  const set = (k) => (e) => setAdd({ ...add, [k]: e.target.value, ...(k === "kind" && e.target.value !== "other" ? { currency: "cny" } : {}) });
  // locked — строка уже оплачена в ДДС: сумму/курс не правим (сервер всё равно ответит 400).
  const field = (p, k, w, type = "text", locked = false) => (
    <input key={`${k}:${p[k] ?? ""}`} type={type} defaultValue={p[k] ?? ""} disabled={!canEdit || busy || locked} style={{ ...inp, width: w }}
      title={locked ? PAID_LOCK_MSG : undefined}
      onBlur={(e) => { if (e.target.value !== String(p[k] ?? "")) post("pay_update", { id: p.id, [k]: e.target.value }); }} />
  );
  return (
    <section style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Оплаты <span style={{ fontSize: 13, color: C.muted, fontWeight: 400 }}>осталось оплатить {nf2.format(d.calc.remainingCny)} ¥</span></h2>
      <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ color: C.muted, textAlign: "left" }}>
          <th style={{ padding: 6 }}>Вид</th><th style={{ padding: 6 }}>Сумма</th><th style={{ padding: 6 }}>Валюта</th>
          <th style={{ padding: 6 }}>Курс</th><th style={{ padding: 6 }}>Дата</th><th style={{ padding: 6 }}>В календаре</th><th />
        </tr></thead>
        <tbody>
          {d.payments.map((p) => {
            const m = ddsBy.get(`order:${d.order.id}:pay:${p.id}`);
            const locked = m?.status === "paid";
            return (
              <tr key={p.id} style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: 6 }}>{PAY_KIND_LABELS[p.kind]}</td>
                <td style={{ padding: 6 }} title={locked ? PAID_LOCK_MSG : undefined}>{field(p, "amount", 90, "text", locked)}</td>
                <td style={{ padding: 6 }}>{p.currency === "rub" ? "₽" : "¥"}</td>
                <td style={{ padding: 6 }} title={locked ? PAID_LOCK_MSG : undefined}>{p.currency === "cny" ? field(p, "rate", 70, "text", locked) : "—"}</td>
                <td style={{ padding: 6 }}>{field(p, "plan_date", 140, "date")}</td>
                <td style={{ padding: 6, color: m?.status === "paid" ? C.pos : C.muted }}>{m ? (m.status === "paid" ? `✓ оплачено ${m.paid_at ? m.paid_at.slice(0, 10) : ""}` : "запланировано") : "—"}</td>
                <td style={{ padding: 6 }} title={locked ? PAID_LOCK_MSG : undefined}>{canEdit && <button style={btn} disabled={busy || locked} title={locked ? PAID_LOCK_MSG : undefined} onClick={() => confirm("Удалить оплату?") && post("pay_delete", { id: p.id })}>✕</button>}</td>
              </tr>
            );
          })}
          {canEdit && (
            <tr style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
              <td style={{ padding: 6 }}><select value={add.kind} onChange={set("kind")} style={inp}>{Object.entries(PAY_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
              <td style={{ padding: 6 }}><input value={add.amount} onChange={set("amount")} style={{ ...inp, width: 90 }} /></td>
              <td style={{ padding: 6 }}>
                <select value={add.currency} onChange={set("currency")} disabled={add.kind !== "other"} style={inp}><option value="cny">¥</option><option value="rub">₽</option></select>
              </td>
              <td style={{ padding: 6 }}><input value={add.rate} onChange={set("rate")} disabled={add.currency === "rub"} style={{ ...inp, width: 70 }} /></td>
              <td style={{ padding: 6 }}><input type="date" value={add.plan_date} onChange={set("plan_date")} style={inp} /></td>
              <td colSpan={2} style={{ padding: 6 }}><button style={{ ...btn, borderColor: C.accent }} disabled={busy}
                onClick={async () => { if (await post("pay_add", add)) setAdd(EMPTY); }}>+ Оплата</button></td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
