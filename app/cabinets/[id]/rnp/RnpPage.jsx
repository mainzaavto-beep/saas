"use client";
import { C, soft } from "@/lib/palette.js";

import { useEffect, useMemo, useState } from "react";

// =====================================================================
//  /cabinets/[id]/rnp — «Рука на пульсе» (оперативная сводка по товарам).
//  Источник: /api/cabinets/[id]/rnp-summary.
//  Колонки: Заказы факт/план · CTR ▲▼ · ДРР % · ДРР ₽ · Скидка МП ·
//           Прибыль факт/план · Оборачиваемость · Рейтинг ▲▼.
//  Клик по строке → детальная сводка (drilldown как в «Сводке по товарам»).
// =====================================================================


const ALERT = {
  info: { background: "rgba(79, 140, 255, 0.10)", border: "1px solid rgba(79, 140, 255, 0.35)", color: "#4f8cff" },
};
const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : r2(v) + "%");
const pct1 = (v) => (v == null || !Number.isFinite(v) ? "—" : (Math.round(v * 10) / 10) + "%");

// Значок динамики ▲▼ (up=зелёный, down=красный, flat=серый, none=пусто).
function Trend({ trend }) {
  if (trend === "up")   return <span style={{ color: C.pos, fontWeight: 700 }}>▲</span>;
  if (trend === "down") return <span style={{ color: C.neg, fontWeight: 700 }}>▼</span>;
  if (trend === "flat") return <span style={{ color: C.faint, fontWeight: 700 }}>—</span>;
  return <span style={{ color: C.faint }}>·</span>;
}

export default function RnpPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Дефолт РНП — неделя (пресет "week"). "default" → серверный дефолт (7дн от MAX).
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [preset, setPreset] = useState("default");
  const [mp, setMp] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "salesRub", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Пресеты [from, to] в YYYY-MM-DD.
  const presetToDates = (p) => {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (p === "yesterday") { const y = new Date(today); y.setDate(y.getDate() - 1); return [iso(y), iso(y)]; }
    if (p === "week")      { const w = new Date(today); w.setDate(w.getDate() - 6); return [iso(w), iso(today)]; }
    if (p === "thisMonth") { return [ymd(today.getFullYear(), today.getMonth() + 1, 1), iso(today)]; }
    if (p === "lastMonth") {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return [ymd(first.getFullYear(), first.getMonth() + 1, 1), ymd(last.getFullYear(), last.getMonth() + 1, last.getDate())];
    }
    return ["", ""];
  };
  const onPresetChange = (p) => {
    setPreset(p);
    if (p === "default") { setDateFrom(""); setDateTo(""); return; }
    if (p === "custom") return;
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
    fetch(`/api/cabinets/${cabinetId}/rnp-summary` + (qs ? "?" + qs : ""))
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  }, [cabinetId, qs]);

  const filtered = useMemo(() => {
    if (!data?.items) return [];
    let arr = data.items;
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
  }, [data, q, sort]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => { setPage(1); }, [q, pageSize, qs]);

  const hasActiveFilters = mp !== "all" || preset !== "default" || dateFrom || dateTo || q.trim();
  const resetFilters = () => {
    setMp("all"); setPreset("default"); setDateFrom(""); setDateTo(""); setQ("");
  };

  // Drilldown в детсводку — тот же механизм, что в «Сводке по товарам»,
  // дополнительно несём ref=rnp, чтобы детсводка знала, куда возвращать.
  const openDetail = (it) => {
    const p = new URLSearchParams();
    p.set("platform", it.platform === "ozon" ? "ozon" : "wb");
    p.set("nm", it.nm);
    p.set("ref", "rnp");
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    window.location.href = `/cabinets/${cabinetId}/detail?` + p.toString();
  };

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка «Руки на пульсе»…</Centered>;

  const t = data.totals || {};
  const period = data.period || {};

  return (
    <main style={{ width: "100%", margin: 0, padding: "20px 18px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Рука на пульсе</h1>
        <p style={{ margin: "3px 0 0", color: C.muted, fontSize: 13 }}>
          {data.count} товаров · период {period.from || "—"} → {period.to || "—"} ({period.days || "?"} дн.)
          {period.prevFrom && <> · сравнение с {period.prevFrom} → {period.prevTo}</>}
          {" "}· <span style={{ color: C.faint }}>кликните товар, чтобы открыть его детальную сводку</span>
        </p>
      </div>

      <div style={{ ...ALERT.info, padding: "8px 12px", borderRadius: 8, marginBottom: 14, fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <span>ℹ️</span>
        <span>{data.methodology}</span>
      </div>

      {/* KPI-плитки */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Kpi label="Заказы факт" value={num(t.orderedFact)} />
        <Kpi label="Прибыль факт" value={money(t.profitFact)} color={t.profitFact >= 0 ? C.pos : C.neg} />
        <Kpi label="CTR (рекл.)" value={pct(t.ctrPct)} />
        <Kpi label="ДРР %" value={pct(t.drrPct)} />
        <Kpi label="Реклама, ₽" value={money(t.adSpend)} color={C.neg} />
      </div>

      {/* Фильтры */}
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
            <option value="default">По умолчанию (7 дн)</option>
            <option value="yesterday">Вчера</option>
            <option value="week">Неделя (7 дн)</option>
            <option value="thisMonth">Этот месяц</option>
            <option value="lastMonth">Прошлый месяц</option>
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
        <span style={{ marginLeft: "auto" }}>
          Показано {pageItems.length === 0 ? 0 : (safePage - 1) * pageSize + 1}–{(pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length))} из {filtered.length}
        </span>
      </div>

      {/* Таблица */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              {COLS.map((col) => <Th key={col.key} col={col} sort={sort} setSort={setSort} />)}
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
                <Td right>{num(it.orderedFact)}</Td>
                <Td right style={planCell(it.orderedFact, it.orderedPlan)}>{it.orderedPlan != null ? num(it.orderedPlan) : "—"}</Td>
                <Td right>{pct1(it.ctrPct)} <Trend trend={it.ctrTrend} /></Td>
                <Td right>{pct(it.drrPctFact)}</Td>
                <Td right>{it.drrPctPlan != null ? pct(it.drrPctPlan) : "—"}</Td>
                <Td right>{money(it.drrRubFact)}</Td>
                <Td right>{it.drrRubPlan != null ? money(it.drrRubPlan) : "—"}</Td>
                <Td right>{it.mpDiscount != null ? pct1(it.mpDiscount) : "—"}</Td>
                <Td right>
                  <span style={{ color: (it.profitFact || 0) >= 0 ? C.pos : C.neg, fontWeight: 700 }}>{money(it.profitFact)}</span>
                </Td>
                <Td right>{it.profitPlan != null ? money(it.profitPlan) : "—"}</Td>
                <Td right>{it.turnoverDays != null ? num(it.turnoverDays) + " дн" : "—"}</Td>
                <Td right>
                  {it.rating != null ? r2(it.rating) + " ★" : "—"} <Trend trend={it.ratingTrend} />
                </Td>
              </tr>
            ))}
            {pageItems.length === 0 && (
              <tr><td colSpan={COLS.length} style={{ padding: 30, textAlign: "center", color: C.muted }}>Нет данных по выбранным фильтрам</td></tr>
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                <td style={tdFootL}>Итого ({filtered.length})</td>
                <td style={tdFootR}>{num(t.orderedFact)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{pct(t.ctrPct)}</td>
                <td style={tdFootR}>{pct(t.drrPct)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{money(t.adSpend)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={{ ...tdFootR, fontWeight: 800, color: t.profitFact >= 0 ? C.pos : C.neg }}>{money(t.profitFact)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
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

      <p style={{ marginTop: 18, fontSize: 11, color: C.faint }}>
        ⚠️ Рейтинг — сглаженный feedbackRating WB (честные отзывы пока не собираются). CTR — рекламный (клики/показы из daily_metrics).
      </p>
    </main>
  );
}

// Подсветка ячейки плана: зелёный если факт ≥ плана, красный если меньше.
function planCell(fact, plan) {
  if (plan == null || fact == null) return {};
  if (fact >= plan) return { color: C.pos };
  return { color: C.neg };
}

// ---------- Колонки ----------
const COLS = [
  { key: "name",        label: "Товар",            align: "left", minW: 320, sort: "name" },
  { key: "orderedFact", label: "Заказы факт",      minW: 95, sort: "num" },
  { key: "orderedPlan", label: "Заказы план",      minW: 95, sort: "num" },
  { key: "ctrPct",      label: "CTR, %",           minW: 95, sort: "num" },
  { key: "drrPctFact",  label: "ДРР, %",           minW: 75, sort: "num" },
  { key: "drrPctPlan",  label: "ДРР план, %",      minW: 90, sort: "num" },
  { key: "drrRubFact",  label: "ДРР, ₽",           minW: 95, sort: "num" },
  { key: "drrRubPlan",  label: "ДРР план, ₽",      minW: 95, sort: "num" },
  { key: "mpDiscount",  label: "Скидка МП, %",     minW: 100, sort: "num" },
  { key: "profitFact",  label: "Прибыль, ₽",       minW: 105, sort: "num" },
  { key: "profitPlan",  label: "Прибыль план, ₽",  minW: 110, sort: "num" },
  { key: "turnoverDays",label: "Оборач., дн",      minW: 90, sort: "num" },
  { key: "rating",      label: "Рейтинг",          minW: 85, sort: "num" },
];

// ---------- Композитная ячейка «Товар» ----------
function ProductCell({ it }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 280, maxWidth: 380 }}>
      <Thumb url={it.im_url} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 340 }} title={it.name}>
          {it.name || "—"}
        </div>
        <div style={{ fontSize: 11, color: C.faint, whiteSpace: "nowrap" }} title={(it.sa || "—") + " · " + it.nm}>
          {it.sa || "—"} · {it.nm}
        </div>
        <div style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap", marginTop: 1 }}>
          {it.brand ? it.brand : "—"}{it.grp ? ` · ${it.grp}` : ""}{` · ${it.shop}`}
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

// ---------- Хелперы UI (как в SummaryPage) ----------
const thStyle = {
  padding: "10px 8px", fontSize: 11, color: C.muted, textTransform: "uppercase",
  fontWeight: 600, whiteSpace: "nowrap", textAlign: "center",
};
function Th({ col, sort, setSort }) {
  const sortable = !!col.sort;
  const isActive = sortable && sort?.key === col.key;
  const onClick = sortable ? () => {
    if (isActive) setSort({ key: col.key, dir: sort.dir === "asc" ? "desc" : "asc" });
    else setSort({ key: col.key, dir: "desc" });
  } : undefined;
  return (
    <th
      onClick={onClick}
      style={{
        ...thStyle, textAlign: col.align === "left" ? "left" : "center",
        cursor: sortable ? "pointer" : "default", color: isActive ? C.ink : C.muted,
        minWidth: col.minW, position: "sticky", top: 0, zIndex: 1,
      }}
      title={sortable ? "Сортировка" : undefined}
    >
      {col.label}{isActive ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}
function Td({ children, right, left, title, style }) {
  return (
    <td style={{
      padding: "8px 8px", fontSize: 12.5, whiteSpace: "nowrap",
      textAlign: right ? "right" : left ? "left" : "center",
      fontVariantNumeric: right ? "tabular-nums" : "normal", ...style,
    }} title={title}>{children}</td>
  );
}
const tdFootL = { padding: "10px 8px", fontSize: 12.5, fontWeight: 800, color: C.ink, textAlign: "left", whiteSpace: "nowrap" };
const tdFootR = { padding: "10px 8px", fontSize: 12.5, color: C.ink, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

function Kpi({ label, value, color }) {
  return (
    <div style={{ padding: "12px 16px", borderRadius: 10, background: C.surface, border: `1px solid ${C.line}`, minWidth: 130 }}>
      <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
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
function Seg({ children }) { return <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>{children}</div>; }
function SegBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none",
      background: active ? C.accent : C.surfaceAlt, color: active ? "#0A1A1C" : C.ink, fontFamily: "inherit",
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
  ...inputStyle, padding: "7px 26px 7px 10px", appearance: "none",
  backgroundImage: "linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)",
  backgroundPosition: "calc(100% - 14px) 50%, calc(100% - 9px) 50%", backgroundSize: "5px 5px, 5px 5px", backgroundRepeat: "no-repeat", cursor: "pointer",
};
const resetBtnStyle = {
  padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
  border: `1px solid ${C.line}`, background: "transparent", color: C.muted, fontFamily: "inherit",
};

function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
