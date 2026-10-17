"use client";
// ArticlesTab — вкладка «Статьи» ДДС: справочник по видам деятельности × направлению (17.10.2026,
// спека docs/superpowers/specs/2026-10-17-dds-design.md §5).
import { useState } from "react";
import { C, soft } from "@/lib/palette.js";
import { ACTIVITIES } from "@/lib/dds.js";
import { api, S, Field } from "./ddsUi.js";

const COLORS = ["pos", "neg", "warn", "accent", "accent2", "blue", "pink", "muted", "faint", "line"];
const DIRS = [["income", "Поступления"], ["expense", "Выбытия"]];

export default function ArticlesTab({ cabinetId, refs, onChanged }) {
  const [editKey, setEditKey] = useState(null); // null | key | "new:<activity>:<direction>"
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const canEdit = !!refs.canEdit;
  const articles = refs.articles || [];

  function startNew(activity, direction) {
    setForm({ label: "", color: "line", activity, direction });
    setEditKey(`new:${activity}:${direction}`);
    setErr(null);
  }
  function startEdit(a) {
    setForm({ label: a.label, color: a.color || "line" });
    setEditKey(a.key);
    setErr(null);
  }
  function cancel() { setEditKey(null); setForm(null); setErr(null); }

  async function save() {
    if (!form.label.trim()) { setErr("название статьи обязательно"); return; }
    setSaving(true); setErr(null);
    try {
      const body = editKey.startsWith("new:")
        ? { action: "article_save", label: form.label.trim(), color: form.color, activity: form.activity, direction: form.direction }
        : { action: "article_save", key: editKey, label: form.label.trim(), color: form.color };
      await api(`/api/cabinets/${cabinetId}/dds-refs`, body);
      cancel();
      onChanged();
    } catch (e) { console.error("article_save", e); setErr(e.message); }
    finally { setSaving(false); }
  }

  async function toggleArchive(a) {
    try { await api(`/api/cabinets/${cabinetId}/dds-refs`, { action: "article_archive", key: a.key, archived: !a.is_archived }); onChanged(); }
    catch (e) { console.error("article_archive", e); alert("Не удалось: " + e.message); }
  }

  return (
    <div>
      {canEdit && (
        <div style={{ ...S.card, marginBottom: 14, fontSize: 12, color: C.muted }}>
          Удаления нет — только скрытие. Скрытая статья не предлагается в формах, но остаётся в отчёте.
        </div>
      )}
      {ACTIVITIES.map((act) => (
        <div key={act.key} style={{ marginBottom: 22 }}>
          <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 10 }}>{act.label}</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {DIRS.map(([dir, dirLabel]) => {
              const items = articles.filter((a) => a.activity === act.key && a.direction === dir);
              const newKey = `new:${act.key}:${dir}`;
              return (
                <div key={dir} style={{ ...S.card, flex: "1 1 320px", minWidth: 280 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: C.muted, marginBottom: 8 }}>{dirLabel}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {items.map((a) => editKey === a.key ? (
                      <ArticleForm key={a.key} form={form} setForm={setForm} err={err} saving={saving} onSave={save} onCancel={cancel} />
                    ) : (
                      <div key={a.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", opacity: a.is_archived ? 0.5 : 1 }}>
                        <span style={S.dot(a.color)} />
                        <span style={{ flex: 1, fontSize: 13 }}>
                          {a.label} {a.is_system && <span title="Системная статья">🔒</span>} {a.is_archived && <span style={{ color: C.faint, fontSize: 11 }}>скрыта</span>}
                        </span>
                        {canEdit && (
                          <>
                            <button onClick={() => startEdit(a)} style={S.btn}>✎</button>
                            {/* other/other_in — фолбэк операций без статьи, скрыть нельзя (lib/ddsData.js archiveArticle) */}
                            {a.key !== "other" && a.key !== "other_in" && (
                              <button onClick={() => toggleArchive(a)} style={{ ...S.btn, marginLeft: 4 }}>{a.is_archived ? "Показать" : "Скрыть"}</button>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    {editKey === newKey && (
                      <ArticleForm form={form} setForm={setForm} err={err} saving={saving} onSave={save} onCancel={cancel} />
                    )}
                    {canEdit && editKey === null && (
                      <button onClick={() => startNew(act.key, dir)} style={{ ...S.btn, alignSelf: "flex-start", marginTop: 4 }}>+ статья</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ArticleForm({ form, setForm, err, saving, onSave, onCancel }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0", borderTop: `1px solid ${soft("line", 20)}`, borderBottom: `1px solid ${soft("line", 20)}` }}>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Название">
          <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} style={{ ...S.input, width: 160 }} />
        </Field>
        <Field label="Цвет">
          <select value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} style={S.input}>
            {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <button onClick={onSave} disabled={saving} style={{ ...S.btn, color: C.pos }}>{saving ? "…" : "✓"}</button>
        <button onClick={onCancel} style={S.btn}>✕</button>
      </div>
      {err && <div style={{ color: C.neg, fontSize: 11 }}>⚠ {err}</div>}
    </div>
  );
}
