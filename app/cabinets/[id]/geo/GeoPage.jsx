"use client";
import { C } from "@/lib/palette.js";

import React, { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";


const money = (n) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const moneyShort = (n) =>
  Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)} млн` : Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}т` : `${Math.round(n)}`;
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

export default function GeoPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("region"); // region | warehouse
  // Фильтры
  const [mp, setMp] = useState("all");           // all | wb | ozon
  const [period, setPeriod] = useState("all");   // all | YYYY-MM
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [presetRange, setPresetRange] = useState(""); // week | month | ""
  const [q, setQ] = useState("");
  const [nm, setNm] = useState("");
  const [brand, setBrand] = useState("");
  const [group, setGroup] = useState("");

  // Пресет «неделя/месяц» — ставит from/to относительно сегодня (только если выбран).
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
    setPeriod("all"); // пресет месяца-имени несовместим со свободным диапазоном
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
    return p.toString();
  }, [mp, period, from, to, presetRange, q, nm, brand, group]);

  useEffect(() => {
    setData(null);
    fetch(`/api/cabinets/${cabinetId}/geography?${qs}`)
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
  const rows = data ? (tab === "region" ? data.byRegion : data.byWarehouse) : [];
  const ozonNote = mp === "ozon" ? " (продажи = заказы: у Ozon нет гео-разреза продаж)" : "";

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: font }}>
      <div style={{ maxWidth: 1340, margin: "0 auto", padding: "28px 22px 56px" }}>
        <div style={{ marginBottom: 18 }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800 }}>География заказов и продаж</h1>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
            {data ? `период: ${fmtFull(data.period.from)} – ${fmtFull(data.period.to)}` : "загрузка…"}{ozonNote}
          </div>
        </div>

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

        {/* Вкладки регион / склад */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${C.line}` }}>
          <Tab active={tab === "region"} onClick={() => setTab("region")}>{mp === "ozon" ? "По городам" : "По округам"}</Tab>
          <Tab active={tab === "warehouse"} onClick={() => setTab("warehouse")}>По складам</Tab>
        </div>

        {!data ? (
          <Centered>Загрузка данных…</Centered>
        ) : rows.length === 0 ? (
          <Centered>Нет данных по выбранным фильтрам.</Centered>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(440px, 1fr))", gap: 16 }}>
            <ChartCard title="Заказы (рубли)" rows={rows} dataKey="ordersRub" color={C.blue} fmt={money} short={moneyShort} />
            <ChartCard title="Продажи (рубли)" rows={rows} dataKey="salesRub" color={C.pink} fmt={money} short={moneyShort} />
            <ChartCard title="Заказы (штуки)" rows={rows} dataKey="ordersQty" color={C.blue} fmt={num} short={num} />
            <ChartCard title="Продажи (штуки)" rows={rows} dataKey="salesQty" color={C.pink} fmt={num} short={num} />
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 12, color: C.faint, textAlign: "center" }}>
          WB: заказы — из orders (price_with_disc), продажи — из sales (finished_price), разрез по округу/складу. Ozon: регион = город, продажи = заказы (API Ozon не отдаёт гео продаж). Источник: боевые БД WB+Ozon.
        </div>
      </div>
    </div>
  );
}

function ChartCard({ title, rows, dataKey, color, fmt, short }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b[dataKey] - a[dataKey]), [rows, dataKey]);
  const top = sorted.slice(0, 25); // топ-25, чтобы график не разрастался при mp=all
  const height = Math.max(220, top.length * 34 + 40);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: "16px 14px 8px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, padding: "0 6px 10px", textAlign: "center" }}>{title}{sorted.length > 25 ? ` (топ-25 из ${sorted.length})` : ""}</div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={top} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={C.line} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} tickFormatter={short} />
            <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: C.ink }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v) => fmt(v)} cursor={{ fill: "rgba(255,255,255,0.06)" }} contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13 }} />
            <Bar dataKey={dataKey} fill={color} radius={[0, 5, 5, 0]} barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{ border: "none", background: "transparent", cursor: "pointer", padding: "10px 16px", fontSize: 14, fontWeight: 600, color: active ? C.accent : C.muted, borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent", marginBottom: -1 }}>
      {children}
    </button>
  );
}
function Seg({ children }) {
  return <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>{children}</div>;
}
function SegBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{ padding: "7px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none", background: active ? C.accent : C.surfaceAlt, color: active ? "#0A1A1C" : C.ink, fontFamily: "inherit" }}>{children}</button>
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
function Centered({ children }) {
  return (
    <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", color: C.muted, background: C.bg, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
}
