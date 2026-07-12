import { ensureAuditTriggers } from "./dbAudit";

// =====================================================================
//  lib/finItems.js — справочники и переопределения ТОВАРОВ в fin_data.db.
//
//  3 таблицы, которыми ВЛАДЕЕТ data-presenter (как sales_plan/plan_targets):
//    cost_overrides     — себестоимость с датой начала (история поставок)
//    item_groups        — справочник групп товаров (имя, уникальное)
//    item_group_members — привязка SKU к группе (platform+nm_id/product_id)
//    item_status        — активный/неактивный (1 строка на SKU)
//
//  ГРАНИЦА ЗАПИСИ (правило 6 + DATA_CONTRACT): data-presenter пишет
//  ТОЛЬКО в эти 3 таблицы + sales_plan/plan_targets. Базовый cost в
//  wb_data/ozon_data.db.cogs (сборщика) — НЕ ТРОГАЕМ, он RO-fallback.
//
//  Образец: lib/finDb.js. Открываем/закрываем connection на каждый вызов
//  (для RW безопаснее, чем singleton — нет гонок между запросами).
// =====================================================================

// fin_data.db перенесён в C:\AgentsDB\ 2026-06-24 (как все боевые БД). Env перекрывает.
const FIN_DB_PATH = process.env.FIN_DB_PATH || "/opt/agentsDB/fin_data.db";

const SCHEMA = `
-- nm_id/product_id: NOT NULL DEFAULT 0. Для WB product_id=0, для Ozon nm_id=0.
-- Это позволяет plain UNIQUE(platform, nm_id, product_id, ...) работать
-- (выражения в UNIQUE-констрейнте SQLite запрещены, поэтому без COALESCE).
CREATE TABLE IF NOT EXISTS cost_overrides (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    platform       TEXT NOT NULL,
    nm_id          INTEGER NOT NULL DEFAULT 0,
    product_id     INTEGER NOT NULL DEFAULT 0,
    cost           REAL NOT NULL,
    effective_from TEXT NOT NULL,
    note           TEXT,
    created_at     TEXT NOT NULL,
    UNIQUE(platform, nm_id, product_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_cost_overrides_sku ON cost_overrides(platform, nm_id, product_id, effective_from);

CREATE TABLE IF NOT EXISTS item_groups (
    id         INTEGER PRIMARY KEY,
    name       TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_group_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL REFERENCES item_groups(id) ON DELETE CASCADE,
    platform   TEXT NOT NULL,
    nm_id      INTEGER NOT NULL DEFAULT 0,
    product_id INTEGER NOT NULL DEFAULT 0,
    UNIQUE(platform, nm_id, product_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_igm_sku ON item_group_members(platform, nm_id, product_id);

CREATE TABLE IF NOT EXISTS item_status (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    platform   TEXT NOT NULL,
    nm_id      INTEGER NOT NULL DEFAULT 0,
    product_id INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'active',
    updated_at TEXT NOT NULL,
    UNIQUE(platform, nm_id, product_id)
);
`;

// Инициализация схемы при первом обращении (idempotent).
let _inited = false;
async function ensureSchema() {
  if (_inited) return;
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec(SCHEMA);
    ensureAuditTriggers(db); // 🔒 защита от потери данных (грабля #145)
    _inited = true;
  } finally {
    db.close();
  }
}

async function nowISO() {
  return new Date().toISOString();
}

/** Имя той колонки, что хранит реальный ID SKU (для WHERE по одному полю). */
async function skuCol(platform) {
  return String(platform) === "ozon" ? "product_id" : "nm_id";
}

/** Числовое значение ID SKU (0 если не задано). */
async function skuVal(platform, nmId, productId) {
  return (String(platform) === "ozon" ? Number(productId) : Number(nmId)) || 0;
}

// =====================================================================
//  cost_overrides
// =====================================================================

/**
 * Актуальная себестоимость-override на дату D (или на сегодня).
 * Возвращает {cost, effective_from, note} или null если override нет.
 */
export async function getCostOverride(platform, nmId, productId, onDate) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const d = onDate || new Date().toISOString().slice(0, 10);
    const col = skuCol(platform);
    const v = (String(platform) === "ozon" ? Number(productId) : Number(nmId)) || 0;
    return (
      db
        .prepare(
          `SELECT cost, effective_from, note FROM cost_overrides
            WHERE platform=? AND ${col}=? AND effective_from <= ?
            ORDER BY effective_from DESC LIMIT 1`
        )
        .get(String(platform), v, d) || null
    );
  } finally {
    db.close();
  }
}

/**
 * Вся история override'ов по SKU (для детализации). От новых к старым.
 */
export async function listCostOverrides(platform, nmId, productId) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const col = skuCol(platform);
    const v = (String(platform) === "ozon" ? Number(productId) : Number(nmId)) || 0;
    return db
      .prepare(
        `SELECT id, cost, effective_from, note, created_at FROM cost_overrides
          WHERE platform=? AND ${col}=?
          ORDER BY effective_from DESC`
      )
      .all(String(platform), v);
  } finally {
    db.close();
  }
}

/**
 * Upsert override. Если запись с тем же (sku, effective_from) есть —
 * обновляет cost/note, иначе вставляет новую (история поставок копится).
 */
export async function upsertCostOverride({ platform, nm_id, product_id, cost, effective_from, note }) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const col = skuCol(platform);
    const v = (String(platform) === "ozon" ? Number(product_id) : Number(nm_id)) || 0;
    const ts = nowISO();
    await db.prepare(
      `INSERT INTO cost_overrides(platform, ${col}, cost, effective_from, note, created_at)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, nm_id, product_id, effective_from)
       DO UPDATE SET cost=excluded.cost, note=excluded.note`
    ).run(String(platform), v, Number(cost), String(effective_from), note ? String(note) : null, ts);
    return getCostOverride(platform, nm_id, product_id, effective_from);
  } finally {
    db.close();
  }
}

// =====================================================================
//  item_groups + item_group_members
// =====================================================================

/** Все группы {id, name}. */
export async function listGroups() {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, name FROM item_groups ORDER BY name")
      .all();
  } finally {
    db.close();
  }
}

/** Создать группу по имени. Возвращает {id, name}. */
export async function createGroup(name) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const ts = nowISO();
    // INSERT OR IGNORE + потом SELECT — чтобы вернуть id даже если уже было.
    await db.prepare("INSERT OR IGNORE INTO item_groups(name, created_at) VALUES(?, ?)").run(
      String(name).trim(),
      ts
    );
    return await db.prepare("SELECT id, name FROM item_groups WHERE name=?").get(String(name).trim());
  } finally {
    db.close();
  }
}

/** Группа SKU (1 группа на SKU) или null. */
export async function getGroupOf(platform, nmId, productId) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const col = skuCol(platform);
    const v = skuVal(platform, nmId, productId);
    return (
      db
        .prepare(
          `SELECT g.id, g.name FROM item_group_members m
            JOIN item_groups g ON g.id = m.group_id
           WHERE m.platform=? AND m.${col}=? LIMIT 1`
        )
        .get(String(platform), v) || null
    );
  } finally {
    db.close();
  }
}

/** Карта group_id → имя для bulk-обогащения списка. */
export async function groupsById() {
  const list = listGroups();
  const m = {};
  for (const g of list) m[g.id] = g.name;
  return m;
}

/** Карта (platform|nmId|productId) → group_id для bulk-обогащения. */
export async function membersMap() {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const rows = await db
      .prepare("SELECT platform, nm_id, product_id, group_id FROM item_group_members")
      .all();
    const m = {};
    for (const r of rows) {
      const key = `${r.platform}|${r.nm_id || 0}|${r.product_id || 0}`;
      m[key] = r.group_id;
    }
    return m;
  } finally {
    db.close();
  }
}

/**
 * Привязать SKU к группе (1 группа на SKU — перезаписывает предыдущую).
 */
export async function assignGroup({ platform, nm_id, product_id, group_id }) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const col = skuCol(platform);
    const v = skuVal(platform, nm_id, product_id);
    // Удаляем старую привязку этого SKU (если была), вставляем новую.
    db.exec("BEGIN");
    try {
      await db.prepare(`DELETE FROM item_group_members WHERE platform=? AND ${col}=?`).run(
        String(platform),
        v
      );
      await db.prepare(
        `INSERT INTO item_group_members(group_id, platform, ${col}) VALUES(?, ?, ?)`
      ).run(Number(group_id), String(platform), v);
      db.exec("COMMIT");
    } catch (inner) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* уже откатилось */
      }
      throw inner;
    }
    return getGroupOf(platform, nm_id, product_id);
  } finally {
    db.close();
  }
}

/** Отвязать SKU от любой группы. */
export async function unassignGroup(platform, nmId, productId) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    const col = skuCol(platform);
    const v = skuVal(platform, nmId, productId);
    await db.prepare(`DELETE FROM item_group_members WHERE platform=? AND ${col}=?`).run(
      String(platform),
      v
    );
    return true;
  } finally {
    db.close();
  }
}

// =====================================================================
//  item_status
// =====================================================================

/** Статус SKU или {status:'active'} по умолчанию. */
export async function getStatus(platform, nmId, productId) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const col = skuCol(platform);
    const v = skuVal(platform, nmId, productId);
    return (
      db
        .prepare(`SELECT status FROM item_status WHERE platform=? AND ${col}=?`)
        .get(String(platform), v) || { status: "active" }
    );
  } finally {
    db.close();
  }
}

/** Карта (platform|nmId|productId) → status для bulk-обогащения. */
export async function statusMap() {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const rows = await db.prepare("SELECT platform, nm_id, product_id, status FROM item_status").all();
    const m = {};
    for (const r of rows) {
      const key = `${r.platform}|${r.nm_id || 0}|${r.product_id || 0}`;
      m[key] = r.status;
    }
    return m;
  } finally {
    db.close();
  }
}

/** Установить статус SKU. */
export async function setStatus({ platform, nm_id, product_id, status }) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const col = skuCol(platform);
    const v = skuVal(platform, nm_id, product_id);
    const st = status === "inactive" ? "inactive" : "active";
    const ts = nowISO();
    await db.prepare(
      `INSERT INTO item_status(platform, ${col}, status, updated_at)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(platform, nm_id, product_id)
       DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
    ).run(String(platform), v, st, ts);
    return getStatus(platform, nm_id, product_id);
  } finally {
    db.close();
  }
}

export { FIN_DB_PATH };

// =====================================================================
//  СЛОЙ РАЗРЕШЕНИЯ COST (единый источник истины для фин.расчётов)
//  resolveCost — ближайший override <= даты, иначе fallback на cogs сборщика.
//  Используется в /api/pnl, /api/plan/fact и (после заявки) в fin_agent.
// =====================================================================

/**
 * Bulk-карта {nm_id|product_id: {cost, source, effective_from, override_id}}
 * актуальной себестоимости на дату onDate. Override имеет приоритет; если override
 * нет для SKU — берётся fallback из cogsMap (передаётся вызывающим, чтобы не открывать
 * wb/ozon БД тут — giữим lib чистым от кросс-БД зависимостей).
 *
 * @param platform 'wb' | 'ozon'
 * @param skuIds числоловые ID (nm_id для wb, product_id для ozon)
 * @param onDate YYYY-MM-DD (по умолч. сегодня)
 * @param cogsMap fallback {id: cost} из cogs сборщика (или {})
 */
export async function resolveCostMap(platform, skuIds, onDate, cogsMap = {}) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  const col = skuCol(platform);
  const d = onDate || new Date().toISOString().slice(0, 10);
  const result = {};
  try {
    for (const idRaw of skuIds) {
      const id = Number(idRaw);
      if (!Number.isFinite(id) || id <= 0) continue;
      const ov = await db
        .prepare(
          `SELECT id, cost, effective_from FROM cost_overrides
            WHERE platform=? AND ${col}=? AND effective_from <= ?
            ORDER BY effective_from DESC LIMIT 1`
        )
        .get(String(platform), id, d);
      if (ov) {
        result[id] = {
          cost: ov.cost,
          source: "override",
          effective_from: ov.effective_from,
          override_id: ov.id,
        };
      } else {
        const fb = cogsMap[id];
        result[id] = {
          cost: fb != null ? fb : null,
          source: fb != null ? "cogs" : null,
          effective_from: null,
          override_id: null,
        };
      }
    }
    return result;
  } finally {
    db.close();
  }
}

/** Все override'ы SKU (для истории/детализации). От новых к старым. */
export async function listCostOverridesBySku(platform, nmId, productId) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const col = skuCol(platform);
    const v = skuVal(platform, nmId, productId);
    return db
      .prepare(
        `SELECT id, cost, effective_from, note, created_at FROM cost_overrides
          WHERE platform=? AND ${col}=?
          ORDER BY effective_from DESC`
      )
      .all(String(platform), v);
  } finally {
    db.close();
  }
}

/** Правка существующей записи истории (по PK id). */
export async function updateCostOverride(id, { cost, effective_from, note }) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const sets = [];
    const vals = [];
    if (cost != null && Number.isFinite(Number(cost))) {
      sets.push("cost=?");
      vals.push(Number(cost));
    }
    if (effective_from && /^\d{4}-\d{2}-\d{2}$/.test(effective_from)) {
      sets.push("effective_from=?");
      vals.push(effective_from);
    }
    if (note !== undefined) {
      sets.push("note=?");
      vals.push(note == null || note === "" ? null : String(note));
    }
    if (sets.length === 0) return getCostOverrideById(id);
    vals.push(Number(id));
    await db.prepare(`UPDATE cost_overrides SET ${sets.join(", ")} WHERE id=?`).run(...vals);
    return getCostOverrideById(id);
  } finally {
    db.close();
  }
}

/** Получить запись override по PK id. */
export async function getCostOverrideById(id) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT id, platform, nm_id, product_id, cost, effective_from, note, created_at FROM cost_overrides WHERE id=?"
        )
        .get(Number(id)) || null
    );
  } finally {
    db.close();
  }
}

/** Удалить запись override по PK id. Возвращает true если удалено. */
export async function deleteCostOverride(id) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    const r = await db.prepare("DELETE FROM cost_overrides WHERE id=?").run(Number(id));
    return (r.changes || 0) > 0;
  } finally {
    db.close();
  }
}

/**
 * Все override'ы для платформы (для построения per-day карты в /api/pnl).
 * Возвращает [{nm_id|product_id, cost, effective_from}] отсортированные
 * по (id-col, effective_from) — удобно для бинарного поиска/группировки.
 */
export async function listCostOverridesAll(platform) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    const col = skuCol(platform);
    return db
      .prepare(
        `SELECT ${col} AS sku_id, cost, effective_from FROM cost_overrides
          WHERE platform=? ORDER BY ${col}, effective_from`
      )
      .all(String(platform));
  } finally {
    db.close();
  }
}

/**
 * Построить функцию-резолвер cost(skuId, dateStr) → число, из списка override'ов
 * и fallback-карты cogs. Override'ы сортируются по дате внутри SKU; для (sku,date)
 * берётся ближайший effective_from <= date; иначе fallback.
 *
 * Используется в /api/pnl и /api/plan/fact для per-day/per-order расчёта COGS.
 * Возвращает функцию, чтобы переиспользовать без повторных запросов к БД.
 */
export async function buildCostResolver(overrides, cogsMap) {
  // Группируем override'ы по sku_id, сортируем по effective_from.
  const bySku = {};
  for (const o of overrides) {
    const id = Number(o.sku_id);
    if (!bySku[id]) bySku[id] = [];
    bySku[id].push({ effective_from: o.effective_from, cost: o.cost });
  }
  for (const id of Object.keys(bySku)) {
    bySku[id].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  }
  return function resolve(skuId, dateStr) {
    const id = Number(skuId);
    const list = bySku[id];
    if (list && list.length) {
      // Бинарный/линейный поиск ближайшего effective_from <= dateStr.
      // Списки короткие (1-5 записей на SKU), линейный поиск ок.
      let chosen = null;
      for (const o of list) {
        if (o.effective_from <= dateStr) chosen = o;
        else break;
      }
      if (chosen) return { cost: chosen.cost, source: "override" };
    }
    const fb = cogsMap[id];
    return fb != null ? { cost: fb, source: "cogs" } : { cost: null, source: null };
  };
}
