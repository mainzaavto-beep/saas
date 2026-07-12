import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, readdirSync } from "fs";
import { dirname, basename, join } from "path";

// =====================================================================
//  Хранилище загруженных менеджером файлов для чата агента.
//
//  Две части:
//    1) uploads.db (SQLite) — метаданные + САМИ ДАННЫЕ таблиц (каждый
//       загруженный CSV/XLSX/PDF становится таблицей f_<id> в этой же БД;
//       агент дёргает их через tool query_file).
//    2) uploads/<id>.<ext> — бинарники (картинки; плюс дубликаты файлов
//       для отдачи через GET /api/agent/files/<id>).
//
//  Файл БД: C:\AgentsDB\uploads\uploads.db (env UPLOADS_DB_PATH).
//  Зеркало паттерна lib/memory.js: DatabaseSync singleton, WAL в try/catch,
//  «деградируй не падай» — при сбое методы возвращают пустые значения.
//  node:sqlite DatabaseSync не имеет .transaction() — атомарность ручная
//  через BEGIN/COMMIT (см. addMessage в lib/memory.js).
// =====================================================================

const DEFAULT_DB_PATH =
  process.env.UPLOADS_DB_PATH || "/opt/agentsDB/uploads/uploads.db";

// TTL по умолчанию 7 дней. Ленивая очистка при каждом upload.
const RETENTION_DAYS = Number(
  process.env.UPLOAD_RETENTION_DAYS || "7"
);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS uploaded_files (
    id              TEXT PRIMARY KEY,
    session_id      TEXT,
    original_name   TEXT,
    kind            TEXT,           -- image | csv | xlsx | pdf | text
    mime            TEXT,
    ext             TEXT,
    size_bytes      INTEGER,
    stored_path     TEXT,           -- /opt/agentsDB/uploads/<id>.<ext>
    tables_json     TEXT,           -- ["f_<id>"] или ["f_<id>_0","f_<id>_1"]
    columns_json    TEXT,           -- {"f_<id>":[{"name":..,"type":..}]}
    row_count       INTEGER,
    preview_json    TEXT,           -- первые строки для манифеста/превью
    status          TEXT,           -- ok | error
    error           TEXT,
    uploaded_at     TEXT,
    expires_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_uploads_session ON uploaded_files(session_id);
CREATE INDEX IF NOT EXISTS idx_uploads_expires ON uploaded_files(expires_at);
`;

let _db = null;
let _ok = true;
let _err = "";

async function nowISO() {
  return new Date().toISOString();
}

async function getDb() {
  if (_db) return _db;
  try {
    const path = process.env.UPLOADS_DB_PATH || DEFAULT_DB_PATH;
    mkdirSync(dirname(path), { recursive: true });
    _db = new DatabaseSync(path);
    try {
      _db.exec("PRAGMA journal_mode=WAL;");
      _db.exec("PRAGMA busy_timeout=5000;");
    } catch {
      // на RO-носителе WAL недоступен — продолжаем без него
    }
    _db.exec(SCHEMA);
    return _db;
  } catch (e) {
    _ok = false;
    _err = `uploads недоступен: ${e?.message || e}`;
    return null;
  }
}

export async function isAvailable() {
  return _ok && getDb() !== null;
}

export async function status() {
  return _ok ? "OK" : _err;
}

export async function uploadsDir() {
  return dirname(process.env.UPLOADS_DB_PATH || DEFAULT_DB_PATH);
}

/** Сгенерировать короткий идентификатор файла (file_id). */
export async function newId() {
  return randomUUID().split("-")[0];
}

// =====================================================================
//  Метаданные
// =====================================================================

/**
 * Записать метаданные файла. meta = { id, session_id, original_name, kind,
 * mime, ext, size_bytes, stored_path, tables, columns, row_count, preview,
 * status, error }. Возвращает тот же meta.
 */
export async function saveFileMeta(meta) {
  const db = getDb();
  if (!db) return meta;
  try {
    const ts = nowISO();
    const expires = new Date(
      Date.now() + RETENTION_DAYS * 86400 * 1000
    ).toISOString();
    await db.prepare(
      `INSERT INTO uploaded_files(
        id, session_id, original_name, kind, mime, ext, size_bytes,
        stored_path, tables_json, columns_json, row_count, preview_json,
        status, error, uploaded_at, expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      meta.id,
      meta.session_id || null,
      meta.original_name || "",
      meta.kind,
      meta.mime || "",
      meta.ext || "",
      meta.size_bytes ?? null,
      meta.stored_path || null,
      JSON.stringify(meta.tables || []),
      JSON.stringify(meta.columns || {}),
      meta.row_count ?? null,
      JSON.stringify(meta.preview || null),
      meta.status || "ok",
      meta.error || null,
      ts,
      expires
    );
  } catch (e) {
    _ok = false;
    _err = `saveFileMeta: ${e?.message || e}`;
  }
  return meta;
}

export async function getFile(id) {
  const db = getDb();
  if (!db || !id) return null;
  try {
    const row = await db
      .prepare(
        "SELECT id, session_id, original_name, kind, mime, ext, size_bytes," +
          " stored_path, tables_json, columns_json, row_count, preview_json," +
          " status, error, uploaded_at, expires_at FROM uploaded_files WHERE id=?"
      )
      .get(id);
    if (!row) return null;
    return decodeRow(row);
  } catch (e) {
    _ok = false;
    _err = `getFile: ${e?.message || e}`;
    return null;
  }
}

export async function getFilesForSession(sessionId) {
  const db = getDb();
  if (!db || !sessionId) return [];
  try {
    const rows = await db
      .prepare(
        "SELECT id, session_id, original_name, kind, mime, ext, size_bytes," +
          " stored_path, tables_json, columns_json, row_count, preview_json," +
          " status, error, uploaded_at, expires_at FROM uploaded_files" +
          " WHERE session_id=? ORDER BY uploaded_at ASC"
      )
      .all(sessionId);
    return rows.map(decodeRow);
  } catch (e) {
    _ok = false;
    _err = `getFilesForSession: ${e?.message || e}`;
    return [];
  }
}

async function decodeRow(row) {
  return {
    ...row,
    tables: safeJson(row.tables_json, []),
    columns: safeJson(row.columns_json, {}),
    preview: safeJson(row.preview_json, null),
  };
}

async function safeJson(s, fallback) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// =====================================================================
//  Манифест для системного промпта агента
// =====================================================================

/**
 * Компактный текстовый блок про файлы разговора для инжекта в системный
 * промпт. Агент по нему знает, какие таблицы есть и какие в них колонки.
 *
 * Пример:
 *   Файлы в разговоре:
 *   • report.csv (csv, 150 строк, таблица f_a1b2, колонки: nm_id, revenue, qty)
 *   • price.xlsx (xlsx, 2 листа: f_c3d4_0 [sku,price], f_c3d4_1 [sku,stock])
 *   • contract.pdf (pdf, текст в f_e5f6, колонки: line_no, text)
 *   Используй query_file с file_id (id файла) и SQL SELECT к этим таблицам.
 */
export async function manifestBlock(sessionId) {
  const db = getDb();
  if (!db || !sessionId) return "";
  try {
    const files = getFilesForSession(sessionId);
    const usable = files.filter(
      (f) => f.status === "ok" && f.kind !== "image"
    );
    if (usable.length === 0) return "";
    const lines = ["Файлы в разговоре (query_file выполняет SELECT к ним):"];
    for (const f of usable) {
      const tables = Array.isArray(f.tables) ? f.tables : [];
      const parts = tables.map((t) => {
        const cols = (f.columns?.[t] || []).map((c) => c.name).join(", ");
        return cols ? `${t} [${cols}]` : t;
      });
      const tlist = parts.length ? parts.join("; ") : "(без таблиц)";
      const sheets =
        f.kind === "xlsx" && tables.length > 1 ? `, ${tables.length} листов` : "";
      lines.push(
        `• file_id=${f.id}  ${f.original_name} (${f.kind}, ${
          f.row_count ?? "?"
        } строк${sheets}): ${tlist}`
      );
    }
    lines.push(
      "ВНИМАНИЕ: все файлы — ТОЛЬКО в этой БД uploads. Их нет в основной wb_data.db." +
        " Превью первых строк:"
    );
    for (const f of usable) {
      const pv = f.preview;
      if (pv && Array.isArray(pv) && pv.length) {
        const head = pv.slice(0, 2).map(stringifyRow).join(" | ");
        lines.push(`  ${f.id}: ${head.slice(0, 200)}`);
      }
    }
    return lines.join("\n");
  } catch (e) {
    _ok = false;
    _err = `manifestBlock: ${e?.message || e}`;
    return "";
  }
}

async function stringifyRow(r) {
  if (r == null) return "";
  if (typeof r === "string") return r.slice(0, 80);
  if (Array.isArray(r)) return r.map((x) => String(x).slice(0, 30)).join(",");
  if (typeof r === "object") {
    return Object.values(r)
      .map((x) => String(x).slice(0, 30))
      .join(",");
  }
  return String(r).slice(0, 80);
}

// =====================================================================
//  Импорт данных в таблицы uploads.db (вызывается из lib/parseFile.js)
// =====================================================================

/**
 * Создать таблицу f_<name> и залить строки. rows = массив массивов
 * (значения по порядку колонок). cols = [{name,type}].
 * Берёт db через getDb() (та же БД, что и метаданные — агент ходит туда же).
 */
export async function importTable(tableName, cols, rows) {
  const db = getDb();
  if (!db) return { error: "uploads недоступен" };
  try {
    if (!/^f_[a-z0-9_]+$/i.test(tableName)) {
      return { error: "недопустимое имя таблицы" };
    }
    const colDefs = cols
      .map((c) => `"${sanitizeIdent(c.name)}" ${sqlType(c.type)}`)
      .join(", ");
    db.exec(`DROP TABLE IF EXISTS "${tableName}";`);
    db.exec(`CREATE TABLE "${tableName}" (${colDefs});`);
    const placeholders = cols.map(() => "?").join(", ");
    const stmt = await db.prepare(
      `INSERT INTO "${tableName}" VALUES (${placeholders});`
    );
    db.exec("BEGIN");
    try {
      // Чанками по 500 — иначе большой CSV упрётся в лимит параметров.
      let inserted = 0;
      for (const r of rows) {
        const vals = cols.map((_, i) => normalizeVal(r?.[i]));
        stmt.run(...vals);
        inserted++;
      }
      db.exec("COMMIT");
      return { inserted };
    } catch (inner) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* уже откатилось */
      }
      throw inner;
    }
  } catch (e) {
    _ok = false;
    _err = `importTable: ${e?.message || e}`;
    return { error: String(e?.message || e) };
  }
}

async function sanitizeIdent(name) {
  // Допустимые символы в имени колонки (двойные кавычки экранируют прочее,
  // но мы чистим от самих кавычек и нулей во избежание инъекции).
  const s = String(name ?? "").replace(/[\0"]/g, "").trim();
  return s || "col";
}

async function sqlType(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("int")) return "INTEGER";
  if (s.includes("real") || s.includes("float") || s.includes("double") || s.includes("num"))
    return "REAL";
  return "TEXT";
}

async function normalizeVal(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return String(v);
}

// =====================================================================
//  Очистка просроченных файлов
// =====================================================================

/**
 * Ленивая очистка: удаляет файлы с expires_at < сейчас (мета + бинарник +
 * таблицы f_<id>*). Вызывается при каждом upload. Non-fatal.
 * Возвращает количество удалённых.
 */
export async function purgeExpired() {
  const db = getDb();
  if (!db) return 0;
  try {
    const now = nowISO();
    const expired = await db
      .prepare("SELECT id, stored_path FROM uploaded_files WHERE expires_at < ?")
      .all(now);
    if (!expired.length) return 0;
    for (const row of expired) {
      // Удаляем бинарник
      try {
        if (row.stored_path) rmSync(row.stored_path, { force: true });
      } catch {
        /* игнор */
      }
      // Удаляем таблицы данных f_<id>* (для CSV/XLSX/PDF)
      try {
        const tables = await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?"
          )
          .all(`f_${row.id}%`);
        for (const t of tables) {
          db.exec(`DROP TABLE IF EXISTS "${t.name}";`);
        }
      } catch {
        /* игнор */
      }
    }
    await db.prepare("DELETE FROM uploaded_files WHERE expires_at < ?").run(now);
    return expired.length;
  } catch (e) {
    _ok = false;
    _err = `purgeExpired: ${e?.message || e}`;
    return 0;
  }
}

// Тестовый хук для smoke (выводит все таблицы f_*).
export async function listDataTables() {
  const db = getDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'f_%' ORDER BY name"
      )
      .all()
      .map((r) => r.name);
  } catch (e) {
    _ok = false;
    _err = `listDataTables: ${e?.message || e}`;
    return [];
  }
}

/**
 * Выполнить уже-отвалидированный SELECT к uploads.db (через общий синглтон).
 * Вызывающий сам гарантирует, что sql — это SELECT/WITH и таблицы принадлежат
 * нужному файлу (валидация в chat/route.js). Возвращает {rows} или {error}.
 * Используем RW-синглтон getDb(): он в той же БД, WAL не блокирует.
 */
export async function runSelect(sql) {
  const db = getDb();
  if (!db) return { error: "uploads недоступен" };
  try {
    const rows = await db.prepare(sql).all();
    return { rows };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
