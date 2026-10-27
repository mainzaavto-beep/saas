"use client";
import { C, soft } from "@/lib/palette.js";

import { useEffect, useMemo, useState, useCallback } from "react";


// =====================================================================
//  /finance/purchases — закупки = точная копия листа «Себес товара» (2026-06-24).
//
//  Источник правды = fin_data.db.purchases (C:\AgentsDB\). Sheets — backup.
//  Модель = лист «Себес товара» таблицы 1biax (29 колонок, 8 формул).
//
//  Композитная колонка «Товар» (по требованию владельца) схлопывает:
//    Фото + Где закуплено + Наименование + Артикул + nm_id.
//  Редактируемые ВВОДНЫЕ колонки (Excel): L(M=курс аванса), M, O(qty),
//    P(цена¥), T(логистика¥), U(курс остатка), X(логист. до МСК/ед), Y(логист. МСК→ФФ/ед),
//    даты, статус.
//  Read-only РАСЧЁТНЫЕ колонки (формулы Excel, обновляются после сохранения):
//    N(аванс₽), Q(сумма¥), R(остаток¥), S(остаток₽), V(цена/ед₽),
//    W(сумма₽опл), Z(ИТОГО), AA(Себестоимость — выделена).
//
//  Lifecycle-панель и график платежей (№41) сохранены.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const rub2 = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(x) + " ₽";
};
const yuan = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(x) + " ¥";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));

const STATUSES = ["Приехали", "В пути", "Ожидание", "Отменено"];

// Поля вводных колонок Excel, которые inline-редактируются и передаются на сервер.
// Буква → поле БД. Расчётные (N,Q,R,S,V,W,Z,AA) НЕ тут — они read-only.
const INPUT_FIELDS = [
  "prepay_yuan", "prepay_rate", "qty", "unit_cost_yuan",
  "logistics_yuan", "exchange_rate", "logistics_rub_per_unit", "logistics_rub",
  "order_dt", "ship_dt", "delivery_dt", "supplier_name", "supplier", "pay_status",
];

export default function PurchasesPage({ cabinetId, readOnly = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [supplier, setSupplier] = useState("");
  const [vendor, setVendor] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false); // показывать архивные (завершённые→склад)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState(emptyAdd());
  const [expanded, setExpanded] = useState(null);

  const api = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (supplier) p.set("supplier", supplier);
    if (vendor) p.set("vendor", vendor);
    if (status) p.set("status", status);
    if (category) p.set("category", category);
    if (q.trim()) p.set("q", q.trim());
    if (archived) p.set("archived", "1");
    return `/api/cabinets/${cabinetId}/purchases?` + p.toString();
  }, [cabinetId, from, to, supplier, vendor, status, category, q, archived]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(api).then(async (r) => {
      if (!r.ok) { setError(`Сервер: HTTP ${r.status}`); return; }
      try { return await r.json(); } catch { setError("Сервер вернул не JSON"); return null; }
    })
      .then((d) => { if (d && !d.error) setData(d); else if (d && d.error) setError(d.error); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setPage(1); setExpanded(null); }, [from, to, supplier, vendor, status, category, q, pageSize, archived]);

  if (error && !data) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка…</Centered>;

  const items = data.items || [];
  const totals = data.totals || { parties: 0, qty: 0, costTotal: 0, avgCost: 0, logisticsRubTotal: 0, hasNm: 0 };
  const facets = data.facets || { suppliers: [], vendors: [], statuses: [], categories: [] };
  const totalPages = pageSize === 0 ? 1 : Math.ceil(items.length / pageSize);
  const safePage = Math.min(page, totalPages || 1);
  const slice = pageSize === 0 ? items : items.slice((safePage - 1) * pageSize, safePage * pageSize);

  // --- Сохранение одного поля строки → POST (id=UPDATE). ---
  // Передаём ВСЕ вводные поля, чтобы сервер пересчитал формулы при любом изменении.
  async function saveField(it, field, rawValue) {
    if (readOnly) return;
    const next = { ...it, [field]: rawValue };
    const body = { id: it.id };
    for (const f of INPUT_FIELDS) body[f] = next[f];
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не сохранилось: " + (d.error || "")); return false; }
    reload();
    return true;
  }

  async function delRow(id) {
    if (readOnly) return;
    if (!confirm("Удалить партию? (мягкое удаление, Sheets = backup для аудита)")) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases?id=${id}`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не удалилось: " + (d.error || "")); return; }
    reload();
  }

  // «✓ Доставлено» → партия уходит на страницу «Доставлено на склад» (ждёт приёмки ФФ).
  async function completeToStock(it) {
    if (readOnly) return;
    if (!confirm(`Партия «${it.supplier_name || "#" + it.id}» доставлена на склад?\n` +
      `Она скроется из активных закупок и появится в «Доставлено на склад» — там отметите приёмку по артикулам.`)) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete_to_stock", id: it.id }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не отметилось: " + (d.error || "")); return; }
    if (expanded === it.id) setExpanded(null);
    reload();
  }

  async function addRecord() {
    const qty = Number(addForm.qty);
    if (!Number.isInteger(qty) || qty <= 0) { alert("Кол-во (шт) должно быть целым > 0"); return; }
    setAdding(true);
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addForm),
    });
    const d = await r.json();
    setAdding(false);
    if (!r.ok || d.error) { alert("Не добавилось: " + (d.error || "")); return; }
    setAddForm(emptyAdd());
    setShowAdd(false);
    reload();
  }

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px" }}>
      <Header />

      {/* KPI-плитки */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Партий" value={num(totals.parties)} />
        <Kpi label="Σ шт" value={num(totals.qty)} />
        <Kpi label="Σ ИТОГО (полная стоимость)" value={money(totals.costTotal)} color={C.neg} />
        <Kpi label="Ср. себест. за ед." value={money(totals.avgCost)} />
        <Kpi label="Σ логистика МСК ₽" value={money(totals.logisticsRubTotal)} />
        <Kpi label="SKU с nm_id" value={`${totals.hasNm} / ${totals.parties}`} />
      </div>

      {/* Фильтры + действия */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
        <Field label="С даты"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} /></Field>
        <Field label="По дату"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} /></Field>
        <Field label="Товар (наименование)">
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)} style={inputStyle}>
            <option value="">Все ({facets.suppliers.reduce((s, x) => s + x.n, 0)})</option>
            {facets.suppliers.map((s) => (
              <option key={s.supplier_name || "__n__"} value={s.supplier_name || ""}>{s.supplier_name || "(пусто)"} ({s.n})</option>
            ))}
          </select>
        </Field>
        <Field label="Поставщик (контакт)">
          <select value={vendor} onChange={(e) => setVendor(e.target.value)} style={inputStyle}>
            <option value="">Все ({facets.vendors.reduce((s, x) => s + x.n, 0)})</option>
            {facets.vendors.map((v) => (
              <option key={v.v || "__null__"} value={v.v || "__null__"}>{v.v || "(без поставщика)"} ({v.n})</option>
            ))}
          </select>
        </Field>
        <Field label="Статус">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            <option value="">Все ({facets.statuses.reduce((s, x) => s + x.n, 0)})</option>
            {facets.statuses.map((s) => (
              <option key={s.s || "__null__"} value={s.s || "__null__"}>{s.s || "(пусто)"} ({s.n})</option>
            ))}
          </select>
        </Field>
        <Field label="Категория">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
            <option value="">Все ({facets.categories.reduce((s, x) => s + x.n, 0)})</option>
            {facets.categories.map((c) => (
              <option key={c.c || "__null__"} value={c.c || "__null__"}>{c.c || "(без категории)"} ({c.n})</option>
            ))}
          </select>
        </Field>
        <Field label="Поиск">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="имя товара или nm_id" style={{ ...inputStyle, width: 200 }} />
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: C.muted, cursor: "pointer" }}>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          архивные
        </label>
        <button onClick={() => { setFrom(""); setTo(""); setSupplier(""); setVendor(""); setStatus(""); setCategory(""); setQ(""); setArchived(false); }} style={resetBtnStyle}>Сбросить</button>
        {!readOnly && (
          <button onClick={() => setShowAdd((v) => !v)} style={{ ...addBtnStyle, background: showAdd ? C.surface : C.accent, color: showAdd ? C.ink : "var(--accentInk)" }}>
            {showAdd ? "✕ Закрыть" : "+ Добавить партию"}
          </button>
        )}
      </div>


      {showAdd && !readOnly && (
        <AddForm form={addForm} setForm={setAddForm} onAdd={addRecord} busy={adding} />
      )}

      {readOnly && (
        <div style={{ color: C.muted, fontSize: 13, margin: "4px 0 12px" }}>
          Архив партий до 16.10 — только чтение. Новые закупки заводятся заказами.
        </div>
      )}

      {/* Таблица */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ minWidth: 2200, width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surface, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={{ ...thLeft, width: 32 }}></th>
              <th style={thLeft}>Товар</th>
              <th style={thR}>Предоплата ¥ (L)</th>
              <th style={thR}>Курс аванса (M)</th>
              <th style={thR}>Аванс ₽ (N)</th>
              <th style={thR}>Кол-во (O)</th>
              <th style={thR}>Цена ¥ (P)</th>
              <th style={thR}>Сумма ¥ (Q)</th>
              <th style={thR}>Остаток ¥ (R)</th>
              <th style={thR}>Остаток ₽ (S)</th>
              <th style={thR}>Логист. ¥ (T)</th>
              <th style={thR}>Курс ост. (U)</th>
              <th style={thR}>Цена/ед ₽ (V)</th>
              <th style={thR}>Сумма ₽ (W)</th>
              <th style={thR}>Логист. до МСК/ед ₽ (X)</th>
              <th style={thR}>Логист. МСК→ФФ/ед ₽ (Y)</th>
              <th style={thR}>ИТОГО (Z)</th>
              <th style={thR}>Себест. ₽ (AA)</th>
              <th style={thR}>Дата заказа</th>
              <th style={thR}>Дата отправки</th>
              <th style={thR}>Дата доставки</th>
              <th style={thLeft}>Этап</th>
              <th style={thLeft}>Оплата</th>
              <th style={thR}></th>
            </tr>
          </thead>
          <tbody>
            {slice.map((it) => (
              <Row key={it.id} it={it} cabinetId={cabinetId} onSave={saveField} onDel={delRow}
                onComplete={completeToStock} readOnly={readOnly}
                isOpen={expanded === it.id} onToggle={() => setExpanded(expanded === it.id ? null : it.id)} reload={reload} />
            ))}
            {slice.length === 0 && !loading && (
              <tr><td colSpan={24} style={{ padding: 24, textAlign: "center", color: C.faint }}>
                Нет партий по выбранным фильтрам
              </td></tr>
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.line}`, background: C.surface, fontWeight: 700 }}>
                <td style={tdLeftFoot}></td>
                <td style={tdLeftFoot}>Итого ({totals.parties} партий)</td>
                <td style={tdFootR}>—</td><td style={tdFootR}>—</td><td style={tdFootR}>—</td>
                <td style={tdFootR}>{num(totals.qty)}</td>
                <td style={tdFootR}>—</td><td style={tdFootR}>—</td><td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td><td style={tdFootR}>—</td><td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td><td style={tdFootR}>—</td><td style={tdFootR}>—</td>
                <td style={tdFootR}>{money(totals.logisticsRubTotal)}</td>
                <td style={tdFootR}><strong>{money(totals.costTotal)}</strong></td>
                <td style={tdFootR}><span style={{ color: C.accent }}>{money(totals.avgCost)}</span><div style={{ fontSize: 10, fontWeight: 400, color: C.faint }}>средняя за ед.</div></td>
                <td style={tdFootR} colSpan={6}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <Pagination
        page={safePage} totalPages={totalPages} setPage={setPage}
        totalItems={items.length} pageSize={pageSize} setPageSize={setPageSize}
      />
    </div>
  );
}

// ---------------- Строка таблицы (inline-редактирование вводных) ----------------

function Row({ it, cabinetId, onSave, onDel, onComplete, readOnly, isOpen, onToggle, reload }) {
  const [text, setText] = useState("");
  const [edit, setEdit] = useState(null);

  const dash = (v) => (v == null || v === "" ? <span style={{ color: C.faint }}>—</span> : v);

  const commitNum = async (field, kind) => {
    let val = kind === "int" ? parseInt(text, 10) : parseFloat(text);
    if (!Number.isFinite(val)) { setEdit(null); return; }
    if (val === it[field]) { setEdit(null); return; }
    setEdit(null);
    await onSave(it, field, val);
  };
  const commitText = async (field, opts = {}) => {
    const val = text;
    const cur = it[field] ?? "";
    if (val === cur) { setEdit(null); return; }
    setEdit(null);
    await onSave(it, field, opts.allowEmpty ? val || null : val);
  };

  // Редактируемое числовое поле (вводное).
  const renderNum = (field, kind, fmt) =>
    edit === field ? (
      <input
        autoFocus type="number" step={kind === "int" ? 1 : "any"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commitNum(field, kind)}
        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEdit(null); }}
        style={cellInput}
      />
    ) : (
      <button onClick={() => { setText(String(it[field] ?? "")); setEdit(field); }} style={cellBtn} title="Кликни чтобы править">
        {it[field] != null ? fmt(it[field]) : <span style={{ color: C.faint }}>—</span>}
      </button>
    );

  // Read-only расчётное поле (calc_*).
  const calc = (field, fmt, strong) => {
    const v = it[field];
    return (
      <td style={tdRight}>
        {v != null ? <span style={strong ? { color: C.accent, fontWeight: 700 } : {}}>{fmt(v)}</span> : <span style={{ color: C.faint }}>—</span>}
      </td>
    );
  };

  const renderDate = (field) =>
    edit === field ? (
      <input
        autoFocus type="date"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commitText(field, { allowEmpty: true })}
        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEdit(null); }}
        style={cellInput}
      />
    ) : (
      <button onClick={() => { setText(String(it[field] ?? "")); setEdit(field); }} style={cellBtn} title="Кликни чтобы править">
        {it[field] ? it[field] : <span style={{ color: C.faint }}>—</span>}
      </button>
    );

  return (
    <>
    <tr style={{ borderBottom: isOpen ? "none" : `1px solid ${soft("line", 20)}`, background: isOpen ? "rgba(0,229,255,0.04)" : "transparent" }}>
      <td style={{ padding: "8px 6px", verticalAlign: "middle", textAlign: "center" }}>
        <button onClick={onToggle} style={expandBtnStyle} title={isOpen ? "Свернуть" : "Заказ: жизненный цикл + платежи"}>
          {isOpen ? "▾" : "▸"}
        </button>
      </td>
      {/* Композитная колонка Товар: фото + где закуплено + наименование + артикул + поставщик */}
      <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
        <ProductCell it={it} edit={edit} setEdit={setEdit} setText={setText} text={text}
          onCommit={(v) => onSave(it, "supplier_name", v)}
          onSupplierCommit={(v) => onSave(it, "supplier", v)}
          onCategoryCommit={(v) => onSave(it, "category", v)} />
      </td>
      <Td right>{renderNum("prepay_yuan", "any", yuan)}</Td>          {/* L */}
      <Td right>{renderNum("prepay_rate", "rate", r2)}</Td>            {/* M */}
      {calc("calc_N", rub2)}                                            {/* N расчёт */}
      <Td right>{renderNum("qty", "int", num)}</Td>                    {/* O */}
      <Td right>{renderNum("unit_cost_yuan", "any", yuan)}</Td>        {/* P */}
      {calc("calc_Q", yuan)}                                            {/* Q */}
      {calc("calc_R", yuan)}                                            {/* R */}
      {calc("calc_S", rub2)}                                            {/* S */}
      <Td right>{renderNum("logistics_yuan", "any", yuan)}</Td>        {/* T */}
      <Td right>{renderNum("exchange_rate", "rate", r2)}</Td>          {/* U */}
      {calc("calc_V", rub2)}                                            {/* V */}
      {calc("calc_W", rub2)}                                            {/* W */}
      <Td right>{renderNum("logistics_rub_per_unit", "any", rub2)}</Td>{/* X */}
      <Td right>{renderNum("logistics_rub", "any", rub2)}</Td>         {/* Y */}
      {calc("calc_Z", rub2)}                                            {/* Z */}
      {calc("unit_cost", money, true)}                                 {/* AA */}
      <Td right>{renderDate("order_dt")}</Td>
      <Td right>{renderDate("ship_dt")}</Td>
      <Td right>{renderDate("delivery_dt")}</Td>
      <td style={{ padding: "6px 8px", verticalAlign: "middle" }}><LifecycleBadge status={it.lifecycle_effective} /></td>
      <td style={{ padding: "6px 8px", verticalAlign: "middle" }}>{renderPayStatus(it)}</td>
      <td style={tdRight}>
        {!readOnly && !it.archived && (
          <button onClick={() => onComplete(it)} style={{ ...miniBtn, color: C.pos, marginRight: 4 }} title="Доставлено на склад → ждёт приёмки ФФ">✓ Доставлено</button>
        )}
        {!readOnly && (
          <button onClick={() => onDel(it.id)} style={{ ...miniBtn, color: C.neg }} title="Удалить (мягкое)">🗑</button>
        )}
      </td>
    </tr>
    {isOpen && (
      <tr>
        <td colSpan={24} style={{ padding: "14px 20px", background: C.surface, borderBottom: `1px solid ${soft("line", 20)}` }}>
          <PurchaseDetailPanel it={it} cabinetId={cabinetId} reload={reload} />
        </td>
      </tr>
    )}
    </>
  );

  // Статус оплаты — inline-select. none/prepaid/paid. paid → остаток=0.
  function renderPayStatus(it) {
    return (
      <select
        value={it.pay_status ?? "none"}
        onChange={(e) => onSave(it, "pay_status", e.target.value)}
        style={{ ...cellInput, width: "auto", minWidth: 100, padding: "3px 6px", cursor: "pointer" }}
      >
        <option value="none">не оплачено</option>
        <option value="prepaid">аванс</option>
        <option value="paid">тело оплачено</option>
      </select>
    );
  }
}
// Композитная колонка «Товар» — фото + где закуплено + наименование + артикул + поставщик + категория.
function ProductCell({ it, edit, setEdit, setText, text, onCommit, onSupplierCommit, onCategoryCommit }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 240, maxWidth: 320 }}>
      {it.im_url ? (
        <img src={it.im_url} alt="" width={40} height={40}
          style={{ borderRadius: 6, objectFit: "cover", border: `1px solid ${C.line}` }} />
      ) : (
        <div style={{
          width: 40, height: 40, borderRadius: 6, background: C.surface, color: C.faint,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16, border: `1px solid ${C.line}`, flexShrink: 0,
        }}>📦</div>
      )}
      <div style={{ minWidth: 0 }}>
        {edit === "supplier_name" ? (
          <input autoFocus value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { const v = text; setEdit(null); if (v !== (it.supplier_name ?? "")) onCommit(v || null); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEdit(null); }}
            style={{ ...cellInput, fontWeight: 600, minWidth: 160 }} />
        ) : (
          <button onClick={() => { setText(String(it.supplier_name ?? "")); setEdit("supplier_name"); }}
            style={cellBtn} title="Кликни чтобы править наименование">
            <span style={{ fontWeight: 600, display: "block", textAlign: "left" }}>
              {it.supplier_name || <span style={{ color: C.faint, fontWeight: 400 }}>имя товара</span>}
            </span>
          </button>
        )}
        <div style={{ fontSize: 11, color: C.faint, whiteSpace: "nowrap", marginTop: 2 }}>
          {it.source_country ? `${it.source_country} · ` : ""}
          {it.nm_id ? `nm ${it.nm_id}` : "nm —"}
          {it.order_no ? ` · № ${it.order_no}` : ""}
        </div>
        {edit === "supplier" ? (
          <input autoFocus value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { const v = text; setEdit(null); if (v !== (it.supplier ?? "")) onSupplierCommit(v || null); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEdit(null); }}
            style={{ ...cellInput, fontSize: 11, width: "100%", marginTop: 2 }} placeholder="поставщик" />
        ) : (
          <button onClick={() => { setText(String(it.supplier ?? "")); setEdit("supplier"); }}
            style={{ ...cellBtn, fontSize: 11, textAlign: "left", padding: "1px 4px", width: "auto" }}
            title="Кликни чтобы править поставщика">
            <span style={{ color: C.faint }}>
              {it.supplier || <span style={{ opacity: 0.6 }}>поставщик —</span>}
            </span>
          </button>
        )}
        {/* Категория — кликабельный бейдж (inline-редактор). */}
        {edit === "category" ? (
          <input autoFocus value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { const v = text.trim(); setEdit(null); if (v !== (it.category ?? "")) onCategoryCommit(v || null); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEdit(null); }}
            style={{ ...cellInput, fontSize: 11, width: "100%", marginTop: 2 }} placeholder="категория (напр. Экшн-камеры)" />
        ) : (
          <button onClick={() => { setText(String(it.category ?? "")); setEdit("category"); }}
            style={{ ...badgeStyle, cursor: "pointer", marginTop: 2, background: it.category ? soft("accent", 14) : "transparent",
                     border: it.category ? "none" : `1px dashed ${C.line}`, color: it.category ? C.accent : C.faint,
                     fontSize: 10, padding: "1px 7px", textAlign: "left" }}
            title="Кликни чтобы задать категорию">
            {it.category || "без категории"}
          </button>
        )}
      </div>
    </div>
  );
}

// =====================================================================
//  №41: жизненный цикл заказа + график платежей (разворачивающаяся панель).
// =====================================================================

const LIFECYCLE = ["planned", "ordered", "in_production", "shipped", "in_transit", "arrived", "in_stock"];
const LIFECYCLE_LABEL = {
  planned: "Планируется", ordered: "Заказан", in_production: "В производстве",
  shipped: "Отгружен", in_transit: "В пути", arrived: "Прибыл", in_stock: "На складе",
};
const LIFECYCLE_COLOR = {
  planned: { bg: soft("muted", 18), fg: C.muted },
  ordered: { bg: soft("accent", 18), fg: C.accent },
  in_production: { bg: soft("accent", 18), fg: C.accent },
  shipped: { bg: soft("warn", 18), fg: C.warn },
  in_transit: { bg: soft("warn", 18), fg: C.warn },
  arrived: { bg: soft("pos", 18), fg: C.pos },
  in_stock: { bg: soft("pos", 30), fg: C.pos }, // выше alpha подложки — финальная стадия заметнее, чем «arrived»
};

function LifecycleBadge({ status }) {
  const s = status || "planned";
  const col = LIFECYCLE_COLOR[s] || LIFECYCLE_COLOR.planned;
  return (
    <span style={{ ...badgeStyle, background: col.bg, color: col.fg }}>
      {LIFECYCLE_LABEL[s] || s}
    </span>
  );
}

function PurchaseDetailPanel({ it, cabinetId, reload }) {
  const cur = it.lifecycle_effective || "planned";
  const curIdx = LIFECYCLE.indexOf(cur);
  const next = curIdx >= 0 && curIdx < LIFECYCLE.length - 1 ? LIFECYCLE[curIdx + 1] : null;

  const [advancing, setAdvancing] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [payForm, setPayForm] = useState({ due_dt: "", amount: "", ratio: "", status: "planned", note: "" });
  const [savingPay, setSavingPay] = useState(false);

  async function setStage(stage) {
    setAdvancing(true);
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, lifecycle_status: stage }),
    });
    const d = await r.json();
    setAdvancing(false);
    if (!r.ok || d.error) { alert("Не сохранилось: " + (d.error || "")); return; }
    reload();
  }

  async function addPayment() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payForm.due_dt)) { alert("Дата платежа должна быть ГГГГ-ММ-ДД"); return; }
    const amount = Number(payForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) { alert("Сумма > 0"); return; }
    setSavingPay(true);
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purchase_id: it.id, due_dt: payForm.due_dt, amount,
        ratio: payForm.ratio || null, status: payForm.status, note: payForm.note || null }),
    });
    const d = await r.json();
    setSavingPay(false);
    if (!r.ok || d.error) { alert("Не добавилось: " + (d.error || "")); return; }
    setPayForm({ due_dt: "", amount: "", ratio: "", status: "planned", note: "" });
    setShowPay(false);
    reload();
  }

  async function payPayment(ppId) {
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: ppId, status: "paid" }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не отметилось: " + (d.error || "")); return; }
    reload();
  }

  async function delPayment(ppId) {
    if (!confirm("Удалить платёж из графика?")) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-payments?id=${ppId}`, { method: "DELETE" });
      if (r.status === 404) { alert("Удаление платежей: эндпоинт не реализован в SaaS."); return; }
      const d = await r.json();
      if (!r.ok || d.error) { alert("Не удалилось: " + (d.error || "")); return; }
      reload();
    } catch (e) {
      alert("Сеть: " + e.message);
    }
  }

  const pays = it.payments || [];
  const round2 = (v) => { const n = Number(v) || 0; return Math.round(n * 100) / 100; };

  // Сохранение плановой даты (plan_ship_dt / plan_arrival_dt) через purchases POST.
  async function savePlanDate(field, value) {
    const r = await fetch(`/api/cabinets/${cabinetId}/purchases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, [field]: value || null }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не сохранилось: " + (d.error || "")); return; }
    reload();
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 24 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Заказ</div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 13, marginBottom: 14 }}>
          <span style={{ color: C.faint }}>№ заказа:</span><span>{it.order_no || "—"}</span>
          <span style={{ color: C.faint }}>Кол-во:</span><span>{num(it.qty)} шт</span>
          <span style={{ color: C.faint }}>ИТОГО (Z):</span><span><strong>{rub2(it.calc_Z)}</strong></span>
          <span style={{ color: C.faint }}>Оплачено за товар (W):</span><span style={{ color: C.pos }}>{rub2(it.calc_W)}</span>
          <span style={{ color: C.faint }}>Себест. (AA):</span><span style={{ color: C.accent }}>{money(it.unit_cost)}</span>
          <span style={{ color: C.faint }}>План. отгрузка:</span>
          <DateEdit it={it} field="plan_ship_dt" onCommit={(v) => savePlanDate("plan_ship_dt", v)} />
          <span style={{ color: C.faint }}>План. прибытие:</span>
          <DateEdit it={it} field="plan_arrival_dt" onCommit={(v) => savePlanDate("plan_arrival_dt", v)} />
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Жизненный цикл</div>
        <div style={{ display: "flex", alignItems: "center", gap: 2, marginBottom: 12, flexWrap: "wrap" }}>
          {LIFECYCLE.map((st, i) => (
            <div key={st} style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <span title={LIFECYCLE_LABEL[st]} style={{
                width: 12, height: 12, borderRadius: "50%",
                background: i <= curIdx ? (LIFECYCLE_COLOR[st]?.fg || C.accent) : C.line,
                display: "inline-block",
              }} />
              {i < LIFECYCLE.length - 1 && <span style={{ width: 14, height: 2, background: i < curIdx ? C.accent : C.line }} />}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <LifecycleBadge status={cur} />
          {next ? (
            <button onClick={() => setStage(next)} disabled={advancing} style={advanceBtn}>
              {advancing ? "…" : `→ ${LIFECYCLE_LABEL[next]}`}
            </button>
          ) : (
            <span style={{ fontSize: 12, color: C.pos }}>✓ финальная стадия</span>
          )}
          <select onChange={(e) => e.target.value && setStage(e.target.value)} value="" style={{ ...inputStyle, padding: "4px 8px", width: "auto", fontSize: 12 }} title="Сменить этап вручную">
            <option value="">сменить…</option>
            {LIFECYCLE.map((st) => <option key={st} value={st}>{LIFECYCLE_LABEL[st]}</option>)}
          </select>
        </div>
      </div>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>График платежей</span>
          <button onClick={() => setShowPay((v) => !v)} style={miniBtn}>{showPay ? "✕" : "+ платёж"}</button>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <PayKpi label="ИТОГО (Z)" value={rub2(it.calc_Z)} />
          <PayKpi label="Оплачено за товар (W)" value={rub2(it.calc_W)} color={C.pos} />
          <PayKpi label="Остаток к оплате" value={money(it.calc_balance_due)} color={(it.calc_balance_due || 0) > 0.01 ? C.neg : C.faint} />
          <PayKpi label="След. платёж" value={it.next_pay_dt || "—"} />
          {(it.calc_balance_due || 0) > 0.01 && (
            // Остаток поставщику уже в платёжном календаре автоматически (purchase:<id>:balance) —
            // ручная запись в ДДС задваивала бы его; ведём на месяц даты остатка (как purchasePayments).
            <a href={`/cabinets/${cabinetId}/fin-calendar?month=${(/^\d{4}-\d{2}/.test(String(it.ship_dt || "")) ? it.ship_dt
                : /^\d{4}-\d{2}/.test(String(it.plan_ship_dt || "")) ? it.plan_ship_dt
                : /^\d{4}-\d{2}/.test(String(it.date || "")) ? it.date : new Date().toISOString()).slice(0, 7)}`}
              style={{ ...miniBtn, color: C.accent, alignSelf: "center", textDecoration: "none" }}
              title="Остаток к оплате — в платёжном календаре">в календаре</a>
          )}
        </div>
        {showPay && (
          <div style={{ ...payFormCard, marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <Field label="Дата"><input type="date" value={payForm.due_dt} onChange={(e) => setPayForm({ ...payForm, due_dt: e.target.value })} style={{ ...inputStyle, width: 140, padding: "4px 8px" }} /></Field>
              <Field label="Сумма ₽"><input type="number" step="any" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} style={{ ...inputStyle, width: 110, padding: "4px 8px" }} /></Field>
              <Field label="Доля (0..1)"><input type="number" step="any" value={payForm.ratio} onChange={(e) => setPayForm({ ...payForm, ratio: e.target.value })} placeholder="опц." style={{ ...inputStyle, width: 90, padding: "4px 8px" }} /></Field>
              <Field label="Статус">
                <select value={payForm.status} onChange={(e) => setPayForm({ ...payForm, status: e.target.value })} style={{ ...inputStyle, padding: "4px 8px", width: "auto" }}>
                  <option value="planned">план</option>
                  <option value="paid">оплачен</option>
                </select>
              </Field>
              <Field label="Коммент."><input value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} style={{ ...inputStyle, width: 140, padding: "4px 8px" }} /></Field>
              <button onClick={addPayment} disabled={savingPay} style={addBtnStyle}>{savingPay ? "…" : "Добавить"}</button>
            </div>
          </div>
        )}
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: C.bg, borderBottom: `1px solid ${C.line}` }}>
                <th style={payThL}>Срок</th><th style={payThR}>Сумма</th><th style={payThR}>Доля</th>
                <th style={payThL}>Статус</th><th style={payThL}>Оплачено</th><th style={payThR}></th>
              </tr>
            </thead>
            <tbody>
              {pays.map((pp) => (
                <tr key={pp.id} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{pp.due_dt}</td>
                  <td style={payTdR}><strong style={{ color: C.neg }}>{money(pp.amount)}</strong></td>
                  <td style={payTdR}>{pp.ratio != null ? (pp.ratio * 100).toFixed(0) + "%" : "—"}</td>
                  <td style={{ padding: "6px 8px" }}>
                    {pp.status === "paid" ? (
                      <span style={{ ...badgeStyle, background: soft("pos", 18), color: C.pos }}>✓ оплачен</span>
                    ) : (
                      <span style={{ ...badgeStyle, background: soft("warn", 15), color: C.warn }}>план</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px", color: C.faint }}>{pp.paid_dt || "—"}</td>
                  <td style={payTdR}>
                    {pp.status !== "paid" && <button onClick={() => payPayment(pp.id)} style={{ ...miniBtn, color: C.pos, marginRight: 4 }} title="Отметить оплаченным">✓</button>}
                    <button onClick={() => delPayment(pp.id)} style={{ ...miniBtn, color: C.neg }} title="Удалить">🗑</button>
                  </td>
                </tr>
              ))}
              {pays.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 14, textAlign: "center", color: C.faint }}>
                  Нет платежей. Добавьте аванс/остаток через «+ платёж».
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Inline-редактор даты для разворота (план. отгрузка / план. прибытие).
// Кликабельная кнопка показывает дату или «—», при клике → input[type=date].
function DateEdit({ it, field, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(it[field] ?? ""));
  if (editing) {
    return (
      <input autoFocus type="date" value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => { setEditing(false); if (val !== String(it[field] ?? "")) onCommit(val); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(false); }}
        style={{ ...cellInput, width: 130, padding: "2px 6px", fontSize: 12 }} />
    );
  }
  return (
    <button onClick={() => { setVal(String(it[field] ?? "")); setEditing(true); }}
      style={{ ...cellBtn, textAlign: "left", width: "auto", padding: "2px 6px" }}
      title="Кликни чтобы править дату">
      {it[field] || <span style={{ color: C.faint }}>—</span>}
    </button>
  );
}

function PayKpi({ label, value, color }) {
  return (
    <div style={{ flex: "1 1 110px", minWidth: 110, padding: "8px 10px", borderRadius: 8, background: C.bg, border: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 10, color: C.faint, marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color || C.ink }}>{value}</div>
    </div>
  );
}

function Td({ right, children }) {
  return <td style={right ? tdRight : tdLeft}>{children}</td>;
}

// ---------------- Форма добавления ----------------

function emptyAdd() {
  return {
    supplier_name: "", source_country: "Китай", supplier: "", nm_id: "",
    category: "",
    prepay_yuan: "", prepay_rate: "", qty: "",
    unit_cost_yuan: "", logistics_yuan: "", exchange_rate: "",
    logistics_rub_per_unit: "", logistics_rub: "",
    order_dt: "", ship_dt: "", delivery_dt: "", note: "",
    // status убран: этап (lifecycle_status) заменяет его (решение 2026-06-25).
    // № заказа (order_no) генерируется системой при создании.
  };
}

function AddForm({ form, setForm, onAdd, busy }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div style={formCardStyle}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Новая партия (модель «Себес товара»)</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Наименование"><input value={form.supplier_name} onChange={set("supplier_name")} style={{ ...inputStyle, width: 200 }} placeholder="напр. Видеорегулятор" /></Field>
        <Field label="Где закуплено"><input value={form.source_country} onChange={set("source_country")} style={{ ...inputStyle, width: 110 }} placeholder="Китай / РФ" /></Field>
        <Field label="Поставщик"><input value={form.supplier} onChange={set("supplier")} style={{ ...inputStyle, width: 140 }} /></Field>
        <Field label="Категория"><input value={form.category} onChange={set("category")} style={{ ...inputStyle, width: 150 }} placeholder="напр. Экшн-камеры" /></Field>
        <Field label="nm_id (опц.)"><input value={form.nm_id} onChange={set("nm_id")} style={{ ...inputStyle, width: 120 }} placeholder="в пути" /></Field>
        <Field label="Предоплата ¥ (L)"><input type="number" step="any" value={form.prepay_yuan} onChange={set("prepay_yuan")} style={{ ...inputStyle, width: 110 }} /></Field>
        <Field label="Курс аванса (M)"><input type="number" step="any" value={form.prepay_rate} onChange={set("prepay_rate")} style={{ ...inputStyle, width: 100 }} placeholder="11.5" /></Field>
        <Field label="Кол-во (O)"><input type="number" value={form.qty} onChange={set("qty")} style={{ ...inputStyle, width: 90 }} /></Field>
        <Field label="Цена ¥ (P)"><input type="number" step="any" value={form.unit_cost_yuan} onChange={set("unit_cost_yuan")} style={{ ...inputStyle, width: 100 }} /></Field>
        <Field label="Логист. ¥ (T)"><input type="number" step="any" value={form.logistics_yuan} onChange={set("logistics_yuan")} style={{ ...inputStyle, width: 100 }} /></Field>
        <Field label="Курс ост. (U)"><input type="number" step="any" value={form.exchange_rate} onChange={set("exchange_rate")} style={{ ...inputStyle, width: 100 }} placeholder="11.46" /></Field>
        <Field label="Логист. до МСК/ед ₽ (X)"><input type="number" step="any" value={form.logistics_rub_per_unit} onChange={set("logistics_rub_per_unit")} style={{ ...inputStyle, width: 120 }} /></Field>
        <Field label="Логист. МСК→ФФ/ед ₽ (Y)"><input type="number" step="any" value={form.logistics_rub} onChange={set("logistics_rub")} style={{ ...inputStyle, width: 120 }} /></Field>
        <Field label="Дата заказа"><input type="date" value={form.order_dt} onChange={set("order_dt")} style={inputStyle} /></Field>
        <Field label="Дата отправки"><input type="date" value={form.ship_dt} onChange={set("ship_dt")} style={inputStyle} /></Field>
        <Field label="Дата доставки"><input type="date" value={form.delivery_dt} onChange={set("delivery_dt")} style={inputStyle} /></Field>
        <button onClick={onAdd} disabled={busy} style={addBtnStyle}>{busy ? "…" : "+ Добавить"}</button>
      </div>
      <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
        Себестоимость AA и расчётные поля (N,Q,R,S,V,W,Z) посчитаются автоматически
        по формулам Excel: N=L×M, Q=O×P, R=Q−L, S=M×R, V=P×U, W=R×U+N, Z=W+(X+Y)×O, AA=Z/O.
        № заказа и этап «Планируется» проставятся автоматически.
      </div>
    </div>
  );
}

// ---------------- UI-компоненты ----------------

function Header() {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 4px 0" }}>Закупки (Себес товара)</h1>
    </div>
  );
}

function Centered({ children }) {
  return <div style={{ fontFamily: FONT, color: C.ink, padding: 40, textAlign: "center" }}>{children}</div>;
}

function Kpi({ label, value, color }) {
  return (
    <div style={{
      flex: "1 1 140px", minWidth: 140,
      padding: "12px 16px", borderRadius: 10,
      background: C.surface, border: `1px solid ${C.line}`,
    }}>
      <div style={{ fontSize: 11, color: C.faint, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || C.ink }}>{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.faint }}>
      {label}{children}
    </label>
  );
}

function Pagination({ page, totalPages, setPage, totalItems, pageSize, setPageSize }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, fontSize: 12, color: C.faint, flexWrap: "wrap", gap: 10 }}>
      <div>
        Показано {totalItems === 0 ? 0 : ((page - 1) * (pageSize || totalItems) + 1)}–
        {pageSize === 0 ? totalItems : Math.min(page * pageSize, totalItems)} из {totalItems}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={{ ...inputStyle, padding: "4px 8px", width: "auto" }}>
          <option value={20}>20</option>
          <option value={50}>50</option>
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
const resetBtnStyle = {
  padding: "7px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const addBtnStyle = {
  padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
  background: C.accent, color: "var(--accentInk)", border: "none",
};
const miniBtn = {
  padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const cellInput = {
  padding: "3px 6px", borderRadius: 5, fontSize: 12.5, width: 84,
  background: C.bg, color: C.ink, border: `1px solid ${C.accent}`,
};
// Редактируемая ячейка: subtle фон + левая акцент-полоска, чтобы было ВИДНО,
// что клетку можно кликнуть и поправить (read-only расчётные клетки — без подсветки).
const cellBtn = {
  background: "rgba(0,229,255,0.06)", border: "none",
  borderLeft: `2px solid ${soft("accent", 33)}`, borderRadius: 0,
  cursor: "pointer", color: C.ink, fontFamily: "inherit", fontSize: 12.5,
  fontVariantNumeric: "tabular-nums", padding: "2px 6px", textAlign: "right",
  width: "100%", transition: "background 0.12s",
};
const badgeStyle = { padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" };
const thLeft = { padding: "10px 6px", fontWeight: 600, fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.3, textAlign: "left", whiteSpace: "nowrap" };
const thR = { ...thLeft, textAlign: "right" };
const tdLeft = { padding: "8px 6px", verticalAlign: "middle" };
const tdRight = { padding: "8px 6px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeftFoot = { padding: "10px", textAlign: "left", whiteSpace: "nowrap" };
const tdFootR = { padding: "10px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const formCardStyle = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10,
  padding: "14px 16px", marginBottom: 14,
};
const expandBtnStyle = {
  background: "transparent", border: "none", cursor: "pointer",
  color: C.muted, fontSize: 13, padding: 0, lineHeight: 1,
};
const advanceBtn = {
  padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer",
  background: C.accent, color: "var(--accentInk)", border: "none",
};
const payFormCard = {
  background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px",
};
const payThL = { padding: "7px 8px", fontWeight: 600, fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.3, textAlign: "left" };
const payThR = { ...payThL, textAlign: "right" };
const payTdR = { padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", verticalAlign: "middle" };
