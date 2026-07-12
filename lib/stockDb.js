import { ensureAuditTriggers } from "./dbAudit";

// =====================================================================
//  lib/stockDb.js — ОСТАТКИ НА СКЛАДЕ/ФФ (сессия 2026-06-25 (5)).
//
//  Ручной учёт товара на собственном складе и фулфилменте (НЕ остатки
//  на МП — те берутся из daily_stock сборщика RO). Хранится СНЭПШОТАМИ
//  по датам (как balance_snapshot), чтобы видеть остаток на прошлую дату.
//
//  3 таблицы в fin_data.db (data-presenter-owned):
//    stock_ff_locations — каталог мест хранения («Свой склад», «ФФ Пеликан»).
//      Паттерн как balance_account_catalog: редактируемый, archived=1 = soft-delete.
//    stock_ff_snapshots — заголовок снапшота на дату (UNIQUE(as_of_date)).
//    stock_ff_balances  — детализация: UNIQUE(as_of_date, catalog_id, location_id).
//      qty + unit_cost (снапшот себестоимости на момент ввода; можно править).
//
//  Связь с товаром — через products_catalog (lib/catalogDb.js). Один
//  balance = (дата, товар-каталога, место). Сумма = qty × unit_cost.
//
//  Граница: fin_data.db — data-presenter владеет; код фин-агента не трогаем.
//  Паттерн: lib/finItems.js (ensureSchema + open/close try/finally).
// =====================================================================

const FIN_DB_PATH = process.env.FIN_DB_PATH || "/opt/agentsDB/fin_data.db";

const SCHEMA = `
-- Каталог мест хранения (как balance_account_catalog).
CREATE TABLE IF NOT EXISTS stock_ff_locations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    archived   INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

-- Заголовок снапшота на дату.
CREATE TABLE IF NOT EXISTS stock_ff_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    as_of_date TEXT NOT NULL UNIQUE,
    note       TEXT,
    created_at TEXT NOT NULL
);

-- Детализация остатков: одна строка = (дата, товар, место).
-- unit_cost — снапшот себестоимости на момент ввода (можно править).
-- qty REAL (допускаем дробные — напр. кг), но обычно целое.
CREATE TABLE IF NOT EXISTS stock_ff_balances (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    as_of_date  TEXT NOT NULL,
    catalog_id  INTEGER NOT NULL REFERENCES products_catalog(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES stock_ff_locations(id) ON DELETE CASCADE,
    qty         REAL NOT NULL DEFAULT 0,
    unit_cost   REAL,
    created_at  TEXT NOT NULL,
    UNIQUE(as_of_date, catalog_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_sff_date ON stock_ff_balances(as_of_date);
CREATE INDEX IF NOT EXISTS idx_sff_cat ON stock_ff_balances(catalog_id);
`;

const DEFAULT_LOCATIONS = ["Свой склад", "ФФ"];

let _inited = false;
async function ensureSchema() {
  if (_inited) return;
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    db.exec(SCHEMA);
    // Сиды каталога мест по умолчанию (если пусто).
    const n = await db.prepare("SELECT COUNT(*) AS n FROM stock_ff_locations").get().n;
    if (!n) {
      const ts = nowISO();
      let order = 0;
      for (const name of DEFAULT_LOCATIONS) {
        await db.prepare(
          "INSERT INTO stock_ff_locations(name, sort_order, created_at) VALUES(?, ?, ?)"
        ).run(name, order++, ts);
      }
    }
    ensureAuditTriggers(db); // 🔒 защита от потери данных (грабля #145)
    _inited = true;
  } finally {
    db.close();
  }
}

async function nowISO() {
  return new Date().toISOString();
}

// =====================================================================
//  stock_ff_locations — каталог мест хранения
// =====================================================================

/** Активные (и архив.) места [{id, name, sort_order, archived, created_at}]. */
export async function listLocations({ includeArchived = false } = {}) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const where = includeArchived ? "" : "WHERE archived=0";
    return db
      .prepare(
        `SELECT id, name, sort_order, archived, created_at
           FROM stock_ff_locations ${where}
          ORDER BY archived, sort_order, name`
      )
      .all();
  } finally {
    db.close();
  }
}

/** Добавить место (reactivates если было archived). Возвращает {id, name}. */
export async function addLocation(name) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const n = String(name || "").trim().slice(0, 200);
    if (!n) throw new Error("name не может быть пустым");
    const ts = nowISO();
    const maxOrder = await db.prepare("SELECT MAX(sort_order) AS m FROM stock_ff_locations").get().m || 0;
    // INSERT OR IGNORE + реактивация archived.
    await db.prepare(
      `INSERT OR IGNORE INTO stock_ff_locations(name, sort_order, archived, created_at) VALUES(?, ?, 0, ?)`
    ).run(n, maxOrder + 1, ts);
    await db.prepare(
      `UPDATE stock_ff_locations SET archived=0, sort_order=CASE WHEN sort_order=0 THEN ? ELSE sort_order END WHERE name=?`
    ).run(maxOrder + 1, n);
    return await db.prepare("SELECT id, name FROM stock_ff_locations WHERE name=?").get(n);
  } finally {
    db.close();
  }
}

/** Переименовать место (каскадно синхронизируется в balances по FK). */
export async function renameLocation(id, name) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const n = String(name || "").trim().slice(0, 200);
    if (!n) throw new Error("name не может быть пустым");
    await db.prepare("UPDATE stock_ff_locations SET name=? WHERE id=?").run(n, Number(id));
    return await db.prepare("SELECT id, name FROM stock_ff_locations WHERE id=?").get(Number(id));
  } finally {
    db.close();
  }
}

/** Soft-delete места (archived=1) — история снапшотов не портится. */
export async function archiveLocation(id) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const r = await db.prepare("UPDATE stock_ff_locations SET archived=1 WHERE id=?").run(Number(id));
    return (r.changes || 0) > 0;
  } finally {
    db.close();
  }
}

// =====================================================================
//  stock_ff_snapshots + balances — чтение
// =====================================================================

/**
 * Ближайший снапшот <= asOfDate (как баланс грузит ближайший). Если дата
 * не задана — последний. Возвращает {snapshot, balances, locations, totals} или
 * {snapshot:null,...} если данных нет.
 */
export async function getSnapshotAt(asOfDate) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    let snap = null;
    if (asOfDate) {
      snap = await db
        .prepare(
          "SELECT id, as_of_date, note, created_at FROM stock_ff_snapshots WHERE as_of_date <= ? ORDER BY as_of_date DESC LIMIT 1"
        )
        .get(asOfDate);
    } else {
      snap = await db
        .prepare("SELECT id, as_of_date, note, created_at FROM stock_ff_snapshots ORDER BY as_of_date DESC LIMIT 1")
        .get();
    }
    if (!snap) return { snapshot: null, balances: [], locations: listLocations({ includeArchived: false }) };

    const balances = await db
      .prepare(
        `SELECT b.id, b.as_of_date, b.catalog_id, b.location_id, b.qty, b.unit_cost, b.created_at
           FROM stock_ff_balances b
          WHERE b.as_of_date = ?
          ORDER BY b.location_id, b.catalog_id`
      )
      .all(snap.as_of_date);

    return {
      snapshot: snap,
      balances,
      locations: listLocations({ includeArchived: false }),
    };
  } finally {
    db.close();
  }
}

/** История totals по всем датам снапшотов (для графика). */
export async function historyTotals() {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT s.as_of_date AS date,
                COUNT(b.id) AS rows,
                SUM(b.qty) AS qty_total,
                ROUND(SUM(b.qty * COALESCE(b.unit_cost, 0)), 2) AS value_total
           FROM stock_ff_snapshots s
           LEFT JOIN stock_ff_balances b ON b.as_of_date = s.as_of_date
          GROUP BY s.as_of_date
          ORDER BY s.as_of_date`
      )
      .all();
  } finally {
    db.close();
  }
}

// =====================================================================
//  POST — replace balances на дату
// =====================================================================

/**
 * Заменяет ВСЕ balances на as_of_date пришедшим массивом.
 * Создаёт snapshot-заголовок если его нет.
 * balances: [{catalog_id, location_id, qty, unit_cost}].
 * Возвращает обновлённый snapshot.
 */
export async function replaceBalances(as_of_date, balances, note) {
  ensureSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(as_of_date)) {
    throw new Error("as_of_date должна быть YYYY-MM-DD");
  }
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    db.exec("PRAGMA foreign_keys=ON;");
    db.exec("BEGIN");
    try {
      // Upsert заголовка снапшота.
      const ts = nowISO();
      await db.prepare(
        `INSERT INTO stock_ff_snapshots(as_of_date, note, created_at) VALUES(?, ?, ?)
         ON CONFLICT(as_of_date) DO UPDATE SET note=excluded.note`
      ).run(as_of_date, note ? String(note).slice(0, 1000) : null, ts);
      // Чистим старые balances этой даты и вставляем новые.
      await db.prepare("DELETE FROM stock_ff_balances WHERE as_of_date=?").run(as_of_date);
      const ins = await db.prepare(
        `INSERT INTO stock_ff_balances(as_of_date, catalog_id, location_id, qty, unit_cost, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`
      );
      for (const b of balances || []) {
        const cat = Number(b.catalog_id);
        const loc = Number(b.location_id);
        const qty = Number(b.qty);
        if (!Number.isFinite(cat) || cat <= 0) continue;
        if (!Number.isFinite(loc) || loc <= 0) continue;
        if (!Number.isFinite(qty)) continue;
        const unit_cost = b.unit_cost == null || b.unit_cost === "" ? null : Number(b.unit_cost);
        ins.run(
          as_of_date,
          cat,
          loc,
          qty,
          Number.isFinite(unit_cost) ? unit_cost : null,
          ts
        );
      }
      db.exec("COMMIT");
    } catch (inner) {
      try { db.exec("ROLLBACK"); } catch { /* уже откатилось */ }
      throw inner;
    }
    return db
      .prepare("SELECT id, as_of_date, note, created_at FROM stock_ff_snapshots WHERE as_of_date=?")
      .get(as_of_date);
  } finally {
    db.close();
  }
}

export { FIN_DB_PATH };
