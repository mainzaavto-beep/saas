"use client";
import { C, soft } from "@/lib/palette.js";

import { useEffect, useState, useCallback } from "react";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";

// =====================================================================
//  /finance/calendar — «ПЛАН ПЛАТЕЖЕЙ» (заявка 2026-06-27).
//
//  Агрегат всех источников по неделям (гибрид: engine=python, fin/payment_plan.py):
//  факт(bank) + план-расход по категориям (закупки/opex/налоги/реклама) +
//  план-доход (продажи + ДДС-planned income). Расширение старого payment_calendar.
//
//  Таблица недель: факт+/факт−/план+/план−/net/баланс(нарастающий, красный
//  при <0) + breakdown план-расхода по 4 категориям. Недели at_risk=true →
//  подсветка жёлтым + ⚠️. AreaChart нарастающего баланса.
//  При падении fin-агента — авто-fallback на автономный JS (calendarCalc).
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
const fmtWeek = (iso) => {
  // ISO-дата понедельника → кратко «24.06».
  if (!iso) return "—";
  return iso.slice(8, 10) + "." + iso.slice(5, 7);
};

const HORIZONS = [4, 8, 12];

export default function CalendarPage({ cabinetId }) {
  const [horizon, setHorizon] = useState(8);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/payment-plan?horizon_weeks=${horizon}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [horizon]);

  useEffect(() => { reload(); }, [reload]);

  const weeks = data?.weeks || [];
  const starting = data?.starting_balance ?? 0;
  const endBalance = weeks.length ? weeks[weeks.length - 1].cumulative : starting;
  const breakWeeks = weeks.filter((w) => w.at_risk).length;

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1300, margin: "0 auto" }}>
      <Header />

      <div style={{ ...alertStyle, marginBottom: 16 }}>
        <strong>План платежей</strong> — агрегат всех источников по неделям: прошедшие =
        ФАКТ (bank_transactions), будущие = ПЛАН. План-расход разбит по категориям:
        <strong> Закуп</strong> (purchase_plan/payments), <strong>OPEX</strong> (постоянные),
        <strong> Налог</strong> (УСН + НДС по режиму магазина; УСН от выручки без НДС), <strong>Рекл</strong> (прогноз).
        План-доход = поступления от продаж (сдвиг +1 мес на выплаты МП) + авто-поступления из ДДС.
        Нарастающий баланс; недели кассового разрыва подсвечены ⚠️. Считается в финансовом
        агенте (<code>fin/payment_plan.py</code>, engine=python); при его недоступности —
        авто-fallback на автономный JS дашборда.
      </div>

      {/* Селектор горизонта */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 16 }}>
        <Field label="Горизонт (недель)">
          <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
            {HORIZONS.map((h) => (
              <button key={h} onClick={() => setHorizon(h)}
                style={{
                  padding: "6px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  background: horizon === h ? C.accent : C.bg, color: horizon === h ? "#0A1A1C" : C.muted,
                  border: "none",
                }}>
                {h}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {error && <div style={{ color: C.neg, margin: "0 0 12px" }}>⚠ {error}</div>}

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Стартовый баланс" value={money(starting)} color={starting >= 0 ? C.ink : C.neg} />
        <Kpi label="Конечный баланс" value={money(endBalance)} color={endBalance >= 0 ? C.pos : C.neg} />
        <Kpi label="Недель разрыва" value={String(breakWeeks)} color={breakWeeks > 0 ? C.neg : C.pos} />
        <Kpi label="Недель в горизонте" value={String(weeks.length)} />
      </div>

      {/* График нарастающего баланса */}
      {weeks.length > 0 && (
        <div style={{ height: 280, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 20 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={weeks} margin={{ top: 6, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.accent} stopOpacity={0.5} />
                  <stop offset="95%" stopColor={C.accent} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={C.line} vertical={false} />
              <XAxis dataKey="week" tickFormatter={fmtWeek} tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} width={52}
                tickFormatter={(v) => new Intl.NumberFormat("ru-RU", { notation: "compact" }).format(v)} />
              <Tooltip
                labelFormatter={(l) => `нед. ${l}`}
                formatter={(v) => [money(v), "баланс"]}
                contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 }}
              />
              <ReferenceLine y={0} stroke={C.neg} strokeDasharray="4 4" />
              <Area type="monotone" dataKey="cumulative" name="Баланс" stroke={C.accent} strokeWidth={2.5} fill="url(#balGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Таблица недель */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1100 }}>
          <thead>
            <tr style={{ background: C.surface, borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}>Неделя</th>
              <th style={thR}>Факт +</th>
              <th style={thR}>Факт −</th>
              <th style={thR}>План +</th>
              <th style={thR}>План −</th>
              <th style={thR} title="Расходы на закупку товара">Закуп</th>
              <th style={thR} title="Постоянные расходы (OPEX)">OPEX</th>
              <th style={thR} title="Налоги (УСН + НДС по режиму магазина)">Налог</th>
              <th style={thR} title="Реклама (прогноз)">Рекл</th>
              <th style={thR}>Net</th>
              <th style={thR}>Баланс</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => {
              const bd = w.plan_exp_breakdown || {};
              return (
              <tr key={w.week} style={{
                borderBottom: `1px solid ${soft("line", 20)}`,
                background: w.at_risk ? "rgba(255,193,7,0.08)" : "transparent",
              }}>
                <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                  {fmtWeek(w.week)}{w.at_risk ? <span title="кассовый разрыв"> ⚠️</span> : null}
                </td>
                <td style={tdRight}><span style={{ color: C.pos }}>{w.fact_income ? "+" + money(w.fact_income) : "—"}</span></td>
                <td style={tdRight}><span style={{ color: C.neg }}>{w.fact_expense ? "−" + money(w.fact_expense) : "—"}</span></td>
                <td style={tdRight}><span style={{ color: C.pos }}>{w.plan_income ? "+" + money(w.plan_income) : "—"}</span></td>
                <td style={tdRight}><span style={{ color: C.neg }}>{w.plan_expense ? "−" + money(w.plan_expense) : "—"}</span></td>
                <td style={tdRight}><span style={{ color: bd.purchase ? C.neg : C.faint }}>{bd.purchase ? money(bd.purchase) : "·"}</span></td>
                <td style={tdRight}><span style={{ color: bd.opex ? C.neg : C.faint }}>{bd.opex ? money(bd.opex) : "·"}</span></td>
                <td style={tdRight}><span style={{ color: bd.tax ? C.neg : C.faint }}>{bd.tax ? money(bd.tax) : "·"}</span></td>
                <td style={tdRight}><span style={{ color: bd.ads ? C.neg : C.faint }}>{bd.ads ? money(bd.ads) : "·"}</span></td>
                <td style={tdRight}>
                  <strong style={{ color: w.net >= 0 ? C.pos : C.neg }}>{w.net >= 0 ? "+" : ""}{money(w.net)}</strong>
                </td>
                <td style={tdRight}>
                  <strong style={{ color: w.cumulative >= 0 ? C.ink : C.neg }}>{money(w.cumulative)}</strong>
                </td>
              </tr>
              );
            })}
            {weeks.length === 0 && !loading && (
              <tr><td colSpan={11} style={{ padding: 24, textAlign: "center", color: C.faint }}>
                Нет данных. Проверьте fin_data.db (bank_transactions, purchase_plan, sales_plan, opex).
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- UI-компоненты ----------------
function Header() {
  return (
    <div style={{ marginBottom: 14 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>План платежей</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Агрегат всех источников по неделям: факт + план (закупки/OPEX/налоги/реклама/доход).
        Прогноз кассового разрыва.
      </p>
    </div>
  );
}
function Kpi({ label, value, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 160px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink }}>{value}</div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
      {label}{children}
    </label>
  );
}

// ---------------- Стили ----------------
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const alertStyle = {
  padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
  background: C.surface, border: `1px solid ${C.line}`, color: C.muted,
};
