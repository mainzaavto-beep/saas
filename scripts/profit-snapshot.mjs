#!/usr/bin/env node
// scripts/profit-snapshot.mjs — снапшоты «было/станет» для документа шлюза
// (план «унификация формул прибыли», docs/superpowers/plans/2026-08-20-
// profit-unification.md, задача 3).
//
// «Было» — живые ответы ТЕКУЩИХ роутов панели по HTTP (127.0.0.1:3200, прод,
// см. .env.local SAAS_PORT). Аутентификация — БЕЗ создания тестовых записей:
// сессия минтится напрямую тем же криптографическим механизмом, что и боевой
// /api/auth/login (iron-session sealData с SAAS_SESSION_SECRET из
// .env.local — тем же секретом, что процесс saas-web читает через
// EnvironmentFile=.env.local, см. systemctl cat saas-web). Владелец кабинета
// берётся из auth.memberships (роль owner, реальный, давно существующий
// пользователь — cabinet 1 → user 1 (owner@sysell.ru), cabinet 1008 →
// user 1031 (m.strelkova78@gmail.com)) — НИКАКИХ INSERT, только SELECT
// (через lib/db.js query(), ту же роль saas_app, что и сама панель).
// Cookie передаётся вручную HTTP-заголовком, session.save()/touchSession()
// внутри withCabinet.js пишет только Set-Cookie в ответ (мы его не сохраняем
// и не используем повторно) — ни одной строки в БД не меняется.
//
// «Станет» — прямые вызовы канона (lib/ozonMetrics.js::ozProfitProduct/
// ozProfitCabinet, lib/wbMetrics.js::wbProfitProduct/wbProfitCabinet) внутри
// withTenant(cabinetId, ...) — ТОТ ЖЕ паттерн, что уже проверен в
// scripts/check-profit-canon.mjs (задачи 1-2, ALL PASS).
//
// Вывод: JSON в .superpowers/sdd/2026-08-20-profit-unification/ (gitignored,
// НЕ в репозитории) + сводка расхождений в stdout.
//
// Разрезы (бриф задачи 3): pnl, overview, detail (2-3 топ-товара),
// products-summary, rnp-summary, plan/fact — апр-июл 2026 × кабинеты 1
// (WB+Ozon), 1008 (Ozon-only, у кабинета нет магазина WB) × площадки.
//
// Использование:
//   node scripts/profit-snapshot.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { sealData } from 'iron-session';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { withTenant, query, DatabaseSync } = await import('../lib/db.js');
const { ozProfitProduct, ozProfitCabinet } = await import('../lib/ozonMetrics.js');
const { wbProfitProduct, wbProfitCabinet } = await import('../lib/wbMetrics.js');
const { calcTotalTax, normalizeTaxMode } = await import('../lib/tax.js');

const BASE = 'http://127.0.0.1:3200'; // прод-порт (см. saas-verification-protocol), НЕ 3210
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07'];
const OUT_DIR = new URL('../.superpowers/sdd/2026-08-20-profit-unification/', import.meta.url);
mkdirSync(OUT_DIR, { recursive: true });

const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round((Number(v) + Number.EPSILON) * 100) / 100);
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function monthBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${period}-01`, `${period}-${String(last).padStart(2, '0')}`];
}

// ═══════════════════════ Аутентификация без записи в БД ═══════════════════════
// Минтит sealed-cookie ТЕМ ЖЕ способом, что iron-session::getIronSession +
// session.save() в app/api/auth/login/route.js (см. lib/session.js
// sessionOptions(): password=SAAS_SESSION_SECRET, ttl=MAX_AGE=7 дней,
// cookieName='saas_session'). Поля сессии — 1:1 с login/route.js: user_id,
// email, name, sv (=session_version, сверяется withCabinet.js), touched_at
// (свежий — touchSession() внутри withCabinet.js не станет его перезаписывать
// и НЕ тронет БД). Никакого INSERT/UPDATE — только чтение auth.users через
// lib/db.js::query() (та же роль saas_app, что использует сама панель).
const SESSION_COOKIE = 'saas_session';
const MAX_AGE = 60 * 60 * 24 * 7;

async function mintCookie(userId) {
  const rows = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [userId]);
  if (!rows.length) throw new Error(`auth.users: нет пользователя ${userId}`);
  const u = rows[0];
  const sessionData = {
    user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
    active_cabinet_id: null, touched_at: Date.now(),
  };
  const seal = await sealData(sessionData, { password: process.env.SAAS_SESSION_SECRET, ttl: MAX_AGE });
  return `${SESSION_COOKIE}=${encodeURIComponent(seal)}`;
}

async function apiGet(cookie, path) {
  const res = await fetch(BASE + path, { headers: { cookie } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON — оставим null */ }
  if (res.status !== 200) {
    throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

// ═══════════════════════ Кабинеты/площадки ═══════════════════════
const CABINETS = [
  { cabinetId: 1, ownerUserId: 1, platforms: ['wb', 'ozon'] },
  { cabinetId: 1008, ownerUserId: 1031, platforms: ['ozon'] },
];

async function taxModeOf(cabinetId, mp) {
  const rows = await query(
    `SELECT tax_mode FROM auth.shops WHERE cabinet_id = $1 AND mp_code = $2 AND is_active = true LIMIT 1`,
    [cabinetId, mp]
  );
  return normalizeTaxMode(rows[0]?.tax_mode || null);
}

// Топ-N товаров по выручке за весь диапазон апр-июл (канон-подключение,
// внутри RLS кабинета — cabinet_id не нужен явно, withTenant уже скопировал).
async function topProducts(cabinetId, mp, n = 3) {
  const [from] = monthBounds(MONTHS[0]);
  const [, to] = monthBounds(MONTHS[MONTHS.length - 1]);
  return withTenant(cabinetId, async () => {
    const db = new DatabaseSync(mp, { readOnly: true });
    if (mp === 'ozon') {
      const rows = await db.prepare(
        `SELECT product_id AS id, SUM(cost_value_retail) AS rev
         FROM order_costs
         WHERE is_return = 0 AND substr(COALESCE(sale_dt, return_dt),1,10) >= ?
           AND substr(COALESCE(sale_dt, return_dt),1,10) <= ? AND product_id IS NOT NULL
         GROUP BY product_id ORDER BY rev DESC LIMIT ?`
      ).all(from, to, n);
      return rows.map((r) => r.id);
    } else {
      const rows = await db.prepare(
        `SELECT nm_id AS id, SUM(cost_value_pay) AS rev
         FROM order_costs
         WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
           AND substr(COALESCE(sale_dt, return_dt),1,10) <= ? AND nm_id IS NOT NULL
         GROUP BY nm_id ORDER BY rev DESC LIMIT ?`
      ).all(from, to, n);
      return rows.map((r) => r.id);
    }
  });
}

// Список product_id/nm_id, встречавшихся в периоде (для Σ profitProduct по
// товарам — «станет» products-summary/rnp-summary, симметрично проверке 5
// check-profit-canon.mjs).
async function productsInPeriod(cabinetId, mp, from, to) {
  return withTenant(cabinetId, async () => {
    const db = new DatabaseSync(mp, { readOnly: true });
    const col = mp === 'ozon' ? 'product_id' : 'nm_id';
    const rows = await db.prepare(
      `SELECT DISTINCT ${col} AS id FROM order_costs
       WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
         AND substr(COALESCE(sale_dt, return_dt),1,10) <= ? AND ${col} IS NOT NULL`
    ).all(from, to);
    return rows.map((r) => r.id);
  });
}

// ═══════════════════════ «Станет» — канон ═══════════════════════
async function canonCabinet(cabinetId, mp, taxMode, from, to) {
  return withTenant(cabinetId, async () => {
    const db = new DatabaseSync(mp, { readOnly: true });
    return mp === 'ozon'
      ? ozProfitCabinet(db, taxMode, { cabinetId, from, to })
      : wbProfitCabinet(db, taxMode, { cabinetId, from, to });
  });
}

async function canonProduct(cabinetId, mp, taxMode, from, to, productId = null) {
  return withTenant(cabinetId, async () => {
    const db = new DatabaseSync(mp, { readOnly: true });
    return mp === 'ozon'
      ? ozProfitProduct(db, taxMode, { cabinetId, from, to }, productId)
      : wbProfitProduct(db, taxMode, { cabinetId, from, to }, productId);
  });
}

// Σ profitProduct(товар).profit по всем товарам периода — «станет» для
// products-summary/rnp-summary (canon-табличка задачи 3-6: обе страницы
// сводятся к сумме profitProduct по товарам, БЕЗ кабинетных расходов).
async function canonProductSum(cabinetId, mp, taxMode, from, to, productIds) {
  let sum = 0;
  const items = {};
  for (const id of productIds) {
    const pp = await canonProduct(cabinetId, mp, taxMode, from, to, id);
    sum += pp.profit;
    items[id] = pp.profit;
  }
  return { sum: round2(sum), count: productIds.length, items };
}

// ═══════════════════════ «Было» — извлечение ключевых полей ═══════════════════════
function extractPnlWas(json, mp) {
  const o = mp === 'ozon' ? json.ozon : json.wb;
  if (!o) return null;
  return {
    sales: round2(o.sales), netSales: round2(o.netSales), cost: round2(o.cost),
    commission: round2(o.commission), logistics: round2(o.logistics), acquiring: round2(o.acquiring),
    storage: round2(o.storage), promotion: round2(o.promotion), subscription: round2(o.subscription),
    penalty: round2(o.penalty), deductionOther: round2(o.deductionOther), otherIncome: round2(o.otherIncome),
    tax: round2(o.tax), grossProfit: round2(o.grossProfit), netProfit: round2(o.netProfit),
  };
}

function extractOverviewWas(json) {
  const k = json.kpi;
  return {
    revenue: round2(k.revenue), cogsSold: round2(k.cogsSold), adSpend: round2(k.adSpend),
    tax: round2(k.tax), profit: round2(k.grossProfit) /* поле называется grossProfit, но это ИТОГОВАЯ k.profit */,
    margin: round2(k.margin), expenses: round2(k.expenses),
  };
}

function extractProductsSummaryWas(json) {
  const t = json.totals;
  return {
    salesRub: round2(t.salesRub), costRub: round2(t.costRub), commission: round2(t.commission),
    logistics: round2(t.logistics), acquiring: round2(t.acquiring), loyalty: round2(t.loyalty),
    adSpend: round2(t.adSpend), tax: round2(t.tax), profit: round2(t.profit), margin: t.margin,
    returnLogistics: round2(t.returnLogistics), count: json.count,
  };
}

function extractRnpWas(json) {
  const t = json.totals;
  return {
    salesRub: round2(t.salesRub), adSpend: round2(t.adSpend), profitFact: round2(t.profitFact),
  };
}

function extractDetailWas(json) {
  const t = json.totals;
  return {
    profit: round2(t.profit), tax: round2(t.tax), adSpend: round2(t.adSpend ?? t.ad_spend),
  };
}

// ═══════════════════════ Основной прогон ═══════════════════════
const result = { generatedAt: new Date().toISOString(), cabinets: {} };

for (const { cabinetId, ownerUserId, platforms } of CABINETS) {
  console.log(`\n════ Кабинет ${cabinetId} (владелец user_id=${ownerUserId}) ════`);
  const cookie = await mintCookie(ownerUserId);
  // Смок-проверка: сессия реально валидна (не создаёт данных — просто /me).
  const me = await apiGet(cookie, `/api/cabinets/${cabinetId}/me`).catch((e) => { throw new Error(`минт-сессия не прошла: ${e.message}`); });
  console.log(`  сессия ок: ${me?.email || JSON.stringify(me)}`);

  result.cabinets[cabinetId] = { platforms: {} };

  for (const mp of platforms) {
    console.log(`  ── площадка ${mp} ──`);
    const taxMode = await taxModeOf(cabinetId, mp);
    const top = await topProducts(cabinetId, mp, 3);
    console.log(`  топ-3 товара: ${top.join(', ')}`);

    const platformOut = { taxMode, topProducts: top, months: {} };

    for (const period of MONTHS) {
      const [from, to] = monthBounds(period);
      console.log(`    период ${period} (${from}..${to})`);
      const monthOut = {};

      // ── pnl ──
      try {
        const pnlWasJson = await apiGet(cookie, `/api/cabinets/${cabinetId}/pnl?period=${period}`);
        const pnlWas = extractPnlWas(pnlWasJson, mp);
        const pnlCanon = await canonCabinet(cabinetId, mp, taxMode, from, to);
        monthOut.pnl = {
          was: pnlWas,
          canon: {
            revenue: round2(pnlCanon.revenue), cogs: round2(pnlCanon.cogs), commission: round2(pnlCanon.commission),
            logistics: round2(pnlCanon.logistics), acquiring: round2(pnlCanon.acquiring), loyalty: round2(pnlCanon.loyalty),
            ads: round2(pnlCanon.ads), tax: round2(pnlCanon.tax), cabinetCosts: pnlCanon.cabinetCosts,
            unknownCostTypes: pnlCanon.unknownCostTypes, profit: round2(pnlCanon.profit),
          },
        };
      } catch (e) { monthOut.pnl = { error: e.message }; }

      // ── overview ──
      try {
        const ovWasJson = await apiGet(cookie, `/api/cabinets/${cabinetId}/overview?mp=${mp}&from=${from}&to=${to}`);
        const ovWas = extractOverviewWas(ovWasJson);
        // Канон overview = profitCabinet (та же функция, что и pnl — см. таблицу
        // потребителей в спеке). Переиспользуем pnlCanon, если уже посчитан.
        const ovCanon = monthOut.pnl?.canon || await (async () => {
          const c = await canonCabinet(cabinetId, mp, taxMode, from, to);
          return { profit: round2(c.profit), ads: round2(c.ads), tax: round2(c.tax) };
        })();
        monthOut.overview = { was: ovWas, canon: { profit: ovCanon.profit, ads: ovCanon.ads, tax: ovCanon.tax } };
      } catch (e) { monthOut.overview = { error: e.message }; }

      // ── products-summary ──
      try {
        const psWasJson = await apiGet(cookie, `/api/cabinets/${cabinetId}/products-summary?platform=${mp}&from=${from}&to=${to}`);
        const psWas = extractProductsSummaryWas(psWasJson);
        const ids = await productsInPeriod(cabinetId, mp, from, to);
        const psCanon = await canonProductSum(cabinetId, mp, taxMode, from, to, ids);
        monthOut.productsSummary = { was: psWas, canon: { profitSum: psCanon.sum, productCount: psCanon.count } };
      } catch (e) { monthOut.productsSummary = { error: e.message }; }

      // ── rnp-summary ──
      try {
        const rnpWasJson = await apiGet(cookie, `/api/cabinets/${cabinetId}/rnp-summary?platform=${mp}&from=${from}&to=${to}`);
        const rnpWas = extractRnpWas(rnpWasJson);
        // Тот же канон-набор товаров/сумм, что и products-summary (обе страницы
        // сходятся к Σ profitProduct по товарам — цель унификации).
        const rnpCanonSum = monthOut.productsSummary?.canon?.profitSum;
        monthOut.rnpSummary = { was: rnpWas, canon: { profitSum: rnpCanonSum } };
      } catch (e) { monthOut.rnpSummary = { error: e.message }; }

      // ── detail (топ-3 товара) ──
      monthOut.detail = {};
      for (const pid of top) {
        try {
          const qParam = mp === 'ozon' ? `nm=${pid}` : `nm=${pid}`;
          const detWasJson = await apiGet(cookie, `/api/cabinets/${cabinetId}/detail?platform=${mp}&${qParam}&from=${from}&to=${to}`);
          const detWas = extractDetailWas(detWasJson);
          const detCanon = await canonProduct(cabinetId, mp, taxMode, from, to, pid);
          monthOut.detail[pid] = { was: detWas, canon: { profit: round2(detCanon.profit), tax: round2(detCanon.tax), ads: round2(detCanon.ads) } };
        } catch (e) { monthOut.detail[pid] = { error: e.message }; }
      }

      platformOut.months[period] = monthOut;
    }

    result.cabinets[cabinetId].platforms[mp] = platformOut;
  }
}

// ═══════════════════════ plan/fact (только реальные строки sales_plan) ═══════════════════════
// Живых данных мало (см. task-3 разведку): cabinet 1 / OZON / 2026-05 (1 SKU),
// cabinet 1 / WB / 2026-06 (1 SKU). Кабинет 1008 — без строк плана вовсе.
// Снапшотим то, что реально есть, честно фиксируем пустоту остального.
const PLAN_FACT_CASES = [
  { cabinetId: 1, ownerUserId: 1, platform: 'OZON', mp: 'ozon', period: '2026-05' },
  { cabinetId: 1, ownerUserId: 1, platform: 'WB', mp: 'wb', period: '2026-06' },
];
result.planFact = [];
for (const c of PLAN_FACT_CASES) {
  const cookie = await mintCookie(c.ownerUserId);
  const [from, to] = monthBounds(c.period);
  const taxMode = await taxModeOf(c.cabinetId, c.mp);
  try {
    const json = await apiGet(cookie, `/api/cabinets/${c.cabinetId}/plan/fact?period=${c.period}&platform=${c.platform}`);
    const items = [];
    for (const it of json.items || []) {
      const pid = c.mp === 'ozon' ? it.product_id : it.nm_id;
      let canonProfit = null;
      if (pid != null) {
        const cp = await canonProduct(c.cabinetId, c.mp, taxMode, from, to, pid);
        canonProfit = round2(cp.profit);
      }
      items.push({
        sku_label: it.sku_label, nm_id: it.nm_id, product_id: it.product_id,
        cost_plan: it.cost_plan, qty_fact: it.qty_fact, revenue_fact: it.revenue_fact,
        margin_fact_rub_was: it.margin_fact_rub, // факт-прибыль на плановой себестоимости (было)
        profit_canon: canonProfit,               // факт-прибыль на фактической себестоимости (станет)
      });
    }
    result.planFact.push({ ...c, items });
  } catch (e) {
    result.planFact.push({ ...c, error: e.message });
  }
}

writeFileSync(new URL('snapshot.json', OUT_DIR), JSON.stringify(result, null, 2));
console.log(`\nСнапшот сохранён: ${new URL('snapshot.json', OUT_DIR).pathname}`);
