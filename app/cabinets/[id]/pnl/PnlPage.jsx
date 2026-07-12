"use client";
import { useEffect, useState } from "react";
const money = (v) => v != null ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽" : "—";
const pct = (v) => v != null ? v + "%" : "—";

export default function PnlPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/pnl?period=${period}`)
      .then((r) => r.json()).then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [cabinetId, period]);

  if (loading) return <div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>;
  if (!data) return null;
  const t = data.total || {};

  // Строки P&L: выручка → минус расходы → прибыль
  const rows = [
    ["Выручка (брутто)", t.sales, "#4ade80"],
    ["Возвраты", -t.returns, "#f87171"],
    ["Выручка (нетто)", t.netSales, "#4ade80"],
    ["Себестоимость", -t.cost, "#f87171"],
    ["Валовая прибыль", t.grossProfit, t.grossProfit >= 0 ? "#4ade80" : "#f87171"],
    ["Комиссия МП", -t.commission, "#f87171"],
    ["Логистика", -t.logistics, "#f87171"],
    ["Эквайринг", -t.acquiring, "#f87171"],
    ["Хранение", -t.storage, "#f87171"],
    ["УСН 6%", -t.tax, "#f87171"],
    ["ЧИСТАЯ ПРИБЫЛЬ", t.netProfit, t.netProfit >= 0 ? "#4ade80" : "#f87171"],
  ];

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>💰 Сводка по прибыли</h2>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
          style={{ padding: "6px 10px", background: "#1a2540", border: "1px solid #243049", borderRadius: 6, color: "#e8edf7", fontSize: 14 }} />
      </div>

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        {[
          ["Выручка", money(t.netSales)],
          ["Прибыль", money(t.netProfit), t.netProfit >= 0 ? "#4ade80" : "#f87171"],
          ["Маржа", pct(t.margin)],
          ["К перечислению", money(t.forPay)],
        ].map(([label, val, color]) => (
          <div key={label} style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 8, padding: "12px 16px", flex: 1 }}>
            <div style={{ fontSize: 12, color: "#8a99b8", marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: color || "#e8edf7" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* P&L таблица */}
      <div style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 12, padding: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <tbody>
            {rows.map(([label, val, color], i) => {
              const isTotal = label.includes("ЧИСТАЯ") || label.includes("Валовая");
              const isSubtotal = label.includes("нетто");
              return (
                <tr key={i} style={{
                  borderTop: isTotal ? "2px solid #243049" : "1px solid rgba(36,48,73,0.3)",
                  fontWeight: isTotal ? 700 : (isSubtotal ? 600 : 400),
                }}>
                  <td style={{ padding: "10px 6px" }}>{label}</td>
                  <td style={{ padding: "10px 6px", textAlign: "right", color, fontSize: isTotal ? 16 : 14 }}>
                    {val >= 0 ? "" : "−"}{money(Math.abs(val))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.wb && data.ozon && (
        <div style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 12, padding: 20, marginTop: 16 }}>
          <h3 style={{ margin: "0 0 12px" }}>По маркетплейсам</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ borderBottom: "1px solid #243049" }}>
              <th style={{ textAlign: "left", padding: "6px" }}>Показатель</th>
              <th style={{ textAlign: "right" }}>WB</th>
              <th style={{ textAlign: "right" }}>Ozon</th>
            </tr></thead>
            <tbody>
              {[["Выручка", "netSales"], ["Себест.", "cost"], ["Комиссия", "commission"], ["Логистика", "logistics"], ["Прибыль", "netProfit"]].map(([label, key]) => (
                <tr key={key} style={{ borderBottom: "1px solid rgba(36,48,73,0.3)" }}>
                  <td style={{ padding: "5px 6px" }}>{label}</td>
                  <td style={{ textAlign: "right", padding: "5px 6px" }}>{money(data.wb?.[key])}</td>
                  <td style={{ textAlign: "right", padding: "5px 6px" }}>{money(data.ozon?.[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
