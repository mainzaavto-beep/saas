#!/usr/bin/env node
// scripts/check-profit-canon.mjs — сторож канонического слоя прибыли
// (план «унификация формул прибыли», docs/superpowers/plans/
// 2026-08-20-profit-unification.md, задача 1 — Ozon-секция, задача 2 —
// WB-секция, тот же файл, симметричные проверки).
//
// Проверяет РЕАЛЬНЫЕ функции lib/ozonMetrics.js (ozProfitProduct/
// ozProfitCabinet/ozCabinetCostLabel) и lib/wbMetrics.js (wbProfitProduct/
// wbProfitCabinet/wbCabinetCostLabel) — не переизобретает их формулу —
// против НЕЗАВИСИМОГО SQL, посчитанного этим скриптом с нуля. Расхождение
// = баг канона (finance-discrepancy-rule), не повод подгонять эталон.
//
// Два разных подключения — оба обязательны (Global Constraints задачи 1):
//   1) канон читает БД штатным способом панели — DatabaseSync поверх
//      withTenant(cabinetId, ...) (та же RLS-транзакция, что открывает
//      withCabinet на каждый запрос). Креды — saas_app из .env.local (та же
//      роль, что использует сама панель; НЕ admin, см. scripts/lib/pgpass.mjs
//      — тот файл только для saas_ro/postgres).
//   2) независимая проверочная сумма — pg.Pool(readonlyPgConfig()), ТОЛЬКО
//      saas_ro (bypass RLS, явный cabinet_id в каждом запросе) — сторож
//      физически не может писать и не зависит от той же RLS-логики, что
//      проверяет.
//
// Период по умолчанию — июль 2026, кабинет 1 (см. бриф задачи 1: «для
// июля-2026 каб.1»; те же данные, что использует docs/ozon-external-
// reconciliation-*). --cabinet/--from/--to меняют период вручную (общий
// для обеих секций — Ozon и WB).
//
// ═══════════════════════ OZON-СЕКЦИЯ (задача 1) ═══════════════════════
// Проверки (все обязаны выполниться зелёными; ненулевой exit при любом
// расхождении):
//   1. ozProfitProduct(period).profit (без productId) = независимому SQL
//      SUM(order_costs.profit) − SUM(ad_spend) − calcTotalTax(...).total,
//      допуск 0,01 ₽.
//   2. Слагаемые аддитивны: revenue−cogs−commission−logistics−acquiring
//      −loyalty (поля из ozProfitProduct) = независимому SUM(order_costs.
//      profit) — «знаковая формула сборщика» (worker/collectors/
//      ozon_order_costs.py: comps ≡ SUM(accrued) ≡ profit+cost), допуск
//      0,01 ₽.
//   3. ozProfitCabinet(period).profit = ozProfitProduct(period).profit ПЛЮС
//      ЗНАКОВАЯ Σ cabinetCosts[].amount — сверка внутренней арифметики
//      канона (ИСПРАВЛЕНО ревью задачи 1, fix-раунд: первая версия плана и
//      кода брала МОДУЛЬ каждой статьи — контролёр признал формулировку
//      плана своей ошибкой, положительная статья должна ПРИБАВЛЯТЬСЯ, не
//      вычитаться модулем, см. коммент в lib/ozonMetrics.js у
//      ozProfitCabinet), допуск 0,01 ₽. Проверка намеренно берёт период с
//      живой положительной статьёй (accrual_62 у кабинета 1, +8 955 ₽) —
//      знаковая и модульная формулы дают РАЗНЫЕ числа именно на ней
//      (2×8 955=17 910 ₽ расхождение), так проверка ловит регресс к старой
//      (модульной) формуле, а не только совпадает случайно на чисто
//      отрицательном наборе статей.
//   4. cabinetCosts[].label — ни один не содержит подстроку «accrual_»
//      сырым текстом (задача 1 плана: «accrual_93 больше нигде не
//      показывается сырым»).
//   5. productId-фильтр аддитивен (формула переписана задачей 6, 2026-08-22
//      — пер-SKU реклама Ozon теперь ЕСТЬ, см. докстроку ozAdSpend в
//      lib/ozonMetrics.js): Σ ozProfitProduct(period, productId).profit по
//      всем товарам периода, МИНУС нераспределённый остаток рекламы
//      (ads(кабинета) − Σ ozProfitProduct(товар).ads), = ozProfitProduct
//      (period).profit без фильтра, допуск 0,05 ₽ (шире базового 0,01 — см.
//      обоснование допуска ниже, у самого чека).
//      ⚠️ ПОЧЕМУ «−остаток», а не голое сравнение сумм: даже с пер-SKU
//      данными (миграция 043, tenant.ozon_daily_sku_ad) Σ ads(товар) НЕ
//      равна ads(кабинета) — «нераспределённый остаток» складывается из ДВУХ
//      компонент: (а) кампании без товарной разбивки (напр. «Оплата за
//      заказ — все товары», campaign_id 27109544 у кабинета 1, ~47% бюджета
//      кабинета в июле) физически не отдают per-SKU статистику Performance
//      API, их расход остаётся только в ads(кабинета); (б) реклама товаров,
//      у которых В ЭТОМ ПЕРИОДЕ НЕТ строк order_costs (товар рекламировался,
//      но не продавался/не попал в фин-отчёт) — такой product_id не входит в
//      цикл проверки (он строится по DISTINCT product_id FROM order_costs),
//      поэтому его ads физически не попадает в Σ ads(товар), хотя запись в
//      ozon_daily_metrics/ozon_daily_sku_ad есть (симметрично уже известному
//      WB-случаю ниже, 7 077,17 ₽ «осиротевших» на nm без order_costs).
//      Кабинетный вызов (без productId) вычитает ПОЛНУЮ ads(кабинета) РОВНО
//      ОДИН раз — Σ по товарам оттого ВЫШЕ (менее убыточна), чем profit(без
//      фильтра), РОВНО на нераспределённый остаток: Σ profit(товар) =
//      profit(без фильтра) + остаток. Если бы проверка сравнивала голые
//      суммы без поправки, она была бы математически невыполнима при ЛЮБОМ
//      нераспределённом остатке — не баг канона, а неизбежное следствие
//      структурного пробела покрытия (не 100% кампаний имеют SKU-разбивку,
//      не все рекламируемые товары продаются в периоде). Налог при этом
//      ОСТАЁТСЯ в сумме по товарам без поправки (под usn_income он линеен по
//      выручке — Σtax(товар) = tax(кабинет) с точностью до округления
//      round2 на каждый товар, см. коммент в lib/ozonMetrics.js) — поправка
//      нужна только для ads.
//   5б. ⚠️ НАХОДКА РЕВЬЮ задачи 6/7: проверка 5 (и WB п.5 ниже) алгебраически
//      НЕЧУВСТВИТЕЛЬНА к фактическому значению ads_i — Σ ads(товар) сначала
//      вычитается (внутри profit(товар)), потом прибавляется обратно
//      (поправка на остаток), поэтому в итоговой формуле ads_i полностью
//      СОКРАЩАЮТСЯ; проверка 5 прошла бы зелёной, даже если бы ozAdSpend/
//      wbAdTotal(id) всегда возвращали неверное число — лишь бы одно и то же
//      число участвовало в обеих частях формулы. Проверка 5б — НЕЗАВИСИМАЯ
//      сверка САМИХ ads_i: Σ ads(товар)/Σ ads(nm), которую посчитал канон
//      (цикл по ozAdSpend/wbAdTotal с productId/nmId), против ОДНОГО bulk SQL
//      SUM(ad_spend) (roPool/saas_ro, без RLS) по ТОМУ ЖЕ множеству id из
//      ozon_daily_metrics/wb_daily_metrics — другой код, другое подключение,
//      значит бы поймала регресс в самом ozAdSpend/wbAdTotal, допуск 0,05 ₽.
//   6. Инвариант «batch ≡ скаляр» (задача 2 плана «канон волна 2»):
//      ozProfitProductBatch(period).get(productId) обязан ПОКОМПОНЕНТНО
//      совпадать со скалярным ozProfitProduct(period, productId) —
//      revenue/cogs/commission/logistics/acquiring/loyalty/ads/tax/profit/
//      profitGross/returnLogistics (rawProfit — служебное поле batch-Map,
//      в сравнение не входит). Берутся 5 СЛУЧАЙНЫХ product_id из batch-Map
//      (или все, если товаров в периоде < 5), допуск 0,01 ₽ — обе формулы
//      исполняют один и тот же SQL-агрегат (скаляр — WHERE product_id = ?,
//      batch — GROUP BY product_id), расхождение возможно только при
//      разъехавшейся реализации (регресс), не при округлении.
//   7. Дневной канон (задача 6 плана «канон волна 2», 2026-08-25): для ДО 3
//      товаров с продажами в периоде (или всех, если товаров < 3) — Σ
//      profit(день), посчитанная той же композицией, что теперь использует
//      detail-роут (app/api/cabinets/[id]/detail/route.js, collectOzon):
//      ozRawProfitByDay(productId) [тот же SELECT, что скалярный агрегат,
//      GROUP BY день] + adDay [daily_metrics.ad_spend по (product_id,date) —
//      ТОТ ЖЕ источник, что суммирует ozAdSpend(productId)] → profit(день) =
//      rawProfit(день) − ad(день) − calcTotalTax(день).total — сравнивается
//      со скалярным ozProfitProduct(period, productId).profit, допуск
//      0,05 ₽ (usn_income линеен по выручке ⇒ Σtax(день) = tax(период) точно,
//      допуск шире базового только на случай накопленных round2 по дням).
//
// ═══════════════════════ WB-СЕКЦИЯ (задача 2) ═══════════════════════
// Симметричные проверки против lib/wbMetrics.js::wbProfitProduct/
// wbProfitCabinet/wbCabinetCostLabel. Отличия от Ozon (та же ФОРМА, другая
// СЕМАНТИКА — ppvz-модель, урок D15):
//   1. wbProfitProduct(period).profit (без nmId) = независимому SQL
//      SUM(wb_order_costs.profit) − SUM(ad_spend) − calcTotalTax(...).total,
//      допуск 0,01 ₽. wb_order_costs.profit = cost_value_pay − cost −
//      logistics (commission/acquiring/loyalty УЖЕ внутри cost_value_pay,
//      не вычитаются повторно — см. докстроку wbProfitProduct).
//   2. Слагаемые аддитивны: revenue(cost_value_pay)−cogs−logistics =
//      независимому SUM(profit) (БЕЗ commission/acquiring/loyalty — они не
//      участвуют в формуле WB, в отличие от Ozon), допуск 0,01 ₽.
//   3. wbProfitCabinet.profit = wbProfitProduct.profit + Σ cabinetCosts[].
//      amount (ЗНАК УЖЕ НОРМАЛИЗОВАН каноном — см. докстроку
//      wbProfitCabinet в lib/wbMetrics.js: сырой знак в tenant.
//      wb_cabinet_costs у WB ПРОТИВОПОЛОЖЕН Ozon — расходы положительны,
//      возмещения/выплаты отрицательны — канон инвертирует, чтобы внешний
//      контракт (amount<0=расход, amount>0=доход) был одинаков для обеих
//      площадок). Независимая проверка считает Σ(−amount_raw) и сверяет.
//      Проверка берёт период с живой отрицательной (= доходной по сырому
//      знаку) статьёй payout_other (кабинет 1, июль-2026, −68 774,48 ₽,
//      «Выплаты WB (компенсации)» — см. память wb-cabinet-costs-fixed.md).
//   4. cabinetCosts[].label — ни один НЕ равен сырому costType (весь набор
//      cost_type у WB резолвится статичным словарём WB_COST_LABELS,
//      unknownCostTypes должен быть 0 на живых данных).
//   5. nmId-фильтр аддитивен (формула переписана задачей 6, 2026-08-22,
//      симметрично Ozon): Σ wbProfitProduct(period, nmId).profit по всем nm
//      периода, МИНУС нераспределённый остаток рекламы (ads(кабинета) −
//      Σ wbProfitProduct(nm).ads) — см. докстроку wbProfitProduct в
//      lib/wbMetrics.js: реклама по nm_id У WB ЕСТЬ и с задачи 6 реально
//      подставляется в ads(nm), но часть ad_spend «осиротела» на nm без
//      строк order_costs в периоде — 7 077,17 ₽ на кабинете 1 за июль-2026 —
//      этот остаток вычитается только на кабинетном вызове, допуск 0,05 ₽.
//   6. Инвариант «batch ≡ скаляр» — симметрично Ozon п.6 выше:
//      wbProfitProductBatch(period).get(nm_id) покомпонентно = wbProfitProduct
//      (period, nm_id) на 5 случайных nm_id (или всех, если nm < 5), допуск
//      0,01 ₽.
//   7. Дневной канон (задача 6 плана «канон волна 2») — симметрично Ozon п.7:
//      для ДО 3 nm_id с продажами (или всех, если < 3) — Σ profit(день), той
//      же композицией, что теперь использует detail-роут (collectWB):
//      wbRawProfitByDay(nmId) + adDay [daily_metrics.ad_spend по (nm_id,date),
//      ТОТ ЖЕ источник, что wbAdTotal(nmId)] → profit(день) = rawProfit(день)
//      − ad(день) − calcTotalTax(день, база=cogs+logistics+ads).total,
//      сравнивается со скалярным wbProfitProduct(period, nmId).profit,
//      допуск 0,05 ₽.
//   ℹ️ (не пронумерованная проверка, только информационная строка): is_return
//      НЕ фильтруется — независимая проверка №1 явно НЕ добавляет "AND
//      is_return=0"; отдельно выводится строка «что было бы, если» — это
//      находка задачи 2 (брифинг явно просил её зафиксировать), не
//      обязательная проверка (нечего регрессировать — фильтра никогда не
//      было в этом каноне).
//
// Использование:
//   node scripts/check-profit-canon.mjs
//   node scripts/check-profit-canon.mjs --cabinet 1 --from 2026-07-01 --to 2026-07-31
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { withTenant, query, DatabaseSync } = await import('../lib/db.js');
const { ozProfitProduct, ozProfitCabinet, ozProfitProductBatch, ozRawProfitByDay, ozDayProfit } = await import('../lib/ozonMetrics.js');
const { wbProfitProduct, wbProfitCabinet, wbProfitProductBatch, wbRawProfitByDay, wbDayProfit } = await import('../lib/wbMetrics.js');
const { ZERO_RAW_AGG } = await import('../lib/profitForms.js');
const { calcTotalTax, normalizeTaxMode } = await import('../lib/tax.js');
const { SERVICE_TYPE_LABELS, NON_SERVICE_PER_ORDER_SETS } = await import('../lib/ozonServiceTypes.js');

function parseArgs(argv) {
  const out = { cabinet: 1, from: '2026-07-01', to: '2026-07-31' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cabinet') out.cabinet = Number(argv[++i]);
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const CABINET_ID = args.cabinet;
const FROM = args.from;
const TO = args.to;
const TOL = 0.01; // ₽ — тот же допуск, что и «инвариант периода» check-ozon-profit-invariant.mjs
const PRODUCT_SUM_TOL = 0.05; // ₽ — допуск для Σ по товарам/nm (много round2 подряд)

// Допуск №7 (Σ дней vs скаляр): до 3 округлений/день (VAT, УСН, profit —
// см. ozDayProfit) по ≤0,005 ₽ + подневное округление Σ. На месячном окне
// ≈ прежние 0,05-0,6 ₽; на квартале растёт линейно — фиксированный допуск
// давал бы ложный FAIL. Пол 0,05 ₽ — короткие окна.
const dailySumTol = (days) => Math.max(0.05, 0.02 * days);
const periodDays = Math.round((new Date(TO) - new Date(FROM)) / 86400000) + 1;

const fmtRub = (n) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

// ── Проверка №6 (задача 2 плана «канон волна 2»): инвариант batch ≡ скаляр —
// ozProfitProductBatch/wbProfitProductBatch(period).get(id) обязан
// покомпонентно совпадать с ozProfitProduct/wbProfitProduct(period, id).
// Поля сравнения — по брифингу задачи 2 (rawProfit НЕ входит, это служебное
// поле batch-Map, у скаляра его нет в контракте). ──
// services добавлено задачей 3 плана «Сборы Ozon» (2026-08-25) — WB-объекты
// его не пишут, num() в этой же проверке трактует undefined как 0, поэтому
// WB-секция (общий массив ниже) не ловит ложных расхождений.
const BATCH_SCALAR_FIELDS = [
  'revenue', 'cogs', 'commission', 'services', 'logistics', 'acquiring', 'loyalty',
  'ads', 'tax', 'profit', 'profitGross', 'returnLogistics',
];

// Fisher–Yates по копии массива, берём первые n — случайный отбор id для
// проверки №6 (5 или все, если товаров/nm в периоде меньше 5).
function pickRandomIds(ids, n) {
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

// ── Проверка №9 (пост-ревью плана «расшифровка Сборов Ozon», 2026-08-25):
// паритет множеств классификации py↔js. worker/collectors/
// ozon_profit_map.py::classify_row — источник истины, по которому сборщик
// (ozon_order_costs.py) считает order_costs.services; lib/ozonServiceTypes.js
// ::isServiceRow — JS-зеркало ТОЙ ЖЕ логики, которым detail-роут строит
// тултип расшифровки этой самой ячейки (см. докстроки обоих файлов —
// «двустороннее зеркало», встречные комментарии друг на друга). Ничто
// механически не мешает им разъехаться при правке одного файла без
// другого: PY и JS — разные рантаймы, общего импорта нет и быть не может.
// Если разъедутся — ячейка (py) и тултип (js) молча классифицируют один и
// тот же type_id по-разному, без единой ошибки в логах. Эта проверка
// вычитывает СЫРОЙ текст ozon_profit_map.py регэкспом (не может импортировать
// питон-модуль в node) и сравнивает 4 множества с их JS-аналогами.
//
// Парсер простой и строгий по требованию задачи: если формат блока
// изменился (не голый `NAME = {int, int, ...}` / `NAME = set()`) —
// parsePySet бросает исключение с понятным текстом, проверка ниже ловит
// её и превращает в FAIL, а не в молчаливый пропуск/пустое множество.
function parsePySet(src, varName) {
  if (new RegExp(`\\b${varName}\\s*=\\s*set\\(\\)`).test(src)) return new Set();
  const startMarker = `${varName} = {`;
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(
      `не найдено множество "${varName}" (ни "${varName} = {...}", ни "${varName} = set()") — формат ozon_profit_map.py изменился`
    );
  }
  const braceStart = startIdx + startMarker.length - 1; // индекс символа '{'
  const closeIdx = src.indexOf('}', braceStart);
  if (closeIdx === -1) {
    throw new Error(`не найдена закрывающая "}" для множества "${varName}"`);
  }
  const block = src.slice(braceStart + 1, closeIdx);
  const withoutComments = block.replace(/#.*$/gm, '');
  const nums = withoutComments.match(/\d+/g) || [];
  // Строгость: после удаления комментариев и вычитания всех чисел в блоке
  // не должно остаться ничего, кроме запятых/пробелов/переводов строк —
  // если осталось (выражение, диапазон, чужая ссылка на константу) —
  // формат сложнее голого перечисления int-литералов, парсер это не умеет.
  const residue = withoutComments.replace(/\d+/g, '').replace(/[\s,]/g, '');
  if (residue.length > 0) {
    throw new Error(
      `множество "${varName}" содержит нечисловой токен после разбора ("${residue}") — блок не голый перечень int-литералов через запятую`
    );
  }
  return new Set(nums.map(Number));
}

// Сравнение двух Set<number> — разница в обе стороны (для текста FAIL).
function diffSets(a, b) {
  const onlyInA = [...a].filter((x) => !b.has(x)).sort((x, y) => x - y);
  const onlyInB = [...b].filter((x) => !a.has(x)).sort((x, y) => x - y);
  return { equal: onlyInA.length === 0 && onlyInB.length === 0, onlyInA, onlyInB };
}

// Сама сверка (вынесена функцией — так же вызывается негативным юнит-тестом
// вне рабочего дерева, см. отчёт задачи). pySrc — сырой текст
// ozon_profit_map.py, jsSets — { SERVICE_TYPE_LABELS, NON_SERVICE_PER_ORDER_SETS }
// с ИМЕНАМИ экспортов lib/ozonServiceTypes.js. Возвращает { ok, detail }.
function checkPyJsSetParity(pySrc, jsSets) {
  let pySets;
  try {
    pySets = {
      PER_ORDER_SERVICE_TYPE_IDS: parsePySet(pySrc, 'PER_ORDER_SERVICE_TYPE_IDS'),
      PER_ORDER_LOGISTICS_TYPE_IDS: parsePySet(pySrc, 'PER_ORDER_LOGISTICS_TYPE_IDS'),
      ACQUIRING_TYPE_IDS: parsePySet(pySrc, 'ACQUIRING_TYPE_IDS'),
      LOYALTY_TYPE_IDS: parsePySet(pySrc, 'LOYALTY_TYPE_IDS'),
    };
  } catch (e) {
    return { ok: false, detail: `парсер ozon_profit_map.py упал: ${e.message}` };
  }
  const jsSetsByName = {
    PER_ORDER_SERVICE_TYPE_IDS: new Set(Object.keys(jsSets.SERVICE_TYPE_LABELS).map(Number)),
    PER_ORDER_LOGISTICS_TYPE_IDS: jsSets.NON_SERVICE_PER_ORDER_SETS.PER_ORDER_LOGISTICS_TYPE_IDS,
    ACQUIRING_TYPE_IDS: jsSets.NON_SERVICE_PER_ORDER_SETS.ACQUIRING_TYPE_IDS,
    LOYALTY_TYPE_IDS: jsSets.NON_SERVICE_PER_ORDER_SETS.LOYALTY_TYPE_IDS,
  };
  const mismatches = [];
  for (const key of Object.keys(pySets)) {
    const cmp = diffSets(pySets[key], jsSetsByName[key]);
    if (!cmp.equal) {
      mismatches.push(`${key}: только в py {${cmp.onlyInA.join(',')}}, только в js {${cmp.onlyInB.join(',')}}`);
    }
  }
  return {
    ok: mismatches.length === 0,
    detail: mismatches.length
      ? mismatches.join('; ')
      : `все 4 множества совпадают (${Object.entries(pySets).map(([k, v]) => `${k}=${v.size}`).join(', ')})`,
  };
}

let failures = 0;
function verdict(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

const roPool = new pg.Pool(readonlyPgConfig());

// ═════════════════════════════ OZON ═════════════════════════════
async function runOzonChecks() {
  console.log(`Сторож канонического слоя прибыли Ozon — кабинет ${CABINET_ID}, период ${FROM}..${TO}`);
  console.log('');

  // ── Налоговый режим кабинета (auth.shops, вне RLS — та же таблица, что
  // читает withCabinet.js для cabinet.shopTax.ozon). ──
  const shopRows = await query(
    `SELECT tax_mode FROM auth.shops WHERE cabinet_id = $1 AND mp_code = 'ozon' AND is_active = true LIMIT 1`,
    [CABINET_ID]
  );
  const taxMode = normalizeTaxMode(shopRows[0]?.tax_mode || null);
  console.log(`Налоговый режим (auth.shops): ${JSON.stringify(taxMode)}`);
  console.log('');

  // ── Канон — через штатное подключение панели (withTenant/DatabaseSync,
  // ровно как настоящий роут за withCabinet). ──
  const canon = await withTenant(CABINET_ID, async () => {
    const db = new DatabaseSync('ozon', { readOnly: true });
    const profitProduct = await ozProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, null);
    const profitCabinet = await ozProfitCabinet(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO });

    // Список товаров периода — для проверки 5 (productId-фильтр).
    const productRows = await db
      .prepare(
        `SELECT DISTINCT product_id FROM order_costs
         WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
           AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
           AND product_id IS NOT NULL
         ORDER BY product_id`
      )
      .all(FROM, TO);
    const nullProductRow = await db
      .prepare(
        `SELECT count(*) AS n FROM order_costs
         WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
           AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
           AND product_id IS NULL`
      )
      .get(FROM, TO);
    const qtyRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM order_costs WHERE qty IS NOT NULL AND qty <> 1`)
      .get();

    let sumByProduct = 0;
    let sumByProductAds = 0;
    for (const row of productRows) {
      const pp = await ozProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, row.product_id);
      sumByProduct += pp.profit;
      sumByProductAds += pp.ads;
    }

    // ── Проверка №6: инвариант batch ≡ скаляр — 5 случайных product_id (или
    // все, если товаров < 5) из ozProfitProductBatch, сравнить покомпонентно
    // со скалярным ozProfitProduct(..., id). ──
    const batchMap = await ozProfitProductBatch(db, taxMode, { from: FROM, to: TO });
    const batchIds = pickRandomIds([...batchMap.keys()], Math.min(5, batchMap.size));
    const batchVsScalar = [];
    for (const id of batchIds) {
      const scalar = await ozProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, id);
      batchVsScalar.push({ id, batch: batchMap.get(id), scalar });
    }

    // ── Проверка №7 (задача 6 плана «канон волна 2»): дневной канон Σ =
    // скаляр — до 3 product_id с продажами (или все, если товаров < 3). №7
    // исполняет ТУ ЖЕ ozDayProfit, что и detail-роут — сторожится и формула,
    // и route-композиция. ⚠️ Σ теперь из ПОДНЕВНО округлённых значений (как
    // в роуте и как суммирует UI) — осознанное изменение внутренностей
    // проверки, роут-числа не меняются. ──
    const dailyCheckIds = productRows.slice(0, 3).map((r) => r.product_id);
    const dailyChecks = [];
    for (const productId of dailyCheckIds) {
      const scalar = await ozProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, productId);
      const rawByDay = await ozRawProfitByDay(db, { from: FROM, to: TO, productId });
      const adRows = await db
        .prepare(
          `SELECT date::text AS d, ad_spend FROM daily_metrics
           WHERE product_id = ? AND date::text >= ? AND date::text <= ? AND ad_spend IS NOT NULL`
        )
        .all(productId, FROM, TO);
      const adByDate = new Map(adRows.map((r) => [r.d, r.ad_spend]));
      // ⚠️ Союз дат rawByDay∪adByDate (НЕ только rawByDay!) — товар может
      // рекламироваться в день без единой продажи (ozon_daily_sku_ad не
      // синхронизирован с order_costs). Итерация только по rawByDay теряла
      // бы ad_spend таких дней целиком — та же находка, что заставила
      // route-код (collectOzon) считать profit БЕЗУСЛОВНО на каждый день.
      const allDates = new Set([...rawByDay.keys(), ...adByDate.keys()]);
      let sumDaily = 0;
      for (const d of allDates) {
        const raw = rawByDay.get(d) || ZERO_RAW_AGG;
        const adDay = adByDate.get(d) || 0;
        sumDaily += ozDayProfit(raw, adDay, taxMode);
      }
      dailyChecks.push({ id: productId, scalarProfit: scalar.profit, sumDaily: Math.round(sumDaily * 100) / 100 });
    }

    return {
      profitProduct, profitCabinet,
      productCount: productRows.length,
      nullProductRows: Number(nullProductRow?.n) || 0,
      qtyAnomalies: Number(qtyRow?.n) || 0,
      sumByProduct: Math.round(sumByProduct * 100) / 100,
      sumByProductAds: Math.round(sumByProductAds * 100) / 100,
      productIds: productRows.map((r) => r.product_id),
      batchVsScalar,
      dailyChecks,
    };
  });

  console.log('ozProfitProduct (без productId):', JSON.stringify(canon.profitProduct));
  console.log('ozProfitCabinet.cabinetCosts:', JSON.stringify(canon.profitCabinet.cabinetCosts));
  console.log(`ozProfitCabinet.unknownCostTypes: ${canon.profitCabinet.unknownCostTypes}`);
  console.log(`Товаров в периоде (product_id NOT NULL): ${canon.productCount}, строк с product_id IS NULL: ${canon.nullProductRows}`);
  console.log('');

  // ── Независимая сверка (saas_ro, явный cabinet_id, БЕЗ обращения к
  // канону — своя SQL с нуля). ──
  const { rows: [rawRow] } = await roPool.query(
    `SELECT
       COALESCE(SUM(cost_value_retail),0) AS revenue,
       COALESCE(SUM(cost),0) AS cogs,
       COALESCE(SUM(commission),0) AS commission,
       COALESCE(SUM(services),0) AS services,
       COALESCE(SUM(logistics),0) AS logistics,
       COALESCE(SUM(acquiring),0) AS acquiring,
       COALESCE(SUM(loyalty),0) AS loyalty,
       COALESCE(SUM(profit),0) AS profit
     FROM tenant.ozon_order_costs
     WHERE cabinet_id = $1
       AND COALESCE(sale_dt, return_dt) BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const { rows: [adRow] } = await roPool.query(
    `SELECT COALESCE(SUM(ad_spend),0) AS s
     FROM tenant.ozon_daily_efficiency
     WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date AND ad_spend IS NOT NULL`,
    [CABINET_ID, FROM, TO]
  );
  const { rows: cabinetCostRows } = await roPool.query(
    `SELECT cost_type, COALESCE(SUM(amount),0) AS s
     FROM tenant.ozon_cabinet_costs
     WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date
     GROUP BY cost_type`,
    [CABINET_ID, FROM, TO]
  );

  const indRevenue = num(rawRow.revenue);
  const indCogs = num(rawRow.cogs);
  const indCommission = num(rawRow.commission);
  const indServices = num(rawRow.services);
  const indLogistics = num(rawRow.logistics);
  const indAcquiring = num(rawRow.acquiring);
  const indLoyalty = num(rawRow.loyalty);
  const indRawProfit = num(rawRow.profit);
  const indAdSpend = num(adRow.s);
  const indExpenses = indCogs + indCommission + indServices + indLogistics + indAcquiring + indLoyalty + indAdSpend;
  const indTax = calcTotalTax(taxMode, indRevenue, indExpenses).total;
  const indProfit = Math.round((indRawProfit - indAdSpend - indTax) * 100) / 100;
  // Знаковая сумма (правильная, после fix-раунда ревью задачи 1) и модульная
  // (старая, ошибочная формула — считаем ОБЕ, чтобы явно показать до/после
  // на живой положительной статье, не только использовать одну из них).
  const indCabinetSignedSum = cabinetCostRows.reduce((acc, r) => acc + num(r.s), 0);
  const indCabinetAbsSum = cabinetCostRows.reduce((acc, r) => acc + Math.abs(num(r.s)), 0);
  const positiveRows = cabinetCostRows.filter((r) => num(r.s) > 0);

  console.log('Независимый SQL (saas_ro):');
  console.log(`  revenue=${fmtRub(indRevenue)} cogs=${fmtRub(indCogs)} commission=${fmtRub(indCommission)} services=${fmtRub(indServices)} logistics=${fmtRub(indLogistics)} acquiring=${fmtRub(indAcquiring)} loyalty=${fmtRub(indLoyalty)}`);
  console.log(`  SUM(profit) сырой (все строки, без фильтра is_return) = ${fmtRub(indRawProfit)}`);
  console.log(`  ad_spend = ${fmtRub(indAdSpend)}, налог (calcTotalTax) = ${fmtRub(indTax)}`);
  console.log(`  profit независимый = SUM(profit) − ad_spend − налог = ${fmtRub(indProfit)}`);
  console.log(`  Σ cabinetCosts.amount (знаковая, используется в проверке 3) = ${fmtRub(indCabinetSignedSum)}`);
  if (positiveRows.length) {
    console.log(
      `  ⚠️ ${positiveRows.length} статья(и) с положительным знаком (доход, не расход): `
      + positiveRows.map((r) => `${r.cost_type}=${fmtRub(num(r.s))} ₽`).join(', ')
      + ` — ДО fix-раунда (ошибочная формула «− Σ|amount|») cabinetCosts.profit занижался бы ровно на 2×эту сумму`
      + ` (${fmtRub(2 * positiveRows.reduce((a, r) => a + num(r.s), 0))} ₽ на этих статьях).`
    );
  }
  console.log(`  СПРАВОЧНО, старая (ошибочная) формула Σ|cabinetCosts.amount| = ${fmtRub(indCabinetAbsSum)} (только для сравнения до/после, в проверке НЕ используется)`);
  console.log('');

  // ── Проверка 1 ──
  verdict(
    'ozProfitProduct.profit = независимый SQL (SUM(profit) − ad_spend − налог)',
    Math.abs(canon.profitProduct.profit - indProfit) <= TOL,
    `канон=${fmtRub(canon.profitProduct.profit)}, независимо=${fmtRub(indProfit)}, разница=${fmtRub(canon.profitProduct.profit - indProfit)}`
  );

  // ── Проверка 2: слагаемые аддитивны (revenue−cogs−commission−services−
  // logistics−acquiring−loyalty = сырой SUM(profit), знаковая формула
  // сборщика — services добавлено задачей 3 плана «Сборы Ozon», см.
  // worker/collectors/ozon_order_costs.py: comps = cost_value_retail −
  // commission − services − logistics − acquiring − loyalty ≈ sum_accrued). ──
  const compsProfit = canon.profitProduct.revenue - canon.profitProduct.cogs - canon.profitProduct.commission
    - canon.profitProduct.services - canon.profitProduct.logistics - canon.profitProduct.acquiring - canon.profitProduct.loyalty;
  verdict(
    'слагаемые аддитивны: revenue−cogs−commission−services−logistics−acquiring−loyalty = SUM(order_costs.profit)',
    Math.abs(compsProfit - indRawProfit) <= TOL,
    `по слагаемым=${fmtRub(compsProfit)}, независимый SUM(profit)=${fmtRub(indRawProfit)}, разница=${fmtRub(compsProfit - indRawProfit)}`
  );

  // ── Проверка 3: ozProfitCabinet.profit = ozProfitProduct.profit + Σ cabinetCosts (знаковая) ──
  const expectedCabinetProfitSigned = Math.round((canon.profitProduct.profit + indCabinetSignedSum) * 100) / 100;
  const expectedCabinetProfitAbsOld = Math.round((canon.profitProduct.profit - indCabinetAbsSum) * 100) / 100;
  verdict(
    'ozProfitCabinet.profit = ozProfitProduct.profit + Σ cabinetCosts[].amount (знаковая сумма)',
    Math.abs(canon.profitCabinet.profit - expectedCabinetProfitSigned) <= TOL,
    `канон=${fmtRub(canon.profitCabinet.profit)}, ожидание(знаковая)=${fmtRub(expectedCabinetProfitSigned)}`
    + ` [ДО fix-раунда, модульная формула, дала бы ${fmtRub(expectedCabinetProfitAbsOld)} — разница ${fmtRub(expectedCabinetProfitSigned - expectedCabinetProfitAbsOld)} ₽]`
  );

  // ── Проверка 4: labels без сырого accrual_ ──
  const rawLabels = canon.profitCabinet.cabinetCosts.filter((c) => String(c.label).includes('accrual_'));
  verdict(
    'cabinetCosts[].label не содержит сырой "accrual_" ни в одной статье',
    rawLabels.length === 0,
    rawLabels.length ? `сырых меток: ${rawLabels.length} (${rawLabels.map((c) => `${c.costType}→"${c.label}"`).join(', ')})` : `${canon.profitCabinet.cabinetCosts.length} статей, все с русскими именами`
  );

  // ── Проверка 5: productId-фильтр аддитивен (см. докстроку файла, п.5,
  // формула задачи 6). Допуск шире базового (0,05 ₽ вместо 0,01): 44
  // товара, у каждого свой round2(tax) — независимые округления могут
  // накопить пару копеек, что не является расхождением канона (в отличие
  // от проверок 1-3, где сравнение идёт «один канон-вызов vs один
  // независимый SQL» без per-item округлений). ──
  const unallocatedAds = Math.round((canon.profitProduct.ads - canon.sumByProductAds) * 100) / 100;
  const sumByProductMinusUnallocated = Math.round((canon.sumByProduct - unallocatedAds) * 100) / 100;
  verdict(
    'productId-фильтр аддитивен: Σ ozProfitProduct(товар).profit − (ads(кабинета) − Σ ads(товар)) = ozProfitProduct(без фильтра).profit',
    Math.abs(sumByProductMinusUnallocated - canon.profitProduct.profit) <= PRODUCT_SUM_TOL,
    `Σ profit(товар)=${fmtRub(canon.sumByProduct)} (${canon.productCount} тов.), Σ ads(товар)=${fmtRub(canon.sumByProductAds)}, ads(кабинета)=${fmtRub(canon.profitProduct.ads)}, нераспределено=${fmtRub(unallocatedAds)} ⇒ ${fmtRub(sumByProductMinusUnallocated)}, без фильтра=${fmtRub(canon.profitProduct.profit)}`
  );
  if (canon.nullProductRows > 0) {
    console.log(`  ⚠️ product_id IS NULL строк в периоде: ${canon.nullProductRows} — их деньги в Σ по товарам не попадают (ожидаемо, не баг проверки).`);
  }

  // ── Проверка 5б (находка ревью задачи 6): проверка 5 выше алгебраически
  // НЕЧУВСТВИТЕЛЬНА к фактическому значению ads_i — Σ profit(товар) уже
  // содержит "−ads_i" (см. ozProfitProduct), а поправка "−(ads(кабинета) −
  // Σ ads(товар))" прибавляет Σ ads_i обратно → ads_i сокращаются в формуле,
  // проверка 5 прошла бы ЗЕЛЁНОЙ, даже если бы ozAdSpend(productId) всегда
  // возвращал 0 или любое другое неверное число, лишь бы одно и то же число
  // подставлялось и в profit(товар), и в Σ ads(товар). Эта проверка —
  // НЕЗАВИСИМАЯ сверка САМИХ значений ads_i (не их алгебраической роли):
  // Σ ads(товар), которую только что посчитал канон (через ozAdSpend по
  // каждому product_id в цикле выше), против ОДНОГО bulk SQL-запроса к тому
  // же ozon_daily_metrics.ad_spend по ТОМУ ЖЕ множеству product_id — другой
  // код (агрегатный GROUP не нужен, просто SUM с ANY-фильтром), другое
  // подключение (roPool/saas_ro, без RLS), поэтому баг в SQL-тексте самого
  // ozAdSpend (например, неверная граница даты) здесь бы проявился. ──
  const { rows: [pidAdRow] } = await roPool.query(
    `SELECT COALESCE(SUM(ad_spend),0) AS s
     FROM tenant.ozon_daily_metrics
     WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date
       AND product_id = ANY($4::bigint[])`,
    [CABINET_ID, FROM, TO, canon.productIds]
  );
  const indSumByProductAds = num(pidAdRow.s);
  verdict(
    'Σ ads(товар) = SQL(ad_spend) — независимая проверка (bulk SUM по ozon_daily_metrics, тот же набор product_id)',
    Math.abs(canon.sumByProductAds - indSumByProductAds) <= PRODUCT_SUM_TOL,
    `Σ ads(товар) канон=${fmtRub(canon.sumByProductAds)}, независимый SQL=${fmtRub(indSumByProductAds)}, разница=${fmtRub(canon.sumByProductAds - indSumByProductAds)}`
  );
  console.log('');

  // ── Проверка №6 (задача 2 плана «канон волна 2»): инвариант batch ≡
  // скаляр — ozProfitProductBatch(period).get(id) обязан покомпонентно
  // совпадать с ozProfitProduct(period, id) на СЛУЧАЙНОЙ выборке id (5 или
  // все, если товаров < 5 — см. canon.batchVsScalar выше). ──
  {
    let worstField = null;
    let worstDiff = 0;
    let worstId = null;
    let allOk = true;
    for (const { id, batch, scalar } of canon.batchVsScalar) {
      for (const field of BATCH_SCALAR_FIELDS) {
        const diff = Math.abs(num(batch[field]) - num(scalar[field]));
        if (diff > TOL) allOk = false;
        if (diff >= worstDiff) { worstDiff = diff; worstField = field; worstId = id; }
      }
    }
    verdict(
      'инвариант batch ≡ скаляр: ozProfitProductBatch(period).get(id) = ozProfitProduct(period, id) покомпонентно',
      allOk,
      `проверено ${canon.batchVsScalar.length} товаров, макс |Δ| по полю ${worstField ?? '—'} = ${fmtRub(worstDiff)}${worstId != null ? ` (product_id=${worstId})` : ''}`
    );
  }
  console.log('');

  // ── Проверка №7 (задача 6 плана «канон волна 2»): дневной канон Σ =
  // скаляр — до 3 product_id с продажами (или все, если товаров < 3, см.
  // canon.dailyChecks выше). ──
  {
    let worstDiff = 0;
    let worstId = null;
    let allOk = true;
    for (const { id, scalarProfit, sumDaily } of canon.dailyChecks) {
      const diff = Math.abs(sumDaily - scalarProfit);
      if (diff > dailySumTol(periodDays)) allOk = false;
      if (diff >= worstDiff) { worstDiff = diff; worstId = id; }
      console.log(`  product_id=${id}: скаляр=${fmtRub(scalarProfit)}, Σ дней=${fmtRub(sumDaily)}, Δ=${fmtRub(sumDaily - scalarProfit)}`);
    }
    verdict(
      'дневной канон: Σ profit(день) [ozRawProfitByDay + ads(день) + tax(день)] = ozProfitProduct(period, id).profit',
      allOk,
      `проверено ${canon.dailyChecks.length} товаров, макс |Δ| = ${fmtRub(worstDiff)}, допуск ${fmtRub(dailySumTol(periodDays))}${worstId != null ? ` (product_id=${worstId})` : ''}`
    );
  }
  console.log('');

  // ── Проверка №8: инвариант qty ≡ 1 (ozon_order_costs). Канон читает
  // revenue как SUM(cost_value_retail) БЕЗ умножения на qty (скаляр, batch,
  // by-day — все три). Пока сборщик пишет строку на юнит (qty всегда 1) —
  // это верно; появись qty>1, выручка канона молча занизится. ──
  verdict(
    'инвариант qty ≡ 1: строк ozon_order_costs с qty∉{NULL,1} нет',
    canon.qtyAnomalies === 0,
    `строк с qty≠1: ${canon.qtyAnomalies}`
  );
  console.log('');

  // ── Проверка №9 (пост-ревью плана «расшифровка Сборов Ozon»): паритет
  // наборов py↔js — см. коммент у parsePySet/checkPyJsSetParity выше.
  // Детерминированная, БД не трогает (сырой текст ozon_profit_map.py читается
  // синхронно с диска, jsSets — уже импортированные экспорты
  // lib/ozonServiceTypes.js). ──
  {
    const pySrc = readFileSync(new URL('../worker/collectors/ozon_profit_map.py', import.meta.url), 'utf8');
    const { ok, detail } = checkPyJsSetParity(pySrc, { SERVICE_TYPE_LABELS, NON_SERVICE_PER_ORDER_SETS });
    verdict(
      'паритет наборов py↔js: PER_ORDER_SERVICE_TYPE_IDS/PER_ORDER_LOGISTICS_TYPE_IDS/ACQUIRING_TYPE_IDS/LOYALTY_TYPE_IDS (ozon_profit_map.py) = ozonServiceTypes.js (SERVICE_TYPE_LABELS/NON_SERVICE_PER_ORDER_SETS)',
      ok,
      detail
    );
  }
  console.log('');
}

// ═════════════════════════════ WB ═════════════════════════════
async function runWbChecks() {
  console.log(`Сторож канонического слоя прибыли WB — кабинет ${CABINET_ID}, период ${FROM}..${TO}`);
  console.log('');

  const shopRows = await query(
    `SELECT tax_mode FROM auth.shops WHERE cabinet_id = $1 AND mp_code = 'wb' AND is_active = true LIMIT 1`,
    [CABINET_ID]
  );
  const taxMode = normalizeTaxMode(shopRows[0]?.tax_mode || null);
  console.log(`Налоговый режим (auth.shops): ${JSON.stringify(taxMode)}`);
  console.log('');

  const canon = await withTenant(CABINET_ID, async () => {
    const db = new DatabaseSync('wb', { readOnly: true });
    const profitProduct = await wbProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, null);
    const profitCabinet = await wbProfitCabinet(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO });

    // Список nm периода — для проверки 5 (nmId-фильтр).
    const nmRows = await db
      .prepare(
        `SELECT DISTINCT nm_id FROM order_costs
         WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
           AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
           AND nm_id IS NOT NULL
         ORDER BY nm_id`
      )
      .all(FROM, TO);
    const nullNmRow = await db
      .prepare(
        `SELECT count(*) AS n FROM order_costs
         WHERE substr(COALESCE(sale_dt, return_dt),1,10) >= ?
           AND substr(COALESCE(sale_dt, return_dt),1,10) <= ?
           AND nm_id IS NULL`
      )
      .get(FROM, TO);

    let sumByNm = 0;
    let sumByNmAds = 0;
    for (const row of nmRows) {
      const pp = await wbProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, row.nm_id);
      sumByNm += pp.profit;
      sumByNmAds += pp.ads;
    }

    // ── Проверка №6 (симметрично Ozon): 5 случайных nm_id (или все, если
    // nm в периоде < 5) из wbProfitProductBatch, сравнить покомпонентно со
    // скалярным wbProfitProduct(..., nm_id). ──
    const batchMap = await wbProfitProductBatch(db, taxMode, { from: FROM, to: TO });
    const batchIds = pickRandomIds([...batchMap.keys()], Math.min(5, batchMap.size));
    const batchVsScalar = [];
    for (const id of batchIds) {
      const scalar = await wbProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, id);
      batchVsScalar.push({ id, batch: batchMap.get(id), scalar });
    }

    // ── Проверка №7 (задача 6 плана «канон волна 2», симметрично Ozon):
    // дневной канон Σ = скаляр — до 3 nm_id с продажами (или все, если nm в
    // периоде < 3). №7 исполняет ТУ ЖЕ wbDayProfit, что и detail-роут —
    // сторожится и формула, и route-композиция. ⚠️ Σ теперь из ПОДНЕВНО
    // округлённых значений (как в роуте и как суммирует UI) — осознанное
    // изменение внутренностей проверки, роут-числа не меняются. ──
    const dailyCheckIds = nmRows.slice(0, 3).map((r) => r.nm_id);
    const dailyChecks = [];
    for (const nmId of dailyCheckIds) {
      const scalar = await wbProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, nmId);
      const rawByDay = await wbRawProfitByDay(db, { from: FROM, to: TO, nmId });
      const adRows = await db
        .prepare(
          `SELECT date::text AS d, ad_spend FROM daily_metrics
           WHERE date >= ? AND date <= ? AND nm_id = ? AND ad_spend IS NOT NULL`
        )
        .all(FROM, TO, nmId);
      const adByDate = new Map(adRows.map((r) => [r.d, r.ad_spend]));
      // ⚠️ Союз дат rawByDay∪adByDate — симметрично Ozon-версии выше (nm_id
      // может рекламироваться в день без продажи, wb_daily_metrics не
      // синхронизирован с order_costs).
      const allDates = new Set([...rawByDay.keys(), ...adByDate.keys()]);
      let sumDaily = 0;
      for (const d of allDates) {
        const raw = rawByDay.get(d) || ZERO_RAW_AGG;
        const adDay = adByDate.get(d) || 0;
        sumDaily += wbDayProfit(raw, adDay, taxMode);
      }
      dailyChecks.push({ id: nmId, scalarProfit: scalar.profit, sumDaily: Math.round(sumDaily * 100) / 100 });
    }

    return {
      profitProduct, profitCabinet,
      nmCount: nmRows.length,
      nullNmRows: Number(nullNmRow?.n) || 0,
      sumByNm: Math.round(sumByNm * 100) / 100,
      sumByNmAds: Math.round(sumByNmAds * 100) / 100,
      nmIds: nmRows.map((r) => r.nm_id),
      batchVsScalar,
      dailyChecks,
    };
  });

  console.log('wbProfitProduct (без nmId):', JSON.stringify(canon.profitProduct));
  console.log('wbProfitCabinet.cabinetCosts:', JSON.stringify(canon.profitCabinet.cabinetCosts));
  console.log(`wbProfitCabinet.unknownCostTypes: ${canon.profitCabinet.unknownCostTypes}`);
  console.log(`nm_id в периоде (nm_id NOT NULL): ${canon.nmCount}, строк с nm_id IS NULL: ${canon.nullNmRows}`);
  console.log('');

  // ── Независимая сверка (saas_ro, явный cabinet_id, БЕЗ обращения к
  // канону — своя SQL с нуля). is_return НЕ фильтруется (см. докстроку
  // файла п.6 WB-секции). ──
  const { rows: [rawRow] } = await roPool.query(
    `SELECT
       COALESCE(SUM(cost_value_pay),0) AS revenue,
       COALESCE(SUM(cost),0) AS cogs,
       COALESCE(SUM(commission),0) AS commission,
       COALESCE(SUM(acquiring),0) AS acquiring,
       COALESCE(SUM(logistics),0) AS logistics,
       COALESCE(SUM(loyalty),0) AS loyalty,
       COALESCE(SUM(profit),0) AS profit
     FROM tenant.wb_order_costs
     WHERE cabinet_id = $1
       AND substr(COALESCE(sale_dt, return_dt),1,10) BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  // Контрольная сумма С фильтром is_return=0 — ТОЛЬКО для информационной
  // строки «что было бы, если» (находка задачи 2, брифинг требовал
  // зафиксировать сумму). В самой проверке 1 НЕ участвует.
  //
  // ⚠️ substr(...,1,10) — sale_dt/return_dt в wb_order_costs хранятся как
  // TEXT ПОЛНЫМ ISO-таймстампом ('2026-07-31T14:40:29Z'), а не голой датой
  // (в отличие от Ozon, где sale_dt/return_dt — DATE). Голый BETWEEN с
  // датой-строкой без substr систематически теряет последний день периода
  // (лексикографически '2026-07-31T...' > '2026-07-31' → верхняя граница
  // не проходит) — классический «T vs пробел» гоча проекта (коммит
  // 92a072a), пойманный здесь заново при первом прогоне: без substr WB
  // canon PROFIT расходился с «независимым» SQL на 6 501,77 ₽ (потерянный
  // весь день 31.07). canon (lib/wbMetrics.js) сам всегда использует
  // substr — независимая сверка обязана делать так же.
  const { rows: [filteredRow] } = await roPool.query(
    `SELECT COALESCE(SUM(profit),0) AS profit
     FROM tenant.wb_order_costs
     WHERE cabinet_id = $1 AND is_return = 0
       AND substr(COALESCE(sale_dt, return_dt),1,10) BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const { rows: [adRow] } = await roPool.query(
    `SELECT COALESCE(SUM(ad_spend),0) AS s
     FROM tenant.wb_daily_metrics
     WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date AND ad_spend IS NOT NULL`,
    [CABINET_ID, FROM, TO]
  );
  const { rows: cabinetCostRows } = await roPool.query(
    `SELECT cost_type, COALESCE(SUM(amount),0) AS s
     FROM tenant.wb_cabinet_costs
     WHERE cabinet_id = $1 AND period_from <= $3::date AND period_to >= $2::date
     GROUP BY cost_type`,
    [CABINET_ID, FROM, TO]
  );

  const indRevenue = num(rawRow.revenue);
  const indCogs = num(rawRow.cogs);
  const indLogistics = num(rawRow.logistics);
  const indRawProfit = num(rawRow.profit);
  const indAdSpend = num(adRow.s);
  // Налоговая база — та же, что в wbProfitProduct: cogs + logistics + ads
  // (commission/acquiring/loyalty уже внутри revenue=cost_value_pay).
  const indExpenses = indCogs + indLogistics + indAdSpend;
  const indTax = calcTotalTax(taxMode, indRevenue, indExpenses).total;
  const indProfit = Math.round((indRawProfit - indAdSpend - indTax) * 100) / 100;

  // cabinetCosts: сырой знак у WB инвертирован относительно Ozon (см.
  // докстроку wbProfitCabinet) — независимая сумма считает −amount_raw,
  // тот же контракт, что отдаёт канон.
  const indCabinetSignedSum = cabinetCostRows.reduce((acc, r) => acc - num(r.s), 0);
  const negativeRawRows = cabinetCostRows.filter((r) => num(r.s) < 0);

  console.log('Независимый SQL (saas_ro):');
  console.log(`  revenue(cost_value_pay)=${fmtRub(indRevenue)} cogs=${fmtRub(indCogs)} logistics=${fmtRub(indLogistics)}`);
  console.log(`  SUM(profit) сырой (все строки, без фильтра is_return) = ${fmtRub(indRawProfit)}`);
  console.log(`  ad_spend(кабинет) = ${fmtRub(indAdSpend)}, налог (calcTotalTax, база=revenue) = ${fmtRub(indTax)}`);
  console.log(`  profit независимый = SUM(profit) − ad_spend − налог = ${fmtRub(indProfit)}`);
  console.log(`  Σ cabinetCosts.amount (нормализованный знак, канон-контракт) = ${fmtRub(indCabinetSignedSum)}`);
  if (negativeRawRows.length) {
    console.log(
      `  ⚠️ ${negativeRawRows.length} статья(и) с ОТРИЦАТЕЛЬНЫМ сырым знаком в БД (= доход/возмещение продавцу по докстроке wb_cabinet_costs.py, канон покажет их ПОЛОЖИТЕЛЬНЫМИ): `
      + negativeRawRows.map((r) => `${r.cost_type}=${fmtRub(num(r.s))} ₽(сырой)`).join(', ')
    );
  }
  // ── Находка задачи 2 (брифинг): what-if is_return=0 фильтр (как старый
  // Ozon-баг задачи 1) — не применяется в каноне, только измеряется. ──
  const isReturnFilterLoss = Math.round((indRawProfit - num(filteredRow.profit)) * 100) / 100;
  console.log('');
  console.log(`ℹ️  Проверка is_return (находка задачи 2, брифинг): SUM(profit) БЕЗ фильтра = ${fmtRub(indRawProfit)}; С фильтром is_return=0 (гипотетическая калька Ozon-бага задачи 1) = ${fmtRub(num(filteredRow.profit))}; разница (убыток возвратов, который фильтр бы СКРЫЛ) = ${fmtRub(isReturnFilterLoss)} ₽.`);
  console.log(`   Канон is_return НЕ фильтрует (проверка 1 ниже сверяется с БЕЗ-фильтра суммой) — находка зафиксирована, регресса нет.`);
  console.log('');

  // ── Проверка 1 ──
  verdict(
    'wbProfitProduct.profit = независимый SQL (SUM(order_costs.profit, БЕЗ is_return-фильтра) − ad_spend − налог)',
    Math.abs(canon.profitProduct.profit - indProfit) <= TOL,
    `канон=${fmtRub(canon.profitProduct.profit)}, независимо=${fmtRub(indProfit)}, разница=${fmtRub(canon.profitProduct.profit - indProfit)}`
  );

  // ── Проверка 2: слагаемые аддитивны (revenue−cogs−logistics = сырой
  // SUM(profit) — ppvz-модель, commission/acquiring/loyalty НЕ участвуют). ──
  const compsProfit = canon.profitProduct.revenue - canon.profitProduct.cogs - canon.profitProduct.logistics;
  verdict(
    'слагаемые аддитивны (ppvz-модель): revenue−cogs−logistics = SUM(wb_order_costs.profit)',
    Math.abs(compsProfit - indRawProfit) <= TOL,
    `по слагаемым=${fmtRub(compsProfit)}, независимый SUM(profit)=${fmtRub(indRawProfit)}, разница=${fmtRub(compsProfit - indRawProfit)}`
  );

  // ── Проверка 3: wbProfitCabinet.profit = wbProfitProduct.profit + Σ cabinetCosts (нормализованный знак) ──
  const expectedCabinetProfit = Math.round((canon.profitProduct.profit + indCabinetSignedSum) * 100) / 100;
  verdict(
    'wbProfitCabinet.profit = wbProfitProduct.profit + Σ cabinetCosts[].amount (знак нормализован каноном)',
    Math.abs(canon.profitCabinet.profit - expectedCabinetProfit) <= TOL,
    `канон=${fmtRub(canon.profitCabinet.profit)}, ожидание=${fmtRub(expectedCabinetProfit)}`
  );

  // ── Проверка 4: labels резолвлены (ни один не равен сырому cost_type, unknownCostTypes=0) ──
  const unresolvedLabels = canon.profitCabinet.cabinetCosts.filter((c) => c.label === c.costType);
  verdict(
    'cabinetCosts[].label не равен сырому cost_type ни в одной статье (весь набор резолвлен словарём)',
    unresolvedLabels.length === 0 && canon.profitCabinet.unknownCostTypes === 0,
    unresolvedLabels.length
      ? `нерезолвленных: ${unresolvedLabels.length} (${unresolvedLabels.map((c) => c.costType).join(', ')}), unknownCostTypes=${canon.profitCabinet.unknownCostTypes}`
      : `${canon.profitCabinet.cabinetCosts.length} статей, все с русскими именами, unknownCostTypes=${canon.profitCabinet.unknownCostTypes}`
  );

  // ── Проверка 5: nmId-фильтр аддитивен (см. докстроку файла, WB п.5,
  // формула задачи 6, симметрично Ozon). ──
  const unallocatedAdsWb = Math.round((canon.profitProduct.ads - canon.sumByNmAds) * 100) / 100;
  const sumByNmMinusUnallocated = Math.round((canon.sumByNm - unallocatedAdsWb) * 100) / 100;
  verdict(
    'nmId-фильтр аддитивен: Σ wbProfitProduct(nm).profit − (ads(кабинета) − Σ ads(nm)) = wbProfitProduct(без фильтра).profit',
    Math.abs(sumByNmMinusUnallocated - canon.profitProduct.profit) <= PRODUCT_SUM_TOL,
    `Σ profit(nm)=${fmtRub(canon.sumByNm)} (${canon.nmCount} nm), Σ ads(nm)=${fmtRub(canon.sumByNmAds)}, ads(кабинета)=${fmtRub(canon.profitProduct.ads)}, нераспределено=${fmtRub(unallocatedAdsWb)} ⇒ ${fmtRub(sumByNmMinusUnallocated)}, без фильтра=${fmtRub(canon.profitProduct.profit)}`
  );
  if (canon.nullNmRows > 0) {
    console.log(`  ⚠️ nm_id IS NULL строк в периоде: ${canon.nullNmRows} — их деньги в Σ по nm не попадают (ожидаемо, не баг проверки).`);
  }

  // ── Проверка 5б (находка ревью задачи 6, симметрично Ozon): проверка 5
  // выше алгебраически нечувствительна к фактическому значению ads_i (то же
  // сокращение в формуле, см. коммент у Ozon-версии этой проверки). Здесь —
  // независимая сверка Σ ads(nm) против bulk SQL SUM(ad_spend) по тому же
  // множеству nm_id из wb_daily_metrics, другое подключение (roPool/
  // saas_ro). ──
  const { rows: [nmAdRow] } = await roPool.query(
    `SELECT COALESCE(SUM(ad_spend),0) AS s
     FROM tenant.wb_daily_metrics
     WHERE cabinet_id = $1 AND date BETWEEN $2::date AND $3::date
       AND nm_id = ANY($4::bigint[])`,
    [CABINET_ID, FROM, TO, canon.nmIds]
  );
  const indSumByNmAds = num(nmAdRow.s);
  verdict(
    'Σ ads(nm) = SQL(ad_spend) — независимая проверка (bulk SUM по wb_daily_metrics, тот же набор nm_id)',
    Math.abs(canon.sumByNmAds - indSumByNmAds) <= PRODUCT_SUM_TOL,
    `Σ ads(nm) канон=${fmtRub(canon.sumByNmAds)}, независимый SQL=${fmtRub(indSumByNmAds)}, разница=${fmtRub(canon.sumByNmAds - indSumByNmAds)}`
  );
  console.log('');

  // ── Проверка №6 (задача 2 плана «канон волна 2», симметрично Ozon):
  // инвариант batch ≡ скаляр — wbProfitProductBatch(period).get(nm_id)
  // обязан покомпонентно совпадать с wbProfitProduct(period, nm_id) на
  // СЛУЧАЙНОЙ выборке nm_id (5 или все, если nm < 5 — см. canon.
  // batchVsScalar выше). ──
  {
    let worstField = null;
    let worstDiff = 0;
    let worstId = null;
    let allOk = true;
    for (const { id, batch, scalar } of canon.batchVsScalar) {
      for (const field of BATCH_SCALAR_FIELDS) {
        const diff = Math.abs(num(batch[field]) - num(scalar[field]));
        if (diff > TOL) allOk = false;
        if (diff >= worstDiff) { worstDiff = diff; worstField = field; worstId = id; }
      }
    }
    verdict(
      'инвариант batch ≡ скаляр: wbProfitProductBatch(period).get(nm_id) = wbProfitProduct(period, nm_id) покомпонентно',
      allOk,
      `проверено ${canon.batchVsScalar.length} товаров, макс |Δ| по полю ${worstField ?? '—'} = ${fmtRub(worstDiff)}${worstId != null ? ` (nm_id=${worstId})` : ''}`
    );
  }
  console.log('');

  // ── Проверка №7 (задача 6 плана «канон волна 2», симметрично Ozon):
  // дневной канон Σ = скаляр — до 3 nm_id с продажами (или все, если nm в
  // периоде < 3, см. canon.dailyChecks выше). ──
  {
    let worstDiff = 0;
    let worstId = null;
    let allOk = true;
    for (const { id, scalarProfit, sumDaily } of canon.dailyChecks) {
      const diff = Math.abs(sumDaily - scalarProfit);
      if (diff > dailySumTol(periodDays)) allOk = false;
      if (diff >= worstDiff) { worstDiff = diff; worstId = id; }
      console.log(`  nm_id=${id}: скаляр=${fmtRub(scalarProfit)}, Σ дней=${fmtRub(sumDaily)}, Δ=${fmtRub(sumDaily - scalarProfit)}`);
    }
    verdict(
      'дневной канон: Σ profit(день) [wbRawProfitByDay + ads(день) + tax(день)] = wbProfitProduct(period, nm_id).profit',
      allOk,
      `проверено ${canon.dailyChecks.length} товаров, макс |Δ| = ${fmtRub(worstDiff)}, допуск ${fmtRub(dailySumTol(periodDays))}${worstId != null ? ` (nm_id=${worstId})` : ''}`
    );
  }
  console.log('');
}

try {
  await runOzonChecks();
  await runWbChecks();
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.stack || e.message}`);
  await roPool.end().catch(() => {});
  process.exit(3);
} finally {
  await roPool.end().catch(() => {});
}

if (failures === 0) {
  console.log('ALL PASS — канонический слой прибыли Ozon и WB сходится с независимым SQL до копейки.');
  process.exit(0);
} else {
  console.log(`ИТОГО ${failures} РАСХОЖДЕНИЕ(Й) — см. блоки выше.`);
  process.exit(1);
}
