"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useState } from "react";
import { useSort } from "@/lib/useSort.js";

// /cabinets/[id]/order-matrix — «Матрица заказов» (14.10.2026): артикул площадки × день →
// заказы, шт (все, включая отменённые — как «Заказали» в ЛК WB и «Заказано» на «Сводке»).
// Источник: GET /api/cabinets/[id]/order-matrix?days=&platform=&showHidden= (сборка — lib/orderMatrix.js).
// Скрытие артикулов — свой список страницы (POST hide/unhide/hide_empty), на другие страницы не влияет.

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const LS_KEY = "orderMatrix.prefs";
const DAYS = [7, 14, 30, 60];
const PLATFORMS = [{ v: "all", l: "Все" }, { v: "wb", l: "Wildberries" }, { v: "ozon", l: "Ozon" }];
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const dayOf = (d) => new Date(d + "T00:00:00Z").getUTCDay();
const ddmm = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

function readPrefs() {
  try {
    const p = JSON.parse(window.localStorage.getItem(LS_KEY) || "{}");
    return {
      days: DAYS.includes(p.days) ? p.days : 14,
      platform: PLATFORMS.some((x) => x.v === p.platform) ? p.platform : "all",
      showHidden: p.showHidden === true,
    };
  } catch { return { days: 14, platform: "all", showHidden: false }; }
}

export default function OrderMatrixPage({ cabinetId }) {
  const [prefs, setPrefs] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [q, setQ] = useState("");
  const { sort, toggle, apply } = useSort("total");

  useEffect(() => { setPrefs(readPrefs()); }, []);
  useEffect(() => {
    if (!prefs) return;
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch {}
    setLoading(true);
    fetch(`/api/cabinets/${cabinetId}/order-matrix?days=${prefs.days}&platform=${prefs.platform}${prefs.showHidden ? "&showHidden=1" : ""}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setError(d.error); else { setData(d); setError(null); } })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId, prefs, reload]);

  const rows = useMemo(() => {
    let list = data?.rows || [];
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((r) => (r.name || "").toLowerCase().includes(s)
      || String(r.sku).includes(s) || (r.article || "").toLowerCase().includes(s));
    const spec = { name: (r) => r.name, total: (r) => r.total, today: (r) => r.todayQty };
    for (const d of data?.dates || []) spec[`d:${d}`] = (r) => r.days[d]?.t || 0;
    return apply(list, spec);
  }, [data, q, apply]);

  const post = async (body) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/order-matrix`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) { window.alert(d.error || `Ошибка ${r.status}`); return null; }
      setReload((x) => x + 1);
      return d;
    } finally { setBusy(false); }
  };
  const hideEmpty = async () => {
    const n = (data?.rows || []).filter((r) => !r.hidden && r.total === 0 && r.todayQty === 0).length;
    if (!n) { window.alert("Артикулов без заказов за период нет."); return; }
    if (!window.confirm(`Скрыть ${n} арт. без заказов за ${data.days} дн и сегодня? Вернуть можно галочкой «Показать скрытые».`)) return;
    await post({ action: "hide_empty", days: data.days, platform: data.platform });
  };

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка…</Centered>;

  const t = data.totals;
  const hiddenOrders = t.allTotal - t.total;
  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", opacity: loading || busy ? 0.6 : 1 }}>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Матрица заказов</h1>
        <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13, maxWidth: 1000 }}>
          Заказы по дням, шт — все, включая отменённые (как «Заказано» на «Сводке по товарам»). {data.days} полных дней по вчера,
          {" "}сегодня — отдельной колонкой (день не закончился). Наведите на ячейку — сколько из заказов отменено.
        </p>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input placeholder="Поиск: название, артикул" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...inputStyle, minWidth: 220 }} />
        <Segmented value={prefs.platform} options={PLATFORMS} onChange={(v) => setPrefs((p) => ({ ...p, platform: v }))} />
        <Segmented value={prefs.days} options={DAYS.map((d) => ({ v: d, l: `${d} дн` }))} onChange={(v) => setPrefs((p) => ({ ...p, days: v }))} />
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 12, color: C.muted, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={prefs.showHidden} onChange={(e) => setPrefs((p) => ({ ...p, showHidden: e.target.checked }))} />
          показать скрытые ({data.hiddenCount})
        </label>
        <button onClick={hideEmpty} disabled={busy} style={btnStyle} title="Скрыть артикулы без единого заказа за выбранный период и сегодня">
          Скрыть все без заказов
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Kpi label={`Заказов за ${data.days} дн`} value={nf0.format(t.total)} accent />
        <Kpi label="В среднем в день" value={nf0.format(Math.round(t.total / data.days))} />
        <Kpi label="Сегодня (неполный день)" value={nf0.format(t.today)} />
        <Kpi label="Артикулов в таблице" value={nf0.format(rows.filter((r) => !r.hidden).length)}
          hint={data.hiddenCount ? `Скрыто ${data.hiddenCount} арт.${hiddenOrders > 0 ? `, у них ${nf0.format(hiddenOrders)} заказов за период — в итоги не входят` : ""}` : undefined} />
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "auto", maxHeight: "calc(100vh - 260px)" }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5, minWidth: "100%" }}>
          <thead>
            <tr>
              <SortTh colKey="name" sort={sort} toggle={toggle} style={{ ...thBase, ...stickyLeft, zIndex: 3, textAlign: "left", minWidth: 280 }}>Артикул</SortTh>
              <SortTh colKey="total" sort={sort} toggle={toggle} style={{ ...thBase, textAlign: "right", borderRight: `1px solid ${C.line}` }}>Итого</SortTh>
              {data.dates.map((d) => {
                const wd = dayOf(d);
                return (
                  <SortTh key={d} colKey={`d:${d}`} sort={sort} toggle={toggle} title={d}
                    style={{ ...thBase, textAlign: "center", minWidth: 44, background: wd === 0 || wd === 6 ? soft("warn", 8) : C.surface }}>
                    <div>{ddmm(d)}</div><div style={{ fontSize: 9.5, color: C.faint, fontWeight: 500 }}>{WD[wd]}</div>
                  </SortTh>
                );
              })}
              <SortTh colKey="today" sort={sort} toggle={toggle} title={`${data.today} — день ещё идёт`}
                style={{ ...thBase, textAlign: "center", minWidth: 52, borderLeft: `1px solid ${C.line}` }}>
                <div>Сегодня</div><div style={{ fontSize: 9.5, color: C.faint, fontWeight: 500 }}>{ddmm(data.today)}</div>
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={data.dates.length + 3} style={{ padding: 24, textAlign: "center", color: C.muted }}>Нет артикулов</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} style={{ opacity: r.hidden ? 0.45 : 1 }}>
                <td style={{ ...tdBase, ...stickyLeft }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {r.imUrl
                      ? <img src={r.imUrl} alt="" style={{ width: 30, height: 30, objectFit: "cover", borderRadius: 5, flex: "none" }} />
                      : <div style={{ width: 30, height: 30, borderRadius: 5, background: soft("line", 50), flex: "none" }} />}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ lineHeight: 1.2, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}</div>
                      <div style={{ fontSize: 10.5, color: C.faint }}>
                        <span style={{ fontWeight: 700, color: r.platform === "wb" ? C.accent : C.pink }}>{r.platform === "wb" ? "WB" : "Ozon"}</span>
                        {" "}{r.sku}{r.article ? ` · ${r.article}` : ""}{r.inactive ? " · неактивен" : ""}
                      </div>
                    </div>
                    <button onClick={() => post({ action: r.hidden ? "unhide" : "hide", platform: r.platform, sku: r.sku })} disabled={busy}
                      title={r.hidden ? "Вернуть в матрицу" : "Скрыть артикул на этой странице"}
                      style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 5, cursor: "pointer", color: C.muted, fontSize: 11, padding: "2px 6px", flex: "none" }}>
                      {r.hidden ? "вернуть" : "скрыть"}
                    </button>
                  </div>
                </td>
                <td style={{ ...tdBase, textAlign: "right", fontWeight: 800, borderRight: `1px solid ${C.line}` }}
                  title={r.cancelled ? `из них отменено ${r.cancelled}` : undefined}>
                  {r.total ? nf0.format(r.total) : <span style={{ color: C.faint }}>0</span>}
                </td>
                {data.dates.map((d) => <Cell key={d} v={r.days[d]} max={r.max} date={d} />)}
                <td style={{ ...tdBase, textAlign: "center", color: C.muted, borderLeft: `1px solid ${C.line}` }}
                  title={r.todayCancelled ? `из них отменено ${r.todayCancelled}` : undefined}>
                  {r.todayQty || <span style={{ color: C.faint }}>·</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...tdFoot, ...stickyLeft, zIndex: 3, textAlign: "left" }}>Итого по дням{data.hiddenCount ? <span style={{ fontWeight: 500, color: C.faint }}> (без скрытых)</span> : null}</td>
              <td style={{ ...tdFoot, textAlign: "right", borderRight: `1px solid ${C.line}` }}>{nf0.format(t.total)}</td>
              {data.dates.map((d) => <td key={d} style={{ ...tdFoot, textAlign: "center" }}>{nf0.format(t.byDay[d] || 0)}</td>)}
              <td style={{ ...tdFoot, textAlign: "center", color: C.muted, borderLeft: `1px solid ${C.line}` }}>{nf0.format(t.today)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// Ячейка: число заказов, фон — сила относительно лучшего дня строки.
function Cell({ v, max, date }) {
  const n = v?.t || 0;
  if (!n) return <td style={{ ...tdBase, textAlign: "center", color: C.faint }}>·</td>;
  const pct = max > 0 ? Math.round(8 + (n / max) * 42) : 0;
  return (
    <td style={{ ...tdBase, textAlign: "center", background: soft("accent", pct), fontWeight: 600 }}
      title={`${date}: ${n} шт${v.c ? `, из них отменено ${v.c}` : ""}`}>
      {n}{v.c ? <sup style={{ color: C.neg, fontSize: 8.5, marginLeft: 1 }}>{v.c}</sup> : null}
    </td>
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

function SortTh({ colKey, sort, toggle, style, children, title }) {
  const active = sort.key === colKey;
  const icon = active ? (sort.dir === "asc" ? "▲" : "▼") : "";
  return (
    <th style={{ ...style, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", color: active ? C.ink : style.color }}
      onClick={() => toggle(colKey)} title={title ? `${title}\nКлик — сортировка.` : "Клик — сортировка"}>
      {children}
      {icon && <span style={{ fontSize: 9, color: C.accent, fontWeight: 700, marginLeft: 2 }}>{icon}</span>}
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
const btnStyle = { padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, cursor: "pointer" };
const stickyLeft = { position: "sticky", left: 0, background: C.surface, zIndex: 1, borderRight: `1px solid ${C.line}` };
const thBase = { position: "sticky", top: 0, zIndex: 2, background: C.surface, padding: "8px 6px", fontWeight: 600, fontSize: 11, color: C.muted, borderBottom: `1px solid ${C.line}` };
const tdBase = { padding: "5px 6px", borderTop: `1px solid ${soft("line", 60)}`, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const tdFoot = { ...tdBase, position: "sticky", bottom: 0, background: C.surface, fontWeight: 800, borderTop: `1px solid ${C.line}` };
