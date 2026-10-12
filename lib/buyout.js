// lib/buyout.js — процент выкупа WB когортно по дате заказа (11.10.2026).
// Спека docs/superpowers/specs/2026-10-11-buyout-page-design.md, контракт метрик §18.
// Чистые функции, без БД (данные — lib/buyoutData.js). Берём заказы периода и смотрим
// судьбу КАЖДОГО заказа (srid): одно ведро на заказ, проверки в порядке BUCKETS.
//   % выкупа = sold / (sold + refused + returned); pending и cancelledPre в знаменатель
//   не входят, самовыкупы (self) исключены из всех вёдер.
// ⚠️ Это НЕ коэффициент выкупа юнитки (lib/unit.js): там b по событиям отчёта реализации,
// чтобы логистика сводилась к Σлогистики/продано (§18.4 контракта).

// todayMsk() — «сегодня» по МСК, не по UTC сервера (фикс 2026-10-12, финальное ревью):
// заказы датируются МСК, а `new Date().toISOString().slice(0,10)` даёт UTC-дату — в окне
// 00:00–02:59 МСК (UTC ещё «вчера») asOf расходился с датой последнего заказа когорты
// на сутки. `toLocaleDateString("sv-SE", {timeZone:"Europe/Moscow"})` даёт YYYY-MM-DD.
export function todayMsk() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
}

export const CANCEL_SETTLE_DAYS = 7; // отчёт реализации отстаёт: раньше 7 дней отмену без логистики не судим
export const IMMATURE_SHARE = 0.05;  // доля «в пути» выше — период не дозрел
export const MIN_RESOLVED = 20;      // меньше доехавших — процент бледный (малая выборка)
export const NO_SIZE = "0";          // WB tech_size неразмерного товара
const COUNT_KEYS = ["ordered", "self", "returned", "sold", "refused", "cancelledPre", "pending"];
const DAY = 864e5;

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const emptyCounts = () => Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));

export function classifyWbOrder(r, asOf) {
  if (r.selfBuyout) return "self";
  if (r.hasReturn) return "returned";
  if (r.hasSale) return "sold";
  if (r.isCancel) {
    if (r.refusedLogistics) return "refused";
    const at = r.cancelAt ? Date.parse(String(r.cancelAt).slice(0, 10)) : NaN;
    if (Number.isFinite(at) && (Date.parse(asOf) - at) / DAY > CANCEL_SETTLE_DAYS) return "cancelledPre";
  }
  return "pending";
}

export function buyoutStats(c) {
  const resolved = c.sold + c.refused + c.returned;
  const open = resolved + c.pending;
  const pendingShare = open > 0 ? c.pending / open : 0;
  return {
    ...c,
    resolved,
    buyoutPct: resolved > 0 ? round2((100 * c.sold) / resolved) : null,
    pendingShare: round2(pendingShare),
    immature: pendingShare > IMMATURE_SHARE,
    lowSample: resolved < MIN_RESOLVED,
  };
}

function add(counts, bucket) {
  counts.ordered += 1;
  counts[bucket] += 1;
}

const LETTER = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "3XL", "4XL", "5XL"];
export function sortSizes(list) {
  const rank = (s) => {
    const u = String(s).toUpperCase();
    const li = LETTER.indexOf(u);
    if (li >= 0) return [0, li, u];
    const n = parseFloat(u);
    if (Number.isFinite(n)) return [1, n, u];
    return [2, 0, u];
  };
  return [...list].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2], "ru");
  });
}

export function aggregateBuyout(rows, asOf) {
  const kpi = emptyCounts();
  const byNm = new Map();
  for (const r of rows) {
    const b = classifyWbOrder(r, asOf);
    add(kpi, b);
    let it = byNm.get(r.nmId);
    if (!it) {
      it = { nmId: r.nmId, article: r.article || null, name: r.name || null, counts: emptyCounts(), sizes: new Map() };
      byNm.set(r.nmId, it);
    }
    if (!it.name && r.name) it.name = r.name;
    if (!it.article && r.article) it.article = r.article;
    add(it.counts, b);
    const size = r.size || NO_SIZE;
    if (!it.sizes.has(size)) it.sizes.set(size, emptyCounts());
    add(it.sizes.get(size), b);
  }
  const items = [...byNm.values()].map((it) => {
    const sizeKeys = [...it.sizes.keys()];
    const real = sizeKeys.some((s) => s !== NO_SIZE);
    return {
      nmId: it.nmId, article: it.article, name: it.name,
      ...buyoutStats(it.counts),
      sizes: real ? sortSizes(sizeKeys).map((s) => ({ size: s === NO_SIZE ? "без размера" : s, ...buyoutStats(it.sizes.get(s)) })) : [],
    };
  }).sort((a, b) => b.ordered - a.ordered);
  return { kpi: buyoutStats(kpi), items };
}

export function weekStart(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // пн = 0
  return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}

export function weeklyBuyout(rows, asOf, { weeks = 13, nmId = null } = {}) {
  const last = Date.parse(`${weekStart(asOf)}T00:00:00Z`);
  const keys = Array.from({ length: weeks }, (_, i) => new Date(last - (weeks - 1 - i) * 7 * DAY).toISOString().slice(0, 10));
  const acc = new Map(keys.map((k) => [k, { total: emptyCounts(), sizes: new Map() }]));
  const sizeSet = new Set();
  for (const r of rows) {
    if (nmId != null && r.nmId !== nmId) continue;
    const w = acc.get(weekStart(r.orderDate));
    if (!w) continue;
    const b = classifyWbOrder(r, asOf);
    add(w.total, b);
    const size = r.size || NO_SIZE;
    if (nmId != null && size !== NO_SIZE) {
      sizeSet.add(size);
      if (!w.sizes.has(size)) w.sizes.set(size, emptyCounts());
      add(w.sizes.get(size), b);
    }
  }
  const sizeList = sortSizes([...sizeSet]);
  return {
    sizeList,
    weeks: keys.map((k) => {
      const w = acc.get(k);
      return {
        week: k,
        ...buyoutStats(w.total),
        sizes: Object.fromEntries(sizeList.map((s) => [s, buyoutStats(w.sizes.get(s) || emptyCounts())])),
      };
    }),
  };
}
