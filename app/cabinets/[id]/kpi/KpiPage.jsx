"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { applyLayout } from "@/lib/kpiDashboard.js";
import { defaultPeriod } from "@/lib/period.js";
import KpiTile, { fmt } from "./KpiTile";
import MultiSelect from "./MultiSelect";
import WidgetSettings from "./WidgetSettings";

// /cabinets/[id]/kpi — «Дашборд показателей» (15.10.2026). Плитки — GET /api/cabinets/[id]/kpi
// (канон: lib/kpiDashboard.js + lib/kpiDashboardData.js). Фильтры живут в URL (ссылкой можно
// поделиться); набор и порядок плиток — личный (POST save_layout).
const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const PARAMS = ["from", "to", "shops", "brands", "cats", "skus"];
const ddmm = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");

function readUrl() {
  const sp = new URLSearchParams(window.location.search);
  const list = (k) => (sp.get(k) || "").split(",").filter(Boolean);
  const def = defaultPeriod(7); // 7 полных дней по вчера — тот же дефолт, что parseKpiQuery
  return { from: sp.get("from") || def.from, to: sp.get("to") || def.to, shops: list("shops"), brands: list("brands"), cats: list("cats"), skus: list("skus") };
}
function toQuery(f) {
  const sp = new URLSearchParams();
  for (const k of PARAMS) {
    const v = Array.isArray(f[k]) ? f[k].join(",") : f[k];
    if (v) sp.set(k, v);
  }
  return sp.toString();
}

export default function KpiPage({ cabinetId }) {
  const [f, setF] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);
  const [settings, setSettings] = useState(false);
  const [layout, setLayout] = useState(null);

  useEffect(() => { setF(readUrl()); }, []);

  useEffect(() => {
    if (!f) return;
    const qs = toQuery(f);
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    const ac = new AbortController();
    setLoading(true);
    setErr("");
    fetch(`/api/cabinets/${cabinetId}/kpi?${qs}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
        setLayout(d.layout);
      })
      .catch((e) => {
        if (e.name === "AbortError") return; // запрос отменён более свежим фильтром — не ошибка
        console.error("kpi load:", e);
        setErr(String(e.message || e));
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [f, cabinetId]);

  const tiles = useMemo(() => (data && layout ? applyLayout(data.tiles, layout) : []), [data, layout]);
  const titles = useMemo(() => Object.fromEntries((data?.tiles || []).map((t) => [t.key, t.title])), [data]);
  const opt = data?.options || { shops: [], brands: [], cats: [], skus: [] };
  const set = useCallback((k, v) => setF((x) => ({ ...x, [k]: v })), []);

  const postLayout = async (body) => {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/kpi`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setLayout(d.layout);
      setSettings(false);
    } catch (e) {
      console.error("kpi layout:", e);
      alert(`Не удалось сохранить настройку: ${e.message || e}`);
    }
  };

  const inputStyle = { padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
  return (
    <div style={{ padding: 16, fontFamily: FONT, color: C.ink, maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>Дашборд показателей</h1>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        {f && (
          <>
            <input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} style={inputStyle} />
            <span style={{ color: C.muted }}>—</span>
            <input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} style={inputStyle} />
            <MultiSelect label="Магазины" value={f.shops} onChange={(v) => set("shops", v)}
              title="Данные хранятся по площадке: несколько юрлиц одной площадки не различаются"
              options={opt.shops.map((s) => ({ value: String(s.id), label: s.name, sub: s.platform === "wb" ? "WB" : "Ozon" }))} />
            <MultiSelect label="Бренды" value={f.brands} onChange={(v) => set("brands", v)} options={opt.brands.map((b) => ({ value: b, label: b }))} />
            <MultiSelect label="Категории" value={f.cats} onChange={(v) => set("cats", v)} options={opt.cats.map((c) => ({ value: c, label: c }))} />
            <MultiSelect label="Артикулы" value={f.skus} onChange={(v) => set("skus", v)}
              options={opt.skus.map((s) => ({ value: s.key, label: s.name, sub: `${s.platform === "wb" ? "WB" : "Ozon"} ${s.article || ""}` }))} />
          </>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setSettings(true)} disabled={!data} style={{ ...inputStyle, cursor: "pointer" }}>⚙ Настройка виджетов</button>
      </div>

      {data && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
          Сравнение с {ddmm(data.prevPeriod.from)} — {ddmm(data.prevPeriod.to)}.
          {data.productFilter && " Фильтр по товарам: расходы кабинета (хранение, штрафы, удержания и т.п.) не делятся по товарам и не показываются; прибыль — сумма прибыли выбранных товаров."}
          {data.errors.length > 0 && <span style={{ color: C.neg }}> Часть данных не загрузилась — см. плитки «ошибка загрузки».</span>}
        </div>
      )}
      {err && <div style={{ color: C.neg, marginBottom: 10 }}>Ошибка: {err}</div>}
      {loading && !data && <div style={{ color: C.muted }}>Загрузка…</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, opacity: loading ? 0.6 : 1 }}>
        {tiles.map((t) => <KpiTile key={t.key} tile={t} onOpen={setOpen} />)}
      </div>

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, background: soft("ink", 40), zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, width: 420, maxWidth: "100%" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <b>{open.title}</b>
              <button onClick={() => setOpen(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18 }}>✕</button>
            </div>
            {open.breakdown.map((b, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
                <span>{b.label}</span><b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(b.value, b.unit)}</b>
              </div>
            ))}
          </div>
        </div>
      )}

      {settings && data && (
        <WidgetSettings titles={titles} catalog={data.catalog} layout={layout}
          onSave={(l) => postLayout({ action: "save_layout", layout: l })}
          onReset={() => postLayout({ action: "reset_layout" })}
          onClose={() => setSettings(false)} />
      )}
    </div>
  );
}
