"use client";
import { C } from "@/lib/palette.js";
import { useEffect, useState } from "react";

// Поиск артикула WB/Ozon для позиции заказа (GET purchase-orders?catalog=1).
export default function CatalogPicker({ cabinetId, onPick, onCancel }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/purchase-orders?catalog=1&q=${encodeURIComponent(q.trim())}`);
        setFound((await r.json()).catalog || []);
      } catch (e) { console.error("po catalog", e); setFound([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [cabinetId, q]);
  return (
    <div style={{ padding: 8, border: `1px solid ${C.line}`, borderRadius: 8, background: C.surface, minWidth: 340 }}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Артикул, название, offer_id"
        style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, width: "100%" }} />
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {found.map((c) => (
          <div key={`${c.platform}${c.nm_id || c.product_id}`} onClick={() => onPick(c)} style={{ padding: "4px 2px", cursor: "pointer", fontSize: 13 }}>
            {c.im_url && <img src={c.im_url} alt="" style={{ width: 24, height: 24, objectFit: "cover", borderRadius: 4, verticalAlign: "middle", marginRight: 6 }} />}
            {c.platform === "wb" ? "WB" : "Ozon"} · {c.label} <span style={{ color: C.muted }}>{c.nm_id || c.article || c.product_id}</span>
          </div>
        ))}
      </div>
      {onCancel && <button onClick={onCancel} style={{ marginTop: 6, fontSize: 12, background: "none", border: "none", color: C.muted, cursor: "pointer" }}>отмена</button>}
    </div>
  );
}
