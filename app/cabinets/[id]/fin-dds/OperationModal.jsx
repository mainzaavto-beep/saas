"use client";
// OperationModal — создание/правка операции ДДС (поступление/списание/перевод), 17.10.2026,
// спека docs/superpowers/specs/2026-10-17-dds-design.md §5.
import { useState } from "react";
import { C } from "@/lib/palette.js";
import { ACTIVITIES } from "@/lib/dds.js";
import { api, mskToday, S, Field } from "./ddsUi.js";

const NOOP_RULES = { amount: true, article: true, counterparty: true, date: true, account: true, comment: true, del: true, why: null };
const TYPE_BTNS = [["income", "↓ Поступление"], ["expense", "↑ Списание"], ["transfer", "⇄ Перевод"]];
// Фолбэк статьи для income/expense — в селекте нет «—» (иначе NULL в report группируется как
// «Прочее», а фильтр журнала article=other её не находит, D6). articleKeyOf в lib/dds.js делает то
// же на сервере для старых записей без article_key — держим фолбэк в одном смысле с ним.
const otherKeyFor = (t) => (t === "income" ? "other_in" : "other");
const alertStyle = { padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: C.surface, border: `1px solid ${C.line}`, color: C.muted, marginBottom: 12 };

// Счета без архивных, кроме текущего выбранного (чтобы правка старой строки не «теряла» счёт).
function accountOptions(accounts, selectedId) {
  return (accounts || []).filter((a) => !a.is_archived || String(a.id) === String(selectedId));
}

export default function OperationModal({ cabinetId, refs, row, onClose, onSaved }) {
  const isEdit = !!row;
  const rules = row ? row.rules : NOOP_RULES;
  const [type, setType] = useState(row ? row.type : "expense");
  const [form, setForm] = useState(() => ({
    date: row ? row.date : mskToday(),
    amount: row ? String(row.amount) : "",
    account_id: row && row.account_id != null ? String(row.account_id) : "",
    account_to_id: row && row.account_to_id != null ? String(row.account_to_id) : "",
    article_key: row ? (row.article_key || otherKeyFor(row.type)) : otherKeyFor(type),
    counterparty: row ? (row.counterparty || "") : "",
    description: row ? (row.description || "") : "",
  }));
  // Снимок исходных значений — для правки отправляем только реально изменённые поля (иначе
  // любая правка комментария/счёта отвязывала бы повторяющуюся строку от шаблона на сервере,
  // который трактует ЛЮБОЕ присутствие date/amount/article_key/counterparty в body как намерение
  // поправить именно их).
  const [initialForm] = useState(() => ({ ...form }));
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const isTransfer = type === "transfer";
  const up = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const switchType = (t) => { if (isEdit) return; setType(t); setForm((f) => ({ ...f, article_key: t === "transfer" ? "" : otherKeyFor(t) })); };

  const articleGroups = ACTIVITIES.map((a) => ({
    ...a,
    // Архивная статья текущей строки остаётся в списке (иначе правка строки с архивной статьёй
    // не показывала бы её выбранной — «пустой» select при наличии значения).
    items: (refs.articles || []).filter((x) => x.direction === type && x.activity === a.key && (!x.is_archived || (row && x.key === row.article_key))),
  })).filter((g) => g.items.length);

  async function submit() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) { setErr("дата обязательна (ГГГГ-ММ-ДД)"); return; }
    // Валидируем сумму только когда её можно править (создание или rules.amount) — у выплаты
    // МП (mp_payout) сумма read-only и бывает ≤ 0 (окно Ozon с удержаниями больше начислений);
    // без этого условия правка даты/счёта/комментария такой строки не сохранялась бы.
    if ((!isEdit || rules.amount) && !(Number(form.amount) > 0)) { setErr("сумма должна быть больше 0"); return; }
    if (isTransfer) {
      if (!form.account_id || !form.account_to_id) { setErr("у перевода нужны оба счёта"); return; }
      if (form.account_id === form.account_to_id) { setErr("счета перевода совпадают"); return; }
    }
    setErr(null); setSaving(true);
    try {
      let body;
      if (isEdit) {
        body = { action: "update", id: row.id };
        if (rules.date && form.date !== initialForm.date) body.date = form.date;
        if (rules.amount && Number(form.amount) !== Number(initialForm.amount)) body.amount = Number(form.amount);
        if (rules.article && !isTransfer && form.article_key !== initialForm.article_key) body.article_key = form.article_key;
        if (rules.counterparty && !isTransfer && form.counterparty !== initialForm.counterparty) body.counterparty = form.counterparty || null;
        if (rules.account) {
          if (form.account_id !== initialForm.account_id) body.account_id = form.account_id === "" ? null : Number(form.account_id);
          if (isTransfer && form.account_to_id !== initialForm.account_to_id) body.account_to_id = form.account_to_id === "" ? null : Number(form.account_to_id);
        }
        if (form.description !== initialForm.description) body.description = form.description || null;
      } else {
        body = {
          action: "create", type, date: form.date, amount: Number(form.amount),
          account_id: form.account_id === "" ? null : Number(form.account_id),
          account_to_id: isTransfer ? (form.account_to_id === "" ? null : Number(form.account_to_id)) : null,
          article_key: isTransfer ? null : (form.article_key || otherKeyFor(type)),
          counterparty: isTransfer ? null : (form.counterparty || null),
          description: form.description || null,
          paid: true,
        };
      }
      await api(`/api/cabinets/${cabinetId}/dds`, body);
      onSaved();
    } catch (e) { console.error("dds operation save", e); setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>{isEdit ? "Редактирование операции" : "Новая операция"}</h2>
          <button onClick={onClose} style={S.btn}>✕</button>
        </div>

        {isEdit && rules.why && <div style={alertStyle}>{rules.why}</div>}

        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {TYPE_BTNS.map(([k, l]) => (
            <button key={k} onClick={() => switchType(k)} disabled={isEdit}
              style={{
                ...S.btn, flex: 1, fontWeight: 600, cursor: isEdit ? "default" : "pointer", opacity: isEdit && type !== k ? 0.4 : 1,
                borderColor: type === k ? C.accent : C.line, background: type === k ? C.accent : C.surface,
                color: type === k ? "var(--accentInk)" : C.ink,
              }}>{l}</button>
          ))}
        </div>

        {err && <div style={{ color: C.neg, marginBottom: 12, fontSize: 13 }}>⚠ {err}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Field label="Дата">
              <input type="date" value={form.date} onChange={up("date")} disabled={!rules.date} style={{ ...S.input, opacity: rules.date ? 1 : 0.6 }} />
            </Field>
            <Field label="Сумма ₽">
              <input type="number" step="any" value={form.amount} onChange={up("amount")} disabled={!rules.amount}
                style={{ ...S.input, width: 130, opacity: rules.amount ? 1 : 0.6 }} />
            </Field>
          </div>

          {isTransfer ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Field label="Откуда">
                <select value={form.account_id} onChange={up("account_id")} disabled={!rules.account}
                  style={{ ...S.input, opacity: rules.account ? 1 : 0.6 }}>
                  <option value="">—</option>
                  {accountOptions(refs.accounts, form.account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Куда">
                <select value={form.account_to_id} onChange={up("account_to_id")} disabled={!rules.account}
                  style={{ ...S.input, opacity: rules.account ? 1 : 0.6 }}>
                  <option value="">—</option>
                  {accountOptions(refs.accounts, form.account_to_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Field label="Счёт">
                <select value={form.account_id} onChange={up("account_id")} disabled={!rules.account}
                  style={{ ...S.input, opacity: rules.account ? 1 : 0.6 }}>
                  <option value="">{isEdit ? "не указан" : "по умолчанию"}</option>
                  {accountOptions(refs.accounts, form.account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Статья">
                <select value={form.article_key} onChange={up("article_key")} disabled={!rules.article}
                  style={{ ...S.input, opacity: rules.article ? 1 : 0.6 }}>
                  {articleGroups.map((g) => (
                    <optgroup key={g.key} label={g.label}>
                      {g.items.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </Field>
            </div>
          )}

          {!isTransfer && (
            <Field label="Контрагент">
              <input value={form.counterparty} onChange={up("counterparty")} disabled={!rules.counterparty}
                style={{ ...S.input, opacity: rules.counterparty ? 1 : 0.6 }} />
            </Field>
          )}
          <Field label="Комментарий">
            <input value={form.description} onChange={up("description")} style={S.input} />
          </Field>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button onClick={onClose} style={S.btn}>Отмена</button>
          <button onClick={submit} disabled={saving} style={S.primary}>{saving ? "…" : "Сохранить"}</button>
        </div>
      </div>
    </div>
  );
}
