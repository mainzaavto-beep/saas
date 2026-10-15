"use client";
import FinanceMoneyTabs from "./FinanceMoneyTabs.jsx";
import MoneyCalendar from "./MoneyCalendar.jsx";

// Платёжный календарь (15.10.2026): расходы по дням поверх tenant.dds_movements.
// Спека docs/superpowers/specs/2026-10-15-payment-calendar-design.md.
export default function CalendarPage({ cabinetId }) {
  return (
    <div style={{ padding: "20px 28px" }}>
      <FinanceMoneyTabs cabinetId={cabinetId} active="calendar" />
      <MoneyCalendar cabinetId={cabinetId} kind="expense" />
    </div>
  );
}
