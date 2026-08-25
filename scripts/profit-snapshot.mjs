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
//   node scripts/profit-snapshot.mjs            — снапшоты «было/станет» (задача 3)
//   node scripts/profit-snapshot.mjs --verify    — автопроверка после переключения
//     роутов на канон (задача 4, шаг 3): живой HTTP-ответ pnl/overview за июль-2026
//     (+ июнь-2026 WB — контрольная точка шлюза) должен совпасть с прямым вызовом
//     канона ДО КОПЕЙКИ, и ни в одном JSON-ответе не должно быть сырого "accrual_".
//     Ненулевой exit при любом расхождении.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { sealData } from 'iron-session';
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { withTenant, query, DatabaseSync } = await import('../lib/db.js');
const { ozProfitProduct, ozProfitCabinet } = await import('../lib/ozonMetrics.js');
const { wbProfitProduct, wbProfitCabinet } = await import('../lib/wbMetrics.js');
const { calcTotalTax, normalizeTaxMode } = await import('../lib/tax.js');

// Независимая проверочная сумма для revenueGross (задача «WB валовая
// выручка справочной строкой», 2026-08-20) — ТОЛЬКО saas_ro (bypass RLS,
// явный cabinet_id в каждом запросе), тот же паттерн, что
// scripts/check-profit-canon.mjs (docstring там же, «два разных
// подключения»). НЕ вызывает lib/wbMetrics.js::wbRevenueGross — своя SQL с
// нуля, иначе проверка была бы сверкой функции сама с собой.
const roPool = new pg.Pool(readonlyPgConfig());
async function independentWbRevenueGross(cabinetId, from, to) {
  const { rows: [row] } = await roPool.query(
    `SELECT COALESCE(SUM(cost_value_retail),0) AS v
     FROM tenant.wb_order_costs
     WHERE cabinet_id = $1
       AND substr(COALESCE(sale_dt, return_dt),1,10) BETWEEN $2 AND $3`,
    [cabinetId, from, to]
  );
  return round2(row?.v || 0);
}

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

async function apiGetText(cookie, path) {
  const res = await fetch(BASE + path, { headers: { cookie } });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

async function apiGet(cookie, path) {
  const text = await apiGetText(cookie, path);
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON — оставим null */ }
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
    tax: round2(k.tax), profit: round2(k.profit) /* поле переименовано волной 3: было kpi.grossProfit, теперь kpi.profit */,
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

// ═══════════════════════ --verify (задача 4, шаг 3) ═══════════════════════
// Контрольные точки шлюза (docs/profit-unification-delta.md, колонка
// «станет») — если канон/роут когда-нибудь разойдутся именно на этих цифрах,
// это первый сигнал, что что-то в подмене сломалось не только «до копейки
// относительно самого канона», но и относительно того, что владелец видел
// и одобрил.
const GATE_CHECKS = [
  // Ozon кабинет 1, 2026-07: было -179 413,96 -> -107 556,96 (Δ=+71 857,00,
  // фикс фантомного COGS, находка владельца 2026-08-21, заказ 09609165-0986-1)
  // -> -90 338,96 (Δ=+17 218,00) — политика возвратного COGS, решение
  // владельца 2026-08-21 (та же дата, прямое продолжение фикса выше):
  // «В возвратах должна учитываться только расходка на них, себестоимость не
  // учитывается, потому что часть из них идут заново в продажу». worker/
  // collectors/ozon_order_costs.py::build_order_costs — has_sale теперь
  // false ещё и при is_return=1 (было: только при отсутствии commission-
  // блока) — возвратный юнит С commission-блоком (реальная продажа была,
  // товар вернулся) больше не списывает cost_overrides, profit возврата =
  // только фактическая расходка на сам возврат (sum_accrued). Полный перегон
  // обоих кабинетов (2025-08-14..2026-08-20) подтвердил число всеми сторожами
  // (check-ozon-profit-invariant.mjs ALL PASS, check-profit-canon(-cross).mjs
  // ALL PASS, --verify) — не подгонка, новое честное число. Кабинет 1 целиком
  // (все месяцы 2025-08..2026-08): Δ=+59 825,00 ₽ (78 возвратных строк,
  // ровно снятая себестоимость); кабинет 1008 — Δ=0 (нет cost_overrides).
  // -> ТЕПЕРЬ -89 573,96 (Δ=+765,00) — возврат через ПОЛНОЕ СТОРНО распознан
  // (находка владельца 2026-08-21, заказ 0131642813-0453-1): is_return
  // раньше требовал ОДНОГО отрицательного commission-блока ИЛИ кодов 45/59
  // — юнит, где продажа (10.08, +1378) и её сторно (17.08, −1378) идут
  // ДВУМЯ ОТДЕЛЬНЫМИ commission-блоками, гасящими друг друга РОВНО в ноль
  // (не строго отрицательно — ни одна из веток не срабатывала), проходил
  // как обычная продажа с COGS. worker/collectors/ozon_order_costs.py::
  // build_order_costs — третья ветка is_return: >1 commission-блока И
  // |Σ seller_price| < 0,01 И среди блоков есть отрицательный. Полный
  // перегон обоих кабинетов (2025-08-14..2026-08-20) — 20 строк класса
  // кабинета 1 (было is_return=0, cost>0), Δ=+12 485,00 ₽ (ровно снятая
  // себестоимость); из них 1 строка (41353856-0429-1, cost=765,00) попадает
  // в июль-2026 — отсюда Δ ШЛЮЗА июля. Кабинет 1008 — 0 строк класса, Δ=0.
  // Пример-эталон 0131642813-0453-1: profit −857,28 -> −127,28, метка
  // /orders «Возврат». check-ozon-profit-calc.py (секция 22) / check-ozon-
  // profit-invariant.mjs (ALL PASS) / check-ozon-profit-map.py --live /
  // --verify — не подгонка, новое честное число.
  { cabinetId: 1, mp: 'ozon', period: '2026-07', route: 'pnl', expected: -89573.96 },
  // WB кабинет 1, 2026-06: было 102 659,15 -> 136 549,15 (Δ=+33 890,00) —
  // политика возвратного COGS WB, решение владельца 2026-08-21 (та же
  // дата/цитата, что и Ozon-политика выше; см. worker/collectors/
  // wb_order_costs.py::_aggregate_sql, докстрока у "profit"): «В возвратах
  // должна учитываться только расходка на них, себестоимость не
  // учитывается, потому что часть из них идут заново в продажу». cost
  // теперь явно 0 (не NULL) на is_return=1 (CASE в SQL, тем же приёмом, что
  // уже применён к cost_value_retail/cost_value_pay) — было: cost
  // безусловно списывался из cost_overrides join'ом, не условным на
  // is_return (найденный баг, docs/metrics-contract.md §7: комментарий
  // сборщика «profit возврата = −logistics» был ложным по факту). Полный
  // перегон кабинета 1 (2026-05-01..2026-08-20, единственный диапазон с
  // покрытием tenant.wb_finance_report): 114 возвратных строк, Δ=+119 756,00
  // ₽ (ровно снятая себестоимость возвратов, помесячно: 05=+54 866,
  // 06=+33 890, 07=+27 010, 08=+3 990). Продажные строки (is_return=0, 2124
  // шт.) не задеты — count/Σcost/Σprofit идентичны до/после. Дублей
  // (cabinet_id, srid) — 0. check-wb-return-cogs.mjs / check-profit-canon
  // .mjs / check-profit-canon-cross.mjs / --verify — ALL PASS.
  { cabinetId: 1, mp: 'wb', period: '2026-06', route: 'pnl', expected: 136549.15 },
];

// Строки плана с реальными данными (см. докстроку блока «plan/fact» ниже) —
// объявлена здесь (не там, где раньше), т.к. runVerify() (задача 5) её тоже
// использует и вызывается раньше по файлу, чем блок снапшота «было/станет».
const PLAN_FACT_CASES = [
  { cabinetId: 1, ownerUserId: 1, platform: 'OZON', mp: 'ozon', period: '2026-05' },
  { cabinetId: 1, ownerUserId: 1, platform: 'WB', mp: 'wb', period: '2026-06' },
];

function assertClose(label, was, canon, tol = 0.01) {
  const d = Math.round((Number(was) - Number(canon)) * 100) / 100;
  const ok = Math.abs(d) <= tol;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: было=${was} канон=${canon} Δ=${d}`);
  return ok;
}

// ═══════════════════════ --verify: товарные роуты (задача 5, шаг 5) ═══════════════════════
// detail/products-summary/rnp-summary/plan-fact — теперь на profitProduct
// (задача 5 плана унификации прибыли). Автопроверка расширена: (а) каждый
// роут = canon.profitProduct(productId) до копейки на сэмпле товаров; (б)
// ГЛАВНАЯ приёмка плана — кросс-страничная сверка «один период = одна
// цифра»: pnl.profit (товарная часть = profitProduct БЕЗ productId, т.е.
// canonProduct(..., null)) = products-summary.totals.profit (Σ по товарам,
// с вычетом ПОЛНОЙ кабинетной рекламы — см. коммент в route.js) =
// rnp-summary.totals.profitFact (тот же приём) — допуск 0,01 ₽.
async function runVerifyProductPages(cookie, cabinetId, mp, taxMode, period, top) {
  let allOk = true;
  const [from, to] = monthBounds(period);
  console.log(`\n── товарные роуты: кабинет ${cabinetId} / ${mp} / ${period} ──`);

  // «Товарная часть» pnl — profitProduct БЕЗ productId (тот же канон, что
  // ozProfitCabinet/wbProfitCabinet используют ПЕРЕД добавлением cabinetCosts).
  const productPart = await canonProduct(cabinetId, mp, taxMode, from, to, null);

  // ── products-summary: totals + сэмпл top-3 товаров ──
  // Допуск Σ-по-товарам-vs-агрегат = 0,05 (не 0,01) — ТА ЖЕ поправка, что
  // PRODUCT_SUM_TOL в check-profit-canon.mjs (проверка 5): каждый item.profit
  // округляется НЕЗАВИСИМО (revenue/cogs/commission/... round2 на каждом из
  // ~24-45 товаров), накопленный дрейф округления в несколько копеек —
  // ожидаемое свойство поштучного пересчёта, не баг.
  const psJson = await apiGet(cookie, `/api/cabinets/${cabinetId}/products-summary?platform=${mp}&from=${from}&to=${to}`);
  allOk = assertClose(`products-summary.totals.profit = pnl.profit(товарная часть)`, psJson?.totals?.profit, round2(productPart.profit), 0.05) && allOk;
  for (const pid of top) {
    const it = (psJson?.items || []).find((x) => x.nm === pid);
    const c = await canonProduct(cabinetId, mp, taxMode, from, to, pid);
    if (!it) { console.log(`  FAIL products-summary: товар ${pid} отсутствует в items`); allOk = false; continue; }
    allOk = assertClose(`products-summary[${pid}].profit`, it.profit, round2(c.profit)) && allOk;
    allOk = assertClose(`products-summary[${pid}].salesRub(revenue)`, it.salesRub, round2(c.revenue)) && allOk;
    allOk = assertClose(`products-summary[${pid}].costRub(cogs)`, it.costRub, round2(c.cogs)) && allOk;
    allOk = assertClose(`products-summary[${pid}].tax`, it.tax, round2(c.tax)) && allOk;
    allOk = assertClose(`products-summary[${pid}].returnLogistics`, it.returnLogistics, round2(c.returnLogistics)) && allOk;
  }

  // ── rnp-summary: totals + тот же сэмпл (явные from/to — иначе дефолт 7 дней) ──
  const rnpJson = await apiGet(cookie, `/api/cabinets/${cabinetId}/rnp-summary?platform=${mp}&from=${from}&to=${to}`);
  allOk = assertClose(`rnp-summary.totals.profitFact = pnl.profit(товарная часть)`, rnpJson?.totals?.profitFact, round2(productPart.profit), 0.05) && allOk;
  allOk = assertClose(`rnp-summary.Σ = products-summary.Σ`, rnpJson?.totals?.profitFact, psJson?.totals?.profit, 0.05) && allOk;
  for (const pid of top) {
    const it = (rnpJson?.items || []).find((x) => x.nm === pid);
    if (!it) { console.log(`  ИНФО rnp-summary: товар ${pid} отсутствует в items (нет активности в периоде фильтра rnp) — пропуск`); continue; }
    const c = await canonProduct(cabinetId, mp, taxMode, from, to, pid);
    allOk = assertClose(`rnp-summary[${pid}].profitFact`, it.profitFact, round2(c.profit)) && allOk;
    allOk = assertClose(`rnp-summary[${pid}].salesRub(revenue)`, it.salesRub, round2(c.revenue)) && allOk;
  }

  // ── detail: totals за тот же сэмпл ──
  for (const pid of top) {
    const detJson = await apiGet(cookie, `/api/cabinets/${cabinetId}/detail?platform=${mp}&nm=${pid}&from=${from}&to=${to}`);
    const c = await canonProduct(cabinetId, mp, taxMode, from, to, pid);
    allOk = assertClose(`detail[${pid}].totals.profit`, detJson?.totals?.profit, round2(c.profit)) && allOk;
    allOk = assertClose(`detail[${pid}].totals.tax`, detJson?.totals?.tax, round2(c.tax)) && allOk;
    allOk = assertClose(`detail[${pid}].totals.revenue`, detJson?.totals?.revenue, round2(c.revenue)) && allOk;
  }

  return allOk;
}

async function runVerify() {
  console.log('════ --verify: живой роут = канон до копейки (задачи 4-5) ════');
  let allOk = true;

  for (const { cabinetId, ownerUserId, platforms } of CABINETS) {
    const cookie = await mintCookie(ownerUserId);

    // /unit — мёртвый роут задачи 5, должен быть удалён (404).
    const unitRes = await fetch(`${BASE}/api/cabinets/${cabinetId}/unit`, { headers: { cookie } });
    if (unitRes.status !== 404) { console.log(`  FAIL /unit кабинета ${cabinetId}: ожидался 404, получен ${unitRes.status} — роут не удалён?`); allOk = false; }
    else console.log(`  PASS /unit кабинета ${cabinetId}: 404 (удалён)`);

    for (const mp of platforms) {
      const taxMode = await taxModeOf(cabinetId, mp);
      // Июль — обязательный разрез брифа; июнь добавлен только для WB кабинета 1,
      // чтобы покрыть вторую контрольную точку шлюза (GATE_CHECKS).
      const periods = mp === 'wb' && cabinetId === 1 ? ['2026-06', '2026-07'] : ['2026-07'];
      const top = await topProducts(cabinetId, mp, 3);
      for (const period of periods) {
        const [from, to] = monthBounds(period);
        console.log(`\n── кабинет ${cabinetId} / ${mp} / ${period} ──`);

        // pnl
        const pnlText = await apiGetText(cookie, `/api/cabinets/${cabinetId}/pnl?period=${period}`);
        if (/accrual_/.test(pnlText)) { console.log(`  FAIL pnl: сырой accrual_ в ответе`); allOk = false; }
        const pnlJson = JSON.parse(pnlText);
        const pnlWas = pnlJson[mp];
        const pnlCanon = await canonCabinet(cabinetId, mp, taxMode, from, to);
        allOk = assertClose(`pnl.${mp}.profit`, pnlWas?.profit, round2(pnlCanon.profit)) && allOk;
        allOk = assertClose(`pnl.${mp}.revenue`, pnlWas?.revenue, round2(pnlCanon.revenue)) && allOk;
        allOk = assertClose(`pnl.${mp}.tax`, pnlWas?.tax, round2(pnlCanon.tax)) && allOk;
        allOk = assertClose(`pnl.${mp}.ads`, pnlWas?.ads, round2(pnlCanon.ads)) && allOk;
        allOk = assertClose(
          `pnl.${mp}.cabinetCostsTotal`,
          pnlWas?.cabinetCostsTotal,
          round2(pnlCanon.cabinetCosts.reduce((a, x) => a + x.amount, 0))
        ) && allOk;

        // revenueGross (задача «WB валовая выручка справочной строкой»,
        // 2026-08-20) — АДДИТИВНОЕ справочное поле, ТОЛЬКО у WB. Сверка НЕ
        // с каноном (wbRevenueGross бы проверял сам себя), а с независимой
        // SQL-суммой на saas_ro (см. independentWbRevenueGross выше).
        if (mp === 'wb') {
          const indRevenueGross = await independentWbRevenueGross(cabinetId, from, to);
          allOk = assertClose(`pnl.wb.revenueGross = независимый SQL(saas_ro)`, pnlWas?.revenueGross, indRevenueGross) && allOk;
        }

        // overview
        const ovText = await apiGetText(cookie, `/api/cabinets/${cabinetId}/overview?mp=${mp}&from=${from}&to=${to}`);
        if (/accrual_/.test(ovText)) { console.log(`  FAIL overview: сырой accrual_ в ответе`); allOk = false; }
        const ovJson = JSON.parse(ovText);
        // Поле переименовано волной 3 (kpi.profit — полная прибыль); правка синхронна с деплоем.
        allOk = assertClose(`overview.kpi.profit`, ovJson.kpi?.profit, round2(pnlCanon.profit)) && allOk;
        allOk = assertClose(`overview.kpi.tax`, ovJson.kpi?.tax, round2(pnlCanon.tax)) && allOk;
        allOk = assertClose(`overview.kpi.adSpend`, ovJson.kpi?.adSpend, round2(pnlCanon.ads)) && allOk;
        if (mp === 'wb') {
          const indRevenueGross = await independentWbRevenueGross(cabinetId, from, to);
          allOk = assertClose(`overview.kpi.revenueGross = независимый SQL(saas_ro)`, ovJson.kpi?.revenueGross, indRevenueGross) && allOk;
        }

        // Контрольные точки шлюза.
        for (const g of GATE_CHECKS) {
          if (g.cabinetId === cabinetId && g.mp === mp && g.period === period && g.route === 'pnl') {
            allOk = assertClose(`ШЛЮЗ pnl.${mp}.profit (${period})`, pnlWas?.profit, g.expected) && allOk;
          }
        }

        // Товарные роуты (задача 5) — detail/products-summary/rnp-summary +
        // кросс-страничная сверка «один период = одна цифра».
        allOk = await runVerifyProductPages(cookie, cabinetId, mp, taxMode, period, top) && allOk;
      }
    }
  }

  // ── plan/fact (задача 5): факт-колонки на каноне, теми же строками, что
  // реально есть в sales_plan (см. PLAN_FACT_CASES ниже — живых данных мало).
  console.log(`\n── plan/fact (факт-колонки = канон) ──`);
  for (const c of PLAN_FACT_CASES) {
    const cookie = await mintCookie(c.ownerUserId);
    const [from, to] = monthBounds(c.period);
    const taxMode = await taxModeOf(c.cabinetId, c.mp);
    const json = await apiGet(cookie, `/api/cabinets/${c.cabinetId}/plan/fact?period=${c.period}&platform=${c.platform}`);
    for (const it of json?.items || []) {
      const pid = c.mp === 'ozon' ? it.product_id : it.nm_id;
      if (pid == null || it.margin_fact_rub == null) continue;
      const canonP = await canonProduct(c.cabinetId, c.mp, taxMode, from, to, pid);
      allOk = assertClose(`plan/fact[${c.platform}/${c.period}/${pid}].margin_fact_rub`, it.margin_fact_rub, round2(canonP.profit)) && allOk;
      allOk = assertClose(`plan/fact[${c.platform}/${c.period}/${pid}].revenue_fact`, it.revenue_fact, round2(canonP.revenue)) && allOk;
    }
  }

  console.log(`\n${allOk ? 'ВСЕ ПРОВЕРКИ ПРОШЛИ (ALL PASS)' : 'ЕСТЬ РАСХОЖДЕНИЯ (FAIL)'}`);
  // roPool (независимая сверка revenueGross, saas_ro) — закрыть явно, иначе
  // процесс висит на открытом соединении пула после process.exit не дойдя
  // (тот же приём, что check-profit-canon.mjs, roPool.end()).
  await roPool.end().catch(() => {});
  if (!allOk) process.exit(1);
}

if (process.argv.includes('--verify')) {
  await runVerify();
  process.exit(0);
} else {
  // Основной прогон снапшота roPool не использует — закрыть, чтобы node
  // не завис на открытом соединении пула.
  await roPool.end().catch(() => {});
}

// ═══════════════════════ Основной прогон (снапшоты «было/станет», задача 3) ═══════════════════════
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
// (PLAN_FACT_CASES объявлена выше — переиспользуется runVerify(), задача 5.)
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
