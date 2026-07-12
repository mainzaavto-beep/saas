"use client";
// /cabinets/[id]/reviews — отзывы WB+Ozon.
import { useEffect, useState } from "react";

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

  if (loading) return <div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>;
  if (!data) return null;
  const items = data.items || [];
  const s = data.stats || {};

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 8px" }}>⭐ Отзывы</h2>
      <div style={{ fontSize: 13, color: "#8a99b8", marginBottom: 16 }}>
        {s.total} отзывов · средний {(s.avgRating || 0).toFixed(1)}★
      </div>

      {/* KPI */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        {[
          ["Всего", s.total],
          ["Без ответа", s.unanswered, "#fbbf24"],
          ["Низкие (≤2★)", s.lowRating, "#f87171"],
        ].map(([label, val, color]) => (
          <div key={label} style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 8, padding: "10px 16px" }}>
            <div style={{ fontSize: 12, color: "#8a99b8" }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: color || "#e8edf7" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Фильтры */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {["all", "wb", "ozon"].map((m) => (
          <button key={m} onClick={() => setMp(m)} style={{
            padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13,
            border: "1px solid #243049", background: mp === m ? "#4f8cff" : "#1a2540", color: "#fff",
          }}>
            {m === "all" ? "Все МП" : m.toUpperCase()}
          </button>
        ))}
        <span style={{ width: 1, background: "#243049", margin: "0 4px" }} />
        {[
          ["all", "Все"],
          ["unanswered", "Без ответа"],
          ["low", "Низкий рейтинг"],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)} style={{
            padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13,
            border: "1px solid #243049", background: filter === key ? "#4f8cff" : "#1a2540", color: "#fff",
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* Список */}
      <div style={{ background: "#131c2e", border: "1px solid #243049", borderRadius: 12, padding: 8 }}>
        {items.length === 0 ? (
          <div style={{ textAlign: "center", color: "#8a99b8", padding: 40 }}>Нет отзывов</div>
        ) : (
          items.map((rv, i) => (
            <div key={i} style={{ borderBottom: i < items.length - 1 ? "1px solid rgba(36,48,73,0.4)" : "none", padding: "12px 8px" }}>
              {/* Шапка отзыва */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    padding: "2px 6px", borderRadius: 3, fontSize: 11, fontWeight: 600,
                    background: rv.platform === "wb" ? "rgba(96,165,250,0.15)" : "rgba(249,115,22,0.15)",
                    color: rv.platform === "wb" ? "#60a5fa" : "#f97316",
                  }}>{rv.platform.toUpperCase()}</span>
                  {rv.rating && (
                    <span style={{ color: rv.rating <= 2 ? "#f87171" : rv.rating <= 3 ? "#fbbf24" : "#4ade80" }}>
                      {"★".repeat(rv.rating)}<span style={{ color: "#333" }}>{"★".repeat(5 - rv.rating)}</span>
                    </span>
                  )}
                  {!rv.was_answered && (
                    <span style={{ fontSize: 11, color: "#fbbf24" }}>● без ответа</span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: "#8a99b8" }}>{(rv.created_at || "").slice(0, 10)}</span>
              </div>

              {/* Товар */}
              <div style={{ fontSize: 12, color: "#8a99b8", marginBottom: 4 }}>
                {(rv.product_name || rv.product || "").slice(0, 50)}
              </div>

              {/* Текст отзыва */}
              {rv.text && (
                <div style={{ fontSize: 14, marginBottom: 6, lineHeight: 1.5 }}>{rv.text.slice(0, 400)}</div>
              )}

              {/* Ответ МП (если есть) */}
              {rv.wb_answer && (
                <div style={{ fontSize: 13, color: "#4ade80", marginTop: 4, paddingLeft: 12, borderLeft: "2px solid #243049" }}>
                  ↳ {rv.wb_answer.slice(0, 200)}
                </div>
              )}

              {/* Черновик (если есть) */}
              {rv.draft_reply && editId !== rv.id && (
                <div style={{ fontSize: 13, color: "#fbbf24", marginTop: 4, paddingLeft: 12, borderLeft: "2px solid #fbbf24" }}>
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
                      background: "#1a2540", border: "1px solid #4f8cff", borderRadius: 6,
                      color: "#e8edf7", fontSize: 14, fontFamily: "inherit", resize: "vertical",
                    }}
                    placeholder="Введите ответ..."
                    autoFocus
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button onClick={() => saveDraft(rv.id, rv.platform)} style={{
                      padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
                      background: "#4f8cff", border: "none", color: "#fff",
                    }}>✓ Сохранить</button>
                    <button onClick={() => setEditId(null)} style={{
                      padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
                      background: "#1a2540", border: "1px solid #243049", color: "#8a99b8",
                    }}>Отмена</button>
                  </div>
                </div>
              ) : (
                !rv.was_answered && (
                  <button onClick={() => { setEditId(rv.id); setDraftText(rv.draft_reply || ""); }} style={{
                    marginTop: 4, padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 12,
                    background: "transparent", border: "1px solid #243049", color: "#8a99b8",
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
