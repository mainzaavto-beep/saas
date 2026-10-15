"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState } from "react";

// Панель приёмки партии: строки «артикул → принято, шт», выбор артикула из каталога WB/Ozon
// или вручную, итог и отметка «Учтено по артикулам». У закрытой — только чтение.

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const inp = { padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
const btn = { padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.ink, cursor: "pointer", fontSize: 13 };

export default function ReceiptPanel({ cabinetId, item, role, onChanged }) {
  const done = item.status === "done";
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(null); // { platform, nm_id|product_id, label } | { platform: null }
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [manual, setManual] = useState("");
  const [search, setSearch] = useState("");
  const [found, setFound] = useState([]);

  useEffect(() => {
    if (done || search.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/deliveries?catalog=1&q=${encodeURIComponent(search.trim())}`);
        const d = await r.json();
        setFound(d.catalog || []);
      } catch (e) { console.error("deliveries catalog", e); setFound([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [cabinetId, search, done]);

  async function post(body) {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/deliveries`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert(d.error || `Ошибка ${r.status}`); return false; }
      await onChanged();
      return true;
    } catch (e) { console.error("deliveries post", e); alert(String(e.message || e)); return false; }
    finally { setBusy(false); }
  }

  async function addLine() {
    if (!pick) { alert("Выберите артикул из каталога или «другое»"); return; }
    const body = { action: "line_add", purchase_id: item.id, qty_accepted: qty, note,
      platform: pick.platform || null, nm_id: pick.nm_id, product_id: pick.product_id,
      label: pick.platform ? pick.label : manual };
    if (await post(body)) { setPick(null); setQty(""); setNote(""); setManual(""); setSearch(""); }
  }

  async function editQty(l) {
    const v = prompt(`Принято, шт — «${l.label}»`, String(l.qty_accepted));
    if (v == null) return;
    await post({ action: "line_update", id: l.id, qty_accepted: v.trim() });
  }

  async function markDone() {
    const msg = item.diff !== 0
      ? `Принято ${nf0.format(item.accepted)} из ${nf0.format(item.ordered)} (расхождение ${item.diff > 0 ? "+" : ""}${nf0.format(item.diff)}). Отметить «Учтено по артикулам»?`
      : "Отметить «Учтено по артикулам»? Строки станут только для чтения.";
    if (confirm(msg)) await post({ action: "done", purchase_id: item.id });
  }

  return (
    <div style={{ fontSize: 13 }}>
      {item.lines.length > 0 ? (
        <table style={{ borderCollapse: "collapse", marginBottom: 10, minWidth: 560 }}>
          <thead><tr style={{ color: C.muted, textAlign: "left" }}>
            <th style={{ padding: "4px 8px" }}>Артикул</th>
            <th style={{ padding: "4px 8px", textAlign: "right" }}>Принято, шт</th>
            <th style={{ padding: "4px 8px" }}>Примечание</th>
            <th />
          </tr></thead>
          <tbody>
            {item.lines.map((l) => (
              <tr key={l.id} style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: "4px 8px" }}>
                  {l.im_url ? <img src={l.im_url} alt="" style={{ width: 24, height: 24, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} /> : null}
                  {l.label}
                  <span style={{ color: C.muted, marginLeft: 6 }}>
                    {l.platform === "wb" ? `WB ${l.nm_id}` : l.platform === "ozon" ? `Ozon ${l.article || l.product_id}` : "вручную"}
                  </span>
                </td>
                <td style={{ padding: "4px 8px", textAlign: "right" }}>
                  {done ? nf0.format(l.qty_accepted)
                    : <button style={btn} disabled={busy} onClick={() => editQty(l)}>{nf0.format(l.qty_accepted)} ✏️</button>}
                </td>
                <td style={{ padding: "4px 8px", color: C.muted }}>{l.note || ""}</td>
                <td style={{ padding: "4px 8px" }}>
                  {!done && <button style={{ ...btn, color: C.neg }} disabled={busy}
                    onClick={() => confirm(`Удалить строку «${l.label}»?`) && post({ action: "line_delete", id: l.id })}>✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div style={{ color: C.muted, marginBottom: 10 }}>Строк приёмки ещё нет.</div>}

      <div style={{ marginBottom: 12 }}>
        Итого: принято <b>{nf0.format(item.accepted)}</b> из {nf0.format(item.ordered)}
        {item.lines.length > 0 && (
          <span style={{ color: item.diff !== 0 ? C.neg : C.pos, marginLeft: 8 }}>
            расхождение {item.diff > 0 ? "+" : ""}{nf0.format(item.diff)}
          </span>
        )}
      </div>

      {!done && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 12 }}>
          <div style={{ position: "relative" }}>
            {pick ? (
              <div style={{ ...inp, display: "flex", gap: 6, alignItems: "center", minWidth: 260 }}>
                {pick.platform
                  ? <span>{pick.label} <span style={{ color: C.muted }}>{pick.platform === "wb" ? `WB ${pick.nm_id}` : `Ozon ${pick.article || pick.product_id}`}</span></span>
                  : <input autoFocus value={manual} onChange={(e) => setManual(e.target.value)} placeholder="артикул / название из акта"
                      style={{ border: "none", background: "transparent", color: C.ink, outline: "none", minWidth: 220 }} />}
                <button style={{ ...btn, padding: "0 6px" }} onClick={() => { setPick(null); setManual(""); }}>×</button>
              </div>
            ) : (
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Артикул: поиск WB/Ozon"
                style={{ ...inp, minWidth: 260 }} />
            )}
            {!pick && search.trim().length >= 2 && (
              <div style={{ position: "absolute", zIndex: 5, top: "100%", left: 0, right: 0, marginTop: 2, maxHeight: 260, overflowY: "auto",
                background: C.surface, border: `1px solid ${C.line}`, borderRadius: 6 }}>
                {found.map((f) => (
                  <div key={`${f.platform}:${f.nm_id || f.product_id}`} onClick={() => setPick(f)}
                    style={{ padding: "5px 8px", cursor: "pointer", display: "flex", gap: 6, alignItems: "center" }}>
                    {f.im_url ? <img src={f.im_url} alt="" style={{ width: 24, height: 24, objectFit: "cover", borderRadius: 4 }} /> : null}
                    <span>{f.label}</span>
                    <span style={{ color: C.muted, marginLeft: "auto" }}>{f.platform === "wb" ? `WB ${f.nm_id}` : `Ozon ${f.article || f.product_id}`}</span>
                  </div>
                ))}
                <div onClick={() => setPick({ platform: null })}
                  style={{ padding: "5px 8px", cursor: "pointer", color: C.accent, borderTop: `1px solid ${soft("line", 50)}` }}>
                  другое — ввести вручную
                </div>
              </div>
            )}
          </div>
          <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="принято, шт" inputMode="numeric" style={{ ...inp, width: 110 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="примечание (брак, недостача)" style={{ ...inp, minWidth: 220 }} />
          <button style={btn} disabled={busy} onClick={addLine}>+ Добавить</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        {!done && <button style={{ ...btn, borderColor: C.pos, color: C.pos }} disabled={busy || !item.lines.length} onClick={markDone}>✓ Учтено по артикулам</button>}
        {!done && !item.lines.length && <button style={btn} disabled={busy}
          onClick={() => confirm("Вернуть партию в активные закупки?") && post({ action: "return_to_purchases", purchase_id: item.id })}>↩ Вернуть в закупки</button>}
        {done && role === "owner" && <button style={btn} disabled={busy}
          onClick={() => confirm("Снять отметку «Учтено по артикулам»? Строки снова можно будет править.") && post({ action: "undone", purchase_id: item.id })}>Снять отметку</button>}
      </div>
    </div>
  );
}
