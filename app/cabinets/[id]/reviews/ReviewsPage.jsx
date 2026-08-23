"use client";
// /cabinets/[id]/reviews — отзывы WB+Ozon.
import { useEffect, useState } from "react";
import { C, soft } from "@/lib/palette.js";

export default function ReviewsPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mp, setMp] = useState("all");
  const [filter, setFilter] = useState("all"); // all|unanswered|low
  const [editId, setEditId] = useState(null);
  const [draftText, setDraftText] = useState("");

  const load = () => {
    let url = `/api/cabinets/${cabinetId}/feedbacks?mp=${mp}`;
    if (filter === "unanswered") url += "&unanswered=1";
    if (filter === "low") url += "&ratingMax=2";
    fetch(url)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, [cabinetId, mp, filter]);

  const saveDraft = async (id, platform) => {
    await fetch(`/api/cabinets/${cabinetId}/feedbacks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, platform, draft: draftText, status: "draft" }),
    });
    setEditId(null);
    load();
  };

  if (loading) return <div style={{ padding: 40, color: C.muted }}>Загрузка...</div>;
  if (!data) return null;
  const items = data.items || [];
  const s = data.stats || {};

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 8px" }}>⭐ Отзывы</h2>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
        {s.total} отзывов · средний {(s.avgRating || 0).toFixed(1)}★
      </div>

      {/* KPI */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        {[
          ["Всего", s.total],
          ["Без ответа", s.unanswered, C.warn],
          ["Низкие (≤2★)", s.lowRating, C.neg],
        ].map(([label, val, color]) => (
          <div key={label} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 16px" }}>
            <div style={{ fontSize: 12, color: C.muted }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: color || C.ink }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Фильтры */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {["all", "wb", "ozon"].map((m) => (
          <button key={m} onClick={() => setMp(m)} style={{
            padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13,
            border: `1px solid ${C.line}`, background: mp === m ? C.accent : C.surfaceAlt,
            color: mp === m ? "var(--accentInk)" : C.ink,
          }}>
            {m === "all" ? "Все МП" : m.toUpperCase()}
          </button>
        ))}
        <span style={{ width: 1, background: C.line, margin: "0 4px" }} />
        {[
          ["all", "Все"],
          ["unanswered", "Без ответа"],
          ["low", "Низкий рейтинг"],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)} style={{
            padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13,
            border: `1px solid ${C.line}`, background: filter === key ? C.accent : C.surfaceAlt,
            color: filter === key ? "var(--accentInk)" : C.ink,
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* Список */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 8 }}>
        {items.length === 0 ? (
          <div style={{ textAlign: "center", color: C.muted, padding: 40 }}>Нет отзывов</div>
        ) : (
          items.map((rv, i) => (
            <div key={i} style={{ borderBottom: i < items.length - 1 ? `1px solid ${soft("line", 40)}` : "none", padding: "12px 8px" }}>
              {/* Шапка отзыва */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className={`mp-badge ${rv.platform === "wb" ? "mp-wb" : "mp-ozon"}`}>{rv.platform.toUpperCase()}</span>
                  {rv.rating && (
                    <span style={{ color: rv.rating <= 2 ? C.neg : rv.rating <= 3 ? C.warn : C.pos }}>
                      {"★".repeat(rv.rating)}<span style={{ color: C.faint }}>{"★".repeat(5 - rv.rating)}</span>
                    </span>
                  )}
                  {!rv.was_answered && (
                    <span style={{ fontSize: 11, color: C.warn }}>● без ответа</span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: C.muted }}>{(rv.created_at || "").slice(0, 10)}</span>
              </div>

              {/* Товар */}
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
                {(rv.product_name || rv.product || "").slice(0, 50)}
              </div>

              {/* Текст отзыва */}
              {rv.text && (
                <div style={{ fontSize: 14, marginBottom: 6, lineHeight: 1.5 }}>{rv.text.slice(0, 400)}</div>
              )}

              {/* Ответ МП (если есть) */}
              {rv.wb_answer && (
                <div style={{ fontSize: 13, color: C.pos, marginTop: 4, paddingLeft: 12, borderLeft: `2px solid ${C.line}` }}>
                  ↳ {rv.wb_answer.slice(0, 200)}
                </div>
              )}

              {/* Черновик (если есть) */}
              {rv.draft_reply && editId !== rv.id && (
                <div style={{ fontSize: 13, color: C.warn, marginTop: 4, paddingLeft: 12, borderLeft: `2px solid ${C.warn}` }}>
                  ✎ черновик: {rv.draft_reply.slice(0, 200)}
                </div>
              )}

              {/* Редактор черновика */}
              {editId === rv.id ? (
                <div style={{ marginTop: 8 }}>
                  <textarea
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    style={{
                      width: "100%", minHeight: 60, padding: 8,
                      background: C.surfaceAlt, border: `1px solid ${C.accent}`, borderRadius: 6,
                      color: C.ink, fontSize: 14, fontFamily: "inherit", resize: "vertical",
                    }}
                    placeholder="Введите ответ..."
                    autoFocus
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button onClick={() => saveDraft(rv.id, rv.platform)} style={{
                      padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
                      background: C.accent, border: "none", color: "var(--accentInk)",
                    }}>✓ Сохранить</button>
                    <button onClick={() => setEditId(null)} style={{
                      padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
                      background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted,
                    }}>Отмена</button>
                  </div>
                </div>
              ) : (
                !rv.was_answered && (
                  <button onClick={() => { setEditId(rv.id); setDraftText(rv.draft_reply || ""); }} style={{
                    marginTop: 4, padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 12,
                    background: "transparent", border: `1px solid ${C.line}`, color: C.muted,
                  }}>
                    ✎ {rv.draft_reply ? "Редактировать черновик" : "Написать ответ"}
                  </button>
                )
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
