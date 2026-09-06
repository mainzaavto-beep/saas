#!/usr/bin/env node
// scripts/check-profit-canon-cross.mjs — сторожевая ПЕРЕКРЁСТНАЯ проверка
// канонического слоя прибыли (план «унификация формул прибыли»,
// .superpowers/sdd/2026-08-20-profit-unification/, задача 6, шаг 1).
//
// Отличие от scripts/check-profit-canon.mjs (задачи 1-2, тот же независимый-
// SQL приём): тот скрипт — ОДНОРАЗОВЫЙ глубокий разбор на ЗАФИКСИРОВАННОМ
// периоде (июль-2026, кабинет 1, 5+6 проверок с построчной аддитивностью
// productId/nmId). Этот — ПОСТОЯННЫЙ еженедельный сторож (страховка на
// годы, а не разовая приёмка): СКОЛЬЗЯЩАЯ прошлая ISO-неделя, ВСЕ активные
// магазины обеих площадок (`auth.shops WHERE is_active=true`, не только
// кабинет 1) — один короткий чек на кабинет (profitCabinet целиком, без
// разбивки по товарам), допуск ШИРЕ (1 ₽, а не 0,01 ₽ — брифинг задачи 6
// прямо требует этот порог: цель — ловить будущий регресс формулы, не
// копеечное округление конкретного периода).
//
// Проверка, ОДНА на строку (кабинет × площадка):
//   ozProfitCabinet(period).profit / wbProfitCabinet(period).profit
//     = независимый SQL: Σ(order_costs.profit) − Σ(ad_spend) − налог(canon
//       taxMode, revenue, expenses) + Σ cabinetCosts[].amount (знак —
//       ТОТ ЖЕ контракт, что отдаёт канон: Ozon сырой знак как есть, WB
//       инвертирован — см. докстроки ozProfitCabinet/wbProfitCabinet).
//   ⚠️ У WB строк ДВЕ (переезд 06.09.2026, «выручка WB по цене со скидкой
//   продавца»): прибыль — как выше, ПЛЮС отдельная строка «revenue =
//   Σ cost_value_withdisc». Без неё еженедельный сторож переезд не
//   защищает: прибыль WB собирается из order_costs.profit и не изменится,
//   даже если выручку случайно вернут на cost_value_pay/cost_value_retail.
//   Налоговая база WB здесь — та же, что в каноне (WB_TAX_BASE =
//   "realized"): доход Σ cost_value_retail, расходы cogs+logistics+ads+
//   нетто-вознаграждение (Σ retail − Σ pay).
//   Допуск: 1 ₽. Печатается КАЖДАЯ строка (не только упавшие) — «все
//   строки» из брифа задачи 6, чтобы зелёный статус был виден целиком, а
//   не подразумевался по отсутствию вывода.
//
// ⚠️ Независимость ЧАСТИЧНАЯ, честно об этом (ревью задачи 6, fix-раунд,
// п.3): налог считает ОДНА И ТА ЖЕ функция `calcTotalTax` (`lib/tax.js`) и
// в каноне, и в независимой сумме этого сторожа — они НЕ два разных
// расчёта налога. Это НАМЕРЕННО (переизобретать налоговую формулу в
// сторожевом скрипте — плодить второй источник истины по методике налога,
// прямо запрещённой Global Constraints задачи 6 плана), но означает: этот
// сторож ловит регресс СБОРКИ (revenue/cogs/commission/logistics/
// acquiring/loyalty/ads/cabinetCosts неправильно просуммированы или
// потеряны при рефакторинге), а НЕ регресс самой ФОРМУЛЫ налога — баг
// внутри `calcTotalTax` пройдёт одинаково через обе стороны сравнения и
// останется незамеченным этим конкретным чеком (методика налога вне
// скоупа задачи 6, см. «Что в этот план НЕ входит» в брифе).
//
// Подключения — тот же приём, что в check-profit-canon.mjs (Global
// Constraints задачи 1, актуальны и здесь):
//   1) канон — DatabaseSync поверх withTenant(cabinetId, ...), креды
//      saas_app из .env.local (штатный путь панели, НЕ admin).
//   2) независимая сверка — pg.Pool(readonlyPgConfig()), ТОЛЬКО saas_ro
//      (bypass RLS, явный cabinet_id в каждом запросе).
//
// Список кабинетов/площадок берётся из `auth.shops WHERE is_active=true`
// на момент запуска — НЕ хардкод (в отличие от check-profit-canon.mjs,
// где кабинет 1 — часть его конкретной задачи приёмки за июль). Новый
// кабинет/площадка подключается — сторож начинает проверять его
// автоматически, без правки кода.
//
// Использование:
//   node scripts/check-profit-canon-cross.mjs                (прошлая ISO-неделя)
//   node scripts/check-profit-canon-cross.mjs --from 2026-08-10 --to 2026-08-16
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { withTenant, query, DatabaseSync } = await import('../lib/db.js');
const { ozProfitCabinet } = await import('../lib/ozonMetrics.js');
const { wbProfitCabinet } = await import('../lib/wbMetrics.js');
const { calcTotalTax, normalizeTaxMode } = await import('../lib/tax.js');

// ── прошлая ISO-неделя (пн..вс), тот же приём, что в
// check-ozon-profit-invariant.mjs (сервер работает в Europe/Moscow). ──
function pad2(n) { return String(n).padStart(2, '0'); }
function toIsoLocal(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function mondayOf(d) {
  const nd = new Date(d);
  const wd = nd.getDay(); // 0=вс..6=сб
  const diff = (wd + 6) % 7;
  nd.setDate(nd.getDate() - diff);
  return nd;
}
function previousIsoWeek(today = new Date()) {
  const thisMonday = mondayOf(today);
  const prevMonday = new Date(thisMonday); prevMonday.setDate(prevMonday.getDate() - 7);
  const prevSunday = new Date(thisMonday); prevSunday.setDate(prevSunday.getDate() - 1);
  return { from: toIsoLocal(prevMonday), to: toIsoLocal(prevSunday) };
}

function parseArgs(argv) {
  const out = { from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
let FROM = args.from, TO = args.to;
if (!FROM || !TO) {
  const w = previousIsoWeek();
  FROM = w.from; TO = w.to;
}

const TOL = 1; // ₽ — допуск задачи 6 (шире 0,01 ₽ check-profit-canon.mjs: страховка на регресс формулы, не копеечная сверка)

const fmtRub = (n) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

let failures = 0;
let rows = 0;
function verdict(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
  rows++;
}

const roPool = new pg.Pool(readonlyPgConfig());

async function checkOzon(cabinetId, taxMode) {
  const canon = await withTenant(cabinetId, async () => {
    const db = new DatabaseSync('ozon', { readOnly: true });
    return ozProfitCabinet(db, taxMode, { cabinetId, from: FROM, to: TO });
  });

  const { rows: [rawRow] } = await roPool.query(
    `SELECT
       COALESCE(SUM(cost),0) AS cogs,
       COALESCE(SUM(commission),0) AS commission,
       COALESCE(SUM(logistics),0) AS logistics,
       COALESCE(SUM(acquiring),0) AS acquiring,
       COALESCE(SUM(loyalty),0) AS loyalty,
       COALESCE(SUM(cost_value_retail),0) AS revenue,
       COALESCE(SUM(profit),0) AS profit
     FROM tenant.ozon_order_costs
     WHERE cabinet_id = $1 AND COALESCE(sale_dt, return_dt) BETWEEN $2 AND $3`,
    [cabinetId, FROM, TO]
  );
  const { rows: [adRow] } = await roPool.query(
    `SELECT COALESCE(SUM(ad_spend),0) AS s
     FROM tenant.ozon_daily_efficiency
     WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date AND ad_spend IS NOT NULL`,
    [cabinetId, FROM, TO]
  );
  const { rows: cabinetCostRows } = await roPool.query(
    `SELECT COALESCE(SUM(amount),0) AS s
     FROM tenant.ozon_cabinet_costs
     WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date`,
    [cabinetId, FROM, TO]
  );

  const indRevenue = num(rawRow.revenue);
  const indRawProfit = num(rawRow.profit);
  const indAdSpend = num(adRow.s);
  const indExpenses = num(rawRow.cogs) + num(rawRow.commission) + num(rawRow.logistics) + num(rawRow.acquiring) + num(rawRow.loyalty) + indAdSpend;
  const indTax = calcTotalTax(taxMode, indRevenue, indExpenses).total;
  const indCabinetSignedSum = num(cabinetCostRows[0].s); // Ozon: сырой знак = знак канона (без инверсии)
  const indProfit = Math.round((indRawProfit - indAdSpend - indTax + indCabinetSignedSum) * 100) / 100;

  verdict(
    `Ozon кабинет ${cabinetId}: ozProfitCabinet.profit = независимый SQL (Σ order_costs.profit − ad_spend − налог + Σ cabinetCosts)`,
    Math.abs(canon.profit - indProfit) <= TOL,
    `канон=${fmtRub(canon.profit)}, независимо=${fmtRub(indProfit)}, разница=${fmtRub(canon.profit - indProfit)} `
    + `[SUM(order_costs.profit)=${fmtRub(indRawProfit)}, ad_spend=${fmtRub(indAdSpend)}, налог=${fmtRub(indTax)}, ΣcabinetCosts=${fmtRub(indCabinetSignedSum)}]`
  );
}

async function checkWb(cabinetId, taxMode) {
  const canon = await withTenant(cabinetId, async () => {
    const db = new DatabaseSync('wb', { readOnly: true });
    return wbProfitCabinet(db, taxMode, { cabinetId, from: FROM, to: TO });
  });

  const { rows: [rawRow] } = await roPool.query(
    `SELECT
       COALESCE(SUM(cost_value_withdisc),0) AS revenue,
       COALESCE(SUM(cost_value_retail),0) AS realized,
       COALESCE(SUM(cost_value_pay),0) AS payout,
       COALESCE(SUM(cost),0) AS cogs,
       COALESCE(SUM(logistics),0) AS logistics,
       COALESCE(SUM(profit),0) AS profit
     FROM tenant.wb_order_costs
     WHERE cabinet_id = $1
       AND substr(COALESCE(sale_dt, return_dt),1,10) BETWEEN $2 AND $3`,
    [cabinetId, FROM, TO]
  );
  const { rows: [adRow] } = await roPool.query(
    `SELECT COALESCE(SUM(ad_spend),0) AS s
     FROM tenant.wb_daily_metrics
     WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date AND ad_spend IS NOT NULL`,
    [cabinetId, FROM, TO]
  );
  const { rows: cabinetCostRows } = await roPool.query(
    `SELECT COALESCE(SUM(amount),0) AS s
     FROM tenant.wb_cabinet_costs
     WHERE cabinet_id = $1 AND period_from <= $3::date AND period_to >= $2::date`,
    [cabinetId, FROM, TO]
  );

  // ⚠️ Переезд 06.09.2026 («выручка WB по цене со скидкой продавца»):
  // налоговая база WB — WB_TAX_BASE = "realized" (Σ cost_value_retail), в
  // расходы входит нетто-вознаграждение WB (Σ cost_value_retail −
  // Σ cost_value_pay). До переезда база была Σ cost_value_pay без
  // commission — если константу в lib/wbMetrics.js переключат обратно,
  // здесь надо править синхронно (иначе строка упадёт на разницу налога).
  const indRealized = num(rawRow.realized);
  const indCommission = Math.round((indRealized - num(rawRow.payout)) * 100) / 100;
  const indRawProfit = num(rawRow.profit);
  const indAdSpend = num(adRow.s);
  const indExpenses = num(rawRow.cogs) + num(rawRow.logistics) + indAdSpend + indCommission;
  const indTax = calcTotalTax(taxMode, indRealized, indExpenses).total;
  const indCabinetSignedSum = -num(cabinetCostRows[0].s); // WB: сырой знак ПРОТИВОПОЛОЖЕН — канон инвертирует (см. wbProfitCabinet)
  const indProfit = Math.round((indRawProfit - indAdSpend - indTax + indCabinetSignedSum) * 100) / 100;

  verdict(
    `WB кабинет ${cabinetId}: wbProfitCabinet.profit = независимый SQL (Σ order_costs.profit − ad_spend − налог + Σ cabinetCosts)`,
    Math.abs(canon.profit - indProfit) <= TOL,
    `канон=${fmtRub(canon.profit)}, независимо=${fmtRub(indProfit)}, разница=${fmtRub(canon.profit - indProfit)} `
    + `[SUM(order_costs.profit)=${fmtRub(indRawProfit)}, ad_spend=${fmtRub(indAdSpend)}, налог=${fmtRub(indTax)} (база realized=${fmtRub(indRealized)}, расходы вкл. commission=${fmtRub(indCommission)}), ΣcabinetCosts=${fmtRub(indCabinetSignedSum)}]`
  );

  // Выручка кабинета — отдельная строка сверки: канон обязан отдавать Σ
  // cost_value_withdisc (переезд 06.09.2026), а не «к перечислению».
  const indRevenue = num(rawRow.revenue);
  verdict(
    `WB кабинет ${cabinetId}: wbProfitCabinet.revenue = независимый SQL (Σ cost_value_withdisc — цена со скидкой продавца)`,
    Math.abs(num(canon.revenue) - indRevenue) <= TOL,
    `канон=${fmtRub(num(canon.revenue))}, независимо=${fmtRub(indRevenue)}, разница=${fmtRub(num(canon.revenue) - indRevenue)} `
    + `[realized=${fmtRub(indRealized)}, payout=${fmtRub(num(rawRow.payout))}]`
  );
}

try {
  console.log(`Перекрёстный сторож канона прибыли — период ${FROM}..${TO} (прошлая ISO-неделя, если не задано --from/--to)`);
  console.log('');

  const shops = await query(
    `SELECT mp_code, cabinet_id, tax_mode FROM auth.shops WHERE is_active = true ORDER BY mp_code, cabinet_id`
  );
  if (shops.length === 0) {
    console.log('⚠️ auth.shops не вернул ни одного активного магазина — нечего проверять.');
  }
  for (const shop of shops) {
    const taxMode = normalizeTaxMode(shop.tax_mode || null);
    if (shop.mp_code === 'ozon') {
      await checkOzon(shop.cabinet_id, taxMode);
    } else if (shop.mp_code === 'wb') {
      await checkWb(shop.cabinet_id, taxMode);
    }
  }
  console.log('');
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.stack || e.message}`);
  await roPool.end().catch(() => {});
  process.exit(3);
} finally {
  await roPool.end().catch(() => {});
}

if (rows === 0) {
  console.log('НЕЧЕГО ПРОВЕРЯТЬ — активных магазинов не найдено (auth.shops).');
  process.exit(1);
} else if (failures === 0) {
  console.log(`ALL PASS — ${rows} строк(и), канон profitCabinet сходится с независимым SQL в пределах ${TOL} ₽ на всех активных магазинах.`);
  process.exit(0);
} else {
  console.log(`ИТОГО ${failures} ИЗ ${rows} РАСХОЖДЕНИЕ(Й) — см. строки выше.`);
  process.exit(1);
}
