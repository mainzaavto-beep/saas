"use client";

import { useEffect, useState, useCallback } from "react";
const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  accent2: "#2bd4a0", pos: "#4ade80", neg: "#ff6b6b", pink: "#f97316",
  blue: "#4f8cff",
};

// =====================================================================
//  /finance/purchase-plan — План закупок (pivot, заявка №35, контракт №36).
//
//  fin_data.db.purchase_plan: недели=строки, для каждого SKU две колонки
//  [Закуп, Поступление] с инлайн-редактируемыми input (onBlur/Enter → POST).
//  type=purchase (Закуп=деньги наружу), type=receipt (Поступление=товар внутрь).
//  Δ = поступления − закуп (кассовый разрыв: отрицательное = больше потратили).
//
//  Источник правды = дашборд (НЕ Sheets). Эталон: fin/db_local.py:fetch_purchase_plan_pivot.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v) || v === 0
    ? ""
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v);
const fmtK = (v) => {
  if (v == null || !Number.isFinite(v) || v === 0) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
};

export default function PurchasePlanPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // "week|nmId|type"
  const [editVal, setEditVal] = useState("");

  // ── Черновик из авто-расчёта потребности (2026-06-27). ──
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftData, setDraftData] = useState(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftErr, setDraftErr] = useState(null);
  const [draftWindow, setDraftWindow] = useState(7);
  const [draftLeadTime, setDraftLeadTime] = useState(45);
  const [draftReplenish, setDraftReplenish] = useState(30);
  const [draftChecked, setDraftChecked] = useState({}); // {<key>: true}

  const api = `/api/cabinets/${cabinetId}/purchase-plan?pivot=1`;

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(api)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { reload(); }, [reload]);

  async function saveCell(week, nmId, type) {
    const amount = Number(editVal);
    setEditing(null);
    if (!Number.isFinite(amount) || amount < 0) return;
    // Пустая ячейка (0) → сохраняем 0 (не архивируем, чтобы ячейка осталась редактируемой).
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week, nm_id: nmId, type, amount }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        alert("Не сохранилось: " + (d.error || ""));
        return;
      }
      reload();
    } catch (e) {
      alert("Ошибка: " + e.message);
    }
  }

  // ── Черновик из авто-расчёта (оборачиваемость). ──
  async function openDraft() {
    setDraftOpen(true);
    setDraftErr(null);
    setDraftData(null);
    setDraftChecked({});
    setDraftLoading(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-plan`);
      const d = await r.json();
      if (!r.ok || d.error) { setDraftErr(d.error || "Ошибка"); }
      else {
        setDraftData(d);
        // По умолчанию отмечаем все рекомендованные (recommend=true) и без exists.
        const init = {};
        (d.items || []).forEach((it) => {
          const k = draftKey(it);
          if (it.recommend && !it.exists && it.qty_needed > 0) init[k] = true;
        });
        setDraftChecked(init);
      }
    } catch (e) { setDraftErr(String(e)); }
    finally { setDraftLoading(false); }
  }

  async function applyDraft() {
    if (!draftData) return;
    const items = (draftData.items || [])
      .filter((it) => draftChecked[draftKey(it)])
      .map((it) => ({ nm_id: it.nm_id, product_id: it.product_id, platform: it.platform,
                       amount: it.budget_rub, qty: it.qty_needed }));
    if (items.length === 0) { alert("Ничего не отмечено"); return; }
    if (!confirm(`Записать ${items.length} строк плана закупок на неделю ${draftData.week}? (type=purchase, note=[auto turnover])`)) return;
    setDraftLoading(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/purchase-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week: draftData.week, engine: "turnover", items }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { setDraftErr(d.error || "Ошибка"); setDraftLoading(false); return; }
      setDraftOpen(false);
      reload();
    } catch (e) { setDraftErr(String(e)); setDraftLoading(false); }
  }

  function draftKey(it) { return `${it.platform}|${it.nm_id || it.product_id || it.sku_label}`; }

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (loading && !data) return <Centered>Загрузка…</Centered>;
  if (!data) return <Centered>Нет данных</Centered>;

  const { weeks, nms, nms_meta, types } = data;

  // KPI: Σзакуп, Σпоступление, Δ за весь период.
  const totals = weeks.reduce(
    (acc, w) => {
      acc.purchase += w.purchase_total || 0;
      acc.receipt += w.receipt_total || 0;
      return acc;
    },
    { purchase: 0, receipt: 0 }
  );
  totals.delta = totals.receipt - totals.purchase;
  totals.purchase = Math.round(totals.purchase * 100) / 100;
  totals.receipt = Math.round(totals.receipt * 100) / 100;
  totals.delta = Math.round(totals.delta * 100) / 100;

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", margin: "0 auto" }}>
      <Header />

      {/* Кнопка авто-генератора черновика */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <button onClick={() => setDraftOpen(true)} style={draftBtnStyle}>⚡ Заполнить из расчёта</button>
      </div>

      {/* Плашка методологии */}
      <div style={{ ...alertStyle, marginBottom: 16 }}>
        <strong>План закупок</strong> — редактируемый pivot: недели = строки, для каждого SKU
        колонки <strong>Закуп</strong> (деньги наружу) и <strong>Поступление</strong> (товар внутрь).
        Кликни по ячейке, чтобы ввести сумму → Enter/onBlur сохраняет. Δ = поступления − закуп
        (отрицательное = кассовый разрыв: больше потратили, чем получили).
      </div>

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Σ Закуп" value={fmtK(totals.purchase)} color={C.neg} />
        <Kpi label="Σ Поступление" value={fmtK(totals.receipt)} color={C.pos} />
        <Kpi label="Δ (кассовый разрыв)" value={fmtK(totals.delta)} color={totals.delta < 0 ? C.neg : C.pos} />
        <Kpi label="Недель" value={weeks.length} />
        <Kpi label="SKU" value={nms.length} />
      </div>

      {weeks.length === 0 ? (
        <Centered>Нет данных плана закупок. Добавьте через ячейки ниже (после появления SKU).</Centered>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              {/* Двухуровневый заголовок: SKU (colspan=2) + итоги */}
              <tr style={{ background: C.surface, borderBottom: `1px solid ${C.line}` }}>
                <th rowSpan={2} style={thLeft}>Неделя</th>
                {nms.map((nm) => (
                  <th key={nm} colSpan={2} style={{ ...thCenter, borderBottom: `1px solid ${C.line}` }}>
                    <NmHeader nm={nm} meta={nms_meta[nm]} />
                  </th>
                ))}
                <th rowSpan={2} style={thR}>Σ Закуп</th>
                <th rowSpan={2} style={thR}>Σ Поступ.</th>
                <th rowSpan={2} style={thR}>Δ</th>
              </tr>
              <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
                {nms.map((nm) => (
                  <>
                    <th key={`${nm}-p`} style={subTh}>Закуп</th>
                    <th key={`${nm}-r`} style={subTh}>Пост.</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => {
                const deltaNeg = w.delta < 0;
                return (
                  <tr key={w.week} style={{ borderBottom: `1px solid ${C.line}33` }}>
                    <td style={{ padding: "8px 10px", fontWeight: 600, whiteSpace: "nowrap" }}>{w.week}</td>
                    {nms.map((nm) =>
                      types.map((t) => {
                        const key = `${w.week}|${nm}|${t}`;
                        const cellKey = `${nm}:${t}`;
                        const val = w.cells[cellKey];
                        const isEditing = editing === key;
                        return (
                          <td key={key} style={tdRight} width={90}>
                            {isEditing ? (
                              <input
                                autoFocus
                                type="number"
                                value={editVal}
                                onChange={(e) => setEditVal(e.target.value)}
                                onBlur={() => saveCell(w.week, nm, t)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveCell(w.week, nm, t);
                                  if (e.key === "Escape") setEditing(null);
                                }}
                                style={{ ...inputStyle, width: "100%", padding: "3px 6px", textAlign: "right" }}
                              />
                            ) : (
                              <button
                                onClick={() => {
                                  setEditing(key);
                                  setEditVal(val != null ? String(val) : "");
                                }}
                                style={{
                                  ...cellBtn,
                                  color: val != null && val > 0
                                    ? t === "purchase" ? C.neg : C.pos
                                    : C.faint,
                                }}
                                title="Кликни чтобы править"
                              >
                                {money(val) || "·"}
                              </button>
                            )}
                          </td>
                        );
                      })
                    )}
                    <td style={tdRight}><span style={{ color: C.neg }}>{fmtK(w.purchase_total)}</span></td>
                    <td style={tdRight}><span style={{ color: C.pos }}>{fmtK(w.receipt_total)}</span></td>
                    <td style={tdRight}>
                      <strong style={{ color: deltaNeg ? C.neg : C.pos }}>{fmtK(w.delta)}</strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {/* Итоговая строка */}
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.line}`, background: C.surface, fontWeight: 700 }}>
                <td style={tdLeftFoot}>Итого ({weeks.length} нед.)</td>
                {nms.map((nm) => (
                  <>
                    <td key={`${nm}-tp`} style={tdFootR} colSpan={2}></td>
                  </>
                ))}
                <td style={tdFootR}><span style={{ color: C.neg }}>{fmtK(totals.purchase)}</span></td>
                <td style={tdFootR}><span style={{ color: C.pos }}>{fmtK(totals.receipt)}</span></td>
                <td style={tdFootR}><span style={{ color: totals.delta < 0 ? C.neg : C.pos }}>{fmtK(totals.delta)}</span></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Модал черновика */}
      {draftOpen && (
        <DraftModal
          window={draftWindow} setWindow={setDraftWindow}
          leadTime={draftLeadTime} setLeadTime={setDraftLeadTime}
          replenish={draftReplenish} setReplenish={setDraftReplenish}
          data={draftData} loading={draftLoading} err={draftErr}
          checked={draftChecked} setChecked={setDraftChecked}
          draftKey={draftKey}
          onReload={openDraft} onApply={applyDraft} onClose={() => setDraftOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------- Модал черновика (оборачиваемость) ----------------

function DraftModal({ window, setWindow, leadTime, setLeadTime, replenish, setReplenish,
                      data, loading, err, checked, setChecked, draftKey, onReload, onApply, onClose }) {
  const items = (data?.items || []).filter((it) => it.recommend);  // показываем только рекомендованные
  const checkedCount = items.filter((it) => checked[draftKey(it)]).length;
  const checkedBudget = items
    .filter((it) => checked[draftKey(it)])
    .reduce((s, it) => s + (it.budget_rub || 0), 0);
  const toggle = (k) => setChecked({ ...checked, [k]: !checked[k] });
  const toggleAll = () => {
    const allChecked = checkedCount === items.length;
    const next = {};
    if (!allChecked) items.forEach((it) => { next[draftKey(it)] = true; });
    setChecked(next);
  };
  return (
    <div style={modalOverlay} onClick={onClose}>
      <div style={modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>⚡ Рекомендация от оборачиваемости</h2>
          <button onClick={onClose} style={miniBtn}>✕</button>
        </div>
        <div style={{ ...alertStyle, marginBottom: 12, fontSize: 11 }}>
          Берём <strong>средние продажи за {window} дней</strong> → скорость/день.
          <code> days_of_cover = остаток ÷ скорость</code>. Если cover &lt;
          <strong> lead_time ({leadTime} дн)</strong> → рекомендация закупить столько, чтобы
          остатка хватило на (lead_time + replenish {replenish}) дней. Расчёт в
          <code> fin/turnover.py</code> (гибрид: дашборд вызывает). Отметьте SKU →
          «Применить» запишет в <code>purchase_plan</code> (type=purchase, note=[auto turnover])
          на неделю <strong>{data?.week || "—"}</strong>.
        </div>

        {/* Параметры */}
        <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: C.muted }}>
            Окно продаж, дней
            <input type="number" value={window} onChange={(e) => setWindow(Number(e.target.value) || 7)} style={{ ...inputStyle, width: 80 }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: C.muted }}>
            Lead time, дней
            <input type="number" value={leadTime} onChange={(e) => setLeadTime(Number(e.target.value) || 45)} style={{ ...inputStyle, width: 80 }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: C.muted }}>
            Цикл пополнения, дней
            <input type="number" value={replenish} onChange={(e) => setReplenish(Number(e.target.value) || 30)} style={{ ...inputStyle, width: 90 }} />
          </label>
          <button onClick={onReload} disabled={loading} style={addBtnStyle}>{loading ? "…" : "Рассчитать"}</button>
        </div>

        {err && <div style={{ color: C.neg, marginBottom: 10 }}>⚠ {err}</div>}

        {data && (
          <>
            {/* KPI черновика */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <KpiSmall label="Рекомендовано SKU" value={String(data.totals?.recommend_count ?? items.length)} color={C.neg} />
              <KpiSmall label="Отмечено" value={String(checkedCount)} color={C.accent} />
              <KpiSmall label="Бюджет отмеч." value={fmtK(checkedBudget)} />
              <KpiSmall label="Σ к закупке (отмеч.)" value={String(items.filter((it) => checked[draftKey(it)]).reduce((s, it) => s + (it.qty_needed || 0), 0))} />
            </div>

            {items.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: C.faint }}>
                Нет SKU к дозакупке — у всех остаток хватает дольше чем на {leadTime} дней.
              </div>
            ) : (
              <div style={{ maxHeight: 380, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
                    <tr>
                      <th style={thLeftSmall}><input type="checkbox" checked={checkedCount === items.length && items.length > 0} onChange={toggleAll} /></th>
                      <th style={thLeftSmall}>SKU</th>
                      <th style={thRSmall}>Прод {window}д</th>
                      <th style={thRSmall}>Ср/день</th>
                      <th style={thRSmall}>Остаток</th>
                      <th style={thRSmall}>Cover, дн</th>
                      <th style={thRSmall}>К закупке</th>
                      <th style={thRSmall}>Бюджет ₽</th>
                      <th style={thLeftSmall}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const k = draftKey(it);
                      const isChk = !!checked[k];
                      const cover = it.days_of_cover;
                      // Цвет cover: красный если <lead_time/3 (критично), жёлтый <2/3, иначе оранж
                      const coverColor = cover == null ? C.faint
                        : cover < leadTime / 3 ? C.neg
                        : cover < (leadTime * 2) / 3 ? "#FFA000" : "#FF6F00";
                      return (
                        <tr key={k} style={{ borderBottom: `1px solid ${C.line}33`, opacity: it.exists ? 0.45 : 1 }}>
                          <td style={{ padding: "5px 8px" }}>
                            <input type="checkbox" disabled={it.exists} checked={isChk && !it.exists} onChange={() => toggle(k)} />
                          </td>
                          <td style={{ padding: "5px 8px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <span style={{ fontSize: 10, color: C.faint }}>{it.platform}</span>{" "}
                            {it.sku_label || `nm ${it.nm_id}` || `pid ${it.product_id}`}
                          </td>
                          <td style={tdRSmall}>{it.sold_window}</td>
                          <td style={tdRSmall}>{(it.avg_daily ?? 0).toFixed(1)}</td>
                          <td style={tdRSmall}>{it.stock_now}</td>
                          <td style={tdRSmall}><strong style={{ color: coverColor }}>{cover == null ? "∞" : `${cover}`}</strong></td>
                          <td style={tdRSmall}><strong style={{ color: it.qty_needed > 0 ? C.neg : C.faint }}>{it.qty_needed || "·"}</strong></td>
                          <td style={tdRSmall}>{it.budget_rub ? fmtK(it.budget_rub) : "—"}</td>
                          <td style={{ padding: "5px 8px", fontSize: 10 }}>
                            {it.exists ? <span style={{ color: C.faint }}>уже есть ⚡</span> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
              <button onClick={onApply} disabled={loading || checkedCount === 0} style={{ ...addBtnStyle, opacity: checkedCount === 0 ? 0.5 : 1 }}>
                Применить ({checkedCount} SKU)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function KpiSmall({ label, value, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 12px", flex: "1 1 110px", minWidth: 100 }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color || C.ink }}>{value}</div>
    </div>
  );
}

// ---------------- UI-компоненты ----------------

function NmHeader({ nm, meta }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center", padding: "4px 6px" }}>
      {meta?.im_url ? (
        <img src={meta.im_url} alt="" width={28} height={28} style={{ borderRadius: 4, objectFit: "cover", border: `1px solid ${C.line}` }} />
      ) : (
        <div style={{ width: 28, height: 28, borderRadius: 4, background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>📦</div>
      )}
      <div style={{ fontSize: 11, lineHeight: 1.2 }}>
        <div style={{ fontWeight: 600, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {meta?.name || `nm ${nm}`}
        </div>
        <div style={{ color: C.faint, fontSize: 10 }}>nm {nm}</div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div style={{ marginBottom: 14 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>План закупки</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Редактируемый pivot плана закупок по неделям и SKU. Источник правды — дашборд.
      </p>
    </div>
  );
}

function Centered({ children }) {
  return <div style={{ fontFamily: FONT, color: C.ink, padding: 40, textAlign: "center" }}>{children}</div>;
}

function Kpi({ label, value, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 150px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink }}>{value}</div>
    </div>
  );
}

// ---------------- Стили ----------------
const inputStyle = {
  padding: "6px 10px", borderRadius: 6, fontSize: 13,
  background: C.bg, color: C.ink, border: `1px solid ${C.line}`,
};
const cellBtn = {
  border: "none", background: "transparent", cursor: "pointer",
  padding: "4px 6px", width: "100%", textAlign: "right",
  fontVariantNumeric: "tabular-nums", fontSize: 13,
};
const draftBtnStyle = {
  padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
  background: C.accent, color: "#0A1A1C", border: "none",
};
const modalOverlay = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20,
};
const modalBox = {
  background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12,
  padding: 20, maxWidth: 820, width: "100%", maxHeight: "88vh", overflowY: "auto",
  boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
};
const resetBtnStyle = {
  padding: "8px 16px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const addBtnStyle = {
  padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
  background: C.accent, color: "#0A1A1C", border: "none",
};
const miniBtn = {
  padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const thLeftSmall = { padding: "6px 8px", fontWeight: 600, fontSize: 10, color: C.muted, textTransform: "uppercase", textAlign: "left" };
const thRSmall = { ...thLeftSmall, textAlign: "right" };
const tdRSmall = { padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };
const thCenter = { ...thLeft, textAlign: "center" };
const thR = { ...thLeft, textAlign: "right" };
const subTh = { padding: "6px 4px", fontWeight: 600, fontSize: 10, color: C.faint, textTransform: "uppercase", textAlign: "center" };
const tdRight = { padding: "4px 6px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeftFoot = { padding: "10px", textAlign: "left" };
const tdFootR = { padding: "10px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const alertStyle = {
  padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
  background: C.surface, border: `1px solid ${C.line}`, color: C.muted,
};
