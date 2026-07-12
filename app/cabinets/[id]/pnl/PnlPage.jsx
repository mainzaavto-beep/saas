"use client";
// /cabinets/[id]/pnl — Сводка по прибыли (P&L).
// Сохраняет SAAS-фичи (месяц-селектор, блок «По маркетплейсам») + добавляет
// колонку «% от выручки» и улучшенную стилизацию итоговых строк из эталона.
import { useEffect, useState } from "react";

// Палитра SAAS (тёмно-синяя), согласована с globals.css.
const C = {
  bg: "#0b1220",
  surface: "#131c2e",
  surfaceAlt: "#1a2540",
  ink: "#e8edf7",
  muted: "#8a99b8",
  faint: "#6b7a8f",
  line: "#243049",
  accent: "#4f8cff",
  pos: "#4ade80",
  neg: "#ff6b6b",
};

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
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
const fmtFull = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

export default function PnlPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));

  useEffect(() => {
    setData(null); setError(null);
    fetch(`/api/cabinets/${cabinetId}/pnl?period=${period}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setError(d.error); else setData(d); })
      .catch((e) => setError(String(e)));
  }, [cabinetId, period]);

  if (error) return <Centered>Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка данных…</Centered>;

  const t = data.total || {};
  const revenue = t.netSales || 0;
  // % от выручки для строки; null для служебных (нетто/валовая/чистая).
  const pctOfRev = (v) => (revenue ? (Math.abs(v) / revenue) * 100 : null);

  // Строки P&L: kind → h0=главный итог(чистая), h1=подытог(нетто/валовая),
  // sub=расход, plain=прочее. pct: true → показываем % от выручки.
  const rows = [
    { label: "Выручка (брутто)", value: t.sales, color: C.pos, kind: "plain", showPct: true },
    { label: "Возвраты", value: -t.returns, color: C.neg, kind: "sub", showPct: true },
    { label: "Выручка (нетто)", value: t.netSales, color: C.pos, kind: "h1", showPct: false },
    { label: "Себестоимость", value: -t.cost, color: C.neg, kind: "sub", showPct: true },
    { label: "Валовая прибыль", value: t.grossProfit, color: t.grossProfit >= 0 ? C.pos : C.neg, kind: "h1", showPct: false },
    { label: "Комиссия МП", value: -t.commission, color: C.neg, kind: "sub", showPct: true },
    { label: "Логистика", value: -t.logistics, color: C.neg, kind: "sub", showPct: true },
    { label: "Эквайринг", value: -t.acquiring, color: C.neg, kind: "sub", showPct: true },
    { label: "Хранение", value: -t.storage, color: C.neg, kind: "sub", showPct: true },
    { label: "УСН 6%", value: -t.tax, color: C.neg, kind: "sub", showPct: true },
    { label: "ЧИСТАЯ ПРИБЫЛЬ", value: t.netProfit, color: t.netProfit >= 0 ? C.pos : C.neg, kind: "h0", showPct: false },
  ];

  return (
    <main style={{ width: "100%", margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: C.accent, fontWeight: 700 }}>
            Финотчёт
          </div>
          <h1 style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 800 }}>Сводка по прибыли</h1>
        </div>
        <input
          type="month" value={period}
          onChange={(e) => setPeriod(e.target.value)}
          style={{
            padding: "8px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`,
            borderRadius: 8, color: C.ink, fontSize: 14, fontFamily: "inherit", colorScheme: "dark",
          }}
        />
      </div>

      {/* Итоговые плашки */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 18 }}>
        <Card label="Выручка (нетто)" value={moneyShort(t.netSales)} />
        <Card
          label="Чистая прибыль"
          value={moneyShort(t.netProfit)}
          tone={t.netProfit >= 0 ? C.pos : C.neg}
          sub={revenue ? `рентабельность ${((t.netProfit / revenue) * 100).toFixed(1)}%` : null}
        />
        <Card label="Валовая прибыль" value={moneyShort(t.grossProfit)} tone={t.grossProfit >= 0 ? C.pos : C.neg} />
        <Card label="К перечислению" value={moneyShort(t.forPay)} />
      </div>

      {/* Таблица P&L */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, color: C.muted }}>
              <th style={thStyleLeft}>Показатель</th>
              <th style={thStyleRight}>Всего</th>
              <th style={{ ...thStyleRight, width: 90 }}>% выр.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isTotal = r.kind === "h0" || r.kind === "h1";
              const big = r.kind === "h0";
              const weight = r.kind === "h0" ? 800 : r.kind === "h1" ? 700 : 400;
              const bg = r.kind === "h0" ? C.surfaceAlt : "transparent";
              const p = r.showPct ? pctOfRev(r.value) : null;
              const valColor = r.kind === "h0"
                ? (r.value >= 0 ? C.pos : C.neg)
                : (r.value < 0 ? C.neg : r.color || C.ink);
              return (
                <tr key={i} style={{ borderTop: isTotal ? `2px solid ${C.line}` : `1px solid ${C.line}55`, background: bg }}>
                  <td style={{
                    padding: isTotal ? "12px 16px" : "9px 16px",
                    paddingLeft: r.kind === "sub" ? 30 : 16,
                    fontWeight: weight, fontSize: big ? 15 : 14, color: C.ink,
                  }}>
                    {r.label}
                  </td>
                  <td style={{
                    padding: isTotal ? "12px 16px" : "9px 16px", textAlign: "right",
                    fontVariantNumeric: "tabular-nums", fontWeight: weight,
                    fontSize: big ? 16 : 14, color: valColor, whiteSpace: "nowrap",
                  }}>
                    {r.value < 0 ? "−" : ""}{money(Math.abs(r.value || 0))}
                  </td>
                  <td style={{
                    padding: "9px 16px", textAlign: "right",
                    fontVariantNumeric: "tabular-nums", color: C.faint, fontSize: 13, whiteSpace: "nowrap",
                  }}>
                    {p != null ? `${p.toFixed(1)}%` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
        Налоги: УСН «доходы» 6% от выручки. «% выр.» — доля строки от выручки (нетто).
        Хранение не входит в per-SKU прибыль (контракт №27) — показано отдельной строкой.
      </div>

      {/* По маркетплейсам */}
      {data.wb && data.ozon && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginTop: 18 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700 }}>По маркетплейсам</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                <th style={thStyleLeft}>Показатель</th>
                <th style={thStyleRight}>Wildberries</th>
                <th style={thStyleRight}>Ozon</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Выручка (нетто)", "netSales"],
                ["Себестоимость", "cost"],
                ["Комиссия", "commission"],
                ["Логистика", "logistics"],
                ["Прибыль", "netProfit"],
              ].map(([label, key]) => {
                const wbVal = data.wb?.[key];
                const ozVal = data.ozon?.[key];
                const profitCol = key === "netProfit";
                return (
                  <tr key={key} style={{ borderTop: `1px solid ${C.line}55` }}>
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

const thStyleLeft = { textAlign: "left", padding: "10px 16px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, color: C.muted };
const thStyleRight = { textAlign: "right", padding: "10px 16px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, color: C.muted };

function Centered({ children }) {
  return (
    <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
}
