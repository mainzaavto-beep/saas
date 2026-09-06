"use client";
import { C, soft } from "@/lib/palette.js";
import PeriodPicker from "../PeriodPicker.jsx";

import React, { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

// Дублируем метку незамапленной пары — источник lib/geoMetrics.js:16 (серверный
// файл, импортировать в клиентский компонент нельзя), значение фиксировано
// контрактом v2 (route.js:49).
const UNMAPPED = "Не определено";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const money = (n) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const moneyShort = (n) =>
  Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)} млн` : Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}т` : `${Math.round(n)}`;
const num = (n) => Math.round(n).toLocaleString("ru-RU");
const fmtFull = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};
const fmt1 = (v) => v.toLocaleString("ru-RU", { maximumFractionDigits: 1 });

// Дельта к прошлому окну — копия паттерна Сводки (SummaryPage.jsx:50-63);
// общего kpi-компонента в проекте нет, копируем по конвенции задачи.
// pp=true — дельта в процентных пунктах, иначе — относительный % изменения.
// invert=true — для метрик «меньше = лучше» (дни/часы): величина СЧИТАЕТСЯ
// как обычно, от (cur-prev)/|prev| (аргументы передаются в естественном
// порядке delta(cur, prev, ...)), а направление/цвет переворачиваются —
// снижение дней окрашивается в «хорошо» (зелёная стрелка вверх). Находка
// ревью финал-волны: старый вызов delta(prev, cur) одновременно переворачивал
// И направление, И базу знаменателя — 10→5 дн давало «▲100%» вместо
// корректных «величина 50%, направление — улучшение».
function delta(cur, prev, { pp = false, invert = false } = {}) {
  if (cur == null || prev == null || !prev) return null;
  const d = pp ? cur - prev : ((cur - prev) / Math.abs(prev)) * 100;
  if (!isFinite(d) || Math.abs(d) < 0.05) return null;
  const rawDir = d >= 0 ? "up" : "down";
  const dir = invert ? (rawDir === "up" ? "down" : "up") : rawDir;
  return { dir, text: `${Math.abs(d).toFixed(1)}${pp ? " пп" : "%"}` };
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

export default function GeoPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("region"); // region | warehouse
  // Фильтры
  const [mp, setMp] = useState("all");           // all | wb | ozon
  const [scheme, setScheme] = useState("all");   // all | fbo | fbs
  // Период — через PeriodPicker (день/неделя/месяц/год/интервал, стрелки
  // ‹/›, «Вчера»), тот же удобный контрол, что и на Главной; дефолт — месяц
  // (как на Главной, OverviewClient.jsx:93), «Вчера» — быстрый переход на день.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [nm, setNm] = useState("");
  const [brand, setBrand] = useState("");
  const [group, setGroup] = useState("");

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("mp", mp);
    p.set("scheme", scheme);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (q) p.set("q", q);
    if (nm) p.set("nm", nm);
    if (brand) p.set("brand", brand);
    if (group) p.set("group", group);
    return p.toString();
  }, [mp, scheme, from, to, q, nm, brand, group]);

  useEffect(() => {
    setData(null);
    fetch(`/api/cabinets/${cabinetId}/geography?${qs}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError("Ошибка чтения базы: " + d.error) : setData(d)))
      .catch(() => setError("Не удалось загрузить данные."));
  }, [qs]);

  const font = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  if (error) return <Centered>{error}</Centered>;

  // Период больше не имеет «нейтрального» состояния (PeriodPicker всегда
  // держит явный день/неделю/месяц/интервал, дефолт — месяц) — из
  // «активных фильтров»/сброса период больше не участвует.
  const hasActiveFilters = mp !== "all" || scheme !== "all" || q ||
    nm || brand || group;
  const resetFilters = () => {
    setMp("all"); setScheme("all");
    setQ(""); setNm(""); setBrand(""); setGroup("");
  };

  const facets = data?.facets || { brand: [], group: [], nm: [] };
  const rows = data ? (tab === "region" ? data.byRegion : data.byWarehouse) : [];
  const kpi = data?.kpi || {};
  const prevKpi = data?.prevKpi || {};
  const localColor = kpi.localPct == null ? C.faint
    : kpi.localPct >= 30 ? C.pos : kpi.localPct >= 10 ? C.warn : C.neg;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: font }}>
      <div style={{ maxWidth: 1340, margin: "0 auto", padding: "28px 22px 56px" }}>
        <div style={{ marginBottom: 18 }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800 }}>География заказов и продаж</h1>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
            {data ? `период: ${fmtFull(data.period.from)} – ${fmtFull(data.period.to)}` : "загрузка…"}
          </div>
        </div>

        {/* KPI-ряд — источник v2 (kpi/prevKpi), дельты к прошлому окну.
            Локальность: с августа 2026 WB отдаёт обезличенный «Склад WB РФ»
            вместо конкретного склада (деградация источника, см. контракт
            задачи 7) — на свежих окнах показатель фактически определяется
            Ozon, поэтому это явно написано в title плашки. */}
        <KpiRow>
          <Kpi
            label="Локальность"
            value={kpi.localPct != null ? `${fmt1(kpi.localPct)}%` : "—"}
            color={localColor}
            title="Доля заказов, где склад и покупатель — в одном кластере/округе (WB+Ozon вместе). С августа 2026 WB не детализирует склад отгрузки («Склад WB РФ» вместо конкретного) — на свежих окнах показатель фактически определяется Ozon."
            delta={delta(kpi.localPct, prevKpi.localPct, { pp: true })}
            sub={kpi.localPct == null ? "копим данные" : null}
          />
          <Kpi
            label="Скорость WB"
            value={kpi.speedWbDays != null ? `${fmt1(kpi.speedWbDays)} дн` : "—"}
            title="До выкупа — прокси, WB не отдаёт дату доставки"
            // Инверсия: меньше дней — лучше, поэтому invert:true (снижение
            // показывает зелёную стрелку вверх, величина — от |prev| как обычно).
            delta={delta(kpi.speedWbDays, prevKpi.speedWbDays, { invert: true })}
            sub={kpi.speedWbDays == null ? "копим данные" : null}
          />
          <Kpi
            label="Скорость Ozon"
            value={kpi.speedOzDays != null ? `${fmt1(kpi.speedOzDays)} дн` : "—"}
            title="До выдачи, только FBO"
            delta={delta(kpi.speedOzDays, prevKpi.speedOzDays, { invert: true })}
            sub={kpi.speedOzDays == null ? "копим данные" : null}
          />
          <Kpi
            label="Доля FBS"
            value={kpi.fbsSharePct != null ? `${fmt1(kpi.fbsSharePct)}%` : "—"}
            title="Доля заказов/продаж по схеме FBS (продавец возит сам) от общего количества, обе площадки вместе"
            delta={delta(kpi.fbsSharePct, prevKpi.fbsSharePct, { pp: true })}
            sub={kpi.fbsSharePct == null ? "копим данные" : null}
          />
          <Kpi
            label="Отгрузка на СЦ"
            value={kpi.scLagHours != null ? `${fmt1(kpi.scLagHours)} ч` : "—"}
            title="WB, медиана времени «закрыта → скан на СЦ»"
            delta={delta(kpi.scLagHours, prevKpi.scLagHours, { invert: true })}
            sub={kpi.scLagHours == null ? "копим данные" : null}
          />
        </KpiRow>

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
          <Seg>
            {[
              { v: "all", l: "Все схемы" },
              { v: "fbo", l: "FBO/FBW" },
              { v: "fbs", l: "FBS" },
            ].map((o) => (
              <SegBtn key={o.v} active={scheme === o.v} onClick={() => setScheme(o.v)}>{o.l}</SegBtn>
            ))}
          </Seg>

          <PeriodPicker
            value={{ from, to }}
            onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }}
          />

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

        {/* Секция 3 — матрица локальности склад→покупатель. Две площадки
            считаются раздельно (locality.wb/locality.ozon из API v2) — при
            mp-фильтре показываем только выбранную площадку. */}
        {data && (
          <div style={{ marginTop: 32 }}>
            <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: C.ink }}>Локальность: склад → покупатель</h2>
            <p style={{ margin: "0 0 12px", color: C.muted, fontSize: 12 }}>
              Доля заказов, где отгрузка и покупатель — в одном кластере/округе. Диагональ (совпадение) обведена.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(440px, 1fr))", gap: 16 }}>
              {mp !== "ozon" && (
                <LocalityMatrix
                  title="WB"
                  rows={data.locality.wb.rows}
                  whKey="whCluster"
                  buyerKey="buyerCluster"
                  localPct={data.locality.wb.localPct}
                  mappedPct={data.locality.wb.mappedPct}
                  note="7 укрупнённых кластеров WB: Юг+Кавказ и Сибирь+ДВ слиты — так устроена карта WB. С августа 2026 WB отдаёт вместо конкретного склада плейсхолдер «Склад WB РФ» — фаззи-мэппинг на справочник его не узнаёт, поэтому такие строки уходят в общую «Не определено» вместе с прочими незамапленными складами (решение ревью финал-волны: не различаем их отдельной подписью оси — не отличить дёшево от прочих причин немэппинга без нового SQL-подсчёта; см. тултип «замаплено»)."
                />
              )}
              {mp !== "wb" && (
                <LocalityMatrix
                  title="Ozon"
                  rows={data.locality.ozon.rows}
                  whKey="whFo"
                  buyerKey="buyerFo"
                  localPct={data.locality.ozon.localPct}
                  mappedPct={data.locality.ozon.mappedPct}
                />
              )}
            </div>
          </div>
        )}

        {/* Секция 4 — скорость доставки: WB fbo/fbs по округам, Ozon fbo по ФО. */}
        {data && (
          <div style={{ marginTop: 32 }}>
            <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: C.ink }}>Скорость доставки</h2>
            <p style={{ margin: "0 0 12px", color: C.muted, fontSize: 12 }}>
              Медианные дни от заказа до выкупа/выдачи, по округам и федеральным округам.
            </p>
            <SpeedTable
              wbRows={mp !== "ozon" ? data.speed.wb : []}
              ozRows={mp !== "wb" ? data.speed.ozon : []}
              showWb={mp !== "ozon"}
              showOz={mp !== "wb"}
            />
          </div>
        )}

        {/* Секция 5 — FBS-отгрузки: поставки WB со стадиями создана→закрыта→
            принята СЦ, висящие без приёмки подсвечены (contract v2 supplies,
            route.js). Компонент сам возвращает null при supplies===null
            (mp=ozon или отсутствии WB у кабинета) — секция скрывается
            целиком, в отличие от секций 3-4, где Ozon-часть есть всегда. */}
        {data && <SuppliesSection supplies={data.supplies} />}

        <div style={{ marginTop: 16, fontSize: 12, color: C.faint, textAlign: "center" }}>
          WB: заказы — из orders (price_with_disc), продажи — из sales (finished_price), разрез по округу/складу. Ozon: регион = город, разрез по кластерам/ФО. Продажи Ozon — по дате выкупа, из начислений. Источник: боевые БД WB+Ozon.
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
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "16px 14px 8px" }}>
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

// LocalityMatrix — секция 3: матрица склад→покупатель (WB: кластеры,
// Ozon: ФО). Оси строятся из уникальных значений rows на клиенте — сервер
// не гарантирует порядок и полный охват осей после фильтра.
function LocalityMatrix({ title, rows, whKey, buyerKey, localPct, mappedPct, note }) {
  const { whVals, buyerVals, cellMap, max } = useMemo(() => {
    const whSet = new Set(), buyerSet = new Set();
    const cellMap = new Map();
    let max = 0;
    for (const r of rows) {
      const wh = r[whKey], buyer = r[buyerKey], qty = Number(r.qty) || 0;
      whSet.add(wh);
      buyerSet.add(buyer);
      cellMap.set(`${wh} ${buyer}`, qty);
      if (qty > max) max = qty;
    }
    // «Не определено» — последним по обеим осям, остальное по алфавиту.
    const ordered = (set) => {
      const arr = [...set].filter((v) => v !== UNMAPPED).sort((a, b) => a.localeCompare(b, "ru"));
      if (set.has(UNMAPPED)) arr.push(UNMAPPED);
      return arr;
    };
    return { whVals: ordered(whSet), buyerVals: ordered(buyerSet), cellMap, max };
  }, [rows, whKey, buyerKey]);

  const localColor = localPct == null ? C.faint : localPct >= 30 ? C.pos : localPct >= 10 ? C.warn : C.neg;
  const mappedLow = mappedPct != null && mappedPct < 85;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: note ? 4 : 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
        <Badge color={localColor}>лок. {localPct != null ? fmt1(localPct) : "—"}%</Badge>
        <Badge
          color={mappedLow ? C.warn : C.faint}
          title={mappedLow
            ? (title === "WB"
                ? "WB с августа 2026 не раскрывает склад отгрузки (плейсхолдер «Склад WB РФ») — локальность по детализированным строкам"
                : "часть городов не распознана — хвост справочника 048")
            : undefined}
        >
          замаплено {mappedPct != null ? fmt1(mappedPct) : "—"}%
        </Badge>
      </div>
      {note && <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>{note}</div>}
      {rows.length === 0 ? (
        <EmptyIsland />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, zIndex: 1, background: C.surface, padding: "4px 10px", textAlign: "left", color: C.faint, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>
                  склад ＼ покупатель
                </th>
                {buyerVals.map((b) => (
                  <th key={b} style={{ padding: "4px 8px", textAlign: "center", color: C.faint, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{b}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {whVals.map((wh) => (
                <tr key={wh}>
                  <td style={{ position: "sticky", left: 0, zIndex: 1, background: C.surface, padding: "4px 10px", fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{wh}</td>
                  {buyerVals.map((buyer) => {
                    const qty = cellMap.get(`${wh} ${buyer}`) || 0;
                    const isDiag = wh === buyer && wh !== UNMAPPED;
                    return (
                      <td
                        key={buyer}
                        title={`${wh} → ${buyer}: ${num(qty)}`}
                        style={{
                          padding: "4px 8px", textAlign: "center", minWidth: 56,
                          background: qty > 0 ? soft("accent", clamp((qty / max) * 60, 4, 60)) : "transparent",
                          // borderBottom всегда шёл ПОСЛЕ border в объекте стилей и
                          // перекрывал нижнюю грань диагонали цветом сетки (находка
                          // ревью финал-волны) — на диагонали нижняя грань тоже C.pos.
                          border: isDiag ? `1px solid ${C.pos}` : "1px solid transparent",
                          borderBottom: isDiag ? `1px solid ${C.pos}` : `1px solid ${C.line}`,
                        }}
                      >
                        {qty > 0 ? num(qty) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// SpeedTable — секция 4: WB округ×схема (fbo/fbs медианы рядом), Ozon ФО×медиана
// (только fbo — у рФБС нет данных о доставке, см. geoMetrics.js:269).
function SpeedTable({ wbRows, ozRows, showWb, showOz }) {
  const wbByOkrug = useMemo(() => {
    const map = new Map();
    for (const r of wbRows) {
      const cur = map.get(r.okrug) || { okrug: r.okrug };
      cur[r.scheme] = { medianDays: r.medianDays, n: r.n };
      map.set(r.okrug, cur);
    }
    return [...map.values()].sort((a, b) => a.okrug.localeCompare(b.okrug, "ru"));
  }, [wbRows]);

  const ozSorted = useMemo(
    () => [...ozRows].sort((a, b) => a.fo.localeCompare(b.fo, "ru")),
    [ozRows]
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 16 }}>
      {showWb && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>WB: FBO vs FBS, по округам</div>
          <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>до выкупа (прокси): включает время на ПВЗ до выкупа</div>
          {wbByOkrug.length === 0 ? (
            <EmptyIsland />
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr>
                  <th style={thStyle("left")}>округ</th>
                  <th style={thStyle("center")}>FBO</th>
                  <th style={thStyle("center")}>FBS</th>
                  <th style={thStyle("center")}>Δ fbs−fbo</th>
                </tr>
              </thead>
              <tbody>
                {wbByOkrug.map((r) => {
                  const fbo = r.fbo, fbs = r.fbs;
                  const diff = fbo?.medianDays != null && fbs?.medianDays != null ? fbs.medianDays - fbo.medianDays : null;
                  const diffColor = diff != null && diff > 1 ? C.neg : C.faint;
                  return (
                    <tr key={r.okrug}>
                      <td style={tdStyle("left")}>{r.okrug}</td>
                      <SpeedCell cell={fbo} />
                      <SpeedCell cell={fbs} />
                      <td style={{ ...tdStyle("center"), color: diffColor, fontWeight: 600 }}>
                        {diff != null ? `${diff > 0 ? "+" : ""}${fmt1(diff)} дн` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {showOz && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Ozon: до выдачи, по ФО</div>
          <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>
            до выдачи, по начислениям последней мили; FBS (рФБС) возится продавцом — данных о доставке нет
          </div>
          {ozSorted.length === 0 ? (
            <EmptyIsland />
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr>
                  <th style={thStyle("left")}>ФО</th>
                  <th style={thStyle("center")}>медиана</th>
                </tr>
              </thead>
              <tbody>
                {ozSorted.map((r) => (
                  <tr key={r.fo}>
                    <td style={tdStyle("left")}>{r.fo}</td>
                    <SpeedCell cell={r} />
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function SpeedCell({ cell }) {
  if (!cell || cell.medianDays == null) return <td style={tdStyle("center")}>—</td>;
  const low = cell.n < 5;
  return (
    <td style={{ ...tdStyle("center"), color: low ? C.faint : C.ink }} title={low ? `мало данных (n=${cell.n})` : `n=${cell.n}`}>
      {fmt1(cell.medianDays)} дн
    </td>
  );
}

function thStyle(align) {
  return { padding: "4px 8px", textAlign: align, color: C.faint, fontWeight: 600, borderBottom: `1px solid ${C.line}` };
}
function tdStyle(align) {
  return { padding: "4px 8px", textAlign: align, borderBottom: `1px solid ${C.line}` };
}

function Badge({ color, title, children }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 20,
        fontSize: 11, fontWeight: 700, color, background: soft(colorToToken(color), 16),
        border: `1px solid ${soft(colorToToken(color), 40)}`,
      }}
    >
      {children}
    </span>
  );
}
// Badge получает уже резолвленный C.* (строка "var(--token)") — вытаскиваем
// имя токена обратно для soft(), которая принимает голое имя переменной.
function colorToToken(cVar) {
  const m = /var\(--(\w+)\)/.exec(cVar || "");
  return m ? m[1] : "line";
}

function EmptyIsland({ children }) {
  return (
    <div style={{ padding: "24px 0", textAlign: "center", color: C.faint, fontSize: 13 }}>
      {children || "Копим данные с 28.08 — вернитесь позже"}
    </div>
  );
}

// Дата-время колонок таблицы поставок — свежее contract-поле уже строка
// "YYYY-MM-DDTHH:MM:SS..." (::text каста в wbSuppliesOps), режем до минут и
// меняем разделитель на пробел, как договорено в брифе задачи 3 (без
// парсинга через Date — она нужна только для разницы в днях у SupplyStage).
function fmtDT(iso) {
  return iso ? iso.substr(0, 16).replace("T", " ") : "—";
}

// SuppliesSection — секция 5: поставки WB со стадиями создана→закрыта→
// принята СЦ. supplies===null — mp=ozon или у кабинета нет WB (contract v2,
// route.js) — секция не рендерится вовсе (единственная из секций 3-5, что
// может исчезнуть целиком: у 3-4 Ozon-часть есть всегда).
function SuppliesSection({ supplies }) {
  if (!supplies) return null;
  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: C.ink }}>FBS-отгрузки</h2>
      <p style={{ margin: "0 0 12px", color: C.muted, fontSize: 12 }}>
        Поставки WB: стадии создана → закрыта → принята СЦ, висящие без приёмки подсвечены.
        «До ПВЗ» — от закрытия поставки до прибытия на пункт выдачи (копится с 06.09, точность 1 ч);
        «До покупателя» — до выкупа (включает ожидание на ПВЗ).
      </p>
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
        {supplies.total === 0 ? (
          <EmptyIsland>Поставок в выбранном окне нет</EmptyIsland>
        ) : (
          <>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, fontVariantNumeric: "tabular-nums" }}>
              сборка {supplies.medianBuildHours != null ? `${fmt1(supplies.medianBuildHours)}ч` : "—"}
              {" · "}до СЦ {supplies.medianScHours != null ? `${fmt1(supplies.medianScHours)}ч` : "—"}
              {supplies.p90ScHours != null ? ` (p90 ${fmt1(supplies.p90ScHours)}ч)` : ""}
              {" · "}висят без приёмки {supplies.stuckCount}{supplies.stuckCount > 0 ? "⚠" : ""}
              {" · "}без отметки (старые) {supplies.noScanOldCount}
              {" · "}до ПВЗ {supplies.pvzMedianDaysOverall != null ? `${fmt1(supplies.pvzMedianDaysOverall)}д (медиана, n=${supplies.pvzN})` : "—"}
              {" · "}до покупателя {supplies.buyoutMedianDaysOverall != null ? `${fmt1(supplies.buyoutMedianDaysOverall)}д (медиана)` : "—"}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                <thead>
                  <tr>
                    <th style={thStyle("left")}>Название</th>
                    <th style={thStyle("left")}>Создана</th>
                    <th style={thStyle("left")}>Закрыта</th>
                    <th style={thStyle("left")}>Принята СЦ</th>
                    <th style={thStyle("center")}>Сборка, ч</th>
                    <th style={thStyle("center")}>До СЦ, ч</th>
                    <th style={thStyle("center")}>До ПВЗ, дн</th>
                    <th style={thStyle("center")}>До покупателя, дн</th>
                  </tr>
                </thead>
                <tbody>
                  {supplies.rows.map((r) => {
                    // Подсветка выброса: время до скана СЦ выше p90 окна.
                    const scWarn = r.scHours != null && supplies.p90ScHours != null && r.scHours > supplies.p90ScHours;
                    return (
                      <tr key={r.supplyId}>
                        <td style={tdStyle("left")}>{r.name}</td>
                        <td style={tdStyle("left")}>{fmtDT(r.createdAt)}</td>
                        <td style={tdStyle("left")}>{fmtDT(r.closedAt)}</td>
                        <td style={tdStyle("left")}>
                          {r.status === "scanned" ? fmtDT(r.scanDt) : <SupplyStage status={r.status} closedAt={r.closedAt} />}
                        </td>
                        <td style={tdStyle("center")}>{r.buildHours != null ? fmt1(r.buildHours) : "—"}</td>
                        <td style={{ ...tdStyle("center"), color: scWarn ? C.warn : C.ink, fontWeight: scWarn ? 700 : 400 }}>
                          {r.scHours != null ? fmt1(r.scHours) : "—"}
                        </td>
                        <PvzCell days={r.pvzMedianDays} n={r.pvzN} tasks={r.tasks} />
                        <BuyoutCell days={r.buyoutMedianDays} n={r.buyoutN} tasks={r.tasks} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: C.faint, marginTop: 10 }}>
              WB проставляет отметку приёмки не для всех типов сдачи (например, через ПВЗ) — «без отметки» не значит «потеряна»; тревога — только свежие поставки без приёмки 3-14 дней.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// SupplyStage — статус приёмки СЦ для незасканенных поставок (status≠'scanned',
// см. wbSuppliesOps): 'stuck' — свежая поставка без скана 3-14 дней от
// closedAt (тревога, C.neg, счётчик дней от даты закрытия); 'no_scan_old' —
// хвост старше 14 дней, WB не всегда проставляет скан для этого типа сдачи —
// это НЕ тревога (C.faint); 'awaiting' — закрыта менее 3 дней назад, ещё рано
// считать висящей — просто тире.
function SupplyStage({ status, closedAt }) {
  if (status === "stuck") {
    const days = closedAt ? Math.max(0, Math.floor((Date.now() - new Date(closedAt).getTime()) / 86400000)) : "?";
    return <Badge color={C.neg}>нет приёмки, {days}д</Badge>;
  }
  if (status === "no_scan_old") {
    return <Badge color={C.faint}>без отметки</Badge>;
  }
  return <span style={{ color: C.faint }}>—</span>;
}

// BuyoutCell — «До покупателя, дн» в таблице поставок (buyoutMedianDays/
// buyoutN, wbSuppliesOps §16.8). У ~40% поставок выкупов пока нет (заказ ещё
// едет к покупателю) — это норма, не сбой: тихий C.faint текст, а не
// предупреждение. Малая выборка (n<3) — тоже C.faint, но с числом и своим
// title, чтобы не путать с «выкупов вовсе нет».
function BuyoutCell({ days, n, tasks }) {
  if (days == null) {
    // Выкупов нет — показываем, ГДЕ задания поставки сейчас (статусы WB,
    // часовой wb_fbs_status): «едут» ≠ «лежат на ПВЗ, покупатель не пришёл»
    // (запрос владельца 06.09.2026). Ведра — wbSuppliesOps.tasks.
    return (
      <td style={{ ...tdStyle("center"), color: C.faint, whiteSpace: "nowrap" }} title="выкупов пока нет; статусы заданий WB">
        <TaskBreakdown tasks={tasks} />
      </td>
    );
  }
  const low = n < 3;
  return (
    <td style={{ ...tdStyle("center"), color: low ? C.faint : C.ink }} title={low ? `мало выкупов (n=${n})` : `n=${n}`}>
      {days}
    </td>
  );
}

// TaskBreakdown — «едут 3 · ПВЗ 2 · отказ 1»: задания поставки по ведрам
// статусов WB (transit/pvz/sold/canceled/unknown из wbSuppliesOps.tasks).
// Пустые ведра не печатаем; если статусов нет вовсе (старые задания без
// order_id) — прежнее «ещё едут».
function TaskBreakdown({ tasks }) {
  const t = tasks || {};
  const parts = [];
  if (t.transit) parts.push(`едут ${t.transit}`);
  if (t.pvz) parts.push(`ПВЗ ${t.pvz}`);
  if (t.sold) parts.push(`выкуп ${t.sold}`);
  if (t.canceled) parts.push(`отказ ${t.canceled}`);
  if (!parts.length) return <>ещё едут</>;
  return <>{parts.join(" · ")}</>;
}

// PvzCell — «До ПВЗ, дн»: медиана по заданиям поставки от закрытия до
// первого ready_for_pickup (pvzMedianDays/pvzN, §16.8). pvz_at копится
// только с 06.09.2026 и только для заданий, чей переход на ПВЗ увидел
// часовой опрос — у старых поставок значения нет, это не сбой: тихий «—»
// с подсказкой. Малая выборка (n<3) — C.faint с числом.
function PvzCell({ days, n, tasks }) {
  if (days == null) {
    const t = tasks || {};
    const hint = t.pvz || t.sold
      ? "прибытие на ПВЗ не поймано: задания были на ПВЗ/выкуплены до начала опроса 06.09"
      : "на ПВЗ пока не доехали";
    return <td style={{ ...tdStyle("center"), color: C.faint }} title={hint}>—</td>;
  }
  const low = n < 3;
  return (
    <td style={{ ...tdStyle("center"), color: low ? C.faint : C.ink }} title={low ? `мало заданий (n=${n})` : `n=${n}`}>
      {fmt1(days)}
    </td>
  );
}

// KpiRow/Kpi — локальные копии паттерна Сводки (SummaryPage.jsx:835-855),
// упрощённые под пять плашек Географии (без primary/спарклайна).
function KpiRow({ children }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 16 }}>{children}</div>;
}
function Kpi({ label, value, color, title, delta, sub }) {
  return (
    <div style={{ padding: "12px 16px", borderRadius: 10, background: C.surface, border: `1px solid ${C.line}`, minWidth: 130 }} title={title}>
      <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {delta && (
        <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, color: delta.dir === "up" ? C.pos : C.neg }}>
          {delta.dir === "up" ? "▲" : "▼"} {delta.text}
        </div>
      )}
      {sub && <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>{sub}</div>}
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
function Centered({ children }) {
  return (
    <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", color: C.muted, background: C.bg, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
}
