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
//    ТРЁХ диагностированных сумм — «исходящей» и «входящей» упаковки на
//    стыке недель (см. ниже и проверку 2) и Σ класса §13 «comps≠accrued»
//    (docs/ozon-accrual-reconciliation.md, попавшая в окно этой недели —
//    находка 05.09.2026, см. CONSISTENCY_CLASS_WINDOW_SQL и докстроку
//    «СТАБИЛЬНОСТЬ КЛАССА» ниже), а не к сырой разнице напрямую.
//
//    order_costs фильтруется по COALESCE(sale_dt, return_dt), а НЕ по голому
//    sale_dt — тот же приём, что уже применяется в
//    worker/collectors/ozon_efficiency.py::_collect_sales (сумма по дню),
//    ровно по той же причине: у возвратных отправлений commission-блок может
//    отсутствовать в ЭТОМ прогоне сборщика (историческая продажа вне окна
//    сбора), sale_dt тогда NULL, а return_dt — есть.
//
//    ⚠️ «Упаковка на стыке недель» ДВУСТОРОННЯЯ (задача 6 плана «ремонт
//    данных прибыли Ozon», task-6-report.md — контроллер потребовал
//    симметричную поправку после того, как первая версия правки вычитала
//    только ОДНО направление и оставляла систематический остаток).
//    tenant.ozon_order_costs — ОДНА строка на posting_number, агрегирующая
//    ВСЮ историю начислений юнита (не только события своей недели),
//    привязанная к ОДНОЙ дате (COALESCE(sale_dt, return_dt), «дата первой
//    операции»). Отсюда ДВЕ независимые утечки, обе печатаются ВСЕГДА (не
//    только при красной строке — защита от самообмана, рост любой из
//    категорий виден глазами):
//    А) ИСХОДЯЩАЯ (CTE `detail`/`unresolved`) — деньги, начисленные В ЭТУ
//       неделю (`tenant.ozon_accruals.date` в периоде), чья
//       `order_costs`-строка датирована ДРУГОЙ неделей (или её нет вовсе,
//       или дата NULL) — уводит деньги ИЗ этой недели. Раскладывается на
//       три причины:
//      • `null_date` — у отправления есть строка, но COALESCE(sale_dt,
//        return_dt) = NULL. После полного пересчёта плана «ремонт данных
//        прибыли Ozon» (датировка «датой первой операции» ко всей истории)
//        таких строк 0 на обоих кабинетах — категория остаётся в коде как
//        страховка на случай будущей неполной пересборки, не как активный
//        известный риск.
//      • `other_period` — у отправления есть строка И дата резолвится, но
//        эта дата попадает в ДРУГУЮ неделю/период — обычный межпериодный
//        «выход» (например, начислена корректировка на несколько дней
//        позже даты возврата). Естественный шум понедельной нарезки
//        таблицы, где 1 строка хранит ВСЮ историю отправления.
//      • `no_row` — у отправления вообще нет строки tenant.ozon_order_costs
//        (SKU не резолвился — до плана «ремонт данных прибыли Ozon» такие
//        строки молча пропускались; теперь пишутся с product_id NULL, эта
//        категория сегодня почти всегда пуста). ПОИСК строки — по
//        COALESCE(oc.src_unit_number, oc.posting_number), а не по голому
//        posting_number — сборщик умеет резолвить posting_number по
//        каталогу, отчего он расходится с СЫРЫМ unit_number начислений;
//        колонка src_unit_number (миграция 042) хранит сырой номер,
//        заполнена у 100% строк обоих кабинетов после полного пересчёта.
//    Б) ВХОДЯЩАЯ (CTE `inbound_units`/`inbound`, НОВАЯ, задача 6 —
//       зеркало А) — деньги ДРУГИХ недель, «упакованные» в
//       `order_costs`-строку, датированную ЭТОЙ неделей: юнит, чья строка
//       датирована В ЭТУ неделю, но ЧАСТЬ его начислений (полная история
//       юнита!) датирована ВНЕ её — эта часть денег «влетает» в order_part
//       этой недели, хотя accrual_total(неделя) её не считает (у неё
//       другая дата). Без этой поправки Check 1 систематически не сходится
//       на любой неделе, где у «своих» юнитов есть иногородние по дате
//       начисления (корректировки/сторно/логистика через дни-недели после
//       продажи) — НЕ зависит от полноты окна сборщика: полный пересчёт
//       истории юнита СОЗДАЁТ этот эффект (агрегирует всю историю в ОДНУ
//       строку), а не устраняет его. Независимое доказательство —
//       task-6-report.md: кабинет 1008, неделя 2026-08-10..16, входящая
//       утечка 43,49 ₽ — ЧИСЛО ИДЕНТИЧНО тому, что было зафиксировано ДО
//       полного пересчёта (задача 4 предыдущего прохода), т.е. это
//       детерминированная функция дат начислений, а не артефакт неполноты
//       модели.
//
// 2) РОСТ «НЕРАЗНЕСЕНО ПО ДАТАМ НЕДЕЛИ» (задача 6, ре-ревью — Important):
//    проверка 1 гасит СУММУ «неразнесено» в остатке КАЖДЫЙ прогон — если сама
//    эта категория вдруг вырастет (например, из-за НОВОГО бага, оставляющего
//    больше дат NULL), проверка 1 всё равно останется зелёной, пока остаток
//    < 1 ₽: рост незаметен без ручного чтения диагностики. Эта проверка ловит
//    рост АВТОМАТИЧЕСКИ, отдельным ненулевым exit. ⚠️ Проверяет ТОЛЬКО
//    ИСХОДЯЩУЮ утечку (unresolvedSum, п. 1А выше) — по прямому указанию
//    контроллера (задача 6, симметричная правка) ВХОДЯЩАЯ (п. 1Б) сюда не
//    добавлена: это НЕЗАВИСИМАЯ проверка, входящая утечка своей отдельной
//    доли/порога/калибровки не имеет — только участвует в остатке проверки 1.
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
// 4) РОСТ ВХОДЯЩЕЙ УТЕЧКИ («упаковка на стыке недель», задача 6 плана
//    «ремонт данных прибыли Ozon», task-6-report.md) — ЗЕРКАЛО проверки 2,
//    тем же приёмом (доля от ИТОГО начислений недели, а не остаток после
//    вычета — иначе рост маскируется проверкой 1 точно так же, как рост
//    исходящей утечки маскировался бы без проверки 2). Калибровка (8
//    последних ISO-недель, оба кабинета, 16 точек, |Σ| ≥ пол — тот же пол,
//    что и у проверки 2, --inbound-floor-rub): наблюдённый максимум —
//    34,80% (кабинет 1, 2026-07-27..08-02), среднее — 5,91%. Порог по
//    умолчанию — 50% (заметный запас над наблюдённым максимумом, тот же
//    принцип калибровки, что и у проверки 2 — см. её комментарий выше).
//    Настраивается --inbound-threshold-pct / --inbound-floor-rub
//    независимо от --unresolved-threshold-pct / --unresolved-floor-rub
//    (проверка 2 сознательно НЕ включает входящую сумму — она про ДРУГОЕ
//    направление утечки, у нёе своя калибровка).
//
// Использование:
//   node scripts/check-ozon-profit-invariant.mjs                     (окно — 4 последние закрытые ISO-недели)
//   node scripts/check-ozon-profit-invariant.mjs --weeks 8           (окно — 8 недель, напр. для перекалибровки)
//   node scripts/check-ozon-profit-invariant.mjs --from 2026-08-10 --to 2026-08-16   (один произвольный период вместо окна)
//   node scripts/check-ozon-profit-invariant.mjs --promo-threshold 150
//   node scripts/check-ozon-profit-invariant.mjs --unresolved-threshold-pct 30 --unresolved-floor-rub 500
//   node scripts/check-ozon-profit-invariant.mjs --inbound-threshold-pct 60 --inbound-floor-rub 500
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';
import { NONITEM_PROMO_TYPE_IDS } from './lib/ozon-promo-type-ids.mjs';

const CABINETS = [1, 1008];
const INVARIANT_TOL_RUB = 1;
const DEFAULT_PROMO_THRESHOLD_RUB = 100;
const DEFAULT_UNRESOLVED_THRESHOLD_PCT = 40;
const DEFAULT_UNRESOLVED_FLOOR_RUB = 1000;
const DEFAULT_INBOUND_THRESHOLD_PCT = 50;
const DEFAULT_INBOUND_FLOOR_RUB = 1000;
const DEFAULT_WEEKS = 4;

function parseArgs(argv) {
  const out = {
    from: null, to: null, weeks: DEFAULT_WEEKS,
    promoThreshold: DEFAULT_PROMO_THRESHOLD_RUB,
    unresolvedThresholdPct: DEFAULT_UNRESOLVED_THRESHOLD_PCT,
    unresolvedFloorRub: DEFAULT_UNRESOLVED_FLOOR_RUB,
    inboundThresholdPct: DEFAULT_INBOUND_THRESHOLD_PCT,
    inboundFloorRub: DEFAULT_INBOUND_FLOOR_RUB,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--weeks') out.weeks = Number(argv[++i]);
    else if (a === '--promo-threshold') out.promoThreshold = Number(argv[++i]);
    else if (a === '--unresolved-threshold-pct') out.unresolvedThresholdPct = Number(argv[++i]);
    else if (a === '--unresolved-floor-rub') out.unresolvedFloorRub = Number(argv[++i]);
    else if (a === '--inbound-threshold-pct') out.inboundThresholdPct = Number(argv[++i]);
    else if (a === '--inbound-floor-rub') out.inboundFloorRub = Number(argv[++i]);
    else if (a.startsWith('--from=')) out.from = a.slice('--from='.length);
    else if (a.startsWith('--to=')) out.to = a.slice('--to='.length);
    else if (a.startsWith('--weeks=')) out.weeks = Number(a.slice('--weeks='.length));
    else if (a.startsWith('--promo-threshold=')) out.promoThreshold = Number(a.slice('--promo-threshold='.length));
    else if (a.startsWith('--unresolved-threshold-pct=')) out.unresolvedThresholdPct = Number(a.slice('--unresolved-threshold-pct='.length));
    else if (a.startsWith('--unresolved-floor-rub=')) out.unresolvedFloorRub = Number(a.slice('--unresolved-floor-rub='.length));
    else if (a.startsWith('--inbound-threshold-pct=')) out.inboundThresholdPct = Number(a.slice('--inbound-threshold-pct='.length));
    else if (a.startsWith('--inbound-floor-rub=')) out.inboundFloorRub = Number(a.slice('--inbound-floor-rub='.length));
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
const inboundThresholdPct = Number.isFinite(args.inboundThresholdPct) ? args.inboundThresholdPct : DEFAULT_INBOUND_THRESHOLD_PCT;
const inboundFloorRub = Number.isFinite(args.inboundFloorRub) ? args.inboundFloorRub : DEFAULT_INBOUND_FLOOR_RUB;

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

// «Семейный» ключ unit_number (задача 6 плана «ремонт данных прибыли
// Ozon», round 3/4 — та же логика, что worker/collectors/ozon_order_costs
// .py::_family_key): строки с ≥2 дефисами срезают последний сегмент
// (суффикс товара), строки с 1 дефисом (уже полная 2-частная форма) —
// сами себе ключ. НУЖНО здесь потому, что merge_unit_siblings в сборщике
// склеивает base/suffix сиблингов ДО записи — итоговая order_costs-строка
// несёт ОДИН src_unit_number (canonical), а деньги физически пришли под
// ДВУМЯ разными сырыми unit_number в tenant.ozon_accruals. Простое
// равенство `a.unit_number = oc.src_unit_number` не находит склеенного
// сиблинга — тот ложно попадал бы в 'no_row' (деньги ЕСТЬ и в order_part,
// и второй раз добавлялись бы в unresolved — двойной учёт, ложный остаток
// Check 1). familyKeySql(col) даёт SQL-выражение того же семейного ключа.
function familyKeySql(col) {
  return `(CASE WHEN (length(${col}) - length(replace(${col}, '-', ''))) >= 2 ` +
         `THEN regexp_replace(${col}, '-[^-]*$', '') ELSE ${col} END)`;
}
const INVARIANT_SQL = `
WITH order_part AS (
  -- services (миграция 045, статья «Сборы Ozon», волна 2026-08-25) — 6-е
  -- слагаемое comps-инварианта, ФИЗИЧЕСКИ было внутри logistics ДО
  -- бэкфилла задач 1-2 и вычиталось здесь неявно; после расщепления
  -- колонки его нужно вычитать явно, иначе order_part систематически
  -- завышен на Σservices окна (пост-ревью нашло перекос: 177 036,63 ₽ за
  -- всю историю 1008 сборов) — profit колонки order_costs это НЕ трогает
  -- (она считается сборщиком как SUM(accrued) − cost, см. docs/metrics-
  -- contract.md §3.3 «Инвариант строки»), расходится только ЭТОТ
  -- независимый пересчёт компонент.
  SELECT COALESCE(SUM(cost_value_retail - commission - services - logistics - acquiring - loyalty), 0) AS s,
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
-- oc_fam — family_key каждой order_costs-строки, посчитан ОДИН раз (не по
-- разу на пару, как в LATERAL) — join ниже становится хэшируемым по
-- family_key, на порядки быстрее корректного, но медленного LATERAL per-row
-- варианта (тот же результат, ~70 сек на прогон окна — неприемлемо против
-- ориентира ~1 мин, см. докстроку).
oc_fam AS (
  SELECT cabinet_id, posting_number, sale_dt, return_dt,
         COALESCE(src_unit_number, posting_number) AS unit_col,
         ${familyKeySql('COALESCE(src_unit_number, posting_number)')} AS family_key
  FROM tenant.ozon_order_costs
),
detail_candidates AS (
  SELECT a.accrual_id, a.line_no, a.accrued, oc.posting_number, oc.sale_dt, oc.return_dt,
    ROW_NUMBER() OVER (
      PARTITION BY a.accrual_id, a.line_no
      ORDER BY (oc.unit_col = a.unit_number) DESC NULLS LAST
    ) AS rn
  FROM tenant.ozon_accruals a
  LEFT JOIN oc_fam oc
    ON oc.cabinet_id = a.cabinet_id
   AND oc.family_key = ${familyKeySql('a.unit_number')}
  WHERE a.cabinet_id = $1 AND a.date BETWEEN $2::date AND $3::date AND a.unit_number IS NOT NULL
),
-- Неоднозначная семья (2+ order_costs-строк с одним family_key,
-- merge_unit_siblings их сознательно НЕ склеил) может дать 2+ кандидата на
-- одну строку начислений — ROW_NUMBER + rn=1 (точное совпадение
-- приоритетнее) гарантирует РОВНО один результат на строку, без задвоения
-- accrued в SUM ниже (тот же принцип, что LATERAL LIMIT 1 выше, дешевле).
detail AS (
  SELECT accrued,
    CASE
      WHEN posting_number IS NULL THEN 'no_row'
      WHEN COALESCE(sale_dt, return_dt) IS NULL THEN 'null_date'
      ELSE 'other_period'
    END AS reason
  FROM detail_candidates
  WHERE rn = 1
    AND (posting_number IS NULL
         OR COALESCE(sale_dt, return_dt) IS NULL
         OR COALESCE(sale_dt, return_dt) NOT BETWEEN $2::text AND $3::text)
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
),
-- ВХОДЯЩАЯ ('inbound') упаковка — зеркало 'other_period' выше (задача 6
-- плана «ремонт данных прибыли Ozon», НАХОДКА task-6-report.md: «упаковка
-- на стыке недель» — двусторонняя, а Check 1 до этой правки вычитал только
-- ОДНО направление). 'other_period'/'detail' выше ловит деньги, начисленные
-- В ЭТУ неделю, чья order_costs-строка датирована ДРУГОЙ (исходящая
-- утечка — уводит деньги ИЗ этой недели). 'inbound' — ровно наоборот:
-- юнит, чья order_costs-строка (COALESCE(sale_dt, return_dt), «дата первой
-- операции») датирована В ЭТУ неделю, но САМИ его начисления (полная
-- история юнита — build_order_costs собирает её целиком, не только события
-- своей недели) частично датированы ВНЕ её — та часть его денег «влетает»
-- в эту неделю через order_part, хотя accrual_total(неделя) её не считает
-- (она дана другой датой). Без вычета inbound_units/inbound остаток
-- Check 1 систематически ненулевой на любой неделе, где у «своих» юнитов
-- есть иногородние по дате начисления (корректировки/сторно/логистика
-- через дни-недели после продажи) — это НЕ зависит от полноты окна сборщика
-- (полный пересчёт истории юнита СОЗДАЁТ этот эффект, а не устраняет его,
-- см. task-6-report.md — независимое доказательство: кабинет 1008,
-- 2026-08-10..16, 43,49 ₽ идентично числу ДО полного пересчёта).
inbound_units AS (
  SELECT DISTINCT COALESCE(src_unit_number, posting_number) AS unit_number,
         ${familyKeySql('COALESCE(src_unit_number, posting_number)')} AS family_key
  FROM tenant.ozon_order_costs
  WHERE cabinet_id = $1 AND COALESCE(sale_dt, return_dt) BETWEEN $2::text AND $3::text
),
inbound AS (
  -- IN (полу-соединение по хэшу малого множества inbound_units), не JOIN:
  -- семейное совпадение может задеть 2+ inbound_units строки (неоднозначная
  -- семья) — IN считает строку начисления РОВНО один раз независимо от
  -- числа совпадений, JOIN бы задвоил accrued. Совпадение семейного ключа
  -- (не только точное) покрывает и склеенных (merge_unit_siblings)
  -- сиблингов тоже (иначе их вклад в «входящую» утечку недосчитывался бы).
  --
  -- F2 (фикс-волна финального ревью 2026-08-18): семейная ветка (совпадение
  -- family_key, НЕ точное unit_number) обязана исключать строки начислений
  -- a.unit_number, у которых уже ЕСТЬ СОБСТВЕННАЯ строка tenant.ozon_
  -- order_costs (свой src_unit_number/posting_number, свой признанный
  -- COALESCE(sale_dt, return_dt) — свои деньги учтены ТОЧНО через detail/
  -- order_part где-то в СВОЁМ периоде). Без исключения неоднозначная семья
  -- (2+ commission-братьев, merge_unit_siblings НЕ склеил — оба остались
  -- отдельными order_costs-строками) ложно приписывает вне-недельные деньги
  -- ЧУЖОГО, уже учтённого юнита ЭТОЙ inbound-неделе — двойной счёт, ровно то
  -- же по духу нарушение, которое ROW_NUMBER+rn=1 в detail_candidates выше
  -- уже предотвращает для исходящей ветки. oc_fam (выше) — тот же источник,
  -- что и detail_candidates, переиспользуем вместо второго обращения к
  -- tenant.ozon_order_costs.
  SELECT COALESCE(SUM(a.accrued), 0) AS s, count(*) AS n
  FROM tenant.ozon_accruals a
  WHERE a.cabinet_id = $1 AND a.date NOT BETWEEN $2::date AND $3::date
    AND (
      a.unit_number IN (SELECT unit_number FROM inbound_units)
      OR (
        ${familyKeySql('a.unit_number')} IN (SELECT family_key FROM inbound_units)
        AND NOT EXISTS (
          SELECT 1 FROM oc_fam oc3
          WHERE oc3.cabinet_id = $1 AND oc3.unit_col = a.unit_number
        )
      )
    )
)
SELECT
  order_part.s AS order_part, order_part.n AS order_n,
  cabinet_part.s AS cabinet_part, cabinet_part.n AS cabinet_n,
  promo_part.s AS promo_part, promo_part.n AS promo_n,
  accrual_total.s AS accrual_total, accrual_total.n AS accrual_n,
  unresolved.s AS unresolved_sum, unresolved.n AS unresolved_n,
  unresolved.no_row_s, unresolved.no_row_n,
  unresolved.null_date_s, unresolved.null_date_n,
  unresolved.other_period_s, unresolved.other_period_n,
  inbound.s AS inbound_sum, inbound.n AS inbound_n
FROM order_part, cabinet_part, promo_part, accrual_total, unresolved, inbound`;

const AD_SPEND_SQL = `
  SELECT COALESCE(SUM(ad_spend), 0) AS s, count(*) AS n
  FROM tenant.ozon_daily_efficiency
  WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date AND ad_spend IS NOT NULL`;

// ── Класс «расхождение компонентной раскладки» (задача 3 плана «витрина
// заказов», .superpowers/sdd/2026-08-18-orders-vitrina/, docs/ozon-accrual-
// reconciliation.md §13) — СПРАВОЧНАЯ строка, НЕ входит в окно недель выше и
// НЕ считается в violations/exit-код: это ВСЯ ИСТОРИЯ обоих кабинетов (не
// последние 4 недели), задача — сделать класс ВИДИМЫМ на каждом прогоне
// сторожа, а не искать регресс в узком окне.
//
// Формула (ЗНАКОВАЯ, та же, что consistency_ok сборщика,
// worker/collectors/ozon_order_costs.py::build_order_costs): cost_value_
// retail − commission − services − logistics − acquiring − loyalty −
// SUM(accrued) — где SUM(accrued) отправления/семьи ТОЖДЕСТВЕННО profit +
// COALESCE(cost, 0) (profit = SUM(accrued) − cost, см. build_order_costs).
// profit САМ строится из SUM(accrued), эта строка на profit не влияет —
// только на 6 денежных КОМПОНЕНТ (cost_value_retail/commission/services/
// logistics/acquiring/loyalty), которые несколько роутов панели
// (app/api/cabinets/[id]/overview, products-summary, rnp-summary, plan/fact)
// складывают САМИ, а не читают готовый profit — на этих строках их
// собственный пересчёт разойдётся с профилем ровно на печатаемую сумму.
//
// services добавлено в формулу класса пост-ревью волны «Сборы Ozon»
// (2026-08-25, миграция 045 + бэкфилл задач 1-2 плана): колонка появилась
// ПОСЛЕ того, как это class-SQL было написано (задача 3 плана «витрина
// заказов») — без явного вычитания класс перестал означать «нарушители
// comps-инварианта» и вместо ~60 ловил ВСЕ 10 341 строки с services≠0
// (расщеплённая часть бывшей logistics, согласованная по построению).
// С services в формуле класс снова измеряет РОВНО то же самое рассогласование,
// что описано ниже (СТАБИЛЬНОСТЬ КЛАССА) — ожидаемое значение после фикса
// снова ~60, а не 10 341.
//
// МЕХАНИЗМ (разбор задачи 3, 60/60 объяснено до копейки без остатка,
// проверочный запрос — .superpowers/sdd/2026-08-18-orders-vitrina/
// task-3-report.md): commission-блок POSTING (type_id IS NULL) несёт accrued
// = sale_price + sale_commission + coinvestment + bonus (тождество,
// проверено на живых строках). Формула build_order_costs предполагает
// ДРУГОЕ тождество — seller_price = sale_price + coinvestment + bonus (§2
// этого документа, footnote¹, «проверено программно, 0 расхождений» — но
// только на выборке ОДНОГО дня, 29 записей 2026-08-05, кабинет 1). На 45 из
// этих 60 отправлений (не-возвраты, 0,318% всех commission-несущих
// unit_number, 45 из 14 147) тождество НЕ держится — расхождение ЦЕЛИКОМ
// объясняется разницей (sale_price − seller_price + coinvestment + bonus),
// это СВОЙСТВО данных Ozon (вероятно,
// промо-схема с иным способом финансирования скидки, нераспознаваемая по
// имеющимся полям), НЕ баг парсинга/суммирования нашего сборщика (проверено:
// пересчёт формулы ТОЛЬКО из seller_price/sale_price/coinvestment/bonus,
// уже хранящихся в tenant.ozon_accruals, воспроизводит расхождение до
// копейки на всех 60 без остатка). У остальных 15 из 60 (возвраты с
// ненулевым commission-блоком) — вторая, независимая причина: cost_value_
// retail сознательно обнуляется для ЛЮБОГО возврата (build_order_costs: «0.0 if is_return else
// seller_price», продуктовое решение — колонка «стоимость заказа» не должна
// показывать откат цены товара на возврате), но у возвратов С commission-
// блоком (развёрнутая продажа, а не чистый логистический возврат)
// seller_price при этом честно ненулевой и полностью «выпадает» из comps —
// расхождение здесь равно ИМЕННО seller_price (сам commission-блок возврата
// внутренне согласован — тождество seller_price=sale_price+coinvestment+
// bonus держится, проверено на всех возвратных строках класса).
//
// СТАБИЛЬНОСТЬ КЛАССА — ОБНОВЛЕНО 05.09.2026 (расследование остатка −4500 ₽
// Проверки 1, неделя 2026-08-24..30, кабинет 1; см. также worker-коммит
// d62f1dd «fix(worker): ozon_order_costs — сверка согласованности учитывает
// обнуление cost_value_retail на возвратах»). ИСХОДНОЕ заявление ниже (бриф
// задачи 3, 2026-08-18/19) было: после ПОЛНОГО пересчёта истории обоих
// кабинетов 2026-08-18 класс остался РОВНО 60 строк, максимальная дата
// аномалии — 2026-06-16, свежих (июль-август 2026) аномалий НЕТ ни одной.
// ЭТО БОЛЬШЕ НЕ ВЕРНО и не будет верно снова — у класса ДВЕ независимые
// причины (§13.2 docs/ozon-accrual-reconciliation.md), и у них РАЗНАЯ
// динамика:
//   • Случай «А» (is_return=0, тождество seller_price=sale_price+
//     coinvestment+bonus не держится на части commission-блоков —
//     особенность данных Ozon, не наш баг, ~45 строк) — по-прежнему БЕЗ
//     роста, максимальная дата всё ещё 2026-06-16 на 05.09.2026.
//   • Случай «Б» (is_return=1, возврат РЕАЛЬНО ПРОДАННОГО юнита —
//     cost_value_retail сознательно обнуляется build_order_costs на любом
//     возврате, а seller_price честно ненулевой и выпадает из comps) —
//     класс ЖИВОЙ и растёт с КАЖДЫМ таким возвратом: это не разовая
//     аномалия данных, а структурное следствие продуктового решения об
//     обнулении. На 05.09.2026 в классе уже 62 строки (было 60) — две
//     новые, обе кабинет 1, обе августовские (постинги 48502768-0261-3 и
//     0150512174-0208-3, найдены расследованием −4500 ₽ Проверки 1).
// Деньги/profit НЕ задеты ни случаем А, ни случаем Б (SUM(accrued) не
// меняется, см. докстроку выше) — расхождение только в 6 независимо
// читаемых компонентах.
//
// Живой сборщик (worker/collectors/ozon_order_costs.py, коммит d62f1dd,
// 2026-09-05) с этой даты БОЛЬШЕ НЕ ФЛАГАЕТ случай «Б» в своей собственной
// внутренней проверке consistency_ok — та проверка починена сдвигом
// ожидания на Σ seller_price для is_return=1 (симметрично обнулению
// cost_value_retail). Денежная арифметика (cost_value_retail/commission/
// services/logistics/acquiring/loyalty/cost/profit — всё, что пишется в
// БД) правкой d62f1dd НЕ изменена ни на копейку — исправлен только
// внутренний индикатор сборщика (consistency_ok нигде не пишется в БД).
// Случай «А» правкой d62f1dd НЕ затронут — по-прежнему флагается и
// сборщиком, и этим классом. Это значит: САМ факт роста случая «Б» —
// больше НЕ сигнал регресса сборщика (сборщик его больше не считает
// нарушением), но денежный разрыв в 6 компонентах для панели (роуты,
// складывающие компоненты сами, а не читающие готовый profit) остаётся, и
// ЭТОТ офлайн-класс (уровня scripts, читает уже записанные значения) —
// единственное место, где он по-прежнему виден и посчитан.
//
// Порог роста для класса по-прежнему НЕ введён: Check 1 теперь явно находит
// строки класса, ПОПАВШИЕ В ОКНО проверяемой недели (CONSISTENCY_CLASS_
// WINDOW_SQL), печатает их и вычитает их знаковую сумму из остатка ПЕРЕД
// сравнением с допуском (см. блок Проверки 1 ниже) — поэтому рост случая
// «Б» сам по себе больше не создаёт ложных РАСХОЖДЕНИЙ в Check 1 неделя за
// неделей. Но эта справочная строка (по ВСЕЙ истории, не только окну
// недель) печатается ВСЕГДА — рост случая «Б» виден ГЛАЗАМИ на каждом
// прогоне (n растёт от 62 дальше). Этот сторож остаётся ВТОРЫМ ЭШЕЛОНОМ для
// случая «А»: отдельной автоматической проверки роста именно случая «А» нет
// — если он тоже начнёт расти, это будет видно здесь же, в общей
// Σ|расхождение| и n, но без разбивки по причине.
const CONSISTENCY_CLASS_SQL = `
  SELECT count(*) AS n,
         COALESCE(SUM(ABS((cost_value_retail - commission - services - logistics - acquiring - loyalty)
                          - (profit + COALESCE(cost, 0)))), 0) AS abs_sum,
         MAX(COALESCE(sale_dt, return_dt)) AS max_dt
  FROM tenant.ozon_order_costs
  WHERE cabinet_id = $1
    AND ABS((cost_value_retail - commission - services - logistics - acquiring - loyalty)
            - (profit + COALESCE(cost, 0))) > 0.01`;

// Windowed-версия класса выше — Проверка 1, находка 05.09.2026
// (расследование остатка −4500 ₽, неделя 2026-08-24..30, кабинет 1;
// /tmp/.../invariant-check1-investigation.md). ТА ЖЕ сигнатура членства
// класса, что и в CONSISTENCY_CLASS_SQL выше (идентичное выражение,
// идентичный допуск 0,01 ₽) — добавлены только (а) фильтр по кабинету и
// COALESCE(sale_dt, return_dt) BETWEEN (строка класса попала именно в
// проверяемую неделю) и (б) ЗНАКОВАЯ (не ABS) сумма плюс список постингов:
// Проверка 1 ниже печатает эти строки явно и вычитает их знаковую сумму из
// остатка ДО сравнения с допуском. Класс — задокументированная (§13.2
// docs/ozon-accrual-reconciliation.md, случай «Б») причина расхождения
// order_part (comps) с SUM(accrued) на возвратах реально проданных юнитов
// (cost_value_retail сознательно обнуляется на возврате, seller_price
// «выпадает» из comps) — без этого вычитания Check 1 видит такой остаток
// как «загадочное» РАСХОЖДЕНИЕ, хотя он целиком объясняется давно известным
// классом (см. также обновлённую докстроку СТАБИЛЬНОСТЬ КЛАССА ниже).
const CONSISTENCY_CLASS_WINDOW_SQL = `
  SELECT count(*) AS n,
         COALESCE(SUM((cost_value_retail - commission - services - logistics - acquiring - loyalty)
                       - (profit + COALESCE(cost, 0))), 0) AS signed_sum,
         array_agg(posting_number ORDER BY posting_number) AS postings
  FROM tenant.ozon_order_costs
  WHERE cabinet_id = $1
    AND COALESCE(sale_dt, return_dt) BETWEEN $2::text AND $3::text
    AND ABS((cost_value_retail - commission - services - logistics - acquiring - loyalty)
            - (profit + COALESCE(cost, 0))) > 0.01`;

const pool = new pg.Pool(readonlyPgConfig());

console.log('Сторож недельного инварианта прибыли Ozon (новая модель — метод начислений)');
console.log(
  `Окно: ${periods.length} период(ов) — ${periods[0].label} .. ${periods[periods.length - 1].label} `
  + `(пороги: promo↔ad_spend ${fmtRub(promoThreshold)} ₽, доля «неразнесено» (Check 2) `
  + `${unresolvedThresholdPct}% при |Σ| ≥ ${fmtRub(unresolvedFloorRub)} ₽, доля «входящая утечка» `
  + `(Check 4) ${inboundThresholdPct}% при |Σ| ≥ ${fmtRub(inboundFloorRub)} ₽)`
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
      const [{ rows: [inv] }, { rows: [ad] }, { rows: [cc] }] = await Promise.all([
        pool.query(INVARIANT_SQL, [cabinetId, dateFrom, dateTo, [...NONITEM_PROMO_TYPE_IDS]]),
        pool.query(AD_SPEND_SQL, [cabinetId, dateFrom, dateTo]),
        pool.query(CONSISTENCY_CLASS_WINDOW_SQL, [cabinetId, dateFrom, dateTo]),
      ]);
      byCabinet[cabinetId] = { inv, ad, cc };
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
      const { inv, cc } = byCabinet[cabinetId];
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
      const inboundSum = num(inv.inbound_sum);
      const inboundN = Number(inv.inbound_n);
      const classN = Number(cc.n);
      const classSum = num(cc.signed_sum);
      const classPostings = cc.postings || [];
      perCabinet[cabinetId] = { accrualTotal, unresolvedSum, unresolvedN, noRowSum, noRowN, nullDateSum, nullDateN, otherPeriodSum, otherPeriodN, inboundSum, inboundN };

      // Остаток = сырая разница + ИСХОДЯЩАЯ утечка (unresolvedSum, «other_period»
      // и соседи — деньги ЭТОЙ недели, упакованные в строку ДРУГОЙ недели) −
      // ВХОДЯЩАЯ утечка (inboundSum — деньги ДРУГИХ недель, упакованные в строку
      // ЭТОЙ недели, задача 6 плана «ремонт данных прибыли Ozon», зеркальная
      // поправка к исходящей, см. комментарий у CTE inbound в INVARIANT_SQL) −
      // Σ класса §13 «comps≠accrued» (classSum, CONSISTENCY_CLASS_WINDOW_SQL,
      // находка 05.09.2026), ПОПАВШАЯ В ОКНО этой недели — известная,
      // задокументированная (docs/ozon-accrual-reconciliation.md §13.2, случай
      // «Б») причина рассинхрона order_part с SUM(accrued) на возвратах
      // реально проданных юнитов; без этого вычитания такие строки выглядят
      // «загадочным» РАСХОЖДЕНИЕМ, хотя давно объяснены справочным блоком в
      // конце файла (там — по ВСЕЙ истории, здесь — только попавшее в окно).
      // Все три поправки печатаются ВСЕГДА (не только при красной строке) —
      // защита от самообмана, рост любой из категорий виден глазами независимо
      // от вердикта.
      const rawResidual = diff + unresolvedSum - inboundSum;
      const residual = rawResidual - classSum;
      const ok = Math.abs(residual) <= INVARIANT_TOL_RUB;
      if (!ok) periodViolations++;
      console.log(
        `    неразнесено по датам недели, ИСХОДЯЩАЯ утечка (unit есть в начислениях периода, но не попал `
        + `в order_costs этой недели): ${unresolvedN} строк(и), Σ=${fmtRub(unresolvedSum)} ₽ — из них:`
      );
      console.log(
        `      • null_date (нет sale_dt/return_dt): ${nullDateN} строк(и), Σ=${fmtRub(nullDateSum)} ₽`
      );
      console.log(
        `      • other_period (дата резолвится, но в другом периоде — межпериодный сосед, не находка): `
        + `${otherPeriodN} строк(и), Σ=${fmtRub(otherPeriodSum)} ₽`
      );
      console.log(
        `      • no_row (нет строки order_costs вовсе): ${noRowN} строк(и), Σ=${fmtRub(noRowSum)} ₽`
      );
      console.log(
        `    входящая упаковка, ВХОДЯЩАЯ утечка (юнит датирован ЭТОЙ неделей `
        + `(COALESCE(sale_dt, return_dt)), но часть его начислений датирована ВНЕ её — `
        + `«упаковка на стыке недель», task-6-report.md): ${inboundN} строк(и) начислений, `
        + `Σ=${fmtRub(inboundSum)} ₽`
      );
      console.log(
        `    объяснено классом §13 «comps≠accrued» (docs/ozon-accrual-reconciliation.md, `
        + `случай «Б» — возврат реально проданного юнита, cost_value_retail сознательно `
        + `обнулён, seller_price выпал из comps; справочный блок в конце файла — по всей `
        + `истории, здесь — только строки, попавшие в это окно): ${classN} строк(и), `
        + `Σ=${fmtRub(classSum)} ₽`
        + (classN > 0 ? `, постинги: ${classPostings.join(', ')}` : '')
      );
      console.log(`    остаток после вычета обеих утечек и класса §13: ${fmtRub(residual)} ₽  ` + (ok ? 'ok' : 'РАСХОЖДЕНИЕ (необъяснённая находка)'));
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

    // ── Проверка 4: рост доли ВХОДЯЩЕЙ утечки («упаковка на стыке недель»,
    // задача 6 плана «ремонт данных прибыли Ozon») — зеркало проверки 2,
    // тот же приём (доля САМОЙ суммы от ИТОГО начислений, не остатка после
    // вычета — иначе рост маскируется проверкой 1). Калибровка и порог —
    // см. комментарий в шапке файла.
    console.log(`─── Проверка 4: доля ВХОДЯЩЕЙ утечки («упаковка на стыке недель») от ИТОГО начислений — допуск ${inboundThresholdPct}% (при |Σ| ≥ ${fmtRub(inboundFloorRub)} ₽, иначе не проверяется) ───`);
    console.log(
      pad('кабинет', 10) + padL('входящая, ₽', 18) + padL('ИТОГО начислений, ₽', 22)
      + padL('доля, %', 12) + '  вердикт'
    );
    for (const cabinetId of CABINETS) {
      const { accrualTotal, inboundSum } = perCabinet[cabinetId];
      const absInbound = Math.abs(inboundSum);
      const pct = accrualTotal !== 0 ? (absInbound / Math.abs(accrualTotal)) * 100 : (absInbound !== 0 ? 100 : 0);
      const belowFloor = absInbound < inboundFloorRub;
      const ok = belowFloor || pct <= inboundThresholdPct;
      if (!ok) periodViolations++;
      console.log(
        pad(String(cabinetId), 10) + padL(fmtRub(inboundSum), 18) + padL(fmtRub(accrualTotal), 22)
        + padL(pct.toFixed(2) + '%', 12) + '  '
        + (ok ? (belowFloor ? 'ok (ниже пола)' : 'ok') : 'РАСХОЖДЕНИЕ (доля входящей утечки выросла ненормально)')
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

  // ── Справочная строка (не входит в окно недель, не влияет на exit-код) ──
  // «расхождение компонентной раскладки» на ВСЕЙ истории обоих кабинетов —
  // см. комментарий у CONSISTENCY_CLASS_SQL выше и docs/ozon-accrual-
  // reconciliation.md §13. profit не затронут никогда (формула этой строки
  // сравнивает 5 компонент с profit + cost, т.е. с тем же SUM(accrued), из
  // которого сам profit и построен) — расхождение может задеть только
  // отдельно читаемые компоненты (commission/logistics/acquiring/
  // cost_value_retail) в тех роутах панели, что складывают их сами.
  console.log('─── Справочно: расхождение компонентной раскладки (cost_value_retail−commission−logistics−acquiring−loyalty ≠ SUM(accrued), ВСЯ ИСТОРИЯ, не окно недель; profit не затронут; порога нет — случай «А» стабилен, случай «Б» растёт с каждым возвратом проданного юнита (см. докстроку CONSISTENCY_CLASS_SQL); Check 1 выше уже вычитает строки, попавшие в окно недели, docs/ozon-accrual-reconciliation.md §13) ───');
  console.log(pad('кабинет', 10) + padL('строк', 10) + padL('Σ|расхождение|, ₽', 20) + padL('последняя дата', 16));
  for (const cabinetId of CABINETS) {
    const { rows: [c] } = await pool.query(CONSISTENCY_CLASS_SQL, [cabinetId]);
    const n = Number(c.n);
    const absSum = num(c.abs_sum);
    const maxDt = c.max_dt ? String(c.max_dt).slice(0, 10) : '—';
    console.log(pad(String(cabinetId), 10) + padL(String(n), 10) + padL(fmtRub(absSum), 20) + padL(maxDt, 16));
  }
  console.log('');
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
  console.log(`ALL PASS — ${periods.length} период(ов), все четыре проверки, оба кабинета, расхождений нет.`);
} else {
  console.log(`ИТОГО ${violations} РАСХОЖДЕНИЕ(Й) по ${periods.length} период(ам) — см. блоки выше.`);
  console.log('Проверка 1: необъяснённый остаток после вычета обеих утечек (исходящей и входящей) — самостоятельная находка.');
  console.log('Проверка 2: доля исходящей утечки выше калиброванного порога — ловит рост категории независимо от проверки 1.');
  console.log('Проверка 3: |promo| и ad_spend разошлись больше порога — независимая находка (см. lib/ozonMetrics.js::ozAdSpend).');
  console.log('Проверка 4: доля входящей утечки («упаковка на стыке недель») выше калиброванного порога — зеркало проверки 2.');
}
process.exit(violations ? 1 : 0);
