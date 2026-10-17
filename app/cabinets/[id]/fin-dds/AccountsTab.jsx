"use client";
// AccountsTab — вкладка «Счета» ДДС (только владелец): справочник счетов, стартовые остатки,
// счета по умолчанию (17.10.2026, спека docs/superpowers/specs/2026-10-17-dds-design.md §5).
import { useState } from "react";
import { C, soft } from "@/lib/palette.js";
import { ACCOUNT_KINDS } from "@/lib/dds.js";
import { api, money, mskToday, S, Field } from "./ddsUi.js";

function emptyForm(sort) {
  return { name: "", kind: "bank_ip", opening_balance: "0", opening_date: mskToday(), sort };
}

export default function AccountsTab({ cabinetId, refs, onChanged }) {
  const [editing, setEditing] = useState(null); // null | "new" | id
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState(() => ({
    default_account_id: refs.settings?.default_account_id ?? "",
    wb: refs.settings?.payout_account?.wb ?? "",
    ozon: refs.settings?.payout_account?.ozon ?? "",
  }));
  const [settingsErr, setSettingsErr] = useState(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const accounts = refs.accounts || [];
  const balances = refs.balances || {};
  const totalBalance = Object.values(balances).reduce((s, v) => s + (Number(v) || 0), 0);
  const noAccountBalance = Number(balances["0"]) || 0;

  function startNew() {
    const maxSort = accounts.reduce((m, a) => Math.max(m, a.sort || 0), 0);
    setForm(emptyForm(maxSort + 10)); setEditing("new"); setErr(null);
  }
  function startEdit(a) {
    setForm({ name: a.name, kind: a.kind, opening_balance: String(a.opening_balance), opening_date: a.opening_date, sort: a.sort });
    setEditing(a.id); setErr(null);
  }
  function cancelEdit() { setEditing(null); setForm(null); setErr(null); }

  async function save() {
    if (!form.name.trim()) { setErr("название счёта обязательно"); return; }
    setSaving(true); setErr(null);
    try {
      const body = {
        action: "account_save", name: form.name.trim(), kind: form.kind,
        opening_balance: Number(form.opening_balance), opening_date: form.opening_date, sort: form.sort,
      };
      if (editing !== "new") body.id = editing;
      await api(`/api/cabinets/${cabinetId}/dds-refs`, body);
      cancelEdit();
      onChanged();
    } catch (e) { console.error("account_save", e); setErr(e.message); }
    finally { setSaving(false); }
  }

  async function toggleArchive(a) {
    try { await api(`/api/cabinets/${cabinetId}/dds-refs`, { action: "account_archive", id: a.id, archived: !a.is_archived }); onChanged(); }
    catch (e) { console.error("account_archive", e); alert("Не удалось: " + e.message); }
  }

  async function saveSettings() {
    setSettingsSaving(true); setSettingsErr(null);
    try {
      await api(`/api/cabinets/${cabinetId}/dds-refs`, {
        action: "settings_save",
        default_account_id: settingsForm.default_account_id || null,
        payout_account: { wb: settingsForm.wb || null, ozon: settingsForm.ozon || null },
      });
      onChanged();
    } catch (e) { console.error("settings_save", e); setSettingsErr(e.message); }
    finally { setSettingsSaving(false); }
  }

  const activeAccounts = accounts.filter((a) => !a.is_archived);

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 14, fontSize: 12, color: C.muted }}>
        Стартовый остаток — сумма на начало дня даты старта. Операции раньше этой даты в остаток не входят.
      </div>

      {err && editing === null && <div style={{ color: C.neg, marginBottom: 10 }}>⚠ {err}</div>}

      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, marginBottom: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 700 }}>
          <thead>
            <tr style={{ background: C.surface }}>
              <th style={S.th}>Имя</th>
              <th style={S.th}>Тип</th>
              <th style={{ ...S.th, textAlign: "right" }}>Старт</th>
              <th style={S.th}>Дата старта</th>
              <th style={{ ...S.th, textAlign: "right" }}>Текущий остаток</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => editing === a.id ? (
              <EditRow key={a.id} form={form} setForm={setForm} err={err} saving={saving} onSave={save} onCancel={cancelEdit} />
            ) : (
              <tr key={a.id} style={{ borderBottom: `1px solid ${soft("line", 20)}`, opacity: a.is_archived ? 0.5 : 1 }}>
                <td style={S.td}>{a.name}{a.is_archived && <span style={{ color: C.faint, fontSize: 11 }}> (архив)</span>}</td>
                <td style={S.td}>{ACCOUNT_KINDS[a.kind] || a.kind}</td>
                <td style={{ ...S.td, ...S.num }}>{money(a.opening_balance)}</td>
                <td style={S.td}>{a.opening_date}</td>
                <td style={{ ...S.td, ...S.num }}>{money(balances[String(a.id)])}</td>
                <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                  <button onClick={() => startEdit(a)} style={S.btn}>✎</button>
                  <button onClick={() => toggleArchive(a)} style={{ ...S.btn, marginLeft: 4 }}>{a.is_archived ? "Вернуть" : "В архив"}</button>
                </td>
              </tr>
            ))}
            {editing === "new" && (
              <EditRow form={form} setForm={setForm} err={err} saving={saving} onSave={save} onCancel={cancelEdit} />
            )}
            {noAccountBalance !== 0 && (
              <tr style={{ borderBottom: `1px solid ${soft("line", 20)}`, color: C.muted }}>
                <td style={S.td} colSpan={4}>Счёт не указан</td>
                <td style={{ ...S.td, ...S.num }}>{money(noAccountBalance)}</td>
                <td style={S.td}></td>
              </tr>
            )}
            <tr style={{ fontWeight: 700 }}>
              <td style={S.td} colSpan={4}>Итого</td>
              <td style={{ ...S.td, ...S.num }}>{money(totalBalance)}</td>
              <td style={S.td}></td>
            </tr>
          </tbody>
        </table>
      </div>

      {editing === null && <button onClick={startNew} style={S.primary}>+ Счёт</button>}

      <div style={{ ...S.card, marginTop: 24, maxWidth: 560 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Счета по умолчанию</div>
        {settingsErr && <div style={{ color: C.neg, marginBottom: 10 }}>⚠ {settingsErr}</div>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field label="Для операций">
            <select value={settingsForm.default_account_id} onChange={(e) => setSettingsForm((f) => ({ ...f, default_account_id: e.target.value }))} style={S.input}>
              <option value="">—</option>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Выплаты WB">
            <select value={settingsForm.wb} onChange={(e) => setSettingsForm((f) => ({ ...f, wb: e.target.value }))} style={S.input}>
              <option value="">—</option>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Выплаты Ozon">
            <select value={settingsForm.ozon} onChange={(e) => setSettingsForm((f) => ({ ...f, ozon: e.target.value }))} style={S.input}>
              <option value="">—</option>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>
        <button onClick={saveSettings} disabled={settingsSaving} style={{ ...S.primary, marginTop: 12 }}>{settingsSaving ? "…" : "Сохранить"}</button>
      </div>
    </div>
  );
}

function EditRow({ form, setForm, err, saving, onSave, onCancel }) {
  const up = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <tr style={{ background: soft("accent", 8) }}>
      <td style={S.td}><input value={form.name} onChange={up("name")} style={{ ...S.input, width: 140 }} /></td>
      <td style={S.td}>
        <select value={form.kind} onChange={up("kind")} style={S.input}>
          {Object.entries(ACCOUNT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </td>
      <td style={S.td}><input type="number" step="any" value={form.opening_balance} onChange={up("opening_balance")} style={{ ...S.input, width: 110, textAlign: "right" }} /></td>
      <td style={S.td}><input type="date" value={form.opening_date} onChange={up("opening_date")} style={S.input} /></td>
      <td style={S.td}></td>
      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
        <button onClick={onSave} disabled={saving} style={{ ...S.btn, color: C.pos }}>{saving ? "…" : "✓"}</button>
        <button onClick={onCancel} style={{ ...S.btn, marginLeft: 4 }}>✕</button>
        {err && <div style={{ color: C.neg, fontSize: 11, marginTop: 4 }}>{err}</div>}
      </td>
    </tr>
  );
}
