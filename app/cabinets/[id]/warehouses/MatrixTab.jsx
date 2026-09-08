"use client";
// app/cabinets/[id]/warehouses/MatrixTab.jsx — вкладка «Матрица» витрины «Склады 2.0»
// (задача 5 плана, этап 4). Один запрос GET ?tab=matrix отдаёт signals+settings+matrix —
// signals прокидываем наверх через onSignals (полоса сигналов над вкладками рисуется в
// WarehousesPage.jsx). Контракт колонок/ячеек — из бэкенда задачи 3 (lib/warehousesMetrics.js
// buildMatrix): columns[] = места (kind:'ff') + FBO-склады (kind:'fbo'), rows[].cells[colKey]
// может отсутствовать вовсе (пусто — «нет пересечения»), ФФ-ячейка хранит свой остаток и
// снимки МП по обеим площадкам (present/delta), FBO-ячейка — остаток+в пути на площадке.
//
// useSort/cmpVal — общий хук lib/useSort.js (вынесен из stocks/StocksPage.jsx, чтобы не
// плодить третью копию). SortTh — копия локального компонента из StocksPage.jsx:82-100
// (кликабельный <th> со стрелкой ▲/▼/‖), под местные thLeft/thR этой страницы.
import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { C, soft } from "@/lib/palette.js";
import { useSort } from "@/lib/useSort.js";

const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const fmtDelta = (d) => (d == null ? "—" : d > 0 ? `+${d}` : String(d));
const fmtCoverage = (c) => (c == null ? "—" : `${Math.round(c)} дн`);

const thLeft = { padding: "8px 10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left", whiteSpace: "nowrap" };
const thR = { ...thLeft, textAlign: "right" };
const tdBase = { padding: "8px 10px", fontSize: 12, borderBottom: `1px solid ${soft("line", 20)}`, verticalAlign: "top" };

// Копия локального компонента StocksPage.jsx:82-100 — кликабельный <th> со стрелкой.
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

function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", border: `1px solid ${C.line}`, borderRadius: 7, overflow: "hidden" }}>
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{ padding: "5px 10px", fontSize: 12, border: "none", cursor: "pointer", background: value === o.v ? C.accent : "transparent", color: value === o.v ? "var(--accentInk)" : C.ink }}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

// Ячейка ФФ-места: «свой N», «WB N (Δ ±k)» / «Ozon …» (только выбранные фильтром площадки;
// mp[p] === null — площадка не привязана или у товара нет её артикула → «—»; mp[p].present
// === null — привязана, но снимка МП по складу ещё нет → «нет данных»), «покрытие N дн».
function FfCell({ cell, platform }) {
  const platforms = platform === "all" ? ["wb", "ozon"] : [platform];
  const bg = cell.flags?.low ? soft("neg", 25) : cell.flags?.delta ? soft("warn", 25) : "transparent";
  return (
    <div style={{ background: bg, borderRadius: 6, padding: "3px 6px", display: "inline-block", textAlign: "left", minWidth: 118 }}>
      <div>свой {num(cell.own)}</div>
      {platforms.map((p) => {
        const label = p === "wb" ? "WB" : "Ozon";
        const mp = cell.mp?.[p];
        if (mp == null) return <div key={p} style={{ color: C.faint }}>{label} —</div>;
        if (mp.present == null) return <div key={p} style={{ color: C.faint }}>{label} нет данных</div>;
        return <div key={p}>{label} {num(mp.present)} (Δ {fmtDelta(mp.delta)})</div>;
      })}
      <div style={{ color: C.muted }}>покрытие {fmtCoverage(cell.coverage)}</div>
    </div>
  );
}

// Ячейка FBO-склада: «N (+в пути M)», «покрытие N дн».
function FboCell({ cell }) {
  const bg = cell.low ? soft("neg", 25) : "transparent";
  return (
    <div style={{ background: bg, borderRadius: 6, padding: "3px 6px", display: "inline-block", textAlign: "left", minWidth: 118 }}>
      <div>{num(cell.stock)} (+в пути {num(cell.inTransit)})</div>
      <div style={{ color: C.muted }}>покрытие {fmtCoverage(cell.coverage)}</div>
    </div>
  );
}

function Cell({ col, cell, platform }) {
  if (!cell) return <span style={{ color: C.faint }}>·</span>;
  return col.kind === "ff" ? <FfCell cell={cell} platform={platform} /> : <FboCell cell={cell} />;
}

export function MatrixTab({ cabinetId, onSignals }) {
  const sp = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState("all"); // all | wb | ozon
  const [onlyProblems, setOnlyProblems] = useState(sp.get("problems") === "1");
  const [q, setQ] = useState("");
  const { sort, toggle, apply } = useSort(null); // null — держим порядок бэкенда (проблемные сверху), пока не кликнули заголовок

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/warehouses?tab=matrix`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) { setError(d.error); return; }
        setData(d);
        onSignals?.(d.signals);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSignals — сеттер из useState родителя, стабилен
  }, [cabinetId]);

  const allColumns = data?.matrix?.columns || [];
  const allRows = data?.matrix?.rows || [];
  // Подсказка «привяжите места» — не по наличию ФФ-колонок самих по себе (место может
  // быть заведено, но ни у одной позиции нет в нём данных), а по тому, есть ли хоть у
  // одной строки хоть одна ФФ-ячейка (решение контроллера, ревью раунд 1).
  const ffColumnKeys = useMemo(() => allColumns.filter((c) => c.kind === "ff").map((c) => c.key), [allColumns]);
  const hasFfData = useMemo(
    () => allRows.some((r) => ffColumnKeys.some((k) => r.cells?.[k])),
    [allRows, ffColumnKeys]
  );

  const columns = useMemo(
    () => allColumns.filter((c) => c.kind === "ff" || platform === "all" || c.platform === platform),
    [allColumns, platform]
  );

  const rowsFiltered = useMemo(() => {
    let rows = allRows;
    if (onlyProblems) rows = rows.filter((r) => r.problem);
    const s = q.trim().toLowerCase();
    if (s) {
      // Поиск по ВСЕМ артикулам компоненты (skuKeys), а не только по минимальной паре skus:
      // строка склеивает партии с разным набором артикулов, и поиск по «второму» nm_id/
      // product_id иначе ничего не находил, хотя товар в матрице есть.
      rows = rows.filter((r) =>
        String(r.name || "").toLowerCase().includes(s)
        || (r.skuKeys?.wb || []).some((k) => String(k).includes(s))
        || (r.skuKeys?.ozon || []).some((k) => String(k).includes(s))
      );
    }
    return rows;
  }, [allRows, onlyProblems, q]);

  const sortSpec = useMemo(() => {
    const spec = {
      name: (r) => r.name,
      own: (r) => r.totals?.own,
      mp: (r) => r.totals?.mp,
      fbo: (r) => r.totals?.fbo,
      gapsQty: (r) => r.totals?.gapsQty,
    };
    for (const col of columns) spec[col.key] = (r) => r.cells?.[col.key]?.coverage ?? null;
    return spec;
  }, [columns]);

  const rows = apply(rowsFiltered, sortSpec);

  if (error) return <div style={{ color: C.neg, padding: 16 }}>⚠️ Ошибка: {error}</div>;
  if (loading && !data) return <div style={{ color: C.muted, padding: 16 }}>Загрузка…</div>;
  if (!data) return null;

  // Пустая матрица (нет ни одной строки вовсе) — это НЕ «места не привязаны», а «позиций нет
  // совсем»: строки матрицы строятся из ff_inventory, привязка мест на их наличие не влияет.
  // Мягкая подсказка про привязку мест — ниже, по hasFfData.
  if (allRows.length === 0) {
    return (
      <div style={{ padding: 28, textAlign: "center", color: C.muted, border: `1px dashed ${C.line}`, borderRadius: 10 }}>
        На складе/ФФ нет позиций — добавьте их в «Остатки склад/ФФ»
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <Segmented value={platform} onChange={setPlatform} options={[{ v: "all", l: "Все" }, { v: "wb", l: "Wildberries" }, { v: "ozon", l: "Ozon" }]} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted, cursor: "pointer" }}>
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Только проблемные
        </label>
        <input
          placeholder="Поиск по названию/артикулу"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 220 }}
        />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.faint }}>{rows.length} строк, {columns.length} колонок</span>
      </div>

      {!hasFfData && (
        <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: soft("warn", 12), color: C.warn, fontSize: 12 }}>
          Позиции ФФ не привязаны к местам — привяжите их в «Остатки склад/ФФ» → 📍 Места; без этого свой учёт в матрице не виден.
        </div>
      )}

      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }}>
          <thead>
            <tr>
              <SortTh colKey="name" sort={sort} toggle={toggle} baseStyle={{ ...thLeft, position: "sticky", top: 0, left: 0, background: C.surfaceAlt, zIndex: 2, minWidth: 200 }}>
                Товар
              </SortTh>
              {columns.map((col) => (
                <SortTh key={col.key} colKey={col.key} sort={sort} toggle={toggle} baseStyle={{ ...thR, position: "sticky", top: 0, background: C.surfaceAlt, zIndex: 1, minWidth: 120 }}>
                  {col.kind === "fbo" ? `${col.platform === "wb" ? "WB" : "Ozon"} FBO · ${col.title}` : col.title}
                </SortTh>
              ))}
              <SortTh colKey="own" sort={sort} toggle={toggle} baseStyle={{ ...thR, position: "sticky", top: 0, background: C.surfaceAlt, zIndex: 1 }}>Свой</SortTh>
              <SortTh colKey="mp" sort={sort} toggle={toggle} baseStyle={{ ...thR, position: "sticky", top: 0, background: C.surfaceAlt, zIndex: 1 }}>На МП</SortTh>
              <SortTh colKey="fbo" sort={sort} toggle={toggle} baseStyle={{ ...thR, position: "sticky", top: 0, background: C.surfaceAlt, zIndex: 1 }}>FBO</SortTh>
              <SortTh colKey="gapsQty" sort={sort} toggle={toggle} baseStyle={{ ...thR, position: "sticky", top: 0, background: C.surfaceAlt, zIndex: 1 }}>Не разнесено</SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={columns.length + 5} style={{ padding: 20, textAlign: "center", color: C.muted }}>Нет строк по условиям фильтра</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.itemKey}>
                <td style={{ ...tdBase, position: "sticky", left: 0, background: C.bg, zIndex: 1, minWidth: 200 }}>
                  <div style={{ fontWeight: 600, color: C.ink }}>{r.name}</div>
                  <div style={{ fontSize: 10, color: C.faint }}>
                    {r.skus?.wb != null && <span>WB {r.skus.wb} </span>}
                    {r.skus?.ozon != null && <span>Ozon {r.skus.ozon}</span>}
                  </div>
                </td>
                {columns.map((col) => (
                  <td key={col.key} style={{ ...tdBase, textAlign: "right" }}>
                    <Cell col={col} cell={r.cells?.[col.key]} platform={platform} />
                  </td>
                ))}
                <td style={{ ...tdBase, textAlign: "right" }}>{num(r.totals?.own)}</td>
                <td style={{ ...tdBase, textAlign: "right" }}>{num(r.totals?.mp)}</td>
                <td style={{ ...tdBase, textAlign: "right" }}>{num(r.totals?.fbo)}</td>
                <td style={{ ...tdBase, textAlign: "right", color: (r.totals?.gapsCount || 0) > 0 ? C.neg : C.ink, fontWeight: (r.totals?.gapsCount || 0) > 0 ? 700 : 400 }}>
                  {num(r.totals?.gapsQty)} шт ({r.totals?.gapsCount || 0})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
