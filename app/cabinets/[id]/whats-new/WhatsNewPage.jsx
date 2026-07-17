"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState } from "react";

// =====================================================================
//  /cabinets/[id]/whats-new — «Что нового»: лента фич/правок продукта.
//  Источник: /api/whats-new (глобальная таблица shared.changelog).
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const TYPE_META = {
  feature:     { icon: "✨", label: "Новая фишка", color: C.pos,  bg: soft("pos", 12) },
  improvement: { icon: "⚡", label: "Улучшение",   color: C.warn, bg: soft("warn", 12) },
  fix:         { icon: "🔧", label: "Правка",     color: C.accent, bg: soft("accent", 12) },
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
};

export default function WhatsNewPage({ cabinetId }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setItems(null); setError(null);
    fetch(`/api/whats-new?limit=50`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setItems(d.items || [])))
      .catch((e) => setError(String(e)));
  }, [cabinetId]);

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!items) return <Centered>Загрузка…</Centered>;

  return (
    <main style={{ width: "100%", maxWidth: 820, margin: "0 auto", padding: "24px 18px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>✨ Что нового</h1>
        <p style={{ margin: "6px 0 0", color: C.muted, fontSize: 13 }}>
          Обновления и улучшения сервиса. Здесь публикуем все новые возможности и важные правки.
        </p>
      </div>

      {items.length === 0 ? (
        <Centered>Пока нет опубликованных обновлений.</Centered>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {items.map((it) => {
            const meta = TYPE_META[it.type] || TYPE_META.feature;
            return (
              <article
                key={it.id}
                style={{
                  padding: "16px 18px", borderRadius: 12, background: C.surface,
                  border: `1px solid ${C.line}`, borderLeft: `3px solid ${meta.color}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px",
                    borderRadius: 20, fontSize: 11, fontWeight: 700,
                    background: meta.bg, color: meta.color,
                  }}>
                    <span style={{ fontSize: 13 }}>{meta.icon}</span>{meta.label}
                  </span>
                  <span style={{ fontSize: 12, color: C.faint }}>{fmtDate(it.date)}</span>
                </div>
                <h2 style={{ margin: "0 0 8px", fontSize: 16.5, fontWeight: 700, color: C.ink, lineHeight: 1.3 }}>
                  {it.title}
                </h2>
                {it.body && (
                  <div style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                    {it.body}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}

function Centered({ children }) {
  return <div style={{ minHeight: "60vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, textAlign: "center", padding: 40 }}>{children}</div>;
}
