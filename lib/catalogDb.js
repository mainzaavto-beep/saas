import { ensureAuditTriggers } from "./dbAudit";

// =====================================================================
//  lib/catalogDb.js — СПРАВОЧНИК ТОВАРОВ компании (сессия 2026-06-25 (5)).
//
//  Внутренний товар (products_catalog) = логическая сущность компании
//  («регистратор 3 камеры дешевый без вайфай»), которая маппится на
//  ОДИН ИЛИ НЕСКОЛЬКО SKU маркетплейсов (M2M). Один товар → несколько
//  nm_id WB (склейки/цвета), несколько product_id Ozon, несколько
//  article Яндекс.
//
//  Зачем нужен: единственный идентификатор, по которому остатки на
//  складе/ФФ, план закупки и аналитика привязываются к товару БЕЗ
//  знания о том, сколько у него карточек на МП. (До этого sku-слой
//  был per-МП: wb_data.articles по nm_id, ozon_data.products по
//  product_id — кросс-МП идентификатора не было.)
//
//  Граница записи (правило 6 + DATA_CONTRACT): data-presenter ВЛАДЕЕТ
//  этими таблицами в fin_data.db. Базовые справочники МП
//  (wb_data.articles, ozon_data.products) — RO-fallback для фото/имени;
//  сами SKU НЕ дублируются, а только ссылаются (nm_id/product_id/
//  yandex_article). display_name/im_url — кеш на момент привязки,
//  чтобы UI работал даже если карточка исчезла из API МП.
//
//  Паттерн: lib/finItems.js — ensureSchema (кэшированный флаг) +
//  open/close try/finally + PRAGMA busy_timeout=5000.
// =====================================================================

const FIN_DB_PATH = process.env.FIN_DB_PATH || "/opt/agentsDB/fin_data.db";

const SCHEMA = `
-- Каталог внутренних товаров компании.
CREATE TABLE IF NOT EXISTS products_catalog (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    internal_name TEXT NOT NULL,
    note         TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_name ON products_catalog(internal_name);

-- M2M: один товар → много SKU маркетплейсов. Один товар может иметь
-- несколько nm_id WB (склейки/цвета), несколько product_id Ozon и т.д.
-- platform ∈ {wb, ozon, yandex}. Для wb храним nm_id, для ozon —
-- product_id, для yandex — текстовый article (БД Яндекса нет, агент
-- не создан). display_name/im_url — кеш из БД МП на момент привязки.
-- NULL'ы в UNIQUE не конфиликтуют (SQLite), поэтому «пустой столбец»
-- у строки другого МП не мешает.
CREATE TABLE IF NOT EXISTS products_catalog_skus (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    catalog_id      INTEGER NOT NULL REFERENCES products_catalog(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL,
    nm_id           INTEGER,
    product_id      INTEGER,
    yandex_article  TEXT,
    display_name    TEXT,
    im_url          TEXT,
    created_at      TEXT NOT NULL,
    UNIQUE(catalog_id, platform, nm_id, product_id, yandex_article)
);
CREATE INDEX IF NOT EXISTS idx_pcs_catalog ON products_catalog_skus(catalog_id);
CREATE INDEX IF NOT EXISTS idx_pcs_sku ON products_catalog_skus(platform, nm_id, product_id);
`;

let _inited = false;
async function ensureSchema() {
  if (_inited) return;
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
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

// =====================================================================
//  products_catalog — CRUD
// =====================================================================

/** Все товары [{id, internal_name, note, created_at}] по алфавиту. */
export async function listProducts() {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, internal_name, note, created_at FROM products_catalog ORDER BY internal_name"
      )
      .all();
  } finally {
    db.close();
  }
}

/** Один товар по id или null. */
export async function getProduct(id) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT id, internal_name, note, created_at FROM products_catalog WHERE id=?"
        )
        .get(Number(id)) || null
    );
  } finally {
    db.close();
  }
}

/** Создать товар. Возвращает {id, internal_name, note, created_at}. */
export async function createProduct(internal_name, note) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const name = String(internal_name || "").trim().slice(0, 300);
    if (!name) throw new Error("internal_name не может быть пустым");
    const ts = nowISO();
    const r = await db
      .prepare(
        "INSERT INTO products_catalog(internal_name, note, created_at) VALUES(?, ?, ?)"
      )
      .run(name, note ? String(note).slice(0, 1000) : null, ts);
    return getProduct(r.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** Переименовать товар (internal_name, note). */
export async function updateProduct(id, { internal_name, note }) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const sets = [];
    const vals = [];
    if (internal_name != null) {
      const name = String(internal_name).trim().slice(0, 300);
      if (!name) throw new Error("internal_name не может быть пустым");
      sets.push("internal_name=?");
      vals.push(name);
    }
    if (note !== undefined) {
      sets.push("note=?");
      vals.push(note == null || note === "" ? null : String(note).slice(0, 1000));
    }
    if (sets.length === 0) return getProduct(id);
    vals.push(Number(id));
    await db.prepare(`UPDATE products_catalog SET ${sets.join(", ")} WHERE id=?`).run(
      ...vals
    );
    return getProduct(id);
  } finally {
    db.close();
  }
}

/** Жёстко удалить товар (каскадно чистит products_catalog_skus). */
export async function deleteProduct(id) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    db.exec("PRAGMA foreign_keys=ON;");
    const r = await db.prepare("DELETE FROM products_catalog WHERE id=?").run(Number(id));
    return (r.changes || 0) > 0;
  } finally {
    db.close();
  }
}

// =====================================================================
//  products_catalog_skus — M2M привязка SKU к товару
// =====================================================================

/**
 * Все SKU привязанные к товарам.
 * Возвращает [{id, catalog_id, platform, nm_id, product_id, yandex_article,
 *  display_name, im_url, created_at}].
 */
export async function listAllSkus() {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT id, catalog_id, platform, nm_id, product_id, yandex_article,
                display_name, im_url, created_at
           FROM products_catalog_skus
          ORDER BY catalog_id, platform, id`
      )
      .all();
  } finally {
    db.close();
  }
}

/** SKU одного товара (по catalog_id). */
export async function listSkusOf(catalogId) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT id, catalog_id, platform, nm_id, product_id, yandex_article,
                display_name, im_url, created_at
           FROM products_catalog_skus
          WHERE catalog_id=? ORDER BY platform, id`
      )
      .all(Number(catalogId));
  } finally {
    db.close();
  }
}

/**
 * Привязать SKU к товару. platform ∈ {wb,ozon,yandex}. Для wb обязателен
 * nm_id, для ozon — product_id, для yandex — yandex_article.
 * display_name/im_url — кеш из БД МП (передаёт вызывающий API после
 * обогащения). Возвращает строку SKU.
 */
export async function addSku({ catalog_id, platform, nm_id, product_id, yandex_article, display_name, im_url }) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const p = String(platform);
    if (!["wb", "ozon", "yandex"].includes(p)) {
      throw new Error(`platform должна быть wb|ozon|yandex, получил '${p}'`);
    }
    const cat = Number(catalog_id);
    if (!Number.isFinite(cat) || cat <= 0) throw new Error("catalog_id обязателен");

    // Нормализация идентификаторов под платформу.
    let nm = null,
      pid = null,
      ya = null;
    if (p === "wb") {
      const n = Number(nm_id);
      nm = Number.isInteger(n) && n > 0 ? n : null;
      if (nm == null) throw new Error("для wb нужен nm_id > 0");
    } else if (p === "ozon") {
      const n = Number(product_id);
      pid = Number.isInteger(n) && n > 0 ? n : null;
      if (pid == null) throw new Error("для ozon нужен product_id > 0");
    } else {
      ya = yandex_article ? String(yandex_article).trim().slice(0, 200) : null;
      if (!ya) throw new Error("для yandex нужен yandex_article");
    }
    const ts = nowISO();
    const r = await db
      .prepare(
        `INSERT INTO products_catalog_skus(
           catalog_id, platform, nm_id, product_id, yandex_article,
           display_name, im_url, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(catalog_id, platform, nm_id, product_id, yandex_article)
         DO UPDATE SET display_name=excluded.display_name, im_url=excluded.im_url`
      )
      .run(
        cat,
        p,
        nm,
        pid,
        ya,
        display_name ? String(display_name).slice(0, 400) : null,
        im_url ? String(im_url).slice(0, 500) : null,
        ts
      );
    return db
      .prepare("SELECT id FROM products_catalog_skus WHERE rowid=?")
      .get(r.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** Убрать привязку SKU по её PK id. */
export async function removeSku(id) {
  ensureSchema();
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const r = await db
      .prepare("DELETE FROM products_catalog_skus WHERE id=?")
      .run(Number(id));
    return (r.changes || 0) > 0;
  } finally {
    db.close();
  }
}

export { FIN_DB_PATH };
