"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useState } from "react";
import { useSort } from "@/lib/useSort.js";

// /cabinets/[id]/purchase-need — «Потребность» (06.10.2026): сколько закупить по активным
// товарам, чтобы хватило на горизонт (дефолт 30 дней) при скорости продаж последних 7 дней.
// Источник: GET /api/cabinets/[id]/purchase-need?window=&horizon= (расчёт — lib/purchaseNeed.js).
// Строка = физический товар: WB и Ozon сливаются, если привязаны к позиции на /inventory.

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const LS_KEY = "purchaseNeed.prefs";
const WINDOWS = [7, 14, 30];
const PLATFORMS = [{ v: "all", l: "Все" }, { v: "wb", l: "Wildberries" }, { v: "ozon", l: "Ozon" }];
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : nf0.format(v));
const money = (v) => (v == null || !Number.isFinite(v) ? "—" : `${nf0.format(v)} ₽`);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "нет снимка");

function readPrefs() {
  try {
    const p = JSON.parse(window.localStorage.getItem(LS_KEY) || "{}");
    return {
      window: WINDOWS.includes(p.window) ? p.window : 7,
      horizon: Number.isFinite(p.horizon) && p.horizon >= 1 && p.horizon <= 365 ? p.horizon : 30,
      platform: PLATFORMS.some((x) => x.v === p.platform) ? p.platform : "all",
    };
  } catch { return { window: 7, horizon: 30, platform: "all" }; }
}

export default function PurchaseNeedPage({ cabinetId }) {
  const [prefs, setPrefs] = useState(null);
  const [horizonDraft, setHorizonDraft] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [onlyBuy, setOnlyBuy] = useState(false);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const { sort, toggle, apply } = useSort(null);

  useEffect(() => { const p = readPrefs(); setPrefs(p); setHorizonDraft(String(p.horizon)); }, []);
  useEffect(() => {
    if (!prefs) return;
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch {}
    setLoading(true);
    fetch(`/api/cabinets/${cabinetId}/purchase-need?window=${prefs.window}&horizon=${prefs.horizon}&platform=${prefs.platform}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setError(d.error); else { setData(d); setError(null); } })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId, prefs]);

  const rows = useMemo(() => {
    let list = data?.rows || [];
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((r) => (r.name || "").toLowerCase().includes(s)
      || [...r.skus.wb, ...r.skus.ozon].some((k) => String(k).includes(s))
      || (r.offers?.ozon || []).some((o) => o.toLowerCase().includes(s)));
    if (onlyBuy) list = list.filter((r) => r.needQty > 0);
    return apply(list, {
      name: (r) => r.name,
      mpQty: (r) => r.mpQty,
      ownQty: (r) => r.ownQty,
      transitQty: (r) => r.transitQty,
      velocity: (r) => r.velocity,
      coverageDays: (r) => r.coverageDays,
      needQty: (r) => r.needQty,
      needCost: (r) => r.needCost,
    });
  }, [data, q, onlyBuy, apply]);

  const commitHorizon = () => {
    const h = parseInt(horizonDraft, 10);
    if (Number.isFinite(h) && h >= 1 && h <= 365) setPrefs((p) => ({ ...p, horizon: h }));
    else setHorizonDraft(String(prefs?.horizon ?? 30));
  };

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка…</Centered>;

  const t = data.totals;
  const horizon = data.horizonDays;
  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1500, margin: "0 auto", opacity: loading ? 0.6 : 1 }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Потребность в закупке</h1>
        <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13, maxWidth: 980 }}>
          Сколько заказать, чтобы товара хватило на {horizon} дн при продажах последних {data.windowDays} дн (по вчера).
          {" "}Остаток = доступно {data.platform === "wb" ? "на WB" : data.platform === "ozon" ? "на Ozon" : "на WB и Ozon"} + свой склад/ФФ + в пути. Только активные товары.
          {data.platform !== "all" && " Свой склад общий для обеих площадок — в фильтре по площадке он учитывается целиком."}
          {" "}Срез WB: {fmtDate(data.stockDates?.wb)} · Ozon: {fmtDate(data.stockDates?.ozon)}.
        </p>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input placeholder="Поиск: название, артикул, offer_id" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...inputStyle, minWidth: 240 }} />
        <label style={{ fontSize: 12, color: C.muted, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={onlyBuy} onChange={(e) => setOnlyBuy(e.target.checked)} /> только к закупке
        </label>
        <a href={`/api/cabinets/${cabinetId}/purchase-need?format=xlsx&window=${prefs.window}&horizon=${prefs.horizon}&platform=${prefs.platform}&q=${encodeURIComponent(q.trim())}${onlyBuy ? "&onlyBuy=1" : ""}`}
          title="Скачать таблицу в Excel — с текущими площадкой, окном, горизонтом, поиском и фильтром «только к закупке»"
          style={{ padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, textDecoration: "none" }}>
          ⬇ Excel
        </a>
        <Segmented value={prefs.platform} options={PLATFORMS} onChange={(v) => setPrefs((p) => ({ ...p, platform: v }))} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.muted }}>Продажи за:</span>
        <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 7, overflow: "hidden" }}>
          {WINDOWS.map((w) => (
            <button key={w} onClick={() => setPrefs((p) => ({ ...p, window: w }))}
              style={{ padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600, border: "none", borderRight: `1px solid ${C.line}`,
                background: prefs.window === w ? C.accent : C.surface, color: prefs.window === w ? "var(--accentInk)" : C.muted }}>
              {w} дн
            </button>
          ))}
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: C.muted }} title="На сколько дней продаж закупать">
          Хватить на, дн
          <input type="number" min={1} max={365} value={horizonDraft}
            onChange={(e) => setHorizonDraft(e.target.value)} onBlur={commitHorizon}
            onKeyDown={(e) => e.key === "Enter" && commitHorizon()}
            style={{ ...inputStyle, minWidth: 0, width: 64, padding: "5px 8px" }} />
        </label>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Активных товаров" value={num(t.items)} />
        <Kpi label="Нужно закупить" value={`${num(t.toBuyItems)} поз.`} accent />
        <Kpi label="Штук к закупке" value={num(t.needQty)} accent />
        <Kpi label="Сумма по себестоимости" value={money(t.needCost)} hint="Себестоимость позиции склада, иначе — со страницы «Себестоимость». Товары без себестоимости в сумму не входят." />
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.line}` }}>
              <SortTh colKey="name" sort={sort} toggle={toggle} baseStyle={thLeft}>Товар</SortTh>
              <SortTh colKey="mpQty" sort={sort} toggle={toggle} baseStyle={thR} title="Доступно на складах WB и Ozon (без резерва)">На МП, шт</SortTh>
              <SortTh colKey="ownQty" sort={sort} toggle={toggle} baseStyle={thR} title="Остаток позиций на «Остатки склад/ФФ»">Свой склад, шт</SortTh>
              <SortTh colKey="transitQty" sort={sort} toggle={toggle} baseStyle={thR} title="Возвраты от клиентов WB в пути + отгрузки на МП, ещё не принятые площадкой">В пути, шт</SortTh>
              <SortTh colKey="velocity" sort={sort} toggle={toggle} baseStyle={thR} title={`Заказы WB + Ozon за ${data.windowDays} полных дней ÷ ${data.windowDays}`}>Продаж/день</SortTh>
              <SortTh colKey="coverageDays" sort={sort} toggle={toggle} baseStyle={thR} title="(на МП + свой склад + в пути) ÷ продаж в день">Хватит на, дн</SortTh>
              <SortTh colKey="needQty" sort={sort} toggle={toggle} baseStyle={thR} title={`⌈продаж/день × ${horizon} − (на МП + свой склад + в пути)⌉, не меньше 0`}>Закупить, шт</SortTh>
              <SortTh colKey="needCost" sort={sort} toggle={toggle} baseStyle={thR}>Сумма, ₽</SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: C.muted }}>Нет товаров</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} style={{ borderTop: `1px solid ${soft("line", 60)}` }}>
                <td style={tdLeft}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 240 }}>
                    {r.imUrl
                      ? <img src={r.imUrl} alt="" style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 6, flex: "none" }} />
                      : <div style={{ width: 34, height: 34, borderRadius: 6, background: soft("line", 50), flex: "none" }} />}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ lineHeight: 1.25 }}>{r.name}</div>
                      <div style={{ fontSize: 10.5, color: C.faint }}>
                        {r.skus.wb.length > 0 && <span>WB {r.skus.wb.join(", ")}</span>}
                        {r.skus.wb.length > 0 && r.skus.ozon.length > 0 && " · "}
                        {r.skus.ozon.length > 0 && <span>Ozon {r.skus.ozon.join(", ")}</span>}
                        {r.offers?.ozon?.length > 0 && <span style={{ color: C.muted }}> · {r.offers.ozon.join(", ")}</span>}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={tdRight}>{num(r.mpQty)}</td>
                <td style={{ ...tdRight, color: r.ownQty ? C.ink : C.faint }}>{num(r.ownQty)}</td>
                <td style={{ ...tdRight, color: r.transitQty ? C.ink : C.faint }}>{num(r.transitQty)}</td>
                <td style={tdRight}>{r.velocity > 0 ? nf1.format(r.velocity) : <span style={{ color: C.faint }}>нет продаж</span>}</td>
                <td style={{ ...tdRight, fontWeight: 700, color: coverageColor(r.coverageDays, horizon) }}>
                  {r.coverageDays == null ? "—" : nf0.format(Math.floor(r.coverageDays))}
                </td>
                <td style={{ ...tdRight, fontWeight: 800, color: r.needQty > 0 ? C.accent : C.faint }}>{r.needQty > 0 ? num(r.needQty) : "—"}</td>
                <td style={{ ...tdRight, color: r.needQty > 0 ? C.ink : C.faint }}>{r.needQty > 0 ? money(r.needCost) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11.5, color: C.muted, marginTop: 10, maxWidth: 980 }}>
        WB и Ozon одного товара сводятся в одну строку, когда их артикулы привязаны к позиции на странице
        {" "}<a href={`/cabinets/${cabinetId}/inventory`} style={{ color: C.accent }}>«Остатки склад/ФФ»</a>;
        {" "}непривязанные артикулы считаются отдельно, без остатка своего склада.
      </p>

      {data.unlinked?.length > 0 && (
        <div style={{ marginTop: 14, padding: "10px 14px", border: `1px solid ${soft("warn", 40)}`, borderRadius: 10, background: soft("warn", 8) }}>
          <button onClick={() => setShowUnlinked((v) => !v)} style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", fontSize: 13, fontWeight: 700, padding: 0 }}>
            {showUnlinked ? "▾" : "▸"} Позиции склада без артикула МП ({data.unlinked.length}) — не участвуют в расчёте
          </button>
          {showUnlinked && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, color: C.muted }}>
              {data.unlinked.map((u) => <li key={u.id}>{u.name} — {num(u.qty)} шт</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 7, overflow: "hidden" }}>
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)}
          style={{ padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600, border: "none", borderRight: `1px solid ${C.line}`,
            background: value === o.v ? C.accent : C.surface, color: value === o.v ? "var(--accentInk)" : C.muted }}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function coverageColor(days, horizon) {
  if (days == null) return C.faint;
  if (days < 7) return C.neg;
  if (days < horizon) return C.warn;
  return C.pos;
}

function SortTh({ colKey, sort, toggle, baseStyle, children, title }) {
  const active = sort.key === colKey;
  const icon = active ? (sort.dir === "asc" ? " ▲" : " ▼") : " ↕";
  return (
    <th style={{ ...baseStyle, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", color: active ? C.ink : undefined }}
      onClick={() => toggle(colKey)} title={title ? `${title}\n\nКлик — сортировка.` : "Сортировка: клик меняет направление"}>
      {children}
      <span style={{ fontSize: 9, color: active ? C.accent : C.faint, fontWeight: 700 }}>{icon}</span>
    </th>
  );
}

function Kpi({ label, value, accent, hint }) {
  return (
    <div title={hint} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 16px", minWidth: 170 }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2, color: accent ? C.accent : C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function Centered({ children }) {
  return <div style={{ padding: 40, textAlign: "center", color: C.muted, fontFamily: FONT }}>{children}</div>;
}

const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120 };
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeft = { padding: "8px 10px", verticalAlign: "middle", textAlign: "left" };
