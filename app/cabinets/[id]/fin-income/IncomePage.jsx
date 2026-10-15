"use client";
import FinanceMoneyTabs from "../fin-calendar/FinanceMoneyTabs.jsx";
import MoneyCalendar from "../fin-calendar/MoneyCalendar.jsx";

// План поступлений (15.10.2026): та же сетка, что «Платёжный календарь», kind=income —
// ручные поступления + прогноз выплат WB/Ozon на окно. Спека
// docs/superpowers/specs/2026-10-15-payment-calendar-design.md §3.3.
export default function IncomePage({ cabinetId }) {
  return (
    <div style={{ padding: "20px 28px" }}>
      <FinanceMoneyTabs cabinetId={cabinetId} active="income" />
      <MoneyCalendar cabinetId={cabinetId} kind="income" />
    </div>
  );
}
