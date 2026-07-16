"use client";
import { C, soft } from "@/lib/palette.js";

import { useEffect, useMemo, useState } from "react";

const ALERT = {
  warn: { background: "rgba(251,191,36,0.10)", border: "1px solid rgba(251,191,36,0.35)", color: "#fbbf24" },
  info: { background: "rgba(79,140,255,0.10)", border: "1px solid rgba(79,140,255,0.35)", color: "#4f8cff" },
};

// =====================================================================
//  /finance/self-buyouts — самовыкупы (контракт №34, редактируемый с 2026-06-26).
//
//  Источник правды = ДАШБОРД (контракт №37, DB-first). Раньше был RO с
//  источником в Google Sheets. Sheets = backup по кнопке «💾 В Sheets»
//  (run.py backup push --only self_buyouts). С 2026-06-25 фин-агент не
//  тянет/не пушит Sheets, поэтому правки идут только из UI.
//
//  Редактирование: клик по ячейке вводного поля → input → Enter/blur →
//  POST {id, ...все 12 полей}. 7 формульных колонок пересчитываются на
//  сервере (эталон fin/db_local.py:250-257) и обновляются после сохранения.
//
//  ⚠️ В P&L НЕ ВХОДИТ — параллельный справочный отчёт (решение владельца).
//     total — ОТРИЦАТЕЛЬНОЕ (затраты продавца), buyout_total — cash-out.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(x) + " ₽";
};
const pct = (v) => {
  if (v == null || !Number.isFinite(v)) return "—";
  return (Math.round(v * 1000) / 10).toLocaleString("ru-RU") + "%";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const dash = (v) => (v == null || v === "" ? "—" : v);

// Вводные поля, доступные для правки. key → {type, step, placeholder}.
const INPUT_FIELDS = {
  claim_dt: { type: "date", label: "Дата" },
  nm_id: { type: "number", label: "Артикул WB" },
  seller_article: { type: "text", label: "Арт. продавца" },
  qty: { type: "number", label: "Кол-во" },
  price: { type: "number", label: "Цена ₽", step: "0.01" },
  wb_discount: { type: "number", label: "Скидка", step: "0.01" },
  spp: { type: "number", label: "СПП", step: "0.01" },
  commission_pct: { type: "number", label: "Комиссия", step: "0.01" },
  constructor_pct: { type: "number", label: "%констр.", step: "0.01" },
  logistics_unit: { type: "number", label: "Логистика ед", step: "0.01" },
  buyout_price: { type: "number", label: "Цена выкупа", step: "0.01" },
  tax_pct: { type: "number", label: "Налог %", step: "0.01" },
};

function emptyAdd() {
  return {
    claim_dt: new Date().toISOString().slice(0, 10),
    nm_id: "",
    seller_article: "",
    qty: "",
    price: "",
    wb_discount: "",
    spp: "",
    commission_pct: "",
    constructor_pct: "",
    logistics_unit: "",
    buyout_price: "",
    tax_pct: "",
  };
}

export default function SelfBuyoutsPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [nm, setNm] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // per-cell editing: editKey = `${id}|${field}`, editText = текущий ввод.
  const [editKey, setEditKey] = useState(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);

  // add form
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState(emptyAdd());

  // Sheets backup
  const [backup, setBackup] = useState(null);

  const api = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (nm.trim()) p.set("nm", nm.trim());
    if (q.trim()) p.set("q", q.trim());
    return `/api/cabinets/${cabinetId}/self-buyouts?` + p.toString();
  }, [from, to, nm, q]);

  const reload = () => {
    setData(null);
    setError(null);
    fetch(api)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  };
  useEffect(reload, [api]);

  useEffect(() => {
    setPage(1);
  }, [from, to, nm, q, pageSize]);

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка…</Centered>;

  const { items, totals } = data;

  // Пагинация.
  const totalPages = pageSize === 0 ? 1 : Math.ceil(items.length / pageSize);
  const safePage = Math.min(page, totalPages || 1);
  const slice = pageSize === 0 ? items : items.slice((safePage - 1) * pageSize, safePage * pageSize);

  // ---- per-cell editing ----
  function startCell(it, field) {
    const meta = INPUT_FIELDS[field];
    let val = it[field];
    if (meta.type === "date") val = (val || "").slice(0, 10);
    else if (val == null) val = "";
    setEditKey(`${it.id}|${field}`);
    setEditText(String(val));
  }

  async function saveCell(it, field) {
    if (saving) return;
    const meta = INPUT_FIELDS[field];
    let body = { id: it.id };
    let raw = editText;
    if (meta.type === "text") {
      body[field] = raw;
    } else {
      body[field] = raw === "" ? "" : Number(raw);
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/self-buyouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        alert("Не сохранилось: " + (d.error || ""));
      } else {
        setEditKey(null);
        reload();
      }
    } catch (e) {
      alert("Сеть: " + e);
    } finally {
      setSaving(false);
    }
  }

  async function delRow(id) {
    if (!confirm("Удалить запись самовыкупа? (hard delete; копия сохранится в audit)")) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/self-buyouts?id=${id}`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok || d.error) {
      alert("Не удалилось: " + (d.error || ""));
      return;
    }
    reload();
  }

  async function addRecord() {
    setAdding(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/self-buyouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addForm),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        alert("Не добавилось: " + (d.error || ""));
        return;
      }
      setAddForm(emptyAdd());
      setShowAdd(false);
      reload();
    } catch (e) {
      alert("Сеть: " + e);
    } finally {
      setAdding(false);
    }
  }

  async function doBackup() {
    if (!confirm("Выгрузить самовыкупы в Google Sheets? (backup в «Расчет раздачь и самовыкупов»)")) return;
    setBackup({ busy: true });
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/self-buyouts?action=backup`, { method: "POST" });
      const d = await r.json();
      if (!r.ok || d.error) {
        setBackup({ ok: false, error: d.error || d.log || "backup провалился" });
      } else {
        setBackup({ ok: true, log: d.log });
      }
    } catch (e) {
      setBackup({ ok: false, error: String(e) });
    }
  }

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1700, margin: "0 auto" }}>
      <Header />

      {/* KPI-плитки. total < 0 → красным (расход). buyout_total > 0 → cash-out. */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Записей" value={num(totals.rows)} />
        <Kpi label="Σ шт" value={num(totals.qty)} />
        <Kpi label="Σ cash-out (услуга выкупа)" value={money(totals.buyoutTotal)} hint="чистый расход на выкуп, того нет в WB API" />
        <Kpi label="Σ затраты продавца (total)" value={money(totals.total)} color={C.neg} hint="обычно отрицательное — чистые затраты" />
        <Kpi label="SKU с nm_id" value={`${totals.hasNm} / ${totals.rows}`} />
      </div>

      {/* Фильтры */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
        <Field label="С даты заявки">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="По дату">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Артикул WB (nm_id)">
          <input
            value={nm}
            onChange={(e) => setNm(e.target.value.replace(/\D/g, ""))}
            placeholder="напр. 401354438"
            style={{ ...inputStyle, width: 160 }}
          />
        </Field>
        <Field label="Поиск">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="арт. продавца или nm_id"
            style={{ ...inputStyle, width: 200 }}
          />
        </Field>
        <button
          onClick={() => { setFrom(""); setTo(""); setNm(""); setQ(""); }}
          style={resetBtnStyle}
        >
          Сбросить
        </button>
        <button
          onClick={() => setShowAdd((v) => !v)}
          style={{ ...addBtnStyle, background: showAdd ? C.surface : C.accent, color: showAdd ? C.ink : "#0A1A1C" }}
        >
          {showAdd ? "✕ Закрыть" : "+ Добавить"}
        </button>
        <button onClick={doBackup} disabled={backup?.busy} style={resetBtnStyle} title="Выгрузить в Google Sheets">
          {backup?.busy ? "⏳ Выгрузка…" : "💾 В Sheets"}
        </button>
      </div>

      {backup && !backup.busy && (
        <div style={{ ...alertStyle, marginBottom: 12, ...(backup.ok ? {} : { border: `1px solid ${C.neg}` }) }}>
          {backup.ok ? "✅ Выгружено в Google Sheets." : "❌ " + (backup.error || "ошибка")}
          {backup.log ? (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: "pointer", color: C.faint }}>лог</summary>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{backup.log}</pre>
            </details>
          ) : null}
        </div>
      )}

      {showAdd && (
        <AddForm
          form={addForm}
          setForm={setAddForm}
          onAdd={addRecord}
          adding={adding}
        />
      )}


      {/* Таблица */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surface, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}>Товар</th>
              <th style={thR}>Дата заявки</th>
              <th style={thR}>Кол-во</th>
              <th style={thR}>Цена ₽</th>
              <th style={thR}>Скидка ВБ</th>
              <th style={thR}>СПП</th>
              <th style={thR}>Σ без СПП (K)</th>
              <th style={thR}>Σ с СПП (L)</th>
              <th style={thR}>Комиссия ₽ (O)</th>
              <th style={thR}>Логистика ₽ (Q)</th>
              <th style={thR}>Цена выкупа</th>
              <th style={thR}>cash-out (S)</th>
              <th style={thR}>Налог ₽ (U)</th>
              <th style={thR}>Итого (total)</th>
              <th style={thR}> </th>
            </tr>
          </thead>
          <tbody>
            {slice.map((it) => (
              <tr key={it.id} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                {/* Композитная колонка Товар */}
                <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {it.im_url ? (
                      <img
                        src={it.im_url}
                        alt=""
                        width={40}
                        height={40}
                        style={{ borderRadius: 6, objectFit: "cover", border: `1px solid ${C.line}` }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 40, height: 40, borderRadius: 6, background: C.surface, color: C.faint,
                          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
                          border: `1px solid ${C.line}`,
                        }}
                      >📦</div>
                    )}
                    <div>
                      <CellEdit
                        it={it} field="seller_article" editKey={editKey} editText={editText}
                        setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
                        render={(v) => <span style={{ fontWeight: 600 }}>{dash(v)}</span>}
                        width={150}
                      />
                      <div style={{ fontSize: 11, color: C.faint }}>
                        <CellEdit
                          it={it} field="nm_id" editKey={editKey} editText={editText}
                          setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
                          render={(v) => (v ? `nm ${v}` : "nm —")}
                          inline
                        />
                        {it.wb_name ? ` · ${it.wb_name}` : ""}
                      </div>
                    </div>
                  </div>
                </td>
                <CellTd it={it} field="claim_dt" editKey={editKey} editText={editText}
                  setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
                  render={(v) => dash(v)} right />
                <CellTd it={it} field="qty" editKey={editKey} editText={editText}
                  setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
                  render={(v) => num(v)} right />
                <CellTd it={it} field="price" editKey={editKey} editText={editText}
                  setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
                  render={(v) => money(v)} right />
                <CellTd it={it} field="wb_discount" editKey={editKey} editText={editText}
                  setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
                  render={(v) => pct(v)} right />
                <CellTd it={it} field="spp" editKey={editKey} editText={editText}
                  setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
                  render={(v) => pct(v)} right />
                {/* формульные — read-only */}
                <Td right>{money(it.sum_no_spp)}</Td>
                <Td right>{money(it.sum_with_spp)}</Td>
                <Td right>{money(it.commission_rub)}</Td>
                <Td right>{money(it.logistics_total)}</Td>
                <CellTd it={it} field="buyout_price" editKey={editKey} editText={editText}
                  setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
                  render={(v) => money(v)} right />
                <Td right><span style={{ color: ALERT?.warn?.text }}>{money(it.buyout_total)}</span></Td>
                {/* tax_pct редактируется, tax_total — нет */}
                <Td right>{money(it.tax_total)}</Td>
                <Td right><strong style={{ color: C.neg }}>{money(it.total)}</strong></Td>
                <td style={tdRight}>
                  <button onClick={() => delRow(it.id)} title="Удалить" style={delBtn}>🗑</button>
                </td>
              </tr>
            ))}
            {slice.length === 0 && (
              <tr>
                <td colSpan={15} style={{ padding: 24, textAlign: "center", color: C.faint }}>
                  Нет записей по выбранным фильтрам
                </td>
              </tr>
            )}
          </tbody>
          {/* Итоговая строка */}
          {items.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.line}`, background: C.surface, fontWeight: 700 }}>
                <td style={tdLeftFoot}>Итого ({totals.rows})</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{num(totals.qty)}</td>
                <td style={tdFootR} colSpan={9}>
                  cash-out: <span style={{ color: ALERT?.warn?.text }}>{money(totals.buyoutTotal)}</span>
                </td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}><span style={{ color: C.neg }}>{money(totals.total)}</span></td>
                <td style={tdFootR}> </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Подсказка: редактирование tax_pct (его нет отдельной колонкой, правится через ...) */}
      {/* Поле tax_pct вынесено в колонку-меню т.к. соответствующая формульная = tax_total */}
      <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
        Подсказка: ставка налога (%) правится двойным кликом по ячейке «Налог ₽ (U)» — она вводная.
      </div>

      {/* Пагинация */}
      <Pagination
        page={safePage} totalPages={totalPages} setPage={setPage}
        totalItems={items.length} pageSize={pageSize} setPageSize={setPageSize}
      />
    </div>
  );

  // ---- Форма добавления ----
  function AddForm({ form, setForm, onAdd, adding }) {
    return (
      <div style={{ ...cardStyle, marginBottom: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Новая запись самовыкупа</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
          {Object.entries(INPUT_FIELDS).map(([key, meta]) => (
            <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.faint }}>
              {meta.label}
              <input
                type={meta.type}
                step={meta.step}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                style={inputStyle}
                placeholder={meta.label}
              />
            </label>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={onAdd} disabled={adding} style={addBtnStyle}>
            {adding ? "…" : "+ Добавить запись"}
          </button>
        </div>
        <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
          Обязательные: Дата, Кол-во, Цена. Доли (скидка/СПП/комиссия/налог) вводятся как 0.06, не 6%. Формульные
          колонки посчитаются автоматически.
        </div>
      </div>
    );
  }
}

// ---------------- UI-компоненты ----------------

/** Редактируемая ячейка-столбец (full <td>). */
function CellTd({ it, field, editKey, editText, setEditKey, setEditText, startCell, saveCell, render, right }) {
  const active = editKey === `${it.id}|${field}`;
  const meta = INPUT_FIELDS[field];
  return (
    <td style={right ? tdRight : tdLeft}>
      <CellEdit
        it={it} field={field} editKey={editKey} editText={editText}
        setEditKey={setEditKey} setEditText={setEditText} startCell={startCell} saveCell={saveCell}
        render={render} active={active} meta={meta}
      />
    </td>
  );
}

/** Внутренний редактор ячейки (используется и в td, и inline в составной колонке). */
function CellEdit({ it, field, editKey, editText, setEditKey, setEditText, startCell, saveCell, render, active, meta, width, inline }) {
  const isActive = active ?? (editKey === `${it.id}|${field}`);
  const m = meta || INPUT_FIELDS[field];
  const commit = () => saveCell(it, field);
  if (isActive) {
    return (
      <input
        autoFocus
        type={m.type}
        step={m.step}
        value={editText}
        onChange={(e) => setEditText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditKey(null);
        }}
        style={{ ...inputStyle, padding: "3px 6px", width: width || (m.type === "text" ? 140 : 90) }}
      />
    );
  }
  // display: кликабельная кнопка-ячейка (визуально почти как текст).
  return (
    <button
      onClick={() => startCell(it, field)}
      title={m.label}
      style={{
        ...(inline ? { display: "inline" } : {}),
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: "inherit",
        font: "inherit",
        padding: "2px 4px",
        borderRadius: 4,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.04)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {render(it[field])}
    </button>
  );
}

function Header() {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 4px 0" }}>Самовыкупы</h1>
      <div style={{ color: C.faint, fontSize: 13 }}>
        <strong>Источник правды — дашборд</strong>. Google Sheets «Расчет раздачь и самовыкупов» = backup.
        Параллельный справочный отчёт — в P&L не входит.
      </div>
    </div>
  );
}

function Centered({ children }) {
  return <div style={{ fontFamily: FONT, color: C.ink, padding: 40, textAlign: "center" }}>{children}</div>;
}

function Kpi({ label, value, color, hint }) {
  return (
    <div
      style={{
        flex: "1 1 160px", minWidth: 160, padding: "12px 16px", borderRadius: 10,
        background: C.surface, border: `1px solid ${C.line}`,
      }}
      title={hint}
    >
      <div style={{ fontSize: 11, color: C.faint, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || C.ink }}>{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.faint }}>
      {label}
      {children}
    </label>
  );
}

function Td({ right, children }) {
  return <td style={right ? tdRight : tdLeft}>{children}</td>;
}

function Pagination({ page, totalPages, setPage, totalItems, pageSize, setPageSize }) {
  return (
    <div
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginTop: 14, fontSize: 12, color: C.faint, flexWrap: "wrap", gap: 10,
      }}
    >
      <div>
        Показано {totalItems === 0 ? 0 : (page - 1) * (pageSize || totalItems) + 1}–
        {pageSize === 0 ? totalItems : Math.min(page * pageSize, totalItems)} из {totalItems}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          style={{ ...inputStyle, padding: "4px 8px", width: "auto" }}
        >
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
  padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink,
  border: `1px solid ${C.line}`, minWidth: 130,
};
const resetBtnStyle = {
  padding: "7px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const addBtnStyle = {
  padding: "7px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer",
  background: C.accent, color: "#0A1A1C", border: "none", fontWeight: 600,
};
const delBtn = {
  background: "transparent", border: "none", cursor: "pointer", fontSize: 15,
  padding: "2px 6px", borderRadius: 4,
};
const miniBtn = {
  padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const cardStyle = {
  padding: 14, borderRadius: 10, background: C.surface, border: `1px solid ${C.line}`,
};
const thLeft = {
  padding: "10px", fontWeight: 600, fontSize: 12, color: C.faint,
  textTransform: "uppercase", letterSpacing: 0.4,
};
const thR = { ...thLeft, textAlign: "right" };
const tdLeft = { padding: "8px 10px", verticalAlign: "middle" };
const tdRight = {
  padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums",
};
const tdLeftFoot = { padding: "10px", textAlign: "left" };
const tdFootR = { padding: "10px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const alertStyle = {
  padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
  background: ALERT?.bg || "rgba(255,193,7,0.08)",
  border: `1px solid ${ALERT?.line || "rgba(255,193,7,0.3)"}`,
  color: ALERT?.text || C.ink,
};
