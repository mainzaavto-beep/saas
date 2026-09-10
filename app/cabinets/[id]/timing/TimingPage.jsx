"use client";
import { C } from "@/lib/palette.js";

import React, { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { metricsForMp, metricLabel } from "@/lib/timing30m.js";


const num = (n) => Math.round(n).toLocaleString("ru-RU");
const fmtFull = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};
const monthLabel = (m) => {
  const names = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const [y, mm] = m.split("-");
  return `${names[+mm - 1]} ${y}`;
};
const hourLabel = (h) => `${String(h).padStart(2, "0")}:00`;
const slotLabel = (s) => `${String(Math.floor(s / 2)).padStart(2, "0")}:${s % 2 === 0 ? "00" : "30"}`;

// Цвет ячейки тепловой карты (тёмная тема): тёмная → нарастающий циан → яркий/белый.
function heatColor(v, max) {
  if (!v) return C.surfaceAlt;
  const t = max ? v / max : 0;
  const stops = [
    [0, [16, 38, 38]],     // тёмный циан-черный (холодно)
    [0.5, [0, 140, 160]],  // средний циан
    [1, [0, 229, 255]],    // яркий неоновый циан (горячо)
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const f = (b[0] - a[0]) ? (t - a[0]) / (b[0] - a[0]) : 0;
  const c = a[1].map((ch, i) => Math.round(ch + (b[1][i] - ch) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const inputStyle = {
  padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit",
};
const selectStyle = {
  ...inputStyle,
  padding: "7px 26px 7px 10px",
  appearance: "none",
  backgroundImage: "linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)",
  backgroundPosition: "calc(100% - 14px) 50%, calc(100% - 9px) 50%",
  backgroundSize: "5px 5px, 5px 5px",
  backgroundRepeat: "no-repeat",
  cursor: "pointer",
};

export default function TimingPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Фильтры
  const [mp, setMp] = useState("all");
  const [period, setPeriod] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [presetRange, setPresetRange] = useState("");
  const [q, setQ] = useState("");
  const [nm, setNm] = useState("");
  const [brand, setBrand] = useState("");
  const [group, setGroup] = useState("");
  // Гранулярность: hour (заказы, как раньше) | m30 (30-минутная воронка WB + Ozon)
  const [granularity, setGranularity] = useState("hour");
  // Метрика для режима m30: что показываем. Набор зависит от площадки (lib/timing30m.js):
  // при смене МП метрика, которой у площадки нет, сбрасывается на «Заказы».
  const [metric, setMetric] = useState("orders");
  const metricOptions = useMemo(() => metricsForMp(mp), [mp]);
  useEffect(() => {
    if (!metricOptions.some((o) => o.v === metric)) setMetric("orders");
  }, [metricOptions, metric]);

  // Пресет «неделя/месяц» — ставит from/to относительно сегодня.
  useEffect(() => {
    if (!presetRange) return;
    const now = new Date();
    const to0 = new Date(now);
    const from0 = new Date(now);
    if (presetRange === "week") from0.setDate(now.getDate() - 7);
    else if (presetRange === "month") from0.setMonth(now.getMonth() - 1);
    const iso = (d) => d.toISOString().slice(0, 10);
    setFrom(iso(from0));
    setTo(iso(to0));
    setPeriod("all");
  }, [presetRange]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("mp", mp);
    if (period !== "all" && !presetRange) p.set("period", period);
    if (from && presetRange) p.set("from", from);
    if (to && presetRange) p.set("to", to);
    if (q) p.set("q", q);
    if (nm) p.set("nm", nm);
    if (brand) p.set("brand", brand);
    if (group) p.set("group", group);
    if (granularity !== "hour") { p.set("granularity", granularity); p.set("metric", metric); }
    return p.toString();
  }, [mp, period, from, to, presetRange, q, nm, brand, group, granularity, metric]);

  useEffect(() => {
    setData(null);
    fetch(`/api/cabinets/${cabinetId}/timing?${qs}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError("Ошибка чтения базы: " + d.error) : setData(d)))
      .catch(() => setError("Не удалось загрузить данные."));
  }, [qs]);

  const font = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  if (error) return <Centered>{error}</Centered>;

  const hasActiveFilters = mp !== "all" || period !== "all" || presetRange || q ||
    nm || brand || group;
  const resetFilters = () => {
    setMp("all"); setPeriod("all"); setPresetRange(""); setFrom(""); setTo("");
    setQ(""); setNm(""); setBrand(""); setGroup("");
  };

  const facets = data?.facets || { brand: [], group: [], nm: [] };
  const heatmap = Array.isArray(data?.heatmap) ? data.heatmap : [];
  const maxCell = Math.max(1, ...heatmap.flat());

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: font }}>
      <div style={{ maxWidth: 1340, margin: "0 auto", padding: "28px 22px 56px" }}>
        <div style={{ marginBottom: 18, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800 }}>
              {granularity === "m30" ? "Воронка по времени" : "Заказы по времени"}
            </h1>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
              {data
                ? `${granularity === "m30" ? metricLabel(metric) : "Заказы"} с ${fmtFull(data.period.from)} по ${fmtFull(data.period.to)} · всего ${num(data.total)}`
                : "загрузка…"}
            </div>
          </div>
          {/* Переключатель гранулярности */}
          <Seg>
            {[
              { v: "hour", l: "По часам (заказы)" },
              { v: "m30", l: "По 30 минут (воронка)" },
            ].map((o) => (
              <SegBtn key={o.v} active={granularity === o.v} onClick={() => setGranularity(o.v)}>{o.l}</SegBtn>
            ))}
          </Seg>
        </div>

        {/* Селектор метрик — только в режиме m30 */}
        {granularity === "m30" && (
          <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 10, marginBottom: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginRight: 4 }}>Метрика:</span>
            {metricOptions.map((o) => (
              <Chip key={o.v} active={metric === o.v} onClick={() => setMetric(o.v)}>{o.l}</Chip>
            ))}
          </div>
        )}

        {/* Панель фильтров */}
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Seg>
            {[
              { v: "all", l: "Все МП" },
              { v: "wb", l: "WB" },
              { v: "ozon", l: "Ozon" },
            ].map((o) => (
              <SegBtn key={o.v} active={mp === o.v} onClick={() => setMp(o.v)}>{o.l}</SegBtn>
            ))}
          </Seg>

          <Field label="Период (быстрый)">
            <select value={period} onChange={(e) => { setPeriod(e.target.value); setPresetRange(""); }} disabled={!!presetRange} style={{ ...selectStyle, opacity: presetRange ? 0.5 : 1 }}>
              <option value="all">Всё время</option>
              {(data?.months || []).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </Field>
          <Field label="или отн. сегодня">
            <select value={presetRange} onChange={(e) => setPresetRange(e.target.value)} style={selectStyle}>
              <option value="">— вручную —</option>
              <option value="week">Последние 7 дней</option>
              <option value="month">Последние 30 дней</option>
            </select>
          </Field>
          <Field label="От">
            <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPresetRange(""); setPeriod("all"); }} style={inputStyle} />
          </Field>
          <Field label="До">
            <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPresetRange(""); setPeriod("all"); }} style={inputStyle} />
          </Field>

          <Field label="Товар / артикул">
            <select value={nm} onChange={(e) => setNm(e.target.value)} style={{ ...selectStyle, minWidth: 200 }}>
              <option value="">Все товары</option>
              {facets.nm.map((o) => <option key={o.id} value={o.id}>{o.label} ({o.count})</option>)}
            </select>
          </Field>
          <Field label="Группа / категория">
            <select value={group} onChange={(e) => setGroup(e.target.value)} style={selectStyle}>
              <option value="">Все группы</option>
              {facets.group.map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
            </select>
          </Field>
          <Field label="Бренд">
            <select value={brand} onChange={(e) => setBrand(e.target.value)} style={selectStyle}>
              <option value="">Все бренды</option>
              {facets.brand.map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
            </select>
          </Field>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск: артикул МП (977847925), артикул продавца или название товара…"
            style={{ ...inputStyle, flex: 1, minWidth: 200 }}
          />
          {hasActiveFilters && (
            <button onClick={resetFilters} style={{ padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, border: `1px solid ${C.line}`, background: "transparent", color: C.muted, fontFamily: "inherit" }}>Сбросить</button>
          )}
        </div>

        {!data ? (
          <Centered>Загрузка данных…</Centered>
        ) : data.note ? (
          <Centered>{data.note}</Centered>
        ) : data.total === 0 ? (
          <Centered>{granularity === "m30" ? `Нет данных по метрике «${metricLabel(metric)}» за выбранный период.` : "Нет заказов по выбранным фильтрам."}</Centered>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(440px, 1fr))", gap: 16, marginBottom: 16 }}>
              <Card title={`${granularity === "m30" ? metricLabel(metric) : "Заказы"} по дням недели`}>
                <div style={{ height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.weekdays} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={C.line} vertical={false} />
                      <XAxis dataKey="short" tick={{ fontSize: 12, fill: C.muted }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} width={48} />
                      <Tooltip formatter={(v) => [num(v), ""]} cursor={{ fill: "rgba(255,255,255,0.06)" }} contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13 }} />
                      <Bar dataKey="count" fill={granularity === "m30" ? C.blue : C.pink} radius={[5, 5, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card title={`${granularity === "m30" ? metricLabel(metric) : "Заказы"} по часам`}>
                <div style={{ height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.hours} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={C.line} vertical={false} />
                      <XAxis dataKey="hour" tickFormatter={(h) => String(h).padStart(2, "0")} tick={{ fontSize: 10, fill: C.faint }} axisLine={false} tickLine={false} interval={1} />
                      <YAxis tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} width={48} />
                      <Tooltip formatter={(v) => [num(v), ""]} labelFormatter={(h) => `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`} cursor={{ fill: "rgba(255,255,255,0.06)" }} contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13 }} />
                      <Bar dataKey="count" fill={granularity === "m30" ? C.blue : C.pink} radius={[5, 5, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </div>

            {/* Тепловая карта: m30 → 48 столбцов (00:00..23:30), hour → 24 столбца */}
            <Card title={`Тепловая карта: день недели × ${granularity === "m30" ? "30 минут" : "час"}`}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                  <thead>
                    <tr>
                      <th style={{ position: "sticky", left: 0, background: C.surface, padding: "4px 8px", textAlign: "left", color: C.muted }}></th>
                      {granularity === "m30" ? (
                        // 48 столбцов: подпись только на каждом чётном (целый час)
                        Array.from({ length: 48 }, (_, s) => (
                          <th key={s} style={{ padding: "4px 2px", color: s % 2 === 0 ? C.faint : "transparent", fontWeight: 600, minWidth: 22 }}>{s % 2 === 0 ? String(s / 2).padStart(2, "0") : "·"}</th>
                        ))
                      ) : (
                        Array.from({ length: 24 }, (_, h) => (
                          <th key={h} style={{ padding: "4px 5px", color: C.faint, fontWeight: 600, minWidth: 26 }}>{String(h).padStart(2, "0")}</th>
                        ))
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.weekdays || []).map((wd, d) => (
                      <tr key={d}>
                        <td style={{ position: "sticky", left: 0, background: C.surface, padding: "4px 8px", color: C.ink, fontWeight: 600, whiteSpace: "nowrap" }}>{wd.short}</td>
                        {(heatmap[d] || []).map((v, idx) => (
                          <td key={idx} title={`${wd.label}, ${granularity === "m30" ? slotLabel(idx) : hourLabel(idx)} — ${num(v)}`} style={{ padding: granularity === "m30" ? "5px 1px" : "5px 5px", textAlign: "center", background: heatColor(v, maxCell), color: v / maxCell > 0.6 ? "#fff" : C.ink, borderRadius: 2 }}>
                            {v || ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {granularity === "m30" && (
                <div style={{ fontSize: 11, color: C.faint, marginTop: 8, textAlign: "center" }}>
                  Числа в ячейках — прирост метрики за 30-минутный слот (дельта кумулятивного счётчика площадки). Подписи часов — по целым часам (· = получасовой слот).
                </div>
              )}
            </Card>
          </>
        )}

        <div style={{ marginTop: 16, fontSize: 12, color: C.faint, textAlign: "center" }}>
          {granularity === "m30"
            ? "30-минутная воронка: WB — активные товары (wb_metrics_30m), Ozon — товары из аналитики продавца и реклама по кампаниям (ozon_metrics_30m). Снимки раз в 30 мин, дельта = прирост за слот. «Все МП» складывает площадки по общим метрикам."
            : "Считаются все заказы WB+Ozon по времени их оформления (час из order_dt). Источник: боевые БД."}
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: "16px 16px 10px", marginBottom: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, padding: "0 2px 12px" }}>{title}</div>
      {children}
    </div>
  );
}
function Seg({ children }) {
  return <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>{children}</div>;
}
function SegBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{ padding: "7px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none", background: active ? C.accent : C.surfaceAlt, color: active ? "var(--accentInk)" : C.ink, fontFamily: "inherit" }}>{children}</button>
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
function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 12px", cursor: "pointer", fontSize: 13, fontWeight: 600,
      border: `1px solid ${active ? C.accent : C.line}`, borderRadius: 8,
      background: active ? C.accent : C.surfaceAlt, color: active ? "var(--accentInk)" : C.ink,
      fontFamily: "inherit",
    }}>{children}</button>
  );
}
function Centered({ children }) {
  return (
    <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", color: C.muted, background: C.bg, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
}
