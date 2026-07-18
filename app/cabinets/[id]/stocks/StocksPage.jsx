"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState, useCallback, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

// /cabinets/[id]/stocks — Склады и индексы.
//
// 4 вкладки:
//   • Склады    — распределение остатков по складам WB/Ozon (%, стоимость).
//   • Индексы   — дни до out-of-stock, оборачиваемость по товарам.
//   • Динамика  — тренд остатков по дням (история; WB-график скрыт, если истории <7 дней).
//   • Финансы   — себест./реализация по складам, мёртвый капитал.
//
// Источник: GET /api/cabinets/[id]/stocks?vel=7|14|30|60 (один запрос — все данные).
const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
const num = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const fmtFull = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
};
const fmtFullLong = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
};

const TABS = [
  { id: "warehouses", label: "Склады", icon: "🏭" },
  { id: "oos",        label: "Индексы OOS", icon: "📉" },
  { id: "dynamics",   label: "Динамика", icon: "📈" },
  { id: "finances",   label: "Финансы", icon: "💰" },
];
const VEL_OPTIONS = [7, 14, 30, 60];

// OOS-статус → метаданные для бейджа.
const OOS_META = {
  out:       { label: "Нет остатка",  color: "neg",   icon: "🔴" },
  critical:  { label: "Критично",     color: "warn",  icon: "🟠" },
  low:       { label: "Мало",         color: "warn",  icon: "🟡" },
  ok:        { label: "Норма",        color: "pos",   icon: "🟢" },
  no_sales:  { label: "Нет продаж",   color: "faint", icon: "⚪" },
};

export default function StocksPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [vel, setVel] = useState(7);
  const [mp, setMp] = useState("all");          // all | wb | ozon
  const [tab, setTab] = useState("warehouses");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/stocks?vel=${vel}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId, vel]);

  useEffect(() => { reload(); }, [reload]);

  const allItems = data?.items || [];
  const allWh = data?.byWarehouse || [];
  const cats = data?.categories || [];

  const mpFilter = useCallback((arr) =>
    arr.filter((x) => (mp === "all" ? true : x.platform === mp)), [mp]);

  const itemsF = useMemo(() => mpFilter(allItems).filter((it) => {
    if (category && it.category !== category) return false;
    if (!q) return true;
    const s = q.toLowerCase();
    return String(it.name || "").toLowerCase().includes(s)
      || String(it.sku || "").toLowerCase().includes(s)
      || String(it.article || "").toLowerCase().includes(s);
  }), [mpFilter, allItems, q, category]);

  const whF = useMemo(() => mpFilter(allWh), [mpFilter, allWh]);

  const totals = data?.totals || { all: {}, wb: {}, ozon: {} };
  const totalsForMp = mp === "wb" ? totals.wb : mp === "ozon" ? totals.ozon : totals.all;

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (loading && !data) return <Centered>Загрузка…</Centered>;
  if (!data) return <Centered>Нет данных</Centered>;

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1500, margin: "0 auto" }}>
      <Header dateWb={data.dateWb} dateOzon={data.dateOzon} vel={data.velocityWindow} />

      {/* Контролы: переключатель МП + окно velocity */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <Segmented value={mp} onChange={setMp} options={[
          { v: "all", l: "Все" }, { v: "wb", l: "Wildberries" }, { v: "ozon", l: "Ozon" },
        ]} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.muted }}>Окно оборачиваемости:</span>
        <Segmented value={String(vel)} onChange={(v) => setVel(Number(v))} options={
          VEL_OPTIONS.map((v) => ({ v: String(v), l: `${v} дн` }))
        } />
      </div>

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Остаток (шт)" value={num(totalsForMp.quantity_full)} accent />
        <Kpi label="Σ себест." value={money(totalsForMp.value_cost)} color={C.neg} />
        <Kpi label="Σ реализация" value={money(totalsForMp.value_retail)} />
        <Kpi label="Мёртвый капитал" value={money(totalsForMp.dead_capital)}
          color={(totalsForMp.dead_capital || 0) > 0 ? C.warn : C.faint}
          hint="Σ себестоимости товаров без продаж за выбранный период" />
      </div>

      {/* Вкладки */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              ...tabBtn,
              color: tab === t.id ? C.accent : C.muted,
              borderBottom: tab === t.id ? `2px solid ${C.accent}` : "2px solid transparent",
            }}>
            <span style={{ marginRight: 6 }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* Содержимое вкладок */}
      {tab === "warehouses" && (
        <WarehousesTable rows={whF} totalFull={totalsForMp.quantity_full} />
      )}
      {tab === "oos" && (
        <OosTable items={itemsF} vel={data.velocityWindow} categories={cats} q={q} setQ={setQ} category={category} setCategory={setCategory} />
      )}
      {tab === "dynamics" && (
        <DynamicsChart dynamics={data.dynamics} wbTooShort={data.wbTooShort} mp={mp} />
      )}
      {tab === "finances" && (
        <FinancesTable rows={whF} />
      )}
    </div>
  );
}

// =====================================================================
//  Вкладка 1: распределение по складам
// =====================================================================
function WarehousesTable({ rows, totalFull }) {
  const maxFull = Math.max(...rows.map((r) => r.quantity_full || 0), 1);
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
            <th style={thLeft}>МП</th>
            <th style={thLeft}>Склад</th>
            <th style={thR}>Остаток (шт)</th>
            <th style={thR}>Полный</th>
            <th style={thLeft}>Товаров</th>
            <th style={{ ...thLeft, width: 140 }}>Доля</th>
            <th style={thR}>Σ себест.</th>
            <th style={thR}>Σ реализация</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.platform}-${r.warehouse}-${i}`} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
              <td style={tdLeft}><MpBadge platform={r.platform} /></td>
              <td style={tdLeft}>{r.warehouse}</td>
              <td style={tdRight}>{num(r.quantity)}</td>
              <td style={{ ...tdRight, fontWeight: 700 }}>{num(r.quantity_full)}</td>
              <td style={tdRight}>{num(r.items)}</td>
              <td style={tdLeft}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ height: 6, flex: 1, background: C.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${Math.max(1, (r.quantity_full / maxFull) * 100)}%`,
                      background: r.platform === "wb" ? C.accent : C.pink,
                    }} />
                  </div>
                  <span style={{ fontSize: 11, color: C.muted, minWidth: 40, textAlign: "right" }}>{r.share_pct}%</span>
                </div>
              </td>
              <td style={{ ...tdRight, color: C.neg }}>{money(r.value_cost)}</td>
              <td style={tdRight}>{money(r.value_retail)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: C.muted }}>
              Нет данных по складам для выбранного фильтра.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// =====================================================================
//  Вкладка 2: индексы OOS
// =====================================================================
function OosTable({ items, vel, categories, q, setQ, category, setCategory }) {
  return (
    <>
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск товара/артикула…"
          style={{ ...inputStyle, flex: 1, minWidth: 200 }} />
        {categories.length > 0 && (
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...inputStyle, width: "auto" }}>
            <option value="">Все категории</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>
      <div style={{ fontSize: 12, color: C.faint, marginBottom: 8 }}>
        Сортировка по срочности: сначала критичные (скоро закончится), затем норма, в конце — без продаж.
        Оборачиваемость = средние продажи/день за {vel} дн.
      </div>
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}>Товар</th>
              <th style={thLeft}>МП</th>
              <th style={thR}>Остаток</th>
              <th style={thR}>Продаж/день</th>
              <th style={thR}>Дней до OOS</th>
              <th style={thLeft}>Статус</th>
              <th style={thR}>Заморожено ₽</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <OosRow key={`${it.platform}-${it.sku}-${i}`} it={it} />
            ))}
            {items.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: C.muted }}>
                Нет товаров по фильтру.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OosRow({ it }) {
  const meta = OOS_META[it.status] || OOS_META.no_sales;
  const color = C[meta.color] || C.faint;
  return (
    <tr style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
      <td style={tdLeft}>
        <div>{it.name || "—"}</div>
        <div style={{ fontSize: 11, color: C.faint }}>{it.article || it.sku}{it.category ? ` · ${it.category}` : ""}</div>
      </td>
      <td style={tdLeft}><MpBadge platform={it.platform} /></td>
      <td style={{ ...tdRight, fontWeight: 700, color: (it.quantity_full || 0) === 0 ? C.neg : C.ink }}>
        {num(it.quantity_full)}
      </td>
      <td style={tdRight}>{num(it.velocity) || "—"}</td>
      <td style={{ ...tdRight, fontWeight: 700, color: color }}>
        {it.days_to_oos == null ? (it.status === "out" ? "—" : "∞") : num(it.days_to_oos)}
      </td>
      <td style={tdLeft}>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6,
          background: soft(meta.color === "faint" ? "line" : meta.color, 12),
          color: color,
        }}>{meta.icon} {meta.label}</span>
      </td>
      <td style={{ ...tdRight, color: (it.value_cost || 0) > 0 && it.status === "no_sales" ? C.warn : C.faint }}>
        {money(it.value_cost)}
      </td>
    </tr>
  );
}

// =====================================================================
//  Вкладка 3: динамика остатков
// =====================================================================
function DynamicsChart({ dynamics, wbTooShort, mp }) {
  // Объединяем WB и Ozon по дате в один ряд для recharts.
  const wbMap = {}; for (const r of (dynamics.wb || [])) wbMap[r.date] = r.total;
  const ozMap = {}; for (const r of (dynamics.ozon || [])) ozMap[r.date] = r.total;
  const dates = [...new Set([...Object.keys(wbMap), ...Object.keys(ozMap)])].sort();
  const chartData = dates.map((d) => ({
    date: d,
    wb: wbMap[d] != null ? wbMap[d] : null,
    ozon: ozMap[d] != null ? ozMap[d] : null,
  }));

  const showWb = !wbTooShort && (mp === "all" || mp === "wb");
  const showOz = (dynamics.ozon || []).length > 0 && (mp === "all" || mp === "ozon");

  if (chartData.length === 0 || (!showWb && !showOz)) {
    return <Centered>Недостаточно истории для графика. Данные накапливаются ежедневно.</Centered>;
  }

  return (
    <div>
      {wbTooShort && (mp === "all" || mp === "wb") && (
        <div style={{ ...alertStyle, marginBottom: 12, borderLeft: `3px solid ${C.warn}` }}>
          ⚠️ История остатков WB накапливается (менее 7 дней снимков). График WB появится позже.
          Сейчас показана только динамика Ozon.
        </div>
      )}
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, background: C.surface }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Остатки по дням (шт, полный сток)</div>
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={soft("line", 30)} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.faint }} tickFormatter={(d) => fmtFull(d)} minTickGap={20} />
              <YAxis tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} width={50}
                tickFormatter={(v) => num(v)} />
              <Tooltip
                contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 12 }}
                labelFormatter={(d) => fmtFullLong(d)}
                formatter={(v) => num(v) + " шт"}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {showWb && <Line type="monotone" dataKey="wb" name="Wildberries" stroke={C.accent} strokeWidth={2}
                dot={{ r: 2, fill: C.accent }} connectNulls />}
              {showOz && <Line type="monotone" dataKey="ozon" name="Ozon" stroke={C.pink} strokeWidth={2}
                dot={{ r: 2, fill: C.pink }} connectNulls />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
//  Вкладка 4: финансы по складам
// =====================================================================
function FinancesTable({ rows }) {
  const sorted = [...rows].sort((a, b) => (b.value_cost || 0) - (a.value_cost || 0));
  const totalCost = sorted.reduce((a, r) => a + (r.value_cost || 0), 0);
  const totalRetail = sorted.reduce((a, r) => a + (r.value_retail || 0), 0);
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
            <th style={thLeft}>МП</th>
            <th style={thLeft}>Склад</th>
            <th style={thR}>Σ себест.</th>
            <th style={thR}>Σ реализация</th>
            <th style={thR}>Потенц. маржа</th>
            <th style={thR}>Доля капитала</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const margin = (r.value_retail || 0) - (r.value_cost || 0);
            const shareCap = totalCost > 0 ? ((r.value_cost || 0) * 100) / totalCost : 0;
            return (
              <tr key={`${r.platform}-${r.warehouse}-${i}`} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                <td style={tdLeft}><MpBadge platform={r.platform} /></td>
                <td style={tdLeft}>{r.warehouse}</td>
                <td style={{ ...tdRight, color: C.neg, fontWeight: 700 }}>{money(r.value_cost)}</td>
                <td style={tdRight}>{money(r.value_retail)}</td>
                <td style={{ ...tdRight, color: margin >= 0 ? C.pos : C.neg }}>{money(margin)}</td>
                <td style={tdRight}>{Math.round(shareCap)}%</td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: C.muted }}>
              Нет данных по складам.
            </td></tr>
          )}
        </tbody>
        {sorted.length > 0 && (
          <tfoot>
            <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
              <td style={tdFootLeft} colSpan={2}>Итого</td>
              <td style={{ ...tdFootRight, color: C.neg }}>{money(totalCost)}</td>
              <td style={tdFootRight}>{money(totalRetail)}</td>
              <td style={{ ...tdFootRight, color: totalRetail - totalCost >= 0 ? C.pos : C.neg }}>{money(totalRetail - totalCost)}</td>
              <td style={tdFootRight}>100%</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// =====================================================================
//  Мелочи: Header, Kpi, Segmented, MpBadge, Centered
// =====================================================================
function Header({ dateWb, dateOzon, vel }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Склады и индексы</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Остатки по складам WB/Ozon, оборачиваемость и дни до out-of-stock.
        {" "}Срез WB{dateWb ? `: ${fmtFullLong(dateWb)}` : " недоступен"} · Ozon{dateOzon ? `: ${fmtFullLong(dateOzon)}` : " недоступен"}.
      </p>
    </div>
  );
}
function Centered({ children }) {
  return <div style={{ minHeight: "60vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
function Kpi({ label, value, accent, color, hint }) {
  return (
    <div title={hint} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 140px", minWidth: 120 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ? C.accent : color || C.ink }}>{value}</div>
    </div>
  );
}
function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 7, overflow: "hidden" }}>
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)}
          style={{
            padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600,
            background: value === o.v ? C.accent : C.surface,
            color: value === o.v ? "#0A1A1C" : C.muted,
            border: "none", borderRight: `1px solid ${C.line}`,
          }}>
          {o.l}
        </button>
      ))}
    </div>
  );
}
function MpBadge({ platform }) {
  const isWb = platform === "wb";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6,
      background: isWb ? soft("accent", 15) : soft("pink", 15),
      color: isWb ? C.accent : C.pink,
    }}>{isWb ? "WB" : "OZON"}</span>
  );
}

// ---------------- Стили ----------------
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120 };
const tabBtn = { padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", background: "transparent", border: "none", marginBottom: -1 };
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeft = { padding: "8px 10px", verticalAlign: "middle", textAlign: "left" };
const tdFootLeft = { padding: "12px 10px", fontSize: 13, fontWeight: 800, color: C.ink, textAlign: "left" };
const tdFootRight = { padding: "12px 10px", fontSize: 13, color: C.ink, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 800 };
const alertStyle = { padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted };
