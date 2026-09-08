"use client";
// app/cabinets/[id]/warehouses/WarehousesPage.jsx — каркас витрины «Склады 2.0» (этап 4,
// задачи 5-6 плана). Три вкладки: matrix | places | supplies. Вкладка держится в URL (?tab=)
// через useSearchParams/router.replace, как принято в панели (см. /shipments). SignalsStrip
// получает signals из активной вкладки через onSignals — общий колбэк, чтобы полоса сигналов
// не дублировала запрос. Вкладка «Поставки» своих сигналов не грузит (она — /shipments в
// embedded-режиме), поэтому на ней полоса осталась бы пустой: если сигналов ещё нет, тянем их
// здесь одним GET ?tab=matrix и берём ТОЛЬКО signals (матрица не нужна). Ошибка — [] , то
// есть просто нет полосы: сигналы не должны ронять вкладку поставок.
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { C } from "@/lib/palette.js";
import { SignalsStrip } from "./SignalsStrip";
import { MatrixTab } from "./MatrixTab";
import { PlacesTab } from "./PlacesTab";
import { SuppliesTab } from "./SuppliesTab";

const TABS = [["matrix", "Матрица"], ["places", "Места"], ["supplies", "Поставки"]];

export default function WarehousesPage({ cabinetId }) {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = TABS.some(([k]) => k === sp.get("tab")) ? sp.get("tab") : "matrix";
  const [signals, setSignals] = useState(null);
  const setTab = (k) => router.replace(`?tab=${k}`);

  useEffect(() => {
    if (tab !== "supplies" || signals !== null) return;
    let cancelled = false;
    fetch(`/api/cabinets/${cabinetId}/warehouses?tab=matrix`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setSignals(d?.error ? [] : (d.signals || [])); })
      .catch(() => { if (!cancelled) setSignals([]); });
    return () => { cancelled = true; };
  }, [tab, signals, cabinetId]);

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Склады</h1>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 12 }}>Свой учёт против остатков на МП, покрытие по каждому месту и складу, поставки</div>
      <SignalsStrip cabinetId={cabinetId} signals={signals} />
      <div style={{ display: "flex", gap: 6, margin: "12px 0" }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${C.line}`, background: tab === k ? C.accent : "transparent", color: tab === k ? "var(--accentInk)" : C.ink, cursor: "pointer", fontWeight: 600 }}>{label}</button>
        ))}
      </div>
      {tab === "matrix" && <MatrixTab cabinetId={cabinetId} onSignals={setSignals} />}
      {tab === "places" && <PlacesTab cabinetId={cabinetId} onSignals={setSignals} />}
      {tab === "supplies" && <SuppliesTab cabinetId={cabinetId} />}
    </div>
  );
}
