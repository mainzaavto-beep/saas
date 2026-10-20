"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useState } from "react";
import { useSort } from "@/lib/useSort.js";
import BuyoutChart from "./BuyoutChart";
import CategoryMultiSelect from "../CategoryMultiSelect.jsx";

// /cabinets/[id]/buyout — «Процент выкупа» (11.10.2026, Ozon добавлен 12.10.2026). WB и
// Ozon, когортно по дате заказа: берём заказы периода и смотрим судьбу каждого
// (выкуп / невыкуп / возврат / в пути) — у WB по srid, у Ozon по отправлению (posting_number).
// % выкупа = выкуплено / (выкуплено + невыкуп + возвраты). Расчёт — lib/buyout.js,
// контракт метрик §18. Это НЕ коэффициент выкупа юнитки (там — по событиям отчёта реализации).

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : nf0.format(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : `${nf1.format(v)} %`);
const iso = (d) => d.toISOString().slice(0, 10);
const defFrom = () => iso(new Date(Date.now() - 30 * 864e5));
const defTo = () => iso(new Date(Date.now() - 864e5));

// Фильтр «Категория» (20.10.2026) — на сервере: режет заказы до расчёта, поэтому плитки и
// график тоже по выбранным категориям (поиск по товару — только таблица).
const catQuery = (cats) => [...cats].map((c) => `&cat=${encodeURIComponent(c)}`).join("");

const PLATFORMS = [{ v: "all", l: "Все" }, { v: "wb", l: "Wildberries" }, { v: "ozon", l: "Ozon" }];

const COLS = [
  { key: "ordered", label: "Заказано", tip: "все заказы периода (по дате заказа)" },
  { key: "cancelledPre", label: "Отменено до отгрузки", tip: "отменены, товар к покупателю не ехал — в % не входят" },
  { key: "resolved", label: "Доехало", tip: "выкуплено + невыкуп + возвраты" },
  { key: "sold", label: "Выкуплено" },
  { key: "refused", label: "Невыкуп", tip: "доехал до ПВЗ, покупатель отказался" },
  { key: "returned", label: "Возвраты", tip: "выкупил, потом вернул" },
  { key: "pending", label: "В пути", tip: "развязки ещё нет — в % не входят" },
  { key: "self", label: "Самовыкупы", tip: "исключены из расчёта" },
  { key: "buyoutPct", label: "% выкупа" },
];

const th = { padding: "8px 10px", fontSize: 12, color: C.muted, fontWeight: 600, textAlign: "right", whiteSpace: "nowrap", cursor: "pointer", borderBottom: `1px solid ${C.line}` };
const td = { padding: "7px 10px", fontSize: 13, textAlign: "right", whiteSpace: "nowrap", borderBottom: `1px solid ${soft("line", 40)}` };

function PctCell({ r }) {
  const faded = r.lowSample;
  return (
    <span title={faded ? `мало доехавших (${r.resolved}) — процент неустойчив` : r.immature ? `ещё в пути ${nf1.format(r.pendingShare * 100)} % — цифра изменится` : ""}
      style={{ fontWeight: 700, color: faded ? C.muted : C.ink, opacity: faded ? 0.6 : 1 }}>
      {pct(r.buyoutPct)}{r.immature ? " ⏳" : ""}
    </span>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 16px", minWidth: 150 }}>
      <div style={{ fontSize: 12, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

export default function BuyoutPage({ cabinetId }) {
  const [from, setFrom] = useState(defFrom);
  const [to, setTo] = useState(defTo);
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("all");
  const [cats, setCats] = useState(() => new Set());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [selected, setSelected] = useState(null); // { platform, nmId, name }
  const { sort, toggle, apply } = useSort("ordered", "desc");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/buyout?from=${from}&to=${to}&platform=${platform}${catQuery(cats)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { if (alive) setData(j); })
      .catch((e) => { console.error("buyout load:", e); if (alive) setError(String(e.message || e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cabinetId, from, to, platform, cats]);

  // Выбранная, но отсутствующая на площадке/в периоде категория остаётся в списке с 0 —
  // иначе её нельзя было бы снять галочкой.
  const catOptions = useMemo(() => {
    const list = data?.categories || [];
    const have = new Set(list.map(([c]) => c));
    return [...list, ...[...cats].filter((c) => !have.has(c)).map((c) => [c, 0])];
  }, [data, cats]);

  const changeCats = (upd) => {
    setCats(upd);
    setSelected(null);
    setOpen(new Set());
  };

  const rows = useMemo(() => {
    const items = data?.items || [];
    const qq = q.trim().toLowerCase();
    const f = qq ? items.filter((i) => `${i.name || ""} ${i.article || ""} ${i.nmId}`.toLowerCase().includes(qq)) : items;
    return apply(f, Object.fromEntries(COLS.map((c) => [c.key, (r) => r[c.key]])));
  }, [data, q, apply]);

  const rowKey = (it) => `${it.platform}:${it.nmId}`;

  const toggleOpen = (key) => setOpen((cur) => {
    const n = new Set(cur);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });

  const changePlatform = (v) => {
    setPlatform(v);
    setSelected(null);
    setOpen(new Set());
  };

  const kpi = data?.kpi;
  return (
    <div style={{ padding: 24, fontFamily: FONT, color: C.ink }}>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>Процент выкупа</h1>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, maxWidth: 900 }}>
        Только FBO (склады маркетплейса; FBS не учитывается). Берём заказы, сделанные в периоде, и смотрим, чем закончился каждый. % выкупа =
        выкуплено / (выкуплено + невыкуп + возвраты); заказы в пути и отменённые до отгрузки не входят,
        самовыкупы исключены. Свежие недели «дозревают» (⏳).
        Ozon: каждое отправление — выкуп (доставлено), возврат (доставлено и сторнировано), невыкуп
        (отменено с обратной логистикой) или отмена до отгрузки. Размеров у Ozon нет — каждый размер
        отдельный товар. Ozon: отмена без даты отмены считается отменой до отгрузки через 30 дней
        после заказа — свежие недели Ozon дозревают дольше.
        В юнит-экономике «% выкупа» — коэффициент модели логистики по событиям отчёта реализации
        за 30 дней, это другая величина (контракт метрик §18.4).
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ fontSize: 13 }}>Заказы с <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label style={{ fontSize: 13 }}>по <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <Segmented value={platform} options={PLATFORMS} onChange={changePlatform} />
        <CategoryMultiSelect options={catOptions} selected={cats} setSelected={changeCats}
          buttonStyle={{ padding: "6px 26px 6px 10px", background: C.surface }} />
        <input placeholder="Поиск: название, артикул, nm" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ padding: "6px 10px", border: `1px solid ${C.line}`, borderRadius: 8, background: C.surface, color: C.ink, minWidth: 240 }} />
        {loading ? <span style={{ fontSize: 13, color: C.muted }}>загрузка…</span> : null}
      </div>

      {error ? <div style={{ color: C.neg, marginBottom: 12 }}>Ошибка: {error}</div> : null}

      {kpi ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          <Tile label="% выкупа" value={<PctCell r={kpi} />} sub={kpi.immature ? "период не дозрел" : null} />
          <Tile label="Доехало до покупателя" value={num(kpi.resolved)} sub={`из ${num(kpi.ordered)} заказов`} />
          <Tile label="Невыкуп" value={num(kpi.refused)} />
          <Tile label="Возвраты" value={num(kpi.returned)} />
          <Tile label="В пути" value={num(kpi.pending)} sub={`${nf1.format(kpi.pendingShare * 100)} % открытых`} />
        </div>
      ) : null}

      <BuyoutChart cabinetId={cabinetId} platform={selected ? selected.platform : platform}
        nmId={selected?.nmId ?? null} name={selected?.name ?? null} cats={cats}
        onReset={() => setSelected(null)} />

      <div style={{ overflowX: "auto", background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", cursor: "default" }}>Товар</th>
              {COLS.map((c) => (
                <th key={c.key} style={th} title={c.tip || ""} onClick={() => toggle(c.key)}>
                  {c.label}{sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : " ↕"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => {
              const key = rowKey(it);
              const isOpen = open.has(key);
              const isSel = selected?.platform === it.platform && selected?.nmId === it.nmId;
              return [
                <tr key={key} style={{ background: isSel ? soft("accent", 10) : "transparent", cursor: "pointer" }}
                  onClick={() => setSelected(isSel ? null : { platform: it.platform, nmId: it.nmId, name: it.name || it.article })}>
                  <td style={{ ...td, textAlign: "left", whiteSpace: "normal", minWidth: 240 }}>
                    {it.sizes.length ? (
                      <span onClick={(e) => { e.stopPropagation(); toggleOpen(key); }}
                        style={{ display: "inline-block", width: 18, color: C.muted }}>{isOpen ? "▾" : "▸"}</span>
                    ) : <span style={{ display: "inline-block", width: 18 }} />}
                    <b>{it.name || "—"}</b>
                    <div style={{ fontSize: 12, color: C.muted, marginLeft: 18 }}>
                      <span style={{ fontWeight: 600, color: C.accent }}>{it.platform === "ozon" ? "Ozon" : "WB"}</span>
                      {" "}· {it.article || ""} · {it.nmId}{it.category ? ` · ${it.category}` : ""}
                    </div>
                  </td>
                  {COLS.map((c) => (
                    <td key={c.key} style={td}>{c.key === "buyoutPct" ? <PctCell r={it} /> : num(it[c.key])}</td>
                  ))}
                </tr>,
                ...(isOpen ? it.sizes.map((s) => (
                  <tr key={`${key}|${s.size}`} style={{ background: soft("line", 10) }}>
                    <td style={{ ...td, textAlign: "left", paddingLeft: 38, color: C.muted }}>размер <b style={{ color: C.ink }}>{s.size}</b></td>
                    {COLS.map((c) => (
                      <td key={c.key} style={td}>{c.key === "buyoutPct" ? <PctCell r={s} /> : num(s[c.key])}</td>
                    ))}
                  </tr>
                )) : []),
              ];
            })}
            {!rows.length && !loading ? (
              <tr><td colSpan={COLS.length + 1} style={{ ...td, textAlign: "center", color: C.muted }}>{cats.size ? "Нет заказов за период в выбранных категориях" : "Нет заказов за период"}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
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
