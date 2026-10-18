"use client";
import { useState } from "react";
import Link from "next/link";
import { C, soft } from "@/lib/palette.js";

// =====================================================================
//  PaymentModal — карточка платежа/поступления платёжного календаря
//  (создание, правка, отметка повтора). 15.10.2026.
//  Спека docs/superpowers/specs/2026-10-15-payment-calendar-design.md §3.4.
// =====================================================================

const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export default function PaymentModal({ cabinetId, kind, categories, accounts, recurring, initial, onClose, onSaved }) {
  const isEdit = initial.mode === "edit";
  const item = isEdit ? initial.item : null;
  const isPurchase = isEdit && item.source_kind === "purchase";
  // Выплата МП уже получена (receive_payout пишет status='paid') — сумма зафиксирована
  // фактом получения, updateMovement для mp_payout всё равно хранит только date/description
  // (как у purchase), поэтому поля суммы/статьи/контрагента тоже read-only (фикс ревью, раунд 1).
  const isPayout = isEdit && item.source_kind === "mp_payout";
  const readOnlyFields = isPurchase || isPayout;
  const isRecurringRow = isEdit && typeof item.ref === "string" && item.ref.startsWith("recurring:");
  const templateId = isRecurringRow ? Number(item.ref.split(":")[1]) : null;

  // Статья по умолчанию — системный фолбэк своего направления, не «—» (иначе NULL уходит на
  // сервер и расходится с отчётом/фильтром журнала, см. articleKeyOf(null, type) в lib/dds.js).
  const [form, setForm] = useState(() => (isEdit
    ? { date: item.date, amount: String(item.amount), article_key: item.cat || (kind === "income" ? "other_in" : "other"), counterparty: item.counterparty || "", description: item.description || "", paid: item.status === "paid", account_id: item.account_id ?? "" }
    : { date: initial.date, amount: "", article_key: kind === "income" ? "other_in" : "other", counterparty: "", description: "", paid: false, account_id: "" }));

  // «Повторять» — только для новой записи.
  const [repeat, setRepeat] = useState("none");
  const [ruleDay, setRuleDay] = useState(1);
  const [everyN, setEveryN] = useState(7);
  const [dateTo, setDateTo] = useState("");

  // Повторяющаяся строка: «только этот» (row) или «весь шаблон» (template).
  const [view, setView] = useState("row");
  const [tplForm, setTplForm] = useState(null);

  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  async function submit(body) {
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/payment-calendar`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) { setErr(d.error || `Ошибка (${r.status})`); return; }
      onSaved();
    } catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  }

  function openTemplate() {
    const t = recurring.find((x) => x.id === templateId);
    if (!t) { setErr("Шаблон не найден — возможно, уже удалён."); return; }
    setTplForm({
      amount: String(t.amount), article_key: t.article_key || (kind === "income" ? "other_in" : "other"), counterparty: t.counterparty || "", description: t.description || "",
      rule: t.rule, rule_day: t.rule_day ?? 1, every_n: t.every_n ?? 7, date_from: t.date_from, date_to: t.date_to || "",
    });
    setErr(null);
    setView("template");
  }

  function handleSave() {
    if (readOnlyFields) {
      submit({ action: "update", id: item.id, date: form.date, description: form.description || null, account_id: form.account_id || null });
      return;
    }
    if (isRecurringRow && view === "template") {
      if (!(Number(tplForm.amount) > 0)) { setErr("Сумма должна быть больше 0"); return; }
      if (!tplForm.date_from) { setErr("Дата начала обязательна"); return; }
      submit({
        action: "recurring_save", id: templateId, type: kind === "income" ? "income" : "expense",
        amount: Number(tplForm.amount), article_key: tplForm.article_key || null, counterparty: tplForm.counterparty || null,
        description: tplForm.description || null, rule: tplForm.rule,
        rule_day: tplForm.rule === "every_n_days" ? null : Number(tplForm.rule_day),
        every_n: tplForm.rule === "every_n_days" ? Number(tplForm.every_n) : null,
        date_from: tplForm.date_from, date_to: tplForm.date_to || null,
      });
      return;
    }
    if (!form.date || !/^\d{4}-\d{2}-\d{2}$/.test(form.date)) { setErr("Дата обязательна (ГГГГ-ММ-ДД)"); return; }
    if (!(Number(form.amount) > 0)) { setErr("Сумма должна быть больше 0"); return; }
    if (isEdit) {
      submit({ action: "update", id: item.id, date: form.date, amount: Number(form.amount), article_key: form.article_key || null, counterparty: form.counterparty || null, description: form.description || null, account_id: form.account_id || null });
      return;
    }
    if (repeat !== "none") {
      submit({
        action: "recurring_save", type: kind === "income" ? "income" : "expense", amount: Number(form.amount),
        article_key: form.article_key || null, counterparty: form.counterparty || null, description: form.description || null,
        rule: repeat, rule_day: repeat === "every_n_days" ? null : Number(ruleDay),
        every_n: repeat === "every_n_days" ? Number(everyN) : null, date_from: form.date, date_to: dateTo || null,
      });
    } else {
      submit({ action: "create", type: kind === "income" ? "income" : "expense", date: form.date, amount: Number(form.amount), article_key: form.article_key || null, counterparty: form.counterparty || null, description: form.description || null, paid: form.paid, account_id: form.account_id || null });
    }
  }

  function handleDelete() {
    if (!confirm(`Удалить ${kind === "income" ? "поступление" : "платёж"}?`)) return;
    submit({ action: "delete", id: item.id });
  }
  function handleDeleteTemplate() {
    if (!confirm("Удалить повторяющийся шаблон целиком? Будущие неоплаченные платежи по нему будут отменены.")) return;
    submit({ action: "recurring_delete", id: templateId });
  }

  const title = isPurchase
    ? "Платёж из закупки"
    : isPayout
      ? "Выплата маркетплейса"
      : isRecurringRow && view === "template"
        ? "Шаблон повтора"
        : isEdit
          ? `Редактирование ${kind === "income" ? "поступления" : "платежа"}`
          : kind === "income" ? "Новое поступление" : "Новый платёж";

  return (
    <div style={modalOverlay} onClick={onClose}>
      <div style={modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>{title}</h2>
          <button onClick={onClose} style={miniBtn}>✕</button>
        </div>

        {err && <div style={{ color: C.neg, marginBottom: 12, fontSize: 13 }}>⚠ {err}</div>}

        {isPurchase && (
          <div style={{ ...alertStyle, marginBottom: 12 }}>
            Сумма правится в «Закупках» —{" "}
            <Link href={`/cabinets/${cabinetId}/fin-purchases`} style={{ color: C.accent }}>открыть партию</Link>.
            Здесь можно поменять дату и комментарий.
          </div>
        )}

        {isPayout && (
          <div style={{ ...alertStyle, marginBottom: 12 }}>
            Сумма меняется снятием отметки «получено». Здесь можно поменять дату и комментарий.
          </div>
        )}

        {isRecurringRow && view === "row" && (
          <div style={{ ...alertStyle, marginBottom: 12 }}>
            Это повторяющийся платёж. Правка ниже меняет только эту дату — для изменения всего
            расписания нажмите «Изменить шаблон».
          </div>
        )}

        {isRecurringRow && view === "template" ? (
          <TemplateForm form={tplForm} setForm={setTplForm} categories={categories} kind={kind} />
        ) : (
          <RowForm form={form} setForm={setForm} categories={categories} accounts={accounts} readOnly={readOnlyFields} showPaidCheckbox={!isEdit} />
        )}

        {!isEdit && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 8 }}>Повторять</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <Field label="Правило">
                <select value={repeat} onChange={(e) => setRepeat(e.target.value)} style={inputStyle}>
                  <option value="none">нет</option>
                  <option value="monthly">ежемесячно</option>
                  <option value="weekly">еженедельно</option>
                  <option value="every_n_days">каждые N дней</option>
                </select>
              </Field>
              {repeat === "monthly" && (
                <Field label="Число месяца">
                  <input type="number" min={1} max={31} value={ruleDay} onChange={(e) => setRuleDay(e.target.value)} style={{ ...inputStyle, width: 70 }} />
                </Field>
              )}
              {repeat === "weekly" && (
                <Field label="День недели">
                  <select value={ruleDay} onChange={(e) => setRuleDay(Number(e.target.value))} style={inputStyle}>
                    {WEEKDAY_LABELS.map((l, i) => <option key={i} value={i + 1}>{l}</option>)}
                  </select>
                </Field>
              )}
              {repeat === "every_n_days" && (
                <Field label="Каждые N дней">
                  <input type="number" min={1} max={365} value={everyN} onChange={(e) => setEveryN(e.target.value)} style={{ ...inputStyle, width: 70 }} />
                </Field>
              )}
              {repeat !== "none" && (
                <Field label="До даты (опц.)">
                  <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} />
                </Field>
              )}
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18, gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isEdit && !isPurchase && !isPayout && view === "row" && (
              <button onClick={handleDelete} disabled={saving} style={dangerBtnStyle}>Удалить</button>
            )}
            {isRecurringRow && view === "row" && (
              <button onClick={openTemplate} disabled={saving} style={resetBtnStyle}>Изменить шаблон</button>
            )}
            {isRecurringRow && view === "template" && (
              <>
                <button onClick={() => setView("row")} disabled={saving} style={resetBtnStyle}>← к записи</button>
                <button onClick={handleDeleteTemplate} disabled={saving} style={dangerBtnStyle}>Удалить шаблон</button>
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
            <button onClick={handleSave} disabled={saving} style={addBtnStyle}>
              {saving ? "…" : isRecurringRow && view === "row" ? "Сохранить только этот" : "Сохранить"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RowForm({ form, setForm, categories, accounts, readOnly, showPaidCheckbox }) {
  const up = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="Дата">
          <input type="date" value={form.date} onChange={up("date")} style={inputStyle} />
        </Field>
        <Field label="Сумма ₽">
          <input type="number" step="any" value={form.amount} onChange={up("amount")} disabled={readOnly} style={{ ...inputStyle, width: 130, opacity: readOnly ? 0.6 : 1 }} />
        </Field>
        <Field label="Статья">
          <select value={form.article_key} onChange={up("article_key")} disabled={readOnly} style={{ ...inputStyle, opacity: readOnly ? 0.6 : 1 }}>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="Контрагент">
          <input value={form.counterparty} onChange={up("counterparty")} disabled={readOnly} style={{ ...inputStyle, width: 200, opacity: readOnly ? 0.6 : 1 }} />
        </Field>
        <Field label="Комментарий">
          <input value={form.description} onChange={up("description")} style={{ ...inputStyle, width: 220 }} />
        </Field>
        <Field label="Счёт">
          <select value={form.account_id} onChange={up("account_id")} style={inputStyle}>
            <option value="">по умолчанию</option>
            {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      {showPaidCheckbox && (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.muted, cursor: "pointer" }}>
          <input type="checkbox" checked={form.paid} onChange={(e) => setForm({ ...form, paid: e.target.checked })} />
          Уже оплачено
        </label>
      )}
    </div>
  );
}

function TemplateForm({ form, setForm, categories, kind }) {
  if (!form) return null;
  const up = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="Сумма ₽">
          <input type="number" step="any" value={form.amount} onChange={up("amount")} style={{ ...inputStyle, width: 130 }} />
        </Field>
        <Field label="Статья">
          <select value={form.article_key} onChange={up("article_key")} style={inputStyle}>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="Контрагент">
          <input value={form.counterparty} onChange={up("counterparty")} style={{ ...inputStyle, width: 200 }} />
        </Field>
        <Field label="Комментарий">
          <input value={form.description} onChange={up("description")} style={{ ...inputStyle, width: 220 }} />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Правило">
          <select value={form.rule} onChange={up("rule")} style={inputStyle}>
            <option value="monthly">ежемесячно</option>
            <option value="weekly">еженедельно</option>
            <option value="every_n_days">каждые N дней</option>
          </select>
        </Field>
        {form.rule === "monthly" && (
          <Field label="Число месяца">
            <input type="number" min={1} max={31} value={form.rule_day} onChange={up("rule_day")} style={{ ...inputStyle, width: 70 }} />
          </Field>
        )}
        {form.rule === "weekly" && (
          <Field label="День недели">
            <select value={form.rule_day} onChange={(e) => setForm({ ...form, rule_day: Number(e.target.value) })} style={inputStyle}>
              {WEEKDAY_LABELS.map((l, i) => <option key={i} value={i + 1}>{l}</option>)}
            </select>
          </Field>
        )}
        {form.rule === "every_n_days" && (
          <Field label="Каждые N дней">
            <input type="number" min={1} max={365} value={form.every_n} onChange={up("every_n")} style={{ ...inputStyle, width: 70 }} />
          </Field>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="С даты">
          <input type="date" value={form.date_from} onChange={up("date_from")} style={inputStyle} />
        </Field>
        <Field label="До даты (опц.)">
          <input type="date" value={form.date_to} onChange={up("date_to")} style={inputStyle} />
        </Field>
      </div>
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
const inputStyle = { padding: "7px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}` };
const resetBtnStyle = { padding: "7px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const addBtnStyle = { padding: "8px 18px", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer", background: C.accent, color: "var(--accentInk)", border: "none" };
const dangerBtnStyle = { padding: "7px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: soft("neg", 12), color: C.neg, border: `1px solid ${C.neg}` };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const modalOverlay = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 };
const modalBox = { background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, maxWidth: 520, width: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" };
const alertStyle = { padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: C.surface, border: `1px solid ${C.line}`, color: C.muted };
