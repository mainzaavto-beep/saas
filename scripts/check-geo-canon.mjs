#!/usr/bin/env node
// scripts/check-geo-canon.mjs — сторож канона «География» («одна цифра
// везде», задача 4 плана 2026-09-05-geo-canon-vitrina). Проверяет РЕАЛЬНЫЕ
// функции lib/geoMetrics.js (wbGeoSummary/ozGeoSummary/
// wbOrdersLocalityMatrix/ozOrdersLocalityMatrix) — не переизобретает их
// формулу — против НЕЗАВИСИМОГО SQL, посчитанного этим скриптом с нуля.
// Расхождение = баг канона/роута (finance-discrepancy-rule), не повод
// подгонять эталон.
//
// Два разных подключения (образец — scripts/check-profit-canon.mjs):
//   1) канон — DatabaseSync поверх withTenant(cabinetId, ...) (та же
//      RLS-транзакция, что открывает withCabinet на каждый запрос панели).
//      Креды — saas_app из .env.local (та же роль, что использует сама
//      панель).
//   2) независимая сверка — pg.Pool(readonlyPgConfig()), ТОЛЬКО saas_ro
//      (bypass RLS, явный cabinet_id в каждом запросе) — сторож физически
//      не может писать и не зависит от той же RLS-логики, что проверяет.
//
// Период по умолчанию — defaultPeriod(30) (по вчера, см. lib/period.js),
// кабинет по умолчанию — 1. --cabinet/--from/--to меняют вручную.
//
// ═══════════════════════════ ПРОВЕРКИ ═══════════════════════════
//   1. WB заказы: Σ wbGeoSummary.byRegion.ordersQty = независимый SQL
//      COUNT(*) FROM tenant.wb_orders WHERE cabinet_id=$1 AND is_cancel=0
//      AND substr(order_dt,1,10) BETWEEN from,to; рубли = SUM(price_with_disc)
//      тем же фильтром. Допуск 0,01.
//   2. Ozon заказы: Σ ozGeoSummary.byRegion.ordersQty = независимый SUM(qty)
//      FROM tenant.ozon_orders тем же фильтром (is_cancel=0, окно по
//      order_dt); рубли = SUM(total). Допуск 0,01.
//   3. Σ по byRegion = Σ по byWarehouse — внутри каждой платформы, отдельно
//      заказы и продажи (4 под-проверки: WB-заказы, WB-продажи, Ozon-заказы,
//      Ozon-продажи). Это сверка ВНУТРИ одного и того же вызова
//      wbGeoSummary/ozGeoSummary (два разных GROUP BY одних и тех же строк
//      обязаны давать одну и ту же сумму) — не против независимого SQL,
//      ловит регресс группировки/JOIN, теряющий или дублирующий строки в
//      одном из двух срезов. Допуск 0,01.
//   4. Продажи Ozon: Σ ozGeoSummary.byRegion.salesRub = независимый SQL
//      SUM(revenue) FROM tenant.ozon_sales WHERE is_return=0 AND
//      sale_dt BETWEEN from,to (честные продажи по своей дате, БЕЗ join к
//      заказам — регресс-ловушка на «дубль заказов вместо честных продаж»,
//      старый баг этапа 1). ozGeoSummary сам берёт гео через JOIN к orders
//      по (posting_number, product_id) — этот JOIN может ТЕРЯТЬ строки
//      продаж без сматченного заказа; если проверка 4 расходится, смотреть
//      именно туда (JOIN, не INNER vs LEFT). Допуск 0,01.
//   5. Локальность (WB и Ozon зеркально) — ЧЕСТНО про границы независимости
//      (фикс-раунд 1 ревью): мэппинг-ЯДРО (fuzzy JOIN склад→кластер,
//      справочники кластер→ФО/округ) контролируется НЕ повторной
//      SQL-реализацией того же JOIN (первая версия сторожа дословно
//      копировала LATERAL-fuzzy и кластерные JOIN из lib/geoMetrics.js —
//      тавтология: баг самого мэппинга давал бы одинаково неверный
//      результат в обеих копиях и остался бы незамеченным), а ОТДЕЛЬНЫМИ
//      золотыми кейсами (проверка 5б ниже, точечные запросы к справочникам
//      + один поведенческий вызов настоящего warehouseFuzzyLateral).
//      Полная независимая переимплементация fuzzy-логики сознательно НЕ
//      делается — две fuzzy-реализации (канон и «независимая копия»)
//      законно разойдутся на границах (частичные совпадения, регистр,
//      скобки) и сторож будет флапать без реального регресса.
//      Проверка 5 (эта) отвечает только за то, что МОЖЕТ быть независимым
//      без копирования JOIN:
//        (i) Σ qty матрицы (все ячейки, включая «Не определено») =
//            независимый COUNT/SUM незакансельных заказов окна (WB — с
//            непустым складом, как в самой матрице; Ozon — без доп.
//            фильтра, как в ozOrdersLocalityMatrix) — БЕЗ JOIN к
//            справочникам, чистый фильтр по tenant-таблице заказов;
//        (ii) localPct/mappedPct пересчитаны СОБСТВЕННОЙ арифметической
//            функцией этого скрипта (computeLocalityIndependent) НАД
//            ГОТОВЫМИ rows канона (canon.locMatrix.rows — теми самыми
//            ячейками whCluster×buyerCluster/whFo×buyerFo, которые уже
//            посчитал wbOrdersLocalityMatrix/ozOrdersLocalityMatrix) — это
//            ловит регресс в АРИФМЕТИКЕ процентов/округления
//            (withLocalityTotals в geoMetrics.js, не экспортируется —
//            переизобретаем математику отдельно), но НЕ в самом мэппинге
//            склад→кластер (за это отвечает проверка 5б).
//      Допуск: local/mapped/total — 0,01 (целые), localPct/mappedPct —
//      0,01 (сравниваются ПОСЛЕ одинакового round1 с обеих сторон —
//      фактически строгое равенство, а не дополнительный допуск на
//      расхождение мэппинга).
//      Пороги (скорректировано по плану, НЕ 85%): mappedPct(Ozon) ≥ 60 —
//      отдельная проверка (пустой city у части FBO). mappedPct(WB) БЕЗ
//      порога — деградация «Склад WB РФ» с августа задокументирована в
//      плане, здесь только печатается для видимости, не валит сторож.
//   5б. Золотые кейсы мэппинга (фикс-раунд 1 ревью, см. проверку 5 выше) —
//      точечные запросы к справочникам БЕЗ fuzzy и без geoMetrics.js,
//      значения зафиксированы прямыми SELECT по факту (проверены вручную
//      2026-09-05 перед вшиванием в сторож):
//        - Ozon: shared.ozon_clusters.warehouse_name = 'ЖУКОВСКИЙ_РФЦ' →
//          cluster_name = 'Москва, МО и Дальние регионы' →
//          shared.ozon_cluster_fo.fo = 'Центральный';
//        - shared.ru_geo_fo: 'Ульяновск' → 'Приволжский', 'Санкт-Петербург'
//          → 'Северо-Западный';
//        - WB: shared.region_to_cluster: 'Центральный федеральный округ' →
//          'Центральный';
//        - WB fuzzy (поведенческий, единственный кейс, где вызывается
//          НАСТОЯЩИЙ канон, не переизобретение): warehouseFuzzyLateral
//          (импорт из lib/geoMetrics.js — та же функция, что использует
//          wbOrdersLocalityMatrix) на литеральной строке
//          'Самара (Новосемейкино)' обязан вернуть region склада
//          'Новосемейкино' (region='Приволжский') из shared.wb_warehouses —
//          именно тот случай неточного совпадения имён, ради которого
//          fuzzy-LATERAL и был введён (см. докстроку warehouseFuzzyLateral
//          в geoMetrics.js: точный JOIN терял ~18% выручки на этой паре
//          имён). Упавший золотой кейс = FAIL сторожа.
//   6. Кросс-канонная: Σ wbGeoSummary.byRegion.ordersQty = wbOrdersCount(db,
//      {from,to}) РОВНО — обе функции считают COUNT(*) заказов WB с
//      is_cancel=0 в одном и том же окне (wbOrdersCount фильтрует по
//      order_dt full-timestamp, wbGeoSummary — по substr(order_dt,1,10);
//      на практике одно и то же множество строк). Допуск 0,01.
//      ⚠️ Ozon-зеркало НЕ вызывает ozOrdersCount(db,...) для сравнения —
//      проверено (см. lib/ozonMetrics.js): ozOrdersCount считает COUNT(*)
//      строк заказов, а Σ ozGeoSummary.byRegion.ordersQty — SUM(qty)
//      (штуки), это РАЗНЫЕ числа при qty>1 на строку (наблюдается на живых
//      данных — см. вывод «ozOrdersCount(informational)» ниже, отличается
//      от Σ qty). Кросс-канонная проверка для Ozon сверяется с СОБСТВЕННЫМ
//      independent-SQL-эквивалентом ozOrdersCount-по-смыслу-задачи —
//      SELECT SUM(qty) FROM tenant.ozon_orders WHERE is_cancel=0 в том же
//      окне (та же формула, что уже проверяет п.2 этого файла; повторный
//      независимый вызов здесь — намеренно отдельный SQL-запрос, не
//      переиспользование переменной п.2, чтобы проверка 6 не зависела от
//      состояния, вычисленного проверкой 2).
//   7. FBS-отгрузки WB (wbSuppliesOps, tenant.wb_supplies, миграция 047) —
//      канон через withTenant (DatabaseSync('wb',...)) против независимого
//      SQL saas_ro (bypass RLS, явный cabinet_id — та же дисциплина, что и
//      проверки 1-6):
//        (а) total = COUNT(*) FROM tenant.wb_supplies WHERE cabinet_id=$1
//            AND closed_at IS NOT NULL AND closed_at::date BETWEEN $2,$3;
//        (б) medianScHours = percentile_cont(0.5) тем же условием +
//            scan_dt IS NOT NULL; допуск 0,1ч (не 0,01, как в остальных
//            проверках) — JS-медиана канона считается НАД округлёнными до
//            0,1ч строками (scHours из SQL уже ROUND(...,1)), а
//            percentile_cont независимого SQL — над сырыми секундами;
//            на чётных выборках JS-медиана (усреднение соседних элементов
//            невозможно — берётся ближайший по формуле floor(p*(n-1)+0.5))
//            и percentile_cont (честная интерполяция середины) могут
//            разойтись на полшага — отсюда более широкий допуск;
//        (в) stuckCount = независимый COUNT с тем же CASE-условием
//            (done, scan_dt IS NULL, closed_at в окне [3;14) дней от now()).
//      Кабинет без WB-данных в окне (1008) → total=0, medianScHours=null,
//      stuckCount=0 с обеих сторон = PASS.
//
// Использование:
//   node scripts/check-geo-canon.mjs --cabinet 1
//   node scripts/check-geo-canon.mjs --cabinet 1008 --from 2026-08-01 --to 2026-08-31
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { withTenant, DatabaseSync } = await import('../lib/db.js');
const { wbGeoSummary, ozGeoSummary, wbOrdersLocalityMatrix, ozOrdersLocalityMatrix, warehouseFuzzyLateral, wbSuppliesOps } = await import('../lib/geoMetrics.js');
const { wbOrdersCount } = await import('../lib/wbMetrics.js');
const { ozOrdersCount } = await import('../lib/ozonMetrics.js');
const { defaultPeriod } = await import('../lib/period.js');

const UNMAPPED = 'Не определено';

function parseArgs(argv) {
  const def = defaultPeriod(30);
  const out = { cabinet: 1, from: def.from, to: def.to };
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
const TOL = 0.01; // ₽/шт/п.п. — единый допуск брифа (для процентов: сравниваем ПОСЛЕ
// одинакового round1 с обеих сторон, поэтому 0,01 — это фактически строгое
// равенство округлённых значений, а не дополнительный допуск на мэппинг;
// см. фикс-раунд 1 ревью в докстроке файла, проверка 5).
const OZ_MAPPED_MIN = 60; // % — скорректированный порог из плана (не 85, пустой city у части FBO)

const fmtRub = (n) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const round1 = (x) => Math.round(x * 10) / 10;

let failures = 0;
function verdict(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

// Σ qty/rub по массиву строк byRegion/byWarehouse (формат zipGeo из
// geoMetrics.js: {name, ordersQty, ordersRub, salesQty, salesRub}).
function sumGeoRows(rows) {
  let ordersQty = 0, ordersRub = 0, salesQty = 0, salesRub = 0;
  for (const r of rows) {
    ordersQty += num(r.ordersQty);
    ordersRub += num(r.ordersRub);
    salesQty += num(r.salesQty);
    salesRub += num(r.salesRub);
  }
  return { ordersQty, ordersRub, salesQty, salesRub };
}

// Независимая (собственная) реализация localPct/mappedPct — НЕ импорт
// withLocalityTotals из geoMetrics.js (она даже не экспортируется оттуда;
// но и была бы экспортирована — считать той же функцией, что проверяем,
// значило бы не проверять её вовсе). rows — [{whKey, buyerKey, qty}].
function computeLocalityIndependent(rows, whKey, buyerKey) {
  let total = 0, mapped = 0, local = 0;
  for (const r of rows) {
    const q = num(r.qty);
    total += q;
    if (r[whKey] !== UNMAPPED && r[buyerKey] !== UNMAPPED) {
      mapped += q;
      if (r[whKey] === r[buyerKey]) local += q;
    }
  }
  return {
    total, mapped, local,
    localPct: mapped > 0 ? round1((local * 100) / mapped) : null,
    mappedPct: total > 0 ? round1((mapped * 100) / total) : null,
  };
}

const roPool = new pg.Pool(readonlyPgConfig());

// ═════════════════════════════ WB ═════════════════════════════
async function runWbChecks() {
  console.log(`Сторож канона Географии WB — кабинет ${CABINET_ID}, период ${FROM}..${TO}`);
  console.log('');

  const canon = await withTenant(CABINET_ID, async () => {
    const db = new DatabaseSync('wb', { readOnly: true });
    const geoSum = await wbGeoSummary(db, { from: FROM, to: TO });
    const locMatrix = await wbOrdersLocalityMatrix(db, { from: FROM, to: TO });
    const ordersCountCanon = await wbOrdersCount(db, { from: FROM, to: TO });
    return { geoSum, locMatrix, ordersCountCanon };
  });

  const byRegionSums = sumGeoRows(canon.geoSum.byRegion);
  const byWhSums = sumGeoRows(canon.geoSum.byWarehouse);
  console.log('wbGeoSummary Σ byRegion:', JSON.stringify(byRegionSums));
  console.log('wbGeoSummary Σ byWarehouse:', JSON.stringify(byWhSums));
  console.log(`wbOrdersLocalityMatrix: localPct=${canon.locMatrix.localPct}, mappedPct=${canon.locMatrix.mappedPct}, строк=${canon.locMatrix.rows.length}`);
  console.log('');

  // ── Проверка 1: заказы WB (qty+рубли) против независимого SQL. ──
  const { rows: [ordRow] } = await roPool.query(
    `SELECT COUNT(*) AS qty, COALESCE(SUM(price_with_disc),0) AS rub
     FROM tenant.wb_orders
     WHERE cabinet_id = $1 AND is_cancel = 0
       AND substr(order_dt,1,10) BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const indOrdQty = num(ordRow.qty);
  const indOrdRub = num(ordRow.rub);
  verdict(
    'WB заказы: Σ wbGeoSummary.byRegion.ordersQty = COUNT(*) независимый SQL',
    Math.abs(byRegionSums.ordersQty - indOrdQty) <= TOL,
    `канон=${byRegionSums.ordersQty}, независимо=${indOrdQty}`
  );
  verdict(
    'WB заказы: Σ wbGeoSummary.byRegion.ordersRub = SUM(price_with_disc) независимый SQL',
    Math.abs(byRegionSums.ordersRub - indOrdRub) <= TOL,
    `канон=${fmtRub(byRegionSums.ordersRub)}, независимо=${fmtRub(indOrdRub)}`
  );

  // ── Проверка 3 (WB-половина): Σ byRegion = Σ byWarehouse, заказы и продажи. ──
  verdict(
    'WB: Σ byRegion.ordersQty/ordersRub = Σ byWarehouse.ordersQty/ordersRub',
    Math.abs(byRegionSums.ordersQty - byWhSums.ordersQty) <= TOL && Math.abs(byRegionSums.ordersRub - byWhSums.ordersRub) <= TOL,
    `byRegion=(${byRegionSums.ordersQty} шт, ${fmtRub(byRegionSums.ordersRub)} ₽), byWarehouse=(${byWhSums.ordersQty} шт, ${fmtRub(byWhSums.ordersRub)} ₽)`
  );
  verdict(
    'WB: Σ byRegion.salesQty/salesRub = Σ byWarehouse.salesQty/salesRub',
    Math.abs(byRegionSums.salesQty - byWhSums.salesQty) <= TOL && Math.abs(byRegionSums.salesRub - byWhSums.salesRub) <= TOL,
    `byRegion=(${byRegionSums.salesQty} шт, ${fmtRub(byRegionSums.salesRub)} ₽), byWarehouse=(${byWhSums.salesQty} шт, ${fmtRub(byWhSums.salesRub)} ₽)`
  );
  console.log('');

  // ── Проверка 5 (WB-половина): Σ qty матрицы = COUNT незакансельных
  // заказов окна с непустым складом; localPct/mappedPct — независимый
  // пересчёт (свой SQL той же формы через roPool/saas_ro, своя JS-функция
  // computeLocalityIndependent). ──
  const { rows: [locCountRow] } = await roPool.query(
    `SELECT COUNT(*) AS n FROM tenant.wb_orders
     WHERE cabinet_id = $1 AND is_cancel = 0
       AND substr(order_dt,1,10) BETWEEN $2 AND $3
       AND warehouse_name IS NOT NULL AND warehouse_name <> ''`,
    [CABINET_ID, FROM, TO]
  );
  const indLocCount = num(locCountRow.n);
  const matrixQtySum = canon.locMatrix.rows.reduce((a, r) => a + num(r.qty), 0);
  verdict(
    'WB локальность: Σ qty матрицы (все ячейки) = COUNT незакансельных заказов окна с непустым складом',
    Math.abs(matrixQtySum - indLocCount) <= TOL,
    `матрица=${matrixQtySum}, независимо=${indLocCount}`
  );

  // ⚠️ Фикс-раунд 1 ревью: здесь БОЛЬШЕ НЕТ повторного SQL с fuzzy-LATERAL
  // и JOIN к shared.region_to_cluster — первая версия дословно копировала
  // JOIN-цепочку wbOrdersLocalityMatrix, из-за чего проверка была
  // тавтологичной (баг мэппинга дал бы одинаково неверный результат в
  // обеих копиях). Вместо этого арифметика localPct/mappedPct пересчитана
  // НАД ГОТОВЫМИ ячейками канона (canon.locMatrix.rows) — это ловит
  // регресс в withLocalityTotals (округление/проценты), не в мэппинге
  // склад→кластер (за мэппинг отвечает золотая проверка 5б ниже).
  const indLocWb = computeLocalityIndependent(canon.locMatrix.rows, 'whCluster', 'buyerCluster');
  verdict(
    'WB локальность: localPct независимый (арифметика над rows канона) = canon.localPct',
    canon.locMatrix.localPct === null
      ? indLocWb.localPct === null
      : Math.abs(canon.locMatrix.localPct - indLocWb.localPct) <= TOL,
    `канон=${canon.locMatrix.localPct}, независимо=${indLocWb.localPct} (mapped=${indLocWb.mapped}, local=${indLocWb.local})`
  );
  verdict(
    'WB локальность: mappedPct независимый (арифметика над rows канона) = canon.mappedPct (порога нет — деградация «Склад WB РФ» с августа задокументирована в плане)',
    canon.locMatrix.mappedPct === null
      ? indLocWb.mappedPct === null
      : Math.abs(canon.locMatrix.mappedPct - indLocWb.mappedPct) <= TOL,
    `канон=${canon.locMatrix.mappedPct}%, независимо=${indLocWb.mappedPct}% (total=${indLocWb.total})`
  );
  console.log('');

  // ── Проверка 6 (WB-половина): кросс-канонная — Σ wbGeoSummary.
  // byRegion.ordersQty = wbOrdersCount(db,{from,to}) РОВНО. ──
  verdict(
    'WB кросс-канонная: Σ wbGeoSummary.byRegion.ordersQty = wbOrdersCount(db,{from,to})',
    Math.abs(byRegionSums.ordersQty - canon.ordersCountCanon) <= TOL,
    `Σ гео=${byRegionSums.ordersQty}, wbOrdersCount=${canon.ordersCountCanon}`
  );
  console.log('');
}

// ═════════════════════════════ OZON ═════════════════════════════
async function runOzonChecks() {
  console.log(`Сторож канона Географии Ozon — кабинет ${CABINET_ID}, период ${FROM}..${TO}`);
  console.log('');

  const canon = await withTenant(CABINET_ID, async () => {
    const db = new DatabaseSync('ozon', { readOnly: true });
    const geoSum = await ozGeoSummary(db, { from: FROM, to: TO });
    const locMatrix = await ozOrdersLocalityMatrix(db, { from: FROM, to: TO });
    // Вызывается ТОЛЬКО для информационного вывода (см. докстрока файла,
    // п.6) — семантика COUNT(*) заведомо отличается от Σ ordersQty
    // (SUM(qty)), в проверке 6 НЕ участвует.
    const ordersCountInfo = await ozOrdersCount(db, { from: FROM, to: TO });
    return { geoSum, locMatrix, ordersCountInfo };
  });

  const byRegionSums = sumGeoRows(canon.geoSum.byRegion);
  const byWhSums = sumGeoRows(canon.geoSum.byWarehouse);
  console.log('ozGeoSummary Σ byRegion:', JSON.stringify(byRegionSums));
  console.log('ozGeoSummary Σ byWarehouse:', JSON.stringify(byWhSums));
  console.log(`ozOrdersLocalityMatrix: localPct=${canon.locMatrix.localPct}, mappedPct=${canon.locMatrix.mappedPct}, строк=${canon.locMatrix.rows.length}`);
  console.log(`ℹ️  ozOrdersCount(informational, COUNT(*) заказов) = ${canon.ordersCountInfo} — НЕ равно Σ ordersQty (SUM(qty)) при qty>1 на строку, см. докстроку п.6.`);
  console.log('');

  // ── Проверка 2: заказы Ozon (SUM(qty)+рубли) против независимого SQL. ──
  const { rows: [ordRow] } = await roPool.query(
    `SELECT COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(total),0) AS rub
     FROM tenant.ozon_orders
     WHERE cabinet_id = $1 AND is_cancel = 0
       AND substr(order_dt,1,10) BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const indOrdQty = num(ordRow.qty);
  const indOrdRub = num(ordRow.rub);
  verdict(
    'Ozon заказы: Σ ozGeoSummary.byRegion.ordersQty = SUM(qty) независимый SQL',
    Math.abs(byRegionSums.ordersQty - indOrdQty) <= TOL,
    `канон=${byRegionSums.ordersQty}, независимо=${indOrdQty}`
  );
  verdict(
    'Ozon заказы: Σ ozGeoSummary.byRegion.ordersRub = SUM(total) независимый SQL',
    Math.abs(byRegionSums.ordersRub - indOrdRub) <= TOL,
    `канон=${fmtRub(byRegionSums.ordersRub)}, независимо=${fmtRub(indOrdRub)}`
  );

  // ── Проверка 3 (Ozon-половина): Σ byRegion = Σ byWarehouse. ──
  verdict(
    'Ozon: Σ byRegion.ordersQty/ordersRub = Σ byWarehouse.ordersQty/ordersRub',
    Math.abs(byRegionSums.ordersQty - byWhSums.ordersQty) <= TOL && Math.abs(byRegionSums.ordersRub - byWhSums.ordersRub) <= TOL,
    `byRegion=(${byRegionSums.ordersQty} шт, ${fmtRub(byRegionSums.ordersRub)} ₽), byWarehouse=(${byWhSums.ordersQty} шт, ${fmtRub(byWhSums.ordersRub)} ₽)`
  );
  verdict(
    'Ozon: Σ byRegion.salesQty/salesRub = Σ byWarehouse.salesQty/salesRub',
    Math.abs(byRegionSums.salesQty - byWhSums.salesQty) <= TOL && Math.abs(byRegionSums.salesRub - byWhSums.salesRub) <= TOL,
    `byRegion=(${byRegionSums.salesQty} шт, ${fmtRub(byRegionSums.salesRub)} ₽), byWarehouse=(${byWhSums.salesQty} шт, ${fmtRub(byWhSums.salesRub)} ₽)`
  );
  console.log('');

  // ── Проверка 4: продажи Ozon — Σ salesRub = SUM(revenue), честные
  // продажи по СВОЕЙ дате sale_dt, БЕЗ join к заказам (регресс-ловушка на
  // «дубль заказов» — старый баг этапа 1). ──
  const { rows: [saleRow] } = await roPool.query(
    `SELECT COALESCE(SUM(revenue),0) AS rub, COALESCE(SUM(qty),0) AS qty
     FROM tenant.ozon_sales
     WHERE cabinet_id = $1 AND is_return = 0
       AND substr(sale_dt,1,10) BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const indSaleRub = num(saleRow.rub);
  verdict(
    'Ozon продажи: Σ ozGeoSummary.byRegion.salesRub = SUM(revenue) независимый SQL (честные продажи, не дубль заказов)',
    Math.abs(byRegionSums.salesRub - indSaleRub) <= TOL,
    `канон=${fmtRub(byRegionSums.salesRub)}, независимо=${fmtRub(indSaleRub)}`
    + (Math.abs(byRegionSums.salesRub - indSaleRub) > TOL
      ? ' ⚠️ ozGeoSummary джойнит sales→orders по (posting_number, product_id) для гео — расхождение указывает на строки продаж без сматченного заказа (JOIN теряет строки), смотреть там, не в независимом SQL.'
      : '')
  );
  console.log(`  (справочно) Σ qty продаж независимо = ${num(saleRow.qty)}, канон Σ salesQty = ${byRegionSums.salesQty}`);
  console.log('');

  // ── Проверка 5 (Ozon-половина, зеркало WB): Σ qty матрицы = независимый
  // SUM(qty) незакансельных заказов окна (без доп. фильтра по складу — как
  // в ozOrdersLocalityMatrix); localPct/mappedPct — независимый пересчёт;
  // ДОПОЛНИТЕЛЬНО порог mappedPct(Ozon) ≥ 60 (скорректировано планом, не
  // 85 — пустой city у части FBO). ──
  const { rows: [locCountRow] } = await roPool.query(
    `SELECT COALESCE(SUM(qty),0) AS n FROM tenant.ozon_orders
     WHERE cabinet_id = $1 AND is_cancel = 0
       AND substr(order_dt,1,10) BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const indLocCount = num(locCountRow.n);
  const matrixQtySum = canon.locMatrix.rows.reduce((a, r) => a + num(r.qty), 0);
  verdict(
    'Ozon локальность: Σ qty матрицы (все ячейки) = SUM(qty) независимый SQL незакансельных заказов окна',
    Math.abs(matrixQtySum - indLocCount) <= TOL,
    `матрица=${matrixQtySum}, независимо=${indLocCount}`
  );

  // ⚠️ Фикс-раунд 1 ревью (см. WB-версию выше и докстроку файла) — здесь
  // тоже больше нет повторного SQL с JOIN к shared.ozon_clusters/
  // ozon_cluster_fo/ru_geo_fo. Арифметика пересчитана НАД ГОТОВЫМИ ячейками
  // канона (canon.locMatrix.rows), мэппинг склад→ФО проверяется золотыми
  // кейсами 5б.
  const indLocOz = computeLocalityIndependent(canon.locMatrix.rows, 'whFo', 'buyerFo');
  verdict(
    'Ozon локальность: localPct независимый (арифметика над rows канона) = canon.localPct',
    canon.locMatrix.localPct === null
      ? indLocOz.localPct === null
      : Math.abs(canon.locMatrix.localPct - indLocOz.localPct) <= TOL,
    `канон=${canon.locMatrix.localPct}, независимо=${indLocOz.localPct} (mapped=${indLocOz.mapped}, local=${indLocOz.local})`
  );
  verdict(
    'Ozon локальность: mappedPct независимый (арифметика над rows канона) = canon.mappedPct',
    canon.locMatrix.mappedPct === null
      ? indLocOz.mappedPct === null
      : Math.abs(canon.locMatrix.mappedPct - indLocOz.mappedPct) <= TOL,
    `канон=${canon.locMatrix.mappedPct}%, независимо=${indLocOz.mappedPct}% (total=${indLocOz.total})`
  );
  verdict(
    `Ozon локальность: mappedPct ≥ ${OZ_MAPPED_MIN}% (скорректированный порог плана, не 85 — пустой city у части FBO)`,
    canon.locMatrix.mappedPct !== null && canon.locMatrix.mappedPct >= OZ_MAPPED_MIN,
    `mappedPct=${canon.locMatrix.mappedPct}%`
  );
  console.log('');

  // ── Проверка 6 (Ozon-половина): кросс-канонная — Σ ozGeoSummary.
  // byRegion.ordersQty сверяется с СОБСТВЕННЫМ independent-SQL-эквивалентом
  // «ozOrdersCount по смыслу задачи» (SUM(qty) WHERE is_cancel=0 в том же
  // окне), НЕ с реальной функцией ozOrdersCount(db,...) — см. докстроку
  // файла п.6 и информационную строку выше (ozOrdersCount считает COUNT(*)
  // строк, а не SUM(qty), это разные числа). Отдельный SQL-вызов (не
  // переиспользование переменной проверки 2), чтобы проверка была
  // самостоятельной. ──
  const { rows: [crossRow] } = await roPool.query(
    `SELECT COALESCE(SUM(qty),0) AS n FROM tenant.ozon_orders
     WHERE cabinet_id = $1 AND is_cancel = 0
       AND substr(order_dt,1,10) BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const indCross = num(crossRow.n);
  verdict(
    'Ozon кросс-канонная: Σ ozGeoSummary.byRegion.ordersQty = независимый SQL SUM(qty) WHERE is_cancel=0 (НЕ ozOrdersCount — другая семантика, см. докстроку)',
    Math.abs(byRegionSums.ordersQty - indCross) <= TOL,
    `Σ гео=${byRegionSums.ordersQty}, независимо=${indCross}`
  );
  console.log('');
}

// ═══════════════════ ПРОВЕРКА 5б: ЗОЛОТЫЕ КЕЙСЫ МЭППИНГА ═══════════════════
// Фикс-раунд 1 ревью (см. докстроку файла, проверка 5): мэппинг-ЯДРО
// (fuzzy JOIN и справочники) НЕ переизобретается независимым SQL — вместо
// этого несколько фиксированных пар «вход→ожидаемый выход», проверенных
// ПРЯМЫМИ точечными запросами к shared.*-справочникам (без fuzzy, без
// geoMetrics.js — просто SELECT по точному ключу) плюс ОДИН поведенческий
// вызов настоящего warehouseFuzzyLateral (импорт из lib/geoMetrics.js —
// та функция, что реально использует канон, не копия). Значения золотых
// кейсов сверены вручную прямыми SELECT перед вшиванием в сторож
// (2026-09-05, см. отчёт задачи). Кейсы не зависят от кабинета/периода —
// проверяются один раз за прогон. Упавший кейс = FAIL (регресс справочника
// или самой fuzzy-функции), не флап.
async function runGoldenMappingChecks() {
  console.log('Золотые кейсы мэппинга (справочники, без fuzzy-переизобретения)');
  console.log('');

  // ── Ozon: склад → кластер → ФО (двухшаговый JOIN двух точных ключей,
  // без LIKE/ILIKE — оба справочника матчатся строгим равенством имени). ──
  const { rows: [ozRow] } = await roPool.query(
    `SELECT cf.fo AS fo, oc.cluster_name AS cluster_name
     FROM shared.ozon_clusters oc
     JOIN shared.ozon_cluster_fo cf ON cf.cluster_name = oc.cluster_name
     WHERE oc.warehouse_name = 'ЖУКОВСКИЙ_РФЦ'`
  );
  verdict(
    "золотой кейс Ozon: warehouse_name='ЖУКОВСКИЙ_РФЦ' → cluster_name='Москва, МО и Дальние регионы' → fo='Центральный'",
    ozRow?.cluster_name === 'Москва, МО и Дальние регионы' && ozRow?.fo === 'Центральный',
    `получено cluster_name=${JSON.stringify(ozRow?.cluster_name)}, fo=${JSON.stringify(ozRow?.fo)}`
  );

  // ── shared.ru_geo_fo: город → ФО, точный ключ. ──
  const { rows: geoFoRows } = await roPool.query(
    `SELECT name, fo FROM shared.ru_geo_fo WHERE name IN ('Ульяновск', 'Санкт-Петербург')`
  );
  const geoFoMap = new Map(geoFoRows.map((r) => [r.name, r.fo]));
  verdict(
    "золотой кейс ru_geo_fo: 'Ульяновск' → 'Приволжский'",
    geoFoMap.get('Ульяновск') === 'Приволжский',
    `получено ${JSON.stringify(geoFoMap.get('Ульяновск'))}`
  );
  verdict(
    "золотой кейс ru_geo_fo: 'Санкт-Петербург' → 'Северо-Западный'",
    geoFoMap.get('Санкт-Петербург') === 'Северо-Западный',
    `получено ${JSON.stringify(geoFoMap.get('Санкт-Петербург'))}`
  );

  // ── WB: shared.region_to_cluster — округ → кластер, точный ключ. ──
  const { rows: [rtcRow] } = await roPool.query(
    `SELECT cluster FROM shared.region_to_cluster WHERE region = 'Центральный федеральный округ'`
  );
  verdict(
    "золотой кейс region_to_cluster: 'Центральный федеральный округ' → 'Центральный'",
    rtcRow?.cluster === 'Центральный',
    `получено ${JSON.stringify(rtcRow?.cluster)}`
  );

  // ── WB fuzzy (поведенческий): НАСТОЯЩИЙ warehouseFuzzyLateral (импорт из
  // lib/geoMetrics.js) на литеральной строке 'Самара (Новосемейкино)' —
  // тот самый неточный случай имени, ради которого fuzzy-LATERAL и был
  // введён (см. докстроку функции: точный JOIN терял ~18% выручки).
  // Ожидание — region склада 'Новосемейкино' из shared.wb_warehouses. ──
  const literal = "'Самара (Новосемейкино)'";
  const { rows: [fuzzyRow] } = await roPool.query(
    `SELECT wh_l.region AS region
     FROM (SELECT 1) t
     ${warehouseFuzzyLateral(literal)}`
  );
  const { rows: [directRow] } = await roPool.query(
    `SELECT region FROM shared.wb_warehouses WHERE name = 'Новосемейкино'`
  );
  verdict(
    "золотой кейс WB fuzzy (настоящий warehouseFuzzyLateral): 'Самара (Новосемейкино)' → region склада 'Новосемейкино'",
    fuzzyRow?.region === directRow?.region && directRow?.region != null,
    `fuzzy вернул region=${JSON.stringify(fuzzyRow?.region)}, прямой запрос по 'Новосемейкино'=${JSON.stringify(directRow?.region)}`
  );
  console.log('');
}

// ═══════════════════ ПРОВЕРКА 7: FBS-ОТГРУЗКИ WB (wbSuppliesOps) ═══════════════════
async function runSuppliesOpsChecks() {
  console.log(`Сторож канона FBS-отгрузок WB (wbSuppliesOps) — кабинет ${CABINET_ID}, период ${FROM}..${TO}`);
  console.log('');

  const canon = await withTenant(CABINET_ID, async () => {
    const db = new DatabaseSync('wb', { readOnly: true });
    return wbSuppliesOps(db, { from: FROM, to: TO });
  });
  console.log(`wbSuppliesOps: total=${canon.total}, medianBuildHours=${canon.medianBuildHours}, medianScHours=${canon.medianScHours}, p90ScHours=${canon.p90ScHours}, stuckCount=${canon.stuckCount}, noScanOldCount=${canon.noScanOldCount}`);
  console.log('');

  // (а) total — независимый COUNT(*), тот же фильтр окна, что в wbSuppliesOps.
  const { rows: [totalRow] } = await roPool.query(
    `SELECT COUNT(*) AS n FROM tenant.wb_supplies
     WHERE cabinet_id = $1 AND closed_at IS NOT NULL
       AND closed_at::date BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const indTotal = num(totalRow.n);
  verdict(
    'FBS-отгрузки WB: total = COUNT(*) независимый SQL saas_ro',
    Math.abs(canon.total - indTotal) <= TOL,
    `канон=${canon.total}, независимо=${indTotal}`
  );

  // (б) medianScHours — percentile_cont(0.5) над сырыми секундами (не над
  // округлёнными до 0,1ч строками канона) — допуск 0,1ч, см. докстроку файла п.7.
  const MEDIAN_TOL = 0.1;
  const { rows: [medRow] } = await roPool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (scan_dt - closed_at)) / 3600.0
           ) AS med
     FROM tenant.wb_supplies
     WHERE cabinet_id = $1 AND closed_at IS NOT NULL AND scan_dt IS NOT NULL
       AND closed_at::date BETWEEN $2 AND $3`,
    [CABINET_ID, FROM, TO]
  );
  const indMedianScHours = medRow.med === null ? null : Number(medRow.med);
  verdict(
    'FBS-отгрузки WB: medianScHours ≈ percentile_cont(0.5) независимый SQL (допуск 0,1ч)',
    canon.medianScHours === null
      ? indMedianScHours === null
      : Math.abs(canon.medianScHours - indMedianScHours) <= MEDIAN_TOL,
    `канон=${canon.medianScHours}, независимо=${indMedianScHours === null ? null : indMedianScHours.toFixed(2)}`
  );

  // (в) stuckCount — независимый COUNT с тем же CASE-условием (done,
  // scan_dt IS NULL, closed_at в окне [3;14) дней от now() — те же пороги,
  // что SUPPLY_STUCK_MIN_DAYS/SUPPLY_STUCK_MAX_DAYS в lib/geoMetrics.js).
  const { rows: [stuckRow] } = await roPool.query(
    `SELECT COUNT(*) AS n FROM tenant.wb_supplies
     WHERE cabinet_id = $1 AND closed_at IS NOT NULL
       AND closed_at::date BETWEEN $2 AND $3
       AND done AND scan_dt IS NULL
       AND closed_at < now() - interval '3 days'
       AND closed_at >= now() - interval '14 days'`,
    [CABINET_ID, FROM, TO]
  );
  const indStuck = num(stuckRow.n);
  verdict(
    'FBS-отгрузки WB: stuckCount = COUNT(*) независимый SQL с тем же CASE-условием',
    Math.abs(canon.stuckCount - indStuck) <= TOL,
    `канон=${canon.stuckCount}, независимо=${indStuck}`
  );
  console.log('');
}

try {
  await runWbChecks();
  await runOzonChecks();
  await runGoldenMappingChecks();
  await runSuppliesOpsChecks();
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.stack || e.message}`);
  await roPool.end().catch(() => {});
  process.exit(3);
} finally {
  await roPool.end().catch(() => {});
}

if (failures === 0) {
  console.log('ALL PASS — канон Географии (WB и Ozon) сходится с независимым SQL до копейки/штуки.');
  process.exit(0);
} else {
  console.log(`ИТОГО ${failures} РАСХОЖДЕНИЕ(Й) — см. блоки выше.`);
  process.exit(1);
}
