import { getFinDb } from "./finDb";

// =====================================================================
//  lib/purchasesInTransit.js — «Товар в пути» из закупок (заявка 2026-06-25).
//
//  Зеркалит ДОКАЗАННУЮ формулу из financial_agent/fin/balance_proposal.py:
//    stock_in_transit = Σ ( qty × unit_cost [fallback unit_cost_est] )
//      по закупкам с lifecycle_effective ∈ {"shipped", "in_transit"},
//      исключая soft-deleted (deleted_at IS NULL).
//
//  lifecycle_effective (как db_local._lifecycle_effective и route.js lifecycleEffective):
//    raw lifecycle_status если задан, иначе 'arrived' если delivery_dt, иначе 'planned'.
//  → NULL-legacy строки НЕ попадают в «в пути» (резолвятся в arrived/planned).
//
//  Переиспользуется /api/balance (авто stock_in_transit, read-only в UI).
//  Возвращает разбивку по закупкам + total. Дата НЕ фильтруется (как в build_proposal —
//  сумма всех текущих партий в пути; закупки — актуальное состояние, не исторический срез).
//
//  Граница: читает fin_data.db (purchases), НЕ пишет; НЕ трогает код фин-агента.
// =====================================================================

const IN_TRANSIT_STATES = new Set(["shipped", "in_transit"]);

async function lifecycleEffective(row) {
  if (row.lifecycle_status) return row.lifecycle_status;
  return row.delivery_dt ? "arrived" : "planned";
}

async function round2(v) {
  const n = Number(v) || 0;
  return Math.round(n * 100) / 100;
}

/**
 * Себестоимость партий «в пути» (shipped / in_transit) + разбивка по закупкам.
 * @returns {{ total:number, count:number, items:Array<{id, name, qty, unit_cost, value, lifecycle}> }}
 */
export async function purchasesInTransit() {
  const db = getFinDb();
  try {
    const rows = await db
      .prepare(
        `SELECT id, supplier_name, qty, unit_cost, unit_cost_est,
                lifecycle_status, delivery_dt
         FROM purchases
         WHERE deleted_at IS NULL`
      )
      .all();
    const items = [];
    let total = 0;
    for (const r of rows) {
      const ls = lifecycleEffective(r);
      if (!IN_TRANSIT_STATES.has(ls)) continue;
      const uc = Number(r.unit_cost) || Number(r.unit_cost_est) || 0;
      const qty = Number(r.qty) || 0;
      const value = round2(qty * uc);
      total += value;
      items.push({
        id: r.id,
        name: r.supplier_name || `#${r.id}`,
        qty,
        unit_cost: round2(uc),
        value,
        lifecycle: ls,
      });
    }
    return { total: round2(total), count: items.length, items };
  } finally {
    db.close();
  }
}
