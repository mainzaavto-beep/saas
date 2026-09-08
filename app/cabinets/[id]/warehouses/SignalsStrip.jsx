"use client";
// app/cabinets/[id]/warehouses/SignalsStrip.jsx — полоса сигналов над вкладками витрины
// «Склады 2.0» (задача 5 плана). Данные приходят снаружи (signals из ответа MatrixTab —
// одного запроса на все вкладки, см. WarehousesPage.jsx), сама полоса только рендерит и
// маршрутизирует клики по пиллам на нужную вкладку/фильтр.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { C, soft } from "@/lib/palette.js";

// kind сигнала → куда ведёт клик по пиллу.
const TARGET = {
  discrepancy: "?tab=matrix&problems=1",
  low_coverage: "?tab=matrix&problems=1",
  gaps: "?tab=places",
  waiting_accept: "?tab=supplies",
};

export function SignalsStrip({ cabinetId, signals }) {
  const router = useRouter();
  const [openKind, setOpenKind] = useState(null);

  if (signals === null) {
    return <div style={{ color: C.muted, fontSize: 13 }}>Считаем…</div>;
  }
  if (signals.length === 0) {
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span style={pillStyle("pos")}>✅ Проблем нет</span>
      </div>
    );
  }

  const open = signals.find((s) => s.kind === "low_coverage" && openKind === "low_coverage");

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {signals.map((s) => {
          const token = s.level === "crit" ? "neg" : "warn";
          const isLowCoverage = s.kind === "low_coverage";
          return (
            <button
              key={s.kind}
              onClick={() => {
                if (isLowCoverage) {
                  setOpenKind((k) => (k === "low_coverage" ? null : "low_coverage"));
                } else {
                  const href = TARGET[s.kind] || "?tab=matrix";
                  router.push(href);
                }
              }}
              style={{ ...pillStyle(token), cursor: "pointer", border: "none" }}
              title={isLowCoverage ? "Раскрыть список" : "Перейти к проблемным"}
            >
              {s.level === "crit" ? "🔴" : "🟠"} {s.text}
            </button>
          );
        })}
      </div>
      {open && (
        <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surface, fontSize: 12 }}>
          {open.items.map((it, i) => (
            <div key={i} style={{ padding: "3px 0", color: C.muted }}>{it.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function pillStyle(token) {
  return {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
    background: soft(token, 15), color: C[token] || C.ink,
  };
}
