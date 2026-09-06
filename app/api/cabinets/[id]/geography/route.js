// /api/cabinets/[id]/geography — «География» v2: канон + prev-окно + KPI.
// Переписано с нуля (план 2026-09-05-geo-canon-vitrina, задача 3) поверх
// гео-канона lib/geoMetrics.js (задача 2, коммит 3144bef) — «одна цифра
// везде» с /pnl и /products-summary: заказы is_cancel=0, продажи WB
// is_realization=1, продажи Ozon честные (tenant.ozon_sales, is_return=0).
//
// Контракт ответа v2 (Global Constraints плана — задачи 5-6 его потребляют,
// сторож задачи 4 сверяет; менять только синхронно со всеми тремя):
//   {
//     period: {from,to}, prevPeriod: {from,to},
//     kpi:     { localPct, speedWbDays, speedOzDays, fbsSharePct, scLagHours },
//     prevKpi: { ...та же форма, за prevPeriod... },   // null-поля при пустом prev
//     byRegion:    [{ name, ordersRub, ordersQty, salesRub, salesQty }],  // сорт. ordersRub+salesRub desc
//     byWarehouse: [{ name, ordersRub, ordersQty, salesRub, salesQty }],
//     locality: { wb:   { rows: [{ whCluster, buyerCluster, qty }], localPct, mappedPct },
//                 ozon: { rows: [{ whFo,      buyerFo,      qty }], localPct, mappedPct } },
//     speed:    { wb: [{ okrug, scheme, medianDays, n }], ozon: [{ fo, medianDays, n }] },
//     facets:   { brand: [{value,count}], group: [{value,count}], nm: [{id,label,count}] },
//     supplies: { rows: [{ supplyId, name, createdAt, closedAt, scanDt, done,
//                           buildHours, scHours, status,
//                           buyoutMedianDays, buyoutN,
//                           pvzMedianDays, pvzN,
//                           tasks: { transit, pvz, sold, canceled, unknown } }],
//                 medianBuildHours, medianScHours, p90ScHours,
//                 stuckCount, noScanOldCount, total,
//                 buyoutMedianDaysOverall, pvzMedianDaysOverall, pvzN }
//               | null при mp=ozon / отсутствии WB у кабинета (см. wantWb);
//                 не считается для prevKpi (kpiOnly пропускает).
//   }
//
// mp=wb|ozon — платформа, которой нет (ни по query, ни по cabinet.
// marketplaces — гейт применяется единообразно с overview/items/pnl),
// отдаётся locality как { rows: [], localPct: null, mappedPct: null },
// speed — как [].
// scheme=all|fbo|fbs — ВАЛИДИРУЕТСЯ на входе (находка ревью задачи 2): любое
// иное значение ломает SQL в geoMetrics-хелперах (WB_SCHEME_SQL[scheme] даёт
// undefined) — падаем на «all», а не пробрасываем сырой параметр.
//
// prev-окно считается ТЕМ ЖЕ кодом (collectAll), стыком назад (паттерн
// products-summary/route.js:117-129), но БЕЗ byRegion/byWarehouse/locality.
// rows/speed/facets — только kpi (kpiOnly:true) — тяжёлые запросы не дублируем.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { defaultPeriod } from "@/lib/period.js";
import {
  wbGeoSummary, ozGeoSummary,
  wbOrdersLocalityMatrix, ozOrdersLocalityMatrix,
  wbSpeedByOkrug, ozSpeedByFo,
  wbSpeedOverall, ozSpeedOverall,
  wbFbsShare, ozFbsShare,
  wbSupplyLagHours,
  wbSuppliesOps,
} from "@/lib/geoMetrics.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_LOCALITY = { rows: [], localPct: null, mappedPct: null };
const UNMAPPED = "Не определено";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mp = url.searchParams.get("mp") || "all";
  // Находка ревью задачи 2: scheme вне {all,fbo,fbs} рождает битый SQL
  // в geoMetrics-хелперах (WB_SCHEME_SQL[scheme] → undefined). Валидируем.
  const rawScheme = url.searchParams.get("scheme") || "all";
  const scheme = ["fbo", "fbs"].includes(rawScheme) ? rawScheme : "all";
  const def = defaultPeriod(30);
  const from = url.searchParams.get("from") || def.from;
  const to = url.searchParams.get("to") || def.to;
  const filters = {
    scheme,
    nmId: url.searchParams.get("nm") || "",
    brand: url.searchParams.get("brand") || "",
    group: url.searchParams.get("group") || "",
    q: (url.searchParams.get("q") || "").trim().toLowerCase(), // lib оборачивает колонку в LOWER(), не параметр — регистр гасим тут
  };

  // Гейт площадок кабинета (находка ревью, фикс-раунд 1): паттерн
  // overview/route.js:126,141,145 — mp-параметр И реально подключённые
  // площадки. Кабинет с одной площадкой (обычный итог онбординга) не
  // должен вхолостую гонять SQL по отсутствующей БД дважды (cur+prev).
  const mps = cabinet.marketplaces || ["wb", "ozon"];
  const wantWb = mp !== "ozon" && mps.includes("wb");
  const wantOz = mp !== "wb" && mps.includes("ozon");

  // prev-окно ТЕМ ЖЕ кодом (паттерн products-summary/route.js:117-129).
  const N = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const prevTo = shiftDateUTC(from, -1);
  const prevFrom = shiftDateUTC(prevTo, -(N - 1));

  const cur = await collectAll({ wantWb, wantOz }, { from, to, ...filters });
  const prev = await collectAll({ wantWb, wantOz }, { from: prevFrom, to: prevTo, ...filters, kpiOnly: true });

  return NextResponse.json({
    period: { from, to }, prevPeriod: { from: prevFrom, to: prevTo },
    kpi: cur.kpi, prevKpi: prev.kpi,
    byRegion: cur.byRegion, byWarehouse: cur.byWarehouse,
    locality: cur.locality, speed: cur.speed,
    facets: cur.facets,
    supplies: cur.supplies,
  });
});

// Сдвиг даты 'YYYY-MM-DD' на N дней в UTC — точная копия
// products-summary/route.js:245-249 (там локальная, не экспортируется;
// дублируем с этой ссылкой, а не импортируем приватную функцию).
function shiftDateUTC(dateStr, deltaDays) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// collectAll({wantWb, wantOz}, opts) — ЕДИНСТВЕННОЕ место расчёта (и
// текущего окна, и prev). wantWb/wantOz уже учитывают И mp-параметр, И
// cabinet.marketplaces (считает вызывающий GET) — здесь только сами флаги,
// без доступа к query/cabinet, чтобы функция оставалась чистой и не решала
// дважды один и тот же гейт. opts.kpiOnly=true пропускает byRegion/
// byWarehouse/детальную speed/facets — это тяжёлые запросы, prev-окну
// хватает kpi (сам kpi всё равно считается ТЕМИ ЖЕ функциями geoMetrics,
// что и для текущего окна).
async function collectAll({ wantWb, wantOz }, opts) {
  const { from, to, scheme, nmId, brand, group, q, kpiOnly } = opts;
  const wbDb = wantWb ? new DatabaseSync("wb", { readOnly: true }) : null;
  const ozDb = wantOz ? new DatabaseSync("ozon", { readOnly: true }) : null;

  // Локальность нужна ВСЕГДА (и для kpi.localPct, и для секции 3 в full-режиме).
  const wbLoc = wantWb ? await wbOrdersLocalityMatrix(wbDb, { from, to, scheme }) : null;
  const ozLoc = wantOz ? await ozOrdersLocalityMatrix(ozDb, { from, to, scheme }) : null;

  // KPI-компоненты — тоже всегда (лёгкие агрегаты без GROUP BY по разрезу).
  const wbFast = wantWb ? await wbSpeedOverall(wbDb, { from, to }) : null;
  const ozFast = wantOz ? await ozSpeedOverall(ozDb, { from, to }) : null;
  const wbShare = wantWb ? await wbFbsShare(wbDb, { from, to }) : null;
  const ozShare = wantOz ? await ozFbsShare(ozDb, { from, to }) : null;
  const scLag = wantWb ? await wbSupplyLagHours(wbDb, { from, to }) : null;

  const kpi = buildKpi({ wbLoc, ozLoc, wbFast, ozFast, wbShare, ozShare, scLag });

  if (kpiOnly) {
    return { kpi };
  }

  // Полные сводки/разрезы — только для текущего окна.
  const wbSum = wantWb ? await wbGeoSummary(wbDb, { from, to, scheme, nmId, brand, group, q }) : null;
  const ozSum = wantOz ? await ozGeoSummary(ozDb, { from, to, scheme, nmId, brand, group, q }) : null;
  const wbSpeedRows = wantWb ? await wbSpeedByOkrug(wbDb, { from, to }) : [];
  const ozSpeedRows = wantOz ? await ozSpeedByFo(ozDb, { from, to }) : [];

  // FBS-отгрузки (задача 2 плана 2026-09-05-geo-fbs-ops) — только WB (Ozon
  // FBS вне рамок этапа), только текущее окно (kpiOnly уже вернулся выше,
  // !opts.kpiOnly здесь для явности контракта, а не как рабочий гейт).
  const supplies = wantWb && !opts.kpiOnly ? await wbSuppliesOps(wbDb, { from, to }) : null;

  const byRegion = mergeByName(wbSum?.byRegion || [], ozSum?.byRegion || []);
  const byWarehouse = mergeByName(wbSum?.byWarehouse || [], ozSum?.byWarehouse || []);
  byRegion.sort((a, b) => (b.ordersRub + b.salesRub) - (a.ordersRub + a.salesRub));
  byWarehouse.sort((a, b) => (b.ordersRub + b.salesRub) - (a.ordersRub + a.salesRub));

  const facets = await buildFacets({ wbDb, ozDb, from, to });

  return {
    kpi,
    byRegion, byWarehouse,
    locality: {
      wb: wbLoc || EMPTY_LOCALITY,
      ozon: ozLoc || EMPTY_LOCALITY,
    },
    speed: { wb: wbSpeedRows, ozon: ozSpeedRows },
    facets,
    supplies,
  };
}

// buildKpi/weightedLocalPct — дословно из брифа задачи 3 плана.
function buildKpi({ wbLoc, ozLoc, wbFast, ozFast, wbShare, ozShare, scLag }) {
  // Локальность: взвешенно по замапленным штукам обеих площадок (Σ local / Σ mapped
  // пересчитывается из rows матриц — та же формула, что в withLocalityTotals).
  const localPct = weightedLocalPct([wbLoc, ozLoc].filter(Boolean));
  const fbsQty = (wbShare?.fbsQty ?? 0) + (ozShare?.fbsQty ?? 0);
  const totalQty = (wbShare?.totalQty ?? 0) + (ozShare?.totalQty ?? 0);
  return {
    localPct,
    speedWbDays: wbFast?.medianDays ?? null,   // wbSpeedOverall (Task 2)
    speedOzDays: ozFast?.medianDays ?? null,   // ozSpeedOverall (Task 2)
    fbsSharePct: totalQty > 0 ? Math.round((fbsQty * 1000) / totalQty) / 10 : null,
    scLagHours: scLag?.medianHours ?? null,
  };
}

function weightedLocalPct(parts) {
  let local = 0, mapped = 0;
  for (const p of parts) for (const r of p.rows) {
    const q = Number(r.qty) || 0;
    const wh = r.whCluster ?? r.whFo, buyer = r.buyerCluster ?? r.buyerFo;
    if (wh !== UNMAPPED && buyer !== UNMAPPED) {
      mapped += q;
      if (wh === buyer) local += q;
    }
  }
  return mapped > 0 ? Math.round((local * 1000) / mapped) / 10 : null;
}

// mergeByName — перенос из старого роута (geography/route.js, дословно).
function mergeByName(a, b) {
  const map = new Map();
  for (const r of a) map.set(r.name, { ...r });
  for (const r of b) {
    const cur = map.get(r.name) || { name: r.name, ordersRub: 0, ordersQty: 0, salesRub: 0, salesQty: 0 };
    cur.ordersRub += r.ordersRub || 0; cur.ordersQty += r.ordersQty || 0;
    cur.salesRub += r.salesRub || 0; cur.salesQty += r.salesQty || 0;
    map.set(r.name, cur);
  }
  return [...map.values()];
}

// buildFacets — перенос из старого роута, но ОКНО обязательно (полный скан
// таблицы заказов без границ дат — слишком тяжело; facets только для
// текущего окна, prev их не считает — collectAll(kpiOnly) сюда не заходит).
async function buildFacets({ wbDb, ozDb, from, to }) {
  const facets = { brand: [], group: [], nm: [] };
  if (wbDb) {
    const rows = await wbDb.prepare(
      `SELECT o.brand, o.subject, o.nm_id, o.supplier_article, a.name
       FROM orders o LEFT JOIN articles a ON a.nm_id = o.nm_id
       WHERE substr(o.order_dt,1,10) >= ? AND substr(o.order_dt,1,10) <= ?`
    ).all(from, to);
    const wbFacets = buildFacetsFromRows(rows, "wb");
    facets.brand = mergeFacets(facets.brand, wbFacets.brand);
    facets.group = mergeFacets(facets.group, wbFacets.group);
    facets.nm = mergeFacets(facets.nm, wbFacets.nm);
  }
  if (ozDb) {
    const rows = await ozDb.prepare(
      `SELECT o.product_id, p.brand, p.category, p.name, o.offer_id
       FROM orders o LEFT JOIN products p ON p.product_id = o.product_id
       WHERE substr(o.order_dt,1,10) >= ? AND substr(o.order_dt,1,10) <= ?`
    ).all(from, to);
    const ozFacets = buildFacetsFromRows(rows, "ozon");
    facets.brand = mergeFacets(facets.brand, ozFacets.brand);
    facets.group = mergeFacets(facets.group, ozFacets.group);
    facets.nm = mergeFacets(facets.nm, ozFacets.nm);
  }
  return facets;
}

// buildFacetsFromRows/mergeFacets — перенос из старого роута (дословно,
// переименовано buildFacets→buildFacetsFromRows чтобы не конфликтовать
// с async-обёрткой buildFacets выше).
function buildFacetsFromRows(rows, mp) {
  const brands = new Map(), groups = new Map(), nms = new Map();
  for (const r of rows) {
    if (mp === "wb") {
      if (r.brand) brands.set(r.brand, (brands.get(r.brand) || 0) + 1);
      if (r.subject) groups.set(r.subject, (groups.get(r.subject) || 0) + 1);
      if (r.nm_id) nms.set(r.nm_id, { label: r.supplier_article || r.name || String(r.nm_id), count: (nms.get(r.nm_id)?.count || 0) + 1 });
    } else {
      if (r.brand) brands.set(r.brand, (brands.get(r.brand) || 0) + 1);
      if (r.category) groups.set(r.category, (groups.get(r.category) || 0) + 1);
      if (r.product_id) nms.set(r.product_id, { label: r.offer_id || r.name || String(r.product_id), count: (nms.get(r.product_id)?.count || 0) + 1 });
    }
  }
  const toOpts = (m, isNm) => {
    if (isNm) return [...nms.entries()].map(([id, v]) => ({ id, label: v.label, count: v.count })).sort((a, b) => b.count - a.count);
    return [...m.entries()].map(([k, n]) => ({ value: k, count: n })).sort((a, b) => b.count - a.count);
  };
  return { brand: toOpts(brands, false), group: toOpts(groups, false), nm: toOpts(nms, true) };
}

function mergeFacets(a, b) {
  const map = new Map(a.map((x) => [x.value ?? x.id, x]));
  for (const x of b) {
    const key = x.value ?? x.id;
    const cur = map.get(key);
    if (cur) cur.count = (cur.count || 0) + (x.count || 0);
    else map.set(key, x);
  }
  return [...map.values()].sort((a, b) => (b.count || 0) - (a.count || 0));
}
