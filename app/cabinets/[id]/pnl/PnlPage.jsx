"use client";
import { C, soft } from "@/lib/palette.js";
// /cabinets/[id]/pnl — Сводка по прибыли (P&L).
// Поддержка: произвольный диапазон от-до + разбивка по неделям/месяцам
// (отрезки как колонки). Без разбивки — 3 колонки (Показатель/Всего/% выр.).
import { useEffect, useState } from "react";

// Палитра SAAS (тёмно-синяя).


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const money = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
const moneyShort = (n) => {
  if (n == null) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  return abs >= 1_000_000
    ? `${sign}${(abs / 1_000_000).toFixed(2)} млн ₽`
    : `${sign}${Math.round(abs / 1000)} тыс ₽`;
};

// Строки P&L: kind → h0=главный итог, h1=подытог, sub=расход, plain=прочее.
// field — ключ в total для подстановки значения. Источник — канон
// (ozProfitCabinet/wbProfitCabinet, задача 4 плана унификации прибыли):
// одна формула на обе площадки, реклама/лояльность/кабинетные расходы —
// впервые в P&L. Кабинетные статьи (accrual_*, WB-типы) — не отдельными
// типизированными полями (их больше нет в ответе роута), а суммой
// cabinetCostsTotal здесь + расшифровкой по статьям отдельным блоком ниже
// (см. cabinetCosts[] в рендере).
// hasRevenueGross — показывать ли справочную строку «Выручка (валовая)».
// Поле revenueGross аддитивно и приходит ТОЛЬКО от WB-блока роута (задача
// «WB валовая выручка справочной строкой», 2026-08-20) — у Ozon revenue уже
// валовая, отдельного поля нет. Строку скрываем, если в кабинете нет WB
// (иначе была бы «Выручка (валовая) 0 ₽» — вводит в заблуждение).
const buildRows = (taxLabel, hasRevenueGross) => [
  { label: "Выручка", field: "revenue", color: C.pos, kind: "plain", showPct: true },
  ...(hasRevenueGross ? [{
    label: "Выручка (валовая, WB)", field: "revenueGross", color: C.muted, kind: "plain", showPct: false,
  }] : []),
  { label: "Себестоимость", field: "cogs", negate: true, color: C.neg, kind: "sub", showPct: true },
  { label: "Комиссия МП", field: "commission", negate: true, color: C.neg, kind: "sub", showPct: true },
  { label: "Логистика", field: "logistics", negate: true, color: C.neg, kind: "sub", showPct: true },
  { label: "Эквайринг", field: "acquiring", negate: true, color: C.neg, kind: "sub", showPct: true },
  { label: "Лояльность", field: "loyalty", negate: true, color: C.neg, kind: "sub", showPct: true },
  { label: "Валовая прибыль", field: "grossProfit", kind: "h1", showPct: false },
  { label: "Реклама", field: "ads", negate: true, color: C.neg, kind: "sub", showPct: true },
  { label: taxLabel || "Налог", field: "tax", negate: true, color: C.neg, kind: "sub", showPct: true },
  // Кабинетные расходы — знаковая сумма статей (расход отрицателен, возмещение/
  // доход положителен), см. cabinetCosts[] ниже для расшифровки по статьям.
  { label: "Кабинетные расходы", field: "cabinetCostsTotal", kind: "sub", showPct: true },
  { label: "ЧИСТАЯ ПРИБЫЛЬ", field: "profit", kind: "h0", showPct: false },
];

const valOf = (row, total) => {
  const v = total?.[row.field] || 0;
  return row.negate ? -v : v;
};
const colorOf = (row, v) => {
  if (row.kind === "h0") return v >= 0 ? C.pos : C.neg;
  if (v < 0) return C.neg;
  return row.color || C.ink;
};

export default function PnlPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [dateFrom, setDateFrom] = useState(() => ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [dateTo, setDateTo] = useState(() => ymd(new Date()));
  const [breakdown, setBreakdown] = useState("none"); // none|week|month

  useEffect(() => {
    setData(null); setError(null);
    const q = new URLSearchParams({ from: dateFrom, to: dateTo, breakdown });
    fetch(`/api/cabinets/${cabinetId}/pnl?${q}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setError(d.error); else setData(d); })
      .catch((e) => setError(String(e)));
  }, [cabinetId, dateFrom, dateTo, breakdown]);

  const hasSegments = breakdown !== "none" && data?.segments?.length > 0;

  return (
    <main style={{ width: "100%", maxWidth: hasSegments ? 1400 : 900, margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: C.accent, fontWeight: 700 }}>
          Финотчёт
        </div>
        <h1 style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 800 }}>Сводка по прибыли</h1>
      </div>

      {/* Панель периода + разбивки */}
      <div style={{
        background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14,
        padding: "12px 14px", marginBottom: 18, display: "flex", gap: 14,
        alignItems: "flex-end", flexWrap: "wrap",
      }}>
        <Field label="Период с">
          <input type="date" value={dateFrom} max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)} style={dateInputStyle} />
        </Field>
        <Field label="по">
          <input type="date" value={dateTo} min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)} style={dateInputStyle} />
        </Field>
        <Field label="Разбивка по отрезкам">
          <Seg>
            {[{ v: "none", l: "Нет" }, { v: "week", l: "Недели" }, { v: "month", l: "Месяцы" }].map((o) => (
              <SegBtn key={o.v} active={breakdown === o.v} onClick={() => setBreakdown(o.v)}>{o.l}</SegBtn>
            ))}
          </Seg>
        </Field>
      </div>

      {error && <Centered>Ошибка: {error}</Centered>}
      {!error && !data && <Centered>Загрузка данных…</Centered>}

      {!error && data && (
        <>
          {/* KPI-плашки по всему диапазону */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 18 }}>
            <Card label="Выручка" value={moneyShort(data.total.revenue)} />
            <Card label="Чистая прибыль" value={moneyShort(data.total.profit)} tone={data.total.profit >= 0 ? C.pos : C.neg}
              sub={data.total.revenue ? `рентабельность ${((data.total.profit / data.total.revenue) * 100).toFixed(1)}%` : null} />
            <Card label="Валовая прибыль" value={moneyShort(data.total.grossProfit)} tone={data.total.grossProfit >= 0 ? C.pos : C.neg} />
            <Card label="К перечислению" value={moneyShort(data.total.forPay)} />
          </div>

          {/* Таблица P&L */}
          <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ background: C.surfaceAlt, color: C.muted }}>
                  <th style={thLeft}>Показатель</th>
                  {hasSegments ? (
                    <>
                      {data.segments.map((s, i) => (
                        <th key={i} style={thRight} title={`${s.from} — ${s.to}`}>{s.label}</th>
                      ))}
                      <th style={{ ...thRight, fontWeight: 800, color: C.ink }}>Итого</th>
                    </>
                  ) : (
                    <>
                      <th style={thRight}>Всего</th>
                      <th style={{ ...thRight, width: 90 }}>% выр.</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {buildRows(data.taxLabel, Boolean(data.wb)).map((row, ri) => {
                  const v = valOf(row, data.total);
                  const isTotal = row.kind === "h0" || row.kind === "h1";
                  const big = row.kind === "h0";
                  const weight = row.kind === "h0" ? 800 : row.kind === "h1" ? 700 : 400;
                  const bg = row.kind === "h0" ? C.surfaceAlt : "transparent";
                  const revenue = data.total.revenue || 0;
                  return (
                    <tr key={ri} style={{ borderTop: isTotal ? `2px solid ${C.line}` : `1px solid ${soft("line", 33)}`, background: bg }}>
                      <td style={{
                        padding: isTotal ? "12px 16px" : "9px 16px",
                        paddingLeft: row.kind === "sub" ? 30 : 16,
                        fontWeight: weight, fontSize: big ? 15 : 14, color: C.ink,
                      }}>
                        {row.label}
                      </td>
                      {hasSegments ? (
                        <>
                          {data.segments.map((s, i) => {
                            const sv = valOf(row, s.total);
                            return (
                              <td key={i} style={{
                                padding: "9px 16px", textAlign: "right", whiteSpace: "nowrap",
                                fontVariantNumeric: "tabular-nums", fontSize: big ? 15 : 14,
                                fontWeight: weight, color: colorOf(row, sv),
                              }}>
                                {sv < 0 ? "−" : ""}{money(Math.abs(sv || 0))}
                              </td>
                            );
                          })}
                          <td style={{
                            padding: isTotal ? "12px 16px" : "9px 16px", textAlign: "right", whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: big ? 16 : 14,
                            color: colorOf(row, v),
                          }}>
                            {v < 0 ? "−" : ""}{money(Math.abs(v || 0))}
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{
                            padding: isTotal ? "12px 16px" : "9px 16px", textAlign: "right", whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums", fontWeight: weight, fontSize: big ? 16 : 14,
                            color: colorOf(row, v),
                          }}>
                            {v < 0 ? "−" : ""}{money(Math.abs(v || 0))}
                          </td>
                          <td style={{
                            padding: "9px 16px", textAlign: "right", whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums", color: C.faint, fontSize: 13,
                          }}>
                            {row.showPct && revenue ? `${(Math.abs(v) / revenue * 100).toFixed(1)}%` : ""}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 14, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
            Диапазон: {data.from} — {data.to}.
            Налоги: {data.taxLabel || "УСН по режиму магазина"} — УСН от выручки без НДС, НДС выделяется из цены. «% выр.» — доля строки от выручки, только без разбивки.
            Кабинетные расходы (хранение/продвижение/подписки/штрафы/Premium/RFBS и др.) не привязаны к SKU —
            показаны одной строкой знаковой суммой (расход уменьшает прибыль, возмещение/доход — увеличивает);
            расшифровка по статьям — в блоке «Кабинетные расходы по статьям» ниже.
            {data.wb && " «Выручка (валовая, WB)» — справочная сумма ДО вычета комиссии/логистики/эквайринга WB (retail_amount), для сверки с отчётами маркетплейса; в расчёт прибыли не входит — используется «Выручка» (к перечислению)."}
            {data.total.unknownCostTypes > 0 && ` Не удалось сопоставить название для ${data.total.unknownCostTypes} стат. (показаны как «Прочее»).`}
          </div>

          {/* Кабинетные расходы по статьям — расшифровка cabinetCosts[] из канона
              (ozProfitCabinet/wbProfitCabinet). Суммы знаковые: расход — красным
              со знаком «−», доход/возмещение — обычным цветом без знака. Технические
              ключи (accrual_N) сюда не попадают — label уже резолвлен на сервере. */}
          {!hasSegments && data.total.cabinetCosts && data.total.cabinetCosts.length > 0 && (
            <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginTop: 18 }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700 }}>Кабинетные расходы по статьям</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                    <th style={thLeft}>Статья</th>
                    <th style={thRight}>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {data.total.cabinetCosts.map((c, i) => (
                    <tr key={`${c.label}-${i}`} style={{ borderTop: `1px solid ${soft("line", 33)}` }}>
                      <td style={{ padding: "8px 6px", color: C.ink }}>{c.label}</td>
                      <td style={{
                        padding: "8px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap", color: c.amount < 0 ? C.neg : C.pos,
                      }}>
                        {c.amount < 0 ? "−" : "+"}{money(Math.abs(c.amount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* По маркетплейсам — только без разбивки (при разбивке per-segment WB/Ozon не считаем) */}
          {!hasSegments && data.wb && data.ozon && (
            <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginTop: 18 }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700 }}>По маркетплейсам</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                    <th style={thLeft}>Показатель</th>
                    <th style={thRight}>Wildberries</th>
                    <th style={thRight}>Ozon</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Выручка", "revenue"],
                    ["Себестоимость", "cogs"],
                    ["Комиссия", "commission"],
                    ["Логистика", "logistics"],
                    ["Прибыль", "profit"],
                  ].map(([label, key]) => {
                    const wbVal = data.wb?.[key];
                    const ozVal = data.ozon?.[key];
                    const profitCol = key === "profit";
                    return (
                      <tr key={key} style={{ borderTop: `1px solid ${soft("line", 33)}` }}>
                        <td style={{ padding: "8px 6px", color: C.ink, fontWeight: profitCol ? 700 : 400 }}>{label}</td>
                        <td style={{ padding: "8px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: profitCol ? (wbVal >= 0 ? C.pos : C.neg) : C.ink, whiteSpace: "nowrap" }}>{money(wbVal)}</td>
                        <td style={{ padding: "8px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: profitCol ? (ozVal >= 0 ? C.pos : C.neg) : C.ink, whiteSpace: "nowrap" }}>{money(ozVal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}

// --- компоненты ---
function Card({ label, value, sub, tone }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 18px" }}>
      <div style={{ fontSize: 12.5, color: C.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, letterSpacing: -0.5, color: tone || C.ink }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, color: C.faint, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</span>
      <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>{children}</div>
    </label>
  );
}
function Seg({ children }) {
  return <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>{children}</div>;
}
function SegBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none",
      background: active ? C.accent : C.surfaceAlt, color: active ? "var(--accentInk)" : C.ink,
      fontFamily: "inherit",
    }}>{children}</button>
  );
}

const dateInputStyle = {
  padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit",
};
const thLeft = { textAlign: "left", padding: "10px 16px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, color: C.muted, whiteSpace: "nowrap" };
const thRight = { textAlign: "right", padding: "10px 16px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, color: C.muted, whiteSpace: "nowrap" };

function Centered({ children }) {
  return (
    <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
}
