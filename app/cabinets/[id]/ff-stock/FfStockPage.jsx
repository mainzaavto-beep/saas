"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  accent2: "#2bd4a0", pos: "#4ade80", neg: "#ff6b6b", pink: "#f97316",
  blue: "#4f8cff",
};

// =====================================================================
//  /items/ff-stock — ОСТАТКИ НА СКЛАДЕ/ФФ (заявка 2026-06-25 (5)).
//
//  Ручной учёт товара на собственном складе и фулфилменте. Хранится
//  снапшотами по датам (как баланс): можно посмотреть остаток на прошлую дату.
//
//  Источник: GET /api/cabinets/${cabinetId}/ff-stock?date=  (stock_ff_snapshots + balances +
//    locations + товары каталога + totals).
//  Запись: POST /api/ff-stock {as_of_date, balances:[...]} — replace на дату.
//  Каталог мест: GET/POST ?action=locations — add/rename/archive.
//
//  Колонки таблицы: Товар (фото + имя из справочника + кол-во SKU) · Место ·
//    Количество (inline) · Себест. (inline) · Сумма (= qty×cost, read-only).
//  Себестоимость: при пустом поле подтягивается из resolveCostMap (override >
//    cogs). Можно править в строке — фиксируется как снапшот на дату.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const num = (v) =>
  v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const today = () => new Date().toISOString().slice(0, 10);

export default function FfStockPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(today());
  const [dirty, setDirty] = useState(false); // есть ли несохранённые правки
  const [saving, setSaving] = useState(false);
  // Редактируемая копия balances (рабочий буфер до «Сохранить»).
  const [draft, setDraft] = useState([]);
  // Каталог мест (editable).
  const [locations, setLocations] = useState([]);

  const reload = useCallback((keepDraft = false) => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    if (date) p.set("date", date);
    fetch(`/api/cabinets/${cabinetId}/ff-stock?` + p.toString())
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        setLocations(d.locations || []);
        if (!keepDraft) {
          setDraft(d.balances || []);
          setDirty(false);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [date]);

  useEffect(() => { reload(false); }, [reload]);

  // Рабочее представление: balances по (товар × место) — draft + пустые клетки.
  // Структура: rows = [{catalog_id, catalog_name, im_url, sku_count, byLoc: {locId: {qty, unit_cost, id?}}}].
  const grid = useMemo(() => {
    if (!data) return [];
    const products = data.products || [];
    const locs = locations.length ? locations : data.locations || [];
    // Индекс по catalog_id.
    const byCat = {};
    for (const b of draft) {
      if (!byCat[b.catalog_id]) {
        byCat[b.catalog_id] = { catalog_id: b.catalog_id, catalog_name: b.catalog_name, im_url: b.im_url, sku_count: b.sku_count, byLoc: {} };
      }
      byCat[b.catalog_id].byLoc[b.location_id] = {
        id: b.id,
        qty: b.qty,
        unit_cost: b.unit_cost,
        value: b.value,
      };
    }
    // Дополняем товарами каталога, для которых нет строк (чтобы добавить).
    const rows = [];
    for (const p of products) {
      const exist = byCat[p.id];
      if (exist) {
        rows.push({ ...exist, catalog_name: exist.catalog_name || p.internal_name });
      } else {
        rows.push({ catalog_id: p.id, catalog_name: p.internal_name, im_url: null, sku_count: 0, byLoc: {} });
      }
    }
    // Убираем строки, чьего товара уже нет в каталоге (orphan) — показываем отдельно.
    for (const k of Object.keys(byCat)) {
      if (!products.find((p) => p.id === Number(k))) {
        rows.push(byCat[k]);
      }
    }
    return rows;
  }, [data, draft, locations]);

  // Итоги по draft.
  const totals = useMemo(() => {
    const t = { rows: 0, qty: 0, value: 0, byLoc: {} };
    for (const b of draft) {
      const qty = Number(b.qty) || 0;
      const cost = Number(b.unit_cost) || 0;
      const value = round2(qty * cost);
      if (qty === 0 && cost === 0) continue;
      t.rows += 1;
      t.qty = round2(t.qty + qty);
      t.value = round2(t.value + value);
      if (!t.byLoc[b.location_id]) t.byLoc[b.location_id] = { qty: 0, value: 0 };
      t.byLoc[b.location_id].qty = round2(t.byLoc[b.location_id].qty + qty);
      t.byLoc[b.location_id].value = round2(t.byLoc[b.location_id].value + value);
    }
    return t;
  }, [draft]);

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (loading && !data) return <Centered>Загрузка…</Centered>;
  if (!data) return <Centered>Нет данных</Centered>;

  const snapshotDate = data.snapshot?.as_of_date || null;
  const locs = locations.length ? locations : data.locations || [];

  // --- Правки draft (inline editing) ---
  function patchCell(catalogId, locId, field, value) {
    setDirty(true);
    setDraft((prev) => {
      const next = [...prev];
      const idx = next.findIndex((b) => b.catalog_id === catalogId && b.location_id === locId);
      if (idx >= 0) {
        next[idx] = { ...next[idx], [field]: value };
      } else {
        // Создаём новую строку при первом вводе.
        const cat = (data.products || []).find((p) => p.id === catalogId);
        next.push({
          catalog_id: catalogId,
          location_id: locId,
          catalog_name: cat?.internal_name || null,
          qty: field === "qty" ? value : 0,
          unit_cost: field === "unit_cost" ? value : null,
        });
      }
      return next;
    });
  }

  // Удалить строку (товар × место) из draft.
  function removeRow(catalogId, locId) {
    setDirty(true);
    setDraft((prev) => prev.filter((b) => !(b.catalog_id === catalogId && b.location_id === locId)));
  }

  // --- Сохранить снапшот на дату ---
  async function save() {
    if (!ISO_DATE(date)) { alert("Укажите дату YYYY-MM-DD"); return; }
    // Фильтруем пустые (qty=0 и cost=0/null).
    const balances = draft
      .filter((b) => Number(b.qty) !== 0 || Number(b.unit_cost) !== 0)
      .map((b) => ({
        catalog_id: b.catalog_id,
        location_id: b.location_id,
        qty: Number(b.qty) || 0,
        unit_cost: b.unit_cost === "" || b.unit_cost == null ? null : Number(b.unit_cost),
      }));
    setSaving(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/ff-stock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ as_of_date: date, balances }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "save failed");
      setDirty(false);
      await reload(false);
    } catch (e) {
      alert("Не сохранилось: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  // --- CRUD каталога мест ---
  async function addLocation(name) {
    const r = await fetch(`/api/cabinets/${cabinetId}/ff-stock?action=locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "add", name }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не добавить: " + (d.error || "")); return; }
    setLocations((prev) => [...prev, d.location].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
  }
  async function renameLocation(id, name) {
    const r = await fetch(`/api/cabinets/${cabinetId}/ff-stock?action=locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "rename", id, name }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не переименовать: " + (d.error || "")); return; }
    setLocations((prev) => prev.map((l) => (l.id === id ? { ...l, name: d.location.name } : l)));
  }
  async function archiveLocation(id) {
    if (!confirm("Убрать место? История прошлых снапшотов не пострадает.")) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/ff-stock?action=locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "archive", id }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не убрать: " + (d.error || "")); return; }
    setLocations((prev) => prev.filter((l) => l.id !== id));
  }

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1600, margin: "0 auto" }}>
      <Header />

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Строк остатков" value={num(totals.rows)} />
        <Kpi label="Остаток (шт.)" value={num(totals.qty)} accent />
        <Kpi label="Сумма (себест.)" value={money(totals.value)} accent />
        <Kpi label="Мест хранения" value={num(locs.length)} />
        <Kpi label="Товаров в каталоге" value={num((data.products || []).length)} />
      </div>

      {/* Плашка */}
      <div style={{ ...alertStyle, marginBottom: 14 }}>
        <strong>Что это:</strong> остатки на собственном складе и фулфилменте (НЕ на МП —
        те в отдельной вкладке). Товар берётся из «Справочника товаров». Себестоимость
        подтягивается из справочника себестоимости (override &gt; cogs), но фиксируется как
        снапшот на дату — можно править. <strong>Сумма = кол-во × себест.</strong> Хранится
        по датам: переключите дату, чтобы посмотреть остаток на прошлый день.
      </div>

      {/* Управление датой + сохранение */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <Field label="Дата снапшота">
          <input
            type="date"
            value={date}
            onChange={(e) => { if (dirty && !confirm("Есть несохранённые правки. Сменить дату и потерять их?")) return; setDate(e.target.value); }}
            style={{ ...inputStyle, width: 160 }}
          />
        </Field>
        {snapshotDate && snapshotDate !== date && (
          <span style={{ fontSize: 12, color: C.faint }}>
            показан ближайший снапшот: <strong style={{ color: C.accent }}>{snapshotDate}</strong>
          </span>
        )}
        {snapshotDate == null && (
          <span style={{ fontSize: 12, color: C.faint }}>снапшотов на эту дату и раньше нет — будет новый</span>
        )}
        <div style={{ flex: 1 }} />
        {dirty && <span style={{ fontSize: 12, color: "#ffcc33" }}>● есть правки</span>}
        <button onClick={save} disabled={saving || !ISO_DATE(date)} style={primaryBtn}>
          {saving ? "⏳ Сохранение…" : "💾 Сохранить снапшот"}
        </button>
      </div>

      {/* Каталог мест хранения */}
      <LocationsBar
        locations={locs}
        onAdd={addLocation}
        onRename={renameLocation}
        onArchive={archiveLocation}
      />

      {/* Таблица остатков */}
      {(data.products || []).length === 0 ? (
        <div style={{ ...cardStyle, padding: 24, textAlign: "center", color: C.muted }}>
          Справочник товаров пуст. Сначала заведите товары во вкладке «Справочник товаров».
        </div>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
                <th style={thLeft}>Товар</th>
                {locs.map((l) => (
                  <th key={l.id} style={thR}>{l.name} · кол-во</th>
                ))}
                <th style={thR}>Себест. ₽</th>
                <th style={thR}>Сумма ₽</th>
                <th style={thR}></th>
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => {
                const totalQty = round2(locs.reduce((s, l) => s + (Number(row.byLoc[l.id]?.qty) || 0), 0));
                // Себестоимость берём из первой заполненной клетки строки (обычно одинаковая).
                const cost = locs.map((l) => row.byLoc[l.id]?.unit_cost).find((v) => v != null && v !== "") ?? null;
                const value = round2(totalQty * (Number(cost) || 0));
                return (
                  <tr key={row.catalog_id} style={{ borderBottom: `1px solid ${C.line}33` }}>
                    <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {row.im_url ? (
                          <img src={row.im_url} alt="" width={38} height={38} style={{ borderRadius: 6, objectFit: "cover", border: `1px solid ${C.line}` }} />
                        ) : (
                          <div style={{ ...thumbFallback, width: 38, height: 38, fontSize: 15 }}>📦</div>
                        )}
                        <div>
                          <div style={{ fontWeight: 600 }}>{row.catalog_name || `#${row.catalog_id}`}</div>
                          <div style={{ fontSize: 11, color: C.faint }}>
                            {row.sku_count > 0 ? `${row.sku_count} SKU` : "нет SKU"}
                          </div>
                        </div>
                      </div>
                    </td>
                    {locs.map((l) => (
                      <td key={l.id} style={{ padding: "4px 6px", textAlign: "right" }}>
                        <input
                          type="number"
                          value={row.byLoc[l.id]?.qty ?? ""}
                          onChange={(e) => patchCell(row.catalog_id, l.id, "qty", e.target.value)}
                          placeholder="0"
                          style={{ ...inputStyle, width: 80, padding: "4px 6px", textAlign: "right", ...(isEditableCell(row.byLoc[l.id]) ? editCell : {}) }}
                        />
                      </td>
                    ))}
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      <input
                        type="number"
                        value={cost ?? ""}
                        onChange={(e) => {
                          // Применяем себестоимость ко всем клеткам строки (один товар = одна себест.).
                          setDirty(true);
                          setDraft((prev) => {
                            const next = [...prev];
                            locs.forEach((l) => {
                              const idx = next.findIndex((b) => b.catalog_id === row.catalog_id && b.location_id === l.id);
                              if (idx >= 0) {
                                next[idx] = { ...next[idx], unit_cost: e.target.value === "" ? null : Number(e.target.value) };
                              } else if (e.target.value !== "") {
                                const cat = (data.products || []).find((p) => p.id === row.catalog_id);
                                next.push({ catalog_id: row.catalog_id, location_id: l.id, catalog_name: cat?.internal_name || null, qty: 0, unit_cost: Number(e.target.value) });
                              }
                            });
                            return next;
                          });
                        }}
                        placeholder="—"
                        style={{ ...inputStyle, width: 100, padding: "4px 6px", textAlign: "right", ...editCell }}
                      />
                    </td>
                    <td style={{ ...tdRight, fontWeight: 700, color: value > 0 ? C.accent : C.ink }}>{value > 0 ? money(value) : "—"}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      {locs.some((l) => row.byLoc[l.id]) && (
                        <button
                          onClick={() => locs.forEach((l) => row.byLoc[l.id] && removeRow(row.catalog_id, l.id))}
                          style={{ ...miniBtn, color: C.neg }}
                          title="Очистить строку"
                        >🗑</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {/* Итог */}
            <tfoot>
              <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                <td style={tdFootLeft}>Итого</td>
                {locs.map((l) => (
                  <td key={l.id} style={{ ...tdFootRight, fontWeight: 700 }}>
                    {num(totals.byLoc[l.id]?.qty || 0)}
                  </td>
                ))}
                <td style={tdFootRight}>—</td>
                <td style={{ ...tdFootRight, fontWeight: 800, color: C.accent }}>{money(totals.value)}</td>
                <td style={tdFootRight}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Расшифровка по местам */}
      {Object.keys(totals.byLoc).length > 0 && (
        <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {locs.map((l) => {
            const t = totals.byLoc[l.id];
            if (!t) return null;
            return (
              <div key={l.id} style={{ ...cardStyle, padding: "10px 14px", flex: "1 1 200px" }}>
                <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3 }}>{l.name}</div>
                <div style={{ fontSize: 16, fontWeight: 800, marginTop: 4 }}>{money(t.value)}</div>
                <div style={{ fontSize: 12, color: C.faint }}>{num(t.qty)} шт.</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =====================================================================
//  Каталог мест хранения (inline)
// =====================================================================
function LocationsBar({ locations, onAdd, onRename, onArchive }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState("");

  function commitAdd() {
    const n = newName.trim();
    if (!n) { setAdding(false); return; }
    onAdd(n);
    setNewName("");
    setAdding(false);
  }
  function commitRename(id) {
    const n = editName.trim();
    if (!n) { setEditId(null); return; }
    onRename(id, n);
    setEditId(null);
  }

  return (
    <div style={{ ...cardStyle, padding: "10px 14px", marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3, marginRight: 4 }}>
          Места хранения
        </span>
        {locations.map((l) => (
          <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {editId === l.id ? (
              <>
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(l.id);
                    if (e.key === "Escape") setEditId(null);
                  }}
                  style={{ ...inputStyle, width: 120, padding: "3px 6px", fontSize: 12 }}
                />
                <button onClick={() => commitRename(l.id)} style={{ ...miniBtn, color: C.pos, padding: "2px 6px" }}>✓</button>
              </>
            ) : (
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 7,
                  padding: "3px 8px", fontSize: 12,
                }}
              >
                {l.name}
                <button onClick={() => { setEditId(l.id); setEditName(l.name); }} style={{ border: "none", background: "transparent", cursor: "pointer", color: C.faint, fontSize: 11 }} title="Переименовать">✎</button>
                <button onClick={() => onArchive(l.id)} style={{ border: "none", background: "transparent", cursor: "pointer", color: C.neg, fontSize: 11 }} title="Убрать">✕</button>
              </span>
            )}
          </div>
        ))}
        {adding ? (
          <>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAdd();
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="название места"
              style={{ ...inputStyle, width: 160, padding: "3px 8px", fontSize: 12 }}
            />
            <button onClick={commitAdd} style={{ ...miniBtn, color: C.pos, padding: "2px 8px" }}>✓</button>
            <button onClick={() => setAdding(false)} style={{ ...miniBtn, padding: "2px 8px" }}>✕</button>
          </>
        ) : (
          <button onClick={() => setAdding(true)} style={{ ...miniBtn, fontSize: 12 }}>+ добавить место</button>
        )}
      </div>
    </div>
  );
}

// =====================================================================
//  Мелкие компоненты
// =====================================================================
function Header() {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Остатки на складе/ФФ</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Товар на собственном складе и фулфилменте. Снапшоты по датам, несколько мест хранения.
      </p>
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
}

function Kpi({ label, value, accent }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 140px", minWidth: 120 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ? C.accent : C.ink }}>{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
      {label}
      {children}
    </label>
  );
}

// ---------------- Хелперы ----------------
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function ISO_DATE(v) { return ISO_DATE_RE.test(v || ""); }
function round2(v) { const n = Number(v) || 0; return Math.round(n * 100) / 100; }
function isEditableCell(cell) { return cell != null; }

// ---------------- Стили ----------------
const inputStyle = {
  padding: "6px 10px", borderRadius: 6, fontSize: 13,
  background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 80,
};
const primaryBtn = {
  padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600,
  background: C.accent, color: "#0A1A1C", border: "none",
};
const miniBtn = {
  padding: "4px 8px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.muted, border: `1px solid ${C.line}`,
};
const cardStyle = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10,
};
const thumbFallback = {
  borderRadius: 6, background: C.surfaceAlt, color: C.faint,
  display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.line}`,
};
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdFootLeft = { padding: "12px", fontSize: 13, fontWeight: 800, color: C.ink, textAlign: "left" };
const tdFootRight = { padding: "12px", fontSize: 13, color: C.ink, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const editCell = {
  background: "rgba(0,229,255,0.06)",
  borderLeft: `2px solid ${C.accent}`,
};
const alertStyle = {
  padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
  background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted,
};
