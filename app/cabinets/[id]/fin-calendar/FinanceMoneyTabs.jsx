"use client";
import Link from "next/link";
import { C } from "@/lib/palette.js";

// Общие вкладки над ДДС / Планом поступлений / Платёжным календарём (15.10.2026).
// Спека docs/superpowers/specs/2026-10-15-payment-calendar-design.md §3.1.
const TABS = [
  { key: "dds", href: "/fin-dds", label: "ДДС" },
  { key: "income", href: "/fin-income", label: "План поступлений" },
  { key: "calendar", href: "/fin-calendar", label: "Платёжный календарь" },
];

export default function FinanceMoneyTabs({ cabinetId, active }) {
  return (
    <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.line}`, marginBottom: 16 }}>
      {TABS.map((t) => (
        <Link key={t.key} href={`/cabinets/${cabinetId}${t.href}`}
          style={{ padding: "8px 14px", fontSize: 14, fontWeight: 600, textDecoration: "none",
            color: active === t.key ? C.ink : C.muted, background: active === t.key ? C.surface : "transparent",
            border: `1px solid ${active === t.key ? C.line : "transparent"}`, borderBottom: "none", borderRadius: "8px 8px 0 0",
            marginBottom: -1 }}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
