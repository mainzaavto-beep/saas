"use client";
import { C, soft } from "@/lib/palette.js";

import { useEffect, useMemo, useState } from "react";

// Цветовая палитра SAAS (тёмно-синяя). Согласована с globals.css.
// Внутренние компоненты (Kpi/Th/Td/ProductCell/...) обращаются к C.*,
// поэтому держим объект C здесь — не тянем старую палитру из lib/theme.

const ALERT = {
  info: {
    background: "rgba(79, 140, 255, 0.10)",
    border: "1px solid rgba(79, 140, 255, 0.35)",
    color: "#4f8cff",
  },
};

// =====================================================================
//  /cabinets/[id]/summary — Сводка по товарам (SaaS, WB+Ozon).
//  Полный перенос эталона data-presenter/app/products/page.jsx с
//  адаптацией роутинга/API под мультитенантный контур.
//
//  Источник: /api/cabinets/[id]/products-summary — агрегаты по каждому
//  товару за период (заказано/продано/отмен/возвр/самовыкупы, выручка,
//  себест., комиссия, логистика, эквайринг, лояльность, налог, прибыль,
//  маржа, ROI, ДРР, ROMI, CPA, оборачиваемость, остаток).
//
//  ⚠️ МЕТОДОЛОГИЯ: цифры считаются из PostgreSQL по нашим формулам и
//  МОГУТ расходиться с выгрузкой Mpassistant на 5–30% (разная методология).
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : r2(v) + "%");

export default function SummaryPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Кабинетные расходы (№27) — отдельный источник (не входят в маржу SKU).
  const [cab, setCab] = useState(null);

  // Период и МП — управляют самим запросом к API (важно: разные колонки
  // берутся по разным датам, это делает сервер).
  // preset: "custom" — ручной от/до, либо один из быстрых пресетов.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [preset, setPreset] = useState("default"); // default=30дн от MAX, custom=ручной
  const [mp, setMp] = useState("all");
  // Остальные фильтры — клиентские (по готовым агрегатам).
  const [brand, setBrand] = useState("__all__");
  const [group, setGroup] = useState("__all__");
  const [cat, setCat] = useState("__all__");
  const [shop, setShop] = useState("__all__");
  const [q, setQ] = useState("");
  // Сортировка + пагинация.
  const [sort, setSort] = useState({ key: "salesRub", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Считает [from, to] для пресета в формате YYYY-MM-DD.
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
    return ["", ""]; // default / custom
  };

  const onPresetChange = (p) => {
    setPreset(p);
    if (p === "default" || p === "custom") {
      if (p === "default") { setDateFrom(""); setDateTo(""); }
      return;
    }
    const [f, t] = presetToDates(p);
    setDateFrom(f);
    setDateTo(t);
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

  // Кабинетные расходы (№27): те же platform/period, что у products-summary.
  useEffect(() => {
    setCab(null);
    fetch(`/api/cabinets/${cabinetId}/cabinet-costs` + (qs ? "?" + qs : ""))
      .then((r) => r.json())
      .then((d) => { if (!d.error) setCab(d); })
      .catch(() => {});
  }, [cabinetId, qs]);

  // Фасеты для дропдаунов.
  const facets = useMemo(() => {
    const f = { brand: new Map(), group: new Map(), cat: new Map(), shop: new Map() };
    for (const i of data?.items || []) {
      if (i.brand) f.brand.set(i.brand, (f.brand.get(i.brand) || 0) + 1);
      if (i.grp)   f.group.set(i.grp, (f.group.get(i.grp) || 0) + 1);
      if (i.cat)   f.cat.set(i.cat, (f.cat.get(i.cat) || 0) + 1);
      if (i.shop)  f.shop.set(i.shop, (f.shop.get(i.shop) || 0) + 1);
    }
    const toArr = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return { brand: toArr(f.brand), group: toArr(f.group), cat: toArr(f.cat), shop: toArr(f.shop) };
  }, [data]);

  const filtered = useMemo(() => {
    if (!data?.items) return [];
    let arr = data.items;
    if (brand !== "__all__") arr = arr.filter((i) => i.brand === brand);
    if (group !== "__all__") arr = arr.filter((i) => i.grp === group);
    if (cat !== "__all__")   arr = arr.filter((i) => i.cat === cat);
    if (shop !== "__all__")  arr = arr.filter((i) => i.shop === shop);
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
  }, [data, brand, group, cat, shop, q, sort]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => { setPage(1); }, [brand, group, cat, shop, q, pageSize, qs]);

  const hasActiveFilters = mp !== "all" || preset !== "default" || dateFrom || dateTo ||
    brand !== "__all__" || group !== "__all__" || cat !== "__all__" || shop !== "__all__" || q.trim();
  const resetFilters = () => {
    setMp("all"); setPreset("default"); setDateFrom(""); setDateTo("");
    setBrand("__all__"); setGroup("__all__"); setCat("__all__"); setShop("__all__"); setQ("");
  };

  // Переход в детальную сводку товара (drill-down → /cabinets/[id]/detail).
  // Несём текущий период (если задан) — чтобы деталь открылась тем же окном данных.
  const openDetail = (it) => {
    const p = new URLSearchParams();
    p.set("platform", it.platform === "ozon" ? "ozon" : "wb");
    p.set("nm", it.nm);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    window.location.href = `/cabinets/${cabinetId}/detail?` + p.toString();
  };

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка сводки по товарам…</Centered>;

  const t = data.totals || {};
  const period = data.period || {};
  // Дата снимка остатков Ozon (грабля #139): показываем последнюю доступную дату,
  // т.к. остаток = снапшот и может не совпадать с концом выбранного периода.
  const ozStockDate = (data.items || []).find((i) => i.platform === "ozon")?.stockDate || null;

  return (
    <main style={{ width: "100%", margin: 0, padding: "20px 18px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Сводка по товарам</h1>
        <p style={{ margin: "3px 0 0", color: C.muted, fontSize: 13 }}>
          {data.count} товаров · период {period.from || "—"} → {period.to || "—"} ({period.days || "?"} дн.)
          {ozStockDate && <> · <span title="У Ozon API не отдаёт историю остатков — показан последний доступный снимок">остатки Ozon на {ozStockDate}</span></>}
          {" "}· <span style={{ color: C.faint }}>кликните товар, чтобы открыть его детальную сводку</span>
        </p>
      </div>

      {/* Плашка о методологии — компактная, не навязчивая. */}
      <div style={{
        ...ALERT.info, padding: "8px 12px", borderRadius: 8, marginBottom: 14, fontSize: 12,
        display: "flex", gap: 8, alignItems: "center",
      }}>
        <span>ℹ️</span>
        <span>{data.methodology}</span>
      </div>

      {/* KPI-плитки */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Kpi label="Выручка" value={money(t.salesRub)} />
        <Kpi label="Прибыль" value={money(t.profit)} color={t.profit >= 0 ? C.pos : C.neg} />
        <Kpi label="Средняя маржа" value={pct(t.margin)} />
        <Kpi label="Заказано, шт" value={num(t.ordered)} />
        <Kpi label="Продано, шт" value={num(t.sold)} />
        <Kpi label="% выкупа" value={pct(t.buyoutPct)} />
        <Kpi label="ДРР (общий)" value={t.salesRub ? pct(100 * (t.adSpend || 0) / t.salesRub) : "—"} />
        <Kpi label="Реклама, ₽" value={money(t.adSpend)} />
        <Kpi
          label="Кабинетные расходы, ₽"
          value={cab ? money(cab.totals.all) : "…"}
          color={C.neg}
          title={cab ? `Без привязки к SKU (№27, вкл. хранение): WB ${money(cab.totals.wb)} · Ozon ${money(cab.totals.ozon)} — не входят в маржу товара` : undefined}
        />
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

      {/* Фильтры — ряд 2: бренд / группа / категория / магазин */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap" }}>
        <Field label="Бренд">
          <select value={brand} onChange={(e) => setBrand(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.brand.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
        <Field label="Группа товаров">
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.group.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
        <Field label="Категория">
          <select value={cat} onChange={(e) => setCat(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.cat.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
        <Field label="Магазин">
          <select value={shop} onChange={(e) => setShop(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.shop.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
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
              {COLS.map((col) => (
                <Th key={col.key} col={col} sort={sort} setSort={setSort} />
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
                <Td right>{num(it.ordered)}</Td>
                <Td right>{num(it.sold)}</Td>
                <Td right>{num(it.cancelled)}</Td>
                <Td right>{num(it.returns)}</Td>
                <Td right>{num(it.stock)}</Td>
                <Td right>{pct(it.buyoutPct)}</Td>
                <Td right>{num(it.avgOrdersDay)}</Td>
                <Td right>{money(it.orderRub)}</Td>
                <Td right>{money(it.avgCheck)}</Td>
                <Td right>{money(it.salesRub)}</Td>
                <Td right>{money(it.costRub)}</Td>
                <Td right>{money(it.commission)}</Td>
                <Td right>{pct(it.commissionPct)}</Td>
                <Td right>{money(it.logistics)}</Td>
                <Td right>{money(it.acquiring)}</Td>
                <Td right>{money(it.adSpend)}</Td>
                <Td right>{money(it.loyalty)}</Td>
                <Td right>{money(it.tax)}</Td>
                <Td right><span style={{ color: (it.profit || 0) >= 0 ? C.pos : C.neg, fontWeight: 700 }}>{money(it.profit)}</span></Td>
                <Td right>{money(it.avgProfit)}</Td>
                <Td right><span style={{ color: (it.margin || 0) >= 0 ? C.pos : C.neg, fontWeight: 600 }}>{pct(it.margin)}</span></Td>
                <Td right>{pct(it.roi)}</Td>
                <Td right>{pct(it.drr)}</Td>
                <Td right>{pct(it.romi)}</Td>
                <Td right>{money(it.cpa)}</Td>
                <Td right>{it.turnoverDays != null ? num(it.turnoverDays) + " дн" : "—"}</Td>
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
                <td style={tdFootR}>{num(t.ordered)}</td>
                <td style={tdFootR}>{num(t.sold)}</td>
                <td style={tdFootR}>{num(t.cancelled)}</td>
                <td style={tdFootR}>{num(t.returns)}</td>
                <td style={tdFootR}>{num(t.stock)}</td>
                <td style={tdFootR}>{pct(t.buyoutPct)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{money(t.orderRub)}</td>
                <td style={tdFootR}>{money(t.avgCheck)}</td>
                <td style={tdFootR}>{money(t.salesRub)}</td>
                <td style={tdFootR}>{money(t.costRub)}</td>
                <td style={tdFootR}>{money(t.commission)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{money(t.logistics)}</td>
                <td style={tdFootR}>{money(t.acquiring)}</td>
                <td style={tdFootR}>{money(t.adSpend)}</td>
                <td style={tdFootR}>{money(t.loyalty)}</td>
                <td style={tdFootR}>{money(t.tax)}</td>
                <td style={{ ...tdFootR, fontWeight: 800, color: t.profit >= 0 ? C.pos : C.neg }}>{money(t.profit)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{pct(t.margin)}</td>
                <td style={tdFootR}>—</td><td style={tdFootR}>—</td><td style={tdFootR}>—</td><td style={tdFootR}>—</td>
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

      {/* Кабинетные расходы (№27) — то, что API МП НЕ привязывает к товару.
          По контракту НЕЛЬЗЯ размазывать по SKU (искажает маржу): показываем
          отдельной секцией под основной таблицей. Источник: /api/cabinet-costs. */}
      {cab && cab.items && cab.items.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: C.ink }}>
            Кабинетные расходы (без привязки к товару)
          </h2>
          <p style={{ margin: "0 0 10px", color: C.muted, fontSize: 12 }}>
            Период {cab.period?.from || "—"} → {cab.period?.to || "—"} · Итого {money(cab.totals.all)}
            {" "}(<span style={{ color: C.accent }}>WB {money(cab.totals.wb)}</span>
            {" · "}<span style={{ color: C.pink }}>Ozon {money(cab.totals.ozon)}</span>)
          </p>
          <div style={{
            ...ALERT.info, padding: "8px 12px", borderRadius: 8, marginBottom: 10, fontSize: 12,
            display: "flex", gap: 8, alignItems: "center",
          }}>
            <span>⚠️</span>
            <span>{cab.methodology}</span>
          </div>
          <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
                  <th style={thStyle}>Тип расхода</th>
                  <th style={thStyle}>Платформа</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Сумма, ₽</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Доля</th>
                </tr>
              </thead>
              <tbody>
                {cab.items.map((it) => (
                  <tr key={it.platform + "-" + it.cost_type} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                    <Td left>{it.label}</Td>
                    <Td>
                      <span style={{
                        padding: "1px 6px", borderRadius: 5, fontSize: 10, fontWeight: 700,
                        background: it.platform === "wb" ? `${soft("accent", 13)}` : `${soft("pink", 13)}`,
                        color: it.platform === "wb" ? C.accent : C.pink,
                      }}>{it.platform === "wb" ? "WB" : "Ozon"}</span>
                    </Td>
                    <Td right>
                      <span style={{ color: (it.amount || 0) < 0 ? C.pos : C.ink, fontWeight: 600 }}>
                        {money(it.amount)}
                      </span>
                    </Td>
                    <Td right>{it.share != null ? pct(it.share) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                  <td style={tdFootL}>Итого</td>
                  <td style={tdFootR}>—</td>
                  <td style={{ ...tdFootR, fontWeight: 800, color: C.neg }}>{money(cab.totals.all)}</td>
                  <td style={tdFootR}>100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}

// Композитная ячейка «Товар» — схлопывает идентификационные колонки:
//   фото + имя + (арт.продавца · арт.МП · баркод) + (бренд · группа · магазин · МП).
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

// ---------- Колонки (key указывает на поле item) ----------
const COLS = [
  { key: "name",        label: "Товар",          align: "left", minW: 320, sort: "name" },
  { key: "ordered",     label: "Заказано",       minW: 80, sort: "num" },
  { key: "sold",        label: "Продано",        minW: 70, sort: "num" },
  { key: "cancelled",   label: "Отмен",          minW: 60, sort: "num" },
  { key: "returns",     label: "Возвраты",       minW: 70, sort: "num" },
  { key: "stock",       label: "Остаток",        minW: 75, sort: "num" },
  { key: "buyoutPct",   label: "% выкупа",       minW: 75, sort: "num" },
  { key: "avgOrdersDay",label: "Зак/день",       minW: 70, sort: "num" },
  { key: "orderRub",    label: "Заказов, ₽",     minW: 100, sort: "num" },
  { key: "avgCheck",    label: "Ср. чек",        minW: 85, sort: "num" },
  { key: "salesRub",    label: "Продажи, ₽",     minW: 100, sort: "num" },
  { key: "costRub",     label: "Себест., ₽",     minW: 95, sort: "num" },
  { key: "commission",  label: "Комиссия, ₽",    minW: 95, sort: "num" },
  { key: "commissionPct",label: "Ком. %",        minW: 65, sort: "num" },
  { key: "logistics",   label: "Логистика, ₽",   minW: 95, sort: "num" },
  { key: "acquiring",   label: "Эквайринг, ₽",   minW: 95, sort: "num" },
  { key: "adSpend",     label: "Реклама, ₽",     minW: 95, sort: "num" },
  { key: "loyalty",     label: "Лояльность, ₽",  minW: 95, sort: "num" },
  { key: "tax",         label: "Налог, ₽",       minW: 85, sort: "num" },
  { key: "profit",      label: "Прибыль, ₽",     minW: 100, sort: "num" },
  { key: "avgProfit",   label: "Ср. прибыль",    minW: 90, sort: "num" },
  { key: "margin",      label: "Маржа",          minW: 70, sort: "num" },
  { key: "roi",         label: "ROI",            minW: 65, sort: "num" },
  { key: "drr",         label: "ДРР",            minW: 60, sort: "num" },
  { key: "romi",        label: "ROMI",           minW: 70, sort: "num" },
  { key: "cpa",         label: "CPA, ₽",         minW: 80, sort: "num" },
  { key: "turnoverDays",label: "Оборач., дн",    minW: 85, sort: "num" },
];

// ---------- Хелперы UI ----------
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
        ...thStyle,
        textAlign: col.align === "left" ? "left" : "center",
        cursor: sortable ? "pointer" : "default",
        color: isActive ? C.ink : C.muted,
        minWidth: col.minW,
        position: "sticky",
        top: 0,
        zIndex: 1,
      }}
      title={sortable ? "Сортировка" : undefined}
    >
      {col.label}{isActive ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

function Td({ children, right, left, mono, title, style }) {
  return (
    <td style={{
      padding: "8px 8px", fontSize: 12.5, whiteSpace: "nowrap",
      textAlign: right ? "right" : left ? "left" : "center",
      fontVariantNumeric: (right || mono) ? "tabular-nums" : "normal",
      fontFamily: mono ? "ui-monospace, Consolas, monospace" : "inherit",
      ...style,
    }} title={title}>{children}</td>
  );
}
const tdFootL = { padding: "10px 8px", fontSize: 12.5, fontWeight: 800, color: C.ink, textAlign: "left", whiteSpace: "nowrap" };
const tdFootR = { padding: "10px 8px", fontSize: 12.5, color: C.ink, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

function Kpi({ label, value, color }) {
  return (
    <div style={{
      padding: "12px 16px", borderRadius: 10, background: C.surface,
      border: `1px solid ${C.line}`, minWidth: 130,
    }}>
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
