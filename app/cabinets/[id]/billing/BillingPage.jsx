"use client";
import { C, soft } from "@/lib/palette.js";
// /cabinets/[id]/billing — единственная страница про деньги: состояние
// подписки, тарифы, история платежей.
import { useEffect, useState } from "react";

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("ru-RU") : "—");
const fmtMoney = (v) => `${Number(v).toLocaleString("ru-RU", { minimumFractionDigits: 0 })} ₽`;

const STATE_TEXT = {
  trial: (d) => `Пробный период до ${fmtDate(d.until)} — осталось ${d.days_left} дн.`,
  active: (d) => `Подписка оплачена до ${fmtDate(d.until)}`,
  grace: (d) => `Срок закончился ${fmtDate(d.until)}. Доступ закроется ${fmtDate(d.grace_until)} — оплатите подписку.`,
  locked: () => `Доступ к проекту приостановлен. Оплатите подписку, чтобы продолжить.`,
};

export default function BillingPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = () => {
    fetch(`/api/cabinets/${cabinetId}/billing`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Не удалось загрузить состояние"))))
      .then(setData)
      .catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, [cabinetId]);

  // Вернулись из платёжной формы — ждём подтверждения от провайдера.
  const justPaid = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("paid") === "1";
  useEffect(() => {
    if (!justPaid) return;
    const t = setInterval(load, 3000);
    const stop = setTimeout(() => clearInterval(t), 60000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [justPaid, cabinetId]);

  async function pay(code) {
    setErr(""); setBusy(code);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/billing/pay`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_code: code }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.confirmation_url) { setErr(d.error || "Не удалось создать платёж"); return; }
      window.location.href = d.confirmation_url;
    } catch { setErr("Сетевая ошибка"); }
    finally { setBusy(""); }
  }

  if (err && !data) return <div style={{ padding: 24, fontFamily: FONT, color: C.neg }}>{err}</div>;
  if (!data) return <div style={{ padding: 24, fontFamily: FONT, color: C.muted }}>Загрузка…</div>;

  const monthly = data.plans.find((p) => p.months === 1);
  const benefit = (p) => {
    if (!monthly || p.months === 1) return null;
    const full = Number(monthly.price_rub) * p.months;
    const save = Math.round((1 - Number(p.price_rub) / full) * 100);
    return save > 0 ? `выгода ${save}%` : null;
  };

  return (
    <div style={{ width: "100%", maxWidth: 760, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 20px" }}>💳 Подписка</h1>

      <div style={{
        background: data.state === "locked" || data.state === "grace" ? soft("neg", 12) : C.surface,
        border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20, fontSize: 15,
      }}>
        {STATE_TEXT[data.state](data)}
      </div>

      {justPaid && data.state !== "active" && (
        <div style={{ background: soft("warn", 12), borderRadius: 12, padding: 16, marginBottom: 20, fontSize: 14 }}>
          Платёж обрабатывается — страница обновится сама, когда банк подтвердит оплату.
        </div>
      )}
      {err && <div className="err">{err}</div>}

      {!data.plans.length ? (
        <div style={{ color: C.muted, fontSize: 14, marginBottom: 20 }}>Тарифы не настроены — напишите в поддержку.</div>
      ) : !data.can_pay ? (
        <div style={{ color: C.muted, fontSize: 14, marginBottom: 20 }}>Оплату производит владелец проекта.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 24 }}>
          {data.plans.map((p) => (
            <div key={p.code} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{p.title}</div>
              <div style={{ fontSize: 24, fontWeight: 800, margin: "8px 0" }}>{fmtMoney(p.price_rub)}</div>
              {benefit(p) && <div style={{ fontSize: 12, color: C.pos, marginBottom: 8 }}>{benefit(p)}</div>}
              <button onClick={() => pay(p.code)} disabled={!!busy} style={{
                width: "100%", padding: "10px", borderRadius: 8, background: C.accent, color: "var(--accentInk)",
                border: "none", cursor: busy ? "default" : "pointer", fontWeight: 700, fontFamily: "inherit", fontSize: 14,
              }}>{busy === p.code ? "Создаём платёж…" : "Оплатить"}</button>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>История платежей</h2>
      {!data.payments.length ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Платежей ещё не было.</div>
      ) : (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
          {data.payments.map((p) => (
            <div key={p.payment_id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 16px", borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
              <span>{fmtDate(p.created_at)} — {p.months} мес.</span>
              <span>{fmtMoney(p.amount_rub)} · {p.status === "succeeded" ? "оплачен" : p.status === "pending" ? "в обработке" : p.status === "mismatch" ? "требует разбора" : "отменён"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
