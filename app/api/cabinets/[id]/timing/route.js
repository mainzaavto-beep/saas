import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
// =====================================================================
//  «Заказы по времени» — WB + Ozon. Два режима гранулярности:
//
//  granularity=hour (ПО УМОЛЧАНИЮ): тепловая карта (день недели × час) по ЗАКАЗАМ.
//    Источник: orders.order_dt (час из даты заказа) из wb_data.db + ozon_data.db.
//    Только заказы — у остальных метрик нет часовой гранулярности в API.
//
//  granularity=m30 (НОВЫЙ): 30-минутная динамика Воронки WB (клики/корзины/заказы/
//    продажи₽/избранное) по выбранным метрикам. Источник: таблица metrics_30m
//    (кумулятивные снапшоты, собираются раз в 30 мин сборщиком wb_metrics_30m.py).
//    Дельта (прирост за 30 мин) считается здесь из кумулятивов. Только WB (Ozon позже).
//
//  Параметры:
//    granularity = hour | m30 (по умолчанию hour — текущее поведение не ломаем)
//    metric      = orders | clicks | cart | order_sum | favorites (только для m30)
//    mp          = all | wb | ozon (m30 реагирует только на wb)
//    period      = all | YYYY-MM   ; from/to = YYYY-MM-DD (диапазон)
//    q           = поиск по артикулу МП / артикулу продавца / имени
//    nm, brand, group — фильтры товара (как в /api/geography)
// =====================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";




export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const mp = url.searchParams.get("mp") || "all";
    const period = url.searchParams.get("period") || "all";
    const fromQ = url.searchParams.get("from") || "";
    const toQ = url.searchParams.get("to") || "";
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const nm = url.searchParams.get("nm") || "";
    const brand = url.searchParams.get("brand") || "";
    const group = url.searchParams.get("group") || "";
    const granularity = url.searchParams.get("granularity") || "hour";
    const mps = cabinet.marketplaces || ["wb", "ozon"];
    const metric = url.searchParams.get("metric") || "orders";            // для m30

    // Пресет месяца → диапазон
    let from = fromQ, to = toQ;
    if (period !== "all" && /^\d{4}-\d{2}$/.test(period)) {
      const [y, m] = period.split("-").map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      from = `${period}-01`;
      to = `${period}-${String(lastDay).padStart(2, "0")}`;
    }

    const facets = await collectFacets(mp);

    // ── Режим m30: 30-минутная воронка WB (отдельная ветка, раньше return). ──
    if (granularity === "m30") {
      const result = collectMetric30m({ from, to, q, nm, brand, group, metric });
      const WD = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
      return NextResponse.json({
        granularity: "m30",
        metric,
        period: result.range,
        months: result.months,
        selected: { mp, period, from, to, q, nm, brand, group, granularity, metric },
        total: result.total,
        weekdays: WD.map((label, i) => ({ label, short: label.slice(0, 2), count: result.byWeekday[i] })),
        hours: result.byHour.map((count, h) => ({ hour: h, count })),       // агрегация по часам (из 30м)
        slots30: result.bySlot.map((count, s) => ({ slot: s, count })),     // 48 бинов 00:00..23:30
        heatmap: result.heatmap,                                             // 7×48 (день × 30-мин слот)
        note: result.note,
        facets,
      });
    }

    // Сетка 7×24 + распределения
    const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
    const byWeekday = Array(7).fill(0);
    const byHour = Array(24).fill(0);
    let total = 0;
    const months = new Set();
    let range = { from: null, to: null };

    if (mp !== "ozon") {
      const wb = await collectCell("wb", { from, to, q, nm, brand, group });
      mergeGrid(heatmap, byWeekday, byHour, wb.cells);
      total += wb.total;
      for (const m of (wb.months || [])) months.add(m);
      if (wb.range.from && (!range.from || wb.range.from < range.from)) range.from = wb.range.from;
      if (wb.range.to && (!range.to || wb.range.to > range.to)) range.to = wb.range.to;
    }
    if (mp !== "wb") {
      const oz = await collectCell("ozon", { from, to, q, nm, brand, group });
      mergeGrid(heatmap, byWeekday, byHour, oz.cells);
      total += oz.total;
      for (const m of (oz.months || [])) months.add(m);
      if (oz.range.from && (!range.from || oz.range.from < range.from)) range.from = oz.range.from;
      if (oz.range.to && (!range.to || oz.range.to > range.to)) range.to = oz.range.to;
    }

    const WD = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
    return NextResponse.json({
      period: range,
      months: [...months].sort(),
      selected: { mp, period, from, to, q, nm, brand, group },
      total,
      weekdays: WD.map((label, i) => ({ label, short: label.slice(0, 2), count: byWeekday[i] })),
      hours: byHour.map((count, h) => ({ hour: h, count })),
      heatmap,
      facets,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

// ── Режим m30: 30-минутная воронка WB из кумулятивных снапшотов metrics_30m. ─────
// Дельта-логика: для каждого (nm, слот) дельта = max(0, snap - prev_snap_same_day).
// prev_snap — предыдущий слот ТОГО ЖЕ nm и ТОГО ЖЕ дня. Первый слот дня = само значение
// (счётчик только что сброшен в полночь). Корректировки WB (возврат уменьшает orderCount)
// → delta = max(0, отрицательная) = 0 (корректно, не показываем отрицательный «отток»).
const METRIC_COL = {
  orders: "orders", clicks: "clicks", cart: "cart",
  buyouts: "buyouts", favorites: "favorites",
};
async function collectMetric30m({ from, to, q, nm, brand, group, metric }) {
  const db = new DatabaseSync("wb", { readOnly: true });
  const col = METRIC_COL[metric] || "orders";

  // Фильтр по товару: применяем к metrics_30m через JOIN articles (как collectCell).
  const conds = ["1=1"];
  const params = [];
  if (from) { conds.push("m.date >= ?"); params.push(from); }
  if (to)   { conds.push("m.date <= ?"); params.push(to); }
  if (nm)    { conds.push("m.nm_id = ?"); params.push(Number(nm)); }
  if (brand) { conds.push("a.brand = ?"); params.push(brand); }
  if (group) { conds.push("a.subject = ?"); params.push(group); }
  if (q) {
    conds.push("(LOWER(CAST(m.nm_id AS TEXT)) LIKE ? OR LOWER(COALESCE(a.name,'')) LIKE ? OR LOWER(COALESCE(sa.name,'')) LIKE ?)");
    // sa — артикул продавца; в metrics_30m его нет, берём из orders (любая строка с этим nm).
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conds.join(" AND ");

  // JOIN: articles (имя/бренд/группа) + саб-запрос на supplier_article (поиск по артикулу продавца).
  const rows = await db.prepare(
    `SELECT m.nm_id, m.date, m.ts, m.${col} AS val
     FROM wb_metrics_30m m
     LEFT JOIN articles a ON a.nm_id = m.nm_id
     LEFT JOIN (SELECT DISTINCT nm_id, supplier_article AS name FROM orders WHERE supplier_article IS NOT NULL AND supplier_article <> '') sa ON sa.nm_id = m.nm_id
     WHERE ${where}
     ORDER BY m.nm_id, m.ts`
  ).all(...params);

  // Группируем по nm_id → [{ts, val}], считаем дельты.
  // byNm: Map<nm_id, [{ts, date, val}]> уже отсортирован по ts.
  const byNm = new Map();
  for (const r of rows) {
    if (!byNm.has(r.nm_id)) byNm.set(r.nm_id, []);
    byNm.get(r.nm_id).push({ ts: r.ts, date: r.date, val: r.val });
  }

  // Сетки: 7 будней × 48 слотов (00:00, 00:30, … 23:30). slot index = hour*2 + (min>=30?1:0).
  const SLOT_COUNT = 48;
  const heatmap = Array.from({ length: 7 }, () => Array(SLOT_COUNT).fill(0));
  const byWeekday = Array(7).fill(0);
  const byHour = Array(24).fill(0);
  const bySlot = Array(SLOT_COUNT).fill(0);
  let total = 0;
  let deltaCount = 0;

  // День недели из ts (локальное МСК — сборщик пишет локальное время).
  const wd = (ts) => {
    const d = new Date(ts.replace(" ", "T"));
    let w = d.getDay();           // 0=Вс..6=Сб
    return (w === 0 ? 6 : w - 1); // Пн=0..Вс=6
  };
  const slotIdx = (ts) => {
    const h = Number(ts.substr(11, 2));
    const mi = Number(ts.substr(14, 2));
    return h * 2 + (mi >= 30 ? 1 : 0);
  };

  for (const [, snaps] of byNm) {
    let prev = null;     // предыдущий снимок (для дельты)
    for (const s of snaps) {
      let delta;
      if (prev && prev.date === s.date) {
        delta = Math.max(0, (s.val || 0) - (prev.val || 0));
      } else {
        // Первый снимок дня (или самый первый) — счётчик только сброшен, delta = val.
        delta = Math.max(0, s.val || 0);
      }
      prev = s;
      if (delta > 0 || s.val > 0) {
        // Записываем дельту в сетки (даже 0 — для полноты тепловой карты, но total только >0).
        const w = wd(s.ts);
        const si = slotIdx(s.ts);
        heatmap[w][si] += delta;
        byWeekday[w] += delta;
        byHour[Math.floor(si / 2)] += delta;
        bySlot[si] += delta;
        total += delta;
        deltaCount += 1;
      }
    }
  }

  // Покрытие (для фасетов периода).
  const rng = await db.prepare("SELECT MIN(ts) a, MAX(ts) b FROM wb_metrics_30m").get();
  const months = (await db.prepare(
    "SELECT DISTINCT substr(ts,1,7) m FROM wb_metrics_30m ORDER BY m"
  ).all()).map((r) => r.m).filter(Boolean);

  const note = deltaCount === 0
    ? "Нет 30-минутных данных за период. Сборщик wb_metrics_30m.py копит историю с момента старта задачи (раз в 30 мин)."
    : null;

  return {
    heatmap, byWeekday, byHour, bySlot, total,
    range: { from: rng?.a || null, to: rng?.b || null },
    months,
    note,
  };
}

// Сбор ячеек сетки из одной БД. Возвращает [{w,h,c}] в схеме Пн=0..Вс=6.
async function collectCell(which, { from, to, q, nm, brand, group }) {
  const db = new DatabaseSync(which, { readOnly: true });
  const oNm = which === "wb" ? "o.nm_id" : "o.product_id";
  const oBrand = which === "wb" ? "o.brand" : "p.brand";
  const oGroup = which === "wb" ? "o.subject" : "p.category";
  const oSa = which === "wb" ? "o.supplier_article" : "o.offer_id";
  const artJoin = which === "wb"
    ? "LEFT JOIN articles a ON a.nm_id = o.nm_id"
    : "LEFT JOIN products p ON p.product_id = o.product_id";

  // Часовой пояс: WB orders.order_dt — локальное МСК, Ozon — UTC (суффикс 'Z').
  // Для Ozon конвертируем в МСК (+3 часа), иначе часы/дни недели сдвинуты на 3ч назад.
  // dtExpr — ТЕКСТОВОЕ выражение даты-времени в МСК (приводим к ::text, чтобы
  // substr/::date ниже работали единообразно для WB и Ozon).
  // ⚠️ PG: SQLite-функция datetime() не существует — используем ::timestamp + interval + ::text.
  const dtExpr = which === "wb"
    ? "o.order_dt"
    : "(o.order_dt::timestamp + interval '3 hours')::text";   // UTC → MSK

  const conds = ["o.order_dt <> ''", "length(o.order_dt) >= 13"];
  const params = [];
  if (from) { conds.push(`substr(${dtExpr},1,10) >= ?`); params.push(from); }
  if (to)   { conds.push(`substr(${dtExpr},1,10) <= ?`); params.push(to); }
  if (nm)    { conds.push(`${oNm} = ?`); params.push(nm); }
  if (brand) { conds.push(`${oBrand} = ?`); params.push(brand); }
  if (group) { conds.push(`${oGroup} = ?`); params.push(group); }
  if (q) {
    // Поиск по: артикул продавца (supplier_article/offer_id), артикул МП (nm_id/product_id),
    // имя товара (articles.name/products.name). Пользователь часто вбивает WB-артикул (977847925).
    const nameCol = which === "wb" ? "a.name" : "p.name";
    conds.push(`(LOWER(${oSa}) LIKE ? OR LOWER(CAST(${oNm} AS TEXT)) LIKE ? OR LOWER(COALESCE(${nameCol},'')) LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conds.join(" AND ");

  // %w: 0=Вс..6=Сб ; час = позиции 12-13. Оба берутся из dtExpr (уже в МСК для Ozon).
  const grid = await db.prepare(
    `SELECT EXTRACT(DOW FROM substr(${dtExpr},1,10)::date)::int w,
            CAST(substr(${dtExpr},12,2) AS INT) h,
            COUNT(*) c
     FROM orders o ${artJoin}
     WHERE ${where}
     GROUP BY w, h`
  ).all(...params);

  const toMon = (w) => (w === 0 ? 6 : w - 1);
  let total = 0;
  const cells = [];
  for (const row of grid) {
    const d = toMon(row.w);
    cells.push({ w: d, h: row.h, c: row.c });
    total += row.c;
  }

  const range = await db.prepare(
    `SELECT MIN(substr(order_dt,1,10)) a, MAX(substr(order_dt,1,10)) b FROM orders WHERE order_dt <> ''`
  ).get();
  const months = (await db.prepare(
    `SELECT DISTINCT substr(order_dt,1,7) m FROM orders WHERE order_dt <> '' ORDER BY m`
  ).all()).map((r) => r.m).filter(Boolean);

  return { cells, total, range: { from: range?.a || null, to: range?.b || null }, months };
}

function mergeGrid(heatmap, byWeekday, byHour, cells) {
  for (const c of cells) {
    if (c.h >= 0 && c.h < 24 && c.w >= 0 && c.w < 7) {
      heatmap[c.w][c.h] += c.c;
      byWeekday[c.w] += c.c;
      byHour[c.h] += c.c;
    }
  }
}

async function collectFacets(mp) {
  const brands = new Map();
  const groups = new Map();
  const nms = new Map();
  const add = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  if (mp !== "ozon") {
    const db = new DatabaseSync("wb", { readOnly: true });
    for (const r of await db.prepare(
      `SELECT o.brand, o.subject, o.nm_id, o.supplier_article, a.name
       FROM orders o LEFT JOIN articles a ON a.nm_id = o.nm_id WHERE o.order_dt <> ''`
    ).all()) {
      add(brands, r.brand);
      add(groups, r.subject);
      const id = r.nm_id;
      if (id) nms.set(id, { label: r.supplier_article || r.name || String(id), count: (nms.get(id)?.count || 0) + 1 });
    }
  }
  if (mp !== "wb") {
    const db = new DatabaseSync("ozon", { readOnly: true });
    for (const r of await db.prepare(
      `SELECT o.product_id, p.brand, p.category, p.name, o.offer_id
       FROM orders o LEFT JOIN products p ON p.product_id = o.product_id WHERE o.order_dt <> ''`
    ).all()) {
      add(brands, r.brand);
      add(groups, r.category);
      const id = r.product_id;
      if (id) nms.set(id, { label: r.offer_id || r.name || String(id), count: (nms.get(id)?.count || 0) + 1 });
    }
  }
  const toOpts = (m, isNm) => (isNm
    ? [...nms.entries()].map(([id, v]) => ({ id, label: v.label, count: v.count }))
    : [...m.entries()].map(([k, n]) => ({ value: k, count: n }))
  ).sort((a, b) => b.count - a.count);
  return {
    brand: toOpts(brands, false),
    group: toOpts(groups, false),
    nm: toOpts(nms, true),
  };
}
