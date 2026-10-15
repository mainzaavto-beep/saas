// lib/kpiDashboard.js — «Дашборд показателей» (15.10.2026), чистое ядро без БД и без импортов
// (работает и в браузере: applyLayout/normalizeLayout зовёт клиент). Спека
// docs/superpowers/specs/2026-10-15-kpi-dashboard-design.md.
// Деньги — ТОЛЬКО канон: строки «Сводки по товарам» (lib/productsSummaryData.js) либо,
// без товарного фильтра, wbProfitCabinet/ozProfitCabinet (applyCanon). Здесь — суммы,
// производные (÷), цвет и раскрытие; новых денежных формул нет.

export const TONE_THRESHOLD = 0.01; // |отн. изменение| < 1 % → без цвета

const MONEY = ["revenue", "realized", "payout", "spp", "cogs", "commission", "acquiring", "loyalty",
  "services", "logistics", "returnLogistics", "ads", "tax", "profit", "profitGross", "taxBase"];
const COUNTS = ["sold", "returns", "cancelled", "ordered", "orderRub", "buyoutSold", "buyoutResolved",
  "stock", "stockValue", "stockNoCost"];
const COST_TILES = ["storage", "acceptance", "penalties", "otherDeductions", "compensations"];
const AGG_KEYS = [...MONEY, ...COUNTS, ...COST_TILES];
// Поле строки Сводки, соответствующее значению WB_TAX_BASE (lib/wbMetrics.js).
const WB_BASE_FIELD = { revenue: "salesRub", realized: "realized", payout: "payout" };

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const div = (a, b) => (b ? r2(a / b) : null);
const pct = (a, b) => (b ? r2((100 * a) / b) : null);

export function emptyAgg() {
  const a = {};
  for (const k of AGG_KEYS) a[k] = 0;
  a.costLines = [];
  return a;
}

export function skuKeyOf(it) { return `${it.platform}:${it.nm}`; }

// Строки Сводки → { wb, ozon } суммы. adSpend строки = ads; costRub = cogs; salesRub = revenue.
export function aggregateItems(items, { wbTaxBase = "realized" } = {}) {
  const out = { wb: emptyAgg(), ozon: emptyAgg() };
  for (const it of items || []) {
    const a = out[it.platform];
    if (!a) continue;
    a.revenue += num(it.salesRub);
    a.realized += num(it.realized);
    a.payout += num(it.payout);
    a.spp += num(it.spp);
    a.cogs += num(it.costRub);
    a.commission += num(it.commission);
    a.acquiring += num(it.acquiring);
    a.loyalty += num(it.loyalty);
    a.services += num(it.services);
    a.logistics += num(it.logistics);
    a.returnLogistics += num(it.returnLogistics);
    a.ads += num(it.adSpend);
    a.tax += num(it.tax);
    a.profit += num(it.profit);
    a.profitGross += num(it.profitGross);
    a.taxBase += num(it.platform === "wb" ? it[WB_BASE_FIELD[wbTaxBase] || "realized"] : it.salesRub);
    for (const k of ["sold", "returns", "cancelled", "ordered", "orderRub", "buyoutSold", "buyoutResolved"]) a[k] += num(it[k]);
    const st = num(it.stock);
    a.stock += st;
    if (num(it.unitCost) > 0) a.stockValue += st * num(it.unitCost);
    else if (st > 0) a.stockNoCost += 1;
  }
  for (const a of Object.values(out)) for (const k of MONEY.concat(["orderRub", "stockValue"])) a[k] = r2(a[k]);
  return out;
}

// Статьи кабинетных расходов → плитка. WB — cost_type сборщика wb_cabinet_costs;
// Ozon — accrual_<type_id> (shared.ozon_accrual_types). Явный маппинг — независимо от знака
// суммы статьи. Всё, что НЕ в явном маппинге (в т.ч. WB «reviews», Ozon accrual_57/62 и т.п.) —
// маршрутизируется по знаку КАНОН-суммы этой строки (fix F2, финальное ревью 15.10.2026): доход
// (amount>0) → «Компенсации», расход (иначе) → «Прочие удержания». costTileOf поэтому принимает
// amount третьим аргументом.
const COST_TILE = {
  wb: {
    storage: "storage", supply: "acceptance", crossdocking: "acceptance", penalty: "penalties",
    payout_other: "compensations", pvz_compensation: "compensations", transport_compensation: "compensations",
  },
  ozon: {
    accrual_46: "storage", accrual_60: "storage", accrual_78: "storage", accrual_79: "storage", accrual_102: "storage",
    accrual_12: "acceptance", accrual_131: "acceptance", accrual_134: "acceptance",
    accrual_13: "acceptance", accrual_77: "acceptance", accrual_133: "acceptance", accrual_135: "acceptance",
    accrual_93: "penalties", accrual_89: "penalties", accrual_90: "penalties", accrual_91: "penalties",
    accrual_92: "penalties", accrual_94: "penalties",
    accrual_10: "compensations", accrual_25: "compensations", accrual_104: "compensations",
  },
};
export function costTileOf(platform, costType, amount) {
  const mapped = COST_TILE[platform]?.[costType];
  if (mapped) return mapped;
  return num(amount) > 0 ? "compensations" : "otherDeductions";
}

// Без товарного фильтра: деньги — кабинетный канон (как /pnl), штуки/остатки — строки Сводки.
// canon.cabinetCosts[].amount — канон-знак (<0 расход, >0 доход). Плитки расходов хранят
// расход положительным (−amount), «Компенсации» — доход положительным (+amount).
export function applyCanon(agg, canon, platform, { wbTaxBase = "realized" } = {}) {
  const a = { ...agg, costLines: [] };
  for (const k of MONEY) if (k !== "taxBase") a[k] = r2(num(canon[k]));
  a.taxBase = r2(num(platform === "wb" ? canon[wbTaxBase] : canon.revenue));
  for (const k of COST_TILES) a[k] = 0;
  for (const c of canon.cabinetCosts || []) {
    const amount = num(c.amount);
    const tile = costTileOf(platform, c.costType, amount);
    a[tile] = r2(a[tile] + (tile === "compensations" ? amount : -amount));
    a.costLines.push({ platform, tile, label: c.label, amount: r2(amount) });
  }
  return a;
}

// validDate(s): M1 — строка 'YYYY-MM-DD' указывает на существующую календарную дату.
// Round-trip через Date (UTC): "2026-02-31" становится "2026-03-03" — не совпадёт с исходной
// строкой. Чистая функция без БД (kpiDashboardData.js импортирует db.js — тестировать
// parseKpiQuery напрямую в node:test рискует потянуть пул соединений).
export function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  try {
    return new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
  } catch {
    return false;
  }
}

export function filterItems(items, { brands = [], cats = [], skus = [] } = {}) {
  const b = new Set(brands), c = new Set(cats), s = new Set(skus);
  return (items || []).filter((it) =>
    (!b.size || b.has(it.brand || "")) && (!c.size || c.has(it.cat || "")) && (!s.size || s.has(skuKeyOf(it))));
}

function sumAggs(list) {
  const out = emptyAgg();
  for (const a of list) {
    if (!a) continue;
    for (const k of AGG_KEYS) out[k] += num(a[k]);
    out.costLines.push(...(a.costLines || []));
  }
  for (const k of AGG_KEYS) out[k] = r2(out[k]);
  return out;
}

export function computeMetrics(a, { opex = null, productFilter = false } = {}) {
  const cab = (v) => (productFilter ? null : v);
  return {
    profit: a.profit, margin: pct(a.profit, a.revenue),
    revenue: a.revenue, sold: a.sold, realized: a.realized,
    orderRub: a.orderRub, ordered: a.ordered,
    buyoutPct: pct(a.buyoutSold, a.buyoutResolved),
    logistics: a.logistics, ads: a.ads, drr: pct(a.ads, a.orderRub), drrSales: pct(a.ads, a.revenue),
    storage: cab(a.storage), acceptance: cab(a.acceptance), otherDeductions: cab(a.otherDeductions),
    penalties: cab(a.penalties), compensations: cab(a.compensations),
    roi: pct(a.profit, a.cogs), cogs: a.cogs,
    opex: productFilter ? null : opex,
    tax: a.tax, taxBase: a.taxBase, commission: a.commission,
    avgPriceBeforeMp: div(a.revenue, a.sold), avgSalePrice: div(a.realized, a.sold),
    logisticsPerUnit: div(a.logistics, a.sold), profitPerUnit: div(a.profit, a.sold),
    stock: a.stock, stockValue: r2(a.stockValue), stockNoCost: a.stockNoCost,
    payout: a.payout, profitGross: a.profitGross, spp: a.spp, acquiring: a.acquiring,
    services: a.services, returnLogistics: a.returnLogistics, cancelled: a.cancelled, returns: a.returns,
  };
}

// good: up — рост хорошо; down — снижение хорошо (по самой величине);
// shareDown — снижение ДОЛИ в выручке хорошо; neutral — без цвета.
// second: { metric, unit } | { share: true } (доля value в выручке, %).
// cab: кабинетная статья (при товарном фильтре — «—»). src: источник ошибки.
// bd: вид раскрытия — "platform" (по умолчанию) | "costs" | "logistics" | "commission".
const T = (key, title, value, unit, good, extra = {}) => ({ key, title, value, unit, good, ...extra });
export const TILES = [
  T("profit", "Чистая прибыль / маржа", "profit", "rub", "up", { second: { metric: "margin", unit: "pct" } }),
  T("revenue", "Продажи", "revenue", "rub", "up", { second: { metric: "sold", unit: "pcs" } }),
  T("realized", "Реализация", "realized", "rub", "up"),
  T("orders", "Заказы", "orderRub", "rub", "up", { second: { metric: "ordered", unit: "pcs" }, src: "items" }),
  T("buyoutPct", "Процент выкупа", "buyoutPct", "pct", "up", { src: "items" }),
  T("logistics", "Логистика", "logistics", "rub", "shareDown", { second: { share: true }, bd: "logistics" }),
  T("ads", "Реклама / ДРР", "ads", "rub", "shareDown", { second: { metric: "drr", unit: "pct" } }),
  T("storage", "Хранение", "storage", "rub", "shareDown", { second: { share: true }, cab: true, bd: "costs" }),
  T("acceptance", "Платная приёмка", "acceptance", "rub", "shareDown", { second: { share: true }, cab: true, bd: "costs" }),
  T("otherDeductions", "Прочие удержания", "otherDeductions", "rub", "shareDown", { second: { share: true }, cab: true, bd: "costs" }),
  T("roi", "ROI", "roi", "pct", "up"),
  T("cogs", "Себестоимость продаж", "cogs", "rub", "shareDown", { second: { share: true } }),
  T("opex", "Операционные расходы", "opex", "rub", "shareDown", { second: { share: true }, cab: true, src: "opex", bd: "none",
    scopeSensitive: true, // F4: не делится по площадкам — «—» при фильтре на часть магазинов кабинета
    hint: "Ручные расходы (раздел «Сопутств. расходы»), справочно: в прибыль панели не входят" }),
  T("tax", "Налоги", "tax", "rub", "shareDown", { second: { share: true } }),
  T("taxBase", "Налоговая база", "taxBase", "rub", "neutral"),
  T("commission", "Комиссия", "commission", "rub", "shareDown", { second: { share: true }, bd: "commission" }),
  T("avgPriceBeforeMp", "Сред. цена до скидок МП", "avgPriceBeforeMp", "rub", "up", { hint: "Продажи ÷ продано шт: цена продавца до СПП" }),
  T("stockValue", "Капитализация по себес.", "stockValue", "rub", "neutral", { snapshot: true, src: "items" }),
  T("stock", "Остатки", "stock", "pcs", "neutral", { snapshot: true, src: "items" }),
  T("penalties", "Штрафы", "penalties", "rub", "shareDown", { second: { share: true }, cab: true, bd: "costs" }),
  T("compensations", "Компенсации", "compensations", "rub", "up", { second: { share: true }, cab: true, bd: "costs" }),
  T("avgSalePrice", "Сред. цена продажи", "avgSalePrice", "rub", "up", { hint: "Реализация ÷ продано шт" }),
  T("logisticsPerUnit", "Сред. стоимость логистики на 1 шт", "logisticsPerUnit", "rub", "down"),
  T("profitPerUnit", "Средняя прибыль на 1 шт", "profitPerUnit", "rub", "up"),
];
export const CATALOG = [
  T("drrSales", "ДРР от продаж", "drrSales", "pct", "down"),
  T("payout", "К перечислению", "payout", "rub", "up", { hint: "У Ozon — расчётно: выручка − вознаграждение − сборы − эквайринг − лояльность" }),
  T("profitGross", "Валовая прибыль", "profitGross", "rub", "up", { hint: "До рекламы, налога и кабинетных расходов" }),
  T("spp", "СПП, ₽", "spp", "rub", "neutral", { hint: "Скидка WB покупателю; у Ozon 0" }),
  T("acquiring", "Эквайринг", "acquiring", "rub", "shareDown", { second: { share: true } }),
  T("services", "Сборы Ozon", "services", "rub", "shareDown", { second: { share: true } }),
  T("returnLogistics", "Возвратная логистика", "returnLogistics", "rub", "shareDown", { second: { share: true }, hint: "Уже входит в «Логистику»" }),
  T("cancelled", "Отмены, шт", "cancelled", "pcs", "down", { src: "items" }),
  T("returns", "Возвраты, шт", "returns", "pcs", "down", { src: "items" }),
];
export const ALL_TILES = [...TILES, ...CATALOG];

function shareOf(def, m) { return m && m[def.value] != null && m.revenue ? m[def.value] / m.revenue : null; }

export function tileTone(def, cur, prev) {
  if (def.good === "neutral" || def.snapshot) return "neutral";
  const c = def.good === "shareDown" ? shareOf(def, cur) : cur?.[def.value];
  const p = def.good === "shareDown" ? shareOf(def, prev) : prev?.[def.value];
  if (c == null || p == null || p === 0) return "neutral";
  const rel = (c - p) / Math.abs(p);
  if (Math.abs(rel) < TONE_THRESHOLD) return "neutral";
  return (def.good === "up" ? rel > 0 : rel < 0) ? "good" : "bad";
}

function secondOf(def, m) {
  if (!def.second) return null;
  if (def.second.share) return { value: m[def.value] == null ? null : pct(m[def.value], m.revenue), unit: "pct" };
  return { value: m[def.second.metric], unit: def.second.unit };
}

function breakdownOf(def, cur, mByPf, productFilter) {
  if (def.bd === "none") return [];
  const names = { wb: "WB", ozon: "Ozon" };
  if (def.bd === "costs") {
    if (productFilter) return [];
    const lines = [];
    for (const pf of ["wb", "ozon"]) {
      for (const l of cur[pf]?.costLines || []) {
        if (l.tile !== def.key) continue;
        lines.push({ label: `${names[pf]} · ${l.label}`, value: def.key === "compensations" ? l.amount : r2(-l.amount), unit: "rub" });
      }
    }
    return lines;
  }
  const rows = [];
  for (const pf of ["wb", "ozon"]) {
    const m = mByPf[pf];
    if (!m) continue;
    rows.push({ label: names[pf], value: m[def.value], unit: def.unit });
    if (def.bd === "logistics") rows.push({ label: `${names[pf]} · в т.ч. возвратная`, value: m.returnLogistics, unit: "rub" });
    // M2: строка «эквайринг (отдельно)» — только когда этот эквайринг площадки ≠ 0
    // (иначе список раскрытия комиссии шумит нулевыми строками, напр. у WB acquiring=0).
    if (def.bd === "commission" && m.acquiring) rows.push({ label: `${names[pf]} · эквайринг (отдельно)`, value: m.acquiring, unit: "rub" });
  }
  return rows;
}

function metricsFor(side, productFilter) {
  const total = sumAggs([side.wb, side.ozon]);
  return {
    total: computeMetrics(total, { opex: side.opex, productFilter }),
    wb: side.wb ? computeMetrics(side.wb, { opex: null, productFilter }) : null,
    ozon: side.ozon ? computeMetrics(side.ozon, { opex: null, productFilter }) : null,
  };
}

// cur/prev: { wb: Agg|null, ozon: Agg|null, opex: number|null }.
// errors: источники, которые не загрузились ("money"|"items"|"opex").
// opexUnavailable (F4): выбранные магазины — подмножество площадок кабинета, opex не делится
// по площадкам → плитка «Опер. расходы» недоступна («—»), без «ошибки загрузки».
export function buildTiles({ cur, prev, productFilter = false, errors = [], opexUnavailable = false }) {
  const mc = metricsFor(cur, productFilter);
  const mp = metricsFor(prev, productFilter);
  const err = new Set(errors);
  // F3: с товарным фильтром деньги считаются ИЗ СТРОК Сводки (items), а не из "money"
  // (тот источник вообще не запрашивается в этом режиме — errors никогда не содержит "money").
  // Если items не загрузился, ВСЕ не-кабинетные плитки должны молчать ошибкой, а не тихо
  // показывать 0 — иначе фильтр по товарам при отказе БД рисовал бы «прибыль 0 ₽» как факт.
  const itemsFailedInFilter = productFilter && err.has("items");
  return ALL_TILES.map((def) => {
    const cabUnavailable = !!def.cab && productFilter;
    const scopeUnavailable = !!def.scopeSensitive && opexUnavailable;
    const unavailable = cabUnavailable || scopeUnavailable;
    const error = !unavailable && (itemsFailedInFilter || err.has(def.src || "money"));
    const value = unavailable || error ? null : mc.total[def.value];
    const prevVal = def.snapshot || unavailable || error ? null : mp.total[def.value];
    const delta = value != null && prevVal != null
      ? { abs: r2(value - prevVal), pct: prevVal ? r2((100 * (value - prevVal)) / Math.abs(prevVal)) : null }
      : null;
    let hint = def.hint || null;
    if (cabUnavailable) hint = "Расход кабинета: не делится по товарам — при фильтре по брендам, категориям или артикулам не показывается";
    else if (scopeUnavailable) hint = "Опер. расходы не делятся по площадкам — при выборе части магазинов не показываются";
    if (def.key === "stockValue" && mc.total.stockNoCost > 0) hint = `Без себестоимости: ${mc.total.stockNoCost} артикулов (не вошли в сумму)`;
    return {
      key: def.key, title: def.title, value, unit: def.unit,
      second: value == null ? null : secondOf(def, mc.total),
      prev: prevVal, delta,
      tone: value == null ? "neutral" : tileTone(def, mc.total, mp.total),
      breakdown: value == null ? [] : breakdownOf(def, cur, { wb: mc.wb, ozon: mc.ozon }, productFilter),
      unavailable, error, hint,
    };
  });
}

const BASE_KEYS = TILES.map((t) => t.key);
const EXTRA_KEYS = CATALOG.map((t) => t.key);
export const DEFAULT_LAYOUT = { order: [...BASE_KEYS], hidden: [], extra: [] };

export function normalizeLayout(raw) {
  if (!raw || typeof raw !== "object") return { order: [...BASE_KEYS], hidden: [], extra: [] };
  const arr = (x) => (Array.isArray(x) ? x.filter((k) => typeof k === "string") : []);
  const extra = [...new Set(arr(raw.extra).filter((k) => EXTRA_KEYS.includes(k)))];
  const allowed = new Set([...BASE_KEYS, ...extra]);
  const order = [...new Set(arr(raw.order).filter((k) => allowed.has(k)))];
  for (const k of [...BASE_KEYS, ...extra]) if (!order.includes(k)) order.push(k);
  const hidden = [...new Set(arr(raw.hidden).filter((k) => allowed.has(k)))];
  return { order, hidden, extra };
}

export function applyLayout(tiles, layout) {
  const l = normalizeLayout(layout);
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  const hidden = new Set(l.hidden);
  return l.order.filter((k) => !hidden.has(k) && byKey.has(k)).map((k) => byKey.get(k));
}
