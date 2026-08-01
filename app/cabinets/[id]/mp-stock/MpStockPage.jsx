"use client";
import { C } from "@/lib/palette.js";

import { useEffect, useMemo, useState } from "react";


// =====================================================================
//  /items/mp-stock — Остатки на маркетплейсе (WB + Ozon).
//
//  Переключатель МП: Все / WB / Ozon. KPI и таблица пересчитываются по выбору.
//  Колонки: Товар · Себест. за ед. · Остаток · Полный · В пути→ · В пути← ·
//  Сумма (себест.) · Сумма (реализ.). Внизу — итоговая строка.
//  Фильтр по категории (WB: subject, Ozon: category) + поиск по имени/артикулу.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
const moneyC = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const num = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v);
// Сегодня в виде YYYY-MM-DD (для max у date-picker'а — нельзя выбрать будущую дату).
const todayStr = () => new Date().toLocaleDateString("sv-SE");

export default function MpStockPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [mp, setMp] = useState("all"); // all | wb | ozon
  const [cat, setCat] = useState("all"); // all | <category>
  const [tab, setTab] = useState("items"); // items | warehouses
  const [date, setDate] = useState(""); // YYYY-MM-DD или "" (срез по умолчанию = MAX date)
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const qs = date ? `?date=${date}` : "";
    fetch(`/api/cabinets/${cabinetId}/mp-stock${qs}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId, date]);

  // Товары выбранного МП. useMemo ДО условных return (Rules of Hooks).
  const platformItems = useMemo(() => {
    if (!data?.items) return [];
    return mp === "all" ? data.items : data.items.filter((i) => i.platform === mp);
  }, [data, mp]);

  // Категории для фильтра (зависят от выбранного МП).
  const categories = useMemo(
    () => [...new Set(platformItems.map((i) => i.category).filter(Boolean))].sort(),
    [platformItems]
  );

  const filtered = useMemo(() => {
    let arr = platformItems;
    if (cat !== "all") arr = arr.filter((i) => i.category === cat);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      arr = arr.filter(
        (i) =>
          String(i.name).toLowerCase().includes(s) ||
          String(i.sku).includes(s) ||
          String(i.article || "").toLowerCase().includes(s) ||
          String(i.brand || "").toLowerCase().includes(s)
      );
    }
    return arr;
  }, [platformItems, cat, q]);

  // KPI/totals по отфильтрованному списку (мгновенно при смене фильтра/МП).
  const t = useMemo(() => {
    const acc = { items: 0, quantity: 0, quantityFull: 0, inWayTo: 0, inWayFrom: 0, valueCost: 0, valueRetail: 0, noCogs: 0 };
    for (const it of filtered) {
      acc.items += 1;
      acc.quantity += it.quantity || 0;
      acc.quantityFull += it.quantity_full || 0;
      acc.inWayTo += it.in_way_to || 0;
      acc.inWayFrom += it.in_way_from || 0;
      acc.valueCost += it.value_cost || 0;
      acc.valueRetail += it.value_retail || 0;
      if (!(it.cost > 0)) acc.noCogs += 1;
    }
    return acc;
  }, [filtered]);

  if (error) return <Centered>Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка данных…</Centered>;
  if (!data.date) return <Centered>Данных по остаткам пока нет.</Centered>;

  // Складская разбивка по выбранному МП. При «Все» — оба МП вместе (byWarehouseAll
  // с меткой platform). Раньше при «Все» показывался только WB — баг.
  const warehouses =
    mp === "ozon" ? data.byWarehouseOzon :
    mp === "wb" ? data.byWarehouse :
    data.byWarehouseAll;

  return (
    <main style={{ maxWidth: 1640, margin: "0 auto", padding: "28px 30px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 18, display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Остатки на маркетплейсе</h1>
          <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
            Срез: {data.dateWb ? `WB ${data.dateWb}` : ""}{data.dateWb && data.dateOzon ? " · " : ""}{data.dateOzon ? `Ozon ${data.dateOzon}` : ""} · {t.items} SKU в выборке{loading ? " · загрузка…" : ""}
          </p>
        </div>
        {/* Выбор даты среза. Backend берёт ближайший снимок <= выбранной даты.
            Если дата пустая — MAX(date) (свежий срез по умолчанию). */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3 }}>
          Дата среза
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="date"
              value={date}
              max={todayStr()}
              onChange={(e) => setDate(e.target.value)}
              style={{ padding: "8px 12px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit" }}
            />
            {date && (
              <button onClick={() => setDate("")} title="Свежий срез" style={{ padding: "8px 12px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.muted, cursor: "pointer", fontSize: 12 }}>
                Сброс
              </button>
            )}
          </span>
        </label>
      </div>

      {/* KPI */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 14, marginBottom: 18 }}>
        {/* Главный KPI «Остаток» — по ПОЛНЫМ остаткам (quantity_full = склад + в пути).
            Раньше тут был просто quantity (только склад), что занижало真实ную сумму.
            quantity_full = quantity + in_way_to + in_way_from (WB) / fbo_present (Ozon). */}
        <Kpi label="Остаток (шт., полный)" value={num(t.quantityFull)} accent />
        <Kpi label="из них на складе" value={num(t.quantity)} />
        <Kpi label="В пути → клиенту" value={num(t.inWayTo)} />
        <Kpi label="В пути ← от клиента" value={num(t.inWayFrom)} />
        <Kpi label="Сумма (себест.)" value={money(t.valueCost)} />
        <Kpi label="Сумма (реализация)" value={money(t.valueRetail)} />
      </div>

      {t.noCogs > 0 && (
        <div style={{ background: "rgba(217,176,140,0.12)", border: `1px solid rgba(217,176,140,0.4)`, color: C.accent2, borderRadius: 12, padding: "10px 14px", fontSize: 13, marginBottom: 16 }}>
          ⚠ У {t.noCogs} товаров нет себестоимости — сумма по себестоимости для них = 0. Заведите её в разделе «Себестоимость».
        </div>
      )}

      {/* Переключатель МП */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
          {[
            { v: "all", label: "Все МП" },
            { v: "wb", label: "WB" },
            { v: "ozon", label: "Ozon" },
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => { setMp(opt.v); setCat("all"); }}
              style={{
                padding: "9px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none",
                background: mp === opt.v ? C.accent : C.surfaceAlt,
                color: mp === opt.v ? "#0A1A1C" : C.ink,
                transition: "background 0.15s",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {/* Вид: по товарам / по складам */}
        <div style={{ display: "inline-flex", gap: 8 }}>
          <TabBtn active={tab === "items"} onClick={() => setTab("items")}>По товарам</TabBtn>
          <TabBtn active={tab === "warehouses"} onClick={() => setTab("warehouses")}>По складам</TabBtn>
        </div>
      </div>

      {tab === "items" ? (
        <>
          {/* Фильтры строки */}
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            {categories.length > 0 && (
              <select
                value={cat}
                onChange={(e) => setCat(e.target.value)}
                style={{ padding: "9px 13px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13, minWidth: 200 }}
              >
                <option value="all">Все категории</option>
                {categories.map((c) => (<option key={c} value={c}>{c}</option>))}
              </select>
            )}
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск: имя, артикул, бренд…"
              style={{ flex: 1, minWidth: 200, padding: "9px 13px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14 }}
            />
          </div>

          {/* Таблица с итоговой строкой */}
          <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
              <thead>
                <tr style={{ background: C.surfaceAlt }}>
                  {HEADS.map((h) => (<th key={h.key} style={th(h)}>{h.label}</th>))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <tr key={it.platform + "-" + it.sku} style={{ borderTop: `1px solid ${C.line}` }}>
                    <Td>
                      <div>{it.name}</div>
                      <div style={{ fontSize: 11, color: C.faint }}>
                        {mp === "all" && (
                          <span style={{ color: it.platform === "wb" ? C.accent : "#ff8800", fontWeight: 700, marginRight: 6 }}>
                            {it.platform.toUpperCase()}
                          </span>
                        )}
                        {it.article || it.sku}{it.brand ? " · " + it.brand : ""}
                      </div>
                    </Td>
                    <Td right>{it.cost > 0 ? moneyC(it.cost) : <span style={{ color: C.faint }}>—</span>}</Td>
                    <Td right style={{ fontWeight: 700, color: it.quantity < 10 ? C.neg : C.ink }}>{num(it.quantity)}</Td>
                    <Td right>{num(it.quantity_full)}</Td>
                    <Td right>{num(it.in_way_to)}</Td>
                    <Td right>{num(it.in_way_from)}</Td>
                    <Td right>{it.cost > 0 ? money(it.value_cost) : <span style={{ color: C.faint }}>—</span>}</Td>
                    <Td right>{it.price > 0 ? money(it.value_retail) : <span style={{ color: C.faint }}>—</span>}</Td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={HEADS.length} style={{ padding: 20, textAlign: "center", color: C.muted }}>Ничего не найдено</td>
                  </tr>
                )}
              </tbody>
              {/* Итоговая строка */}
              {filtered.length > 0 && (
                <tfoot>
                  <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                    <td style={tdFootLeft}>Итого ({t.items} SKU)</td>
                    <td style={tdFootRight}>—</td>
                    <td style={{ ...tdFootRight, fontWeight: 800, color: C.accent }}>{num(t.quantity)}</td>
                    <td style={tdFootRight}>{num(t.quantityFull)}</td>
                    <td style={tdFootRight}>{num(t.inWayTo)}</td>
                    <td style={tdFootRight}>{num(t.inWayFrom)}</td>
                    <td style={{ ...tdFootRight, fontWeight: 800 }}>{money(t.valueCost)}</td>
                    <td style={{ ...tdFootRight, fontWeight: 800 }}>{money(t.valueRetail)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      ) : (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead>
              <tr style={{ background: C.surfaceAlt }}>
                {["Склад", "Остаток (шт.)", "Полный", "Товаров", "Сумма (себест.)", "Сумма (реализ.)"].map((h, i) => (
                  <th key={i} style={th({ align: i === 0 ? "left" : "right" })}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(warehouses || []).map((w, i) => (
                <tr key={w.warehouse + "-" + i} style={{ borderTop: `1px solid ${C.line}` }}>
                  <Td>
                    {mp === "all" && w.platform && (
                      <span style={{ color: w.platform === "wb" ? C.accent : "#ff8800", fontWeight: 700, marginRight: 6, fontSize: 11 }}>
                        {w.platform.toUpperCase()}
                      </span>
                    )}
                    {w.warehouse}
                  </Td>
                  <Td right style={{ fontWeight: 700 }}>{num(w.quantity)}</Td>
                  <Td right>{num(w.quantity_full)}</Td>
                  <Td right>{num(w.items)}</Td>
                  <Td right>{money(w.value_cost)}</Td>
                  <Td right>{money(w.value_retail)}</Td>
                </tr>
              ))}
              {(!warehouses || warehouses.length === 0) && (
                <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: C.muted }}>Нет данных по складам для этого МП</td></tr>
              )}
            </tbody>
            {(warehouses && warehouses.length > 0) && (
              <tfoot>
                <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                  <td style={tdFootLeft}>Итого ({warehouses.length} складов)</td>
                  <td style={tdFootRight}>{num(warehouses.reduce((a, w) => a + (w.quantity || 0), 0))}</td>
                  <td style={{ ...tdFootRight, fontWeight: 800 }}>{num(warehouses.reduce((a, w) => a + (w.quantity_full || 0), 0))}</td>
                  <td style={tdFootRight}>{num(warehouses.reduce((a, w) => a + (w.items || 0), 0))}</td>
                  <td style={{ ...tdFootRight, fontWeight: 800 }}>{money(warehouses.reduce((a, w) => a + (w.value_cost || 0), 0))}</td>
                  <td style={{ ...tdFootRight, fontWeight: 800 }}>{money(warehouses.reduce((a, w) => a + (w.value_retail || 0), 0))}</td>
                </tr>
              </tfoot>
            )}
          </table>
          {mp === "wb" && (
            <p style={{ padding: "0 14px 12px", color: C.faint, fontSize: 12 }}>
              Топ-20 складов WB по остатку. Мелкие склады скрыты.
            </p>
          )}
          {mp === "all" && (
            <p style={{ padding: "0 14px 12px", color: C.faint, fontSize: 12 }}>
              Все склады WB и Ozon, отсортированы по полному остатку.
            </p>
          )}
        </div>
      )}
    </main>
  );
}

const HEADS = [
  { key: "name", label: "Товар", align: "left" },
  { key: "cost", label: "Себест. за ед." },
  { key: "quantity", label: "Остаток" },
  { key: "quantity_full", label: "Полный" },
  { key: "in_way_to", label: "В пути →" },
  { key: "in_way_from", label: "В пути ←" },
  { key: "value_cost", label: "Сумма (себест.)" },
  { key: "value_retail", label: "Сумма (реализ.)" },
];

function Kpi({ label, value, accent }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: accent ? C.accent : C.ink }}>{value}</div>
    </div>
  );
}
function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "7px 16px", borderRadius: 9, border: `1px solid ${active ? C.accent : C.line}`,
      background: active ? C.accent : "transparent", color: active ? "#0A1A1C" : C.muted,
      cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600,
    }}>{children}</button>
  );
}
function Td({ children, right, style }) {
  return <td style={{ padding: "9px 12px", fontSize: 13, textAlign: right ? "right" : "left", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...style }}>{children}</td>;
}
const th = (h) => ({
  textAlign: h.align === "left" ? "left" : "right", padding: "11px 12px",
  fontSize: 11, color: C.muted, textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap",
});
const tdFootLeft = { padding: "12px", fontSize: 13, fontWeight: 800, color: C.ink, textAlign: "left" };
const tdFootRight = { padding: "12px", fontSize: 13, color: C.ink, textAlign: "right", fontVariantNumeric: "tabular-nums" };
function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
