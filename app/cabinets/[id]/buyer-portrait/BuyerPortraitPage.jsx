"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState, useCallback, useMemo } from "react";

// /cabinets/[id]/buyer-portrait — «Портрет покупателя» (подписка «Джем» WB).
//
// 2 вкладки:
//   • Поисковые запросы — по каким словам находят товары, позиции, частоты, CR.
//   • Воронка          — по товарам: показы → клики → корзина → заказ → выкуп.
//
// Источник: GET /api/cabinets/[id]/buyer-portrait?days=30 (один запрос — все вкладки).

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const num = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const pct = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v) + "%";
const fmtFull = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
};

const TABS = [
  { id: "queries", label: "Поисковые запросы", icon: "🔍" },
  { id: "funnel",  label: "Воронка конверсий", icon: "🔻" },
];
const DAYS_OPTIONS = [
  { v: 7,  l: "7д" },
  { v: 14, l: "14д" },
  { v: 30, l: "30д" },
  { v: 60, l: "60д" },
  { v: 90, l: "90д" },
];

// ── Сортировка (копия из StocksPage.jsx) ─────────────────────────────────
const NULL_BIG = Number.POSITIVE_INFINITY;
function cmpVal(a, b) {
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
function SortTh({ colKey, sort, toggle, baseStyle, children }) {
  const active = sort.key === colKey;
  const icon = active ? (sort.dir === "asc" ? " ▲" : " ▼") : " ↕";
  return (
    <th
      style={{ ...baseStyle, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", color: active ? C.ink : undefined }}
      onClick={() => toggle(colKey)}
      title="Сортировка: клик меняет направление"
    >
      {children}
      <span style={{ fontSize: 9, color: active ? C.accent : C.faint, fontWeight: 700 }}>{icon}</span>
    </th>
  );
}

// ── Бейдж кластера позиции (топ-100 зелёный, 101-200 жёлтый, ниже — красный) ─
function PositionBadge({ position }) {
  if (position == null) return <span style={{ color: C.faint }}>—</span>;
  let color, label;
  if (position <= 10) { color = C.pos; label = "топ-10"; }
  else if (position <= 30) { color = C.pos; label = "топ-30"; }
  else if (position <= 100) { color = C.warn; label = "топ-100"; }
  else if (position <= 200) { color = C.warn; label = "101-200"; }
  else { color = C.neg; label = "ниже 200"; }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <strong style={{ fontVariantNumeric: "tabular-nums" }}>{position}</strong>
      <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 5, background: soft(color === C.pos ? "pos" : color === C.warn ? "warn" : "neg", 15), color }}>{label}</span>
    </span>
  );
}

// =====================================================================
export default function BuyerPortraitPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState("queries");
  const [q, setQ] = useState("");

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/buyer-portrait?days=${days}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId, days]);
  useEffect(() => { reload(); }, [reload]);

  const queriesFiltered = useMemo(() => {
    if (!data?.queries) return [];
    if (!q.trim()) return data.queries;
    const s = q.toLowerCase().trim();
    return data.queries.filter((r) => (r.keyword || "").toLowerCase().includes(s));
  }, [data, q]);
  const funnelFiltered = useMemo(() => {
    if (!data?.funnel) return [];
    if (!q.trim()) return data.funnel;
    const s = q.toLowerCase().trim();
    return data.funnel.filter((r) =>
      (r.name || "").toLowerCase().includes(s) ||
      String(r.nm_id || "").includes(s) ||
      (r.brand || "").toLowerCase().includes(s)
    );
  }, [data, q]);

  if (loading) {
    return <Centered>Загрузка портрета покупателя…</Centered>;
  }
  if (error) {
    return (
      <Centered>
        <div style={{ color: C.neg, fontWeight: 700, marginBottom: 8 }}>Ошибка</div>
        <pre style={{ color: C.muted, fontSize: 12, whiteSpace: "pre-wrap" }}>{String(error)}</pre>
      </Centered>
    );
  }
  if (!data) return <Centered>Нет данных</Centered>;

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1500, margin: "0 auto" }}>
      <Header lastDate={data.lastDate} hasData={data.hasData} />

      {!data.hasData ? (
        <div style={alertStyle}>
          <strong>Портрет покупателя пока пуст.</strong>
          <br />
          Это означает одно из: (а) подписка «Джем» не активна у кабинета, (б) сборщик wb_jem ещё
          не отработал по расписанию (4×/день), (в) за выбранный период нет данных. Проверьте логи
          воркера: <code>tail -100 /opt/agentsDB/logs/saas_worker.log | grep wb_jem</code>.
        </div>
      ) : (
        <>
          {/* KPI шапка */}
          <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
            <Kpi label="Уник. запросов" value={num(data.kpis.uniq_keywords)} accent />
            <Kpi label="Ср. позиция" value={data.kpis.avg_position ?? "—"} />
            <Kpi label="Переходы в карточку" value={num(data.kpis.total_open_card)} />
            <Kpi label="Заказы" value={num(data.kpis.total_orders)} color={C.pos} />
            <Kpi label="CR клик→заказ" value={pct(data.kpis.cr_open_to_order)} />
            <Kpi label="CR корзина→заказ" value={pct(data.kpis.cr_cart_to_order)} />
          </div>

          {/* Контролы: окно + поиск */}
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
            <Segmented value={days} onChange={setDays} options={DAYS_OPTIONS} />
            <input
              style={inputStyle}
              placeholder="Поиск…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {/* Вкладки */}
          <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.line}`, marginBottom: 16 }}>
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

          {tab === "queries" && <QueriesTable rows={queriesFiltered} />}
          {tab === "funnel" && <FunnelTable rows={funnelFiltered} />}
        </>
      )}

      <p style={{ marginTop: 24, fontSize: 11, color: C.faint, lineHeight: 1.5 }}>
        Источник: подписка «Джем» WB (методы <code>search-report/report</code> и{" "}
        <code>search-report/product/search-texts</code>). Пол/возраст через API WB не отдаётся —
        только виджет в ЛК.
      </p>
    </div>
  );
}

// =====================================================================
function Header({ lastDate, hasData }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>🎯 Портрет покупателя</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        По каким запросам находят ваши товары, позиции в поиске и воронка конверсий
        (по подписке «Джем» WB).
        {hasData && lastDate ? ` Данные на: ${fmtFull(lastDate)}.` : ""}
      </p>
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: "60vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
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

// =====================================================================
//  Вкладка 1: Поисковые запросы
// =====================================================================
function QueriesTable({ rows }) {
  const { sort, toggle, apply } = useSort("orders", "desc");
  const sorted = apply(rows, {
    keyword:       (r) => r.keyword,
    freq:          (r) => r.freq,
    week_freq:     (r) => r.week_freq,
    avg_position:  (r) => r.avg_position,
    best_position: (r) => r.best_position,
    open_card:     (r) => r.open_card,
    add_to_cart:   (r) => r.add_to_cart,
    orders:        (r) => r.orders,
    open_to_cart_pct:  (r) => r.open_to_cart_pct,
    cart_to_order_pct: (r) => r.cart_to_order_pct,
    visibility:    (r) => r.visibility,
    nm_count:      (r) => r.nm_count,
  });
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: C.surface }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${C.line}` }}>
            <SortTh colKey="keyword"  sort={sort} toggle={toggle} baseStyle={thLeft}>Поисковый запрос</SortTh>
            <SortTh colKey="freq"     sort={sort} toggle={toggle} baseStyle={thR}>Частота</SortTh>
            <SortTh colKey="week_freq" sort={sort} toggle={toggle} baseStyle={thR}>Част/нед</SortTh>
            <SortTh colKey="nm_count" sort={sort} toggle={toggle} baseStyle={thR}>Товаров</SortTh>
            <SortTh colKey="avg_position" sort={sort} toggle={toggle} baseStyle={thR}>Ср. позиция</SortTh>
            <SortTh colKey="open_card" sort={sort} toggle={toggle} baseStyle={thR}>Переходы</SortTh>
            <SortTh colKey="add_to_cart" sort={sort} toggle={toggle} baseStyle={thR}>Корзина</SortTh>
            <SortTh colKey="orders" sort={sort} toggle={toggle} baseStyle={thR}>Заказы</SortTh>
            <SortTh colKey="open_to_cart_pct" sort={sort} toggle={toggle} baseStyle={thR}>CR показ→корз</SortTh>
            <SortTh colKey="cart_to_order_pct" sort={sort} toggle={toggle} baseStyle={thR}>CR корз→заказ</SortTh>
            <SortTh colKey="visibility" sort={sort} toggle={toggle} baseStyle={thR}>Видимость</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.keyword} style={{ borderBottom: `1px solid ${soft("line", 30)}`, background: i % 2 ? C.surfaceAlt : "transparent" }}>
              <td style={tdLeft}>
                <strong>{r.keyword}</strong>
              </td>
              <td style={tdRight}>{num(r.freq)}</td>
              <td style={tdRight}>{num(r.week_freq)}</td>
              <td style={tdRight}>{num(r.nm_count)}</td>
              <td style={tdRight}><PositionBadge position={r.avg_position} /></td>
              <td style={tdRight}>{num(r.open_card)}</td>
              <td style={tdRight}>{num(r.add_to_cart)}</td>
              <td style={tdRight}><strong style={{ color: (r.orders > 0 ? C.pos : C.muted) }}>{num(r.orders)}</strong></td>
              <td style={tdRight}>{pct(r.open_to_cart_pct)}</td>
              <td style={tdRight}>{pct(r.cart_to_order_pct)}</td>
              <td style={tdRight}>{pct(r.visibility)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={11} style={{ ...tdLeft, textAlign: "center", padding: 30, color: C.faint }}>
              Нет поисковых запросов за период. Возможно, данных недостаточно (нужно ≥14 дней).
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// =====================================================================
//  Вкладка 2: Воронка конверсий по товарам
// =====================================================================
function FunnelTable({ rows }) {
  const { sort, toggle, apply } = useSort("orders", "desc");
  const sorted = apply(rows, {
    nm_id:         (r) => r.nm_id,
    name:          (r) => r.name,
    avg_position:  (r) => r.avg_position,
    visibility:    (r) => r.visibility,
    open_card:     (r) => r.open_card,
    add_to_cart:   (r) => r.add_to_cart,
    orders:        (r) => r.orders,
    open_to_cart_pct:  (r) => r.open_to_cart_pct,
    cart_to_order_pct: (r) => r.cart_to_order_pct,
  });

  // Итоги в tfoot (считаются от исходных rows, не зависят от сортировки).
  const totals = rows.reduce(
    (acc, r) => {
      acc.open_card += r.open_card || 0;
      acc.add_to_cart += r.add_to_cart || 0;
      acc.orders += r.orders || 0;
      return acc;
    },
    { open_card: 0, add_to_cart: 0, orders: 0 }
  );
  const totCR1 = totals.open_card > 0 ? (totals.add_to_cart / totals.open_card) * 100 : 0;
  const totCR2 = totals.add_to_cart > 0 ? (totals.orders / totals.add_to_cart) * 100 : 0;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: C.surface }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${C.line}` }}>
            <SortTh colKey="name" sort={sort} toggle={toggle} baseStyle={thLeft}>Товар</SortTh>
            <SortTh colKey="avg_position" sort={sort} toggle={toggle} baseStyle={thR}>Ср. позиция</SortTh>
            <SortTh colKey="visibility" sort={sort} toggle={toggle} baseStyle={thR}>Видимость</SortTh>
            <SortTh colKey="open_card" sort={sort} toggle={toggle} baseStyle={thR}>Переходы</SortTh>
            <SortTh colKey="add_to_cart" sort={sort} toggle={toggle} baseStyle={thR}>Корзина</SortTh>
            <SortTh colKey="orders" sort={sort} toggle={toggle} baseStyle={thR}>Заказы</SortTh>
            <SortTh colKey="open_to_cart_pct" sort={sort} toggle={toggle} baseStyle={thR}>CR показ→корз</SortTh>
            <SortTh colKey="cart_to_order_pct" sort={sort} toggle={toggle} baseStyle={thR}>CR корз→заказ</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.nm_id} style={{ borderBottom: `1px solid ${soft("line", 30)}`, background: i % 2 ? C.surfaceAlt : "transparent" }}>
              <td style={tdLeft}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div style={{ fontSize: 11, color: C.faint }}>
                  {r.brand ? `${r.brand} · ` : ""}ID {r.nm_id}{r.subject ? ` · ${r.subject}` : ""}
                </div>
              </td>
              <td style={tdRight}><PositionBadge position={r.avg_position} /></td>
              <td style={tdRight}>{pct(r.visibility)}</td>
              <td style={tdRight}>{num(r.open_card)}</td>
              <td style={tdRight}>{num(r.add_to_cart)}</td>
              <td style={tdRight}><strong style={{ color: (r.orders > 0 ? C.pos : C.muted) }}>{num(r.orders)}</strong></td>
              <td style={tdRight}>{pct(r.open_to_cart_pct)}</td>
              <td style={tdRight}>{pct(r.cart_to_order_pct)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={8} style={{ ...tdLeft, textAlign: "center", padding: 30, color: C.faint }}>
              Нет данных воронки за период.
            </td></tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr style={{ borderTop: `2px solid ${C.line}`, background: C.surfaceAlt }}>
              <td style={tdFootLeft}>Итого по {rows.length} товарам</td>
              <td style={tdFootRight}></td>
              <td style={tdFootRight}></td>
              <td style={tdFootRight}>{num(totals.open_card)}</td>
              <td style={tdFootRight}>{num(totals.add_to_cart)}</td>
              <td style={tdFootRight}>{num(totals.orders)}</td>
              <td style={tdFootRight}>{pct(Math.round(totCR1 * 10) / 10)}</td>
              <td style={tdFootRight}>{pct(Math.round(totCR2 * 10) / 10)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
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
const alertStyle = { padding: "12px 16px", borderRadius: 8, fontSize: 13, lineHeight: 1.6, background: C.surfaceAlt, border: `1px solid ${soft("warn", 30)}`, color: C.muted };
