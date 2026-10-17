// lib/ddsData.js — ДДС: чтение журнала/отчёта и справочники счетов/статей (17.10.2026, спека
// docs/superpowers/specs/2026-10-17-dds-design.md). Все функции — внутри withTenant (одна транзакция
// роута), запросы последовательно. Запись движений — НЕ здесь, только lib/paymentCalendarData.js.
import { tenantQuery } from "./db.js";
import { SYSTEM_ARTICLES, readDdsSettings, balancesAt, buildReport } from "./dds.js";

export const httpError = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (x) => Math.round(x * 100) / 100;
const addDay = (s) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const COLORS = ["pos", "neg", "warn", "accent", "accent2", "blue", "pink", "muted", "faint", "line"];

export async function ensureArticles() {
  for (const a of SYSTEM_ARTICLES) {
    await tenantQuery(
      `INSERT INTO tenant.dds_articles (cabinet_id, key, label, direction, activity, color, sort, is_system)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (cabinet_id, key) DO NOTHING`,
      [a.key, a.label, a.direction, a.activity, a.color, a.sort]);
  }
}

export async function loadArticles() {
  await ensureArticles();
  return tenantQuery(
    `SELECT key, label, direction, activity, color, sort, is_system, is_archived
       FROM tenant.dds_articles ORDER BY activity, direction, sort, label`);
}

export async function loadAccounts() {
  return tenantQuery(
    `SELECT id::int AS id, name, kind, opening_balance::float8 AS opening_balance, opening_date::text AS opening_date,
            sort, is_archived FROM tenant.dds_accounts ORDER BY is_archived, sort, id`);
}

export async function loadDdsSettings() {
  const r = await tenantQuery(`SELECT settings FROM auth.cabinets WHERE cabinet_id = current_setting('app.cabinet_id')::bigint`);
  return readDdsSettings(r[0]?.settings);
}

export async function loadRefs() {
  const articles = await loadArticles();
  const accounts = await loadAccounts();
  const settings = await loadDdsSettings();
  return { articles, accounts, settings };
}

// Фильтры журнала. account: id | 'none'; source: manual|recurring|purchase|mp_payout|transfer.
function journalWhere({ from, to, account, article, type, source, q }) {
  const conds = ["status = 'paid'"], params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (ISO.test(from || "")) conds.push(`date >= ${p(from)}`);
  if (ISO.test(to || "")) conds.push(`date <= ${p(to)}`);
  if (account === "none") conds.push(`account_id IS NULL AND type <> 'transfer'`);
  else if (Number(account) > 0) { const x = p(Number(account)); conds.push(`(account_id = ${x} OR account_to_id = ${x})`); }
  if (article) conds.push(`article_key = ${p(String(article))}`);
  if (["income", "expense", "transfer"].includes(type)) conds.push(`type = ${p(type)}`);
  if (source === "transfer") conds.push(`type = 'transfer'`);
  else if (["manual", "recurring", "purchase", "mp_payout"].includes(source)) conds.push(`source_kind = ${p(source)} AND type <> 'transfer'`);
  if (q && String(q).trim()) { const x = p(`%${String(q).trim()}%`); conds.push(`(counterparty ILIKE ${x} OR description ILIKE ${x})`); }
  return { where: conds.join(" AND "), params };
}

export const PAGE_SIZE = 100;
export async function loadJournal(f) {
  const { where, params } = journalWhere(f);
  const page = Math.max(1, Number(f.page) || 1);
  const items = await tenantQuery(
    `SELECT id::int AS id, date, type, amount::float8 AS amount, article_key, account_id::int AS account_id,
            account_to_id::int AS account_to_id, counterparty, description, source_kind, source_ref, date_locked
       FROM tenant.dds_movements WHERE ${where}
      ORDER BY date DESC, id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params);
  const agg = (await tenantQuery(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)::float8 AS income,
            COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)::float8 AS expense
       FROM tenant.dds_movements WHERE ${where}`, params))[0];
  const noAcc = (await tenantQuery(
    `SELECT COUNT(*)::int AS n FROM tenant.dds_movements WHERE status = 'paid' AND type <> 'transfer' AND account_id IS NULL`))[0];
  return {
    items, total: agg.n, page, pageSize: PAGE_SIZE,
    totals: { income: r2(agg.income), expense: r2(agg.expense), net: r2(agg.income - agg.expense) },
    noAccountCount: noAcc.n,
  };
}

async function factMovementsUpTo(to) {
  return tenantQuery(
    `SELECT date, type, amount::float8 AS amount, account_id::int AS account_id, account_to_id::int AS account_to_id, article_key
       FROM tenant.dds_movements WHERE status = 'paid' AND date <= $1`, [to]);
}

export async function loadEndBalance(to) {
  const accounts = await loadAccounts();
  const ms = await factMovementsUpTo(to);
  return r2([...balancesAt(accounts, ms, addDay(to)).values()].reduce((s, x) => s + x, 0));
}

export async function loadReport({ from, to, grain, today }) {
  const articles = await loadArticles();
  const accounts = await loadAccounts();
  const movements = await factMovementsUpTo(to);
  return buildReport({ articles, accounts, movements, from, to, grain: grain === "week" ? "week" : "month", today });
}

export async function saveArticle(b) {
  const label = String(b.label || "").trim();
  if (!label) throw httpError("название статьи обязательно");
  if (b.color != null && !COLORS.includes(b.color)) throw httpError("цвет статьи");
  if (b.key) {
    const cur = (await tenantQuery(`SELECT key, is_system FROM tenant.dds_articles WHERE key = $1 FOR UPDATE`, [b.key]))[0];
    if (!cur) throw httpError(`статья ${b.key} не найдена`, 404);
    // у системной меняются только название, цвет и порядок; направление не меняется ни у какой
    const activity = !cur.is_system && ["operating", "investing", "financing"].includes(b.activity) ? b.activity : null;
    await tenantQuery(
      `UPDATE tenant.dds_articles SET label = $1, color = COALESCE($2, color), sort = COALESCE($3, sort),
          activity = COALESCE($4, activity), updated_at = now() WHERE key = $5`,
      [label, b.color ?? null, b.sort != null ? Number(b.sort) : null, activity, b.key]);
    return b.key;
  }
  if (!["income", "expense"].includes(b.direction)) throw httpError("direction: income|expense");
  if (!["operating", "investing", "financing"].includes(b.activity)) throw httpError("activity: operating|investing|financing");
  const r = await tenantQuery(
    `INSERT INTO tenant.dds_articles (cabinet_id, key, label, direction, activity, color, sort, is_system)
     SELECT current_setting('app.cabinet_id')::bigint,
            'u_' || (COALESCE(MAX(substring(key from 3)::int), 0) + 1), $1, $2, $3, $4, COALESCE($5, 1000), false
       FROM tenant.dds_articles WHERE key ~ '^u_[0-9]+$'
     RETURNING key`,
    [label, b.direction, b.activity, b.color || "line", b.sort != null ? Number(b.sort) : null]);
  return r[0].key;
}

// Фолбэк-статьи other/other_in — некуда «переехать» операциям без статьи (articleKeyOf(null, …)
// в lib/dds.js и report'е падают именно на них); скрыть их нельзя.
export async function archiveArticle(key, archived) {
  if (archived && (key === "other" || key === "other_in")) throw httpError("эту статью нельзя скрыть — на неё падают операции без статьи");
  const r = await tenantQuery(`UPDATE tenant.dds_articles SET is_archived = $1, updated_at = now() WHERE key = $2 RETURNING key`, [!!archived, key]);
  if (!r.length) throw httpError(`статья ${key} не найдена`, 404);
}

const KINDS = ["bank_ip", "card_person", "cash", "mp_wb", "mp_ozon", "other"];
export async function saveAccount(b) {
  const name = String(b.name || "").trim();
  if (!name) throw httpError("название счёта обязательно");
  if (!KINDS.includes(b.kind)) throw httpError("тип счёта");
  if (!ISO.test(String(b.opening_date || ""))) throw httpError("дата старта YYYY-MM-DD");
  if (!Number.isFinite(Number(b.opening_balance))) throw httpError("стартовый остаток");
  const vals = [name, b.kind, r2(Number(b.opening_balance)), b.opening_date, Number(b.sort) || 0];
  if (b.id) {
    const r = await tenantQuery(
      `UPDATE tenant.dds_accounts SET name=$1, kind=$2, opening_balance=$3, opening_date=$4::date, sort=$5, updated_at=now()
        WHERE id=$6 RETURNING id::int AS id`, [...vals, Number(b.id)]);
    if (!r.length) throw httpError(`счёт id=${b.id} не найден`, 404);
    return r[0].id;
  }
  const r = await tenantQuery(
    `INSERT INTO tenant.dds_accounts (cabinet_id, name, kind, opening_balance, opening_date, sort)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4::date, $5) RETURNING id::int AS id`, vals);
  return r[0].id;
}

async function writeDdsSettings(dds) {
  await tenantQuery(
    `UPDATE auth.cabinets SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('dds', $1::jsonb)
      WHERE cabinet_id = current_setting('app.cabinet_id')::bigint`, [JSON.stringify(dds)]);
}

// Архивация счёта, занятого в настройках (default_account_id / payout_account.wb / .ozon), должна
// выбить его оттуда — иначе createMovement/markPaid/receivePayout молча подставляли бы архивный
// счёт по умолчанию, и validateDdsMovement заворачивал бы операцию 400'кой «счёт в архиве».
export async function archiveAccount(id, archived) {
  const r = await tenantQuery(`UPDATE tenant.dds_accounts SET is_archived = $1, updated_at = now() WHERE id = $2 RETURNING id`, [!!archived, Number(id)]);
  if (!r.length) throw httpError(`счёт id=${id} не найден`, 404);
  if (archived) {
    const s = await loadDdsSettings();
    const aid = Number(id);
    if (s.default_account_id === aid || s.payout_account.wb === aid || s.payout_account.ozon === aid) {
      await writeDdsSettings({
        default_account_id: s.default_account_id === aid ? null : s.default_account_id,
        payout_account: { wb: s.payout_account.wb === aid ? null : s.payout_account.wb, ozon: s.payout_account.ozon === aid ? null : s.payout_account.ozon },
      });
    }
  }
}

export async function saveDdsSettings(b) {
  const accounts = await loadAccounts();
  const ok = (v) => v == null || v === "" || accounts.some((a) => a.id === Number(v) && !a.is_archived);
  const ids = [b.default_account_id, b.payout_account?.wb, b.payout_account?.ozon];
  if (!ids.every(ok)) throw httpError("счёт настроек не найден или в архиве");
  const norm = (v) => (v == null || v === "" ? null : Number(v));
  await writeDdsSettings({ default_account_id: norm(ids[0]), payout_account: { wb: norm(ids[1]), ozon: norm(ids[2]) } });
}
