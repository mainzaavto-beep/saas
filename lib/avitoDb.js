// Подключение к базе Авито (avito_data.db) — ТОЛЬКО НА ЧТЕНИЕ для чат-агента.
// Базу наполняет Avito-agent (C:\Agents\Avito-agent\collect.py); мы её не меняем.
// Путь берётся из системной переменной AVITO_DB_PATH.
//
// Singleton (как lib/db.js для WB).
//
// ОБРАЗЕЦ: lib/db.js (WB). Для RW-операций (proposals) — отдельный маршрут.


const DB_PATH =
  process.env.AVITO_DB_PATH ||
  "/opt/agentsDB/avito_data.db";

let _db = null;

export async function getAvitoDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH, { readOnly: true });
  }
  return _db;
}

export { DB_PATH as AVITO_DB_PATH };
