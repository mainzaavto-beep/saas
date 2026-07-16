"use client";
import { C } from "@/lib/palette.js";

// /cabinets/[id]/orders — журнал заказов «как в Mpassistant» (22 колонки).
// Полный перенос эталона data-presenter/app/products/orders/page.jsx с
// адаптацией: локальная палитра SAAS, проп cabinetId, fetch на SAAS API.
import { useEffect, useMemo, useState } from "react";

// Палитра SAAS (тёмно-синяя), согласована с globals.css.


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const dt = (v) => {
  if (!v || v.startsWith("0001")) return "";
  return v.replace("T", " ").slice(0, 16);
};

const STATUS_COLORS = {
  delivered:  C.pos,
  delivering: C.muted,
  cancelled:  C.faint,
  return:     C.neg,
};

export default function OrdersPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [mp, setMp] = useState("all");        // all | wb | ozon
  const [status, setStatus] = useState("all"); // all | delivered | delivering | cancelled | return
  const [q, setQ] = useState("");
  // Фильтры: период, бренд, группа товаров, № заказа, магазин, № поставки.
  const [brand, setBrand] = useState("__all__");
  const [group, setGroup] = useState("__all__");
  const [shop, setShop] = useState("__all__");
  const [orderNum, setOrderNum] = useState("");
  const [postingId, setPostingId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/orders?limit=1000`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  }, [cabinetId]);

  // Фасеты: уникальные значения для дропдаунов brand / subject / shop, считаются
  // из исходной выборки data.items (до фильтрации), чтобы опции не «прыгали».
  const facets = useMemo(() => {
    const f = { brand: new Map(), subject: new Map(), shop: new Map() };
    for (const i of data?.items || []) {
      if (i.brand)    f.brand.set(i.brand, (f.brand.get(i.brand) || 0) + 1);
      if (i.subject)  f.subject.set(i.subject, (f.subject.get(i.subject) || 0) + 1);
      if (i.shop)     f.shop.set(i.shop, (f.shop.get(i.shop) || 0) + 1);
    }
    const toArr = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return {
      brand:   toArr(f.brand),
      subject: toArr(f.subject),
      shop:    toArr(f.shop),
    };
  }, [data]);

  const filtered = useMemo(() => {
    if (!data?.items) return [];
    let arr = data.items;
    if (mp !== "all") arr = arr.filter((i) => i.platform === mp);
    if (status !== "all") arr = arr.filter((i) => i.statusGroup === status);
    if (brand !== "__all__") arr = arr.filter((i) => i.brand === brand);
    if (group !== "__all__") arr = arr.filter((i) => i.subject === group);
    if (shop !== "__all__") arr = arr.filter((i) => i.shop === shop);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      arr = arr.filter((i) =>
        String(i.sa || "").toLowerCase().includes(s) ||
        String(i.nm || "").includes(s) ||
        String(i.name || "").toLowerCase().includes(s) ||
        String(i.brand || "").toLowerCase().includes(s)
      );
    }
    if (orderNum.trim()) {
      const s = orderNum.trim().toLowerCase();
      arr = arr.filter((i) => String(i.number || "").toLowerCase().includes(s));
    }
    if (postingId.trim()) {
      const s = postingId.trim().toLowerCase();
      arr = arr.filter((i) => String(i.posting_id || "").toLowerCase().includes(s));
    }
    // Период по дате заказа (от/до включительно).
    if (dateFrom) arr = arr.filter((i) => (i.order_dt || "") >= dateFrom);
    if (dateTo)   arr = arr.filter((i) => (i.order_dt || "") <= dateTo + "T23:59:59");
    return arr;
  }, [data, mp, status, q, brand, group, shop, orderNum, postingId, dateFrom, dateTo]);

  const hasActiveFilters = mp !== "all" || status !== "all" || q.trim() ||
    brand !== "__all__" || group !== "__all__" || shop !== "__all__" ||
    orderNum.trim() || postingId.trim() || dateFrom || dateTo;

  const resetFilters = () => {
    setMp("all"); setStatus("all"); setQ("");
    setBrand("__all__"); setGroup("__all__"); setShop("__all__");
    setOrderNum(""); setPostingId(""); setDateFrom(""); setDateTo("");
  };

  // Тоталы по отфильтрованной выборке (для строки «Итого»).
  const t = useMemo(() => {
    const acc = { qty: 0, cost: 0, orderTotal: 0, saleTotal: 0, commission: 0, acquiring: 0, logistics: 0, loyalty: 0, profit: 0 };
    for (const i of filtered) {
      acc.qty += i.qty || 0;
      acc.cost += i.cost || 0;
      acc.orderTotal += i.order_total || 0;
      acc.saleTotal += i.sale_total || 0;
      acc.commission += i.commission || 0;
      acc.acquiring += i.acquiring || 0;
      acc.logistics += i.logistics || 0;
      acc.loyalty += i.loyalty || 0;
      acc.profit += i.profit || 0;
    }
    return acc;
  }, [filtered]);

  if (error) return <Centered>Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка данных…</Centered>;

  return (
    <main style={{ width: "100%", margin: 0, padding: "20px 18px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Заказы</h1>
        <p style={{ margin: "3px 0 0", color: C.muted, fontSize: 13 }}>
          Журнал заказов WB + Ozon. {filtered.length} из {data.items.length}. Включая заказанные, но ещё не выкупленные («Доставляется»). Логистика/комиссия появляются по факту списания (для «в пути» = 0).
        </p>
      </div>

      {/* Фильтры — ряд 1: МП / статус / поиск */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
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
            { v: "all", l: "Все" },
            { v: "delivered", l: "Доставлены" },
            { v: "delivering", l: "В пути" },
            { v: "cancelled", l: "Отменены" },
            { v: "return", l: "Возвраты" },
          ].map((o) => (
            <SegBtn key={o.v} active={status === o.v} onClick={() => setStatus(o.v)}>{o.l}</SegBtn>
          ))}
        </Seg>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск: артикул, имя, бренд…"
          style={{ flex: 1, minWidth: 220, padding: "8px 12px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13 }}
        />
      </div>

      {/* Фильтры — ряд 2: период / бренд / группа / магазин / № заказа / № поставки + Сбросить */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <Field label="Период">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...inputStyle }} />
          <span style={{ color: C.faint, fontSize: 12 }}>—</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...inputStyle }} />
        </Field>
        <Field label="Бренд">
          <select value={brand} onChange={(e) => setBrand(e.target.value)} style={selectStyle}>
            <option value="__all__">Все ({data.items.length})</option>
            {facets.brand.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
        <Field label="Группа товаров">
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.subject.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
        <Field label="Магазин">
          <select value={shop} onChange={(e) => setShop(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.shop.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
        <Field label="№ заказа">
          <input value={orderNum} onChange={(e) => setOrderNum(e.target.value)} placeholder="напр. 11512178" style={{ ...inputStyle, minWidth: 140 }} />
        </Field>
        <Field label="№ поставки">
          <input value={postingId} onChange={(e) => setPostingId(e.target.value)} placeholder="напр. 1234567890" style={{ ...inputStyle, minWidth: 140 }} />
        </Field>
        {hasActiveFilters && (
          <button onClick={resetFilters} style={resetBtnStyle}>Сбросить</button>
        )}
      </div>

      {/* Таблица */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 2100 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt }}>
              {COLS.map((c) => (
                <th key={c.key} style={{ ...thStyle, textAlign: c.align === "left" ? "left" : "right", minWidth: c.minW }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((it) => (
              <tr key={it.platform + "-" + it.number} style={{ borderTop: `1px solid ${C.line}` }}>
                <Td mono title={it.number}>
                  <span style={{ display: "inline-block", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "middle" }}>
                    {it.number}
                  </span>
                </Td>
                <Td left>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 260 }}>
                    <Thumb url={it.im_url} />
                    <div style={{ lineHeight: 1.25, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.sa || "—"}</div>
                      <div style={{ fontSize: 11, color: C.muted }}>
                        {it.brand ? it.brand + " · " : ""}{it.subject ? it.subject + " · " : ""}
                        {mp === "all" && <span style={{ color: it.platform === "wb" ? C.accent : C.pink, fontWeight: 700 }}>{it.platform.toUpperCase()}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: C.faint }}>арт. МП: {it.nm || "—"}</div>
                    </div>
                  </div>
                </Td>
                <Td>{it.size || ""}</Td>
                <Td><StatusBadge group={it.statusGroup} label={it.statusLabel} /></Td>
                <Td mono>{dt(it.order_dt)}</Td>
                <Td mono>{dt(it.sale_dt)}</Td>
                <Td mono>{dt(it.cancel_dt)}</Td>
                <Td mono>{dt(it.return_dt)}</Td>
                <Td right>{num(it.qty)}</Td>
                <Td right>{money(it.cost)}</Td>
                <Td right>{money(it.order_total)}</Td>
                <Td right>{money(it.sale_total)}</Td>
                <Td right>{money(it.commission)}</Td>
                <Td right>{money(it.acquiring)}</Td>
                <Td right>{money(it.logistics)}</Td>
                <Td right>{money(it.loyalty)}</Td>
                <Td right>
                  <span style={{ color: (it.profit || 0) >= 0 ? C.pos : C.neg, fontWeight: 700 }}>{money(it.profit)}</span>
                </Td>
                <Td mono>{it.posting_id || ""}</Td>
                <Td>
                  <span style={{ color: it.platform === "wb" ? C.accent : C.pink, fontWeight: 700 }}>
                    {it.platform === "wb" ? "WB" : "OZ"}
                  </span>
                </Td>
                <Td>{it.shop || ""}</Td>
                <Td>{it.warehouse || ""}</Td>
                <Td>{it.destination || ""}</Td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={COLS.length} style={{ padding: 20, textAlign: "center", color: C.muted }}>Ничего не найдено</td>
              </tr>
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                <td style={tdFootL}>Итого ({filtered.length})</td>
                <td style={tdFootL}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{num(t.qty)}</td>
                <td style={tdFootR}>{money(t.cost)}</td>
                <td style={tdFootR}>{money(t.orderTotal)}</td>
                <td style={{ ...tdFootR, fontWeight: 800 }}>{money(t.saleTotal)}</td>
                <td style={tdFootR}>{money(t.commission)}</td>
                <td style={tdFootR}>{money(t.acquiring)}</td>
                <td style={tdFootR}>{money(t.logistics)}</td>
                <td style={tdFootR}>{money(t.loyalty)}</td>
                <td style={{ ...tdFootR, fontWeight: 800, color: t.profit >= 0 ? C.pos : C.neg }}>{money(t.profit)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </main>
  );
}

const COLS = [
  { key: "number",       label: "№ заказа",       align: "left", minW: 150 },
  { key: "product",      label: "Товар",          align: "left", minW: 280 },
  { key: "size",         label: "Размер",                       minW: 60 },
  { key: "status",       label: "Статус",                       minW: 110 },
  { key: "order_dt",     label: "Дата заказа",    align: "left", minW: 130 },
  { key: "sale_dt",      label: "Дата продажи",   align: "left", minW: 130 },
  { key: "cancel_dt",    label: "Дата отмены",    align: "left", minW: 130 },
  { key: "return_dt",    label: "Дата возврата",  align: "left", minW: 130 },
  { key: "qty",          label: "Кол-во, шт." },
  { key: "cost",         label: "Себест., ₽" },
  { key: "order_total",  label: "Стоимость, ₽" },
  { key: "sale_total",   label: "Сумма прод., ₽" },
  { key: "commission",   label: "Комиссия, ₽" },
  { key: "acquiring",    label: "Эквайринг, ₽" },
  { key: "logistics",    label: "Логистика, ₽" },
  { key: "loyalty",      label: "Лояльность, ₽" },
  { key: "profit",       label: "Прибыль, ₽" },
  { key: "posting_id",   label: "№ поставки",     align: "left", minW: 110 },
  { key: "platform",     label: "МП",             align: "left", minW: 50 },
  { key: "shop",         label: "Магазин",        align: "left", minW: 110 },
  { key: "warehouse",    label: "Склад отправки", align: "left", minW: 130 },
  { key: "destination",  label: "Куда (доставка)", align: "left", minW: 150 },
];

const thStyle = {
  padding: "10px 10px", fontSize: 11, color: C.muted, textTransform: "uppercase",
  fontWeight: 600, whiteSpace: "nowrap",
};
function Td({ children, right, left, mono, title, style }) {
  return (
    <td style={{
      padding: "8px 10px", fontSize: 12.5, whiteSpace: "nowrap",
      textAlign: right ? "right" : left ? "left" : "center",
      fontVariantNumeric: (right || mono) ? "tabular-nums" : "normal",
      fontFamily: mono ? "ui-monospace, Consolas, monospace" : "inherit",
      ...style,
    }} title={title}>{children}</td>
  );
}
const tdFootL = { padding: "10px", fontSize: 12.5, fontWeight: 800, color: C.ink, textAlign: "left", whiteSpace: "nowrap" };
const tdFootR = { padding: "10px", fontSize: 12.5, color: C.ink, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

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

function StatusBadge({ group, label }) {
  const color = STATUS_COLORS[group] || C.muted;
  return (
    <span style={{
      padding: "3px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700,
      color, border: `1px solid ${color}55`, background: `${color}18`, whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function Seg({ children }) {
  return <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>{children}</div>;
}
function SegBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none",
      background: active ? C.accent : C.surfaceAlt, color: active ? "#0b1220" : C.ink,
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
  alignSelf: "flex-end",
};

function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
