"use client";
import { C, soft } from "@/lib/palette.js";

// /cabinets/[id]/items — Себестоимость и справочники товаров.
// Полный перенос эталона data-presenter/app/items/page.jsx с адаптацией:
// локальная палитра SAAS, проп cabinetId, fetch на /api/cabinets/[id]/items*.
//
// Источник: GET /api/cabinets/[id]/items (WB+Ozon + cost_overrides/groups/status).
// Запись: POST /cost (с effective_from+note), /status, /group, PUT/DELETE /cost/[id].
import { useEffect, useMemo, useState, useCallback } from "react";

// Палитра SAAS (тёмно-синяя).


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const dash = (v) => (v == null || v === "" ? "—" : v);
const today = () => new Date().toISOString().slice(0, 10);

export default function ItemsPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Фильтры.
  const [mp, setMp] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [group, setGroup] = useState("");
  const [status, setStatus] = useState("active"); // по умолчанию только активные
  const [q, setQ] = useState("");
  // UI.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState(null);

  const api = useMemo(() => {
    const p = new URLSearchParams();
    if (mp) p.set("mp", mp);
    if (brand) p.set("brand", brand);
    if (category) p.set("category", category);
    if (group) p.set("group", group);
    if (status) p.set("status", status);
    if (q.trim()) p.set("q", q.trim());
    return `/api/cabinets/${cabinetId}/items?` + p.toString();
  }, [cabinetId, mp, brand, category, group, status, q]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(api)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setPage(1); setExpanded(null); }, [mp, brand, category, group, status, q, pageSize]);

  // --- POST-хелперы ---
  async function postCost(item, cost, effectiveFrom, note) {
    const body = { platform: item.platform, cost: Number(cost), effective_from: effectiveFrom, note: note || null };
    if (item.platform === "wb") body.nm_id = item.nm_id;
    else body.product_id = item.product_id;
    const r = await fetch(`/api/cabinets/${cabinetId}/items/cost`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "cost POST failed");
    return d;
  }

  async function postStatus(item, newStatus) {
    const body = { platform: item.platform, status: newStatus };
    if (item.platform === "wb") body.nm_id = item.nm_id;
    else body.product_id = item.product_id;
    const r = await fetch(`/api/cabinets/${cabinetId}/items/status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "status POST failed");
    return d;
  }

  async function postGroupCreate(name) {
    const r = await fetch(`/api/cabinets/${cabinetId}/items/group`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "group create failed");
    return d;
  }

  async function postGroupAssign(item, groupId) {
    const body = { action: groupId ? "assign" : "unassign", platform: item.platform };
    if (item.platform === "wb") body.nm_id = item.nm_id;
    else body.product_id = item.product_id;
    if (groupId) body.group_id = Number(groupId);
    const r = await fetch(`/api/cabinets/${cabinetId}/items/group`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "group assign failed");
    return d;
  }

  // Локальное обновление строки (optimistic).
  function patchItem(key, patch) {
    setData((prev) => prev ? {
      ...prev,
      items: prev.items.map((it) => (itemKey(it) === key ? { ...it, ...patch } : it)),
    } : prev);
  }

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (loading && !data) return <Centered>Загрузка…</Centered>;
  if (!data) return <Centered>Нет данных</Centered>;

  const { items, totals, facets } = data;
  const totalPages = pageSize === 0 ? 1 : Math.ceil(items.length / pageSize);
  const safePage = Math.min(page, totalPages || 1);
  const slice = pageSize === 0 ? items : items.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1700, margin: "0 auto" }}>
      <Header />

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Всего SKU" value={num(totals.total)} />
        <Kpi label="С себестоимостью" value={num(totals.withCost)} />
        <Kpi label="Override (правлено)" value={num(totals.overrides)} accent={totals.overrides > 0} />
        <Kpi label="Средняя себест." value={money(totals.avgCost)} />
        <Kpi label="В группах" value={num(totals.grouped)} />
        <Kpi label="Активных" value={num(totals.active)} pos={totals.active === totals.total} />
      </div>

      {/* Фильтры */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
        <Field label="Поиск">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="имя, артикул, бренд…" style={{ ...inputStyle, width: 200 }} />
        </Field>
        <Field label="Маркетплейс">
          <select value={mp} onChange={(e) => setMp(e.target.value)} style={inputStyle}>
            <option value="">Все ({totals.total})</option>
            <option value="wb">WB</option>
            <option value="ozon">Ozon</option>
          </select>
        </Field>
        <Field label="Бренд">
          <select value={brand} onChange={(e) => setBrand(e.target.value)} style={inputStyle}>
            <option value="">Все ({(facets.brands || []).reduce((s, x) => s + x.n, 0)})</option>
            {(facets.brands || []).map((b) => <option key={b.brand} value={b.brand}>{b.brand} ({b.n})</option>)}
          </select>
        </Field>
        <Field label="Категория">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
            <option value="">Все ({(facets.categories || []).reduce((s, x) => s + x.n, 0)})</option>
            {(facets.categories || []).map((c) => <option key={c.category} value={c.category}>{c.category} ({c.n})</option>)}
          </select>
        </Field>
        <Field label="Группа">
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={inputStyle}>
            <option value="">Все</option>
            {(facets.groups || []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label="Статус">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            <option value="">Все</option>
            <option value="active">Активные</option>
            <option value="inactive">Неактивные</option>
          </select>
        </Field>
      </div>

      {/* Таблица */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}></th>
              <th style={thLeft}>Товар</th>
              <th style={thR}>Себест. ₽</th>
              <th style={thR}>Дата начала</th>
              <th style={thR}>Магазин</th>
              <th style={thLeft}>Группа</th>
              <th style={thLeft}>Бренд</th>
              <th style={thLeft}>Статус</th>
              <th style={thR}>Активный</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((it) => {
              const key = itemKey(it);
              const isOpen = expanded === key;
              return (
                <RowFragment
                  key={key} it={it} isOpen={isOpen} cabinetId={cabinetId}
                  onToggle={() => setExpanded(isOpen ? null : key)}
                  facets={facets} saving={saving} setSaving={setSaving} patchItem={patchItem}
                  postCost={postCost} postStatus={postStatus}
                  postGroupAssign={postGroupAssign} postGroupCreate={postGroupCreate} reload={reload}
                />
              );
            })}
            {slice.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: C.muted }}>Нет товаров по выбранным фильтрам</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={safePage} totalPages={totalPages} setPage={setPage}
        totalItems={items.length} pageSize={pageSize} setPageSize={setPageSize} />
    </div>
  );
}

// =====================================================================
//  RowFragment — строка таблицы + expand-обёртка
// =====================================================================
function RowFragment({ it, isOpen, onToggle, cabinetId, facets, saving, setSaving, patchItem, postCost, postStatus, postGroupAssign, postGroupCreate, reload }) {
  const key = itemKey(it);
  return (
    <>
      <tr style={{ borderBottom: isOpen ? "none" : `1px solid ${soft("line", 20)}` }}>
        <td style={{ padding: "8px 10px", textAlign: "center", width: 32 }}>
          <button onClick={onToggle} style={expandBtn} title={isOpen ? "Свернуть" : "Детализация"}>{isOpen ? "▾" : "▸"}</button>
        </td>
        {/* Композитная колонка Товар */}
        <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {it.im_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={it.im_url} alt="" width={40} height={40}
                style={{ borderRadius: 6, objectFit: "cover", border: `1px solid ${C.line}` }} />
            ) : (
              <div style={thumbFallback}>📦</div>
            )}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 600, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                <MpBadge platform={it.platform} />
              </div>
              <div style={{ fontSize: 11, color: C.faint }}>
                {it.nm_id ? `nm ${it.nm_id}` : `pid ${it.product_id}`}{it.category ? ` · ${it.category}` : ""}
              </div>
            </div>
          </div>
        </td>
        <CostCell it={it} saving={saving} setSaving={setSaving}
          onSaved={(cost, effectiveFrom) => patchItem(key, { cost, effective_from: effectiveFrom, cost_source: "override" })}
          postCost={postCost} />
        <td style={tdRight}>
          {it.effective_from ? <span style={{ color: C.accent }}>{it.effective_from}</span> : <span style={{ color: C.faint }}>—</span>}
        </td>
        <td style={tdRight}><MpBadge platform={it.platform} /></td>
        <GroupCell it={it} facets={facets} saving={saving} setSaving={setSaving}
          onSaved={(groupId, groupName) => patchItem(key, { group_id: groupId, group_name: groupName })}
          postGroupAssign={postGroupAssign} postGroupCreate={postGroupCreate} reload={reload} />
        <td style={{ padding: "8px 10px", fontSize: 12, color: C.muted }}>{dash(it.brand)}</td>
        <StatusCell it={it} saving={saving} setSaving={setSaving} onSaved={(s) => patchItem(key, { status: s })} postStatus={postStatus} />
        <td style={tdRight}><ActiveDot hasSales={it.has_sales} status={it.status} /></td>
      </tr>
      {isOpen && (
        <tr style={{ background: C.surface }}>
          <td colSpan={9} style={{ padding: "16px 20px", borderBottom: `1px solid ${soft("line", 20)}` }}>
            <DetailPanel it={it} cabinetId={cabinetId} postCost={postCost} reload={reload} />
          </td>
        </tr>
      )}
    </>
  );
}

// =====================================================================
//  Редактируемые ячейки
// =====================================================================
function CostCell({ it, saving, setSaving, onSaved, postCost }) {
  const key = itemKey(it) + "::cost";
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [date, setDate] = useState(today());

  function start() {
    setText(it.cost != null ? String(it.cost) : "");
    setDate(it.effective_from || today());
    setEditing(true);
  }
  async function commit() {
    setEditing(false);
    const v = Number(text);
    if (!Number.isFinite(v) || v < 0 || text.trim() === "") return;
    if (v === it.cost && date === it.effective_from) return;
    setSaving(key);
    try { await postCost(it, v, date); onSaved(v, date); }
    catch (e) { alert("Не сохранилось: " + e.message); }
    finally { setSaving(null); }
  }
  if (editing) {
    return (
      <td style={tdRight}>
        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
          <input autoFocus type="number" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
            style={{ ...inputStyle, width: 90, padding: "4px 6px" }} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
            style={{ ...inputStyle, width: 140, padding: "4px 6px" }} />
        </div>
      </td>
    );
  }
  const isSaving = saving === key;
  return (
    <td style={tdRight}>
      <button onClick={start} title="Кликни чтобы править себестоимость" style={editBtn}>
        <strong style={{ color: it.cost_source === "override" ? C.accent : C.ink }}>{money(it.cost)}</strong>
        {it.cost_source === "cogs" && <span style={{ fontSize: 9, color: C.faint }}> API</span>}
        {isSaving ? " ⏳" : ""}
      </button>
    </td>
  );
}

function GroupCell({ it, facets, saving, setSaving, onSaved, postGroupAssign, postGroupCreate, reload }) {
  const key = itemKey(it) + "::group";
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  async function onChange(e) {
    const val = e.target.value;
    if (val === "__new__") { setCreating(true); setName(""); return; }
    setSaving(key);
    try {
      if (val === "") { await postGroupAssign(it, null); onSaved(null, null); }
      else {
        await postGroupAssign(it, val);
        const g = (facets.groups || []).find((x) => String(x.id) === val);
        onSaved(Number(val), g?.name || null);
      }
    } catch (err) { alert("Не сохранилось: " + err.message); }
    finally { setSaving(null); }
  }
  async function createAndAssign() {
    const nm = name.trim();
    if (!nm) { setCreating(false); return; }
    setSaving(key);
    try {
      const d = await postGroupCreate(nm);
      const g = d.group;
      await postGroupAssign(it, g.id);
      onSaved(g.id, g.name);
      setCreating(false);
      reload();
    } catch (err) { alert("Не удалось создать группу: " + err.message); }
    finally { setSaving(null); }
  }
  if (creating) {
    return (
      <td style={{ padding: "8px 10px" }}>
        <div style={{ display: "flex", gap: 4 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createAndAssign(); if (e.key === "Escape") setCreating(false); }}
            placeholder="название группы" style={{ ...inputStyle, width: 140, padding: "4px 6px" }} />
          <button onClick={createAndAssign} style={miniBtn}>✓</button>
        </div>
      </td>
    );
  }
  return (
    <td style={{ padding: "8px 10px" }}>
      <select value={it.group_id || ""} onChange={onChange} style={{ ...inputStyle, padding: "4px 8px", width: "auto" }}>
        <option value="">— нет —</option>
        {(facets.groups || []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        <option value="__new__">➕ Новая группа…</option>
      </select>
      {saving === key ? " ⏳" : ""}
    </td>
  );
}

function StatusCell({ it, saving, setSaving, onSaved, postStatus }) {
  const key = itemKey(it) + "::status";
  async function onChange(e) {
    const v = e.target.value;
    setSaving(key);
    try { await postStatus(it, v); onSaved(v); }
    catch (err) { alert("Не сохранилось: " + err.message); }
    finally { setSaving(null); }
  }
  return (
    <td style={{ padding: "8px 10px" }}>
      <select value={it.status} onChange={onChange}
        style={{ ...inputStyle, padding: "4px 8px", width: "auto", color: it.status === "active" ? C.pos : C.muted }}>
        <option value="active">● Активный</option>
        <option value="inactive">○ Неактивный</option>
      </select>
      {saving === key ? " ⏳" : ""}
    </td>
  );
}

// =====================================================================
//  DetailPanel — детализация + история себестоимости (CRUD)
// =====================================================================
function DetailPanel({ it, cabinetId, postCost, reload }) {
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState({ cost: "", date: "", note: "" });
  const [adding, setAdding] = useState(false);
  const [newVal, setNewVal] = useState({ cost: "", date: today(), note: "" });

  async function loadHistory() {
    setLoading(true);
    const params = new URLSearchParams({ platform: it.platform });
    if (it.platform === "wb") params.set("nm_id", it.nm_id);
    else params.set("product_id", it.product_id);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/items/history?` + params);
      const d = await r.json();
      setHistory(d.items || []);
    } catch { setHistory([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (it) loadHistory(); /* eslint-disable-next-line */ }, [it.platform, it.nm_id, it.product_id]);

  function startEdit(h) {
    setEditing(h.id);
    setEditVal({ cost: String(h.cost), date: h.effective_from, note: h.note || "" });
  }
  async function saveEdit(id) {
    const v = Number(editVal.cost);
    if (!Number.isFinite(v) || v < 0) { alert("cost должен быть числом >= 0"); return; }
    const body = { cost: v, effective_from: editVal.date, note: editVal.note || null };
    const r = await fetch(`/api/cabinets/${cabinetId}/items/cost/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не сохранилось: " + (d.error || "")); return; }
    setEditing(null); loadHistory(); reload();
  }
  async function delOverride(id) {
    if (!confirm("Удалить запись истории? Расчёты с этой даты пересчитаются.")) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/items/cost/${id}`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не удалилось: " + (d.error || "")); return; }
    loadHistory(); reload();
  }
  async function addOverride() {
    const v = Number(newVal.cost);
    if (!Number.isFinite(v) || v < 0) { alert("cost должен быть числом >= 0"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newVal.date)) { alert("нужна дата YYYY-MM-DD"); return; }
    try {
      await postCost(it, v, newVal.date, newVal.note || null);
      setAdding(false); setNewVal({ cost: "", date: today(), note: "" });
      loadHistory(); reload();
    } catch (e) { alert("Не удалось добавить: " + e.message); }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {it.im_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={it.im_url} alt="" style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}` }} />
        ) : (
          <div style={{ ...thumbFallback, width: 100, height: 100, fontSize: 36 }}>📦</div>
        )}
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>{it.name}</h3>
          <table style={{ fontSize: 13, color: C.muted }}>
            <tbody>
              <tr><td style={dLabel}>Маркетплейс</td><td><MpBadge platform={it.platform} /></td></tr>
              <tr><td style={dLabel}>Артикул</td><td>{it.nm_id ? `nm ${it.nm_id}` : `pid ${it.product_id}`}</td></tr>
              <tr><td style={dLabel}>Бренд</td><td>{dash(it.brand)}</td></tr>
              <tr><td style={dLabel}>Категория</td><td>{dash(it.category)}</td></tr>
              <tr><td style={dLabel}>Текущая себест.</td><td><strong style={{ color: C.accent }}>{money(it.cost)}</strong> <span style={{ color: C.faint }}>({it.cost_source}{it.effective_from ? `, с ${it.effective_from}` : ""})</span></td></tr>
              <tr><td style={dLabel}>Базовый cost (API МП)</td><td>{money(it.base_cost)}</td></tr>
              <tr><td style={dLabel}>Группа</td><td>{dash(it.group_name)}</td></tr>
              <tr><td style={dLabel}>Статус</td><td>{it.status === "active" ? "Активный" : "Неактивный"}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* История себестоимости с inline-edit */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>История себестоимости (override'ы)</strong>
          <button onClick={() => setAdding(!adding)} style={miniBtn}>{adding ? "Отмена" : "+ поставка"}</button>
        </div>
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 8 }}>
          ⚠️ Правка/удаление прошлой записи ретроактивно меняет все фин.расчёты (P&L, юнитка, план-факт) с этой даты.
          Override имеет приоритет над базовым cost API МП.
        </div>

        {adding && (
          <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center", padding: "8px 10px", background: C.surfaceAlt, borderRadius: 8 }}>
            <input type="number" placeholder="cost ₽" value={newVal.cost} onChange={(e) => setNewVal({ ...newVal, cost: e.target.value })} style={{ ...inputStyle, width: 100, padding: "4px 6px" }} />
            <input type="date" value={newVal.date} onChange={(e) => setNewVal({ ...newVal, date: e.target.value })} style={{ ...inputStyle, width: 150, padding: "4px 6px" }} />
            <input placeholder="примечание" value={newVal.note} onChange={(e) => setNewVal({ ...newVal, note: e.target.value })} style={{ ...inputStyle, flex: 1, padding: "4px 6px" }} />
            <button onClick={addOverride} style={{ ...miniBtn, color: C.pos }}>✓ Добавить</button>
          </div>
        )}

        {loading ? (
          <div style={{ color: C.faint, fontSize: 12 }}>Загрузка истории…</div>
        ) : history && history.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                <th style={{ ...thR, textAlign: "left", padding: "6px 10px" }}>Дата начала</th>
                <th style={thR}>Себест. ₽</th>
                <th style={{ ...thR, textAlign: "left" }}>Примечание</th>
                <th style={thR}></th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                  {editing === h.id ? (
                    <>
                      <td style={{ padding: "4px 10px" }}>
                        <input type="date" value={editVal.date} onChange={(e) => setEditVal({ ...editVal, date: e.target.value })} style={{ ...inputStyle, padding: "3px 6px", width: 150 }} />
                      </td>
                      <td style={tdRight}>
                        <input type="number" value={editVal.cost} onChange={(e) => setEditVal({ ...editVal, cost: e.target.value })} style={{ ...inputStyle, padding: "3px 6px", width: 100 }} />
                      </td>
                      <td style={{ padding: "4px 10px" }}>
                        <input value={editVal.note} onChange={(e) => setEditVal({ ...editVal, note: e.target.value })} placeholder="—" style={{ ...inputStyle, padding: "3px 6px", width: "100%" }} />
                      </td>
                      <td style={tdRight}>
                        <button onClick={() => saveEdit(h.id)} style={{ ...miniBtn, color: C.pos, marginRight: 4 }}>✓</button>
                        <button onClick={() => setEditing(null)} style={miniBtn}>✕</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ padding: "6px 10px" }}>
                        <span style={{ color: h.effective_from === it.effective_from ? C.accent : C.ink, fontWeight: h.effective_from === it.effective_from ? 700 : 400 }}>
                          {h.effective_from}
                        </span>
                        {h.effective_from === it.effective_from && <span style={{ fontSize: 10, color: C.accent, marginLeft: 6 }}>● действует</span>}
                      </td>
                      <td style={tdRight}><strong>{money(h.cost)}</strong></td>
                      <td style={{ padding: "6px 10px", color: C.muted }}>{h.note || "—"}</td>
                      <td style={tdRight}>
                        <button onClick={() => startEdit(h)} style={miniBtn} title="Править">✎</button>
                        <button onClick={() => delOverride(h.id)} style={{ ...miniBtn, color: C.neg, marginLeft: 4 }} title="Удалить">🗑</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: "10px 14px", borderRadius: 8, background: C.surfaceAlt, color: C.faint, fontSize: 12 }}>
            Нет override'ов. Себестоимость берётся из базового cogs API МП ({money(it.base_cost)}).
            Нажмите «+ поставка», чтобы задать себестоимость с датой начала.
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
//  Мелкие компоненты
// =====================================================================
function itemKey(it) { return `${it.platform}|${it.nm_id || 0}|${it.product_id || 0}`; }

function MpBadge({ platform }) {
  const isWb = platform === "wb";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6,
      background: isWb ? "rgba(79,140,255,0.15)" : "rgba(249,115,22,0.15)",
      color: isWb ? C.accent : C.pink,
    }}>{isWb ? "WB" : "OZON"}</span>
  );
}

function ActiveDot({ hasSales, status }) {
  const active = hasSales || status === "active";
  return <span title={active ? "активный" : "неактивный"} style={{ fontSize: 16 }}>{active ? "🟢" : "⚫"}</span>;
}

function Header() {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Себестоимость</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Товары WB + Ozon. Себестоимость с историей поставок (override), группы и статус — справочники менеджера.
      </p>
    </div>
  );
}

function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, padding: 20, textAlign: "center" }}>{children}</div>;
}

function Kpi({ label, value, accent, pos }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 140px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ? C.accent : pos === false ? C.neg : C.ink }}>{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>{label}{children}</label>;
}

function Pagination({ page, totalPages, setPage, totalItems, pageSize, setPageSize }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, fontSize: 12, color: C.muted, flexWrap: "wrap", gap: 10 }}>
      <div>
        Показано {totalItems === 0 ? 0 : (page - 1) * (pageSize || totalItems) + 1}–
        {pageSize === 0 ? totalItems : Math.min(page * pageSize, totalItems)} из {totalItems}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={{ ...inputStyle, padding: "4px 8px", width: "auto" }}>
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={0}>все</option>
        </select>
        <button disabled={page <= 1} onClick={() => setPage(page - 1)} style={miniBtn}>‹</button>
        <span>{page} / {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} style={miniBtn}>›</button>
      </div>
    </div>
  );
}

// ---------------- Стили ----------------
const inputStyle = {
  padding: "6px 10px", borderRadius: 6, fontSize: 13,
  background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120,
};
const miniBtn = {
  padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const editBtn = {
  border: "none", background: "transparent", cursor: "pointer",
  padding: "2px 4px", fontVariantNumeric: "tabular-nums",
};
const expandBtn = {
  border: "none", background: "transparent", cursor: "pointer",
  color: C.muted, fontSize: 13, padding: "2px 4px",
};
const thumbFallback = {
  width: 40, height: 40, borderRadius: 6, background: C.surfaceAlt, color: C.faint,
  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, border: `1px solid ${C.line}`,
};
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const dLabel = { color: C.faint, paddingRight: 12, padding: "3px 12px 3px 0" };
