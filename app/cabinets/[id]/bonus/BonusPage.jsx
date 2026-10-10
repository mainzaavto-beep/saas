"use client";
// Премия менеджеров площадок (спека 2026-10-08 §5). Владелец — вкладки сотрудников, план,
// исключения, параметры, фиксация; менеджер — только своя карточка, без правки.
import { useEffect, useState, useCallback } from "react";
import { C, soft } from "@/lib/palette.js";

const rub = (v) => (v == null ? "—" : Math.round(v).toLocaleString("ru-RU") + " ₽");
const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1).replace(".", ",") + " %");
const PL = { wb: "WB", ozon: "Ozon" };
const IND = { sales: "Продажи", profit: "Операционная прибыль", margin: "Маржа, %" };
const box = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 16 };
const inp = { padding: "6px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13 };
const btn = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, cursor: "pointer", fontSize: 13 };

function curPeriod() { return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7); }

export default function BonusPage({ cabinetId }) {
  const [period, setPeriod] = useState(curPeriod());
  const [userId, setUserId] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [planForm, setPlanForm] = useState({ sales_plan: "", profit_plan: "" });
  const [exForm, setExForm] = useState({ sku_key: "", sales_plan_off: "", profit_plan_off: "", reason: "" });
  const [empForm, setEmpForm] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    const q = new URLSearchParams({ period });
    if (userId) q.set("user_id", String(userId));
    const r = await fetch(`/api/cabinets/${cabinetId}/bonus?${q}`);
    const d = await r.json().catch((e) => { console.error("[bonus] GET: ответ не JSON", e); return {}; });
    if (!r.ok) { setData(null); setErr(d.error || `Ошибка ${r.status}`); return; }
    setData(d);
    // card.plan — план ПОСЛЕ снятия исключений; в форму — исходный введённый план.
    const c = d.card;
    setPlanForm(c ? { sales_plan: String(Math.round(c.plan.sales + sumOff(c, "sales_plan_off"))),
      profit_plan: String(Math.round(c.plan.profit + sumOff(c, "profit_plan_off"))) } : { sales_plan: "", profit_plan: "" });
  }, [cabinetId, period, userId]);

  useEffect(() => { load(); }, [load]);

  const post = async (body) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/bonus`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch((e) => { console.error("[bonus] POST: ответ не JSON", e); return {}; });
      if (!r.ok) { alert(d.error || `Ошибка ${r.status}`); return false; }
      await load();
      return true;
    } finally { setBusy(false); }
  };

  if (err) return <div style={{ padding: 32, color: C.muted }}>{err}</div>;
  if (!data) return <div style={{ padding: 32, color: C.muted }}>Загрузка…</div>;

  const owner = data.mode === "owner";
  const card = data.card;
  const closed = card?.status === "closed";
  const uid = card?.employee?.user_id;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto", color: C.ink }}>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Премия</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} style={inp} />
        {owner && data.employees.map((e) => (
          <button key={e.user_id} onClick={() => setUserId(e.user_id)}
            style={{ ...btn, borderColor: e.user_id === uid ? C.accent : C.line, background: e.user_id === uid ? soft("accent", 15) : C.surfaceAlt }}>
            {PL[e.platform]} · {e.name || e.email}{e.is_active ? "" : " (неактивен)"}
          </button>
        ))}
        {owner && <button style={btn} onClick={() => setEmpForm({ user_id: data.candidates[0]?.user_id || "", platform: "wb", salary: 40000, bonus_pct: 4, threshold: 65, is_active: true, isNew: true })}>+ сотрудник</button>}
        {owner && card && <button style={btn} onClick={() => setEmpForm({ user_id: uid, platform: card.employee.platform, salary: card.employee.salary, bonus_pct: card.employee.bonus_pct * 100, threshold: card.employee.threshold * 100, is_active: card.employee.is_active })}>⚙ Параметры</button>}
      </div>

      {empForm && (
        <div style={box}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {empForm.isNew ? (
              <select value={empForm.user_id} onChange={(e) => setEmpForm({ ...empForm, user_id: e.target.value })} style={inp}>
                {data.candidates.length === 0 && <option value="">нет участников вне программы — пригласите в «Команде»</option>}
                {data.candidates.map((c) => <option key={c.user_id} value={c.user_id}>{c.name || c.email} ({c.role})</option>)}
              </select>
            ) : <b>{card?.employee?.name || card?.employee?.email}</b>}
            <select value={empForm.platform} onChange={(e) => setEmpForm({ ...empForm, platform: e.target.value })} style={inp}>
              <option value="wb">WB</option><option value="ozon">Ozon</option>
            </select>
            <label>Оклад <input style={{ ...inp, width: 100 }} value={empForm.salary} onChange={(e) => setEmpForm({ ...empForm, salary: e.target.value })} /></label>
            <label>% от прибыли <input style={{ ...inp, width: 60 }} value={empForm.bonus_pct} onChange={(e) => setEmpForm({ ...empForm, bonus_pct: e.target.value })} /></label>
            <label>Порог, % <input style={{ ...inp, width: 60 }} value={empForm.threshold} onChange={(e) => setEmpForm({ ...empForm, threshold: e.target.value })} /></label>
            <label><input type="checkbox" checked={empForm.is_active} onChange={(e) => setEmpForm({ ...empForm, is_active: e.target.checked })} /> активен</label>
            <button style={btn} disabled={busy || !empForm.user_id} onClick={async () => {
              const ok = await post({ action: "employee_upsert", user_id: Number(empForm.user_id), platform: empForm.platform,
                salary: Number(empForm.salary), bonus_pct: Number(empForm.bonus_pct) / 100, threshold: Number(empForm.threshold) / 100, is_active: empForm.is_active });
              if (ok) { if (empForm.isNew) setUserId(Number(empForm.user_id)); setEmpForm(null); }
            }}>Сохранить</button>
            <button style={btn} onClick={() => setEmpForm(null)}>Отмена</button>
          </div>
        </div>
      )}

      {!card && <div style={{ ...box, color: C.muted }}>{owner ? "В программе пока никого нет — добавьте сотрудника." : "Нет данных."}</div>}

      {card && (
        <>
          <div style={{ ...box, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <b>{PL[card.employee.platform]} · {card.employee.name || card.employee.email}</b>
            <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 12,
              background: closed ? soft("pos", 15) : soft("warn", 15), color: closed ? C.pos : C.warn }}>
              {closed ? `зафиксировано ${new Date(card.closedAt).toLocaleDateString("ru-RU")}` : "предварительно"}
            </span>
            {card.window && <span style={{ color: C.muted, fontSize: 12 }}>факт за {card.window.from} — {card.window.to}</span>}
            {card.status === "no_data" && <span style={{ color: C.muted }}>месяц ещё не начался</span>}
            {owner && !closed && card.status !== "no_data" && <button style={btn} disabled={busy}
              onClick={() => confirm("Зафиксировать месяц? Цифры заморозятся.") && post({ action: "close", user_id: uid, period })}>Зафиксировать месяц</button>}
            {owner && closed && <button style={btn} disabled={busy}
              onClick={() => confirm("Снять фиксацию? Расчёт снова станет живым.") && post({ action: "reopen", user_id: uid, period })}>Снять фиксацию</button>}
          </div>

          {owner && !closed && (
            <div style={{ ...box, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <b>План месяца:</b>
              <label>продажи <input style={{ ...inp, width: 130 }} value={planForm.sales_plan} onChange={(e) => setPlanForm({ ...planForm, sales_plan: e.target.value })} /></label>
              <label>прибыль <input style={{ ...inp, width: 130 }} value={planForm.profit_plan} onChange={(e) => setPlanForm({ ...planForm, profit_plan: e.target.value })} /></label>
              <button style={btn} disabled={busy} onClick={() => post({ action: "plan_set", user_id: uid, period, sales_plan: Number(planForm.sales_plan), profit_plan: Number(planForm.profit_plan) })}>Сохранить план</button>
            </div>
          )}

          <div style={box}>
            {card.status === "no_plan" ? <div style={{ color: C.muted }}>План на месяц не задан — премия не считается, показан только оклад.</div> : card.status !== "no_data" && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr style={{ color: C.muted, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: 6 }}>Показатель</th><th style={{ padding: 6 }}>План</th><th style={{ padding: 6 }}>Факт</th><th style={{ padding: 6 }}>% выполнения</th>
                </tr></thead>
                <tbody>
                  {card.indicators.map((i) => (
                    <tr key={i.key} style={{ borderTop: `1px solid ${C.line}`, textAlign: "right" }}>
                      <td style={{ textAlign: "left", padding: 6 }}>{IND[i.key]}</td>
                      <td style={{ padding: 6 }}>{i.key === "margin" ? pct(i.plan) : rub(i.plan)}</td>
                      <td style={{ padding: 6 }}>{i.key === "margin" ? pct(i.fact) : rub(i.fact)}</td>
                      <td style={{ padding: 6, color: i.below ? C.neg : C.ink, fontWeight: i.below ? 700 : 400 }}>{pct(i.pct)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: `2px solid ${C.line}`, textAlign: "right", fontWeight: 700 }}>
                    <td style={{ textAlign: "left", padding: 6 }}>Итого (среднее)</td><td /><td /><td style={{ padding: 6 }}>{pct(card.avg)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          <div style={{ ...box, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div><div style={{ color: C.muted, fontSize: 12 }}>Оклад</div><b>{rub(card.employee.salary)}</b></div>
            <div><div style={{ color: C.muted, fontSize: 12 }}>Бонусная часть ({(card.employee.bonus_pct * 100).toFixed(1).replace(".", ",")} % прибыли)</div><b>{rub(card.bonusBase)}</b></div>
            <div><div style={{ color: C.muted, fontSize: 12 }}>Коэффициент</div>
              <b>{["no_plan", "no_data"].includes(card.status) ? "—" : card.eligible ? pct(card.avg) : `0 — ниже ${Math.round(card.employee.threshold * 100)} %`}</b></div>
            <div><div style={{ color: C.muted, fontSize: 12 }}>Бонус</div><b>{rub(card.bonus)}</b></div>
            <div><div style={{ color: C.muted, fontSize: 12 }}>К оплате</div><b style={{ fontSize: 18, color: C.accent }}>{rub(card.payout)}</b></div>
          </div>

          <div style={box}>
            <b>Исключённые артикулы</b>
            {card.exclusions.length === 0 && <div style={{ color: C.muted, marginTop: 8 }}>Нет.</div>}
            {card.exclusions.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
                <thead><tr style={{ color: C.muted, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: 6 }}>Товар</th><th style={{ padding: 6 }}>Факт продаж</th><th style={{ padding: 6 }}>Факт прибыли</th>
                  <th style={{ padding: 6 }}>Снято плана продаж</th><th style={{ padding: 6 }}>Снято плана прибыли</th><th style={{ textAlign: "left", padding: 6 }}>Причина</th><th />
                </tr></thead>
                <tbody>{card.exclusions.map((e) => (
                  <tr key={e.id} style={{ borderTop: `1px solid ${C.line}`, textAlign: "right" }}>
                    <td style={{ textAlign: "left", padding: 6 }}>{e.name || "—"} <span style={{ color: C.muted }}>{e.sku_key}</span></td>
                    <td style={{ padding: 6 }}>{rub(e.revenue)}</td><td style={{ padding: 6 }}>{rub(e.profit)}</td>
                    <td style={{ padding: 6 }}>{rub(e.sales_plan_off)}</td><td style={{ padding: 6 }}>{rub(e.profit_plan_off)}</td>
                    <td style={{ textAlign: "left", padding: 6 }}>{e.reason}</td>
                    <td>{owner && !closed && <button style={btn} disabled={busy} onClick={() => confirm("Убрать исключение?") && post({ action: "exclusion_delete", id: e.id })}>✕</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {owner && !closed && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                <input placeholder={card.employee.platform === "wb" ? "nm_id" : "product_id"} style={{ ...inp, width: 120 }} value={exForm.sku_key} onChange={(e) => setExForm({ ...exForm, sku_key: e.target.value })} />
                <input placeholder="снять план продаж" style={{ ...inp, width: 140 }} value={exForm.sales_plan_off} onChange={(e) => setExForm({ ...exForm, sales_plan_off: e.target.value })} />
                <input placeholder="снять план прибыли" style={{ ...inp, width: 140 }} value={exForm.profit_plan_off} onChange={(e) => setExForm({ ...exForm, profit_plan_off: e.target.value })} />
                <input placeholder="причина" style={{ ...inp, flex: 1, minWidth: 160 }} value={exForm.reason} onChange={(e) => setExForm({ ...exForm, reason: e.target.value })} />
                <button style={btn} disabled={busy} onClick={async () => {
                  const ok = await post({ action: "exclusion_add", user_id: uid, period, sku_key: Number(exForm.sku_key),
                    sales_plan_off: Number(exForm.sales_plan_off || 0), profit_plan_off: Number(exForm.profit_plan_off || 0), reason: exForm.reason });
                  if (ok) setExForm({ sku_key: "", sales_plan_off: "", profit_plan_off: "", reason: "" });
                }}>+ исключить</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function sumOff(card, key) { return (card.exclusions || []).reduce((a, e) => a + (e[key] || 0), 0); }
