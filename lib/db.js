// lib/db.js — ЕДИНСТВЕННЫЙ адаптер БД для SaaS.
// DatabaseSync (node:sqlite API совместимый) поверх PostgreSQL + RLS.
//
// Архитектура (SAAS_ARCHITECTURE_CLEAN.md §3):
//   - DatabaseSync(path) определяет МП по path ('wb'/'ozon') для маппинга таблиц
//   - prepare(sql) возвращает { get, all, run } — async (PG), await в lib/route
//   - convertSql: ? → $1, table → tenant.wb_table / tenant.ozon_table
//   - withTenant(cabinetId, fn): BEGIN + set_config('app.cabinet_id') + fn + COMMIT
//   - query(sql, params): без-тенантный (auth/shared)
//
// DatabaseSync берёт PG client из AsyncLocalStorage (установлен withTenant).
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool, types } = pg;
const als = new AsyncLocalStorage();

// Парсить bigint (OID 20) и numeric (OID 1700) как JS number.
// По умолчанию node-postgres возвращает bigint как строку (чтобы не терять точность).
// Для наших данных (COUNT/SUM) потеря точности несущественна.
types.setTypeParser(20, (val) => val === null ? null : Number(val));        // int8/bigint
types.setTypeParser(1700, (val) => val === null ? null : Number(val));      // numeric/decimal
// Даты/timestamp как СТРОКИ (не JS Date). Перенесённый код из data-presenter
// ждёт даты строками (как SQLite): .localeCompare, .slice, строковые сравнения
// >= <= . JS Date ломает все эти операции. OID: 1082=DATE, 1114=TIMESTAMP,
// 1184=TIMESTAMPTZ, 1266=TIMETZ.
types.setTypeParser(1082, (val) => val);  // date — строка YYYY-MM-DD
types.setTypeParser(1114, (val) => val);  // timestamp — строка
types.setTypeParser(1184, (val) => val);  // timestamptz — строка
types.setTypeParser(1266, (val) => val);  // timetz — строка

let _pool = null;

export function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    host: process.env.SAAS_DB_HOST || 'localhost',
    port: Number(process.env.SAAS_DB_PORT) || 5432,
    database: process.env.SAAS_DB || 'saas',
    user: process.env.SAAS_DB_USER || 'saas_app',
    password: process.env.SAAS_DB_PASSWORD,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  _pool.on('error', (err) => console.error('[pg pool]', err.message));
  return _pool;
}

// ── Маппинг таблиц SQLite → PostgreSQL ──────────────────────────────
// Неоднозначные таблицы (orders, sales, finance_report, order_costs, cogs,
// daily_metrics, daily_ad, daily_stock) маппятся ПО КОНТЕКСТУ МП.
const COMMON_WB = {
  articles: 'wb_articles', orders: 'wb_orders', sales: 'wb_sales',
  finance_report: 'wb_finance_report', order_costs: 'wb_order_costs',
  cogs: 'wb_cogs', daily_metrics: 'wb_daily_metrics', daily_ad: 'wb_daily_ad',
  daily_stock: 'wb_daily_stock', wb_metrics_30m: 'wb_metrics_30m',
  wb_cabinet_costs: 'wb_cabinet_costs', cabinet_costs: 'wb_cabinet_costs', wb_per_sku_costs: 'wb_per_sku_costs',
  wb_prices: 'wb_prices', wb_cards_glue: 'wb_cards_glue',
  wb_feedbacks: 'wb_feedbacks', wb_feedback_summary: 'wb_feedback_summary',
  wb_feedback_history: 'wb_feedback_history', wb_questions: 'wb_questions',
  wb_item_keywords: 'wb_item_keywords',
  wb_search_queries: 'wb_search_queries',   // «Портрет покупателя» (Джем), миграция 027
  wb_funnel_daily: 'wb_funnel_daily',
  feedbacks: 'wb_feedbacks', questions: 'wb_questions',
};
const COMMON_OZON = {
  products: 'ozon_products', orders: 'ozon_orders', sales: 'ozon_sales',
  finance_report: 'ozon_finance_report', order_costs: 'ozon_order_costs',
  cogs: 'ozon_cogs', daily_metrics: 'ozon_daily_metrics', daily_ad: 'ozon_daily_ad',
  daily_stock: 'ozon_daily_stock', ozon_cabinet_costs: 'ozon_cabinet_costs', cabinet_costs: 'ozon_cabinet_costs',
  ozon_per_sku_costs: 'ozon_per_sku_costs', ozon_feedbacks: 'ozon_feedbacks',
  ozon_feedback_summary: 'ozon_feedback_summary', ozon_feedback_history: 'ozon_feedback_history',
  ozon_questions: 'ozon_questions', ozon_daily_efficiency: 'ozon_daily_efficiency',
  ozon_actions: 'ozon_actions', ozon_action_products: 'ozon_action_products',
  ozon_prices: 'ozon_prices',   // дневные снимки цен → соинвест (миграция 030)
  feedbacks: 'ozon_feedbacks', questions: 'ozon_questions',
};

function convertSql(sql, mp) {
  // 1. ? → $1, $2...
  let i = 0;
  let result = sql.replace(/\?/g, () => `$${++i}`);

  // 1b. AS camelCase → AS "camelCase" (PG fold'ит без кавычек в lowercase).
  // Только алиасы с МАЛЕНЬКОЙ буквой затем ЗАГЛАВНОЙ (salesRub, dailySales).
  // БЕЗ флага i — иначе TEXT/REAL/INT тоже попадают.
  result = result.replace(/\bAS\s+([a-z]+\w*[A-Z]\w*)\b/g, (m, alias) => `AS "${alias}"`);

  // 2. Имена таблиц → tenant.*
  const map = mp === 'ozon' ? COMMON_OZON : COMMON_WB;
  for (const [sqliteName, pgName] of Object.entries(map)) {
    const escaped = sqliteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // FROM/JOIN/INTO/UPDATE table
    const re = new RegExp(`(?<![\\w.])((?:FROM|JOIN|INTO|UPDATE)\\s+)${escaped}\\b`, 'gi');
    result = result.replace(re, (m, kw) => `${kw}tenant.${pgName}`);
    // DELETE FROM table
    const re2 = new RegExp(`(?<![\\w.])(DELETE\\s+FROM\\s+)${escaped}\\b`, 'gi');
    result = result.replace(re2, (m, kw) => `${kw}tenant.${pgName}`);
  }
  // Ozon-only tables (всегда tenant.ozon_* — даже в WB-контексте не нужны, но безопасно)
  for (const [sqliteName, pgName] of Object.entries(COMMON_OZON)) {
    if (sqliteName.startsWith('ozon_')) {
      const escaped = sqliteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\w.])((?:FROM|JOIN|INTO|UPDATE|DELETE\\s+FROM)\\s+)${escaped}\\b`, 'gi');
      result = result.replace(re, (m, kw) => `${kw}tenant.${pgName}`);
    }
  }
  // WB-only tables (всегда wb_*)
  for (const [sqliteName, pgName] of Object.entries(COMMON_WB)) {
    if (sqliteName.startsWith('wb_')) {
      const escaped = sqliteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\w.])((?:FROM|JOIN|INTO|UPDATE|DELETE\\s+FROM)\\s+)${escaped}\\b`, 'gi');
      result = result.replace(re, (m, kw) => `${kw}tenant.${pgName}`);
    }
  }

  return result;
}

// ── DatabaseSync: node:sqlite-совместимый класс поверх PG ────────────
export class DatabaseSync {
  /**
   * @param {string} mpPath — 'wb' | 'ozon' (определяет маппинг таблиц)
   * @param {object} opts — { readOnly: true } — игнорируется (PG сам управляет)
   */
  constructor(mpPath, opts = {}) {
    const mp = String(mpPath).includes('ozon') ? 'ozon' : 'wb';
    this._mp = mp;
    this._ctx = als.getStore();
    if (!this._ctx?.client) {
      throw new Error('DatabaseSync: no tenant context. Wrap handler in withCabinet/withTenant.');
    }
  }

  prepare(sql) {
    const pgSql = convertSql(sql, this._mp);
    const client = this._ctx.client;
    // Конвертация типов + нормализация ключей (PG fold'ит в lowercase).
    const fixRows = (rows) => {
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          // bigint → number
          if (typeof row[key] === 'bigint') row[key] = Number(row[key]);
        }
      }
      return rows;
    };
    return {
      async get(...params) {
        const { rows } = await client.query(pgSql, params);
        return fixRows(rows)[0] || undefined;
      },
      async all(...params) {
        const { rows } = await client.query(pgSql, params);
        return fixRows(rows);
      },
      async run(...params) {
        const r = await client.query(pgSql, params);
        return { changes: r.rowCount, lastInsertRowid: null };
      },
    };
  }

  pragma() { return []; }
  close() {}
}

// ── withTenant: RLS транзакция ──────────────────────────────────────
export async function withTenant(cabinetId, fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.cabinet_id', $1::text, true)", [String(cabinetId)]);
    // q — async helper для прямых запросов (server components): q(sql, params) → { rows }
    const q = async (sql, params = []) => {
      const { rows } = await client.query(sql, params);
      return { rows };
    };
    const result = await als.run({ client, cabinetId }, () => fn(q, client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// ── query: без-тенантный (auth/shared) ──────────────────────────────
export async function query(sql, params = []) {
  const pool = getPool();
  const { rows } = await pool.query(sql, params);
  return rows;
}

// ── tenantQuery: tenant.* таблицы под RLS (через ALS-клиент withCabinet).
// Используется в lib/файлах (finItems.js и т.п.), которые работают ВНУТРИ
// withCabinet handler'а. RLS активна → видит только строки своего cabinet.
// Возвращает массив rows (пустой если ничего нет).
export async function tenantQuery(sql, params = []) {
  const ctx = als.getStore();
  if (!ctx?.client) {
    throw new Error('tenantQuery: нет tenant-контекста. Оберни вызов в withCabinet/withTenant.');
  }
  const { rows } = await ctx.client.query(sql, params);
  return rows;
}

export async function ping() {
  const rows = await query('SELECT version() AS v');
  return rows[0]?.v;
}
