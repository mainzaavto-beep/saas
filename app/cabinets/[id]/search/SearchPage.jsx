"use client";
import { useEffect, useMemo, useState } from "react";
import { C, soft } from "@/lib/palette.js";
import { defaultPeriod } from "@/lib/period.js";
import { positionTone } from "@/lib/ozonSearch.js";
import PeriodPicker from "../PeriodPicker.jsx";
// =====================================================================
//  «Поиск и запросы» (Ozon) — витрина позиций по поисковым запросам из
//  кабинета продавца. Все расчёты — lib/ozonSearch.js (задача 8), здесь
//  только рендер и фильтры. Заказы/GMV здесь — «по запросу» (статистика
//  поиска кабинета), НЕ заказы панели.
// =====================================================================

const num = (n) => (n == null ? "—" : Math.round(n).toLocaleString("ru-RU"));
const pos1 = (n) => (n == null ? "—" : (Math.round(n * 10) / 10).toLocaleString("ru-RU", { maximumFractionDigits: 1 }));
const money = (n) => (n == null ? "—" : Math.round(n).toLocaleString("ru-RU") + " ₽");
const fmtFull = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};
const fmtShort = (iso) => {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
};

const inputStyle = {
  padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit",
};

// Фон/цвет ячейки по тону позиции — точные значения из брифа.
function toneStyle(tone) {
  if (tone === "top") return { background: soft("pos", 25), color: C.ink };
  if (tone === "good") return { background: soft("accent", 18), color: C.ink };
  if (tone === "mid") return { background: C.surfaceAlt, color: C.ink };
  if (tone === "low") return { background: "transparent", color: C.faint };
  return { background: "transparent", color: C.faint }; // none — пусто
}

export default function SearchPage({ cabinetId }) {
  const seed = useMemo(() => defaultPeriod(14), []);
  const [from, setFrom] = useState(seed.from);
  const [to, setTo] = useState(seed.to);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const [openSku, setOpenSku] = useState(null);
  const [skuData, setSkuData] = useState(null);
  const [minDemand, setMinDemand] = useState(0);
  const [onlyOrders, setOnlyOrders] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    setData(null);
    setError(null);
    const p = new URLSearchParams({ from, to });
    fetch(`/api/cabinets/${cabinetId}/search?${p}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError("Ошибка чтения базы: " + d.error) : setData(d)))
      .catch(() => setError("Не удалось загрузить данные."));
  }, [cabinetId, from, to]);

  useEffect(() => {
    if (!openSku) { setSkuData(null); return; }
    setSkuData(null);
    const p = new URLSearchParams({ from, to, sku: String(openSku), minDemand: String(minDemand || 0), onlyOrders: onlyOrders ? "1" : "0" });
    fetch(`/api/cabinets/${cabinetId}/search?${p}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError("Ошибка чтения базы: " + d.error) : setSkuData(d)))
      .catch(() => setError("Не удалось загрузить данные по запросам."));
  }, [cabinetId, from, to, openSku, minDemand, onlyOrders]);

  const font = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

  const items = useMemo(() => {
    const all = data?.items || [];
    if (!q.trim()) return all;
    const needle = q.trim().toLowerCase();
    return all.filter((it) =>
      String(it.name || "").toLowerCase().includes(needle) ||
      String(it.article || "").toLowerCase().includes(needle) ||
      String(it.sku).includes(needle)
    );
  }, [data, q]);

  if (error) return <Centered>{error}</Centered>;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: font }}>
      <div style={{ maxWidth: 1340, margin: "0 auto", padding: "28px 22px 56px" }}>
        <div style={{ marginBottom: 18, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800 }}>Поиск и запросы · Ozon</h1>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>позиции по данным кабинета продавца, лаг до суток</div>
          </div>
          <PeriodPicker value={{ from, to }} defaultGran="custom" onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
        </div>

        {!data ? (
          <Centered>Загрузка данных…</Centered>
        ) : data.cabinet?.hasProfile === false ? (
          <Centered>Кабинет продавца Ozon не подключён к панели: позиции по запросам доступны после подключения профиля кабинета (владелец сервиса).</Centered>
        ) : data.cabinet?.state === "expired" ? (
          <Centered>Сессия кабинета продавца истекла — войдите заново на вкладке «Сервер» panel.sysell.ru.</Centered>
        ) : (
          <>
            <KpiRow kpi={data.kpi} />

            <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 14 }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Поиск по имени или артикулу…"
                style={{ ...inputStyle, width: "100%", maxWidth: 420 }}
              />
            </div>

            {items.length === 0 ? (
              <Centered>Нет данных по SKU за выбранный период{q ? " и фильтр поиска" : ""}.</Centered>
            ) : (
              <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                      <Th></Th>
                      <Th align="left">Товар</Th>
                      <Th>Позиция</Th>
                      <Th>Δ</Th>
                      <Th>Спрос</Th>
                      <Th>Просмотры</Th>
                      <Th>CTR</Th>
                      <Th>GMV по запросу</Th>
                      <Th>Динамика</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <SkuRow
                        key={it.sku}
                        item={it}
                        open={openSku === it.sku}
                        onToggle={() => setOpenSku(openSku === it.sku ? null : it.sku)}
                      >
                        {openSku === it.sku && (
                          <MatrixPanel
                            data={skuData}
                            minDemand={minDemand}
                            setMinDemand={setMinDemand}
                            onlyOrders={onlyOrders}
                            setOnlyOrders={setOnlyOrders}
                          />
                        )}
                      </SkuRow>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: 16, fontSize: 12, color: C.faint, textAlign: "center" }}>
          Источник — «Запросы моих товаров» кабинета Ozon: спрос = уникальные покупатели, искавшие запрос и видевшие товар; позиция — средняя за день.
        </div>
      </div>
    </div>
  );
}

function KpiRow({ kpi }) {
  const delta = kpi?.position != null && kpi?.positionPrev != null ? Math.round((kpi.positionPrev - kpi.position) * 10) / 10 : null;
  const deltaGood = delta != null && delta > 0;
  const deltaBad = delta != null && delta < 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
      <Kpi title="Средняя позиция" value={pos1(kpi?.position)}
        sub={delta != null ? (
          <span style={{ color: deltaGood ? C.pos : deltaBad ? C.neg : C.faint, fontWeight: 700 }}>
            {delta > 0 ? "+" : ""}{pos1(delta)}
          </span>
        ) : "—"}
      />
      <Kpi title="Запросов в топ-10 / топ-50" value={`${num(kpi?.queriesTop10)} / ${num(kpi?.queriesTop50)}`} sub="на последний день" />
      <Kpi title="Спрос за период" value={num(kpi?.search_users)} sub="уникальные покупатели" />
      <Kpi title="Заказов по запросам" value={num(kpi?.orders)} sub="по статистике поиска, не заказы панели" />
    </div>
  );
}

function Kpi({ title, value, sub }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px" }}>
      <div style={{ fontSize: 12, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{value}</div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function SkuRow({ item, open, onToggle, children }) {
  const tone = positionTone(item.position);
  const ts = toneStyle(tone);
  const delta = item.positionDelta;
  const deltaColor = delta == null ? C.faint : delta > 0 ? C.pos : delta < 0 ? C.neg : C.faint;
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer", borderBottom: `1px solid ${C.line}`, background: open ? C.surfaceAlt : "transparent" }}>
        <td style={{ padding: "8px 10px" }}><Thumb url={item.im_url} /></td>
        <td style={{ padding: "8px 10px", textAlign: "left" }}>
          <div style={{ fontWeight: 600 }}>{item.name}</div>
          <div style={{ fontSize: 11, color: C.faint }}>{item.article || item.sku}</div>
        </td>
        <td style={{ padding: "8px 10px", textAlign: "center" }}>
          <span style={{ ...ts, display: "inline-block", minWidth: 34, padding: "2px 8px", borderRadius: 6, fontWeight: 700 }}>
            {item.position != null ? pos1(item.position) : "—"}
          </span>
        </td>
        <td style={{ padding: "8px 10px", textAlign: "center", color: deltaColor, fontWeight: 600 }}>
          {delta != null ? `${delta > 0 ? "+" : ""}${pos1(delta)}` : "—"}
        </td>
        <td style={{ padding: "8px 10px", textAlign: "center" }}>{num(item.search_users)}</td>
        <td style={{ padding: "8px 10px", textAlign: "center" }}>{num(item.view_users)}</td>
        <td style={{ padding: "8px 10px", textAlign: "center" }}>{item.ctr != null ? `${item.ctr}%` : "—"}</td>
        <td style={{ padding: "8px 10px", textAlign: "center" }}>{money(item.gmv)}</td>
        <td style={{ padding: "8px 10px", textAlign: "center" }}><Sparkline spark={item.spark} /></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ padding: 0, background: C.bg, borderBottom: `1px solid ${C.line}` }}>{children}</td>
        </tr>
      )}
    </>
  );
}

function Thumb({ url }) {
  const [err, setErr] = useState(false);
  const size = 36;
  if (!url || err) {
    return (
      <div style={{ width: size, height: size, borderRadius: 8, flexShrink: 0, background: C.surfaceAlt, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", color: C.faint, fontSize: 14 }}>🖼</div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} onError={() => setErr(true)}
      style={{ width: size, height: size, objectFit: "cover", borderRadius: 8, flexShrink: 0, border: `1px solid ${C.line}` }} />
  );
}

// Спарклайн позиции: SVG-полилиния 80×24, ось Y инвертирована (меньше значение = выше на графике).
function Sparkline({ spark }) {
  const points = (spark || []).filter((p) => p.position != null);
  if (points.length < 2) return <span style={{ color: C.faint, fontSize: 12 }}>—</span>;
  const w = 80, h = 24, pad = 2;
  const values = points.map((p) => p.position);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const xStep = (w - 2 * pad) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * xStep;
    const y = pad + ((p.position - min) / range) * (h - 2 * pad); // меньше позиция → меньше y → выше на графике
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block", margin: "0 auto" }}>
      <polyline points={coords} fill="none" stroke={C.accent} strokeWidth={1.5} />
    </svg>
  );
}

function MatrixPanel({ data, minDemand, setMinDemand, onlyOrders, setOnlyOrders }) {
  if (!data) return <div style={{ padding: 16, color: C.muted }}>Загрузка запросов…</div>;
  const { dates = [], rows = [] } = data.matrix || {};
  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>Мин. спрос</span>
          <input type="number" min={0} value={minDemand} onChange={(e) => setMinDemand(Number(e.target.value) || 0)} style={{ ...inputStyle, width: 100 }} />
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: C.ink }}>
          <input type="checkbox" checked={onlyOrders} onChange={(e) => setOnlyOrders(e.target.checked)} />
          только с заказами
        </label>
      </div>

      {rows.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 13, padding: "8px 0" }}>Нет запросов по выбранным фильтрам.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: C.bg, padding: "5px 10px", textAlign: "left", color: C.faint, fontWeight: 600, whiteSpace: "nowrap" }}>Запрос</th>
                <th style={{ padding: "5px 8px", color: C.faint, fontWeight: 600 }}>Спрос</th>
                <th style={{ padding: "5px 8px", color: C.faint, fontWeight: 600 }}>CTR</th>
                <th style={{ padding: "5px 8px", color: C.faint, fontWeight: 600 }}>Клики</th>
                <th style={{ padding: "5px 8px", color: C.faint, fontWeight: 600 }}>Заказы</th>
                {dates.map((d) => (
                  <th key={d} style={{ padding: "5px 4px", color: C.faint, fontWeight: 600, minWidth: 34 }}>{fmtShort(d)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.query}>
                  <td style={{ position: "sticky", left: 0, background: C.bg, padding: "5px 10px", color: C.ink, whiteSpace: "nowrap" }}>{r.query}</td>
                  <td style={{ padding: "5px 8px", textAlign: "center", color: C.ink }}>{num(r.search_users)}</td>
                  <td style={{ padding: "5px 8px", textAlign: "center", color: C.ink }}>{r.ctr != null ? `${r.ctr}%` : "—"}</td>
                  <td style={{ padding: "5px 8px", textAlign: "center", color: C.ink }}>{num(r.click_users)}</td>
                  <td style={{ padding: "5px 8px", textAlign: "center", color: C.ink }}>{num(r.orders)}</td>
                  {dates.map((d) => {
                    const pv = r.byDay?.[d];
                    const tone = positionTone(pv ?? null);
                    const ts = toneStyle(tone);
                    return (
                      <td key={d} style={{ padding: "5px 4px", textAlign: "center", background: ts.background, color: ts.color, borderRadius: 3 }}>
                        {pv != null ? pv : ""}
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

function Centered({ children }) {
  return (
    <div style={{ minHeight: "40vh", display: "grid", placeItems: "center", color: C.muted, background: C.bg, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
}

function Th({ children, align }) {
  return <th style={{ padding: "10px", textAlign: align || "center", color: C.faint, fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{children}</th>;
}
