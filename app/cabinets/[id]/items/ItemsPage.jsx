"use client";
import { useEffect, useState } from "react";
const money = (v) => v != null ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽" : "—";

export default function ItemsPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mp, setMp] = useState("all");
  const [q, setQ] = useState("");
  const [editNm, setEditNm] = useState(null);
  const [editCost, setEditCost] = useState("");

  const load = () => {
    setLoading(true);
    fetch(`/api/cabinets/${cabinetId}/items?mp=${mp}&q=${encodeURIComponent(q)}`)
      .then((r) => r.json()).then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, [cabinetId, mp]);
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [q]);

  const saveCost = async (nm, platform) => {
    const res = await fetch(`/api/cabinets/${cabinetId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nm, cost: Number(editCost), platform }),
    });
    if (res.ok) {
      setEditNm(null);
      load();
    }
  };

  if (loading) return <div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>;
  if (!data) return null;
  const items = data.items || [];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 8px" }}>🏷️ Товары (себестоимость)</h2>
      <div style={{ fontSize: 13, color: "#8a99b8", marginBottom: 16 }}>{items.length} товаров</div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center" }}>
        {["all", "wb", "ozon"].map((m) => (
          <button key={m} onClick={() => setMp(m)} style={{ padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, border: "1px solid #243049", background: mp === m ? "#4f8cff" : "#1a2540", color: "#fff" }}>
            {m === "all" ? "Все" : m.toUpperCase()}
          </button>
        ))}
        <input placeholder="🔍 Поиск..." value={q} onChange={(e) => setQ(e.target.value)}
          style={{ padding: "6px 12px", background: "#1a2540", border: "1px solid #243049", borderRadius: 6, color: "#e8edf7", fontSize: 13, minWidth: 200 }} />
      </div>

      <div style={{ overflowX: "auto", background: "#131c2e", border: "1px solid #243049", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ borderBottom: "1px solid #243049" }}>
            <th style={{ textAlign: "left", padding: "8px" }}>Товар</th><th>МП</th>
            <th style={{ textAlign: "left" }}>Категория</th>
            <th style={{ textAlign: "right" }}>Артикул</th>
            <th style={{ textAlign: "right" }}>Себест.</th>
          </tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} style={{ borderBottom: "1px solid rgba(36,48,73,0.3)" }}>
                <td style={{ padding: "6px 8px", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {it.im_url && <img src={it.im_url} alt="" style={{ width: 28, height: 28, borderRadius: 4, marginRight: 6, verticalAlign: "middle", objectFit: "cover" }} />}
                  {(it.name || "").slice(0, 45)}
                </td>
                <td><span style={{ padding: "2px 6px", borderRadius: 3, fontSize: 11, fontWeight: 600, background: it.platform === "wb" ? "rgba(96,165,250,0.15)" : "rgba(249,115,22,0.15)", color: it.platform === "wb" ? "#60a5fa" : "#f97316" }}>{it.platform.toUpperCase()}</span></td>
                <td style={{ fontSize: 12, color: "#8a99b8" }}>{(it.category || "").slice(0, 25)}</td>
                <td style={{ textAlign: "right", fontSize: 12, color: "#8a99b8" }}>{it.nm}</td>
                <td style={{ textAlign: "right" }}>
                  {editNm === it.nm ? (
                    <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <input type="number" value={editCost} onChange={(e) => setEditCost(e.target.value)}
                        style={{ width: 80, padding: "2px 6px", background: "#1a2540", border: "1px solid #4f8cff", borderRadius: 4, color: "#e8edf7", fontSize: 12 }}
                        autoFocus />
                      <button onClick={() => saveCost(it.nm, it.platform)} style={{ padding: "2px 8px", background: "#4f8cff", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer", fontSize: 11 }}>✓</button>
                    </span>
                  ) : (
                    <span
                      onClick={() => { setEditNm(it.nm); setEditCost(String(it.cost || 0)); }}
                      style={{ cursor: "pointer", color: it.cost > 0 ? "#e8edf7" : "#fbbf24" }}
                      title="Клик для редактирования"
                    >
                      {money(it.cost)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
