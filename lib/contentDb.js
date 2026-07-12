// Подключение к content.db (контент-агента) — RW (дашборд пишет черновики).
// Образец: lib/finDb.js. Путь по умолчанию — папка контент-агента.
//
// Связь с wb_data.db.articles — по content_pieces.sku = articles.nm_id (TEXT).
// Схема content.db: content_pieces, ab_tests, content_requests, brand_decisions
// (см. C:\Agents\Kontent agent\init_db.py).


const CONTENT_DB_PATH =
  process.env.CONTENT_DB_PATH ||
  "/opt/agents/Kontent agent/content.db";

let _db = null;

/** Открыть НОВОЕ RW-соединение с content.db (как finDb — на каждый запрос).
 *  node:sqlite DatabaseSync по умолчанию возвращает объекты с именами колонок. */
export async function getContentDb() {
  return new DatabaseSync(CONTENT_DB_PATH, { readOnly: false });
}

/** Только-чтение синглтон (для списков в дашборде). */
export async function getContentDbRo() {
  if (!_db) {
    _db = new DatabaseSync(CONTENT_DB_PATH, { readOnly: true });
  }
  return _db;
}

export { CONTENT_DB_PATH };
