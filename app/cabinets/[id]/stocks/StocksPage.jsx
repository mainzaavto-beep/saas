"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState, useCallback, useMemo, Fragment } from "react";
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
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
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
  { id: "warehouses",  label: "Склады", icon: "🏭" },
  { id: "oos",         label: "Индексы OOS", icon: "📉" },
  { id: "dynamics",    label: "Динамика", icon: "📈" },
  { id: "finances",    label: "Финансы", icon: "💰" },
  { id: "efficiency",  label: "Эффективность", icon: "⚡" },
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
// Приоритет статуса для сортировки (совпадает с OOS_ORDER в route.js):
// out → critical → low → ok → no_sales.
const OOS_ORDER = { out: 0, critical: 1, low: 2, ok: 3, no_sales: 4 };

// ── Сортировка колонок (кликабельные заголовки таблиц) ──────────────────
// useSort хранит выбранную колонку и направление. apply(rows, spec) возвращает
// отсортированную копию. spec — карта «ключ колонки → функция-геттер значения».
// null/undefined трактуются как «большое» (проваливаются вниз при asc, вверх при desc).
const NULL_BIG = Number.POSITIVE_INFINITY;
function cmpVal(a, b) {
  // null/undefined трактуются как «большое» (проваливаются вниз при asc).
  const av = a == null ? NULL_BIG : a;
  const bv = b == null ? NULL_BIG : b;
  if (typeof av === "string" || typeof bv === "string") {
    return String(av).localeCompare(String(bv), "ru");
  }
  return av < bv ? -1 : av > bv ? 1 : 0;
}
function useSort(initialKey, initialDir = "desc") {
  const [s, setS] = useState({ key: initialKey, dir: initialDir });
  const toggle = (key) =>
    setS((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: initialDir }
    );
  const apply = (rows, spec) => {
    if (!s.key || !spec[s.key]) return rows;
    const getter = spec[s.key];
    const mul = s.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => mul * cmpVal(getter(a), getter(b)));
  };
  return { sort: s, toggle, apply };
}
// Кликабельный <th> со стрелкой ▲/▼/‖. baseStyle — thLeft/thR (выравнивание).
function SortTh({ colKey, sort, toggle, baseStyle, children }) {
  const active = sort.key === colKey;
  const icon = active ? (sort.dir === "asc" ? " ▲" : " ▼") : " ↕";
  return (
    <th
      style={{
        ...baseStyle,
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
        color: active ? C.ink : undefined,
      }}
      onClick={() => toggle(colKey)}
      title="Сортировка: клик меняет направление"
    >
      {children}
      <span style={{ fontSize: 9, color: active ? C.accent : C.faint, fontWeight: 700 }}>{icon}</span>
    </th>
  );
}

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
        <WarehousesTable rows={whF} trend={data.warehouseTrend} />
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
      {tab === "efficiency" && (
        <EfficiencyView
          byWarehouse={data?.efficiency?.byWarehouse || []}
          byCluster={data?.efficiency?.byCluster || []}
          realloc={data?.efficiency?.realloc || []}
        />
      )}
    </div>
  );
}

// =====================================================================
//  Вкладка 1: распределение по складам
// =====================================================================
function WarehousesTable({ rows, trend }) {
  const maxFull = Math.max(...rows.map((r) => r.quantity_full || 0), 1);
  // Доля склада — от суммы quantity_full ТЕКУЩЕГО отфильтрованного набора rows
  // (а не от готового r.share_pct из API: тот всегда делит на «свой» МП, поэтому
  // при фильтре «Все» доли WB и Ozon считаются от разных знаменателей и в сумме
  // дают ~200%). Приём — как в FinancesTable.shareCap ниже: денормализованное
  // поле с бэкенда игнорируем, знаменатель берём из того же rows, что и числитель.
  const sumQty = rows.reduce((a, r) => a + (r.quantity || 0), 0);
  const sumFull = rows.reduce((a, r) => a + (r.quantity_full || 0), 0);
  const sumItems = rows.reduce((a, r) => a + (r.items || 0), 0);
  const sumCost = rows.reduce((a, r) => a + (r.value_cost || 0), 0);
  const sumRetail = rows.reduce((a, r) => a + (r.value_retail || 0), 0);
  const shareOf = (r) => sumFull > 0 ? round2((r.quantity_full || 0) * 100 / sumFull) : 0;
  const { sort, toggle, apply } = useSort("quantity_full", "desc");
  const sorted = apply(rows, {
    platform:     (r) => r.platform,
    warehouse:    (r) => r.warehouse,
    quantity:     (r) => r.quantity,
    quantity_full:(r) => r.quantity_full,
    items:        (r) => r.items,
    share_pct:    shareOf,
    value_cost:   (r) => r.value_cost,
    value_retail: (r) => r.value_retail,
  });
  // Фактическая сумма долей по всем строкам (не безусловные «100%» — если из-за
  // округления получилось 99.9/100.1, это должно быть видно, а не замаскировано).
  const shareSum = rows.reduce((a, r) => a + shareOf(r), 0);

  // Раскрытая строка тренда (drill-down): ключ = platform|warehouse.
  const [openKey, setOpenKey] = useState(null);
  const trendByMp = trend || { wb: [], ozon: [] };

  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
            <th style={{ ...thLeft, width: 28, cursor: "default" }}></th>
            <SortTh colKey="platform"     sort={sort} toggle={toggle} baseStyle={thLeft}>МП</SortTh>
            <SortTh colKey="warehouse"    sort={sort} toggle={toggle} baseStyle={thLeft}>Склад</SortTh>
            <SortTh colKey="quantity"     sort={sort} toggle={toggle} baseStyle={thR}>Остаток (шт)</SortTh>
            <SortTh colKey="quantity_full"sort={sort} toggle={toggle} baseStyle={thR}>Полный</SortTh>
            <SortTh colKey="items"        sort={sort} toggle={toggle} baseStyle={thR}>Товаров</SortTh>
            <SortTh colKey="share_pct"    sort={sort} toggle={toggle} baseStyle={{ ...thLeft, width: 140 }}>Доля</SortTh>
            <SortTh colKey="value_cost"   sort={sort} toggle={toggle} baseStyle={thR}>Σ себест.</SortTh>
            <SortTh colKey="value_retail" sort={sort} toggle={toggle} baseStyle={thR}>Σ реализация</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const key = `${r.platform}|${r.warehouse}`;
            const isOpen = openKey === key;
            const series = (trendByMp[r.platform] || [])
              .filter((t) => t.warehouse === r.warehouse)
              .map((t) => ({ date: t.date, total: t.total }))
              .sort((a, b) => (a.date < b.date ? -1 : 1));
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => series.length > 0 && setOpenKey(isOpen ? null : key)}
                  style={{
                    borderBottom: `1px solid ${soft("line", 20)}`,
                    cursor: series.length > 0 ? "pointer" : "default",
                    background: isOpen ? soft("accent", 8) : "transparent",
                  }}
                  title={series.length > 0 ? "Клик — показать тренд по дням" : undefined}
                >
                  <td style={{ ...tdLeft, color: C.muted, fontSize: 11 }}>
                    {series.length > 0 ? (isOpen ? "▾" : "▸") : ""}
                  </td>
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
                      <span style={{ fontSize: 11, color: C.muted, minWidth: 40, textAlign: "right" }}>{shareOf(r)}%</span>
                    </div>
                  </td>
                  <td style={{ ...tdRight, color: C.neg }}>{money(r.value_cost)}</td>
                  <td style={tdRight}>{money(r.value_retail)}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={9} style={{ padding: "10px 16px 14px", background: soft("accent", 6), borderBottom: `1px solid ${C.line}` }}>
                      <WarehouseTrend series={series} platform={r.platform} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: C.muted }}>
              Нет данных по складам для выбранного фильтра.
            </td></tr>
          )}
        </tbody>
        {sorted.length > 0 && (
          <tfoot>
            <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
              <td style={tdFootLeft}></td>
              <td style={tdFootLeft} colSpan={2}>Итого</td>
              <td style={tdFootRight}>{num(sumQty)}</td>
              <td style={{ ...tdFootRight, fontWeight: 700 }}>{num(sumFull)}</td>
              <td style={tdFootRight}>{num(sumItems)}</td>
              <td style={tdFootLeft}>{sumFull > 0 ? `${round2(shareSum)}%` : "—"}</td>
              <td style={{ ...tdFootRight, color: C.neg }}>{money(sumCost)}</td>
              <td style={tdFootRight}>{money(sumRetail)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ── Мини-тренд остатка склада по дням (drill-down) ──────────────────────
function WarehouseTrend({ series, platform }) {
  const stroke = platform === "wb" ? C.accent : C.pink;
  const values = series.map((s) => s.total);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const cur = values.length ? values[values.length - 1] : 0;
  const first = values.length ? values[0] : 0;
  const delta = cur - first;
  const deltaPct = first > 0 ? Math.round((delta / first) * 100) : 0;

  if (series.length === 0) {
    return <div style={{ color: C.muted, fontSize: 12, padding: 8 }}>Нет истории по дням для этого склада.</div>;
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 20, alignItems: "baseline", marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: C.muted }}>Остаток по дням (полный сток, шт)</span>
        <span style={{ fontSize: 12 }}>
          <span style={{ color: C.muted }}>min </span><b>{num(min)}</b>
          <span style={{ color: C.muted, marginLeft: 12 }}>max </span><b>{num(max)}</b>
          <span style={{ color: C.muted, marginLeft: 12 }}>сейчас </span><b>{num(cur)}</b>
          <span style={{ color: C.muted, marginLeft: 12 }}>Δ за период </span>
          <b style={{ color: delta > 0 ? C.pos : delta < 0 ? C.neg : C.muted }}>
            {delta > 0 ? "+" : ""}{num(delta)} {first > 0 ? `(${deltaPct > 0 ? "+" : ""}${deltaPct}%)` : ""}
          </b>
        </span>
      </div>
      <div style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            <CartesianGrid stroke={soft("line", 20)} vertical={false} />
            <XAxis dataKey="date" tickFormatter={fmtFull} tick={{ fontSize: 11, fill: C.muted }} stroke={soft("line", 30)} minTickGap={20} />
            <YAxis tickFormatter={(v) => num(v)} tick={{ fontSize: 11, fill: C.muted }} stroke={soft("line", 30)} width={50} />
            <Tooltip
              labelFormatter={fmtFullLong}
              formatter={(v) => [num(v) + " шт", "Остаток"]}
              contentStyle={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12 }}
            />
            <Line type="monotone" dataKey="total" name="Остаток" stroke={stroke} strokeWidth={2}
              dot={{ r: 3, fill: stroke }} activeDot={{ r: 5 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// =====================================================================
//  Вкладка 2: индексы OOS
// =====================================================================
function OosTable({ items, vel, categories, q, setQ, category, setCategory }) {
  // Дефолт: days_to_oos asc (критичные сверху). Статус сортируется по приоритету (OOS_ORDER).
  const { sort, toggle, apply } = useSort("days_to_oos", "asc");
  const sorted = apply(items, {
    name:         (it) => it.name,
    platform:     (it) => it.platform,
    quantity_full:(it) => it.quantity_full,
    velocity:     (it) => it.velocity,
    days_to_oos:  (it) => it.days_to_oos,
    status:       (it) => (OOS_ORDER[it.status] != null ? OOS_ORDER[it.status] : 9),
    value_cost:   (it) => it.value_cost,
  });
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
        Кликайте на заголовки колонок для сортировки (▲/▼). По умолчанию — по срочности (дней до OOS, критичные сверху).
        Оборачиваемость = средние продажи/день за {vel} дн.
      </div>
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <SortTh colKey="name"          sort={sort} toggle={toggle} baseStyle={thLeft}>Товар</SortTh>
              <SortTh colKey="platform"      sort={sort} toggle={toggle} baseStyle={thLeft}>МП</SortTh>
              <SortTh colKey="quantity_full" sort={sort} toggle={toggle} baseStyle={thR}>Остаток</SortTh>
              <SortTh colKey="velocity"      sort={sort} toggle={toggle} baseStyle={thR}>Продаж/день</SortTh>
              <SortTh colKey="days_to_oos"   sort={sort} toggle={toggle} baseStyle={thR}>Дней до OOS</SortTh>
              <SortTh colKey="status"        sort={sort} toggle={toggle} baseStyle={thLeft}>Статус</SortTh>
              <SortTh colKey="value_cost"    sort={sort} toggle={toggle} baseStyle={thR}>Заморожено ₽</SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((it, i) => (
              <OosRow key={`${it.platform}-${it.sku}-${i}`} it={it} />
            ))}
            {sorted.length === 0 && (
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
  // Итоги считаем от исходных rows (не зависят от порядка сортировки).
  const totalCost = rows.reduce((a, r) => a + (r.value_cost || 0), 0);
  const totalRetail = rows.reduce((a, r) => a + (r.value_retail || 0), 0);
  const { sort, toggle, apply } = useSort("value_cost", "desc");
  const sorted = apply(rows, {
    platform:     (r) => r.platform,
    warehouse:    (r) => r.warehouse,
    value_cost:   (r) => r.value_cost,
    value_retail: (r) => r.value_retail,
    margin:       (r) => (r.value_retail || 0) - (r.value_cost || 0),
    share_cap:    (r) => totalCost > 0 ? ((r.value_cost || 0) * 100) / totalCost : 0,
  });
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
            <SortTh colKey="platform"     sort={sort} toggle={toggle} baseStyle={thLeft}>МП</SortTh>
            <SortTh colKey="warehouse"    sort={sort} toggle={toggle} baseStyle={thLeft}>Склад</SortTh>
            <SortTh colKey="value_cost"   sort={sort} toggle={toggle} baseStyle={thR}>Σ себест.</SortTh>
            <SortTh colKey="value_retail" sort={sort} toggle={toggle} baseStyle={thR}>Σ реализация</SortTh>
            <SortTh colKey="margin"       sort={sort} toggle={toggle} baseStyle={thR}>Потенц. маржа</SortTh>
            <SortTh colKey="share_cap"    sort={sort} toggle={toggle} baseStyle={thR}>Доля капитала</SortTh>
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
//  Вкладка 5: Эффективность складов (оборачиваемость + локальность + рекомендации)
// =====================================================================
function EfficiencyView({ byWarehouse, byCluster, realloc }) {
  const [showRealloc, setShowRealloc] = useState(false);
  return (
    <>
      <div style={{ ...alertStyle, marginBottom: 12, borderLeft: `3px solid ${C.accent}` }}>
        <strong>⚡ Эффективность складов</strong> — где товар работает лучше всего.
        Метрики: <b>оборачиваемость</b> (на сколько дней хватит остатка при текущей скорости
        продаж), <b>локальность</b> (доля продаж в свой кластер — дешевле логистика),
        <b> продажи</b> и доля в выручке. Грузите склады с высокой оборачиваемостью и
        локальностью.
        <br />
        <span style={{ fontSize: 11, color: C.faint }}>
          ⚠ Оборачиваемость — аппроксимация: текущий остаток ÷ скорость продаж за окно (истории снимков мало).
          Локальность — по 7 укрупнённым кластерам WB (regionName).
        </span>
      </div>

      {/* KPI по кластерам */}
      {byCluster.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 8px" }}>🗺️ По кластерам</div>
          <ClusterKpi clusters={byCluster} />
        </>
      )}

      {/* Таблица складов */}
      <div style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>🏭 По складам</div>
      <EfficiencyTable rows={byWarehouse} />

      {/* Сворачиваемый блок рекомендаций к перемещению */}
      <div style={{ marginTop: 20, borderTop: `1px solid ${C.line}`, paddingTop: 16 }}>
        <button onClick={() => setShowRealloc((v) => !v)} style={{
          background: "transparent", border: "none", cursor: "pointer", padding: 0,
          fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: C.accent,
        }}>
          {showRealloc ? "▼" : "▶"} Рекомендации к перемещению ({realloc.length})
        </button>
        <span style={{ marginLeft: 10, fontSize: 12, color: C.faint }}>
          куда логично перевезти с неэффективных складов (оформляется в ЛК, через API нельзя)
        </span>
        {showRealloc && (
          <div style={{ marginTop: 12 }}>
            <ReallocTable rows={realloc} embedded />
          </div>
        )}
      </div>
    </>
  );
}

function ClusterKpi({ clusters }) {
  const top = [...clusters].sort((a, b) => (b.sales_rub || 0) - (a.sales_rub || 0)).slice(0, 4);
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {top.map((c) => (
        <div key={c.cluster} style={{
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10,
          padding: "10px 14px", flex: "1 1 180px", minWidth: 160,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.accent, marginBottom: 4 }}>{c.cluster}</div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{money(c.sales_rub)}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span>доля {c.share_pct}%</span>
            <span>складов: {c.wh_count}</span>
            <span style={{ color: C.pos }}>
              оборот {c.avg_turnover_days == null ? "—" : Math.round(c.avg_turnover_days) + "д"}
            </span>
            <span style={{ color: C.accent2 }}>
              лок. {c.avg_local_pct == null ? "—" : c.avg_local_pct + "%"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EfficiencyTable({ rows }) {
  const { sort, toggle, apply } = useSort("sales_rub", "desc");
  const sorted = apply(rows, {
    warehouse:      (r) => r.warehouse,
    cluster:        (r) => r.cluster,
    qty:            (r) => r.qty,
    value_cost:     (r) => r.value_cost,
    sales_qty:      (r) => r.sales_qty,
    sales_rub:      (r) => r.sales_rub,
    share_pct:      (r) => r.share_pct,
    turnover_days:  (r) => r.turnover_days,
    local_pct:      (r) => r.local_pct,
  });
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
            <SortTh colKey="warehouse"     sort={sort} toggle={toggle} baseStyle={thLeft}>Склад</SortTh>
            <SortTh colKey="cluster"       sort={sort} toggle={toggle} baseStyle={thLeft}>Кластер</SortTh>
            <SortTh colKey="qty"           sort={sort} toggle={toggle} baseStyle={thR}>Остаток (шт)</SortTh>
            <SortTh colKey="value_cost"    sort={sort} toggle={toggle} baseStyle={thR}>Σ себест.</SortTh>
            <SortTh colKey="sales_qty"     sort={sort} toggle={toggle} baseStyle={thR}>Продажи (шт)</SortTh>
            <SortTh colKey="sales_rub"     sort={sort} toggle={toggle} baseStyle={thR}>Продажи (₽)</SortTh>
            <SortTh colKey="share_pct"     sort={sort} toggle={toggle} baseStyle={thR}>Доля выручки</SortTh>
            <SortTh colKey="turnover_days" sort={sort} toggle={toggle} baseStyle={thR}>Оборач. (дн)</SortTh>
            <SortTh colKey="local_pct"     sort={sort} toggle={toggle} baseStyle={thR}>Локал. %</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const tdColor = r.turnover_days == null ? C.faint
              : r.turnover_days < 7 ? C.neg
              : r.turnover_days < 30 ? C.warn : C.pos;
            const locColor = r.local_pct == null ? C.faint
              : r.local_pct >= 30 ? C.pos : r.local_pct >= 10 ? C.warn : C.faint;
            return (
              <tr key={`${r.warehouse}-${i}`} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                <td style={tdLeft}>{r.warehouse}</td>
                <td style={{ ...tdLeft, fontSize: 11, color: C.muted }}>{r.cluster || "—"}</td>
                <td style={tdRight}>{num(r.qty)}</td>
                <td style={{ ...tdRight, color: C.neg }}>{money(r.value_cost)}</td>
                <td style={tdRight}>{num(r.sales_qty)}</td>
                <td style={{ ...tdRight, fontWeight: 700 }}>{money(r.sales_rub)}</td>
                <td style={tdRight}>{r.share_pct}%</td>
                <td style={{ ...tdRight, fontWeight: 700, color: tdColor }}>
                  {r.turnover_days == null ? "—" : (r.turnover_days === 0 ? "распродан" : Math.round(r.turnover_days))}
                </td>
                <td style={{ ...tdRight, color: locColor, fontWeight: 600 }}>
                  {r.local_pct == null ? "—" : r.local_pct + "%"}
                </td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: C.muted }}>
              Нет данных по складам за выбранный период.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// =====================================================================
//  Блок рекомендаций к перемещению (вложен в «Эффективность» или отдельно)
// =====================================================================
const LK_URL = "https://seller.wildberries.ru/suppliers-mutual-settlements";  // ЛК → раздел перевозок
function ReallocTable({ rows, embedded }) {
  // ⚠ useSort ВЫЗЫВАЕТСЯ ДО раннего return — иначе нарушится Rules of Hooks
  // (урок D7): число хуков не должно зависеть от данных.
  const { sort, toggle, apply } = useSort("days_to_oos", "asc");
  const list = rows || [];
  const sorted = apply(list, {
    name:           (r) => r.name,
    from_warehouse: (r) => r.from_warehouse,
    to_warehouse:   (r) => r.to_warehouse,
    qty_to_move:    (r) => r.qty_to_move,
    box_tariff_rub: (r) => r.box_tariff_rub,
    pallet_tariff_rub:(r) => r.pallet_tariff_rub,
    days_to_oos:    (r) => r.days_to_oos,
  });
  if (list.length === 0) {
    return (
      <>
        {!embedded && (
          <div style={{ ...alertStyle, marginBottom: 12 }}>
            <strong>ℹ️ Перемещение остатков между складами WB через API недоступно.</strong>{" "}
            Оформляйте перевозку вручную в ЛК продавца. Сейчас нет товаров, подходящих
            под рекомендацию (нужен избыток на одном складе и дефицит на другом при
            наличии тарифа между ними).
          </div>
        )}
        <Centered>Нет рекомендаций по перевозке для текущих остатков.</Centered>
      </>
    );
  }
  return (
    <>
      {!embedded && (
        <div style={{ ...alertStyle, marginBottom: 12, borderLeft: `3px solid ${C.accent}` }}>
          <strong>ℹ️ Перемещение остатков между складами WB через API недоступно.</strong>{" "}
          Оформляйте перевозку вручную в{" "}
          <a href={LK_URL} target="_blank" rel="noopener noreferrer"
             style={{ color: C.accent, textDecoration: "underline" }}>ЛК продавца →</a>.
          <br />
          Рекомендации ниже — про <em>выравнивание распределения</em> (где избыток, где
          дефицит). Тариф — за коробку 0–1500 г; точное число коробок и стоимость
          прикиньте по габаритам товара в ЛК.
        </div>
      )}
      <div style={{ fontSize: 12, color: C.faint, marginBottom: 8 }}>
        Кликайте на заголовки колонок для сортировки (▲/▼). По умолчанию — по срочности (дней до OOS).
      </div>
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <SortTh colKey="name"             sort={sort} toggle={toggle} baseStyle={thLeft}>Товар</SortTh>
              <SortTh colKey="from_warehouse"   sort={sort} toggle={toggle} baseStyle={thLeft}>Из склада</SortTh>
              <SortTh colKey="to_warehouse"     sort={sort} toggle={toggle} baseStyle={thLeft}>На склад</SortTh>
              <SortTh colKey="qty_to_move"      sort={sort} toggle={toggle} baseStyle={thR}>Кол-во</SortTh>
              <SortTh colKey="box_tariff_rub"   sort={sort} toggle={toggle} baseStyle={thR}>Тариф/коробку</SortTh>
              <SortTh colKey="pallet_tariff_rub"sort={sort} toggle={toggle} baseStyle={thR}>Палета</SortTh>
              <SortTh colKey="days_to_oos"      sort={sort} toggle={toggle} baseStyle={thR}>Дней до OOS</SortTh>
              <th style={thLeft}>Причина</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.nm_id}-${r.from_warehouse}-${r.to_warehouse}-${i}`}
                  style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                <td style={tdLeft}>
                  <div>{r.name || "—"}</div>
                  <div style={{ fontSize: 11, color: C.faint }}>{r.nm_id}{r.category ? ` · ${r.category}` : ""}</div>
                </td>
                <td style={tdLeft}>{r.from_warehouse}</td>
                <td style={{ ...tdLeft, fontWeight: 600, color: C.accent }}>{r.to_warehouse}</td>
                <td style={{ ...tdRight, fontWeight: 700 }}>{num(r.qty_to_move)} шт</td>
                <td style={tdRight}>{r.box_tariff_rub != null ? money(r.box_tariff_rub) : "—"}</td>
                <td style={tdRight}>{r.pallet_tariff_rub != null ? money(r.pallet_tariff_rub) : "—"}</td>
                <td style={{ ...tdRight, fontWeight: 700,
                  color: r.days_to_oos == null ? C.faint : (r.days_to_oos < 14 ? C.neg : r.days_to_oos < 30 ? C.warn : C.pos) }}>
                  {r.days_to_oos == null ? "—" : num(r.days_to_oos)}
                </td>
                <td style={{ ...tdLeft, fontSize: 12, color: C.muted, maxWidth: 320 }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
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
            color: value === o.v ? "var(--accentInk)" : C.muted,
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
