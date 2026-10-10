// lib/bonusData.js — адаптер БД для премии менеджеров (спека 2026-10-08 §2-4).
// Вызывается ВНУТРИ withCabinet (RLS-транзакция): tenant.* — через tenantQuery, канон
// прибыли — через DatabaseSync. Запросы строго последовательно (один client на транзакцию).
import { DatabaseSync, tenantQuery, query } from "./db.js";
import { wbProfitCabinet, wbProfitProductBatch } from "./wbMetrics.js";
import { ozProfitCabinet, ozProfitProductBatch } from "./ozonMetrics.js";
import { computeBonus, monthWindow } from "./bonus.js";

const CANON = {
  wb: { cabinet: wbProfitCabinet, batch: wbProfitProductBatch },
  ozon: { cabinet: ozProfitCabinet, batch: ozProfitProductBatch },
};

export async function loadEmployees() {
  const rows = await tenantQuery(
    `SELECT user_id, platform, salary::float8 AS salary, bonus_pct::float8 AS bonus_pct,
            threshold::float8 AS threshold, is_active
       FROM tenant.bonus_employees ORDER BY platform, user_id`);
  if (!rows.length) return [];
  const users = await query(`SELECT user_id, name, email FROM auth.users WHERE user_id = ANY($1::bigint[])`,
    [rows.map((r) => r.user_id)]);
  const byId = new Map(users.map((u) => [Number(u.user_id), u]));
  return rows.map((r) => ({ ...r, user_id: Number(r.user_id), name: byId.get(Number(r.user_id))?.name || null,
    email: byId.get(Number(r.user_id))?.email || null }));
}

export async function loadCandidates(cabinetId) {
  const inProgram = (await tenantQuery(`SELECT user_id FROM tenant.bonus_employees`)).map((r) => Number(r.user_id));
  const rows = await query(
    `SELECT m.user_id, m.role, u.name, u.email FROM auth.memberships m JOIN auth.users u ON u.user_id = m.user_id
      WHERE m.cabinet_id = $1 ORDER BY m.user_id`, [cabinetId]);
  return rows.map((r) => ({ ...r, user_id: Number(r.user_id) })).filter((r) => !inProgram.includes(r.user_id));
}

async function skuNames(platform, keys) {
  if (!keys.length) return new Map();
  const rows = platform === "wb"
    ? await tenantQuery(`SELECT nm_id AS k, name FROM tenant.wb_articles WHERE nm_id = ANY($1::bigint[])`, [keys])
    : await tenantQuery(`SELECT product_id AS k, COALESCE(name, offer_id) AS name FROM tenant.ozon_products WHERE product_id = ANY($1::bigint[])`, [keys]);
  return new Map(rows.map((r) => [Number(r.k), r.name]));
}

// Живой расчёт карточки сотрудника за месяц (без учёта закрытия).
export async function buildLiveCard({ employee, period, today, taxMode }) {
  const [plan] = await tenantQuery(
    `SELECT sales_plan::float8 AS sales_plan, profit_plan::float8 AS profit_plan FROM tenant.bonus_plans
      WHERE user_id = $1 AND period = $2`, [employee.user_id, period]);
  const exRows = await tenantQuery(
    `SELECT id, sku_key, sales_plan_off::float8 AS sales_plan_off, profit_plan_off::float8 AS profit_plan_off, reason
       FROM tenant.bonus_exclusions WHERE user_id = $1 AND period = $2 ORDER BY id`, [employee.user_id, period]);

  const window = monthWindow(period, today);
  let salesFact = 0, profitFact = 0, perSku = new Map();
  if (window) {
    const canon = CANON[employee.platform];
    const db = new DatabaseSync(employee.platform, { readOnly: true });
    const cab = await canon.cabinet(db, taxMode, window);
    salesFact = cab.revenue || 0;
    profitFact = cab.profit || 0;
    if (exRows.length) perSku = await canon.batch(db, taxMode, window);
  }
  const names = await skuNames(employee.platform, exRows.map((e) => Number(e.sku_key)));
  const exclusions = exRows.map((e) => {
    const f = perSku.get(Number(e.sku_key)) || {};
    return { id: Number(e.id), sku_key: Number(e.sku_key), name: names.get(Number(e.sku_key)) || null,
      revenue: f.revenue || 0, profit: f.profit || 0,
      sales_plan_off: e.sales_plan_off, profit_plan_off: e.profit_plan_off, reason: e.reason };
  });

  const r = computeBonus({
    salesPlan: plan?.sales_plan, profitPlan: plan?.profit_plan, salesFact, profitFact,
    exclusions: exclusions.map((e) => ({ revenue: e.revenue, profit: e.profit, salesPlanOff: e.sales_plan_off, profitPlanOff: e.profit_plan_off })),
    salary: employee.salary, bonusPct: employee.bonus_pct, threshold: employee.threshold,
  });
  const status = !window ? "no_data" : r.status === "no_plan" ? "no_plan" : "live";
  // ...r первым: computeBonus тоже отдаёт поле status ('ok'|'no_plan') — карточный статус важнее.
  return { ...r, employee, period, window, status, closedAt: null, closedBy: null,
    platformFact: { revenue: salesFact, profit: profitFact }, exclusions };
}

// Карточка с учётом фиксации: закрытый месяц отдаётся из снимка.
export async function buildCard(args) {
  const [closed] = await tenantQuery(
    `SELECT snapshot, closed_by, closed_at FROM tenant.bonus_closings WHERE user_id = $1 AND period = $2`,
    [args.employee.user_id, args.period]);
  if (closed) return { ...closed.snapshot, status: "closed", closedAt: closed.closed_at, closedBy: Number(closed.closed_by) };
  return buildLiveCard(args);
}

export async function isClosed(userId, period) {
  const r = await tenantQuery(`SELECT 1 FROM tenant.bonus_closings WHERE user_id = $1 AND period = $2`, [userId, period]);
  return r.length > 0;
}
