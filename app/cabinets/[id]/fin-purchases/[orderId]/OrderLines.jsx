"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";
import CatalogPicker from "./CatalogPicker";
import { inp, btn } from "./styles";

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const EMPTY = { label: "", variant: "", qty: "", price_cny: "", weight_kg: "" };

// Позиции заказа: товар (артикул WB/Ozon или текст), вариант, кол-во, цена ¥, вес; себестоимость — из calc.
export default function OrderLines({ cabinetId, d, post, busy, canEdit }) {
  const [add, setAdd] = useState(EMPTY);
  const [pick, setPick] = useState(null);      // выбранный артикул для новой строки
  const [picking, setPicking] = useState(null); // 'new' | line id
  const calcBy = new Map(d.calc.lines.map((l) => [l.id, l]));

  async function addLine() {
    const body = { ...add, label: add.label || pick?.label || "", platform: pick?.platform || null, nm_id: pick?.nm_id, product_id: pick?.product_id };
    if (await post("line_add", body)) { setAdd(EMPTY); setPick(null); }
  }
  const cell = (l, k, w = 70, type = "text") => (
    <input key={`${k}:${l[k] ?? ""}`} type={type} defaultValue={l[k] ?? ""} disabled={!canEdit || busy} style={{ ...inp, width: w, textAlign: type === "number" ? "right" : "left" }}
      onBlur={(e) => { if (e.target.value !== String(l[k] ?? "")) post("line_update", { id: l.id, [k]: e.target.value }); }} />
  );

  return (
    <section style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Позиции</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ color: C.muted, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
          <th style={{ padding: 6 }}>Товар</th><th style={{ padding: 6 }}>Вариант</th>
          <th style={{ padding: 6, textAlign: "right" }}>Кол-во</th><th style={{ padding: 6, textAlign: "right" }}>Цена ¥</th>
          <th style={{ padding: 6, textAlign: "right" }}>Вес ед., кг</th><th style={{ padding: 6, textAlign: "right" }}>Сумма ¥</th>
          <th style={{ padding: 6, textAlign: "right" }}>Себест. ₽/шт</th><th style={{ padding: 6, textAlign: "right" }}>Отпр. / принято</th><th />
        </tr></thead>
        <tbody>
          {d.lines.map((l) => {
            const c = calcBy.get(Number(l.id)) || {};
            const tip = `товар ${nf2.format(c.goodsUnit || 0)} + прочее ${nf2.format(c.otherUnit || 0)} + логистика ${c.logisticsUnit == null ? "ещё не известна" : nf2.format(c.logisticsUnit)}`;
            return (
              <tr key={l.id} style={{ borderBottom: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: 6, position: "relative" }}>
                  {l.photo && <img src={l.photo} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} />}
                  {cell(l, "label", 220)}
                  <span style={{ color: C.muted, marginLeft: 6, cursor: canEdit ? "pointer" : "default" }} onClick={() => canEdit && setPicking(l.id)}>
                    {l.platform === "wb" ? `WB ${l.nm_id}` : l.platform === "ozon" ? `Ozon ${l.article || l.product_id}` : "＋ артикул"}
                  </span>
                  {picking === l.id && (
                    <div style={{ position: "absolute", zIndex: 5, top: "100%", left: 0 }}>
                      <CatalogPicker cabinetId={cabinetId} onCancel={() => setPicking(null)}
                        onPick={async (p) => { if (await post("line_update", { id: l.id, platform: p.platform, nm_id: p.nm_id, product_id: p.product_id, label: l.label })) setPicking(null); }} />
                    </div>
                  )}
                </td>
                <td style={{ padding: 6 }}>{cell(l, "variant", 80)}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{cell(l, "qty", 70, "number")}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{cell(l, "price_cny", 80)}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{cell(l, "weight_kg", 70)}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{nf2.format(c.sumCny || 0)}</td>
                <td style={{ padding: 6, textAlign: "right" }} title={tip}>
                  <b>{nf0.format(c.unitCost || 0)}</b>{c.logisticsUnit == null && <div style={{ color: C.muted, fontSize: 11 }}>без логистики</div>}
                </td>
                <td style={{ padding: 6, textAlign: "right" }}>
                  {nf0.format(c.shipped || 0)} / {nf0.format(c.accepted || 0)}
                  {c.shortage > 0 && <div style={{ color: C.neg, fontSize: 11 }}>недостача {c.shortage} · {nf0.format(c.shortageRub)} ₽</div>}
                  {c.surplus > 0 && <div style={{ color: C.muted, fontSize: 11 }}>излишек {c.surplus}</div>}
                </td>
                <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                  {canEdit && <button title="Ещё размер/цвет" style={btn} disabled={busy}
                    onClick={() => { const v = prompt("Вариант (размер/цвет) новой строки", ""); if (v != null) post("line_copy", { id: l.id, variant: v }); }}>⧉</button>}
                  {canEdit && <button title="Удалить" style={{ ...btn, marginLeft: 4 }} disabled={busy}
                    onClick={() => confirm(`Удалить «${l.label}»?`) && post("line_delete", { id: l.id })}>✕</button>}
                </td>
              </tr>
            );
          })}
          {canEdit && (
            <tr>
              <td style={{ padding: 6, position: "relative" }}>
                <input value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} placeholder={pick ? pick.label : "Название или выберите артикул →"} style={{ ...inp, width: 220 }} />
                <span style={{ color: C.accent, marginLeft: 6, cursor: "pointer" }} onClick={() => setPicking("new")}>{pick ? `${pick.platform === "wb" ? "WB" : "Ozon"} ✓` : "＋ артикул"}</span>
                {picking === "new" && (
                  <div style={{ position: "absolute", zIndex: 5, top: "100%", left: 0 }}>
                    <CatalogPicker cabinetId={cabinetId} onCancel={() => setPicking(null)} onPick={(p) => { setPick(p); setPicking(null); }} />
                  </div>
                )}
              </td>
              <td style={{ padding: 6 }}><input value={add.variant} onChange={(e) => setAdd({ ...add, variant: e.target.value })} style={{ ...inp, width: 80 }} /></td>
              <td style={{ padding: 6, textAlign: "right" }}><input type="number" value={add.qty} onChange={(e) => setAdd({ ...add, qty: e.target.value })} style={{ ...inp, width: 70 }} /></td>
              <td style={{ padding: 6, textAlign: "right" }}><input value={add.price_cny} onChange={(e) => setAdd({ ...add, price_cny: e.target.value })} style={{ ...inp, width: 80 }} /></td>
              <td style={{ padding: 6, textAlign: "right" }}><input value={add.weight_kg} onChange={(e) => setAdd({ ...add, weight_kg: e.target.value })} style={{ ...inp, width: 70 }} /></td>
              <td colSpan={4} style={{ padding: 6 }}><button style={{ ...btn, borderColor: C.accent }} disabled={busy} onClick={addLine}>+ Позиция</button></td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
