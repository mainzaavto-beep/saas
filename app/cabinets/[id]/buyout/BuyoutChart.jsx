"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

// График «% выкупа по неделям заказа» (спека 2026-10-11 §5.3). Без товара — весь кабинет;
// выбран товар — линия товара + линия на каждый размер. Пунктир — неделя не дозрела
// (в пути > 5 %), бледная точка без линии — доехало < 20 заказов.

const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const fmtWeek = (w) => new Date(`${w}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const PALETTE = ["accent", "pos", "warn", "pink", "neg", "muted"];

function splitSeries(points, key, st) {
  // st: Stats недели. Зрелая и достаточная — в сплошную; недозревшая — в пунктир;
  // малая выборка — только точка.
  points[key] = null; points[`${key}_imm`] = null; points[`${key}_low`] = null;
  if (st.buyoutPct == null) return;
  if (st.lowSample) points[`${key}_low`] = st.buyoutPct;
  else if (st.immature) points[`${key}_imm`] = st.buyoutPct;
  else points[key] = st.buyoutPct;
}

export default function BuyoutChart({ cabinetId, platform, nmId, name, onReset, cats }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    const nm = nmId != null ? `&nm=${nmId}` : "";
    const cq = [...(cats || [])].map((c) => `&cat=${encodeURIComponent(c)}`).join("");
    fetch(`/api/cabinets/${cabinetId}/buyout?series=1&platform=${platform}${nm}${cq}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { if (alive) setData(j); })
      .catch((e) => { console.error("buyout series:", e); if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, [cabinetId, platform, nmId, cats]);

  const { series, chart } = useMemo(() => {
    if (!data) return { series: [], chart: [] };
    const series = [{ key: "total", label: nmId != null ? "Товар" : "Кабинет" }]
      .concat((data.sizeList || []).map((s) => ({ key: `s_${s}`, label: s, size: s })));
    const chart = data.weeks.map((w) => {
      const p = { week: w.week, _w: w };
      splitSeries(p, "total", w);
      for (const s of series.slice(1)) splitSeries(p, s.key, w.sizes[s.size]);
      return p;
    });
    // пунктир должен начинаться от последней зрелой точки — дублируем её в _imm
    for (const s of series) {
      for (let i = 1; i < chart.length; i++) {
        if (chart[i][`${s.key}_imm`] != null && chart[i - 1][s.key] != null && chart[i - 1][`${s.key}_imm`] == null) {
          chart[i - 1][`${s.key}_imm`] = chart[i - 1][s.key];
        }
      }
    }
    return { series, chart };
  }, [data, nmId]);

  const colorOf = (i) => `var(--${PALETTE[i % PALETTE.length]})`;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <b>% выкупа по неделям заказа{nmId != null ? ` — ${name || nmId}` : ` — весь кабинет (${platform === "wb" ? "WB" : platform === "ozon" ? "Ozon" : "WB+Ozon"}${cats?.size ? `, ${cats.size === 1 ? [...cats][0] : `категорий: ${cats.size}`}` : ""})`}</b>
        <span style={{ fontSize: 12, color: C.muted }}>
          пунктир — неделя не дозрела · бледная точка — доехало &lt; 20
          {nmId != null ? <> · <button type="button" onClick={onReset} style={{ cursor: "pointer", color: C.accent, background: "none", border: "none", padding: 0, font: "inherit" }}>весь кабинет</button></> : " · клик по товару в таблице — график по размерам"}
        </span>
      </div>
      {error ? <div style={{ color: C.neg }}>Ошибка: {error}</div> : null}
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            <CartesianGrid stroke={soft("line", 20)} vertical={false} />
            <XAxis dataKey="week" tickFormatter={fmtWeek} tick={{ fontSize: 11, fill: C.muted }} stroke={soft("line", 30)} />
            <YAxis domain={[0, 100]} tickFormatter={(v) => `${v} %`} tick={{ fontSize: 11, fill: C.muted }} stroke={soft("line", 30)} width={50} />
            <Tooltip
              payloadUniqBy={(e) => String(e.dataKey).replace(/_(imm|low)$/, "")}
              labelFormatter={(w) => `неделя с ${fmtWeek(w)}`}
              formatter={(v, key, item) => {
                const base = String(key).replace(/_(imm|low)$/, "");
                const s = series.find((x) => x.key === base);
                const st = base === "total" ? item.payload._w : item.payload._w.sizes[s?.size];
                const extra = st ? ` (заказано ${st.ordered}, выкуп ${st.sold}, невыкуп ${st.refused}, возвр. ${st.returned}, в пути ${st.pending})` : "";
                return [`${nf1.format(v)} %${extra}`, s?.label || base];
              }}
              contentStyle={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12 }}
            />
            {series.length > 1 ? <Legend payload={series.map((s, i) => ({ value: s.label, type: "line", color: colorOf(i) }))} /> : null}
            {series.flatMap((s, i) => [
              <Line key={s.key} dataKey={s.key} name={s.label} stroke={colorOf(i)} strokeWidth={s.key === "total" ? 3 : 2}
                dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} legendType="none" />,
              <Line key={`${s.key}_imm`} dataKey={`${s.key}_imm`} name={s.label} stroke={colorOf(i)} strokeWidth={2}
                strokeDasharray="5 4" dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} legendType="none" />,
              <Line key={`${s.key}_low`} dataKey={`${s.key}_low`} name={s.label} stroke="transparent"
                dot={{ r: 3, fill: colorOf(i), fillOpacity: 0.35, stroke: "none" }} isAnimationActive={false} legendType="none" />,
            ])}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
