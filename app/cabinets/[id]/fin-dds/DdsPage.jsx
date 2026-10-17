"use client";
// /fin-dds — ДДС: журнал факта, отчёт, счета, статьи (17.10.2026, спека docs/superpowers/specs/2026-10-17-dds-design.md §5).
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { C } from "@/lib/palette.js";
import FinanceMoneyTabs from "../fin-calendar/FinanceMoneyTabs.jsx";
import JournalTab from "./JournalTab.jsx";
import ReportTab from "./ReportTab.jsx";
import AccountsTab from "./AccountsTab.jsx";
import ArticlesTab from "./ArticlesTab.jsx";
import { api } from "./ddsUi.js";

export default function DdsPage({ cabinetId }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [refs, setRefs] = useState(null);
  const [err, setErr] = useState(null);
  const tab = sp.get("tab") || "journal";
  const loadRefs = useCallback(() => {
    api(`/api/cabinets/${cabinetId}/dds-refs`).then(setRefs).catch((e) => setErr(e.message));
  }, [cabinetId]);
  useEffect(() => { loadRefs(); }, [loadRefs]);
  const go = (t, extra = {}) => {
    const p = new URLSearchParams({ tab: t, ...extra });
    router.replace(`/cabinets/${cabinetId}/fin-dds?${p.toString()}`);
  };
  const tabs = [["journal", "Операции"], ["report", "Отчёт"], ...(refs?.isOwner ? [["accounts", "Счета"]] : []), ["articles", "Статьи"]];
  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: C.ink, padding: "20px 16px", maxWidth: 1400, margin: "0 auto" }}>
      <FinanceMoneyTabs cabinetId={cabinetId} active="dds" />
      <h1 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 800 }}>ДДС — движение денежных средств</h1>
      <p style={{ margin: "0 0 14px", color: C.muted, fontSize: 13 }}>Фактические поступления и списания по счетам. Плановые платежи — в «Платёжном календаре».</p>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => go(k)} style={{ padding: "6px 14px", borderRadius: 16, fontSize: 13, fontWeight: 600, cursor: "pointer",
            border: `1px solid ${tab === k ? C.accent : C.line}`, background: tab === k ? C.accent : "transparent", color: tab === k ? "var(--accentInk)" : C.ink }}>{l}</button>
        ))}
      </div>
      {err && <div style={{ color: C.neg, marginBottom: 12 }}>⚠ {err}</div>}
      {refs && tab === "journal" && <JournalTab cabinetId={cabinetId} refs={refs} initial={Object.fromEntries(sp.entries())} />}
      {refs && tab === "report" && <ReportTab cabinetId={cabinetId} refs={refs} onDrill={(f) => go("journal", f)} />}
      {refs && tab === "accounts" && refs.isOwner && <AccountsTab cabinetId={cabinetId} refs={refs} onChanged={loadRefs} />}
      {refs && tab === "articles" && <ArticlesTab cabinetId={cabinetId} refs={refs} onChanged={loadRefs} />}
    </div>
  );
}
