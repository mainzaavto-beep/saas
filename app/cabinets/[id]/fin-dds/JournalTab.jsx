"use client";
// JournalTab — вкладка «Операции» ДДС: фильтры, журнал фактических движений, назначение счёта,
// модалка операции (17.10.2026, спека docs/superpowers/specs/2026-10-17-dds-design.md §5).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { C, soft } from "@/lib/palette.js";
import { ACTIVITIES } from "@/lib/dds.js";
import PeriodPicker from "../PeriodPicker.jsx";
import OperationModal from "./OperationModal.jsx";
import { api, money, signed, ruDate, S, Kpi, Field } from "./ddsUi.js";

const SOURCES = [
  ["manual", "ручные"],
  ["recurring", "повторы"],
  ["purchase", "закупки"],
  ["mp_payout", "выплаты МП"],
  ["transfer", "переводы"],
];
const TYPES = [["income", "Поступление"], ["expense", "Списание"], ["transfer", "Перевод"]];

function sourceBadge(it, cabinetId) {
  if (it.source_kind === "purchase") {
    return <Link href={`/cabinets/${cabinetId}/fin-purchases`} title="Закупка" style={{ color: C.accent, textDecoration: "none" }}>📦</Link>;
  }
  if (it.source_kind === "mp_payout") {
    const label = it.article_key === "mp_wb" ? "WB" : it.article_key === "mp_ozon" ? "Ozon" : "МП";
    return <span title="Выплата маркетплейса" style={{ color: C.muted, fontWeight: 700, fontSize: 11 }}>{label}</span>;
  }
  if (String(it.source_ref || "").startsWith("recurring:")) return <span title="Повторяющийся платёж">↻</span>;
  return null;
}

export default function JournalTab({ cabinetId, refs, initial, onChanged }) {
  const seedCustom = !!(initial.from && initial.to);
  const [filters, setFilters] = useState(() => ({
    from: initial.from || "", to: initial.to || "",
    account: initial.account || "", article: initial.article || "",
    type: initial.type || "", source: initial.source || "", q: "", page: 1,
  }));
  const [qInput, setQInput] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null); // null | { row?: object }
  const [assignMode, setAssignMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState({});
  const [assignAcc, setAssignAcc] = useState("");
  const [assignErr, setAssignErr] = useState(null);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch, page: patch.page != null ? patch.page : 1 }));

  const load = useCallback(() => {
    if (!filters.from || !filters.to) return;
    setLoading(true); setErr(null);
    const qs = new URLSearchParams({
      view: "journal", from: filters.from, to: filters.to, account: filters.account,
      article: filters.article, type: filters.type, source: filters.source, q: filters.q, page: String(filters.page),
    });
    api(`/api/cabinets/${cabinetId}/dds?${qs.toString()}`)
      .then(setData)
      .catch((e) => { console.error("journal load", e); setErr(e.message); })
      .finally(() => setLoading(false));
  }, [cabinetId, filters]);
  useEffect(() => { load(); }, [load]);

  const accountsByArticle = refs.accounts || [];
  const articlesByActivity = ACTIVITIES.map((a) => ({ ...a, items: (refs.articles || []).filter((x) => x.activity === a.key && !x.is_archived) }));
  const articleMap = Object.fromEntries((refs.articles || []).map((a) => [a.key, a]));
  const accountMap = Object.fromEntries(accountsByArticle.map((a) => [a.id, a]));

  const totals = data?.totals || { income: 0, expense: 0, net: 0 };
  const items = data?.items || [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function doDelete(it) {
    if (!confirm("Удалить операцию?")) return;
    try { await api(`/api/cabinets/${cabinetId}/dds`, { action: "delete", id: it.id }); load(); onChanged && onChanged(); }
    catch (e) { console.error("dds delete", e); alert("Не удалилось: " + e.message); }
  }

  async function applyAssign() {
    const ids = Object.keys(checkedIds).filter((k) => checkedIds[k]).map(Number);
    if (!ids.length) { setAssignErr("не выбраны операции"); return; }
    if (!assignAcc) { setAssignErr("выберите счёт"); return; }
    setAssignErr(null);
    try {
      await api(`/api/cabinets/${cabinetId}/dds`, { action: "assign_account", ids, account_id: Number(assignAcc) });
      setAssignMode(false); setCheckedIds({}); setAssignAcc("");
      load(); onChanged && onChanged();
    } catch (e) { console.error("assign_account", e); setAssignErr(e.message); }
  }

  const canEdit = !!refs.canEdit;

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <PeriodPicker
          value={{ from: filters.from, to: filters.to }}
          onChange={({ from, to }) => setF({ from, to })}
          defaultGran={seedCustom ? "custom" : "month"}
        />
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
        <Field label="Счёт">
          <select value={filters.account} onChange={(e) => setF({ account: e.target.value })} style={S.input}>
            <option value="">Все</option>
            <option value="none">Счёт не указан</option>
            {accountsByArticle.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Статья">
          <select value={filters.article} onChange={(e) => setF({ article: e.target.value })} style={S.input}>
            <option value="">Все</option>
            {articlesByActivity.map((g) => g.items.length ? (
              <optgroup key={g.key} label={g.label}>
                {g.items.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </optgroup>
            ) : null)}
          </select>
        </Field>
        <Field label="Вид">
          <select value={filters.type} onChange={(e) => setF({ type: e.target.value })} style={S.input}>
            <option value="">Все</option>
            {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Источник">
          <select value={filters.source} onChange={(e) => setF({ source: e.target.value })} style={S.input}>
            <option value="">Все</option>
            {SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Поиск">
          <div style={{ display: "flex", gap: 6 }}>
            <input value={qInput} onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setF({ q: qInput }); }}
              placeholder="контрагент, комментарий" style={{ ...S.input, width: 180 }} />
            <button onClick={() => setF({ q: qInput })} style={S.btn}>Найти</button>
          </div>
        </Field>
        {canEdit && <button onClick={() => setModal({})} style={{ ...S.primary, marginLeft: "auto" }}>+ Операция</button>}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi label="Поступления" value={money(totals.income)} color={C.pos} />
        <Kpi label="Списания" value={money(totals.expense)} color={C.neg} />
        <Kpi label="Сальдо" value={money(totals.net)} color={totals.net >= 0 ? C.pos : C.neg} />
        {refs.isOwner && <Kpi label="Остаток на конец" value={money(data?.endBalance)} />}
      </div>

      {err && <div style={{ color: C.neg, marginBottom: 12 }}>⚠ {err}</div>}

      {canEdit && data && data.noAccountCount > 0 && (
        <div style={{ ...S.card, marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", borderColor: "var(--warn)" }}>
          <span style={{ color: C.warn, fontWeight: 600 }}>⚠ {data.noAccountCount} операций без счёта</span>
          {!assignMode ? (
            <button onClick={() => setAssignMode(true)} style={S.btn}>Назначить</button>
          ) : (
            <>
              <span style={{ color: C.muted, fontSize: 12 }}>Отметьте строки в таблице ниже:</span>
              <select value={assignAcc} onChange={(e) => setAssignAcc(e.target.value)} style={S.input}>
                <option value="">— счёт —</option>
                {accountsByArticle.filter((a) => !a.is_archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button onClick={applyAssign} style={S.primary}>Применить</button>
              <button onClick={() => { setAssignMode(false); setCheckedIds({}); setAssignErr(null); }} style={S.btn}>Отмена</button>
              {assignErr && <span style={{ color: C.neg }}>⚠ {assignErr}</span>}
            </>
          )}
        </div>
      )}

      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 900 }}>
          <thead>
            <tr style={{ background: C.surface }}>
              {assignMode && <th style={S.th}></th>}
              <th style={S.th}>Дата</th>
              <th style={S.th}>Счёт</th>
              <th style={S.th}>Статья</th>
              <th style={S.th}>Контрагент</th>
              <th style={S.th}>Комментарий</th>
              <th style={{ ...S.th, textAlign: "right" }}>Сумма</th>
              <th style={S.th}>Ист.</th>
              {canEdit && <th style={S.th}></th>}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const acc = it.account_id != null ? accountMap[it.account_id] : null;
              const accTo = it.account_to_id != null ? accountMap[it.account_to_id] : null;
              const beforeStart = refs.isOwner && acc?.opening_date && it.date < acc.opening_date;
              const art = it.article_key ? articleMap[it.article_key] : null;
              const eligible = it.account_id == null && it.type !== "transfer";
              return (
                <tr key={it.id} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                  {assignMode && (
                    <td style={S.td}>
                      {eligible && (
                        <input type="checkbox" checked={!!checkedIds[it.id]}
                          onChange={(e) => setCheckedIds((c) => ({ ...c, [it.id]: e.target.checked }))} />
                      )}
                    </td>
                  )}
                  <td style={S.td}>{ruDate(it.date)}</td>
                  <td style={S.td}>
                    {it.type === "transfer"
                      ? <span style={{ color: C.muted }}>{acc?.name || "—"} → {accTo?.name || "—"}</span>
                      : acc ? acc.name : <span style={{ color: C.warn }}>не указан</span>}
                    {beforeStart && <div style={{ fontSize: 10, color: C.faint }}>до старта счёта</div>}
                  </td>
                  <td style={S.td}>
                    {it.type === "transfer"
                      ? <span style={{ color: C.muted }}>Перевод</span>
                      : art ? (<><span style={S.dot(art.color)} />{art.label}</>) : (it.article_key || "—")}
                  </td>
                  <td style={S.td}>{it.counterparty || "—"}</td>
                  <td style={S.td}>{it.description || "—"}</td>
                  <td style={{ ...S.td, ...S.num, color: it.type === "income" ? C.pos : it.type === "expense" ? C.neg : C.muted, fontWeight: 600 }}>
                    {signed(it.type, it.amount)}
                  </td>
                  <td style={S.td}>{sourceBadge(it, cabinetId)}</td>
                  {canEdit && (
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                      <button onClick={() => setModal({ row: it })} style={S.btn} title={!it.rules.amount ? it.rules.why : undefined}>✎</button>
                      {it.rules.del && (
                        <button onClick={() => doDelete(it)} style={{ ...S.btn, marginLeft: 4, color: C.neg }}>🗑</button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {items.length === 0 && !loading && (
              <tr><td colSpan={12} style={{ padding: 24, textAlign: "center", color: C.faint }}>Нет операций за период.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center", marginTop: 14 }}>
          <button onClick={() => setF({ page: Math.max(1, filters.page - 1) })} disabled={filters.page <= 1} style={S.btn}>‹ Назад</button>
          <span style={{ color: C.muted, fontSize: 13 }}>стр. {filters.page} из {pages}</span>
          <button onClick={() => setF({ page: Math.min(pages, filters.page + 1) })} disabled={filters.page >= pages} style={S.btn}>Вперёд ›</button>
        </div>
      )}

      {modal && (
        <OperationModal
          cabinetId={cabinetId} refs={refs} row={modal.row}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); onChanged && onChanged(); }}
        />
      )}
    </div>
  );
}
