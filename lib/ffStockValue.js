// lib/ffStockValue.js — остатки склад/ФФ (tenant.stock_ff_* через tenantQuery).
import { tenantQuery } from "./db.js";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export async function ffStockBreakdown(asOfDate = null) {
  try {
    let snapDate = null;
    if (asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      const r = await tenantQuery(
        `SELECT as_of_date AS d FROM tenant.stock_ff_snapshots WHERE as_of_date <= $1 ORDER BY as_of_date DESC LIMIT 1`,
        [asOfDate]
      );
      snapDate = r[0]?.d || null;
    } else {
      const r = await tenantQuery(
        `SELECT as_of_date AS d FROM tenant.stock_ff_snapshots ORDER BY as_of_date DESC LIMIT 1`
      );
      snapDate = r[0]?.d || null;
    }
    if (!snapDate) return { total: 0, date: null, byLocation: [], rows: 0 };

    const rows = await tenantQuery(
      `SELECT b.catalog_id, b.location_id, b.quantity AS qty, b.internal_name,
              COALESCE(l.name, '—') AS location_name
       FROM tenant.stock_ff_balances b
       LEFT JOIN tenant.stock_ff_locations l ON l.id = b.location_id AND l.cabinet_id = b.cabinet_id
       WHERE b.cabinet_id = current_setting('app.cabinet_id')::bigint
         AND EXISTS (SELECT 1 FROM tenant.stock_ff_snapshots s WHERE s.id = b.snapshot_id AND s.as_of_date = $1)`,
      [snapDate]
    );
    const byLoc = {};
    let total = 0;
    let rowCount = 0;
    for (const r of rows) {
      const qty = Number(r.qty) || 0;
      const value = round2(qty); // unit_cost нет в SAAS-схеме — просто qty (упрощение)
      total = round2(total + value);
      rowCount += 1;
      const key = r.location_id;
      if (!byLoc[key]) byLoc[key] = { location_id: r.location_id, location_name: r.location_name, qty: 0, value: 0, rows: 0 };
      byLoc[key].qty = round2(byLoc[key].qty + qty);
      byLoc[key].value = round2(byLoc[key].value + value);
      byLoc[key].rows += 1;
    }
    return { total: round2(total), date: snapDate, byLocation: Object.values(byLoc).sort((a, b) => b.value - a.value), rows: rowCount };
  } catch {
    return { total: 0, date: null, byLocation: [], rows: 0 };
  }
}
