
// =====================================================================
//  lib/ffStockValue.js — себестоимость остатков на собственном складе/ФФ
//  на дату (сессия 2026-06-25 (6) — интеграция ff-stock в баланс).
//
//  Симметрично lib/mpStockValue.js (там — остатки на МП, тут — на собств.
//  складе/ФФ). Переиспользуется /api/ff-stock (детализация по местам) и
//  /api/balance (авто-сумма ff_stock в Активах). Один источник истины для
//  логики «SUM(qty × unit_cost) на ближайшем снапшоте <= D», чтобы баланс
//  и страница /items/ff-stock не разъезжались.
//
//  ffStockBreakdown(asOfDate?) →
//    { total, date, byLocation:[{location_id, location_name, qty, value, rows}], rows }
//  total = Σ(qty × unit_cost) по строкам снапшота. date — дата снапшота
//  (ближайший <= asOfDate, как баланс грузит снапшот). byLocation — расшифровка.
//  Если снапшотов нет → {total:0, date:null, byLocation:[], rows:0}.
//
//  Граница: читает fin_data.db.stock_ff_* RO (data-presenter-owned); НЕ пишет.
// =====================================================================

const FIN_DB_PATH = process.env.FIN_DB_PATH || "/opt/agentsDB/fin_data.db";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

let _fin = null;
async function finDb() {
  if (!_fin) _fin = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  return _fin;
}

async function round2(v) {
  const n = Number(v) || 0;
  return Math.round(n * 100) / 100;
}

/**
 * Себестоимость остатков склад/ФФ на дату + расшифровка по местам.
 * Берётся ближайший снапшот stock_ff_snapshots с as_of_date <= asOfDate
 * (как баланс грузит ближайший снапшот). Если asOfDate не задан — последний.
 *
 * Таблицы stock_ff_* могут отсутствовать на старых fin_data.db — graceful.
 */
export async function ffStockBreakdown(asOfDate = null) {
  let db;
  try {
    db = finDb();
  } catch {
    return { total: 0, date: null, byLocation: [], rows: 0 };
  }
  try {
    // Ближайший снапшот <= asOfDate (или последний).
    let snapDate = null;
    if (asOfDate && ISO_DATE.test(asOfDate)) {
      const r = await db
        .prepare(
          "SELECT as_of_date AS d FROM stock_ff_snapshots WHERE as_of_date <= ? ORDER BY as_of_date DESC LIMIT 1"
        )
        .get(asOfDate);
      snapDate = r?.d || null;
    } else {
      const r = await db
        .prepare(
          "SELECT as_of_date AS d FROM stock_ff_snapshots ORDER BY as_of_date DESC LIMIT 1"
        )
        .get();
      snapDate = r?.d || null;
    }
    if (!snapDate) return { total: 0, date: null, byLocation: [], rows: 0 };

    // Строки снапшота + имена мест.
    const rows = await db
      .prepare(
        `SELECT b.catalog_id, b.location_id, b.qty, b.unit_cost,
                COALESCE(l.name, '—') AS location_name
           FROM stock_ff_balances b
           LEFT JOIN stock_ff_locations l ON l.id = b.location_id
          WHERE b.as_of_date = ?`
      )
      .all(snapDate);

    // Группировка по местам.
    const byLoc = {};
    let total = 0;
    let rowCount = 0;
    for (const r of rows) {
      const qty = Number(r.qty) || 0;
      const cost = Number(r.unit_cost) || 0;
      const value = round2(qty * cost);
      total = round2(total + value);
      rowCount += 1;
      const key = r.location_id;
      if (!byLoc[key]) {
        byLoc[key] = { location_id: r.location_id, location_name: r.location_name, qty: 0, value: 0, rows: 0 };
      }
      byLoc[key].qty = round2(byLoc[key].qty + qty);
      byLoc[key].value = round2(byLoc[key].value + value);
      byLoc[key].rows += 1;
    }
    const byLocation = Object.values(byLoc).sort((a, b) => b.value - a.value);
    return { total: round2(total), date: snapDate, byLocation, rows: rowCount };
  } catch {
    // stock_ff_* могут отсутствовать — не падаем.
    return { total: 0, date: null, byLocation: [], rows: 0 };
  }
}
