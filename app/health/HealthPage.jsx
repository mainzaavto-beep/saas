"use client";
import { useState, useEffect } from "react";

// Матрица «сборщик × день» по кабинетам + лента ошибок (спек п.6).
const COLORS = {
  ok: "#22c55e", partial: "#eab308", skipped: "#f97316",
  failed: "#ef4444", timeout: "#ef4444", no_token: "#ef4444", none: "#3f3f46",
};
const RANK = { ok: 0, skipped: 1, partial: 2, no_token: 3, timeout: 4, failed: 5 };

export default function HealthPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div style={{ padding: 24 }}>Нет доступа: {err}</div>;
  if (!data) return <div style={{ padding: 24 }}>Загрузка…</div>;

  const days = [...Array(data.days)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (data.days - 1 - i));
    return d.toISOString().slice(0, 10);
  });

  // кабинет → сборщик → день → худший статус дня
  const cabs = {};
  for (const r of data.runs) {
    const cab = r.cabinet_id
      ? `#${r.cabinet_id} ${r.display_name || ""}`.trim()
      : "Системные (systemd-юниты)";
    const day = (r.started_at || "").slice(0, 10);
    cabs[cab] ??= {};
    cabs[cab][r.collector] ??= {};
    const prev = cabs[cab][r.collector][day];
    if (!prev || RANK[r.status] > RANK[prev]) cabs[cab][r.collector][day] = r.status;
  }
  const errors = data.runs.filter((r) => r.status !== "ok").slice(0, 50);

  const cell = (st, key) => (
    <td key={key} title={st || "не запускался"}
        style={{ width: 22, height: 18, background: COLORS[st || "none"],
                 border: "1px solid #18181b" }} />
  );

  return (
    <div style={{ padding: 24, fontFamily: "monospace", color: "#e4e4e7",
                  background: "#09090b", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Здоровье данных</h1>
      <div style={{ fontSize: 12, color: "#a1a1aa", marginBottom: 16 }}>
        jobs.collector_runs, последние {data.days} дн. Цвета: ok / partial /
        skipped (guard) / failed-timeout-no_token / не запускался.
      </div>
      {Object.entries(cabs).map(([cab, colls]) => (
        <div key={cab} style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{cab}</div>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", paddingRight: 8 }}>сборщик</th>
                {days.map((d) => (
                  <th key={d} title={d} style={{ fontWeight: 400, color: "#71717a" }}>
                    {d.slice(8)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(colls).sort().map(([coll, byDay]) => (
                <tr key={coll}>
                  <td style={{ paddingRight: 8, whiteSpace: "nowrap" }}>{coll}</td>
                  {days.map((d) => cell(byDay[d], `${coll}-${d}`))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <h2 style={{ fontSize: 16, margin: "24px 0 8px" }}>Последние проблемы</h2>
      {!errors.length && <div style={{ color: "#a1a1aa" }}>Проблем нет 🎉</div>}
      {errors.map((r) => (
        <div key={r.id} style={{ fontSize: 12, marginBottom: 4 }}>
          <span style={{ color: COLORS[r.status] }}>[{r.status}]</span>{" "}
          {(r.started_at || "").slice(0, 16).replace("T", " ")}{" "}
          {r.cabinet_id ? `#${r.cabinet_id}` : "sys"} {r.collector}
          {r.error ? ` — ${r.error}` : ""}
        </div>
      ))}
    </div>
  );
}
