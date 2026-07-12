// Управление оповещениями (notifications) — дашборд-owned RW в agent_memory.db.
// Образец: lib/contentDb.js. Таблица notifications создаётся здесь же (идемпотентно).
//
// Оповещения пишут УТРЕННИЙ БРИФИНГ и другие автоматизации, когда находят
// триггерные ситуации: плохой отзыв, кассовый разрыв, падение рейтинга, блокировка
// карточки и т.п. Карточка на главной + страница /alerts + бейдж «новые» в Nav.


const MEMORY_DB = process.env.MEMORY_DB_PATH || "/opt/agentsDB/agent_memory.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    level        TEXT NOT NULL DEFAULT 'warn',   -- crit | warn | info
    source       TEXT,                            -- morning_brief | reviews | agent:<key>
    category     TEXT,                            -- bad_review | rating_drop | cash_gap | card_blocked | ...
    title        TEXT,
    message      TEXT,
    ref          TEXT,                            -- ссылка/контекст (nm_id, review_id, ...)
    read         INTEGER NOT NULL DEFAULT 0,      -- 0=новое, 1=прочитано
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, ts);
`;

let _db = null;

/** RW-синглтон к agent_memory.db + создание схемы (идемпотентно). */
export async function getNotificationsDb() {
  if (_db) return _db;
  _db = new DatabaseSync(MEMORY_DB, { readOnly: false });
  _db.exec("PRAGMA journal_mode=WAL;");
  _db.exec("PRAGMA busy_timeout=5000;");
  _db.exec(SCHEMA);
  return _db;
}

const nowISO = () => new Date().toISOString();

/** Список оповещений. Параметры: limit (50 по умолч), unreadOnly, level, source. */
export async function listNotifications({ limit = 100, unreadOnly = false, level = null, source = null } = {}) {
  const db = getNotificationsDb();
  let where = [];
  const args = [];
  if (unreadOnly) { where.push("read=0"); }
  if (level) { where.push("level=?"); args.push(level); }
  if (source) { where.push("source=?"); args.push(source); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  return db
    .prepare(`SELECT id, ts, level, source, category, title, message, ref, read, created_at
              FROM notifications ${whereSql} ORDER BY ts DESC LIMIT ?`)
    .all(...args, limit);
}

/** Кол-во непрочитанных (для бейджа в навигации). */
export async function unreadCount() {
  const db = getNotificationsDb();
  const r = await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE read=0").get();
  return r ? r.c : 0;
}

/** Создать оповещение. Возвращает id. */
export async function addNotification({ level = "warn", source = null, category = null,
                                   title = "", message = "", ref = null } = {}) {
  const db = getNotificationsDb();
  const ts = nowISO();
  const r = await db.prepare(
    "INSERT INTO notifications(ts, level, source, category, title, message, ref, read, created_at) " +
      "VALUES(?,?,?,?,?,?,?, 0, ?)"
  ).run(ts, level, source, category, String(title || "").slice(0, 200),
        String(message || "").slice(0, 2000), ref ? String(ref) : null, ts);
  return r.lastInsertRowid || null;
}

/** Пометить прочитанным (read=1). */
export async function markRead(id) {
  const db = getNotificationsDb();
  await db.prepare("UPDATE notifications SET read=1 WHERE id=?").run(Number(id));
  return true;
}

/** Пометить ВСЕ прочитанными. */
export async function markAllRead() {
  const db = getNotificationsDb();
  await db.prepare("UPDATE notifications SET read=1 WHERE read=0").run();
  return true;
}

/** Удалить оповещение. */
export async function deleteNotification(id) {
  const db = getNotificationsDb();
  await db.prepare("DELETE FROM notifications WHERE id=?").run(Number(id));
  return true;
}

export { MEMORY_DB as NOTIFICATIONS_DB_PATH };
