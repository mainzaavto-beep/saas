
// =====================================================================
//  lib/dbAudit.js — универсальная защита от потери данных (заявка 2026-06-25).
//
//  Принцип: для каждой редактируемой таблицы вешаем SQLite-триггеры
//  BEFORE UPDATE / BEFORE DELETE, которые копируют СТАРУЮ (перезаписываемую
//  или удаляемую) версию строки в теневую таблицу <table>_audit. Так ЛЮБАЯ
//  перезапись (UPSERT ON CONFLICT DO UPDATE) или удаление (HARD DELETE)
//  оставляет recoverable-копию с таймстемпом — её можно восстановить.
//
//  Защита на СЛОЕ SQLITE (а не приложения): write-path разбросан по ~16
//  файлов без единого choke-point. Триггеры ловят ВСЕ записи автоматически,
//  независимо от того, кто пишет (route, lib, будущий код). Это — единственный
//  способ гарантировать, что мой smoke-тест или ошибка не убьют данные.
//
//  Триггер инцидента 2026-06-25: владелец сохранил снапшот баланса со своими
//  счетами/вложениями, мой smoke-POST на ту же дату (ON CONFLICT DO UPDATE)
//  молча перезаписал их. Данные потеряны безвозвратно (WAL нет). С этим
//  механизмом старая версия легла бы в balance_snapshot_audit и её можно
//  было бы восстановить одной командой. Грабля #145.
//
//  Колонки динамические: схема строится через PRAGMA table_info(<table>) —
//  не хардкодим схему каждой таблицы, покрытие автоматически подхватывает
//  новые таблицы/колонки.
// =====================================================================

// Все таблицы fin_data.db, в которые дашборд пишет user-data (заявка 2026-06-25).
// Если добавится новая редактируемая таблица — просто дописать сюда.
export const AUDITED_TABLES = [
  "balance_snapshot",
  "balance_accounts",
  "balance_receivables",
  "balance_account_catalog",
  "purchases",
  "purchase_payments",
  "self_buyouts",
  "opex",
  "sales_plan",
  "plan_targets",
  "purchase_plan",
  "dds_movements",
  "cost_overrides",
  "item_groups",
  "item_group_members",
  "item_status",
  "products_catalog",
  "products_catalog_skus",
  "stock_ff_snapshots",
  "stock_ff_balances",
  "stock_ff_locations",
  // Перемещения между складами WB (контракт realloc, 2026-07-03): заявки,
  // которые владелец создаёт в дашборде после подачи в кабинет WB. RW-таблица.
  "wb_realloc_requests",
];

let _inited = new WeakSet(); // по объекту db — один раз на соединение

/**
 * Идемпотентно: создаёт _audit-таблицы + триггеры для указанных таблиц.
 * Безопасно вызывать на каждом открытии соединения (кэш по объекту db).
 *
 * @param {DatabaseSync} db — открытое RW-соединение с fin_data.db.
 * @param {string[]} [tables] — список таблиц (по умолчанию AUDITED_TABLES).
 * @param {{force?: boolean}} [opts] — force=true игнорирует кэш (пересоздаёт
 *   триггеры + синхронизирует колонки). Нужен после миграции схемы (ALTER TABLE),
 *   когда в основную таблицу добавлены колонки, которых ещё нет в _audit.
 */
export async function ensureAuditTriggers(db, tables = AUDITED_TABLES, opts = {}) {
  if (!opts.force && _inited.has(db)) return;
  for (const table of tables) {
    _ensureOne(db, table);
  }
  _inited.add(db);
}

async function _ensureOne(db, table) {
  // Проверяем, что основная таблица существует (новые БД/таблицы могут ещё не быть созданы).
  const mainExists = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
  if (!mainExists) return; // таблицы нет → пропускаем (ensureSchema создаст позже, триггеры повесятся при следующем getFinDb)

  const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.length) return;
  const colNames = cols.map((c) => c.name);
  const colList = colNames.join(", ");
  const oldColList = colNames.map((c) => `OLD.${c}`).join(", ");

  // 1. Теневая таблица <table>_audit: те же колонки + audit-метаданные.
  //    Аналог schema основной таблицы (без PK-ограничений — копии накапливаются).
  const auditTable = `${table}_audit`;
  const colDefs = cols.map((c) => `"${c.name}" ${c.type}`).join(", ");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${auditTable} (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_op TEXT NOT NULL,
      audit_ts TEXT NOT NULL,
      ${colDefs}
    );
    CREATE INDEX IF NOT EXISTS idx_${auditTable}_ts ON ${auditTable}(audit_ts DESC);
  `);

  // 1б. СИНХРОНИЗАЦИЯ колонок: если в основную таблицу позже добавили колонки
  //     (миграция схемы), в _audit-таблице их ещё нет → триггер упадёт. Поэтому
  //     при каждом вызове добавляем недостающие (idempotent ALTER через PRAGMA).
  //     Без этого миграция схемы ЛОМАЛА бы аудит (грабля 2026-06-25: после ALTER
  //     opex +counterparty/op_date триггер BEFORE UPDATE падал с 'no such column').
  const auditCols = await db.prepare(`PRAGMA table_info(${auditTable})`).all().map((c) => c.name);
  for (const c of cols) {
    if (!auditCols.includes(c.name)) {
      db.exec(`ALTER TABLE ${auditTable} ADD COLUMN "${c.name}" ${c.type}`);
    }
  }

  // 2. Триггеры BEFORE UPDATE / BEFORE DELETE — копируют СТАРУЮ версию.
  //    Идемпотентно: DROP TRIGGER IF EXISTS + CREATE.
  //    Пересоздаём всегда (колонки могли измениться) — это дёшево.
  //    Почему BEFORE, а не AFTER: BEFORE срабатывает ДО изменения, OLD содержит
  //    исходную (ещё не перезаписанную) строку — это то, что мы хотим сохранить.
  db.exec(`
    DROP TRIGGER IF EXISTS ${table}_audit_update;
    CREATE TRIGGER ${table}_audit_update
    BEFORE UPDATE ON ${table}
    FOR EACH ROW BEGIN
      INSERT INTO ${auditTable} (audit_op, audit_ts, ${colList})
      VALUES ('UPDATE', datetime('now'), ${oldColList});
    END;
    DROP TRIGGER IF EXISTS ${table}_audit_delete;
    CREATE TRIGGER ${table}_audit_delete
    BEFORE DELETE ON ${table}
    FOR EACH ROW BEGIN
      INSERT INTO ${auditTable} (audit_op, audit_ts, ${colList})
      VALUES ('DELETE', datetime('now'), ${oldColList});
    END;
  `);
}

/**
 * Список аудита-записей для таблицы (для UI «история изменений»).
 * @returns {Array} последние N строк из <table>_audit (по умолчанию 50).
 */
export async function listAudit(db, table, limit = 50) {
  const auditTable = `${table}_audit`;
  const exists = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(auditTable);
  if (!exists) return [];
  return db
    .prepare(`SELECT * FROM ${auditTable} ORDER BY audit_id DESC LIMIT ?`)
    .all(limit);
}

/**
 * Восстановить конкретную версию из аудита в основную таблицу.
 * Логика: INSERT OR REPLACE по PK (перезаписывает текущую строку той версией,
 * что лежит в аудите). Сама эта перезапись тоже попадёт в аудит (RECOVER-метку
 * не ставим намеренно — восстановление это осознанное действие, но след
 * остаётся для честности истории).
 *
 * @returns {boolean} true если восстановлено.
 */
export async function recoverAudit(db, table, auditId) {
  const auditTable = `${table}_audit`;
  const exists = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(auditTable);
  if (!exists) return false;

  const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.length) return false;
  const pk = cols.filter((c) => c.pk).map((c) => c.name);
  const colNames = cols.map((c) => c.name);

  const row = await db.prepare(`SELECT * FROM ${auditTable} WHERE audit_id=?`).get(auditId);
  if (!row) return false;

  const vals = colNames.map((c) => row[c]);
  // INSERT OR REPLACE: если PK совпадает — перезапишет (старое попадёт в audit через триггер).
  // Если PK — автоинкремент и строки уже нет — вставит новую.
  if (pk.length) {
    const setClause = colNames.map((c) => `"${c}"`).join(", ");
    const placeholders = colNames.map(() => "?").join(", ");
    await db.prepare(
      `INSERT OR REPLACE INTO ${table} (${setClause}) VALUES (${placeholders})`
    ).run(...vals);
  } else {
    // Нет явного PK — обычный INSERT (новая строка).
    const setClause = colNames.map((c) => `"${c}"`).join(", ");
    const placeholders = colNames.map(() => "?").join(", ");
    await db.prepare(`INSERT INTO ${table} (${setClause}) VALUES (${placeholders})`).run(...vals);
  }
  return true;
}
