// =====================================================================
//  lib/ozonSearch.js — чистые расчёты страницы «Поиск и запросы» (Ozon):
//  агрегаты по SKU за период, матрица запрос × день, KPI. Без БД.
//  Источник: tenant.ozon_sku_search_daily / tenant.ozon_search_queries_daily
//  (кабинет продавца, сборщик ozon_cabinet_search). Заказы/GMV здесь — «по
//  запросу» (статистика поиска кабинета), они НЕ равны заказам панели и так и
//  подписываются.
//  CTR (ревью 2026-09-12, находка №1): это НЕ Σview/Σsearch — та величина
//  отвечает на другой вопрос («доля искавших, кто дошёл до просмотра») и не
//  совпадает с CTR кабинета. Формула кабинета (queryCtr, столбец `ctr`,
//  проверено вживую: корреляция 1.000) — click_users/view_users. В матрице
//  запрос×день считаем её заново из сумм click_users/view_users; в сводке по
//  SKU строк click_users нет, поэтому берём хранимый `ctr` построчно и
//  взвешиваем по view_users (см. weightedCtr).
//  Позиция 0 (находка №2) означает «товар не ранжирован по запросу», а не
//  ранг 0 — везде ниже такие строки трактуются как отсутствие данных (см. pos()).
//  Селф-тест: scripts/check-ozon-search-selftest.mjs.
// =====================================================================
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const n = (v) => (v == null ? 0 : Number(v) || 0);
// position = 0 у кабинета значит «не ранжирован», а не «место 0» — свести
// такие строки к null везде, где считается позиция или её тон/раскраска.
const pos = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };

export function weightedPosition(rows) {
  let wsum = 0, w = 0, plain = 0, cnt = 0;
  for (const r of rows) {
    const p = pos(r.position);
    if (p == null) continue;
    const su = n(r.search_users);
    wsum += p * su; w += su; plain += p; cnt += 1;
  }
  if (!cnt) return null;
  return w > 0 ? wsum / w : plain / cnt;
}

// Взвешенный CTR сводки по SKU: среднее хранимого `ctr` по строкам,
// взвешенное view_users (нет click_users в строках сводки — они только в
// запросах). Нулевой суммарный вес → простое среднее известных ctr; ни
// одной известной строки → null.
export function weightedCtr(rows) {
  let wsum = 0, w = 0, plain = 0, cnt = 0;
  for (const r of rows) {
    if (r.ctr == null) continue;
    const vu = n(r.view_users);
    const c = n(r.ctr);
    wsum += c * vu; w += vu; plain += c; cnt += 1;
  }
  if (!cnt) return null;
  return w > 0 ? wsum / w : plain / cnt;
}

export function positionTone(v) {
  const p = pos(v);
  if (p == null) return "none";
  if (p <= 10) return "top";
  if (p <= 30) return "good";
  if (p <= 100) return "mid";
  return "low";
}

function groupBySku(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.sku)) m.set(r.sku, []);
    m.get(r.sku).push(r);
  }
  return m;
}

export function aggregateSkus(rows, prevRows = []) {
  const cur = groupBySku(rows), prev = groupBySku(prevRows);
  const items = [];
  for (const [sku, rs] of cur) {
    const su = rs.reduce((s, r) => s + n(r.search_users), 0);
    const vu = rs.reduce((s, r) => s + n(r.view_users), 0);
    const position = r1(weightedPosition(rs));
    const positionPrev = prev.has(sku) ? r1(weightedPosition(prev.get(sku))) : null;
    const last = rs[rs.length - 1];
    items.push({
      sku, product_id: last.product_id ?? null, name: last.name || String(sku), article: last.article || null,
      position, positionPrev,
      positionDelta: position != null && positionPrev != null ? r1(positionPrev - position) : null,
      search_users: su, view_users: vu, ctr: r2(weightedCtr(rs)),
      gmv: rs.reduce((s, r) => s + n(r.gmv), 0),
      spark: [...rs].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, position: pos(r.position) })),
    });
  }
  items.sort((a, b) => b.search_users - a.search_users || a.sku - b.sku);
  const kpi = {
    position: r2(weightedPosition(rows)), positionPrev: r2(weightedPosition(prevRows)),
    queriesTop10: null, queriesTop50: null, orders: null,
    search_users: rows.reduce((s, r) => s + n(r.search_users), 0),
  };
  return { items, kpi };
}

export function buildQueryMatrix(qrows, dates, { minDemand = 0, onlyOrders = false } = {}) {
  const byQ = new Map();
  for (const r of qrows) {
    if (!byQ.has(r.query)) byQ.set(r.query, []);
    byQ.get(r.query).push(r);
  }
  const rows = [];
  for (const [query, rs] of byQ) {
    const su = rs.reduce((s, r) => s + n(r.search_users), 0);
    const vu = rs.reduce((s, r) => s + n(r.view_users), 0);
    const cu = rs.reduce((s, r) => s + n(r.click_users), 0);
    const orders = rs.reduce((s, r) => s + n(r.orders), 0);
    if (su < minDemand || (onlyOrders && orders <= 0)) continue;
    const byDay = Object.fromEntries(dates.map((d) => [d, null]));
    for (const r of rs) if (r.date in byDay) byDay[r.date] = pos(r.position);
    const known = rs.filter((r) => pos(r.position) != null).sort((a, b) => a.date.localeCompare(b.date));
    rows.push({
      // CTR кабинета = click_users/view_users (находка №1), не view/search.
      query, search_users: su, view_users: vu, ctr: vu > 0 ? r2((cu / vu) * 100) : null,
      click_users: cu, orders,
      gmv: rs.reduce((s, r) => s + n(r.gmv), 0), byDay,
      best: known.length ? Math.min(...known.map((r) => r.position)) : null,
      last: known.length ? known[known.length - 1].position : null,
    });
  }
  rows.sort((a, b) => b.search_users - a.search_users || a.query.localeCompare(b.query));
  return { dates, rows };
}

export function kpiFromQueries(qrows) {
  const lastDate = qrows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const lastRows = qrows.filter((r) => r.date === lastDate && pos(r.position) != null);
  return {
    queriesTop10: lastRows.filter((r) => r.position <= 10).length,
    queriesTop50: lastRows.filter((r) => r.position <= 50).length,
    orders: qrows.reduce((s, r) => s + n(r.orders), 0),
  };
}
