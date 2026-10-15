"use client";
import { C, soft } from "@/lib/palette.js";
import { defaultMonthPeriod } from "@/lib/period.js";
import FinanceMoneyTabs from "../fin-calendar/FinanceMoneyTabs.jsx";

import { useEffect, useState, useCallback } from "react";


// =====================================================================
//  /finance/dds — движение денежных средств (заявка №37, контракт №38).
//
//  Источник правды = fin_data.db.dds_movements (дашборд-first). Sheets = backup.
//  В P&L НЕ входит — это cash-flow, не прибыль (прибыль ≠ деньги).
//  ОТДЕЛЬНО от bank_transactions (legacy для cashflow.py).
//
//  Форма: дата + тип(income/expense) + сумма + категория + контрагент +
//  описание + платформа + артикул + тип поступления + счета.
//  Таблица периода с инлайн-редактированием + удалить. KPI за период.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => new Date().toISOString().slice(0, 7) + "-01";

const CATEGORIES = ["Закупка", "Налоги", "ЗП", "Реклама", "Возврат МП", "Прочее"];
const INCOME_TYPES = ["wb_payout", "ozon_payout", "client_return", "owner_inject", "credit"];
const ACCOUNTS = ["расчётный", "карта", "касса", "wb_cabinet", "ozon_cabinet"];

export default function DdsPage({ cabinetId }) {
  // Дефолт — месяц по вчера (решение владельца 2026-08-25), хелпер из
  // lib/period.js (не копия арифметики). monthStart()/today() остаются
  // ниже — их использует явная кнопка «Этот месяц» (сброс, не дефолт) и
  // форма добавления записи (операционная дата документа).
  const [from, setFrom] = useState(() => defaultMonthPeriod().from);
  const [to, setTo] = useState(() => defaultMonthPeriod().to);
  const [typeFilter, setTypeFilter] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Форма добавления
  const [f, setF] = useState(emptyForm());
  const [adding, setAdding] = useState(false);
  // Инлайн-редактирование (полная строка — много полей)
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState(null);

  // ── Авто-черновик из источников (2026-06-27). ──
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftData, setDraftData] = useState(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftErr, setDraftErr] = useState(null);
  const [draftChecked, setDraftChecked] = useState({}); // {<srcKey|date|...>: true}

  const api = useCallback(() => {
    const p = new URLSearchParams();
    if (from) p.set("date_from", from);
    if (to) p.set("date_to", to);
    if (typeFilter) p.set("type", typeFilter);
    return `/api/cabinets/${cabinetId}/dds?` + p.toString();
  }, [from, to, typeFilter]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(api())
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { reload(); }, [reload]);

  async function addRecord() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { alert("Дата должна быть ГГГГ-ММ-ДД"); return; }
    const amount = Number(f.amount);
    if (!Number.isFinite(amount) || amount <= 0) { alert("Сумма > 0"); return; }
    setAdding(true);
    const body = { ...f, amount };
    if (body.nm_id === "") body.nm_id = null;
    const r = await fetch(`/api/cabinets/${cabinetId}/dds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    setAdding(false);
    if (!r.ok || d.error) { alert("Не добавилось: " + (d.error || "")); return; }
    setF(emptyForm());
    reload();
  }

  async function saveEdit() {
    if (!editVal) return;
    const amount = Number(editVal.amount);
    if (!Number.isFinite(amount) || amount <= 0) { alert("Сумма > 0"); return; }
    const r = await fetch(`/api/cabinets/${cabinetId}/dds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...editVal, amount, id: editId }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не сохранилось: " + (d.error || "")); return; }
    setEditId(null); setEditVal(null);
    reload();
  }

  async function delRecord(id) {
    if (!confirm("Удалить движение? (мягкое удаление — в архив)")) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/dds?id=${id}`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok || d.error) { alert("Не удалилось: " + (d.error || "")); return; }
    reload();
  }

  // ── Авто-черновик из источников. ──
  async function openDraft() {
    setDraftOpen(true);
    setDraftErr(null);
    setDraftData(null);
    setDraftChecked({});
    setDraftLoading(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/dds?type=income`);
      const d = await r.json();
      if (!r.ok || d.error) { setDraftErr(d.error || "Ошибка"); }
      else {
        setDraftData(d);
        // По умолчанию отмечаем все новые (не exists).
        const init = {};
        (d.sources || []).forEach((s) => {
          (s.items || []).forEach((it) => {
            if (!it.exists) init[draftItemKey(s.key, it)] = true;
          });
        });
        setDraftChecked(init);
      }
    } catch (e) { setDraftErr(String(e)); }
    finally { setDraftLoading(false); }
  }

  async function applyDraft() {
    if (!draftData) return;
    const selected = [];
    (draftData.sources || []).forEach((s) => {
      (s.items || []).forEach((it) => {
        if (draftChecked[draftItemKey(s.key, it)]) {
          selected.push({
            date: it.date, type: it.type, amount: it.amount, category: it.category,
            counterparty: it.counterparty, description: it.description, source: it.source,
            platform: it.platform, income_type: it.income_type,
            account_from: it.account_from, account_to: it.account_to,
            status: "planned",
          });
        }
      });
    });
    if (selected.length === 0) { alert("Ничего не отмечено"); return; }
    if (!confirm(`Записать ${selected.length} черновых движений ДДС (status=planned)?`)) return;
    setDraftLoading(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/dds?type=expense`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: selected }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { setDraftErr(d.error || "Ошибка"); setDraftLoading(false); return; }
      setDraftOpen(false);
      reload();
    } catch (e) { setDraftErr(String(e)); setDraftLoading(false); }
  }

  function draftItemKey(srcKey, it) {
    return `${srcKey}|${it.date}|${it.amount}|${it.category || ""}`;
  }

  const totals = data?.totals || { income_total: 0, expense_total: 0, net: 0, count: 0, by_category: [] };
  const items = data?.items || [];

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1400, margin: "0 auto" }}>
      <FinanceMoneyTabs cabinetId={cabinetId} active="dds" />
      <Header />

      <div style={{ ...alertStyle, marginBottom: 16 }}>
        <strong>ДДС</strong> — движение денег по датам (cash-flow). Поступления (income) и списания
        (expense). <strong>В P&L НЕ входит</strong> — это про деньги, а не про прибыль (прибыль ≠ деньги).
        Источник правды = дашборд (fin_data.db.dds_movements). Sheets = backup. Кнопка
        <strong> «⚡ Черновик из источников»</strong> собирает поступления от МП, налоги, оплаты закупок и
        OPEX — подтвердите нужные строки (статус planned). Авто-строки помечены ⚡.
      </div>

      {/* Период + фильтр типа */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <Field label="С даты"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} /></Field>
        <Field label="По дату"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} /></Field>
        <Field label="Тип">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={inputStyle}>
            <option value="">Все</option>
            <option value="income">Поступления</option>
            <option value="expense">Списания</option>
          </select>
        </Field>
        <button onClick={() => { setFrom(monthStart()); setTo(today()); setTypeFilter(""); }} style={resetBtnStyle}>Этот месяц</button>
        <button onClick={openDraft} style={draftBtnStyle}>⚡ Черновик из источников</button>
      </div>

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Σ поступления" value={money(totals.income_total)} color={C.pos} />
        <Kpi label="Σ списания" value={money(totals.expense_total)} color={C.neg} />
        <Kpi label="Net за период" value={money(totals.net)} color={totals.net >= 0 ? C.pos : C.neg} />
        <Kpi label="Движений" value={String(totals.count)} />
      </div>

      {/* Форма добавления */}
      <div style={formCardStyle}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Новое движение</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Дата"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={inputStyle} /></Field>
          <Field label="Тип">
            <div style={{ display: "flex", gap: 4 }}>
              {["income", "expense"].map((t) => (
                <button key={t} onClick={() => setF({ ...f, type: t })}
                  style={{ ...typeBtn, background: f.type === t ? (t === "income" ? "rgba(76,175,80,0.25)" : "rgba(244,67,54,0.25)") : C.bg, color: f.type === t ? (t === "income" ? C.pos : C.neg) : C.muted, borderColor: f.type === t ? (t === "income" ? C.pos : C.neg) : C.line }}>
                  {t === "income" ? "↓ Поступление" : "↑ Списание"}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Сумма ₽"><input type="number" step="any" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addRecord(); }} placeholder="0.00" style={{ ...inputStyle, width: 120 }} /></Field>
          <Field label="Категория">
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={inputStyle}>
              <option value="">—</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Контрагент"><input value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} placeholder="опц." style={{ ...inputStyle, width: 160 }} /></Field>
          <Field label="Описание"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ ...inputStyle, width: 200 }} /></Field>
          <Field label="Платформа">
            <select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })} style={inputStyle}>
              <option value="">—</option>
              <option value="WB">WB</option>
              <option value="OZON">OZON</option>
            </select>
          </Field>
          <Field label="Артикул (nm_id)"><input value={f.nm_id} onChange={(e) => setF({ ...f, nm_id: e.target.value })} placeholder="опц." style={{ ...inputStyle, width: 110 }} /></Field>
          {f.type === "income" && (
            <Field label="Тип поступления">
              <select value={f.income_type} onChange={(e) => setF({ ...f, income_type: e.target.value })} style={inputStyle}>
                <option value="">—</option>
                {INCOME_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          )}
          <Field label="Счёт откуда">
            <select value={f.account_from} onChange={(e) => setF({ ...f, account_from: e.target.value })} style={inputStyle}>
              <option value="">—</option>
              {ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Счёт куда">
            <select value={f.account_to} onChange={(e) => setF({ ...f, account_to: e.target.value })} style={inputStyle}>
              <option value="">—</option>
              {ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <button onClick={addRecord} disabled={adding} style={addBtnStyle}>{adding ? "…" : "+ Добавить"}</button>
        </div>
      </div>

      {error && <div style={{ color: C.neg, margin: "12px 0" }}>⚠ {error}</div>}

      {/* Таблица движений */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, marginTop: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1000 }}>
          <thead>
            <tr style={{ background: C.surface, borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}>Дата</th>
              <th style={thLeft}>Тип</th>
              <th style={thR}>Сумма</th>
              <th style={thLeft}>Категория</th>
              <th style={thLeft}>Контрагент</th>
              <th style={thLeft}>Описание</th>
              <th style={thLeft}>Счета</th>
              <th style={thR}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              editId === it.id && editVal ? (
                <EditRow key={it.id} ev={editVal} setEv={setEditVal} onSave={saveEdit} onCancel={() => { setEditId(null); setEditVal(null); }} />
              ) : (
                <tr key={it.id} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{it.date}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {it.type === "income" ? (
                      <span style={{ ...badgeStyle, background: "rgba(76,175,80,0.18)", color: C.pos }}>↓ {it.income_type || "поступление"}</span>
                    ) : (
                      <span style={{ ...badgeStyle, background: "rgba(244,67,54,0.18)", color: C.neg }}>↑ списание</span>
                    )}
                    {it.source && it.source !== "manual" && (
                      <span title={`авто: ${it.source}`} style={{ ...badgeStyle, marginLeft: 4, background: "rgba(0,229,255,0.12)", color: C.accent, fontSize: 10 }}>⚡</span>
                    )}
                  </td>
                  <td style={tdRight}>
                    <strong style={{ color: it.type === "income" ? C.pos : C.neg }}>
                      {it.type === "income" ? "+" : "−"}{money(it.amount)}
                    </strong>
                  </td>
                  <td style={{ padding: "8px 10px" }}>{it.category || "—"}</td>
                  <td style={{ padding: "8px 10px", color: C.muted }}>{it.counterparty || "—"}</td>
                  <td style={{ padding: "8px 10px", color: C.muted, maxWidth: 240 }}>{it.description || "—"}</td>
                  <td style={{ padding: "8px 10px", color: C.faint, fontSize: 11 }}>
                    {it.account_from || "—"} → {it.account_to || "—"}
                  </td>
                  <td style={tdRight}>
                    <button onClick={() => { setEditId(it.id); setEditVal({ ...it }); }} style={miniBtn} title="Править">✎</button>
                    <button onClick={() => delRecord(it.id)} style={{ ...miniBtn, color: C.neg, marginLeft: 4 }} title="Удалить">🗑</button>
                  </td>
                </tr>
              )
            ))}
            {items.length === 0 && !loading && (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: C.faint }}>
                Нет движений за выбранный период. Добавьте первое через форму выше.
              </td></tr>
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.line}`, background: C.surface, fontWeight: 700 }}>
                <td style={tdLeftFoot}>Итого ({totals.count})</td>
                <td></td>
                <td style={tdFootR}>
                  <span style={{ color: C.pos }}>+{money(totals.income_total)}</span>
                  {" / "}
                  <span style={{ color: C.neg }}>−{money(totals.expense_total)}</span>
                </td>
                <td style={tdFootR} colSpan={5}>
                  Net: <span style={{ color: totals.net >= 0 ? C.pos : C.neg }}>{money(totals.net)}</span>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Модал авто-черновика */}
      {draftOpen && (
        <DraftModal
          data={draftData} loading={draftLoading} err={draftErr}
          checked={draftChecked} setChecked={setDraftChecked}
          draftItemKey={draftItemKey}
          onApply={applyDraft} onClose={() => setDraftOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------- Модал авто-черновика ----------------

function DraftModal({ data, loading, err, checked, setChecked, draftItemKey, onApply, onClose }) {
  const sources = data?.sources || [];
  const allItems = sources.flatMap((s) => (s.items || []).map((it) => ({ s, it })));
  const checkedCount = allItems.filter(({ s, it }) => checked[draftItemKey(s.key, it)]).length;
  const checkedInc = allItems.filter(({ s, it }) => checked[draftItemKey(s.key, it)] && it.type === "income").reduce((a, { it }) => a + (it.amount || 0), 0);
  const checkedExp = allItems.filter(({ s, it }) => checked[draftItemKey(s.key, it)] && it.type === "expense").reduce((a, { it }) => a + (it.amount || 0), 0);
  const toggle = (k) => setChecked({ ...checked, [k]: !checked[k] });

  return (
    <div style={modalOverlay} onClick={onClose}>
      <div style={modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>⚡ Черновик из источников</h2>
          <button onClick={onClose} style={miniBtn}>✕</button>
        </div>
        <div style={{ ...alertStyle, marginBottom: 12, fontSize: 11 }}>
          Поступления от WB/Ozon (факт выплат), налоги (УСН + НДС по режиму магазина),
          оплаты по закупкам и регулярные OPEX — собираются автоматически. Отметьте
          нужное → «Применить» запишет в <code>dds_movements</code> со статусом
          <strong> planned</strong> (черновик). Уже существующие строки отмечены серым.
        </div>

        {loading && <div style={{ padding: 20, textAlign: "center", color: C.faint }}>Сбор данных…</div>}
        {err && <div style={{ color: C.neg, marginBottom: 10 }}>⚠ {err}</div>}

        {data && !loading && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <Kpi label="Отмечено" value={String(checkedCount)} color={C.accent} />
              <Kpi label="Поступления" value={money(checkedInc)} color={C.pos} />
              <Kpi label="Списания" value={money(checkedExp)} color={C.neg} />
              <Kpi label="Net отмеч." value={money(checkedInc - checkedExp)} />
            </div>

            {allItems.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: C.faint }}>
                Нет новых данных от источников за период.
              </div>
            ) : (
              <div style={{ maxHeight: 420, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
                {sources.map((s) => {
                  const items = s.items || [];
                  if (items.length === 0) return null;
                  return (
                    <div key={s.key} style={{ borderBottom: `1px solid ${C.line}` }}>
                      <div style={{ background: C.surface, padding: "8px 12px", fontWeight: 700, fontSize: 12, display: "flex", justifyContent: "space-between" }}>
                        <span>{s.label} <span style={{ color: s.type === "income" ? C.pos : C.neg, fontSize: 10 }}>({s.type === "income" ? "поступления" : "списания"})</span></span>
                        <span style={{ color: C.muted, fontSize: 10 }}>{items.length} стр.</span>
                      </div>
                      {items.map((it) => {
                        const k = draftItemKey(s.key, it);
                        const isChk = !!checked[k];
                        return (
                          <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${soft("line", 13)}`, opacity: it.exists ? 0.45 : 1, cursor: it.exists ? "not-allowed" : "pointer" }}>
                            <input type="checkbox" disabled={it.exists} checked={isChk && !it.exists} onChange={() => toggle(k)} />
                            <span style={{ width: 80, fontSize: 11, color: C.muted, flexShrink: 0 }}>{it.date}</span>
                            <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {it.description || it.category || s.label}
                              {it.counterparty && <span style={{ color: C.faint }}> · {it.counterparty}</span>}
                            </span>
                            <strong style={{ fontSize: 12, color: it.type === "income" ? C.pos : C.neg, flexShrink: 0 }}>
                              {it.type === "income" ? "+" : "−"}{money(it.amount)}
                            </strong>
                            {it.exists && <span style={{ fontSize: 9, color: C.faint }}>есть</span>}
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
              <button onClick={onApply} disabled={loading || checkedCount === 0} style={{ ...addBtnStyle, opacity: checkedCount === 0 ? 0.5 : 1 }}>
                Применить ({checkedCount})
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- Строка редактирования (все поля инпутами) ----------------
function EditRow({ ev, setEv, onSave, onCancel }) {
  const up = (k) => (e) => setEv({ ...ev, [k]: e.target.value });
  return (
    <tr style={{ borderBottom: `1px solid ${soft("line", 20)}`, background: "rgba(0,229,255,0.04)" }}>
      <td style={{ padding: "4px 8px" }}><input type="date" value={ev.date || ""} onChange={up("date")} style={{ ...inputStyle, width: 140, padding: "3px 6px" }} /></td>
      <td style={{ padding: "4px 8px" }}>
        <select value={ev.type} onChange={up("type")} style={{ ...inputStyle, padding: "3px 6px" }}>
          <option value="income">поступление</option>
          <option value="expense">списание</option>
        </select>
      </td>
      <td style={{ padding: "4px 8px" }}><input type="number" step="any" value={ev.amount} onChange={up("amount")} style={{ ...inputStyle, width: 100, padding: "3px 6px" }} /></td>
      <td style={{ padding: "4px 8px" }}>
        <select value={ev.category || ""} onChange={up("category")} style={{ ...inputStyle, padding: "3px 6px" }}>
          <option value="">—</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </td>
      <td style={{ padding: "4px 8px" }}><input value={ev.counterparty || ""} onChange={up("counterparty")} style={{ ...inputStyle, width: 140, padding: "3px 6px" }} /></td>
      <td style={{ padding: "4px 8px" }}><input value={ev.description || ""} onChange={up("description")} style={{ ...inputStyle, width: 180, padding: "3px 6px" }} /></td>
      <td style={{ padding: "4px 8px" }}>
        <div style={{ display: "flex", gap: 4 }}>
          <select value={ev.account_from || ""} onChange={up("account_from")} style={{ ...inputStyle, padding: "3px 6px", minWidth: 90 }}>
            <option value="">—</option>
            {ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={ev.account_to || ""} onChange={up("account_to")} style={{ ...inputStyle, padding: "3px 6px", minWidth: 90 }}>
            <option value="">—</option>
            {ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </td>
      <td style={tdRight}>
        <button onClick={onSave} style={{ ...miniBtn, color: C.pos, marginRight: 4 }}>✓</button>
        <button onClick={onCancel} style={miniBtn}>✕</button>
      </td>
    </tr>
  );
}

// ---------------- UI-компоненты ----------------

function emptyForm() {
  return {
    date: today(), type: "expense", amount: "", category: "", counterparty: "",
    description: "", status: "paid", platform: "", nm_id: "", income_type: "",
    account_from: "", account_to: "",
  };
}

function Header() {
  return (
    <div style={{ marginBottom: 14 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>ДДС — движение денежных средств</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Поступления и списания по датам. Cash-flow (прибыль ≠ деньги).
      </p>
    </div>
  );
}

function Kpi({ label, value, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 160px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink }}>{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
      {label}{children}
    </label>
  );
}

// ---------------- Стили ----------------
const inputStyle = {
  padding: "6px 10px", borderRadius: 6, fontSize: 13,
  background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 100,
};
const resetBtnStyle = {
  padding: "7px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const addBtnStyle = {
  padding: "8px 18px", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer",
  background: C.accent, color: "var(--accentInk)", border: "none",
};
const draftBtnStyle = {
  padding: "7px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer",
  background: "rgba(0,229,255,0.12)", color: C.accent, border: `1px solid ${C.accent}`,
};
const modalOverlay = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20,
};
const modalBox = {
  background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12,
  padding: 20, maxWidth: 760, width: "100%", maxHeight: "88vh", overflowY: "auto",
  boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
};
const typeBtn = {
  padding: "5px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
  border: `1px solid ${C.line}`,
};
const miniBtn = {
  padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const badgeStyle = { padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" };
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeftFoot = { padding: "10px", textAlign: "left" };
const tdFootR = { padding: "10px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const formCardStyle = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10,
  padding: "14px 16px",
};
const alertStyle = {
  padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
  background: C.surface, border: `1px solid ${C.line}`, color: C.muted,
};
