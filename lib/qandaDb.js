// Подключение к feedbacks/questions (wb_data.db + ozon_data.db) — RW (менеджер правит
// status/draft_reply). Единый DB-слой для вкладки «Отзывы/Вопросы» (2026-06-28).
//
// Параметризация по marketplace: WB → WB_DB_PATH, Ozon → OZON_DB_PATH. Каждая операция
// принимает kind ("reviews" | "questions") и marketplace ("wb" | "ozon").
//
// Миграция (ALTER TABLE ADD COLUMN): при открытии БД идемпотентно добавляет недостающие
// колонки модерации/мульти-МП в обе таблицы. DDL в collector_*/db.py — первичный
// (создаёт таблицу), здесь — фолбэк для боевых БД, созданных до миграции.
//
// Таблицы:
//   wb_data.db:    feedbacks (reviews WB), questions (вопросы WB)
//   ozon_data.db:  feedbacks (reviews Ozon), questions (вопросы Ozon)
// Workflow менеджера (status/draft_reply/replied_at) НЕ затирается при пересборах —
// см. upsert в collector_*/db.py.


const WB_DB = process.env.WB_DB_PATH || "/opt/agentsDB/wb_data.db";
const OZON_DB = process.env.OZON_DB_PATH || "/opt/agentsDB/ozon_data.db";

const _dbByPath = new Map();

/** Колонки миграции для feedbacks (обоих МП). Идемпотентно ADD COLUMN. */
const FEEDBACKS_MIGRATION = {
  marketplace: "TEXT DEFAULT 'wb'",
  moderation_state: "TEXT",
  is_hidden: "INTEGER DEFAULT 0",
  was_viewed: "INTEGER DEFAULT 0",
  published_at: "TEXT",
  // Ozon-специфичные:
  product_id: "INTEGER",
  sku: "INTEGER",
  mp_answer: "TEXT",
};

/** Колонки миграции для questions. */
const QUESTIONS_MIGRATION = {
  marketplace: "TEXT DEFAULT 'wb'",
  moderation_state: "TEXT",
  is_warned: "INTEGER DEFAULT 0",
  is_hidden: "INTEGER DEFAULT 0",
  was_viewed: "INTEGER DEFAULT 0",
  answer_editable: "INTEGER DEFAULT 0",
  product_id: "INTEGER",
  sku: "INTEGER",
  mp_answer: "TEXT",
  published_at: "TEXT",
};

/** Открыть RW-синглтон по пути БД + применить миграции колонок. */
async function openDb(dbPath) {
  if (_dbByPath.has(dbPath)) return _dbByPath.get(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: false });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  // Миграция идемпотентна: добавляем недостающие колонки, не падаем если таблицы нет.
  try { migrateTable(db, "feedbacks", FEEDBACKS_MIGRATION); } catch { /* таблицы нет ещё */ }
  try { migrateTable(db, "questions", QUESTIONS_MIGRATION); } catch { /* таблицы нет ещё */ }
  _dbByPath.set(dbPath, db);
  return db;
}

/** Идемпотентно добавляет недостающие колонки (как _migrate_columns в collector db.py). */
async function migrateTable(db, table, columns) {
  const existing = new Set(
    await db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
  );
  for (const [col, sqltype] of Object.entries(columns)) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${sqltype}`);
    }
  }
}

/** Разрешить dbPath по marketplace. */
async function dbPathFor(marketplace) {
  if (marketplace === "ozon") return OZON_DB;
  return WB_DB;
}

/** Колонки для SELECT в зависимости от kind + marketplace. Учитываем асимметрию:
 *  - WB reviews: ответ в `wb_answer` (историческое имя), нет mp_answer.
 *  - Ozon reviews + все questions: ответ в `mp_answer`.
 *  - WB questions: есть nm_id/imt_id/is_warned/answer_editable; Ozon — product_id/sku.
 * Колонки, которых нет в конкретной таблице, исключаем (SELECT упал бы). */
async function selectCols(kind, marketplace) {
  const base = ["id", "marketplace", "created_at", "text", "author",
    "was_answered", "product", "moderation_state", "is_hidden",
    "status", "draft_reply", "replied_at"];
  if (kind === "reviews") {
    if (marketplace === "wb") {
      return ["nm_id", "imt_id", "rating", "wb_answer", "was_viewed", ...base];
    }
    // Ozon reviews: product_id/sku/mp_answer.
    return ["product_id", "sku", "rating", "mp_answer", ...base];
  }
  // questions
  if (marketplace === "wb") {
    return ["nm_id", "imt_id", "mp_answer", "is_warned",
            "answer_editable", "was_viewed", ...base];
  }
  // Ozon questions
  return ["product_id", "sku", "mp_answer", ...base];
}

/** Список записей с фильтрами. kind: reviews|questions, marketplace: wb|ozon. */
export async function listItems(kind, marketplace, opts = {}) {
  const db = openDb(dbPathFor(marketplace));
  const cols = selectCols(kind, marketplace);
  const where = [];
  const args = [];
  const {
    ratingMin = null, ratingMax = null, nm = null, productId = null,
    status = null, unansweredOnly = false, hiddenOnly = false, warnedOnly = false,
    limit = 200, sort = "recent",
  } = opts;
  if (ratingMin != null) { where.push("(rating IS NOT NULL AND rating >= ?)"); args.push(Number(ratingMin)); }
  if (ratingMax != null) { where.push("(rating IS NOT NULL AND rating <= ?)"); args.push(Number(ratingMax)); }
  if (nm) { where.push("nm_id = ?"); args.push(Number(nm)); }
  if (productId) { where.push("product_id = ?"); args.push(Number(productId)); }
  if (status) { where.push("status = ?"); args.push(status); }
  if (unansweredOnly) { where.push("was_answered = 0"); }
  if (hiddenOnly) { where.push("is_hidden = 1"); }
  if (warnedOnly) {
    // is_warned есть только в questions — у reviews фильтр не применим.
    if (kind === "questions") { where.push("is_warned = 1"); }
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const order =
    kind === "reviews" && sort === "rating"
      ? "rating ASC, created_at DESC"
      : "created_at DESC";
  return db
    .prepare(`SELECT ${cols.join(", ")} FROM ${kind === "reviews" ? "feedbacks" : "questions"} ${whereSql} ORDER BY ${order} LIMIT ?`)
    .all(...args, limit);
}

/** Одна запись по id. */
export async function getItem(kind, marketplace, id) {
  const db = openDb(dbPathFor(marketplace));
  const cols = selectCols(kind, marketplace);
  return db
    .prepare(`SELECT ${cols.join(", ")} FROM ${kind === "reviews" ? "feedbacks" : "questions"} WHERE id=?`)
    .get(String(id));
}

/** Сохранить черновик ответа + сменить статус. */
export async function setDraftReply(kind, marketplace, id, draftText, status = "draft") {
  const db = openDb(dbPathFor(marketplace));
  const table = kind === "reviews" ? "feedbacks" : "questions";
  const now = new Date().toISOString();
  await db.prepare(`UPDATE ${table} SET draft_reply=?, status=?, updated_at=? WHERE id=?`)
    .run(String(draftText || "").slice(0, 4000), status, now, String(id));
  return true;
}

/** Сменить статус (new/draft/answered/ignored). */
export async function setStatus(kind, marketplace, id, status) {
  const db = openDb(dbPathFor(marketplace));
  const table = kind === "reviews" ? "feedbacks" : "questions";
  const now = new Date().toISOString();
  const repliedAt = status === "answered" ? now : null;
  await db.prepare(`UPDATE ${table} SET status=?, replied_at=COALESCE(?,replied_at), updated_at=? WHERE id=?`)
    .run(status, repliedAt, now, String(id));
  return true;
}

/** Фиксация публикации ответа на площадке (боевой постинг из route.js). */
export async function setPublished(kind, marketplace, id) {
  const db = openDb(dbPathFor(marketplace));
  const table = kind === "reviews" ? "feedbacks" : "questions";
  const now = new Date().toISOString();
  // published_at + status=answered + replied_at (момент публикации).
  await db.prepare(`UPDATE ${table} SET status='answered', replied_at=?, published_at=?, updated_at=? WHERE id=?`)
    .run(now, now, now, String(id));
  return true;
}

/** Сводка по статусам (для шапки страницы). */
export async function itemStats(kind, marketplace) {
  const db = openDb(dbPathFor(marketplace));
  const table = kind === "reviews" ? "feedbacks" : "questions";
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  const unanswered = await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE was_answered=0`).get().c;
  const hidden = await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE is_hidden=1`).get().c;
  const drafts = await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE status='draft'`).get().c;
  // is_warned есть только в questions (у reviews WB такого поля нет) — считаем осторожно.
  let warned = 0;
  try {
    warned = await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE is_warned=1`).get().c;
  } catch { /* колонки нет (reviews) — warned=0 */ }
  const lowRating = kind === "reviews"
    ? await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE rating <= 2`).get().c
    : null;
  return { total, unanswered, hidden, drafts, warned, lowRating };
}

/** Агрегированная сводка по ОБИМ маркетплейсам (для переключателя «Все»). */
export async function statsAll(kind) {
  let agg = { total: 0, unanswered: 0, hidden: 0, drafts: 0, warned: 0, lowRating: 0 };
  for (const mp of ["wb", "ozon"]) {
    try {
      const s = itemStats(kind, mp);
      agg.total += s.total || 0;
      agg.unanswered += s.unanswered || 0;
      agg.hidden += s.hidden || 0;
      agg.drafts += s.drafts || 0;
      agg.warned += s.warned || 0;
      agg.lowRating += s.lowRating || 0;
    } catch (e) {
      // БД может быть недоступна (нет токена, нет файла) — пропускаем.
    }
  }
  return agg;
}
