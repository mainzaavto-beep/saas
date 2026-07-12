"use client";
// /cabinets/[id]/detail — детсводка по товару.
// Параметры из URL: ?platform=wb|ozon&nm=<id>
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";

const money = (v) => v != null ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽" : "—";

export default function DetailPage({ cabinetId }) {
  const sp = useSearchParams();
  const platform = sp.get("platform") || "wb";
  const nm = sp.get("nm");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!nm) { setError("Не указан товар"); setLoading(false); return; }
    const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    fetch(`/api/cabinets/${cabinetId}/detail?platform=${platform}&nm=${nm}&from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [cabinetId, platform, nm]);

  if (loading) return <div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>;
  if (error) return <div style={{ padding: 40, color: "#ff6b6b" }}>Ошибка: {error}</div>;
  if (!data) return null;

  const k = data.kpi || {};
  const days = data.days || [];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      {/* Заголовок */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: "0 0 4px" }}>
          {data.info?.im_url && <img src={data.info.im_url} alt="" style={{ width: 40, height: 40, borderRadius: 6, marginRight: 10, verticalAlign: "middle", objectFit: "cover" }} />}
          {(data.info?.name || "Товар").slice(0, 60)}
        </h2>
        <div style={{ fontSize: 13, color: "#8a99b8" }}>
          <span style={{
            padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, marginRight: 8,
            background: platform === "wb" ? "rgba(96,165,250,0.15)" : "rgba(249,115,22,0.15)",
            color: platform === "wb" ? "#60a5fa" : "#f97316",
          }}>{platform.toUpperCase()}</span>
          {data.info?.brand} · {data.period?.from} → {data.period?.to}
        </div>
      </div>

      {/* KPI */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        {[
          ["Выручка", money(k.revenue), "#4ade80"],
          ["Продано", k.sold, null],
          ["Прибыль", money(k.profit), (k.profit || 0) >= 0 ? "#4ade80" : "#f87171"],
          ["Маржа", k.margin != null ? k.margin + "%" : "—", null],
          ["Себест.", money(k.costRub), null],
          ["Комиссия", money(k.commission), null],
          ["Логистика", money(k.logistics), null],
          ["Реклама", money(k.adSpend), null],
        ].map(([label, val, color]) => (
          <div key={label} style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 8, padding: "10px 14px", minWidth: 110 }}>
            <div style={{ fontSize: 11, color: "#8a99b8", marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: color || "#e8edf7" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* График динамики */}
      {days.length > 0 && (
        <div style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 12, padding: 20, marginBottom: 24 }}>
          <h3 style={{ margin: "0 0 16px" }}>📈 Динамика</h3>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={days.map((d) => ({
              date: d.date.slice(5),
              revenue: Math.round(d.revenue),
              profit: Math.round(d.profit),
              sold: d.sold,
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
              <XAxis dataKey="date" stroke="#8a99b8" fontSize={11} />
              <YAxis yAxisId="left" stroke="#8a99b8" fontSize={11} tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v} />
              <YAxis yAxisId="right" orientation="right" stroke="#8a99b8" fontSize={11} />
              <Tooltip
                contentStyle={{ background: "#0b1220", border: "1px solid #243049", borderRadius: 8 }}
                formatter={(v, name) => name === "sold" ? [v, "Продано"] : [money(v), name === "revenue" ? "Выручка" : "Прибыль"]}
              />
              <Legend formatter={(v) => v === "revenue" ? "Выручка" : v === "profit" ? "Прибыль" : "Продано"} />
              <Bar yAxisId="left" dataKey="revenue" fill="#4f8cff" radius={[3, 3, 0, 0]} name="revenue" />
              <Line yAxisId="left" type="monotone" dataKey="profit" stroke="#4ade80" strokeWidth={2} name="profit" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Матрица по дням */}
      <div style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 12, padding: 20, overflowX: "auto" }}>
        <h3 style={{ margin: "0 0 12px" }}>📅 По дням</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #243049" }}>
              <th style={{ textAlign: "left", padding: "6px" }}>Дата</th>
              <th style={{ textAlign: "right", padding: "6px" }}>Продано</th>
              <th style={{ textAlign: "right", padding: "6px" }}>Выручка</th>
              <th style={{ textAlign: "right", padding: "6px" }}>Прибыль</th>
              <th style={{ textAlign: "right", padding: "6px" }}>Маржа</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={i} style={{ borderBottom: "1px solid rgba(36,48,73,0.3)" }}>
                <td style={{ padding: "5px 6px" }}>
                  {d.date} <span style={{ color: "#5a6a8a", fontSize: 11 }}>{d.weekday}</span>
                </td>
                <td style={{ textAlign: "right", padding: "5px 6px" }}>{d.sold || "—"}</td>
                <td style={{ textAlign: "right", padding: "5px 6px" }}>{money(d.revenue)}</td>
                <td style={{ textAlign: "right", padding: "5px 6px", color: (d.profit || 0) >= 0 ? "#4ade80" : "#f87171" }}>
                  {money(d.profit)}
                </td>
                <td style={{ textAlign: "right", padding: "5px 6px" }}>
                  {d.revenue > 0 ? Math.round((d.profit / d.revenue) * 10000) / 100 + "%" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "2px solid #243049", fontWeight: 700 }}>
              <td style={{ padding: "6px" }}>ИТОГО</td>
              <td style={{ textAlign: "right", padding: "6px" }}>{k.sold}</td>
              <td style={{ textAlign: "right", padding: "6px" }}>{money(k.revenue)}</td>
              <td style={{ textAlign: "right", padding: "6px", color: (k.profit || 0) >= 0 ? "#4ade80" : "#f87171" }}>{money(k.profit)}</td>
              <td style={{ textAlign: "right", padding: "6px" }}>{k.margin != null ? k.margin + "%" : "—"}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
