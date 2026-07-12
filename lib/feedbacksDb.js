// Подключение к feedbacks (wb_data.db) — RW (менеджер правит status/draft_reply).
// Образец: lib/notificationsDb.js. Таблица feedbacks наполняется сборщиком
// collector_wb/wb_feedbacks.py. Управление менеджером из дашборда: статус,
// черновик ответа. Сам текст ответа генерит GLM (glm-4.6, правило #181).


const WB_DB = process.env.WB_DB_PATH || "/opt/agentsDB/wb_data.db";

// Схема feedbacks (дублирует DDL из collector_wb/db.py — чтобы дашборд работал
// даже ДО первого прогона сборщика; CREATE TABLE IF NOT EXISTS идемпотентен).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedbacks (
    id            TEXT PRIMARY KEY,
    nm_id         INTEGER,
    imt_id        INTEGER,
    rating        INTEGER,
    text          TEXT,
    author        TEXT,
    created_at    TEXT,
    was_answered  INTEGER DEFAULT 0,
    wb_answer     TEXT,
    product       TEXT,
    status        TEXT DEFAULT 'new',
    draft_reply   TEXT,
    replied_at    TEXT,
    updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_nm ON feedbacks(nm_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_rating ON feedbacks(rating, created_at);
`;

let _db = null;

/** RW-синглтон к wb_data.db для правок feedbacks (status/draft_reply).
 *  ВНИМАНИЕ: это та же БД, что lib/db.js открывает RO — открываем отдельным
 *  RW-соединением только для управления отзывами (изолированно от чат-чтения). */
export async function getFeedbacksDb() {
  if (_db) return _db;
  _db = new DatabaseSync(WB_DB, { readOnly: false });
  _db.exec("PRAGMA journal_mode=WAL;");
  _db.exec("PRAGMA busy_timeout=5000;");
  _db.exec(SCHEMA); // идемпотентно: таблица создаётся, если ещё нет
  return _db;
}

/** Список отзывов с фильтрами. Параметры:
 *  rating (мин), nm, status, unansweredOnly, limit, sort. */
export async function listFeedbacks({
  rating = null, nm = null, status = null,
  unansweredOnly = false, limit = 200, sort = "recent",
} = {}) {
  const db = getFeedbacksDb();
  const where = [];
  const args = [];
  if (rating != null) { where.push("rating <= ?"); args.push(Number(rating)); }
  if (nm) { where.push("nm_id = ?"); args.push(Number(nm)); }
  if (status) { where.push("status = ?"); args.push(status); }
  if (unansweredOnly) { where.push("was_answered = 0"); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const order = sort === "rating" ? "rating ASC, created_at DESC" : "created_at DESC";
  return db
    .prepare(`SELECT id, nm_id, imt_id, rating, text, author, created_at,
                     was_answered, wb_answer, product, status, draft_reply, replied_at
              FROM feedbacks ${whereSql} ORDER BY ${order} LIMIT ?`)
    .all(...args, limit);
}

/** Один отзыв по id. */
export async function getFeedback(id) {
  const db = getFeedbacksDb();
  return db
    .prepare("SELECT id, nm_id, imt_id, rating, text, author, created_at, was_answered, wb_answer, product, status, draft_reply, replied_at FROM feedbacks WHERE id=?")
    .get(String(id));
}

/** Сохранить черновик ответа + сменить статус. */
export async function setDraftReply(id, draftText, status = "draft") {
  const db = getFeedbacksDb();
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE feedbacks SET draft_reply=?, status=?, updated_at=? WHERE id=?"
  ).run(String(draftText || "").slice(0, 4000), status, now, String(id));
  return true;
}

/** Сменить статус (new/draft/answered/ignored). */
export async function setStatus(id, status) {
  const db = getFeedbacksDb();
  const now = new Date().toISOString();
  const repliedAt = status === "answered" ? now : null;
  await db.prepare("UPDATE feedbacks SET status=?, replied_at=COALESCE(?,replied_at), updated_at=? WHERE id=?")
    .run(status, repliedAt, now, String(id));
  return true;
}

/** Сводка по статусам (для шапки страницы). */
export async function feedbackStats() {
  const db = getFeedbacksDb();
  const total = await db.prepare("SELECT COUNT(*) AS c FROM feedbacks").get().c;
  const unanswered = await db.prepare("SELECT COUNT(*) AS c FROM feedbacks WHERE was_answered=0").get().c;
  const lowRating = await db.prepare("SELECT COUNT(*) AS c FROM feedbacks WHERE rating <= 2").get().c;
  const drafts = await db.prepare("SELECT COUNT(*) AS c FROM feedbacks WHERE status='draft'").get().c;
  return { total, unanswered, lowRating, drafts };
}
