"use client";
import { useEffect, useState } from "react";
const money = (v) => v != null ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽" : "—";
const pct = (v) => v != null ? (Number(v) * 100).toFixed(1) + "%" : "—";

export default function BriefingPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/briefings?limit=1`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [cabinetId]);

  if (loading) return <div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>;
  if (!data) return <div style={{ padding: 40, color: "#8a99b8" }}>Нет данных</div>;
  const items = Array.isArray(data) ? data : (data.items || data.briefings || []);
  const b = items[0] || {};

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 8px" }}>📋 Брифинг</h2>
      <div style={{ fontSize: 13, color: "#8a99b8", marginBottom: 24 }}>
        {b.date || new Date().toISOString().slice(0, 10)}
      </div>

      {b.report ? (
        <BriefingReport report={typeof b.report === "string" ? JSON.parse(b.report) : b.report} />
      ) : (
        <div style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 12, padding: 40, textAlign: "center", color: "#8a99b8" }}>
          Брифинг ещё не сформирован. Запустите сборщик данных.
        </div>
      )}
    </div>
  );
}

function BriefingReport({ report }) {
  const sections = [];
  for (const [key, val] of Object.entries(report)) {
    if (val && typeof val === "object") sections.push([key, val]);
  }
  return (
    <div>
      {sections.map(([key, val]) => (
        <div key={key} style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 16, textTransform: "capitalize" }}>{key}</h3>
          <pre style={{ fontSize: 13, color: "#e8edf7", whiteSpace: "pre-wrap", margin: 0 }}>
            {typeof val === "string" ? val : JSON.stringify(val, null, 2)}
          </pre>
        </div>
      ))}
      {sections.length === 0 && (
        <div style={{ color: "#8a99b8", padding: 20 }}>Нет данных в отчёте</div>
      )}
    </div>
  );
}
