// lib/ffStockValue.js — остатки склад/ФФ (tenant.ff_inventory через tenantQuery).
//
// ⚠ Раньше читал tenant.stock_ff_snapshots/stock_ff_balances (старая ломаная
// модель, всегда пустая). С 2026-07-15 остатки лежат в tenant.ff_inventory
// (маршрут «закупка → завершить → склад», миграция 014) — туда же смотрит
// страница «Остатки склад/ФФ» (/api/inventory). Баланс должен показывать те же
// цифры, что эта страница.
//
// Стоимость = Σ (qty × unit_cost). Группировка по месту (location_id →
// stock_ff_locations.name, миграция 017). Параметр asOfDate игнорируется —
// ff_inventory это накопитель «текущего» остатка (снимок, не история по датам).
import { tenantQuery } from "./db.js";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export async function ffStockBreakdown(asOfDate = null) {
  try {
    const rows = await tenantQuery(
      `SELECT fi.id, fi.qty, fi.unit_cost, fi.internal_name, fi.category,
              fi.location_id,
              COALESCE(l.name, COALESCE(fi.location_type, '—')) AS location_name
       FROM tenant.ff_inventory fi
       LEFT JOIN tenant.stock_ff_locations l
         ON l.id = fi.location_id AND l.cabinet_id = fi.cabinet_id
       WHERE fi.archived_at IS NULL
         AND fi.qty IS NOT NULL AND fi.qty > 0`
    );
    const byLoc = {};
    let total = 0;
    let rowCount = 0;
    for (const r of rows) {
      const qty = Number(r.qty) || 0;
      const uc = Number(r.unit_cost) || 0;
      const value = round2(qty * uc);
      total = round2(total + value);
      rowCount += 1;
      const key = r.location_id != null ? r.location_id : (r.location_name || "—");
      if (!byLoc[key]) byLoc[key] = { location_id: r.location_id, location_name: r.location_name, qty: 0, value: 0, rows: 0 };
      byLoc[key].qty = round2(byLoc[key].qty + qty);
      byLoc[key].value = round2(byLoc[key].value + value);
      byLoc[key].rows += 1;
    }
    return {
      total: round2(total),
      date: new Date().toISOString().slice(0, 10), // ff_inventory — текущий остаток, без истории
      byLocation: Object.values(byLoc).sort((a, b) => b.value - a.value),
      rows: rowCount,
    };
  } catch {
    return { total: 0, date: null, byLocation: [], rows: 0 };
  }
}
