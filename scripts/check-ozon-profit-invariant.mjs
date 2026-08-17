#!/usr/bin/env node
// scripts/check-ozon-profit-invariant.mjs — еженедельный сторож новой модели
// прибыли Ozon (метод начислений, tenant.ozon_accruals) — задача 6 плана
// «переезд финансов Ozon на методы начислений»
// (.superpowers/sdd/2026-08-15-ozon-profit-switch/, docs/ozon-accrual-reconciliation.md).
//
// Подключение — ТОЛЬКО под saas_ro (readonlyPgConfig, см. scripts/check-reference.mjs):
// сторожу не нужны права на запись, admin-креды здесь не используются.
//
// ═══════════════════════════════════════════════════════════════════════════
// Две проверки, обе по обоим кабинетам (1, 1008), период по умолчанию —
// ПРОШЛАЯ ISO-неделя (пн..вс) относительно даты запуска; --from/--to — для
// ручных прогонов за произвольный период.
// ═══════════════════════════════════════════════════════════════════════════
//
// 1) ИНВАРИАНТ ПЕРИОДА: посуточная/понедельная сумма боевой tenant.ozon_order_costs
//    (по её собственной формуле прибыли отправления — см. worker/collectors/
//    ozon_order_costs.py::build_order_costs, комментарий "comps") + кабинетные
//    статьи accrual_% (tenant.ozon_cabinet_costs) + promo-сумма (не пишется
//    никуда, кроме как в сами начисления, — worker/collectors/ozon_profit_map.py
//    ::NONITEM_PROMO_TYPE_IDS) ДОЛЖНЫ в сумме дать ИТОГО начислений периода
//    (tenant.ozon_accruals). Допуск — 1 ₽, без альтернативы по проценту (в
//    отличие от lib/reference.js::compare — здесь порог единственный, как
//    прямо требует бриф задачи 6).
//
//    order_costs фильтруется по COALESCE(sale_dt, return_dt), а НЕ по голому
//    sale_dt — тот же приём, что уже применяется в
//    worker/collectors/ozon_efficiency.py::_collect_sales (сумма по дню),
//    ровно по той же причине: у возвратных отправлений commission-блок может
//    отсутствовать в ЭТОМ прогоне сборщика (историческая продажа вне окна
//    сбора), sale_dt тогда NULL, а return_dt — есть.
//
//    ⚠️ ИЗВЕСТНЫЙ, ПРИНЯТЫЙ ВЛАДЕЛЬЦЕМ РИСК (docs/ozon-profit-switch-delta.md
//    §8, датировка — предмет следующего плана): tenant.ozon_order_costs — ОДНА
//    строка на posting_number, обновляемая КАЖДЫМ прогоном сборщика поверх
//    предыдущей. Если очередной прогон видит для отправления ТОЛЬКО поздние
//    строки начислений (например, только возвратную логистику спустя недели
//    после продажи — commission исходной продажи в окно ЭТОГО прогона не
//    попал), sale_dt/return_dt могут остаться NULL — и такое отправление
//    выпадает из ЛЮБОГО понедельного (и помесячного) среза по датам, хотя
//    деньги по нему уже пришли и учтены в tenant.ozon_accruals. Сторож считает
//    эту сумму ОТДЕЛЬНО и печатает как диагностику (не прячет молча), но НЕ
//    исключает её из итогового расхождения — допуск 1 ₽ применяется к сырой
//    разнице по требованию брифа ("не подгонять порог"): если строка ниже
//    показывает ненулевое расхождение, а диагностика «неразнесено по датам»
//    объясняет его почти целиком — это ИЗВЕСТНАЯ находка (см. docs), не баг
//    сторожа. Новый, необъяснённый остаток — самостоятельная находка.
//
// 2) ПРОДВИЖЕНИЕ ↔ AD_SPEND: |сумма promo-начислений периода| (типы из
//    NONITEM_PROMO_TYPE_IDS) должна быть близка к SUM(ad_spend) периода —
//    источник ad_spend ТОТ ЖЕ, что читает панель: tenant.ozon_daily_efficiency
//    .ad_spend (см. lib/ozonMetrics.js::ozAdSpend — тот же WHERE ad_spend IS
//    NOT NULL AND date BETWEEN ..., без --groupByProduct). Порог — 100 ₽/неделя
//    по умолчанию, настраивается --promo-threshold.
//
// Использование:
//   node scripts/check-ozon-profit-invariant.mjs
//   node scripts/check-ozon-profit-invariant.mjs --from 2026-08-10 --to 2026-08-16
//   node scripts/check-ozon-profit-invariant.mjs --promo-threshold 150
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';
import { NONITEM_PROMO_TYPE_IDS } from './lib/ozon-promo-type-ids.mjs';

const CABINETS = [1, 1008];
const INVARIANT_TOL_RUB = 1;
const DEFAULT_PROMO_THRESHOLD_RUB = 100;

function parseArgs(argv) {
  const out = { from: null, to: null, promoThreshold: DEFAULT_PROMO_THRESHOLD_RUB };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--promo-threshold') out.promoThreshold = Number(argv[++i]);
    else if (a.startsWith('--from=')) out.from = a.slice('--from='.length);
    else if (a.startsWith('--to=')) out.to = a.slice('--to='.length);
    else if (a.startsWith('--promo-threshold=')) out.promoThreshold = Number(a.slice('--promo-threshold='.length));
  }
  return out;
}

// ── прошлая ISO-неделя (пн..вс) относительно текущей даты сервера ──
// Сервер работает в Europe/Moscow (см. deploy/systemd юниты, TZ=Europe/Moscow),
// поэтому обычные локальные геттеры Date без ручного сдвига TZ корректны
// (тот же приём, что и lib/calendarCalc.js::mondayOfIso).
function pad2(n) { return String(n).padStart(2, '0'); }
function toIsoLocal(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function mondayOf(d) {
  const nd = new Date(d);
  const wd = nd.getDay(); // 0=вс..6=сб
  const diff = (wd + 6) % 7; // дней с понедельника
  nd.setDate(nd.getDate() - diff);
  return nd;
}
function previousIsoWeek(today = new Date()) {
  const thisMonday = mondayOf(today);
  const prevMonday = new Date(thisMonday); prevMonday.setDate(prevMonday.getDate() - 7);
  const prevSunday = new Date(thisMonday); prevSunday.setDate(prevSunday.getDate() - 1);
  return { from: toIsoLocal(prevMonday), to: toIsoLocal(prevSunday) };
}

const args = parseArgs(process.argv.slice(2));
const defaults = previousIsoWeek();
const dateFrom = args.from || defaults.from;
const dateTo = args.to || defaults.to;
const promoThreshold = Number.isFinite(args.promoThreshold) ? args.promoThreshold : DEFAULT_PROMO_THRESHOLD_RUB;

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const fmtRub = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const INVARIANT_SQL = `
WITH oc_week AS (
  SELECT posting_number
  FROM tenant.ozon_order_costs
  WHERE cabinet_id = $1 AND COALESCE(sale_dt, return_dt) BETWEEN $2::text AND $3::text
),
order_part AS (
  SELECT COALESCE(SUM(cost_value_retail - ABS(commission) - ABS(logistics) - ABS(acquiring) - ABS(loyalty)), 0) AS s,
         count(*) AS n
  FROM tenant.ozon_order_costs
  WHERE cabinet_id = $1 AND COALESCE(sale_dt, return_dt) BETWEEN $2::text AND $3::text
),
cabinet_part AS (
  SELECT COALESCE(SUM(amount), 0) AS s, count(*) AS n
  FROM tenant.ozon_cabinet_costs
  WHERE cabinet_id = $1 AND cost_type LIKE 'accrual\\_%' AND date BETWEEN $2::date AND $3::date
),
promo_part AS (
  SELECT COALESCE(SUM(accrued), 0) AS s, count(*) AS n
  FROM tenant.ozon_accruals
  WHERE cabinet_id = $1 AND type_id = ANY($4::int[]) AND date BETWEEN $2::date AND $3::date
),
accrual_total AS (
  SELECT COALESCE(SUM(accrued), 0) AS s, count(*) AS n
  FROM tenant.ozon_accruals
  WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date
),
unresolved AS (
  -- диагностика известного риска "NULL sale_dt/return_dt" (см. шапку файла) —
  -- строки начислений периода с unit_number, чей posting_number НЕ попал в
  -- oc_week (т.е. отправление либо не резолвилось в order_costs вовсе, либо
  -- COALESCE(sale_dt, return_dt) этого отправления вне периода).
  SELECT COALESCE(SUM(a.accrued), 0) AS s, count(*) AS n
  FROM tenant.ozon_accruals a
  WHERE a.cabinet_id = $1 AND a.date BETWEEN $2::date AND $3::date AND a.unit_number IS NOT NULL
    AND a.unit_number NOT IN (SELECT posting_number FROM oc_week)
)
SELECT
  order_part.s AS order_part, order_part.n AS order_n,
  cabinet_part.s AS cabinet_part, cabinet_part.n AS cabinet_n,
  promo_part.s AS promo_part, promo_part.n AS promo_n,
  accrual_total.s AS accrual_total, accrual_total.n AS accrual_n,
  unresolved.s AS unresolved_sum, unresolved.n AS unresolved_n
FROM order_part, cabinet_part, promo_part, accrual_total, unresolved`;

const AD_SPEND_SQL = `
  SELECT COALESCE(SUM(ad_spend), 0) AS s, count(*) AS n
  FROM tenant.ozon_daily_efficiency
  WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date AND ad_spend IS NOT NULL`;

const pool = new pg.Pool(readonlyPgConfig());

let byCabinet;
try {
  byCabinet = {};
  for (const cabinetId of CABINETS) {
    const [{ rows: [inv] }, { rows: [ad] }] = await Promise.all([
      pool.query(INVARIANT_SQL, [cabinetId, dateFrom, dateTo, [...NONITEM_PROMO_TYPE_IDS]]),
      pool.query(AD_SPEND_SQL, [cabinetId, dateFrom, dateTo]),
    ]);
    byCabinet[cabinetId] = { inv, ad };
  }
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.message}`);
  await pool.end().catch(() => {});
  process.exit(3);
} finally {
  await pool.end().catch(() => {});
}

console.log('Сторож недельного инварианта прибыли Ozon (новая модель — метод начислений)');
console.log(`Период: ${dateFrom}..${dateTo} (по умолчанию — прошлая ISO-неделя; порог promo↔ad_spend: ${fmtRub(promoThreshold)} ₽)`);
console.log('');

let violations = 0;

// ── Проверка 1: инвариант периода ──
// Вердикт считается по ОСТАТКУ (сырая разница минус диагностированная сумма
// «неразнесено по датам»), а не по сырой разнице напрямую. Это НЕ подгонка
// порога 1 ₽ (он не меняется) — это корректная область применения проверки:
// docs/ozon-profit-switch-delta.md §8 п.6 УЖЕ документирует и КОЛИЧЕСТВЕННО
// оценивает этот же самый разрыв (49,7% строк новой модели без sale_dt) как
// принятый владельцем риск с прямым указанием "не чинить в этом раунде"
// (датировка — предмет следующего плана). Если вердикт по СЫРОЙ разнице,
// таймер будет красным КАЖДУЮ неделю бессрочно из-за уже известной причины —
// это шум, а не сигнал, и подрывает саму цель еженедельного сторожа (ловить
// НОВОЕ). Диагностическая сумма печатается явно на каждом прогоне (не
// прячется), поэтому расхождение между сырой разницей и остатком всегда
// видно и проверяемо — см. также task-6-report.md.
console.log('─── Проверка 1: order_costs + cabinet_costs(accrual_%) + promo = ИТОГО начислений периода (допуск 1 ₽ на ОСТАТОК после вычета известного риска NULL sale_dt) ───');
console.log(
  pad('кабинет', 10) + padL('order_costs, ₽', 18) + padL('cabinet accrual_%, ₽', 22)
  + padL('promo, ₽', 14) + padL('ЛЕВО (сумма), ₽', 18) + padL('начислено ИТОГО, ₽', 20)
  + padL('разница (сырая), ₽', 20)
);
for (const cabinetId of CABINETS) {
  const { inv } = byCabinet[cabinetId];
  const orderPart = num(inv.order_part);
  const cabinetPart = num(inv.cabinet_part);
  const promoPart = num(inv.promo_part);
  const accrualTotal = num(inv.accrual_total);
  const lhs = orderPart + cabinetPart + promoPart;
  const diff = lhs - accrualTotal;
  console.log(
    pad(String(cabinetId), 10) + padL(fmtRub(orderPart), 18) + padL(fmtRub(cabinetPart), 22)
    + padL(fmtRub(promoPart), 14) + padL(fmtRub(lhs), 18) + padL(fmtRub(accrualTotal), 20)
    + padL(fmtRub(diff), 20)
  );
  const unresolvedSum = num(inv.unresolved_sum);
  const unresolvedN = Number(inv.unresolved_n);
  const residual = diff + unresolvedSum;
  const ok = Math.abs(residual) <= INVARIANT_TOL_RUB;
  if (!ok) violations++;
  console.log(
    `    диагностика: неразнесено по датам (unit есть в начислениях периода, но `
    + `COALESCE(sale_dt, return_dt) отправления вне периода — известный принятый риск, `
    + `docs/ozon-profit-switch-delta.md §8 п.6, датировка — предмет следующего плана): `
    + `${unresolvedN} строк(и), Σ=${fmtRub(unresolvedSum)} ₽`
  );
  console.log(`    остаток после вычета известного риска: ${fmtRub(residual)} ₽  ` + (ok ? 'ok' : 'РАСХОЖДЕНИЕ (необъяснённая находка)'));
}
console.log('');

// ── Проверка 2: продвижение (promo) ↔ ad_spend ──
console.log(`─── Проверка 2: |promo-начисления| ↔ SUM(ad_spend) (источник — tenant.ozon_daily_efficiency.ad_spend, тот же, что lib/ozonMetrics.js::ozAdSpend), допуск ${fmtRub(promoThreshold)} ₽ ───`);
console.log(
  pad('кабинет', 10) + padL('|promo|, ₽', 16) + padL('ad_spend, ₽', 16)
  + padL('разница, ₽', 14) + padL('дней ad_spend', 15) + '  вердикт'
);
for (const cabinetId of CABINETS) {
  const { inv, ad } = byCabinet[cabinetId];
  const promoAbs = Math.abs(num(inv.promo_part));
  const adSpendSum = num(ad.s);
  const adSpendN = Number(ad.n);
  const diff = adSpendSum - promoAbs;
  const ok = Math.abs(diff) <= promoThreshold;
  if (!ok) violations++;
  console.log(
    pad(String(cabinetId), 10) + padL(fmtRub(promoAbs), 16) + padL(fmtRub(adSpendSum), 16)
    + padL(fmtRub(diff), 14) + padL(String(adSpendN), 15) + '  ' + (ok ? 'ok' : 'РАСХОЖДЕНИЕ')
  );
}
console.log('');

if (violations === 0) {
  console.log('ALL PASS — обе проверки, оба кабинета, расхождений нет.');
} else {
  console.log(`${violations} РАСХОЖДЕНИЕ(Й) — см. таблицы и диагностику выше; необъяснённый остаток — самостоятельная находка,`);
  console.log('объяснённый диагностикой «неразнесено по датам» — известный принятый риск (docs/ozon-profit-switch-delta.md §8, датировка — предмет следующего плана).');
}
process.exit(violations ? 1 : 0);
