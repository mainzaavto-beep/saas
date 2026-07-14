"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  accent2: "#2bd4a0", pos: "#4ade80", neg: "#ff6b6b", pink: "#f97316",
  blue: "#4f8cff",
};
const ALERT = {
  warn: { background: "rgba(251,191,36,0.10)", border: "1px solid rgba(251,191,36,0.35)", color: "#fbbf24" },
  info: { background: "rgba(79,140,255,0.10)", border: "1px solid rgba(79,140,255,0.35)", color: "#4f8cff" },
};

// =====================================================================
//  /finance/plan — UI плана продаж (заявка №29).
//
//  3 тумблера: «Месячный план» (редактируемый) / «Квартал-Год» (KPI+агрегат)
//  / «Потребность» (только просмотр).
//
//  Источники:
//    /api/plan        — список строк sales_plan (CRUD)
//    /api/cabinets/${cabinetId}/plan/fact   — план-факт (факт WB из wb_data.db)
//    /api/cabinets/${cabinetId}/plan/purchase — потребность в закупке
//    /api/cabinets/${cabinetId}/plan/targets — KPI-цели квартал/год
//    /api/cabinets/${cabinetId}/plan/approve — утвердить строку
//
//  Формулы совпадают с Python fin/plan.py (эталон, сверено копейка в копейку).
//  Редактируемые поля плана (7): qty_plan, price_no_spp (Цена без СПП, ₽/шт),
//  cost_plan (Себест ₽/шт, правка 2026-06-26), drr_plan (%), margin_plan_pct (%),
//  buyout_rate_plan (% выкупа).
//  Сумма ₽ (revenue_plan) — РАСЧЁТНОЕ: Продажи шт × Цена без СПП.
//  ROI план/факт — РАСЧЁТНОЕ: Прибыль ₽ / (Себест × Продажи шт). NULL если Себест не задан.
//  Заказы шт (qty_orders_plan) — RO: Продажи шт / % выкупа (NULL/0 → = продажи шт).
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const pct = (v, digits = 1) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const x = digits === 4 ? r4(v) : r2(v);
  return (x * 100).toFixed(digits) + "%"; // доля → проценты
};

export default function PlanPage({ cabinetId }) {
  const today = new Date().toISOString().slice(0, 7); // YYYY-MM
  const [period, setPeriod] = useState(today);
  const [platform, setPlatform] = useState("WB");
  const [tab, setTab] = useState("month"); // month | qy | purchase
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [savingKey, setSavingKey] = useState(null);

  // Запрос план-факта (для month и qy) или purchase.
  const api = useMemo(() => {
    const p = new URLSearchParams({ period, platform });
    if (tab === "purchase") return `/api/cabinets/${cabinetId}/plan/purchase?` + p.toString() + "&coverage=45";
    return `/api/cabinets/${cabinetId}/plan/fact?` + p.toString();
  }, [period, platform, tab]);

  useEffect(() => {
    setData(null); setError(null);
    fetch(api).then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  }, [api]);

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка плана…</Centered>;

  return (
    <main style={{ width: "100%", margin: 0, padding: "20px 18px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>План продаж</h1>
        <p style={{ margin: "3px 0 0", color: C.muted, fontSize: 13 }}>
          План-факт по SKU · {platform} · {period}
        </p>
      </div>

      {/* Верхняя панель: тумблер платформы + период + тумблер режима */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap" }}>
        <Field label="Платформа">
          <Seg>
            {[{ v: "WB", l: "WB" }, { v: "OZON", l: "Ozon" }, { v: "YA", l: "Яндекс" }].map((o) => (
              <SegBtn key={o.v} active={platform === o.v} onClick={() => setPlatform(o.v)}>{o.l}</SegBtn>
            ))}
          </Seg>
        </Field>
        <Field label="Период (ГГГГ-ММ)">
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Режим">
          <Seg>
            {[{ v: "month", l: "Месячный план" }, { v: "qy", l: "Квартал-Год" }, { v: "purchase", l: "Потребность" }].map((o) => (
              <SegBtn key={o.v} active={tab === o.v} onClick={() => setTab(o.v)}>{o.l}</SegBtn>
            ))}
          </Seg>
        </Field>
      </div>

      {tab === "month" && <MonthPlan data={data} setData={setData} platform={platform} period={period} savingKey={savingKey} setSavingKey={setSavingKey} />}
      {tab === "qy" && <QuarterYear data={data} platform={platform} period={period} />}
      {tab === "purchase" && <Purchase data={data} />}
    </main>
  );
}

// =====================================================================
//  Тумблер 1: Месячный план (редактируемый)
// =====================================================================
function MonthPlan({ data, setData, platform, period, savingKey, setSavingKey }) {
  const items = data.items || [];

  // Сохранение одного поля (6 редактируемых: qty_plan, price_no_spp, drr_plan,
  // margin_plan_pct, buyout_rate_plan; revenue_plan — больше НЕ редактируемое,
  // онo расчётное = Продажи шт × Цена без СПП) → POST /api/plan.
  // ПОЛЯ В ДОЛЯХ (drr_plan, margin_plan_pct, buyout_rate_plan): в БД хранятся
  // как 0.09=9%, а NumCell для unit="%" отдаёт ПРОЦЕНТЫ (как видит пользователь,
  // напр. 9). Бэкенд (_toFraction) и оптимистичный локальный апдейт ждут ДОЛЮ.
  // Поэтому проценты → доля: rawValue/100. Без этого оптимистичный апдейт клал
  // бы 9 в drr_plan, и перерендер (value=×100) показывал 9×100=900% (баг).
  const PCT_FIELDS = new Set(["drr_plan", "margin_plan_pct", "buyout_rate_plan"]);
  const saveField = useCallback(async (row, field, rawValue) => {
    const key = `${row.id}-${field}`;
    setSavingKey(key);
    // Поля-доли: % → доля для локального состояния (согласовано с БД и фактом).
    const storeValue = (PCT_FIELDS.has(field) && rawValue != null)
      ? rawValue / 100
      : rawValue;
    // Оптимистичный апдейт: мгновенно меняем локально.
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((it) => {
          if (it.id !== row.id) return it;
          const next = { ...it, [field]: storeValue };
          // Пересчёт Суммы ₽ (правка 2026-06-26): Продажи шт × Цена без СПП.
          // Триггерится правкой любого из двух. Бэкенд делает то же (источник истины),
          // это лишь мгновенный отклик в UI.
          if (field === "qty_plan" || field === "price_no_spp") {
            const qty = next.qty_plan || 0;
            const price = next.price_no_spp;
            next.revenue_plan = (price != null && Number.isFinite(price)) ? r2(qty * price) : 0;
          }
              // Пересчёт производных (margin_plan_rub).
              if (field === "price_no_spp" || field === "qty_plan" || field === "margin_plan_pct") {
                next.margin_plan_rub = r2((next.revenue_plan || 0) * (next.margin_plan_pct || 0));
              }
              // Пересчёт ROI (план) — правка 2026-06-26: Пр ₽ / (Себест × Продажи шт).
              // Триггерится правкой себест/продаж/цены/маржи% (всё, что меняет число или знаменатель).
              if (field === "cost_plan" || field === "qty_plan" || field === "price_no_spp" || field === "margin_plan_pct") {
                const cost = next.cost_plan;
                const qty = next.qty_plan || 0;
                const costTotal = (cost != null && cost > 0 && qty > 0) ? cost * qty : null;
                next.cost_total_plan = costTotal != null ? r2(costTotal) : null;
                next.roi_plan = (costTotal != null && costTotal > 0 && next.margin_plan_rub != null)
                  ? r4(next.margin_plan_rub / costTotal)
                  : null;
              }
          // Пересчёт Заказов шт (правка 2026-06-26): продажи шт / % выкупа.
          // buyout_rate_plan в долях; null/≤0 → заказы = продажи (как 100% выкупа).
          if (field === "qty_plan" || field === "buyout_rate_plan") {
            const rate = next.buyout_rate_plan;
            const qty = next.qty_plan || 0;
            next.qty_orders_plan = (rate != null && rate > 0) ? Math.round(qty / rate) : qty;
          }
          // Пересчёт %выполнения при правке плана.
          if (field === "qty_plan" && next.qty_fact != null) {
            next.qty_fulfill = (rawValue || 0) > 0 ? r4(next.qty_fact / rawValue) : null;
          }
          if ((field === "price_no_spp" || field === "qty_plan") && next.revenue_fact != null) {
            next.revenue_fulfill = (next.revenue_plan || 0) > 0 ? r4(next.revenue_fact / next.revenue_plan) : null;
          }
          return next;
        }),
      };
    });
    try {
      const body = { ...row, [field]: storeValue };
      const r = await fetch(`/api/cabinets/${cabinetId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || r.status);
      }
    } catch (e) {
      alert("Не сохранилось: " + e.message);
    } finally {
      setSavingKey(null);
    }
  }, [setSavingKey, setData]);

  // Утверждение строки.
  const approve = async (row) => {
    await fetch(`/api/cabinets/${cabinetId}/plan/approve?id=${row.id}`, { method: "POST" });
    setData((prev) => prev ? { ...prev, items: prev.items.map((it) => it.id === row.id ? { ...it, approved: 1 } : it) } : prev);
  };

  // Удаление (архив).
  const remove = async (row) => {
    if (!confirm(`Удалить строку "${row.sku_label}"?`)) return;
    await fetch(`/api/cabinets/${cabinetId}/plan?id=${row.id}`, { method: "DELETE" });
    setData((prev) => prev ? { ...prev, items: prev.items.filter((it) => it.id !== row.id) } : prev);
  };

  return (
    <>
      {/* KPI-сводка */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Kpi label="SKU в плане" value={items.length} />
        <Kpi label="План выручки" value={money(items.reduce((s, i) => s + (i.revenue_plan || 0), 0))} />
        <Kpi label="План маржи" value={money(items.reduce((s, i) => s + (i.margin_plan_rub || 0), 0))} />
        <Kpi label="Факт выручки" value={money(items.reduce((s, i) => s + (i.revenue_fact || 0), 0))} />
        <Kpi label="План шт" value={num(items.reduce((s, i) => s + (i.qty_plan || 0), 0))} />
        <Kpi label="Факт шт" value={num(items.reduce((s, i) => s + (i.qty_fact || 0), 0))} />
      </div>

      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            {/* Верхний ряд: Артикул | МП | ПЛАН (colspan=11) | ФАКТ (colspan=7) | %вып (colspan=2) | Действия */}
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              <th rowSpan={2} style={{ ...thStyle, textAlign: "left", minWidth: 150, maxWidth: 170 }}>Артикул</th>
              <th rowSpan={2} style={{ ...thStyle, minWidth: 80 }}>Статус</th>
              <th colSpan={11} style={{ ...thStyle, borderBottom: `1px solid ${C.line}`, color: C.accent }}>ПЛАН</th>
              <th colSpan={7} style={{ ...thStyle, borderBottom: `1px solid ${C.line}`, color: C.blue }}>ФАКТ</th>
              <th rowSpan={2} style={{ ...thStyle, minWidth: 70 }}>%вып</th>
              <th rowSpan={2} style={{ ...thStyle, minWidth: 70 }}>Действия</th>
            </tr>
            {/* ПЛАН = Заказы шт | % выкупа | Продажи шт | Цена без СПП | Себест | Сумма ₽ | ДРР % | ДРР ₽ | Пр % | Пр ₽ | ROI */}
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              <Th right>Заказы шт</Th><Th right>% выкупа</Th><Th right>Продажи шт</Th><Th right>Цена без СПП</Th><Th right>Себест</Th><Th right>Сумма ₽</Th><Th right>ДРР %</Th><Th right>ДРР ₽</Th><Th right>Пр %</Th><Th right>Пр ₽</Th><Th right>ROI</Th>
              <Th right>шт</Th><Th right>сумма ₽</Th><Th right>ДРР %</Th><Th right>ДРР ₽</Th><Th right>Пр %</Th><Th right>Пр ₽</Th><Th right>ROI</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} style={{ borderBottom: `1px solid ${C.line}33` }}>
                {/* Артикул — композитная ячейка с фото */}
                <td style={{ padding: "8px", maxWidth: 170 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <Thumb url={it.im_url} isNew={it.is_new} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }} title={it.name || it.sku_label}>
                        {it.is_new && "🆕 "}{it.name || it.sku_label}
                      </div>
                      <div style={{ fontSize: 11, color: C.faint }}>
                        {it.platform === "OZON"
                          ? (it.product_id ? `pid ${it.product_id}` : "—")
                          : (it.nm_id ? `nm ${it.nm_id}` : "—")}
                        {it.category ? ` · ${it.category}` : ""}
                      </div>
                    </div>
                  </div>
                </td>
                {/* Статус строки (✓ утверждён / черновик / 🆕 новый SKU) */}
                <td style={{ padding: "8px" }}>
                  {it.is_new ? (
                    <Badge bg={`${C.pink}22`} color={C.pink}>🆕 старт {it.launch_date ? it.launch_date.slice(5, 10) : "—"}</Badge>
                  ) : it.approved ? (
                    <Badge bg={`${C.pos}22`} color={C.pos}>✓ утверждён</Badge>
                  ) : (
                    <Badge bg={`${C.accent}22`} color={C.accent}>черновик</Badge>
                  )}
                </td>
                {/* ПЛАН (11 колонок). Заказы шт/Сумма ₽/ROI — RO. Цена/Себест/Пр%/ДРР% — ✏️.
                    Сумма ₽ = Продажи шт × Цена без СПП. ROI = Пр ₽ / (Себест × Продажи шт). */}
                <Td right style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}>{num(it.qty_orders_plan)}</Td>
                <NumCell row={it} field="buyout_rate_plan" value={it.buyout_rate_plan != null ? it.buyout_rate_plan * 100 : null} onSave={saveField} savingKey={savingKey} unit="%" />
                <NumCell row={it} field="qty_plan" value={it.qty_plan} onSave={saveField} savingKey={savingKey} int />
                <NumCell row={it} field="price_no_spp" value={it.price_no_spp} onSave={saveField} savingKey={savingKey} />
                <NumCell row={it} field="cost_plan" value={it.cost_plan} onSave={saveField} savingKey={savingKey} />
                <Td right style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}>{money(it.revenue_plan)}</Td>
                <NumCell row={it} field="drr_plan" value={it.drr_plan != null ? it.drr_plan * 100 : 0} onSave={saveField} savingKey={savingKey} unit="%" />
                <Td right style={{ color: C.muted }}>{money(it.drr_plan_rub)}</Td>
                <NumCell row={it} field="margin_plan_pct" value={it.margin_plan_pct != null ? it.margin_plan_pct * 100 : 0} onSave={saveField} savingKey={savingKey} unit="%" />
                <Td right style={{ color: C.muted }}>{money(it.margin_plan_rub)}</Td>
                <Td right style={{ color: it.roi_plan != null && it.roi_plan < 0 ? C.neg : C.muted, fontWeight: 600 }}>{pct(it.roi_plan, 0)}</Td>
                {/* ФАКТ (7 колонок, все RO — серым). ROI факт = Пр факт ₽ / (Себест × Факт шт). */}
                <Td right muted>{it.is_new || it.is_waiting ? <span style={{ color: C.faint }}>—</span> : num(it.qty_fact)}</Td>
                <Td right muted>{it.is_new || it.is_waiting ? <span style={{ color: C.faint }}>—</span> : money(it.revenue_fact)}</Td>
                <Td right muted>{it.is_new || it.is_waiting ? <span style={{ color: C.faint }}>—</span> : pct(it.drr_fact)}</Td>
                <Td right muted>{it.is_new || it.is_waiting ? <span style={{ color: C.faint }}>—</span> : money(it.drr_fact_rub)}</Td>
                <Td right muted>{it.is_new || it.is_waiting ? <span style={{ color: C.faint }}>—</span> : pct(it.margin_fact_pct)}</Td>
                <Td right muted>{it.is_new || it.is_waiting ? <span style={{ color: C.faint }}>—</span> : money(it.margin_fact_rub)}</Td>
                <Td right style={{ color: it.roi_fact != null && it.roi_fact < 0 ? C.neg : C.muted, fontWeight: 600 }}>{it.is_new || it.is_waiting ? <span style={{ color: C.faint }}>—</span> : pct(it.roi_fact, 0)}</Td>
                {/* %вып */}
                <td style={{ padding: "8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11.5 }}>
                  {it.is_new || it.is_waiting ? (
                    <span style={{ color: C.faint }}>—</span>
                  ) : (
                    <>
                      <div><span style={{ color: C.faint }}>шт </span><FulfillPct value={it.qty_fulfill} /></div>
                      <div><span style={{ color: C.faint }}>пр </span><FulfillPct value={it.margin_fulfill} /></div>
                    </>
                  )}
                </td>
                {/* Действия */}
                <td style={{ padding: "8px", display: "flex", gap: 4, alignItems: "center" }}>
                  {!it.approved && <button onClick={() => approve(it)} style={miniBtnStyle} title="Утвердить">✓</button>}
                  <button onClick={() => remove(it)} style={miniBtnStyle} title="Удалить">🗑</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={21} style={{ padding: 30, textAlign: "center", color: C.muted }}>
                Нет строк плана за {period} / {platform}. Создайте через «+».
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <NewPlanForm period={period} platform={platform} onCreated={() => {
        // Простой рефреш: дёрнем родительский reload через location.reload().
        // Позже можно сделать через lifting state up.
        if (typeof window !== "undefined") window.location.reload();
      }} />
    </>
  );
}

// Форма добавления нового SKU.
function NewPlanForm({ period, platform, onCreated }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [nmId, setNmId] = useState("");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState(""); // цена без СПП (₽/шт); Сумма ₽ = qty × price
  const [cost, setCost] = useState("");   // планируемая себестоимость (₽/шт); для ROI

  // Динамический label поля ID по платформе (заявка №31):
  // WB → «Артикул WB (nm_id)», OZON → «product_id Ozon», YA → «ID товара».
  // Под капотом значение пишется в nm_id (WB/YA) или product_id (OZON).
  const idLabel = platform === "WB" ? "Артикул WB (nm_id)"
                : platform === "OZON" ? "product_id Ozon"
                : "ID товара";

  const submit = async () => {
    if (!label.trim()) { alert("Введите имя SKU"); return; }
    const idVal = nmId.trim() || null;
    const priceVal = Number(price);
    const costVal = Number(cost);
    const body = {
      period, platform,
      sku_label: label.trim(),
      qty_plan: Number(qty) || 0,
      // Цена без СПП (правка 2026-06-26). Сервер считает revenue_plan = qty × price.
      price_no_spp: Number.isFinite(priceVal) ? priceVal : 0,
      // Планируемая себестоимость (правка 2026-06-26); null если не введена.
      cost_plan: Number.isFinite(costVal) ? costVal : null,
      is_new_sku: idVal ? 0 : 1,
    };
    // ID пишем в правильное поле по платформе.
    if (platform === "OZON") {
      body.product_id = idVal;
      body.nm_id = null;
    } else {
      body.nm_id = idVal;
      body.product_id = null;
    }
    const r = await fetch(`/api/cabinets/${cabinetId}/plan`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      setOpen(false); setLabel(""); setNmId(""); setQty(""); setPrice(""); setCost("");
      onCreated();
    } else {
      const e = await r.json().catch(() => ({}));
      alert("Ошибка: " + (e.error || r.status));
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ ...resetBtnStyle, marginTop: 14 }}>+ Добавить SKU</button>
    );
  }
  return (
    <div style={{ marginTop: 14, padding: 14, border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>Новый SKU в план {period} / {platform}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="Имя SKU"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="напр. Видеорегистратор X" style={inputStyle} /></Field>
        <Field label={idLabel}><input value={nmId} onChange={(e) => setNmId(e.target.value)} placeholder="оставьте пустым для нового" style={inputStyle} /></Field>
        <Field label="Продажи шт"><input type="number" value={qty} onChange={(e) => setQty(e.target.value)} style={inputStyle} /></Field>
        <Field label="Цена без СПП ₽"><input type="number" value={price} onChange={(e) => setPrice(e.target.value)} style={inputStyle} /></Field>
        <Field label="Себест ₽/шт"><input type="number" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="плановая" style={inputStyle} /></Field>
        <button onClick={submit} style={{ ...miniBtnStyle, padding: "9px 18px", fontSize: 13 }}>Создать</button>
        <button onClick={() => setOpen(false)} style={{ ...miniBtnStyle, padding: "9px 14px", fontSize: 13 }}>Отмена</button>
      </div>
    </div>
  );
}

// =====================================================================
//  Тумблер 2: Квартал-Год (обзор года: 12 мес по 4 кварталам + ИТОГО за год)
// =====================================================================
//  Запрашивает /api/cabinets/${cabinetId}/plan/fact для всех 12 месяцев выбранного года (параллельно),
//  агрегирует и показывает таблицу: строки сгруппированы по кварталам Q1–Q4,
//  внутри квартала — 3 месяца + подытог квартала, в самом низу — ИТОГО за год.
//  Колонки сгруппированы ПЛАН/ФАКТ, 5 полей: сумма ₽, ДРР %, ДРР ₽, Прибыль %, Прибыль ₽.
//  Один экран = весь год сразу (Q1+Q2+Q3+Q4 + год), без переключателя диапазона.
function QuarterYear({ data, platform, period }) {
  const [y] = period.split("-").map(Number);
  const yearLabel = `${y}`;
  // 12 месяцев года, разбитые по кварталам.
  const QUARTERS = useMemo(() => [
    { q: 1, months: [1, 2, 3] },
    { q: 2, months: [4, 5, 6] },
    { q: 3, months: [7, 8, 9] },
    { q: 4, months: [10, 11, 12] },
  ].map((qq) => ({ ...qq, ym: qq.months.map((mm) => `${y}-${String(mm).padStart(2, "0")}`) })), [y]);
  const allMonths = QUARTERS.flatMap((qq) => qq.ym);

  // Загружаем факт по всем 12 месяцам (параллельно).
  const [byMonth, setByMonth] = useState(null); // { 'YYYY-MM': items[] }
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    Promise.all(
      allMonths.map((mm) =>
        fetch(`/api/cabinets/${cabinetId}/plan/fact?period=${mm}&platform=${platform}`)
          .then((r) => r.json())
          .then((d) => [mm, d.error ? [] : (d.items || [])])
      )
    )
      .then((pairs) => { if (!cancelled) setByMonth(Object.fromEntries(pairs)); })
      .catch((e) => !cancelled && setErr(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [allMonths.join(","), platform]);

  if (loading) return <Centered>Загрузка {yearLabel}…</Centered>;
  if (err) return <Centered>⚠️ {err}</Centered>;
  if (!byMonth) return null;

  // Агрегация: из массива items → {plan, fact} с 5 полями. % — пересчёт из сумм.
  const agg = (items) => {
    const planRev = sum(items, "revenue_plan");
    const planAdRub = sum(items, "drr_plan_rub");
    const planProfitRub = sum(items, "margin_plan_rub");
    const factRev = sum(items, "revenue_fact");
    const factAdRub = sum(items, "ad_spend");
    const factProfitRub = sum(items, "margin_fact_rub");
    return {
      plan: { rev: planRev, drrPct: planRev > 0 ? planAdRub / planRev : null, drrRub: planAdRub,
              profitPct: planRev > 0 ? planProfitRub / planRev : null, profitRub: planProfitRub },
      fact: { rev: factRev, drrPct: factRev > 0 ? factAdRub / factRev : null, drrRub: factAdRub,
              profitPct: factRev > 0 ? factProfitRub / factRev : null, profitRub: factProfitRub },
    };
  };
  const rowFor = (mm) => ({ mm, ...agg(byMonth[mm] || []) });

  const RU = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const fmtMoney = (v) => (v == null || !Number.isFinite(v) ? "—" : RU.format(v));
  const fmtPct = (v) => (v == null || !Number.isFinite(v) ? "—" : (v * 100).toFixed(1) + "%");

  // ИТОГО за год = агрегат по всем 12 месяцам.
  const yearItems = allMonths.flatMap((mm) => byMonth[mm] || []);
  const yearTotal = agg(yearItems);
  const profitFulfill = yearTotal.plan.profitRub > 0 && yearTotal.fact.profitRub != null
    ? (yearTotal.fact.profitRub / yearTotal.plan.profitRub) * 100 : null;

  // Стиль строк-подытогов квартала и года.
  const qSubtotalStyle = { background: C.surfaceAlt, fontWeight: 700, borderTop: `1px solid ${C.line}` };
  const yearTotalStyle = { background: `${C.accent}11`, fontWeight: 800, borderTop: `2px solid ${C.accent}` };

  // Ячейка факта-прибыли — с цветом.
  const profitColor = (v) => ((v || 0) >= 0 ? C.pos : C.neg);

  return (
    <>
      {/* KPI-сводка по году */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Kpi label={`План выручки ${yearLabel}`} value={money(yearTotal.plan.rev)} />
        <Kpi label={`Факт выручки ${yearLabel}`} value={money(yearTotal.fact.rev)} />
        <Kpi label="План прибыли ₽" value={money(yearTotal.plan.profitRub)} />
        <Kpi label="Факт прибыли ₽" value={money(yearTotal.fact.profitRub)} color={(yearTotal.fact.profitRub || 0) >= 0 ? C.pos : C.neg} />
        <Kpi label="%вып прибыли" value={profitFulfill == null ? "—" : profitFulfill.toFixed(0) + "%"} color={profitFulfill == null ? C.ink : profitFulfill >= 100 ? C.pos : profitFulfill >= 80 ? C.accent : C.neg} />
      </div>

      {/* Таблица: 12 мес × ПЛАН/ФАКТ, сгруппированы по 4 кварталам + ИТОГО за год */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              <th rowSpan={2} style={{ ...thStyle, textAlign: "left", minWidth: 110 }}>Месяц</th>
              <th colSpan={5} style={{ ...thStyle, borderBottom: `1px solid ${C.line}`, color: C.accent }}>ПЛАН</th>
              <th colSpan={5} style={{ ...thStyle, borderBottom: `1px solid ${C.line}`, color: C.blue }}>ФАКТ</th>
            </tr>
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              <Th right>Сумма ₽</Th><Th right>ДРР %</Th><Th right>ДРР ₽</Th><Th right>Прибыль %</Th><Th right>Прибыль ₽</Th>
              <Th right>Сумма ₽</Th><Th right>ДРР %</Th><Th right>ДРР ₽</Th><Th right>Прибыль %</Th><Th right>Прибыль ₽</Th>
            </tr>
          </thead>
          <tbody>
            {QUARTERS.map((qq) => {
              // Подытог квартала = агрегат по его 3 месяцам.
              const qItems = qq.ym.flatMap((mm) => byMonth[mm] || []);
              const qTotal = agg(qItems);
              return (
                <FragmentByKey key={`q${qq.q}`}>
                  {/* Заголовок квартала (строка-разделитель) */}
                  <tr style={{ background: `${C.accent}0d` }}>
                    <td colSpan={11} style={{ padding: "6px 10px", fontSize: 11, fontWeight: 800, color: C.accent, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      Q{qq.q} ({qq.ym.map(fmtMonth).join(" · ")})
                    </td>
                  </tr>
                  {/* 3 месяца квартала */}
                  {qq.ym.map((mm) => {
                    const r = rowFor(mm);
                    return (
                      <tr key={mm} style={{ borderBottom: `1px solid ${C.line}22` }}>
                        <Td left style={{ paddingLeft: 22 }}>{fmtMonth(mm)}</Td>
                        <Td right>{fmtMoney(r.plan.rev)}</Td>
                        <Td right muted>{fmtPct(r.plan.drrPct)}</Td>
                        <Td right muted>{fmtMoney(r.plan.drrRub)}</Td>
                        <Td right muted>{fmtPct(r.plan.profitPct)}</Td>
                        <Td right>{fmtMoney(r.plan.profitRub)}</Td>
                        <Td right>{fmtMoney(r.fact.rev)}</Td>
                        <Td right muted>{fmtPct(r.fact.drrPct)}</Td>
                        <Td right muted>{fmtMoney(r.fact.drrRub)}</Td>
                        <Td right style={{ color: profitColor(r.fact.profitRub) }}>{fmtPct(r.fact.profitPct)}</Td>
                        <Td right style={{ color: profitColor(r.fact.profitRub), fontWeight: 700 }}>{fmtMoney(r.fact.profitRub)}</Td>
                      </tr>
                    );
                  })}
                  {/* Подытог квартала */}
                  <tr style={qSubtotalStyle}>
                    <td style={tdFootL}>ИТОГО Q{qq.q}</td>
                    <td style={tdFootR}>{fmtMoney(qTotal.plan.rev)}</td>
                    <td style={tdFootR}>{fmtPct(qTotal.plan.drrPct)}</td>
                    <td style={tdFootR}>{fmtMoney(qTotal.plan.drrRub)}</td>
                    <td style={tdFootR}>{fmtPct(qTotal.plan.profitPct)}</td>
                    <td style={tdFootR}>{fmtMoney(qTotal.plan.profitRub)}</td>
                    <td style={tdFootR}>{fmtMoney(qTotal.fact.rev)}</td>
                    <td style={tdFootR}>{fmtPct(qTotal.fact.drrPct)}</td>
                    <td style={tdFootR}>{fmtMoney(qTotal.fact.drrRub)}</td>
                    <td style={{ ...tdFootR, color: profitColor(qTotal.fact.profitRub) }}>{fmtPct(qTotal.fact.profitPct)}</td>
                    <td style={{ ...tdFootR, color: profitColor(qTotal.fact.profitRub) }}>{fmtMoney(qTotal.fact.profitRub)}</td>
                  </tr>
                </FragmentByKey>
              );
            })}
            {/* ИТОГО за год */}
            <tr style={yearTotalStyle}>
              <td style={tdFootL}>ИТОГО {yearLabel}</td>
              <td style={tdFootR}>{fmtMoney(yearTotal.plan.rev)}</td>
              <td style={tdFootR}>{fmtPct(yearTotal.plan.drrPct)}</td>
              <td style={tdFootR}>{fmtMoney(yearTotal.plan.drrRub)}</td>
              <td style={tdFootR}>{fmtPct(yearTotal.plan.profitPct)}</td>
              <td style={tdFootR}>{fmtMoney(yearTotal.plan.profitRub)}</td>
              <td style={tdFootR}>{fmtMoney(yearTotal.fact.rev)}</td>
              <td style={tdFootR}>{fmtPct(yearTotal.fact.drrPct)}</td>
              <td style={tdFootR}>{fmtMoney(yearTotal.fact.drrRub)}</td>
              <td style={{ ...tdFootR, color: profitColor(yearTotal.fact.profitRub) }}>{fmtPct(yearTotal.fact.profitPct)}</td>
              <td style={{ ...tdFootR, color: profitColor(yearTotal.fact.profitRub) }}>{fmtMoney(yearTotal.fact.profitRub)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <KpiTargetsEditor period={period} platform={platform} />
    </>
  );
}

// Хелпер: Fragment с key (чтобы React не ругался на map внутри tbody).
function FragmentByKey({ children }) {
  return <>{children}</>;
}

// Сумма поля по items (с защитой от null).
function sum(items, field) {
  let s = 0;
  for (const it of items) {
    const v = Number(it[field]);
    if (Number.isFinite(v)) s += v;
  }
  return s;
}
// 'YYYY-MM' → 'Месяц ГГГГ' по-русски.
const MONTHS_RU = ["", "Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
function fmtMonth(ym) {
  const [yy, mm] = ym.split("-").map(Number);
  return `${MONTHS_RU[mm]} ${yy}`;
}

// Редактор KPI-целей (plan_targets).
function KpiTargetsEditor({ period, platform }) {
  // Определим квартал из месяца: 2026-05 → 2026-Q2.
  const [y, m] = period.split("-").map(Number);
  const q = Math.ceil(m / 3);
  const targetPeriod = `${y}-Q${q}`;
  const [targets, setTargets] = useState(null);
  const [editing, setEditing] = useState(null);

  const loadTargets = () => {
    fetch(`/api/cabinets/${cabinetId}/plan/targets?period=${targetPeriod}&platform=${platform}`)
      .then((r) => r.json())
      .then((d) => setTargets(d.items?.[0] || null));
  };
  useEffect(loadTargets, [targetPeriod, platform]);

  const saveTarget = async (field, val) => {
    const body = { target_period: targetPeriod, platform, [field]: val };
    if (targets) {
      body.revenue_target = targets.revenue_target;
      body.margin_target_pct = targets.margin_target_pct;
      body.profit_target = targets.profit_target;
      body.drr_target = targets.drr_target;
    }
    body[field] = val;
    await fetch(`/api/cabinets/${cabinetId}/plan/targets`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setEditing(null);
    loadTargets();
  };

  return (
    <div style={{ padding: 14, border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>
        KPI-цели {targetPeriod} / {platform}
      </div>
      {!targets && <div style={{ color: C.muted, fontSize: 12 }}>Цели не заданы. Заполните поля.</div>}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <TargetField label="Выручка ₽" value={targets?.revenue_target} onSave={(v) => saveTarget("revenue_target", v)} editing={editing} setEditing={setEditing} field="revenue_target" />
        <TargetField label="Маржа %" value={targets?.margin_target_pct != null ? targets.margin_target_pct * 100 : null} onSave={(v) => saveTarget("margin_target_pct", v)} editing={editing} setEditing={setEditing} field="margin_target_pct" unit="%" />
        <TargetField label="Прибыль ₽" value={targets?.profit_target} onSave={(v) => saveTarget("profit_target", v)} editing={editing} setEditing={setEditing} field="profit_target" />
        <TargetField label="ДРР %" value={targets?.drr_target != null ? targets.drr_target * 100 : null} onSave={(v) => saveTarget("drr_target", v)} editing={editing} setEditing={setEditing} field="drr_target" unit="%" />
      </div>
    </div>
  );
}

function TargetField({ label, value, onSave, editing, setEditing, field, unit }) {
  const [draft, setDraft] = useState("");
  const isEditing = editing === field;
  return (
    <Field label={label}>
      {isEditing ? (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input
            autoFocus
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSave(Number(draft)); if (e.key === "Escape") setEditing(null); }}
            style={{ ...inputStyle, width: 110 }}
          />
          <button onClick={() => onSave(Number(draft))} style={miniBtnStyle}>✓</button>
        </div>
      ) : (
        <button onClick={() => { setDraft(value ?? ""); setEditing(field); }} style={{ ...inputStyle, cursor: "pointer", textAlign: "right", width: 130 }}>
          {value == null ? "—" : unit === "%" ? (Number(value)).toFixed(1) + "%" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value)}
        </button>
      )}
    </Field>
  );
}

// =====================================================================
//  Тумблер 3: Потребность в закупке (только просмотр)
// =====================================================================
function Purchase({ data }) {
  const items = data.items || [];
  const totals = data.totals || {};
  // Существующие = есть ID любого МП (nm_id для WB, product_id для OZON).
  const hasId = (i) => i.nm_id != null || i.product_id != null;
  const existing = items.filter(hasId);
  const news = items.filter((i) => !hasId(i));

  return (
    <>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Kpi label="К закупке шт" value={num(totals.qty_needed)} />
        <Kpi label="Бюджет закупки" value={money(totals.budget_rub)} />
        <Kpi label="Горизонт покрытия" value={(data.coverage || 45) + " дней"} />
      </div>

      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface, marginBottom: 14 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              <Th>Товар</Th>
              <Th right>План шт</Th>
              <Th right>Остаток</Th>
              <Th right>К закупке</Th>
              <Th right>Бюджет ₽</Th>
              <Th right>Дни до OOS</Th>
            </tr>
          </thead>
          <tbody>
            {existing.map((it) => (
              <tr key={it.id || it.nm_id || it.product_id} style={{ borderBottom: `1px solid ${C.line}33` }}>
                <Td left><strong>{it.sku_label}</strong><div style={{ fontSize: 11, color: C.faint }}>{it.platform === "OZON" ? `pid ${it.product_id}` : `nm ${it.nm_id}`} · {it.platform}</div></Td>
                <Td right>{num(it.qty_plan)}</Td>
                <Td right>{num(it.stock_now)}</Td>
                <Td right style={{ fontWeight: 700 }}>{num(it.qty_needed)}</Td>
                <Td right>{money(it.budget_rub)}</Td>
                <Td right><DaysToOos v={it.days_to_oos} /></Td>
              </tr>
            ))}
            <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}`, fontWeight: 800 }}>
              <td style={tdFootL}>Итого ({existing.length})</td>
              <td style={tdFootR}>—</td>
              <td style={tdFootR}>—</td>
              <td style={tdFootR}>{num(totals.qty_needed)}</td>
              <td style={tdFootR}>{money(totals.budget_rub)}</td>
              <td style={tdFootR}>—</td>
            </tr>
          </tbody>
        </table>
      </div>

      {news.length > 0 && (
        <div style={{ padding: 14, border: `1px solid ${C.pink}44`, borderRadius: 10, background: `${C.pink}08` }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>🆕 Новые SKU (заказать к старту)</div>
          {news.map((it) => (
            <div key={it.id} style={{ fontSize: 12.5, marginBottom: 4 }}>
              <strong>{it.sku_label}</strong> — план {num(it.qty_plan)} шт, нет остатка/себестоимости.
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function DaysToOos({ v }) {
  if (v == null) return <span style={{ color: C.faint }}>—</span>;
  const color = v < 7 ? C.neg : v < 14 ? C.accent : C.pos;
  return <span style={{ color, fontWeight: 600 }}>{num(v)} дн</span>;
}

// =====================================================================
//  Инлайн-редактируемая ячейка. Поля: qty_plan (int), price_no_spp,
//  cost_plan, drr_plan/margin_plan_pct/buyout_rate_plan (unit="%",
//  value уже в ПРОЦЕНТАХ — компонент умножение не делает).
//  Конверсия % → доля для локального стейта делается в saveField (PCT_FIELDS).
// =====================================================================
function NumCell({ row, field, value, onSave, savingKey, int, unit }) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => { setText(String(value ?? "")); }, [value]);

  const commit = () => {
    setEditing(false);
    let n = int ? parseInt(text) : parseFloat(text);
    if (!Number.isFinite(n)) { setText(String(value ?? "")); return; }
    if (n === value) return;
    onSave(row, field, n);
  };

  const key = `${row.id}-${field}`;
  const saving = savingKey === key;

  if (editing) {
    return (
      <td style={{ padding: "4px 8px" }}>
        <input
          autoFocus
          type="number"
          step={int ? 1 : "any"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { setText(String(value ?? "")); setEditing(false); } }}
          style={{ ...inputStyle, width: 80, padding: "4px 6px" }}
        />
      </td>
    );
  }
  return (
    <td style={{ padding: "8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
      <button
        onClick={() => setEditing(true)}
        style={{ background: "transparent", border: "none", cursor: "pointer", color: C.ink, fontFamily: "inherit", fontSize: 12.5, fontVariantNumeric: "tabular-nums", padding: 0 }}
        title="Кликни чтобы править"
      >
        {value == null ? <span style={{ color: C.faint }}>—</span> : (int ? num(value) : unit === "%" ? r2(value) + "%" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value))}
        {saving ? " ⏳" : ""}
      </button>
    </td>
  );
}

function FulfillPct({ value }) {
  if (value == null) return <span style={{ color: C.faint }}>—</span>;
  const p = value * 100;
  const color = p >= 100 ? C.pos : p >= 80 ? C.accent : C.neg;
  return <span style={{ color, fontWeight: 600 }}>{p.toFixed(0)}%</span>;
}

// =====================================================================
//  Хелперы UI
// =====================================================================
const thStyle = { padding: "10px 8px", fontSize: 11, color: C.muted, textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap", textAlign: "center" };
function Th({ children, right }) {
  return <th style={{ ...thStyle, textAlign: right ? "right" : "left" }}>{children}</th>;
}
function Td({ children, right, left, muted, style }) {
  return <td style={{ padding: "8px 8px", fontSize: 12.5, whiteSpace: "nowrap", textAlign: right ? "right" : left ? "left" : "center", fontVariantNumeric: right ? "tabular-nums" : "normal", color: muted ? C.muted : undefined, ...style }}>{children}</td>;
}
const tdFootL = { padding: "10px 8px", fontSize: 12.5, fontWeight: 800, color: C.ink, textAlign: "left", whiteSpace: "nowrap" };
const tdFootR = { padding: "10px 8px", fontSize: 12.5, fontWeight: 800, color: C.ink, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

function Kpi({ label, value, color }) {
  return (
    <div style={{ padding: "12px 16px", borderRadius: 10, background: C.surface, border: `1px solid ${C.line}`, minWidth: 130 }}>
      <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function Badge({ bg, color, children }) {
  return <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{children}</span>;
}

function Seg({ children }) {
  return <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>{children}</div>;
}
function SegBtn({ active, onClick, children }) {
  return <button onClick={onClick} style={{ padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none", background: active ? C.accent : C.surfaceAlt, color: active ? "#0A1A1C" : C.ink, fontFamily: "inherit" }}>{children}</button>;
}
function Field({ label, children }) {
  return (
    <label style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</span>
      <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>{children}</div>
    </label>
  );
}
const inputStyle = { padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit" };
const resetBtnStyle = { padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, border: `1px solid ${C.accent}`, background: C.accent, color: "#0A1A1C", fontFamily: "inherit" };
const miniBtnStyle = { padding: "4px 8px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontFamily: "inherit" };

function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}

// Мини-фото товара для композитной ячейки (как на /products/orders).
function Thumb({ url, isNew }) {
  const [err, setErr] = useState(false);
  if (isNew) {
    return (
      <div style={{ width: 36, height: 36, borderRadius: 6, flexShrink: 0, background: `${C.pink}22`, border: `1px solid ${C.pink}55`, display: "grid", placeItems: "center", color: C.pink, fontSize: 16 }}>🆕</div>
    );
  }
  if (!url || err) {
    return (
      <div style={{ width: 36, height: 36, borderRadius: 6, flexShrink: 0, background: C.surfaceAlt, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", color: C.faint, fontSize: 14 }}>🖼</div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={36} height={36} onError={() => setErr(true)} style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6, flexShrink: 0, border: `1px solid ${C.line}` }} />
  );
}
