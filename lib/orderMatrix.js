// lib/orderMatrix.js — «Матрица заказов» (14.10.2026): артикул площадки × день → заказы, шт.
// Чистые функции, БД не трогает (данные — app/api/cabinets/[id]/order-matrix/route.js).
// Заказы — ВСЕ, включая отменённые (решение владельца 14.10.2026, как «Заказали» в ЛК WB);
// источник — wbOrdersAllByDay / ozOrdersAllByDay из единого слоя lib/*Metrics.js.
//
// Какие строки видны:
//   - артикул с заказами за период или сегодня — всегда (даже inactive в item_status);
//   - активный (item_status, fallback "active") без заказов — тоже (его и прячут кнопкой);
//   - inactive без заказов — нет;
//   - скрытый на этой странице (tenant.order_matrix_hidden) — только при showHidden, с hidden:true.
// Итоги по дням — по видимым НЕскрытым строкам; allTotal — все заказы площадки(ок) за
// период без учёта скрытия (сверка с «Заказано» на «Сводке по товарам»).

export const MATRIX_DAYS = [7, 14, 30, 60];

export const skuKey = (platform, sku) => `${platform}:${sku}`;

// Ключ item_status — как в lib/finItems.js statusMap (и /unit/all, products-summary).
const statusKey = (platform, sku) => (platform === "wb" ? `wb|${sku}|0` : `ozon|0|${sku}`);

// Даты окна: N полных дней по вчера (asc) + сегодня отдельно. today — "YYYY-MM-DD".
export function periodDates(today, days) {
  const base = new Date(today + "T00:00:00Z");
  const out = [];
  for (let i = days; i >= 1; i--) out.push(new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10));
  return out;
}

/**
 * @param {object} p
 * @param {string[]} p.dates    дни периода (asc), без сегодня
 * @param {string} p.today
 * @param {{platform,sku,date,total,cancelled}[]} p.counts  заказы по дням (период + сегодня)
 * @param {{platform,sku,name,imUrl,article}[]} p.meta      справочник артикулов
 * @param {Record<string,string>} p.status                  statusMap()
 * @param {Set<string>} p.hidden                            ключи skuKey()
 * @param {"all"|"wb"|"ozon"} p.platform
 * @param {boolean} p.showHidden
 */
export function buildOrderMatrix({ dates, today, counts, meta, status = {}, hidden = new Set(), platform = "all", showHidden = false }) {
  const inPlatform = (pf) => platform === "all" || platform === pf;
  const dateSet = new Set(dates);
  const rows = new Map();
  const ensure = (pf, sku) => {
    const k = skuKey(pf, sku);
    let r = rows.get(k);
    if (!r) {
      r = { key: k, platform: pf, sku, name: null, imUrl: null, article: null,
        days: {}, todayQty: 0, todayCancelled: 0, total: 0, cancelled: 0, max: 0, hasMeta: false };
      rows.set(k, r);
    }
    return r;
  };

  let allTotal = 0;
  for (const c of counts) {
    if (!inPlatform(c.platform)) continue;
    const t = Number(c.total) || 0;
    const cc = Number(c.cancelled) || 0;
    if (c.date === today) {
      const r = ensure(c.platform, c.sku);
      r.todayQty += t; r.todayCancelled += cc;
    } else if (dateSet.has(c.date)) {
      const r = ensure(c.platform, c.sku);
      const d = r.days[c.date] || (r.days[c.date] = { t: 0, c: 0 });
      d.t += t; d.c += cc;
      r.total += t; r.cancelled += cc;
      allTotal += t;
    }
  }

  for (const m of meta) {
    if (!inPlatform(m.platform)) continue;
    const k = skuKey(m.platform, m.sku);
    const active = (status[statusKey(m.platform, m.sku)] || "active") === "active";
    if (!rows.has(k) && !active) continue;
    const r = ensure(m.platform, m.sku);
    if (!r.hasMeta) {
      r.name = m.name || null; r.imUrl = m.imUrl || null; r.article = m.article || null; r.hasMeta = true;
    }
  }

  const out = [];
  let hiddenCount = 0;
  const byDay = Object.fromEntries(dates.map((d) => [d, 0]));
  let total = 0, todayTotal = 0;
  for (const r of rows.values()) {
    r.max = Math.max(0, ...Object.values(r.days).map((d) => d.t));
    r.hidden = hidden.has(r.key);
    r.inactive = (status[statusKey(r.platform, r.sku)] || "active") !== "active";
    if (!r.name) r.name = r.platform === "wb" ? `WB ${r.sku}` : `Ozon ${r.sku}`;
    delete r.hasMeta;
    if (r.hidden) {
      hiddenCount++;
      if (!showHidden) continue;
    } else {
      for (const [d, v] of Object.entries(r.days)) byDay[d] += v.t;
      total += r.total; todayTotal += r.todayQty;
    }
    out.push(r);
  }
  out.sort((a, b) => b.total - a.total || b.todayQty - a.todayQty || String(a.name).localeCompare(String(b.name), "ru"));
  return { dates, today, rows: out, hiddenCount, totals: { byDay, total, today: todayTotal, allTotal } };
}

// Артикулы, которые «Скрыть все без заказов» уберёт: видимые, не скрытые, без заказов
// ни за период, ни сегодня.
export function emptyRowKeys(matrix) {
  return matrix.rows.filter((r) => !r.hidden && r.total === 0 && r.todayQty === 0)
    .map((r) => ({ platform: r.platform, sku: r.sku }));
}
