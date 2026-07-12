"use client";
// /cabinets/[id]/summary — Сводка по товарам (SaaS).
// Тянет /api/cabinets/[id]/products-summary. UI по образцу data-presenter.
// Клик по товару → /cabinets/[id]/detail?platform=X&nm=Y
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : v);
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : r2(v) + "%");

export default function SummaryPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mp, setMp] = useState("all");
  const [sort, setSort] = useState({ key: "salesRub", dir: "desc" });
  const [q, setQ] = useState("");
  const router = useRouter();

  useEffect(() => {
    setLoading(true);
    const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    fetch(`/api/cabinets/${cabinetId}/products-summary?from=${from}&to=${to}&platform=${mp}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [cabinetId, mp]);

  if (loading) return <div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>;
  if (error) return <div style={{ padding: 40, color: "#ff6b6b" }}>Ошибка: {error}</div>;
  if (!data) return null;

  let items = data.items || [];
  if (q) {
    const ql = q.toLowerCase();
    items = items.filter(
      (it) => (it.name || "").toLowerCase().includes(ql) || String(it.nm).includes(ql)
    );
  }
  items.sort((a, b) => {
    const va = Number(a[sort.key] || 0);
    const vb = Number(b[sort.key] || 0);
    return sort.dir === "desc" ? vb - va : va - vb;
  });

  const t = data.totals || {};
  const Th = ({ k, children, right }) => (
    <th
      style={{ textAlign: right ? "right" : "left", cursor: "pointer", whiteSpace: "nowrap" }}
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "desc" ? "asc" : "desc" }))}
    >
      {children} {sort.key === k ? (sort.dir === "desc" ? "↓" : "↑") : ""}
    </th>
  );

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 8px" }}>📦 Сводка по товарам</h2>
      <div style={{ fontSize: 13, color: "#8a99b8", marginBottom: 16 }}>
        {data.period?.from} → {data.period?.to} · {data.count} товаров
      </div>

      {/* Итоги */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        {[
          ["Выручка", money(t.salesRub), "#4ade80"],
          ["Прибыль", money(t.profit), (t.profit || 0) >= 0 ? "#4ade80" : "#f87171"],
          ["Маржа", pct(t.margin), null],
          ["Продано", num(t.sold), null],
          ["Заказано", num(t.ordered), null],
          ["ДРР", pct(t.drr), null],
          ["Реклама", money(t.adSpend), null],
        ].map(([label, val, color]) => (
          <div key={label} style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 8, padding: "10px 16px" }}>
            <div style={{ fontSize: 12, color: "#8a99b8" }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: color || "#e8edf7" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Фильтры */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
        {["all", "wb", "ozon"].map((m) => (
          <button
            key={m}
            onClick={() => setMp(m)}
            style={{
              padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
              border: "1px solid #243049",
              background: mp === m ? "#4f8cff" : "#1a2540",
              color: "#fff",
            }}
          >
            {m === "all" ? "Все" : m === "wb" ? "WB" : "Ozon"}
          </button>
        ))}
        <input
          placeholder="🔍 Поиск..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            padding: "6px 12px", background: "#1a2540", border: "1px solid #243049",
            borderRadius: 6, color: "#e8edf7", fontSize: 13, minWidth: 200,
          }}
        />
      </div>

      {/* Таблица */}
      <div style={{ overflowX: "auto", background: "#131c2e", border: "1px solid #243049", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #243049" }}>
              <Th k="name">Товар</Th>
              <th>МП</th>
              <Th k="sold" right>Прод.</Th>
              <Th k="returns" right>Возвр.</Th>
              <Th k="salesRub" right>Выручка</Th>
              <Th k="costRub" right>Себест.</Th>
              <Th k="commission" right>Комисс.</Th>
              <Th k="logistics" right>Логист.</Th>
              <Th k="adSpend" right>Реклама</Th>
              <Th k="profit" right>Прибыль</Th>
              <Th k="margin" right>Маржа</Th>
              <Th k="drr" right>ДРР</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr
                key={i}
                style={{ borderBottom: "1px solid rgba(36,48,73,0.4)", cursor: "pointer" }}
                onClick={() => router.push(`/cabinets/${cabinetId}/detail?platform=${it.platform}&nm=${it.nm}`)}
              >
                <td style={{ padding: "6px 8px", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {it.im_url && <img src={it.im_url} alt="" style={{ width: 28, height: 28, borderRadius: 4, marginRight: 6, verticalAlign: "middle", objectFit: "cover" }} />}
                  {(it.name || String(it.nm)).slice(0, 45)}
                </td>
                <td>
                  <span style={{
                    padding: "2px 6px", borderRadius: 3, fontSize: 11, fontWeight: 600,
                    background: it.platform === "wb" ? "rgba(96,165,250,0.15)" : "rgba(249,115,22,0.15)",
                    color: it.platform === "wb" ? "#60a5fa" : "#f97316",
                  }}>{(it.platform || "").toUpperCase()}</span>
                </td>
                <td style={{ textAlign: "right" }}>{num(it.sold)}</td>
                <td style={{ textAlign: "right" }}>{num(it.returns)}</td>
                <td style={{ textAlign: "right" }}>{money(it.salesRub)}</td>
                <td style={{ textAlign: "right" }}>{money(it.costRub)}</td>
                <td style={{ textAlign: "right" }}>{money(it.commission)}</td>
                <td style={{ textAlign: "right" }}>{money(it.logistics)}</td>
                <td style={{ textAlign: "right" }}>{money(it.adSpend)}</td>
                <td style={{ textAlign: "right", color: (it.profit || 0) >= 0 ? "#4ade80" : "#f87171", fontWeight: 600 }}>
                  {money(it.profit)}
                </td>
                <td style={{ textAlign: "right" }}>{pct(it.margin)}</td>
                <td style={{ textAlign: "right" }}>{pct(it.drr)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "2px solid #243049", fontWeight: 700 }}>
              <td colSpan={2}>ИТОГО</td>
              <td style={{ textAlign: "right" }}>{num(t.sold)}</td>
              <td style={{ textAlign: "right" }}>{num(t.returns)}</td>
              <td style={{ textAlign: "right" }}>{money(t.salesRub)}</td>
              <td style={{ textAlign: "right" }}>{money(t.costRub)}</td>
              <td style={{ textAlign: "right" }}>{money(t.commission)}</td>
              <td style={{ textAlign: "right" }}>{money(t.logistics)}</td>
              <td style={{ textAlign: "right" }}>{money(t.adSpend)}</td>
              <td style={{ textAlign: "right", color: (t.profit || 0) >= 0 ? "#4ade80" : "#f87171" }}>{money(t.profit)}</td>
              <td style={{ textAlign: "right" }}>{pct(t.margin)}</td>
              <td style={{ textAlign: "right" }}>{pct(t.drr)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
