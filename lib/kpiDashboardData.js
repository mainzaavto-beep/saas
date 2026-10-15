// lib/kpiDashboardData.js — данные «Дашборда показателей» (15.10.2026). Спека
// docs/superpowers/specs/2026-10-15-kpi-dashboard-design.md §4.
// Источники (строго последовательно — withCabinet держит одну транзакцию):
//   items — buildTotals Сводки (lib/productsSummaryData.js), текущее и прошлое окно;
//   money — без товарного фильтра wbProfitCabinet/ozProfitCabinet (как /pnl),
//           с фильтром — деньги из тех же строк Сводки (канон *ProfitProductBatch);
//   opex  — tenant.opex (справочно, в прибыль не входит).
// Каждый источник под своим SAVEPOINT: сбой → console.error + имя в errors[], плитки
// этого источника показывают «ошибка загрузки», остальные живы (паттерн блока складов
// на Главной, app/api/cabinets/[id]/overview/route.js).
import { DatabaseSync, tenantQuery, query } from "./db.js";
import { buildTotals, shiftDateUTC } from "./productsSummaryData.js";
import { wbProfitCabinet, WB_TAX_BASE } from "./wbMetrics.js";
import { ozProfitCabinet } from "./ozonMetrics.js";
import { statusMap } from "./finItems.js";
import { normalizeTaxMode } from "./tax.js";
import { aggregateItems, applyCanon, filterItems, normalizeLayout, skuKeyOf } from "./kpiDashboard.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const list = (sp, k) => (sp.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);

export function parseKpiQuery(sp) {
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  let to = DATE_RE.test(sp.get("to") || "") ? sp.get("to") : yesterday;
  let from = DATE_RE.test(sp.get("from") || "") ? sp.get("from") : shiftDateUTC(to, -6);
  if (from > to) [from, to] = [to, from];
  if ((new Date(to) - new Date(from)) / 864e5 + 1 > MAX_DAYS) from = shiftDateUTC(to, -(MAX_DAYS - 1));
  return {
    from, to,
    shops: list(sp, "shops").map(Number).filter((n) => Number.isInteger(n) && n > 0),
    brands: list(sp, "brands"), cats: list(sp, "cats"), skus: list(sp, "skus"),
  };
}

async function guarded(name, errors, fn, fallback) {
  await tenantQuery(`SAVEPOINT kpi_${name}`, []);
  try {
    const v = await fn();
    await tenantQuery(`RELEASE SAVEPOINT kpi_${name}`, []);
    return v;
  } catch (e) {
    console.error(`[kpi] источник ${name}:`, e);
    await tenantQuery(`ROLLBACK TO SAVEPOINT kpi_${name}`, []);
    await tenantQuery(`RELEASE SAVEPOINT kpi_${name}`, []);
    if (!errors.includes(name)) errors.push(name);
    return fallback;
  }
}

async function loadOpex(from, to) {
  const [r] = await tenantQuery(
    `SELECT COALESCE(SUM(amount),0)::float AS s FROM tenant.opex
     WHERE status = 'active' AND domain = 'business' AND COALESCE(included_in_cogs,0) = 0
       AND substr(COALESCE(NULLIF(op_date,''), period || '-01'),1,10) BETWEEN $1 AND $2`,
    [from, to]
  );
  return Math.round((r?.s || 0) * 100) / 100;
}

async function loadSide(cabinet, { platforms, from, to, productFilter, filter, stat, errors, wbTaxBase }) {
  const pf = platforms.length === 2 ? "all" : platforms[0];
  const built = await guarded("items", errors, () => buildTotals(cabinet, pf, from, to, true, stat), { items: [] });
  const items = productFilter ? filterItems(built.items, filter) : built.items;
  const agg = aggregateItems(items, { wbTaxBase });
  const side = { wb: platforms.includes("wb") ? agg.wb : null, ozon: platforms.includes("ozon") ? agg.ozon : null, opex: null, items: built.items };
  if (!productFilter) {
    if (side.wb) {
      const c = await guarded("money", errors,
        () => wbProfitCabinet(new DatabaseSync("wb", { readOnly: true }), normalizeTaxMode(cabinet.shopTax?.wb), { from, to }), null);
      if (c?.unknownCostTypes) console.error(`[kpi] WB: незнакомые статьи кабинетных расходов: ${c.unknownCostTypes}`);
      side.wb = c ? applyCanon(side.wb, c, "wb", { wbTaxBase }) : side.wb;
    }
    if (side.ozon) {
      const c = await guarded("money", errors,
        () => ozProfitCabinet(new DatabaseSync("ozon", { readOnly: true }), normalizeTaxMode(cabinet.shopTax?.ozon), { from, to }), null);
      if (c?.unknownCostTypes) console.error(`[kpi] Ozon: незнакомые статьи кабинетных расходов: ${c.unknownCostTypes}`);
      side.ozon = c ? applyCanon(side.ozon, c, "ozon", { wbTaxBase }) : side.ozon;
    }
    side.opex = await guarded("opex", errors, () => loadOpex(from, to), null);
  }
  return side;
}

export async function loadKpiDashboard(cabinet, opts) {
  const { from, to } = opts;
  const N = Math.round((new Date(to) - new Date(from)) / 864e5) + 1;
  const prevTo = shiftDateUTC(from, -1);
  const prevFrom = shiftDateUTC(prevTo, -(N - 1));

  const shopRows = await query(
    `SELECT shop_id, mp_code, shop_name FROM auth.shops WHERE cabinet_id = $1 AND is_active ORDER BY shop_id`,
    [cabinet.cabinet_id]
  );
  const cabMps = (cabinet.marketplaces || ["wb", "ozon"]).filter((m) => m === "wb" || m === "ozon");
  const chosen = opts.shops.length ? shopRows.filter((s) => opts.shops.includes(Number(s.shop_id))) : [];
  const platforms = chosen.length ? cabMps.filter((m) => chosen.some((s) => s.mp_code === m)) : cabMps;
  const filter = { brands: opts.brands, cats: opts.cats, skus: opts.skus };
  const productFilter = !!(filter.brands.length || filter.cats.length || filter.skus.length);

  const errors = [];
  const stat = await guarded("items", errors, () => statusMap(), {});
  const common = { platforms, productFilter, filter, stat, errors, wbTaxBase: WB_TAX_BASE };
  const cur = await loadSide(cabinet, { ...common, from, to });
  const prev = await loadSide(cabinet, { ...common, from: prevFrom, to: prevTo });

  // Варианты фильтров — активные товары и товары с движением текущего окна (как видит Сводка).
  // ⚠️ Отклонение от брифа (решение контролера, 15.10.2026): buildTotals выше вызван с
  // includeInactive=true (5-й аргумент), а она выставляет it.status только в ветке
  // includeInactive=false (lib/productsSummaryData.js) — здесь it.status всегда undefined, и
  // `(it.status || "active") === "active"` пропускал бы и inactive-товары в список фильтров.
  // Статус считаем из той же карты stat (statusMap()) тем же ключом, что строит сама buildTotals:
  // `${platform}|${platform==="ozon"?0:nm}|${platform==="ozon"?nm:0}`, fallback "active".
  const statusOf = (it) => {
    const key = `${it.platform}|${it.platform === "ozon" ? 0 : it.nm}|${it.platform === "ozon" ? it.nm : 0}`;
    return stat[key] || "active";
  };
  const visible = cur.items.filter((it) => statusOf(it) === "active"
    || (it.sold || 0) > 0 || (it.returns || 0) > 0 || (it.ordered || 0) > 0 || (it.buyoutResolved || 0) > 0)
    .filter((it) => platforms.includes(it.platform));
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  const options = {
    shops: shopRows.map((s) => ({ id: Number(s.shop_id), platform: s.mp_code, name: s.shop_name || s.mp_code })),
    brands: uniq(visible.map((it) => it.brand)),
    cats: uniq(visible.map((it) => it.cat)),
    skus: visible.map((it) => ({ key: skuKeyOf(it), platform: it.platform, name: it.name, article: it.sa }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru")),
  };
  delete cur.items;
  delete prev.items;
  for (const s of [cur, prev]) for (const pf of ["wb", "ozon"]) if (s[pf] === undefined) s[pf] = null;
  return { period: { from, to }, prevPeriod: { from: prevFrom, to: prevTo }, platforms, productFilter, cur, prev, errors, options };
}

export async function readLayout(cabinetId, userId) {
  const [r] = await tenantQuery(
    `SELECT layout FROM tenant.kpi_dashboard_prefs WHERE cabinet_id = $1 AND user_id = $2`, [cabinetId, userId]);
  return normalizeLayout(r?.layout);
}

export async function saveLayout(cabinetId, userId, layout) {
  const norm = normalizeLayout(layout);
  await tenantQuery(
    `INSERT INTO tenant.kpi_dashboard_prefs (cabinet_id, user_id, layout, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (cabinet_id, user_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()`,
    [cabinetId, userId, JSON.stringify(norm)]);
  return norm;
}

export async function resetLayout(cabinetId, userId) {
  await tenantQuery(`DELETE FROM tenant.kpi_dashboard_prefs WHERE cabinet_id = $1 AND user_id = $2`, [cabinetId, userId]);
  return normalizeLayout(null);
}
