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
// Три проверки, все по обоим кабинетам (1, 1008), СКОЛЬЗЯЩЕЕ ОКНО из 4
// последних ЗАКРЫТЫХ ISO-недель (пн..вс) по умолчанию (задача 4 плана
// «ремонт данных прибыли Ozon», .superpowers/sdd/2026-08-17-ozon-data-repair/
// task-4-brief.md) — раньше сторож смотрел только на прошлую неделю и не
// замечал бы регресс, случившийся 2-3 недели назад и с тех пор не
// повторившийся. Каждая неделя окна печатает СВОЙ блок (обе проверки, оба
// кабинета) и вносит СВОЙ вклад в итоговый exit-код — одна плохая неделя не
// теряется в общем «ALL PASS» по последней. `--weeks N` меняет размер окна
// для ручных прогонов (например, --weeks 8 для повторной калибровки порога
// проверки 2). `--from`/`--to` — старый режим: ОДИН произвольный период
// вместо окна (для точечного разбора конкретной находки).
// ═══════════════════════════════════════════════════════════════════════════
//
// 1) ИНВАРИАНТ ПЕРИОДА: сумма боевой tenant.ozon_order_costs (по её
//    собственной формуле прибыли отправления — см. worker/collectors/
//    ozon_order_costs.py::build_order_costs, комментарий "comps") + кабинетные
//    статьи accrual_% (tenant.ozon_cabinet_costs) + promo-сумма (не пишется
//    никуда, кроме как в сами начисления, — worker/collectors/ozon_profit_map.py
//    ::NONITEM_PROMO_TYPE_IDS) ДОЛЖНЫ в сумме дать ИТОГО начислений периода
//    (tenant.ozon_accruals). Допуск — 1 ₽, без альтернативы по проценту (в
//    отличие от lib/reference.js::compare — здесь порог единственный, как
//    прямо требует бриф задачи 6) — но применяется к ОСТАТКУ после вычета
//    диагностированной суммы «неразнесено по датам недели» (см. ниже и
//    проверку 2), а не к сырой разнице напрямую.
//
//    order_costs фильтруется по COALESCE(sale_dt, return_dt), а НЕ по голому
//    sale_dt — тот же приём, что уже применяется в
//    worker/collectors/ozon_efficiency.py::_collect_sales (сумма по дню),
//    ровно по той же причине: у возвратных отправлений commission-блок может
//    отсутствовать в ЭТОМ прогоне сборщика (историческая продажа вне окна
//    сбора), sale_dt тогда NULL, а return_dt — есть.
//
//    ⚠️ «Неразнесено по датам недели» — НЕ один феномен, а ТРИ разных (см.
//    SQL ниже, CTE `detail`), только внешне похожих тем, что каждый уводит
//    деньги начислений мимо ЭТОЙ конкретной недели order_costs:
//      • `null_date` — у отправления есть строка tenant.ozon_order_costs, но
//        COALESCE(sale_dt, return_dt) = NULL. Это ИМЕННО известный, принятый
//        владельцем риск docs/ozon-profit-switch-delta.md §8 п.6 (~половина
//        строк новой модели без даты продажи, датировка — предмет следующего
//        плана): tenant.ozon_order_costs — одна строка на posting_number,
//        перезаписываемая каждым прогоном сборщика; если прогон видит только
//        поздние строки без исходного блока commission, дата остаётся NULL.
//      • `other_period` — у отправления есть строка И дата резолвится, но эта
//        дата попадает в ДРУГУЮ неделю/период, а не в проверяемый (обычный
//        межпериодный «выход» — например, упаковка отправления начислена на
//        несколько дней раньше даты продажи, или корректировка/сторно — на
//        несколько дней позже даты возврата). Это НЕ то же самое, что
//        «неизвестная» находка §8 п.6 — деньги учтены, просто в соседнем
//        периоде; естественный шум понедельной нарезки таблицы, где 1 строка
//        хранит ВСЮ историю отправления, а не только события своей недели.
//      • `no_row` — у отправления вообще нет строки tenant.ozon_order_costs
//        (не резолвилось сборщиком целиком — например, SKU не найден в
//        каталоге, см. риск §7 docs/ozon-profit-switch-delta.md). ПОИСК
//        строки — по COALESCE(oc.src_unit_number, oc.posting_number), а не
//        по голому posting_number (задача 4 плана 2026-08-17-ozon-data-
//        repair, компонент 4 спеки): сборщик задачи 3 умеет резолвить
//        posting_number (переписывать номер отправления по каталогу), из-за
//        чего он расходится с СЫРЫМ unit_number начислений, по которому
//        реально ключуется detail-JOIN. Колонка `src_unit_number` (миграция
//        042) хранит именно сырой номер — до полного пересчёта задачи 5 она
//        заполнена только у строк, пересобранных после 2026-08-17 19:00 UTC,
//        поэтому JOIN обязан деградировать честно к posting_number через
//        COALESCE, а не требовать src_unit_number NOT NULL. После пересчёта
//        задачи 5 (когда колонка заполнена везде) `no_row` перестанет ложно
//        ловить резолвленные номера — сейчас часть строк ещё может числиться
//        `no_row`, хотя строка order_costs физически есть, просто под старым
//        (нерезолвленным) индексированием.
//    Раньше эти три категории печатались одной суммой под общей подписью
//    «известный риск NULL sale_dt» — неточно (ревью задачи 6, Minor): запрос
//    шире одного феномена. Теперь разложены и подписаны честно.
//
// 2) РОСТ «НЕРАЗНЕСЕНО ПО ДАТАМ НЕДЕЛИ» (задача 6, ре-ревью — Important):
//    проверка 1 гасит СУММУ «неразнесено» в остатке КАЖДЫЙ прогон — если сама
//    эта категория вдруг вырастет (например, из-за НОВОГО бага, оставляющего
//    больше дат NULL), проверка 1 всё равно останется зелёной, пока остаток
//    < 1 ₽: рост незаметен без ручного чтения диагностики. Эта проверка ловит
//    рост АВТОМАТИЧЕСКИ, отдельным ненулевым exit.
//
//    Порог — ДОЛЯ |неразнесено| от |ИТОГО начислений недели|, а не абсолютный
//    ₽/неделю: калибровка на 8 последних ISO-неделях (оба кабинета, 16
//    точек, скрипт калибровки — см. task-6-fix-report.md) показала недельный
//    ИТОГО начислений колеблется в 100+ раз (от ~2 тыс. ₽ до ~290 тыс. ₽,
//    кабинет 1) — абсолютный ₽-потолок пришлось бы либо подгонять под самую
//    крупную неделю (и тогда он ничего не поймает на мелких), либо он бы
//    постоянно горел на крупных. Доля устойчива к этому масштабированию.
//    Тренд к предыдущей неделе (третий вариант из ревью) отклонён: доля САМА
//    ПО СЕБЕ скачет на порядок между соседними неделями даже без всякого бага
//    (кабинет 1008: 1,87% → 32,08% → 20,31% → 5,44% — 17-кратный скачок,
//    естественный, не находка) — «выросло вдвое к прошлой неделе» в этих
//    данных НЕ является сигналом, только шум.
//    Калибровка (8 недель × 2 кабинета = 16 точек, доля от ИТОГО): среднее
//    9,66%, максимум наблюдённый 32,08% (кабинет 1008, 2026-06-29..07-05).
//    Порог по умолчанию — 40% (заметный запас над наблюдённым максимумом,
//    ни одна из 16 калибровочных недель не задела бы его; не «бесполезно
//    широкий» — переход за него означает, что БОЛЬШЕ ТРЕТИ денег недели
//    выпали из датировки, качественно другой масштаб, чем что-либо
//    наблюдённое). Настраивается `--unresolved-threshold-pct`. Дополнительно
//    `--unresolved-floor-rub` (по умолчанию 1000 ₽) — доля не проверяется,
//    если |неразнесено| меньше пола: на мелких неделях (несколько тысяч ₽
//    ИТОГО) доля неустойчива и шумит без денежной значимости.
//
// 3) ПРОДВИЖЕНИЕ ↔ AD_SPEND: |сумма promo-начислений периода| (типы из
//    NONITEM_PROMO_TYPE_IDS) должна быть близка к SUM(ad_spend) периода —
//    источник ad_spend ТОТ ЖЕ, что читает панель: tenant.ozon_daily_efficiency
//    .ad_spend (см. lib/ozonMetrics.js::ozAdSpend — тот же WHERE ad_spend IS
//    NOT NULL AND date BETWEEN ..., без --groupByProduct). Порог — 100 ₽/неделя
//    по умолчанию, настраивается --promo-threshold.
//
// Использование:
//   node scripts/check-ozon-profit-invariant.mjs                     (окно — 4 последние закрытые ISO-недели)
//   node scripts/check-ozon-profit-invariant.mjs --weeks 8           (окно — 8 недель, напр. для перекалибровки)
//   node scripts/check-ozon-profit-invariant.mjs --from 2026-08-10 --to 2026-08-16   (один произвольный период вместо окна)
//   node scripts/check-ozon-profit-invariant.mjs --promo-threshold 150
//   node scripts/check-ozon-profit-invariant.mjs --unresolved-threshold-pct 30 --unresolved-floor-rub 500
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';
import { NONITEM_PROMO_TYPE_IDS } from './lib/ozon-promo-type-ids.mjs';

const CABINETS = [1, 1008];
const INVARIANT_TOL_RUB = 1;
const DEFAULT_PROMO_THRESHOLD_RUB = 100;
const DEFAULT_UNRESOLVED_THRESHOLD_PCT = 40;
const DEFAULT_UNRESOLVED_FLOOR_RUB = 1000;
const DEFAULT_WEEKS = 4;

function parseArgs(argv) {
  const out = {
    from: null, to: null, weeks: DEFAULT_WEEKS,
    promoThreshold: DEFAULT_PROMO_THRESHOLD_RUB,
    unresolvedThresholdPct: DEFAULT_UNRESOLVED_THRESHOLD_PCT,
    unresolvedFloorRub: DEFAULT_UNRESOLVED_FLOOR_RUB,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--weeks') out.weeks = Number(argv[++i]);
    else if (a === '--promo-threshold') out.promoThreshold = Number(argv[++i]);
    else if (a === '--unresolved-threshold-pct') out.unresolvedThresholdPct = Number(argv[++i]);
    else if (a === '--unresolved-floor-rub') out.unresolvedFloorRub = Number(argv[++i]);
    else if (a.startsWith('--from=')) out.from = a.slice('--from='.length);
    else if (a.startsWith('--to=')) out.to = a.slice('--to='.length);
    else if (a.startsWith('--weeks=')) out.weeks = Number(a.slice('--weeks='.length));
    else if (a.startsWith('--promo-threshold=')) out.promoThreshold = Number(a.slice('--promo-threshold='.length));
    else if (a.startsWith('--unresolved-threshold-pct=')) out.unresolvedThresholdPct = Number(a.slice('--unresolved-threshold-pct='.length));
    else if (a.startsWith('--unresolved-floor-rub=')) out.unresolvedFloorRub = Number(a.slice('--unresolved-floor-rub='.length));
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
// ── скользящее окно из N последних ЗАКРЫТЫХ ISO-недель, хронологически
// (старая → новая), последняя элемента == previousIsoWeek() ──
function lastClosedIsoWeeks(n, today = new Date()) {
  const thisMonday = mondayOf(today);
  const weeks = [];
  for (let i = n; i >= 1; i--) {
    const monday = new Date(thisMonday); monday.setDate(monday.getDate() - 7 * i);
    const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
    weeks.push({ from: toIsoLocal(monday), to: toIsoLocal(sunday) });
  }
  return weeks;
}

const args = parseArgs(process.argv.slice(2));
const promoThreshold = Number.isFinite(args.promoThreshold) ? args.promoThreshold : DEFAULT_PROMO_THRESHOLD_RUB;
const unresolvedThresholdPct = Number.isFinite(args.unresolvedThresholdPct) ? args.unresolvedThresholdPct : DEFAULT_UNRESOLVED_THRESHOLD_PCT;
const unresolvedFloorRub = Number.isFinite(args.unresolvedFloorRub) ? args.unresolvedFloorRub : DEFAULT_UNRESOLVED_FLOOR_RUB;

// --from/--to заданы вручную → ОДИН период вместо окна (точечный разбор);
// иначе — окно из --weeks (по умолчанию 4) последних закрытых ISO-недель.
let periods;
if (args.from || args.to) {
  if (!args.from || !args.to) {
    console.error('--from и --to указываются вместе (или не указываются вовсе — тогда окно из последних закрытых ISO-недель)');
    process.exit(2);
  }
  periods = [{ from: args.from, to: args.to, label: `${args.from}..${args.to} (ручной период)` }];
} else {
  const weeksCount = Number.isFinite(args.weeks) && args.weeks > 0 ? Math.floor(args.weeks) : DEFAULT_WEEKS;
  periods = lastClosedIsoWeeks(weeksCount).map((w) => ({ ...w, label: `${w.from}..${w.to} (ISO-неделя)` }));
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const fmtRub = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const INVARIANT_SQL = `
WITH order_part AS (
  SELECT COALESCE(SUM(cost_value_retail - commission - logistics - acquiring - loyalty), 0) AS s,
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
-- «Неразнесено по датам недели» разложено на 3 честные причины (ревью задачи
-- 6, Minor — раньше одна сумма подписывалась целиком как известный риск §8
-- п.6, хотя запрос шире, см. комментарий в шапке файла):
--   no_row       — у unit_number вообще нет строки tenant.ozon_order_costs;
--   null_date    — строка есть, но COALESCE(sale_dt, return_dt) = NULL
--                  (это и есть §8 п.6);
--   other_period — строка есть, дата резолвится, но не в этот период
--                  (межпериодный сосед, не «неизвестность»).
detail AS (
  SELECT a.accrued,
    CASE
      WHEN oc.posting_number IS NULL THEN 'no_row'
      WHEN COALESCE(oc.sale_dt, oc.return_dt) IS NULL THEN 'null_date'
      ELSE 'other_period'
    END AS reason
  FROM tenant.ozon_accruals a
  LEFT JOIN tenant.ozon_order_costs oc
    ON oc.cabinet_id = a.cabinet_id
   AND COALESCE(oc.src_unit_number, oc.posting_number) = a.unit_number
  WHERE a.cabinet_id = $1 AND a.date BETWEEN $2::date AND $3::date AND a.unit_number IS NOT NULL
    AND (oc.posting_number IS NULL
         OR COALESCE(oc.sale_dt, oc.return_dt) IS NULL
         OR COALESCE(oc.sale_dt, oc.return_dt) NOT BETWEEN $2::text AND $3::text)
),
unresolved AS (
  SELECT
    COALESCE(SUM(accrued), 0) AS s, count(*) AS n,
    COALESCE(SUM(accrued) FILTER (WHERE reason = 'no_row'), 0) AS no_row_s,
    count(*) FILTER (WHERE reason = 'no_row') AS no_row_n,
    COALESCE(SUM(accrued) FILTER (WHERE reason = 'null_date'), 0) AS null_date_s,
    count(*) FILTER (WHERE reason = 'null_date') AS null_date_n,
    COALESCE(SUM(accrued) FILTER (WHERE reason = 'other_period'), 0) AS other_period_s,
    count(*) FILTER (WHERE reason = 'other_period') AS other_period_n
  FROM detail
)
SELECT
  order_part.s AS order_part, order_part.n AS order_n,
  cabinet_part.s AS cabinet_part, cabinet_part.n AS cabinet_n,
  promo_part.s AS promo_part, promo_part.n AS promo_n,
  accrual_total.s AS accrual_total, accrual_total.n AS accrual_n,
  unresolved.s AS unresolved_sum, unresolved.n AS unresolved_n,
  unresolved.no_row_s, unresolved.no_row_n,
  unresolved.null_date_s, unresolved.null_date_n,
  unresolved.other_period_s, unresolved.other_period_n
FROM order_part, cabinet_part, promo_part, accrual_total, unresolved`;

const AD_SPEND_SQL = `
  SELECT COALESCE(SUM(ad_spend), 0) AS s, count(*) AS n
  FROM tenant.ozon_daily_efficiency
  WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date AND ad_spend IS NOT NULL`;

const pool = new pg.Pool(readonlyPgConfig());

console.log('Сторож недельного инварианта прибыли Ozon (новая модель — метод начислений)');
console.log(
  `Окно: ${periods.length} период(ов) — ${periods[0].label} .. ${periods[periods.length - 1].label} `
  + `(пороги: promo↔ad_spend ${fmtRub(promoThreshold)} ₽, доля «неразнесено» `
  + `${unresolvedThresholdPct}% при |Σ| ≥ ${fmtRub(unresolvedFloorRub)} ₽)`
);
console.log('');

let violations = 0;
const periodSummaries = [];

try {
  for (const period of periods) {
    const { from: dateFrom, to: dateTo } = period;
    console.log(`═══ Неделя: ${period.label} ═══`);
    console.log('');

    const byCabinet = {};
    for (const cabinetId of CABINETS) {
      const [{ rows: [inv] }, { rows: [ad] }] = await Promise.all([
        pool.query(INVARIANT_SQL, [cabinetId, dateFrom, dateTo, [...NONITEM_PROMO_TYPE_IDS]]),
        pool.query(AD_SPEND_SQL, [cabinetId, dateFrom, dateTo]),
      ]);
      byCabinet[cabinetId] = { inv, ad };
    }

    let periodViolations = 0;

    // ── Проверка 1: инвариант периода ──
    // Вердикт считается по ОСТАТКУ (сырая разница минус диагностированная сумма
    // «неразнесено по датам недели»), а не по сырой разнице напрямую. Это НЕ
    // подгонка порога 1 ₽ (он не меняется) — это корректная область применения
    // проверки: docs/ozon-profit-switch-delta.md §8 п.6 УЖЕ документирует и
    // количественно оценивает основной вклад в этот разрыв (~половина строк
    // новой модели без sale_dt) как принятый владельцем риск с прямым указанием
    // "не чинить в этом раунде" (датировка — предмет следующего плана). Если
    // вердикт по СЫРОЙ разнице, таймер будет красным КАЖДУЮ неделю бессрочно из-
    // за уже известной причины — шум, а не сигнал, подрывающий саму цель
    // еженедельного сторожа (ловить НОВОЕ). Рост самой суммы «неразнесено» —
    // отдельная проверка 2 ниже (ловит именно то, что эта проверка маскирует).
    console.log('─── Проверка 1: order_costs + cabinet_costs(accrual_%) + promo = ИТОГО начислений периода (допуск 1 ₽ на ОСТАТОК после вычета «неразнесено по датам недели») ───');
    console.log(
      pad('кабинет', 10) + padL('order_costs, ₽', 18) + padL('cabinet accrual_%, ₽', 22)
      + padL('promo, ₽', 14) + padL('ЛЕВО (сумма), ₽', 18) + padL('начислено ИТОГО, ₽', 20)
      + padL('разница (сырая), ₽', 20)
    );
    const perCabinet = {};
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
      const noRowSum = num(inv.no_row_s), noRowN = Number(inv.no_row_n);
      const nullDateSum = num(inv.null_date_s), nullDateN = Number(inv.null_date_n);
      const otherPeriodSum = num(inv.other_period_s), otherPeriodN = Number(inv.other_period_n);
      perCabinet[cabinetId] = { accrualTotal, unresolvedSum, unresolvedN, noRowSum, noRowN, nullDateSum, nullDateN, otherPeriodSum, otherPeriodN };

      const residual = diff + unresolvedSum;
      const ok = Math.abs(residual) <= INVARIANT_TOL_RUB;
      if (!ok) periodViolations++;
      console.log(
        `    неразнесено по датам недели (unit есть в начислениях периода, но не попал в order_costs `
        + `этой недели): ${unresolvedN} строк(и), Σ=${fmtRub(unresolvedSum)} ₽ — из них:`
      );
      console.log(
        `      • null_date (нет sale_dt/return_dt — известный принятый риск, docs/ozon-profit-switch-delta.md `
        + `§8 п.6, датировка — предмет следующего плана): ${nullDateN} строк(и), Σ=${fmtRub(nullDateSum)} ₽`
      );
      console.log(
        `      • other_period (дата резолвится, но в другом периоде — межпериодный сосед, не находка): `
        + `${otherPeriodN} строк(и), Σ=${fmtRub(otherPeriodSum)} ₽`
      );
      console.log(
        `      • no_row (нет строки order_costs вовсе): ${noRowN} строк(и), Σ=${fmtRub(noRowSum)} ₽`
      );
      console.log(`    остаток после вычета: ${fmtRub(residual)} ₽  ` + (ok ? 'ok' : 'РАСХОЖДЕНИЕ (необъяснённая находка)'));
    }
    console.log('');

    // ── Проверка 2: рост доли «неразнесено по датам недели» ──
    // Автоматическая проверка САМОЙ суммы «неразнесено» (не остатка после её
    // вычета, как в проверке 1) — иначе рост этой категории (в т.ч. из-за
    // нового бага, оставляющего больше дат NULL) остаётся незамеченным сторожем,
    // пока продолжает полностью гаситься в остатке проверки 1. Порог и его
    // калибровка — см. комментарий в шапке файла.
    console.log(`─── Проверка 2: доля «неразнесено по датам недели» от ИТОГО начислений — допуск ${unresolvedThresholdPct}% (при |Σ| ≥ ${fmtRub(unresolvedFloorRub)} ₽, иначе не проверяется) ───`);
    console.log(
      pad('кабинет', 10) + padL('неразнесено, ₽', 18) + padL('ИТОГО начислений, ₽', 22)
      + padL('доля, %', 12) + '  вердикт'
    );
    for (const cabinetId of CABINETS) {
      const { accrualTotal, unresolvedSum } = perCabinet[cabinetId];
      const absUnresolved = Math.abs(unresolvedSum);
      const pct = accrualTotal !== 0 ? (absUnresolved / Math.abs(accrualTotal)) * 100 : (absUnresolved !== 0 ? 100 : 0);
      const belowFloor = absUnresolved < unresolvedFloorRub;
      const ok = belowFloor || pct <= unresolvedThresholdPct;
      if (!ok) periodViolations++;
      console.log(
        pad(String(cabinetId), 10) + padL(fmtRub(unresolvedSum), 18) + padL(fmtRub(accrualTotal), 22)
        + padL(pct.toFixed(2) + '%', 12) + '  '
        + (ok ? (belowFloor ? 'ok (ниже пола)' : 'ok') : 'РАСХОЖДЕНИЕ (доля неразнесённого выросла ненормально)')
      );
    }
    console.log('');

    // ── Проверка 3: продвижение (promo) ↔ ad_spend ──
    console.log(`─── Проверка 3: |promo-начисления| ↔ SUM(ad_spend) (источник — tenant.ozon_daily_efficiency.ad_spend, тот же, что lib/ozonMetrics.js::ozAdSpend), допуск ${fmtRub(promoThreshold)} ₽ ───`);
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
      if (!ok) periodViolations++;
      console.log(
        pad(String(cabinetId), 10) + padL(fmtRub(promoAbs), 16) + padL(fmtRub(adSpendSum), 16)
        + padL(fmtRub(diff), 14) + padL(String(adSpendN), 15) + '  ' + (ok ? 'ok' : 'РАСХОЖДЕНИЕ')
      );
    }
    console.log('');

    console.log(
      periodViolations === 0
        ? `Неделя ${period.label}: PASS (0 расхождений)`
        : `Неделя ${period.label}: ${periodViolations} РАСХОЖДЕНИЕ(Й)`
    );
    console.log('');

    violations += periodViolations;
    periodSummaries.push({ label: period.label, violations: periodViolations });
  }
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.message}`);
  await pool.end().catch(() => {});
  process.exit(3);
} finally {
  await pool.end().catch(() => {});
}

console.log('═══ Итог по окну ═══');
for (const p of periodSummaries) {
  console.log(`  ${p.label}: ` + (p.violations === 0 ? 'PASS' : `${p.violations} РАСХОЖДЕНИЕ(Й)`));
}
console.log('');
if (violations === 0) {
  console.log(`ALL PASS — ${periods.length} период(ов), все три проверки, оба кабинета, расхождений нет.`);
} else {
  console.log(`ИТОГО ${violations} РАСХОЖДЕНИЕ(Й) по ${periods.length} период(ам) — см. блоки выше.`);
  console.log('Проверка 1: необъяснённый остаток после вычета «неразнесено по датам недели» — самостоятельная находка.');
  console.log('Проверка 2: доля «неразнесено» выше калиброванного порога — ловит рост категории независимо от проверки 1.');
  console.log('Проверка 3: |promo| и ad_spend разошлись больше порога — независимая находка (см. lib/ozonMetrics.js::ozAdSpend).');
}
process.exit(violations ? 1 : 0);
