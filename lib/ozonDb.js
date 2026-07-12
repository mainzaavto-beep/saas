// Подключение к базе Ozon (ozon_data.db) — ТОЛЬКО НА ЧТЕНИЕ для чат-агента.
// Базу наполняет collector_ozon (внутри data-presenter-agent); мы её не меняем.
// Путь берётся из системной переменной OZON_DB_PATH.
//
// Singleton (как lib/db.js для WB) — RO-чтение в чате/аналитике не требует
// свежего соединения на каждый запрос.
//
// ОБРАЗЕЦ: lib/db.js (WB). Для RW-операций есть отдельные route.js.


const DB_PATH =
  process.env.OZON_DB_PATH ||
  "/opt/agentsDB/ozon_data.db";

let _db = null;

export async function getOzonDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH, { readOnly: true });
  }
  return _db;
}

export { DB_PATH as OZON_DB_PATH };
