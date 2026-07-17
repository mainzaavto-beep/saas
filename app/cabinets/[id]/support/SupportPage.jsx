"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useRef, useState } from "react";

// =====================================================================
//  /cabinets/[id]/support — чат поддержки (AI-бот + эскалация к оператору).
//  Источник: /api/cabinets/[id]/support (GET ?since, POST send).
//  Polling каждые 15 сек подбирает новые сообщения (ответ оператора).
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const QUICK_PROMPTS = [
  { label: "Как найти убыточные товары?", text: "Как найти товары, на которых я теряю деньги?" },
  { label: "Что такое маржа?", text: "Объясните простыми словами, что такое маржа и чем она отличается от прибыли." },
  { label: "Где моя выручка?", text: "Где посмотреть мою выручку за прошлый месяц?" },
  { label: "Позвать оператора", text: "Хочу поговорить с живым оператором." },
];

const STATUS_META = {
  ai:         { icon: "🤖", label: "Отвечает AI-ассистент", color: C.accent },
  escalated:  { icon: "⏳", label: "Передано поддержке",       color: C.warn },
  closed:     { icon: "✓",  label: "Диалог закрыт",            color: C.muted },
};

const fmtTs = (ts) => {
  if (!ts) return "";
  // ts приходит как 'YYYY-MM-DDTHH:MM' (московское время, из API).
  const t = ts.split("T")[1] || ts;
  return t;
};

export default function SupportPage({ cabinetId }) {
  const [messages, setMessages] = useState([]);
  const [threadStatus, setThreadStatus] = useState("ai");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const lastIdRef = useRef(0);
  const scrollRef = useRef(null);

  // Первичная загрузка ленты.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(`/api/cabinets/${cabinetId}/support`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) { setError(d.error); return; }
        setMessages(d.messages || []);
        setThreadStatus(d.thread?.status || "ai");
        lastIdRef.current = (d.messages || []).reduce((m, x) => Math.max(m, x.id), 0);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [cabinetId]);

  // Polling каждые 15 сек: подбираем новые сообщения (ответ оператора).
  useEffect(() => {
    if (threadStatus === "closed") return;
    const id = setInterval(() => {
      fetch(`/api/cabinets/${cabinetId}/support?since=${lastIdRef.current}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.error) return;
          if (d.thread?.status && d.thread.status !== threadStatus) setThreadStatus(d.thread.status);
          if (d.messages && d.messages.length) {
            setMessages((prev) => [...prev, ...d.messages]);
            lastIdRef.current = d.messages.reduce((m, x) => Math.max(m, x.id), lastIdRef.current);
          }
        })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [cabinetId, threadStatus]);

  // Автоскролл вниз при новых сообщениях.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    setInput("");
    setSending(true);
    // Оптимистично показываем сообщение клиента сразу.
    setMessages((prev) => [...prev, { id: "pending-" + Date.now(), role: "user", content, by_ai: false, ts: null, _pending: true }]);
    try {
      const resp = await fetch(`/api/cabinets/${cabinetId}/support`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", content }),
      });
      const d = await resp.json();
      if (d.error) { setError(d.error); return; }
      // Заменяем оптимистичное сообщение клиента реальным + добавляем ответ AI.
      setMessages((prev) => {
        const withoutPending = prev.filter((m) => !m._pending);
        const next = [...withoutPending, d.userMessage];
        if (d.aiMessage) next.push(d.aiMessage);
        return next;
      });
      if (d.threadStatus && d.threadStatus !== threadStatus) setThreadStatus(d.threadStatus);
      lastIdRef.current = Math.max(lastIdRef.current, d.userMessage?.id || 0, d.aiMessage?.id || 0);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const statusMeta = STATUS_META[threadStatus] || STATUS_META.ai;

  return (
    <main style={{ width: "100%", maxWidth: 760, margin: "0 auto", padding: "20px 18px", fontFamily: FONT, color: C.ink, display: "flex", flexDirection: "column", height: "calc(100vh - 60px)" }}>
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>💬 Поддержка</h1>
        <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
          Задайте вопрос — ассистент ответит мгновенно. Если нужна живая помощь, попросите оператора.
        </p>
      </div>

      {/* Статус треда. */}
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 8, alignSelf: "flex-start",
        padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
        background: soft("accent", 8), color: statusMeta.color, border: `1px solid ${soft("accent", 25)}`,
        marginBottom: 10,
      }}>
        <span style={{ fontSize: 14 }}>{statusMeta.icon}</span>{statusMeta.label}
      </div>

      {/* Лента сообщений. */}
      <div ref={scrollRef} style={{
        flex: 1, overflowY: "auto", padding: "14px 16px", borderRadius: 12,
        background: C.surface, border: `1px solid ${C.line}`, minHeight: 200,
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {loading ? (
          <div style={{ margin: "auto", color: C.faint, fontSize: 13 }}>Загрузка диалога…</div>
        ) : error ? (
          <div style={{ margin: "auto", color: C.neg, fontSize: 13 }}>⚠️ {error}</div>
        ) : messages.length === 0 ? (
          <div style={{ margin: "auto", textAlign: "center", color: C.faint, fontSize: 13, maxWidth: 420 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>👋</div>
            Здравствуйте! Я AI-ассистент поддержки. Чем могу помочь?
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
              {QUICK_PROMPTS.map((p) => (
                <button key={p.label} onClick={() => send(p.text)} style={quickBtnStyle}>{p.label}</button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <MessageBubble key={m.id} m={m} />
            ))}
            {sending && (
              <div style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 14, background: C.surfaceAlt, color: C.muted, fontSize: 13 }}>
                <span style={{ display: "inline-flex", gap: 3 }}>
                  <Dot d={0} /><Dot d={0.2} /><Dot d={0.4} />
                </span>{"  "}ассистент печатает…
              </div>
            )}
          </>
        )}
      </div>

      {/* Поле ввода. */}
      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Напишите сообщение…  (Enter — отправить, Shift+Enter — новая строка)"
          rows={1}
          disabled={sending}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.line}`,
            background: C.surface, color: C.ink, fontSize: 13.5, fontFamily: "inherit",
            resize: "none", maxHeight: 120, lineHeight: 1.4,
          }}
        />
        <button
          onClick={() => send()}
          disabled={sending || !input.trim()}
          style={{
            padding: "10px 18px", borderRadius: 10, cursor: sending ? "default" : "pointer",
            border: "none", background: sending ? C.surfaceAlt : C.accent,
            color: sending ? C.faint : "#0A1A1C", fontWeight: 700, fontSize: 14, fontFamily: "inherit",
            whiteSpace: "nowrap",
          }}
        >Отправить</button>
      </div>
    </main>
  );
}

function MessageBubble({ m }) {
  const isUser = m.role === "user";
  return (
    <div style={{
      display: "flex", justifyContent: isUser ? "flex-end" : "flex-start",
      opacity: m._pending ? 0.6 : 1,
    }}>
      <div style={{
        maxWidth: "78%", padding: "9px 13px", borderRadius: 14,
        background: isUser ? C.accent : (m.by_ai ? soft("accent", 8) : soft("warn", 10)),
        color: isUser ? "#0A1A1C" : C.ink,
        fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
        borderBottomRightRadius: isUser ? 4 : 14,
        borderBottomLeftRadius: isUser ? 14 : 4,
        border: isUser ? "none" : `1px solid ${soft("accent", 18)}`,
      }}>
        {!isUser && (
          <div style={{ fontSize: 10, fontWeight: 700, color: m.by_ai ? C.accent : C.warn, marginBottom: 3, opacity: 0.8 }}>
            {m.by_ai ? "🤖 Ассистент" : "🎧 Поддержка"}
          </div>
        )}
        {m.content}
        {m.ts && (
          <div style={{ fontSize: 10, color: isUser ? "#0A1A1C" : C.faint, opacity: 0.6, marginTop: 4, textAlign: "right" }}>
            {fmtTs(m.ts)}
          </div>
        )}
      </div>
    </div>
  );
}

function Dot({ d }) {
  return <span style={{
    display: "inline-block", width: 5, height: 5, borderRadius: "50%",
    background: C.muted, animation: "blink 1.4s infinite both", animationDelay: `${d}s`,
  }} />;
}

const quickBtnStyle = {
  padding: "7px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
  border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, textAlign: "left",
};

// keyframes для анимации «печатает».
// Next.js inline-style не поддерживает @keyframes — добавляем через глобальный тег.
if (typeof document !== "undefined") {
  const id = "support-blink-kf";
  if (!document.getElementById(id)) {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = "@keyframes blink { 0%,80%,100% { opacity: 0.2; } 40% { opacity: 1; } }";
    document.head.appendChild(style);
  }
}
