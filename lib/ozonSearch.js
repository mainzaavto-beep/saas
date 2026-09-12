// =====================================================================
//  lib/ozonSearch.js — чистые расчёты страницы «Поиск и запросы» (Ozon):
//  агрегаты по SKU за период, матрица запрос × день, KPI. Без БД.
//  Источник: tenant.ozon_sku_search_daily / tenant.ozon_search_queries_daily
//  (кабинет продавца, сборщик ozon_cabinet_search). Заказы/GMV здесь — «по
//  запросу» (статистика поиска кабинета), они НЕ равны заказам панели и так и
//  подписываются. Селф-тест: scripts/check-ozon-search-selftest.mjs.
// =====================================================================
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const n = (v) => (v == null ? 0 : Number(v) || 0);

export function weightedPosition(rows) {
  let wsum = 0, w = 0, plain = 0, cnt = 0;
  for (const r of rows) {
    if (r.position == null) continue;
    const su = n(r.search_users);
    wsum += r.position * su; w += su; plain += r.position; cnt += 1;
  }
  if (!cnt) return null;
  return w > 0 ? wsum / w : plain / cnt;
}

export function positionTone(pos) {
  if (pos == null) return "none";
  if (pos <= 10) return "top";
  if (pos <= 30) return "good";
  if (pos <= 100) return "mid";
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
      search_users: su, view_users: vu, ctr: su > 0 ? r2((vu / su) * 100) : null,
      gmv: rs.reduce((s, r) => s + n(r.gmv), 0),
      spark: [...rs].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, position: r.position ?? null })),
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
    const orders = rs.reduce((s, r) => s + n(r.orders), 0);
    if (su < minDemand || (onlyOrders && orders <= 0)) continue;
    const byDay = Object.fromEntries(dates.map((d) => [d, null]));
    for (const r of rs) if (r.date in byDay) byDay[r.date] = r.position ?? null;
    const known = rs.filter((r) => r.position != null).sort((a, b) => a.date.localeCompare(b.date));
    rows.push({
      query, search_users: su, view_users: vu, ctr: su > 0 ? r2((vu / su) * 100) : null,
      click_users: rs.reduce((s, r) => s + n(r.click_users), 0), orders,
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
  const lastRows = qrows.filter((r) => r.date === lastDate && r.position != null);
  return {
    queriesTop10: lastRows.filter((r) => r.position <= 10).length,
    queriesTop50: lastRows.filter((r) => r.position <= 50).length,
    orders: qrows.reduce((s, r) => s + n(r.orders), 0),
  };
}
