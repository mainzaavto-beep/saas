"use client";
import { C, soft } from "@/lib/palette.js";

import { useEffect, useMemo, useState } from "react";

// =====================================================================
//  /cabinets/[id]/abc — ABC-анализ товаров (SaaS, WB+Ozon).
//
//  Источник: /api/cabinets/[id]/products-summary — агрегаты по каждому
//  товару за период. ВЕКТОРНАЯ классификация на клиенте: КАЖДЫЙ товар
//  получает оценку A/B/C по 6 метрикам одновременно (а не одну общую).
//
//  Метод оценки зависит от типа метрики:
//   • Аддитивные (выручка / прибыль / заказы / продано) — кумулятивная
//     доля (Парето): сортируем по этой метрике ↓, считаем кумулятивную
//     долю от общего. Пороги фикс: ≤80% = A, 80–95% = B, &gt;95% = C.
//   • Процентные (маржа, ROI) — кумулятив НЕ применим. Пороги:
//       маржа: ≥25% = A, 10–25% = B, &lt;10% = C
//       ROI:   ≥50% = A, 0–50%  = B, &lt;0   = C
//
//  Layout: слева — бейджи классов по 6 метрикам, справа — числа.
//  Фильтр: «показать все товары, у которых метрика X = класс Y».
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : r2(v) + "%");

// 6 метрик классификации. Каждая определяет: key поля в item, тип метода,
// подпись, форматтер. ADDITIVE → кумулятив, PCT → пороги.
const METRICS = [
  { key: "salesRub", short: "Выр",  label: "По выручке",     type: "ADDITIVE", fmt: money },
  { key: "profit",   short: "Приб", label: "По прибыли",     type: "ADDITIVE", fmt: money },
  { key: "ordered",  short: "Зак",  label: "По заказам",     type: "ADDITIVE", fmt: num },
  { key: "sold",     short: "Прод", label: "По проданному",  type: "ADDITIVE", fmt: num },
  { key: "margin",   short: "Мар",  label: "По марже",       type: "PCT", fmt: pct, thresholds: [20, 8] },
  { key: "roi",      short: "ROI",  label: "По ROI",         type: "PCT", fmt: pct, thresholds: [50, 0] },
];

// Классы и визуальное оформление.
const ABC_META = {
  A: { color: C.pos,  bg: soft("pos", 15),  hint: "Лидер" },
  B: { color: C.warn, bg: soft("warn", 15), hint: "Средний" },
  C: { color: C.muted, bg: soft("muted", 15), hint: "Хвост / слабый" },
};

// Считает класс по ОДНОЙ метрике для массива items → Map(itemKey → "A"|"B"|"C").
// Для ADDITIVE — кумулятив по всему списку; для PCT — пороги.
function classifyByMetric(items, metric) {
  const out = new Map();
  if (!items.length) return out;
  if (metric.type === "ADDITIVE") {
    const sorted = [...items].sort((a, b) => (b[metric.key] || 0) - (a[metric.key] || 0));
    const total = sorted.reduce((s, it) => s + (it[metric.key] || 0), 0);
    let cum = 0;
    for (const it of sorted) {
      cum += it[metric.key] || 0;
      const cumPct = total > 0 ? (cum / total) * 100 : 0;
      const cls = cumPct <= 80 ? "A" : cumPct <= 95 ? "B" : "C";
      out.set(it.platform + "-" + it.nm, cls);
    }
  } else {
    // PCT: [hiA, hiB] → ≥hiA=A, hiB..hiA=B, <hiB=C.
    const [hiA, hiB] = metric.thresholds;
    for (const it of items) {
      const v = it[metric.key];
      const cls = (v == null || !Number.isFinite(v)) ? null
        : v >= hiA ? "A" : v >= hiB ? "B" : "C";
      out.set(it.platform + "-" + it.nm, cls);
    }
  }
  return out;
}

export default function AbcPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Период и МП — управляют запросом к API (сервер фильтрует по датам/МП).
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [preset, setPreset] = useState("default");
  const [mp, setMp] = useState("all");

  // Векторный фильтр: показать товары, у которых по выбранной метрике
  // выбранный класс. null = не фильтровать. Пример: {metric:"margin", cls:"C"}.
  const [fltMetric, setFltMetric] = useState(null);
  const [fltClass, setFltClass] = useState("all");

  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "salesRub", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const presetToDates = (p) => {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (p === "yesterday") {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      return [iso(y), iso(y)];
    }
    if (p === "week") {
      const w = new Date(today); w.setDate(w.getDate() - 6);
      return [iso(w), iso(today)];
    }
    if (p === "thisMonth") {
      return [ymd(today.getFullYear(), today.getMonth() + 1, 1), iso(today)];
    }
    if (p === "lastMonth") {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return [ymd(first.getFullYear(), first.getMonth() + 1, 1), ymd(last.getFullYear(), last.getMonth() + 1, last.getDate())];
    }
    if (p === "thisYear") {
      return [ymd(today.getFullYear(), 1, 1), iso(today)];
    }
    return ["", ""];
  };

  const onPresetChange = (p) => {
    setPreset(p);
    if (p === "default" || p === "custom") {
      if (p === "default") { setDateFrom(""); setDateTo(""); }
      return;
    }
    const [f, t] = presetToDates(p);
    setDateFrom(f); setDateTo(t);
  };

  const onManualDate = (which, val) => {
    setPreset("custom");
    if (which === "from") setDateFrom(val); else setDateTo(val);
  };

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (mp !== "all") p.set("platform", mp);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    return p.toString();
  }, [mp, dateFrom, dateTo]);

  useEffect(() => {
    setData(null); setError(null);
    fetch(`/api/cabinets/${cabinetId}/products-summary` + (qs ? "?" + qs : ""))
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  }, [cabinetId, qs]);

  // ЯДРО ABC: классифицируем ВСЕ товары периода по каждой из 6 метрик.
  // Сначала полная совокупность (без клиентских фильтров), иначе класс
  // для аддитивных исказится локальным подмножеством.
  const itemsAll = useMemo(() => data?.items || [], [data]);
  const classes = useMemo(() => {
    const m = {};
    for (const metric of METRICS) m[metric.key] = classifyByMetric(itemsAll, metric);
    return m;
  }, [itemsAll]);

  // Товары, обогащённые вектором оценок {abcSalesRub, abcProfit, ...}.
  const enriched = useMemo(() => {
    return itemsAll.map((it) => {
      const key = it.platform + "-" + it.nm;
      const abc = {};
      for (const metric of METRICS) abc["abc_" + metric.key] = classes[metric.key].get(key);
      return { ...it, _abc: abc };
    });
  }, [itemsAll, classes]);

  // Распределение по классам в разрезе каждой метрики (для сводки вверху).
  const distribution = useMemo(() => {
    const out = {};
    for (const metric of METRICS) {
      const counts = { A: 0, B: 0, C: 0, _: 0 };
      for (const it of itemsAll) {
        const c = classes[metric.key].get(it.platform + "-" + it.nm);
        if (c) counts[c]++; else counts._++;
      }
      out[metric.key] = counts;
    }
    return out;
  }, [itemsAll, classes]);

  // Клиентские фильтры + сортировка поверх обогащённых данных.
  const filtered = useMemo(() => {
    let arr = enriched;
    if (fltMetric && fltClass !== "all") {
      arr = arr.filter((it) => it._abc["abc_" + fltMetric] === fltClass);
    }
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      arr = arr.filter((i) =>
        String(i.sa || "").toLowerCase().includes(s) ||
        String(i.nm || "").includes(s) ||
        String(i.name || "").toLowerCase().includes(s) ||
        String(i.brand || "").toLowerCase().includes(s)
      );
    }
    if (sort) {
      const { key, dir } = sort;
      const mul = dir === "asc" ? 1 : -1;
      arr = [...arr].sort((a, b) => {
        const av = a[key], bv = b[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === "string") return av.localeCompare(bv) * mul;
        return (av - bv) * mul;
      });
    }
    return arr;
  }, [enriched, fltMetric, fltClass, q, sort]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => { setPage(1); }, [fltMetric, fltClass, q, pageSize, qs]);

  const hasActiveFilters = mp !== "all" || preset !== "default" || dateFrom || dateTo ||
    (fltMetric && fltClass !== "all") || q.trim();
  const resetFilters = () => {
    setMp("all"); setPreset("default"); setDateFrom(""); setDateTo("");
    setFltMetric(null); setFltClass("all"); setQ("");
  };

  const openDetail = (it) => {
    const p = new URLSearchParams();
    p.set("platform", it.platform === "ozon" ? "ozon" : "wb");
    p.set("nm", it.nm);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    window.location.href = `/cabinets/${cabinetId}/detail?` + p.toString();
  };

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка ABC-анализа…</Centered>;

  const t = data.totals || {};
  const period = data.period || {};

  // Активная метрика фильтра (для подсветки её столбца классов).
  const activeFilterMetric = fltMetric;

  return (
    <main style={{ width: "100%", margin: 0, padding: "20px 18px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>ABC-анализ товаров</h1>
        <p style={{ margin: "3px 0 0", color: C.muted, fontSize: 13 }}>
          {data.count} товаров · период {period.from || "—"} → {period.to || "—"} ({period.days || "?"} дн.)
          {" · "}
          <span style={{ color: C.faint }}>
            Каждый товар оценивается по 6 метрикам. Кликните товар — открыть детально.
          </span>
        </p>
      </div>

      {/* Плашка-методология. */}
      <div style={{
        background: soft("accent", 8), border: `1px solid ${soft("accent", 25)}`,
        padding: "8px 12px", borderRadius: 8, marginBottom: 14, fontSize: 12,
        color: C.muted, lineHeight: 1.5,
      }}>
        <strong style={{ color: C.ink }}>Методология:</strong>{" "}
        выручка/прибыль/заказы/продано — кумулятивная доля (A ≤80%, B 80–95%, C &gt;95%).
        Маржа — пороги ≥20% / 8–20% / &lt;8%. ROI — ≥50% / 0–50% / &lt;0.
        Один товар может быть A по заказам и C по марже одновременно.
      </div>

      {/* Сводка: распределение A/B/C по каждой метрике (кликабельно → фильтр). */}
      <div style={{ overflowX: "auto", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, minWidth: 720 }}>
          {METRICS.map((metric) => {
            const d = distribution[metric.key];
            const isActiveCol = activeFilterMetric === metric.key;
            return (
              <div key={metric.key} style={{
                flex: "1 1 0", minWidth: 110, padding: "10px 12px", borderRadius: 10,
                background: C.surface, border: `1px solid ${isActiveCol ? C.accent : C.line}`,
              }}>
                <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", fontWeight: 600, marginBottom: 6, letterSpacing: 0.3 }}>
                  {metric.label}
                </div>
                {["A", "B", "C"].map((cls) => {
                  const meta = ABC_META[cls];
                  const isSel = isActiveCol && fltClass === cls;
                  return (
                    <button key={cls} onClick={() => {
                      if (isSel) { setFltMetric(null); setFltClass("all"); }
                      else { setFltMetric(metric.key); setFltClass(cls); }
                    }} title={`${d[cls]} товаров класса ${cls} по ${metric.label.toLowerCase()} — клик: фильтр`}
                      style={{
                        display: "flex", alignItems: "center", gap: 6, width: "100%",
                        padding: "3px 6px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                        background: isSel ? meta.bg : "transparent", border: "1px solid transparent", marginBottom: 2,
                      }}>
                      <AbcBadge cls={cls} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: meta.color, fontVariantNumeric: "tabular-nums" }}>
                        {num(d[cls])}
                      </span>
                      <span style={{ fontSize: 11, color: C.faint, marginLeft: "auto" }}>
                        {d[cls] > 0 ? pct(d[cls] / itemsAll.length * 100) : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Фильтры — ряд 1: МП / Период / Поиск / Сбросить */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
        <Field label="Маркетплейс">
          <Seg>
            {[{ v: "all", l: "Все" }, { v: "wb", l: "WB" }, { v: "ozon", l: "Ozon" }].map((o) => (
              <SegBtn key={o.v} active={mp === o.v} onClick={() => setMp(o.v)}>{o.l}</SegBtn>
            ))}
          </Seg>
        </Field>
        <Field label="Быстрый период">
          <select value={preset} onChange={(e) => onPresetChange(e.target.value)} style={selectStyle}>
            <option value="default">По умолчанию (30 дн)</option>
            <option value="yesterday">Вчера</option>
            <option value="week">Неделя (7 дн)</option>
            <option value="thisMonth">Этот месяц</option>
            <option value="lastMonth">Прошлый месяц</option>
            <option value="thisYear">Этот год</option>
            <option value="custom">Свободный…</option>
          </select>
        </Field>
        <Field label="Период (точные даты)">
          <input type="date" value={dateFrom} onChange={(e) => onManualDate("from", e.target.value)} style={inputStyle} />
          <span style={{ color: C.faint, fontSize: 12 }}>—</span>
          <input type="date" value={dateTo} onChange={(e) => onManualDate("to", e.target.value)} style={inputStyle} />
        </Field>
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск: артикул, имя, бренд…"
          style={{ ...inputStyle, minWidth: 240, flex: 1 }}
        />
        {hasActiveFilters && <button onClick={resetFilters} style={resetBtnStyle}>Сбросить</button>}
      </div>

      {/* Размер страницы */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, fontSize: 12, color: C.muted }}>
        <span>Показывать:</span>
        {[20, 50, 100, 0].map((n) => (
          <button key={n} onClick={() => setPageSize(n)} style={{
            padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            border: `1px solid ${pageSize === n ? C.accent : C.line}`,
            background: pageSize === n ? C.accent : "transparent",
            color: pageSize === n ? "#0A1A1C" : C.muted, fontWeight: 600,
          }}>{n === 0 ? "все" : n}</button>
        ))}
        {activeFilterMetric && fltClass !== "all" && (
          <span style={{ marginLeft: 12, color: ABC_META[fltClass].color, fontWeight: 600 }}>
            Фильтр: {METRICS.find((m) => m.key === activeFilterMetric).label} = {fltClass}
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>
          Показано {pageItems.length === 0 ? 0 : (safePage - 1) * pageSize + 1}–{(pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length))} из {filtered.length}
        </span>
      </div>

      {/* Таблица: КЛАССЫ СЛЕВА, ЧИСЛА СПРАВА */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              <th style={{ ...thStyle, textAlign: "left", minWidth: 280 }}>Товар</th>
              {/* Группа «Классы» */}
              <th colSpan={METRICS.length} style={{ ...thStyle, borderBottom: `1px solid ${soft("line", 30)}`, borderLeft: `2px solid ${soft("line", 40)}` }}>
                Класс A/B/C
              </th>
              {/* Группа «Значения» */}
              <th colSpan={METRICS.length} style={{ ...thStyle, borderBottom: `1px solid ${soft("line", 30)}`, borderLeft: `2px solid ${soft("line", 40)}` }}>
                Значения
              </th>
            </tr>
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              <th style={thStyleBlank} />
              {METRICS.map((m) => (
                <th key={"h-cls-" + m.key} style={{
                  ...thStyle,
                  minWidth: 50,
                  borderLeft: METRICS.indexOf(m) === 0 ? `2px solid ${soft("line", 40)}` : "none",
                  color: activeFilterMetric === m.key ? C.accent : C.muted,
                }} title={m.label}>{m.short}</th>
              ))}
              {METRICS.map((m) => (
                <th key={"h-val-" + m.key} style={{
                  ...thStyle,
                  minWidth: m.type === "PCT" ? 70 : 95,
                  borderLeft: METRICS.indexOf(m) === 0 ? `2px solid ${soft("line", 40)}` : "none",
                }} title={m.label}>{m.label.split(" ")[1] || m.short}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageItems.map((it) => (
              <tr
                key={it.platform + "-" + it.nm}
                onClick={() => openDetail(it)}
                title="Кликните, чтобы открыть детальную сводку по товару"
                style={{ borderBottom: `1px solid ${soft("line", 20)}`, cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = `${soft("accent", 5)}`)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <Td left><ProductCell it={it} /></Td>
                {/* Классы (6 бейджей) */}
                {METRICS.map((m, i) => (
                  <Td key={"c-" + m.key} style={{ borderLeft: i === 0 ? `2px solid ${soft("line", 40)}` : "none" }}>
                    <AbcBadge cls={it._abc["abc_" + m.key]} />
                  </Td>
                ))}
                {/* Значения (6 чисел) */}
                {METRICS.map((m, i) => {
                  const v = it[m.key];
                  const colorize = (m.key === "profit" || m.key === "margin") ? ((v || 0) >= 0 ? C.pos : C.neg) : null;
                  return (
                    <Td key={"v-" + m.key} right style={{ borderLeft: i === 0 ? `2px solid ${soft("line", 40)}` : "none" }}>
                      <span style={colorize ? { color: colorize, fontWeight: 600 } : undefined}>{m.fmt(v)}</span>
                    </Td>
                  );
                })}
              </tr>
            ))}
            {pageItems.length === 0 && (
              <tr><td colSpan={1 + METRICS.length * 2} style={{ padding: 30, textAlign: "center", color: C.muted }}>Нет данных по выбранным фильтрам</td></tr>
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                <td style={tdFootL}>Итого ({filtered.length})</td>
                {METRICS.map((m, i) => (
                  <td key={"f-cls-" + m.key} style={{ ...tdFootC, borderLeft: i === 0 ? `2px solid ${soft("line", 40)}` : "none" }}>—</td>
                ))}
                {METRICS.map((m, i) => {
                  // Для аддитивных — сумма; для процентных — среднее.
                  let val;
                  if (m.type === "ADDITIVE") {
                    val = filtered.reduce((s, it) => s + (it[m.key] || 0), 0);
                  } else {
                    const xs = filtered.map((it) => it[m.key]).filter((x) => x != null && Number.isFinite(x));
                    val = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
                  }
                  return (
                    <td key={"f-val-" + m.key} style={{ ...tdFootR, borderLeft: i === 0 ? `2px solid ${soft("line", 40)}` : "none" }}>
                      {m.type === "ADDITIVE" ? money(val) : pct(val)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Пагинация */}
      {pageSize !== 0 && totalPages > 1 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", marginTop: 14 }}>
          <PagerBtn onClick={() => setPage(1)} disabled={safePage <= 1}>«</PagerBtn>
          <PagerBtn onClick={() => setPage(safePage - 1)} disabled={safePage <= 1}>‹</PagerBtn>
          <span style={{ padding: "0 12px", fontSize: 13, color: C.muted }}>{safePage} / {totalPages}</span>
          <PagerBtn onClick={() => setPage(safePage + 1)} disabled={safePage >= totalPages}>›</PagerBtn>
          <PagerBtn onClick={() => setPage(totalPages)} disabled={safePage >= totalPages}>»</PagerBtn>
        </div>
      )}
    </main>
  );
}

// Бейдж класса A/B/C. null → «—» (нет данных).
function AbcBadge({ cls, title }) {
  if (!cls) return <span style={{ color: C.faint }}>—</span>;
  const meta = ABC_META[cls];
  return (
    <span
      title={title || meta.hint}
      style={{
        display: "inline-block", minWidth: 34, padding: "5px 12px", borderRadius: 8,
        fontSize: 15, fontWeight: 800, textAlign: "center", lineHeight: 1.1,
        background: meta.bg, color: meta.color, border: `1px solid ${meta.color}`,
        fontVariantNumeric: "tabular-nums",
      }}
    >{cls}</span>
  );
}

// Композитная ячейка «Товар» — фото + имя + артикулы + бренд/магазин/МП.
function ProductCell({ it }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 280, maxWidth: 380 }}>
      <Thumb url={it.im_url} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden",
          textOverflow: "ellipsis", maxWidth: 340,
        }} title={it.name}>
          {it.name || "—"}
        </div>
        <div style={{ fontSize: 11, color: C.faint, whiteSpace: "nowrap" }} title={(it.sa || "—") + " · " + it.nm}>
          {it.sa || "—"} · {it.nm}{it.barcode ? ` · ${it.barcode}` : ""}
        </div>
        <div style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap", marginTop: 1 }}>
          {it.brand ? it.brand : "—"}
          {it.cat ? ` · ${it.cat}` : ""}
          {it.grp ? ` · ${it.grp}` : ""}
          {` · ${it.shop}`}
          <span style={{
            marginLeft: 6, padding: "1px 6px", borderRadius: 5, fontSize: 10, fontWeight: 700,
            background: it.platform === "wb" ? `${soft("accent", 13)}` : `${soft("pink", 13)}`,
            color: it.platform === "wb" ? C.accent : C.pink,
          }}>{it.platform === "wb" ? "WB" : "Ozon"}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Хелперы UI ----------
const thStyle = {
  padding: "10px 8px", fontSize: 11, color: C.muted, textTransform: "uppercase",
  fontWeight: 600, whiteSpace: "nowrap", textAlign: "center",
};
const thStyleBlank = { padding: 0, margin: 0, border: "none" };

function Td({ children, right, left, title, style }) {
  return (
    <td style={{
      padding: "8px 8px", fontSize: 12.5, whiteSpace: "nowrap",
      textAlign: right ? "right" : left ? "left" : "center",
      fontVariantNumeric: right ? "tabular-nums" : "normal",
      ...style,
    }} title={title}>{children}</td>
  );
}
const tdFootL = { padding: "10px 8px", fontSize: 12.5, fontWeight: 800, color: C.ink, textAlign: "left", whiteSpace: "nowrap" };
const tdFootR = { padding: "10px 8px", fontSize: 12.5, color: C.ink, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const tdFootC = { padding: "10px 8px", fontSize: 12.5, color: C.ink, textAlign: "center", whiteSpace: "nowrap" };

function PagerBtn({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "6px 12px", borderRadius: 7, cursor: disabled ? "default" : "pointer", fontFamily: "inherit",
      border: `1px solid ${disabled ? C.line : C.accent}`, background: disabled ? "transparent" : C.accent,
      color: disabled ? C.faint : "#0A1A1C", fontWeight: 700, fontSize: 13,
    }}>{children}</button>
  );
}

function Thumb({ url }) {
  const [err, setErr] = useState(false);
  if (!url || err) {
    return (
      <div style={{
        width: 40, height: 40, borderRadius: 7, flexShrink: 0,
        background: C.surfaceAlt, border: `1px solid ${C.line}`,
        display: "grid", placeItems: "center", color: C.faint, fontSize: 16,
      }}>🖼</div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url} alt="" width={40} height={40}
      onError={() => setErr(true)}
      style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 7, flexShrink: 0, border: `1px solid ${C.line}` }}
    />
  );
}

function Seg({ children }) {
  return <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>{children}</div>;
}
function SegBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none",
      background: active ? C.accent : C.surfaceAlt, color: active ? "#0A1A1C" : C.ink,
      fontFamily: "inherit",
    }}>{children}</button>
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
const resetBtnStyle = {
  padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
  border: `1px solid ${C.line}`, background: "transparent", color: C.muted, fontFamily: "inherit",
};

function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
