"use client";
import { useEffect, useState } from "react";
const money = (v) => v != null ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽" : "—";

export default function OrdersPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    fetch(`/api/cabinets/${cabinetId}/orders?from=${from}&to=${to}&limit=200`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [cabinetId]);

  if (loading) return <div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>;
  if (!data) return <div style={{ padding: 40, color: "#8a99b8" }}>Нет данных</div>;
  const items = data.items || [];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 8px" }}>🛒 Заказы</h2>
      <div style={{ fontSize: 13, color: "#8a99b8", marginBottom: 16 }}>
        {data.period?.from} → {data.period?.to} · {items.length} заказов
      </div>
      <div style={{ overflowX: "auto", background: "#131c2e", border: "1px solid #243049", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #243049" }}>
              <th style={{ textAlign: "left", padding: "8px" }}>Дата</th>
              <th>МП</th>
              <th style={{ textAlign: "left" }}>Товар</th>
              <th style={{ textAlign: "left" }}>Склад</th>
              <th style={{ textAlign: "right" }}>Цена</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o, i) => (
              <tr key={i} style={{ borderBottom: "1px solid rgba(36,48,73,0.4)" }}>
                <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{(o.order_dt || "").slice(0, 16)}</td>
                <td>
                  <span style={{
                    padding: "2px 6px", borderRadius: 3, fontSize: 11, fontWeight: 600,
                    background: o.platform === "wb" ? "rgba(96,165,250,0.15)" : "rgba(249,115,22,0.15)",
                    color: o.platform === "wb" ? "#60a5fa" : "#f97316",
                  }}>{(o.platform || "").toUpperCase()}</span>
                </td>
                <td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {(o.name || String(o.nm || "")).slice(0, 45)}
                </td>
                <td style={{ fontSize: 12, color: "#8a99b8" }}>{(o.warehouse || "").slice(0, 20)}</td>
                <td style={{ textAlign: "right" }}>{money(o.orderRub || o.price)}</td>
                <td>{o.cancelled ? <span style={{ color: "#f87171" }}>Отменён</span> : <span style={{ color: "#4ade80" }}>Активен</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
