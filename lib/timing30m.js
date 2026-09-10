// =====================================================================
//  lib/timing30m.js — дельта-логика 30-минутной воронки для страницы
//  «Заказы по времени» (режим granularity=m30). Чистые функции, без БД.
//
//  Снимки (WB: tenant.wb_metrics_30m, Ozon: tenant.ozon_metrics_30m /
//  tenant.ozon_ads_30m) — КУМУЛЯТИВНЫЕ счётчики с начала дня, снятые раз
//  в 30 минут. Дельта слота = max(0, snap − предыдущий снимок того же ключа
//  в тот же день); первый снимок дня = само значение (счётчик сброшен в
//  полночь). Отрицательная дельта (корректировка МП, отмена) → 0.
//  Один накопитель (emptyGrids) можно кормить несколькими источниками —
//  так «Все МП» складывает WB и Ozon. Селф-тест: scripts/check-timing-30m-selftest.mjs.
// =====================================================================

export const SLOT_COUNT = 48; // 00:00, 00:30, … 23:30

export function emptyGrids() {
  return {
    heatmap: Array.from({ length: 7 }, () => Array(SLOT_COUNT).fill(0)), // Пн=0..Вс=6 × слот
    byWeekday: Array(7).fill(0),
    byHour: Array(24).fill(0),
    bySlot: Array(SLOT_COUNT).fill(0),
    total: 0,
    deltaCount: 0, // число снимков с ненулевым значением/приростом (пусто ⇒ «нет данных»)
  };
}

// День недели из ts 'YYYY-MM-DD HH:MM:SS' (локальное МСК, как пишет сборщик): Пн=0..Вс=6.
function weekdayOf(ts) {
  const w = new Date(ts.replace(" ", "T")).getDay(); // 0=Вс..6=Сб
  return w === 0 ? 6 : w - 1;
}
function slotOf(ts) {
  return Number(ts.substr(11, 2)) * 2 + (Number(ts.substr(14, 2)) >= 30 ? 1 : 0);
}

// rows: [{key, date, ts, val}] — порядок внутри ключа по ts обязателен (ORDER BY key, ts).
export function aggregateSnapshots(rows, grids = emptyGrids()) {
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  for (const [, snaps] of byKey) {
    let prev = null;
    for (const s of snaps) {
      const val = Number(s.val) || 0;
      const delta = prev && prev.date === s.date
        ? Math.max(0, val - (Number(prev.val) || 0))
        : Math.max(0, val);
      prev = s;
      if (delta > 0 || val > 0) {
        const w = weekdayOf(s.ts);
        const si = slotOf(s.ts);
        grids.heatmap[w][si] += delta;
        grids.byWeekday[w] += delta;
        grids.byHour[Math.floor(si / 2)] += delta;
        grids.bySlot[si] += delta;
        grids.total += delta;
        grids.deltaCount += 1;
      }
    }
  }
  return grids;
}

// ── Каталог метрик режима m30 ─────────────────────────────────────────
// wb / oz — колонка в tenant.wb_metrics_30m / tenant.ozon_metrics_30m (по товарам);
// ozAds — колонка в tenant.ozon_ads_30m (по КАМПАНИЯМ: Performance API внутри дня
// товарного разреза не даёт, поэтому фильтр по товару к ним неприменим).
// «Все МП» показывает только метрики, которые есть у обеих площадок.
export const M30_METRICS = {
  orders:    { label: "Заказы",                  wb: "orders",    oz: "orders" },
  order_sum: { label: "Заказы, ₽",               wb: "order_sum", oz: "order_sum" },
  cart:      { label: "Корзины",                 wb: "cart",      oz: "cart" },
  clicks:    { label: "Клики (переходы в карточку)", wb: "clicks" },
  buyouts:   { label: "Продажи, шт",             wb: "buyouts" },
  favorites: { label: "Избранные",               wb: "favorites" },
  views:     { label: "Показы всего",            oz: "views" },
  views_search: { label: "Показы в поиске",      oz: "views_search" },
  views_pdp: { label: "Просмотры карточки",      oz: "views_pdp" },
  ad_views:  { label: "Реклама: показы",         ozAds: "views" },
  ad_clicks: { label: "Реклама: клики",          ozAds: "clicks" },
  ad_spend:  { label: "Реклама: расход, ₽",      ozAds: "spend" },
};

export function metricsForMp(mp) {
  return Object.entries(M30_METRICS)
    .filter(([, m]) => mp === "wb" ? !!m.wb
      : mp === "ozon" ? !!(m.oz || m.ozAds)
      : !!(m.wb && m.oz))
    .map(([v, m]) => ({ v, l: m.label }));
}

export const metricLabel = (v) => M30_METRICS[v]?.label || v;
