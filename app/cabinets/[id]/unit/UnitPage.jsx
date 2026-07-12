"use client";
import { useEffect, useState } from "react";
const money = (v) => v != null ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽" : "—";
const pct = (v) => v != null ? v + "%" : "—";

export default function UnitPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mp, setMp] = useState("all");

  useEffect(() => {
    const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    fetch(`/api/cabinets/${cabinetId}/unit?from=${from}&to=${to}`)
      .then((r) => r.json()).then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [cabinetId]);

  if (loading) return <div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>;
  if (!data) return null;
  let items = data.items || [];
  if (mp !== "all") items = items.filter((it) => it.platform === mp);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 8px" }}>📐 Юнит-экономика</h2>
      <div style={{ fontSize: 13, color: "#8a99b8", marginBottom: 16 }}>Средние на единицу · {data.period?.from} → {data.period?.to}</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {["all", "wb", "ozon"].map((m) => (
          <button key={m} onClick={() => setMp(m)} style={{ padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, border: "1px solid #243049", background: mp === m ? "#4f8cff" : "#1a2540", color: "#fff" }}>
            {m === "all" ? "Все" : m.toUpperCase()}
          </button>
        ))}
      </div>
      <div style={{ overflowX: "auto", background: "#131c2e", border: "1px solid #243049", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ borderBottom: "1px solid #243049" }}>
            <th style={{ textAlign: "left", padding: "8px" }}>Товар</th><th>МП</th>
            <th style={{ textAlign: "right" }}>Прод.</th><th style={{ textAlign: "right" }}>Цена</th>
            <th style={{ textAlign: "right" }}>Себест.</th><th style={{ textAlign: "right" }}>Комисс.</th>
            <th style={{ textAlign: "right" }}>Логист.</th><th style={{ textAlign: "right" }}>УСН</th>
            <th style={{ textAlign: "right" }}>Приб./шт</th><th style={{ textAlign: "right" }}>Маржа</th>
          </tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} style={{ borderBottom: "1px solid rgba(36,48,73,0.3)" }}>
                <td style={{ padding: "6px 8px", maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {it.im_url && <img src={it.im_url} alt="" style={{ width: 24, height: 24, borderRadius: 3, marginRight: 6, verticalAlign: "middle", objectFit: "cover" }} />}
                  {(it.name || "").slice(0, 35)}
                </td>
                <td><span style={{ padding: "2px 6px", borderRadius: 3, fontSize: 11, fontWeight: 600, background: it.platform === "wb" ? "rgba(96,165,250,0.15)" : "rgba(249,115,22,0.15)", color: it.platform === "wb" ? "#60a5fa" : "#f97316" }}>{it.platform.toUpperCase()}</span></td>
                <td style={{ textAlign: "right" }}>{it.sold}</td>
                <td style={{ textAlign: "right" }}>{money(it.price)}</td>
                <td style={{ textAlign: "right" }}>{money(it.cost)}</td>
                <td style={{ textAlign: "right" }}>{money(it.commission)}</td>
                <td style={{ textAlign: "right" }}>{money(it.logistics)}</td>
                <td style={{ textAlign: "right" }}>{money(it.tax)}</td>
                <td style={{ textAlign: "right", color: (it.profit || 0) >= 0 ? "#4ade80" : "#f87171", fontWeight: 600 }}>{money(it.profit)}</td>
                <td style={{ textAlign: "right" }}>{pct(it.margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
