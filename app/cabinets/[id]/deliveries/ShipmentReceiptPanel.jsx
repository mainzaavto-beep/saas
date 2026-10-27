"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState } from "react";

// Приёмка отправки заказа (спека 2026-10-27-purchase-orders-design.md §5): по каждой позиции
// «отправлено → принято» (по умолчанию = отправлено), привязка артикула позиции без артикула,
// «✓ Учтено». Конечная точка: в остатки/себестоимость не пишет.

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const inp = { padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
const btn = { padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.ink, cursor: "pointer", fontSize: 13 };

export default function ShipmentReceiptPanel({ cabinetId, item, role, onChanged }) {
  const done = item.status === "done";
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(null); // shipment_line id
  const [search, setSearch] = useState("");
  const [found, setFound] = useState([]);

  useEffect(() => {
    if (!linking || search.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/deliveries?catalog=1&q=${encodeURIComponent(search.trim())}`);
        setFound((await r.json()).catalog || []);
      } catch (e) { console.error("shipment receipt catalog", e); setFound([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [cabinetId, search, linking]);

  async function post(body) {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/deliveries`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipment_id: item.id, ...body }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert(d.error || `Ошибка ${r.status}`); return false; }
      await onChanged();
      return true;
    } catch (e) { console.error("shipment receipt post", e); alert(String(e.message || e)); return false; }
    finally { setBusy(false); }
  }

  async function markDone() {
    const msg = item.diff !== 0
      ? `Принято ${nf0.format(item.accepted)} из ${nf0.format(item.ordered)} (${item.diff > 0 ? "+" : ""}${nf0.format(item.diff)}). Отметить «Учтено»?`
      : "Отметить отправку «Учтено»? Строки станут только для чтения.";
    if (confirm(msg)) await post({ action: "ship_done" });
  }

  return (
    <div style={{ fontSize: 13 }}>
      <table style={{ borderCollapse: "collapse", marginBottom: 10, minWidth: 620 }}>
        <thead><tr style={{ color: C.muted, textAlign: "left" }}>
          <th style={{ padding: "4px 8px" }}>Позиция</th>
          <th style={{ padding: "4px 8px", textAlign: "right" }}>Отправлено</th>
          <th style={{ padding: "4px 8px", textAlign: "right" }}>Принято</th>
          <th />
        </tr></thead>
        <tbody>
          {item.lines.map((l) => {
            const acc = l.qty_accepted ?? l.qty_shipped;
            return (
              <tr key={l.id} style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: "4px 8px" }}>
                  {l.photo && <img src={l.photo} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} />}
                  {l.label}{l.variant ? ` · ${l.variant}` : ""}
                  <span style={{ color: C.muted, marginLeft: 6 }}>
                    {l.platform === "wb" ? `WB ${l.nm_id}` : l.platform === "ozon" ? `Ozon ${l.article || l.product_id}` : "без артикула"}
                  </span>
                </td>
                <td style={{ padding: "4px 8px", textAlign: "right" }}>{nf0.format(l.qty_shipped)}</td>
                <td style={{ padding: "4px 8px", textAlign: "right" }}>
                  {done ? <span style={{ color: acc !== l.qty_shipped ? C.neg : C.ink }}>{nf0.format(acc)}</span> : (
                    <input type="number" min={0} defaultValue={acc} disabled={busy} style={{ ...inp, width: 80, textAlign: "right" }}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        // Пустое поле — не «0 принято»: возвращаем показанное значение, на сервер не шлём.
                        if (v === "") { e.target.value = String(acc); return; }
                        if (v !== String(acc)) post({ action: "ship_accept_line", id: l.id, qty_accepted: v });
                      }} />
                  )}
                </td>
                <td style={{ padding: "4px 8px" }}>
                  {!done && !l.platform && <button style={btn} onClick={() => { setLinking(l.id); setSearch(""); }}>Привязать артикул</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {linking && (
        <div style={{ marginBottom: 10, padding: 8, border: `1px solid ${C.line}`, borderRadius: 8 }}>
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск артикула WB/Ozon" style={{ ...inp, minWidth: 280 }} />
          <button style={{ ...btn, marginLeft: 6 }} onClick={() => setLinking(null)}>Отмена</button>
          {found.map((c) => (
            <div key={`${c.platform}${c.nm_id || c.product_id}`} style={{ padding: "4px 0", cursor: "pointer" }}
              onClick={async () => { if (await post({ action: "ship_link_line", id: linking, platform: c.platform, nm_id: c.nm_id, product_id: c.product_id })) setLinking(null); }}>
              {c.im_url && <img src={c.im_url} alt="" style={{ width: 24, height: 24, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} />}
              {c.platform === "wb" ? "WB" : "Ozon"} · {c.label} <span style={{ color: C.muted }}>{c.nm_id || c.article || c.product_id}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>Итого: принято {nf0.format(item.accepted)} из {nf0.format(item.ordered)}</span>
        {!done && <button style={{ ...btn, borderColor: C.pos, color: C.pos }} disabled={busy} onClick={markDone}>✓ Учтено</button>}
        {done && role === "owner" && <button style={btn} disabled={busy} onClick={() => confirm("Снять отметку «Учтено»?") && post({ action: "ship_undone" })}>Снять отметку</button>}
        <a href={`/cabinets/${cabinetId}/fin-purchases/${item.order_id}`} style={{ marginLeft: "auto", color: C.accent }}>Заказ →</a>
      </div>
    </div>
  );
}
