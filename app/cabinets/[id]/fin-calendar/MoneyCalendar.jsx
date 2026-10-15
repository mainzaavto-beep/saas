"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { C, soft } from "@/lib/palette.js";
import PaymentModal from "./PaymentModal.jsx";

// =====================================================================
//  MoneyCalendar — общая месячная сетка для «Платёжного календаря»
//  (kind="expense") и «Плана поступлений» (kind="income"), 15.10.2026.
//  Данные — GET/POST /api/cabinets/[id]/payment-calendar (Task 6).
//  Спека docs/superpowers/specs/2026-10-15-payment-calendar-design.md §3.2–3.3.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const DOW = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MOBILE_BREAK = 900;

const money = (v) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0) + " ₽";
const fmtK = (v) => {
  const a = Math.abs(v || 0);
  if (a >= 1e6) return (v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " млн";
  if (a >= 1e3) return Math.round(v / 1e3).toLocaleString("ru-RU") + " тыс";
  return Math.round(v).toLocaleString("ru-RU");
};
const isoDow = (s) => ((new Date(s + "T00:00:00Z").getUTCDay() + 6) % 7) + 1; // 1=Пн … 7=Вс
const fmtDateLabel = (s) => `${WEEKDAY_SHORT[isoDow(s) - 1]}, ${s.slice(8, 10)}.${s.slice(5, 7)}`;
const monthLabel = (m) => {
  if (!m) return "…";
  const [y, mo] = m.split("-").map(Number);
  const name = MONTHS_RU[mo - 1] || "";
  return name.charAt(0).toUpperCase() + name.slice(1) + " " + y;
};
const shiftMonth = (m, n) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const todayIso = () => new Date().toISOString().slice(0, 10);

export default function MoneyCalendar({ cabinetId, kind }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [month, setMonthState] = useState(() => searchParams.get("month") || "");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null); // null | {mode:'new', date} | {mode:'edit', item}
  const [dayListDate, setDayListDate] = useState(null); // null | 'YYYY-MM-DD' — items выводятся из data на каждый рендер
  const [receiveFor, setReceiveFor] = useState(null); // null | {mode:'mark'|'payout', item, value}
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1600));

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setMonth = useCallback((m) => {
    setMonthState(m);
    router.replace(`${pathname}?month=${m}`);
  }, [pathname, router]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ kind });
    if (month) q.set("month", month);
    return fetch(`/api/cabinets/${cabinetId}/payment-calendar?${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        if (!month) setMonth(d.month);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId, kind, month, setMonth]);

  useEffect(() => { load(); }, [load]);

  const catMap = useMemo(() => Object.fromEntries((data?.categories || []).map((c) => [c.key, c])), [data]);
  // Карта дата → items текущего ответа — DayListModal читает её каждый рендер,
  // чтобы после mark_paid/unmark/receive_payout внутри неё список не оставался устаревшим.
  const itemsByDate = useMemo(() => {
    const m = {};
    for (const w of (data?.weeks || [])) for (const d of w.days) m[d.date] = d.items;
    return m;
  }, [data]);

  async function doAction(body) {
    setError(null);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/payment-calendar`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) { setError(d.error || `Ошибка запроса (${r.status})`); return false; }
      await load();
      return true;
    } catch (e) { setError(String(e)); return false; }
  }

  // Наблюдатель (viewer) — только чтение (спека §3.5): API отдаёт canEdit=false, и ни плашка,
  // ни кружок статуса, ни пустая ячейка не открывают модалку и не шлют POST.
  const canEdit = data?.canEdit === true;

  function handleItemClick(item, e) {
    e.stopPropagation();
    if (!canEdit || item.status === "forecast") return;
    setModal({ mode: "edit", item });
  }

  function handleCircleClick(item, e) {
    e.stopPropagation();
    if (!canEdit) return;
    if (item.status === "planned") {
      if (kind === "income") setReceiveFor({ mode: "mark", item, value: String(item.amount) });
      else doAction({ action: "mark_paid", id: item.id });
    } else if (item.status === "paid") {
      doAction({ action: "unmark", id: item.id });
    } else if (item.status === "forecast") {
      setReceiveFor({ mode: "payout", item, value: String(item.amount) });
    }
  }

  function openDayList(day, e) {
    e.stopPropagation();
    setDayListDate(day.date);
  }

  function handleCellClick(date) {
    if (!canEdit) return;
    setModal({ mode: "new", date });
  }

  async function confirmReceive() {
    const amt = Number(receiveFor.value);
    const { item, mode } = receiveFor;
    // выплата МП бывает отрицательной (окно Ozon с удержаниями больше начислений)
    if (String(receiveFor.value).trim() === "" || !Number.isFinite(amt) || (mode === "mark" && amt < 0)) {
      setError(mode === "mark" ? "Сумма должна быть ≥ 0" : "Введите сумму"); return;
    }
    const ok = mode === "mark"
      ? await doAction({ action: "mark_paid", id: item.id, amount: amt })
      : await doAction({ action: "receive_payout", ref: item.ref, platform: item.platform, date: item.date, amount: amt, amount_planned: item.amount });
    if (ok) setReceiveFor(null);
  }

  function goToday() {
    setMonth((data?.today || todayIso()).slice(0, 7));
  }

  const totals = data?.totals || { planned: 0, paid: 0, left: 0, overdue: 0 };
  const today = data?.today || todayIso();
  const weeks = data?.weeks || [];
  const mobile = width < MOBILE_BREAK;

  return (
    <div style={{ fontFamily: FONT, color: C.ink }}>
      {/* Шапка: навигация по месяцу + новая запись */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setMonth(shiftMonth(month || today.slice(0, 7), -1))} style={navBtn} title="Предыдущий месяц">←</button>
          <span style={{ fontWeight: 700, fontSize: 15, minWidth: 140, textAlign: "center" }}>{monthLabel(month)}</span>
          <button onClick={() => setMonth(shiftMonth(month || today.slice(0, 7), 1))} style={navBtn} title="Следующий месяц">→</button>
          <button onClick={goToday} style={resetBtnStyle}>Сегодня</button>
        </div>
        {canEdit && (
          <button onClick={() => setModal({ mode: "new", date: today })} style={addBtnStyle}>
            + {kind === "income" ? "Поступление" : "Платёж"}
          </button>
        )}
      </div>

      {error && <div style={{ color: C.neg, marginBottom: 12 }}>⚠ {error}</div>}

      {/* Итоги месяца */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Запланировано" value={money(totals.planned)} />
        <Kpi label={kind === "income" ? "Получено" : "Оплачено"} value={money(totals.paid)} color={C.pos} />
        <Kpi label="Осталось" value={money(totals.left)} />
        <Kpi label="Просрочено" value={money(totals.overdue)} color={totals.overdue > 0 ? C.neg : C.muted} />
      </div>

      {loading && !data && <div style={{ padding: 24, textAlign: "center", color: C.faint }}>Загрузка…</div>}

      {data && (mobile ? (
        <MobileList weeks={weeks} today={today} catMap={catMap} kind={kind} canEdit={canEdit}
          onCellClick={handleCellClick} onItemClick={handleItemClick} onCircle={handleCircleClick} />
      ) : (
        <GridTable weeks={weeks} today={today} catMap={catMap} kind={kind} canEdit={canEdit}
          onCellClick={handleCellClick} onItemClick={handleItemClick} onCircle={handleCircleClick} onMore={openDayList} />
      ))}

      {modal && (
        <PaymentModal cabinetId={cabinetId} kind={kind} categories={data?.categories || []} recurring={data?.recurring || []}
          initial={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}

      {dayListDate && (
        <DayListModal date={dayListDate} items={itemsByDate[dayListDate] || []} today={today} catMap={catMap} kind={kind} canEdit={canEdit}
          onClose={() => setDayListDate(null)}
          onItemClick={(item, e) => { handleItemClick(item, e); setDayListDate(null); }}
          onCircle={handleCircleClick} />
      )}

      {receiveFor && (
        <ReceivePopover state={receiveFor} setState={setReceiveFor} kind={kind}
          onConfirm={confirmReceive} onClose={() => setReceiveFor(null)} />
      )}
    </div>
  );
}

// ---------------- Плашка платежа ----------------
function PaymentPill({ item, today, catMap, kind, canEdit, onClick, onCircle }) {
  const overdue = item.status === "planned" && item.date < today;
  const paid = item.status === "paid";
  const forecast = item.status === "forecast";
  const cat = catMap[item.cat] || { token: "line" };
  const circleTitle = paid ? "Отменить отметку" : forecast || kind === "income" ? "Отметить получение" : "Отметить оплату";
  return (
    <div
      onClick={(e) => onClick(item, e)}
      title={`${item.category || "—"}${item.counterparty ? " · " + item.counterparty : ""}`}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", borderRadius: 6,
        background: soft(cat.token, 14),
        border: overdue ? `1px solid ${C.neg}` : "1px solid transparent",
        borderLeft: `3px solid ${C[cat.token] || C.line}`,
        cursor: forecast || !canEdit ? "default" : "pointer", fontSize: 11, marginBottom: 3, minWidth: 0,
      }}
    >
      <button onClick={(e) => { e.stopPropagation(); onCircle(item, e); }}
        disabled={!canEdit}
        title={canEdit ? circleTitle : undefined}
        style={{
          width: 14, height: 14, borderRadius: "50%", flexShrink: 0, cursor: canEdit ? "pointer" : "default", padding: 0,
          border: `1.5px ${forecast ? "dashed" : "solid"} ${paid ? C.pos : (overdue ? C.neg : C.muted)}`,
          background: paid ? C.pos : "transparent", color: "#fff", fontSize: 9, lineHeight: "12px",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
        {paid ? "✓" : ""}
      </button>
      <span style={{
        flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        textDecoration: paid ? "line-through" : "none", color: paid ? C.muted : C.ink,
      }}>
        {item.category || "—"}{item.counterparty ? ` · ${item.counterparty}` : ""}
        {forecast && item.accruing ? <span style={{ color: C.faint }}> · копится</span> : null}
      </span>
      <span style={{ flexShrink: 0, fontWeight: 600, color: paid ? C.muted : C.ink }}>{fmtK(item.amount)}</span>
    </div>
  );
}

// ---------------- Сетка месяца (десктоп) ----------------
function GridTable({ weeks, today, catMap, kind, canEdit, onCellClick, onItemClick, onCircle, onMore }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <thead>
          <tr style={{ background: C.surface }}>
            {DOW.map((d) => <th key={d} style={thCell}>{d}</th>)}
            <th style={{ ...thCell, textAlign: "right", width: "13%" }}>ИТОГО</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, wi) => (
            <tr key={wi}>
              {w.days.map((day) => (
                <td key={day.date} onClick={() => onCellClick(day.date)}
                  style={{
                    verticalAlign: "top", border: `1px solid ${C.line}`, padding: 6, height: 104,
                    opacity: day.inMonth ? 1 : 0.45, cursor: canEdit ? "pointer" : "default", background: C.bg,
                  }}>
                  <div style={{ marginBottom: 4 }}>
                    <span style={day.date === today
                      ? { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: "50%", background: C.accent, color: "var(--accentInk)", fontSize: 12, fontWeight: 700 }
                      : { fontSize: 12, fontWeight: 600, color: C.muted }}>
                      {Number(day.date.slice(8, 10))}
                    </span>
                  </div>
                  {day.items.slice(0, 3).map((it) => (
                    <PaymentPill key={it.id ?? it.ref} item={it} today={today} catMap={catMap} kind={kind} canEdit={canEdit} onClick={onItemClick} onCircle={onCircle} />
                  ))}
                  {day.items.length > 3 && (
                    <button onClick={(e) => onMore(day, e)} style={miniLink}>ещё {day.items.length - 3}</button>
                  )}
                  {day.total > 0 && (
                    <div style={{ textAlign: "right", fontSize: 11, fontWeight: 700, color: C.muted, marginTop: 4 }}>{fmtK(day.total)}</div>
                  )}
                </td>
              ))}
              <td style={{ border: `1px solid ${C.line}`, padding: "8px 10px", verticalAlign: "middle", textAlign: "right", background: C.surface }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>{money(w.total)}</div>
                <div style={{ fontSize: 11, color: C.muted }}>
                  {w.left === 0 ? (kind === "income" ? "всё получено" : "всё оплачено") : `осталось ${fmtK(w.left)}`}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- Список дней (мобильная адаптация) ----------------
// Показываем только дни с платежами + сегодняшний день (даже пустой, чтобы можно было
// сразу добавить запись) — иначе список из ~30 пустых дней только шумит.
function MobileList({ weeks, today, catMap, kind, canEdit, onCellClick, onItemClick, onCircle }) {
  const allDays = weeks.flatMap((w) => w.days).filter((d) => d.inMonth);
  const hasAny = allDays.some((d) => d.items.length > 0);
  if (!hasAny) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: C.faint }}>
        {kind === "income" ? "Поступлений в этом месяце нет" : "Платежей в этом месяце нет"}
      </div>
    );
  }
  const days = allDays.filter((d) => d.items.length > 0 || d.date === today);
  return (
    <div>
      {days.map((day) => (
        <div key={day.date} onClick={() => onCellClick(day.date)}
          style={{
            border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, marginBottom: 8, cursor: canEdit ? "pointer" : "default",
            background: day.date === today ? soft("accent", 10) : C.surface,
          }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: day.items.length ? 6 : 0 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{fmtDateLabel(day.date)}{day.date === today ? " · сегодня" : ""}</span>
            {day.total > 0 && <span style={{ fontWeight: 700, color: C.muted, fontSize: 13 }}>{fmtK(day.total)}</span>}
          </div>
          {day.items.map((it) => (
            <PaymentPill key={it.id ?? it.ref} item={it} today={today} catMap={catMap} kind={kind} canEdit={canEdit} onClick={onItemClick} onCircle={onCircle} />
          ))}
          {!day.items.length && canEdit && <div style={{ fontSize: 11, color: C.faint }}>+ добавить</div>}
        </div>
      ))}
    </div>
  );
}

// ---------------- Модалка «ещё N» ----------------
function DayListModal({ date, items, today, catMap, kind, canEdit, onClose, onItemClick, onCircle }) {
  return (
    <div style={modalOverlay} onClick={onClose}>
      <div style={{ ...modalBox, maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <strong style={{ fontSize: 15 }}>{fmtDateLabel(date)}</strong>
          <button onClick={onClose} style={miniBtn}>✕</button>
        </div>
        {items.map((it) => (
          <PaymentPill key={it.id ?? it.ref} item={it} today={today} catMap={catMap} kind={kind} canEdit={canEdit} onClick={onItemClick} onCircle={onCircle} />
        ))}
      </div>
    </div>
  );
}

// ---------------- Поповер «фактическая сумма» (вместо window.prompt) ----------------
function ReceivePopover({ state, setState, kind, onConfirm, onClose }) {
  return (
    <div style={modalOverlay} onClick={onClose}>
      <div style={{ ...modalBox, maxWidth: 300 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 14 }}>
          {state.mode === "payout" ? "Фактически получено" : kind === "income" ? "Фактически получено" : "Фактическая сумма"}
        </div>
        <input type="number" step="any" autoFocus value={state.value}
          onChange={(e) => setState({ ...state, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") onConfirm(); }}
          style={{ ...inputStyle, width: "100%", marginBottom: 12, boxSizing: "border-box" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
          <button onClick={onConfirm} style={addBtnStyle}>Подтвердить</button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Мелкие UI-компоненты ----------------
function Kpi({ label, value, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 160px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink }}>{value}</div>
    </div>
  );
}

// ---------------- Стили ----------------
const navBtn = { width: 30, height: 30, borderRadius: 8, fontSize: 14, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const resetBtnStyle = { padding: "7px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const addBtnStyle = { padding: "8px 18px", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer", background: C.accent, color: "var(--accentInk)", border: "none" };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const miniLink = { display: "block", padding: "1px 0", fontSize: 10, color: C.accent, background: "transparent", border: "none", cursor: "pointer", textAlign: "left" };
const inputStyle = { padding: "7px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}` };
const modalOverlay = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 };
const modalBox = { background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, maxWidth: 480, width: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" };
const thCell = { padding: "8px 10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };
