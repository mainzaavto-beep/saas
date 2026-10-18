"use client";
// ReportTab — вкладка «Отчёт» ДДС: статьи × месяцы/недели, остатки, разрез по счетам (17.10.2026,
// спека docs/superpowers/specs/2026-10-17-dds-design.md §5).
import { useCallback, useEffect, useState } from "react";
import { C, soft } from "@/lib/palette.js";
import { api, money, S } from "./ddsUi.js";

const todayYM = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function lastDayOfMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

const sticky = { position: "sticky", left: 0, background: C.bg, zIndex: 1 };

function fmt(v, { expense = false, bold = false } = {}) {
  const n = Number(v) || 0;
  if (n === 0) return <span style={{ color: C.faint }}>—</span>;
  const neg = expense ? n > 0 : n < 0;
  const text = (neg ? "−" : "") + money(Math.abs(n));
  return <span style={{ color: neg && !expense ? C.neg : C.ink, fontWeight: bold ? 700 : 400 }}>{text}</span>;
}

function Row({ label, cells, total, indent, bold, onCellClick, expense, title, sub }) {
  return (
    <tr style={{ borderBottom: `1px solid ${soft("line", 15)}` }}>
      <td style={{ ...S.td, ...sticky, paddingLeft: 10 + (indent || 0) * 16, fontWeight: bold ? 700 : 400, color: sub ? C.muted : C.ink, fontSize: sub ? 12 : 13 }} title={title}>
        {label}
      </td>
      {cells.map((v, i) => (
        <td key={i} style={{ ...S.td, ...S.num, cursor: onCellClick ? "pointer" : "default" }}
          onClick={onCellClick ? () => onCellClick(i) : undefined}>
          {fmt(v, { expense, bold })}
        </td>
      ))}
      <td style={{ ...S.td, ...S.num, fontWeight: 700, cursor: onCellClick ? "pointer" : "default" }}
        onClick={onCellClick ? () => onCellClick(-1) : undefined}>
        {fmt(total, { expense, bold: true })}
      </td>
    </tr>
  );
}

export default function ReportTab({ cabinetId, refs, onDrill }) {
  const [fromMonth, setFromMonth] = useState(() => shiftMonth(todayYM(), -5));
  const [toMonth, setToMonth] = useState(() => todayYM());
  const [grain, setGrain] = useState("month");
  const [byAccount, setByAccount] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!fromMonth || !toMonth || fromMonth > toMonth) return;
    setLoading(true); setErr(null);
    const qs = new URLSearchParams({ view: "report", from: `${fromMonth}-01`, to: lastDayOfMonth(toMonth), grain });
    api(`/api/cabinets/${cabinetId}/dds?${qs.toString()}`)
      .then(setData)
      .catch((e) => { console.error("report load", e); setErr(e.message); })
      .finally(() => setLoading(false));
  }, [cabinetId, fromMonth, toMonth, grain]);
  useEffect(() => { load(); }, [load]);

  const toggle = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  const drillArticle = (key, cols) => (i) => {
    if (!onDrill) return;
    if (i === -1) onDrill({ article: key, from: data.from, to: data.to });
    else onDrill({ article: key, from: cols[i].from, to: cols[i].to });
  };

  const nCols = data ? data.columns.length : 0;
  const hasAdjust = data?.adjust && data.adjust.some((v) => v !== 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
          С <input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} style={S.input} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
          По <input type="month" value={toMonth} onChange={(e) => setToMonth(e.target.value)} style={S.input} />
        </label>
        <div style={{ display: "flex", gap: 4 }}>
          {[["month", "Месяцы"], ["week", "Недели"]].map(([k, l]) => (
            <button key={k} onClick={() => setGrain(k)} style={{
              ...S.btn, borderColor: grain === k ? C.accent : C.line, background: grain === k ? C.accent : C.surface,
              color: grain === k ? "var(--accentInk)" : C.ink,
            }}>{l}</button>
          ))}
        </div>
        {data?.isOwner && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.muted, cursor: "pointer" }}>
            <input type="checkbox" checked={byAccount} onChange={(e) => setByAccount(e.target.checked)} /> По счетам
          </label>
        )}
      </div>

      {err && <div style={{ color: C.neg, marginBottom: 12 }}>⚠ {err}</div>}
      {!data && loading && <div style={{ color: C.faint, padding: 20 }}>Загрузка…</div>}

      {data && (
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%", minWidth: 200 + nCols * 110 }}>
            <thead>
              <tr style={{ background: C.surface }}>
                <th style={{ ...S.th, ...sticky, background: C.surface }}>Статья</th>
                {data.columns.map((c) => (
                  <th key={c.key} style={{ ...S.th, textAlign: "right" }}>{c.label}{c.partial ? " · идёт" : ""}</th>
                ))}
                <th style={{ ...S.th, textAlign: "right" }}>Итого</th>
              </tr>
            </thead>
            <tbody>
              {data.isOwner && (
                <Row label="Остаток на начало" cells={data.opening} total={data.openingTotal} bold />
              )}

              {data.groups.map((g) => (
                <GroupBlock key={g.activity} g={g} collapsed={!!collapsed[g.activity]} onToggle={() => toggle(g.activity)} onDrill={drillArticle} columns={data.columns} />
              ))}

              <Row label="Чистый денежный поток" cells={data.netFlow} total={data.netFlowTotal} bold />

              {data.isOwner && hasAdjust && (
                <Row label="Изменение остатков вне статей" cells={data.adjust} total={data.adjustTotal} sub
                  title="Старт счёта или операции до даты старта счёта — входят в остаток, но не в поток статей" />
              )}
              {data.isOwner && (
                <Row label="Остаток на конец" cells={data.closing} total={data.closingTotal} bold />
              )}
              {data.isOwner && byAccount && (data.byAccount || []).map((a) => (
                <Row key={a.id} label={a.name} cells={a.closing} total={a.closing[a.closing.length - 1] ?? 0} indent={1} sub />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GroupBlock({ g, collapsed, onToggle, onDrill, columns }) {
  return (
    <>
      <tr style={{ background: soft("surfaceAlt", 60) }}>
        <td colSpan={columns.length + 2} style={{ ...S.td, fontWeight: 700, cursor: "pointer" }} onClick={onToggle}>
          {collapsed ? "▸" : "▾"} {g.label}
        </td>
      </tr>
      {!collapsed && (
        <>
          <Row label="Поступления" cells={g.incomeTotal} total={g.income.reduce((s, r) => s + r.total, 0)} indent={1} />
          {g.income.map((r) => (
            <Row key={r.key} label={r.label} cells={r.cells} total={r.total} indent={2} sub onCellClick={onDrill(r.key, columns)} />
          ))}
          <Row label="Выбытия" cells={g.expenseTotal} total={g.expense.reduce((s, r) => s + r.total, 0)} indent={1} expense />
          {g.expense.map((r) => (
            <Row key={r.key} label={r.label} cells={r.cells} total={r.total} indent={2} sub expense onCellClick={onDrill(r.key, columns)} />
          ))}
          <Row label={`Сальдо: ${g.label}`} cells={g.net} total={g.netTotal} indent={1} bold />
        </>
      )}
    </>
  );
}
