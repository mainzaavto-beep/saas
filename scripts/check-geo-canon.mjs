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
//   5. Локальность (WB и Ozon зеркально): Σ qty матрицы (все ячейки,
//      включая «Не определено») = независимый COUNT/SUM незакансельных
//      заказов окна (WB — с непустым складом, как в самой матрице; Ozon —
//      без доп. фильтра, как в ozOrdersLocalityMatrix); localPct и mappedPct
//      пересчитаны СОБСТВЕННОЙ функцией этого скрипта (не импортом
//      withLocalityTotals — она не экспортируется из geoMetrics.js и в
//      любом случае должна быть независимой реализацией той же математики)
//      над СОБСТВЕННЫМ SQL (та же форма JOIN, что в geoMetrics.js, но через
//      roPool/saas_ro с явным cabinet_id — тот же стандарт «независимости»,
//      что уже принят в check-profit-canon.mjs, где независимые запросы
//      тоже дословно повторяют форму SQL канона, но идут по другому
//      подключению и минуют RLS). Допуск: qty — 0,01 (целые), localPct/
//      mappedPct — 0,1 (обе стороны округляют до 1 знака одной и той же
//      формулой round1).
//      Пороги (скорректировано по плану, НЕ 85%): mappedPct(Ozon) ≥ 60 —
//      отдельная проверка (пустой city у части FBO). mappedPct(WB) БЕЗ
//      порога — деградация «Склад WB РФ» с августа задокументирована в
//      плане, здесь только печатается для видимости, не валит сторож.
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
const { wbGeoSummary, ozGeoSummary, wbOrdersLocalityMatrix, ozOrdersLocalityMatrix } = await import('../lib/geoMetrics.js');
const { wbOrdersCount } = await import('../lib/wbMetrics.js');
const { ozOrdersCount } = await import('../lib/ozonMetrics.js');
const { defaultPeriod } = await import('../lib/period.js');

const EMPTY = 'Не указан';
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
const TOL = 0.01; // ₽/шт — тот же базовый допуск, что и в check-profit-canon.mjs
const PCT_TOL = 0.1; // п.п. — localPct/mappedPct округлены до 1 знака одной формулой с обеих сторон
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

  const { rows: locRowsWb } = await roPool.query(
    `SELECT COALESCE(wh_l.region, $4) AS "whCluster",
            COALESCE(rtc_ok.cluster, rtc_reg.cluster, $4) AS "buyerCluster",
            COUNT(*) AS qty
     FROM tenant.wb_orders o
     LEFT JOIN shared.region_to_cluster rtc_ok ON rtc_ok.region = o.okrug_name
     LEFT JOIN shared.region_to_cluster rtc_reg
       ON rtc_reg.region = o.region_name AND (o.okrug_name IS NULL OR o.okrug_name = '')
     LEFT JOIN LATERAL (
       SELECT region FROM shared.wb_warehouses
       WHERE name = o.warehouse_name
          OR o.warehouse_name ILIKE '%' || name || '%'
          OR name ILIKE '%' || o.warehouse_name || '%'
       ORDER BY (name = o.warehouse_name) DESC, updated_at DESC
       LIMIT 1
     ) wh_l ON true
     WHERE o.cabinet_id = $1
       AND substr(o.order_dt,1,10) >= $2 AND substr(o.order_dt,1,10) <= $3
       AND o.is_cancel = 0 AND o.warehouse_name <> ''
     GROUP BY 1, 2`,
    [CABINET_ID, FROM, TO, UNMAPPED]
  );
  const indLocWb = computeLocalityIndependent(locRowsWb, 'whCluster', 'buyerCluster');
  verdict(
    'WB локальность: localPct независимый = canon.localPct',
    canon.locMatrix.localPct === null
      ? indLocWb.localPct === null
      : Math.abs(canon.locMatrix.localPct - indLocWb.localPct) <= PCT_TOL,
    `канон=${canon.locMatrix.localPct}, независимо=${indLocWb.localPct} (mapped=${indLocWb.mapped}, local=${indLocWb.local})`
  );
  verdict(
    'WB локальность: mappedPct независимый = canon.mappedPct (порога нет — деградация «Склад WB РФ» с августа задокументирована в плане)',
    canon.locMatrix.mappedPct === null
      ? indLocWb.mappedPct === null
      : Math.abs(canon.locMatrix.mappedPct - indLocWb.mappedPct) <= PCT_TOL,
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

  const { rows: locRowsOz } = await roPool.query(
    `SELECT COALESCE(cf.fo, $4) AS "whFo",
            COALESCE(g.fo, $4) AS "buyerFo",
            COALESCE(SUM(o.qty),0) AS qty
     FROM tenant.ozon_orders o
     LEFT JOIN shared.ozon_clusters oc ON oc.warehouse_id = o.warehouse_id
     LEFT JOIN shared.ozon_cluster_fo cf ON cf.cluster_name = oc.cluster_name
     LEFT JOIN shared.ru_geo_fo g ON g.name = o.region
     WHERE o.cabinet_id = $1
       AND substr(o.order_dt,1,10) >= $2 AND substr(o.order_dt,1,10) <= $3
       AND o.is_cancel = 0
     GROUP BY 1, 2`,
    [CABINET_ID, FROM, TO, UNMAPPED]
  );
  const indLocOz = computeLocalityIndependent(locRowsOz, 'whFo', 'buyerFo');
  verdict(
    'Ozon локальность: localPct независимый = canon.localPct',
    canon.locMatrix.localPct === null
      ? indLocOz.localPct === null
      : Math.abs(canon.locMatrix.localPct - indLocOz.localPct) <= PCT_TOL,
    `канон=${canon.locMatrix.localPct}, независимо=${indLocOz.localPct} (mapped=${indLocOz.mapped}, local=${indLocOz.local})`
  );
  verdict(
    'Ozon локальность: mappedPct независимый = canon.mappedPct',
    canon.locMatrix.mappedPct === null
      ? indLocOz.mappedPct === null
      : Math.abs(canon.locMatrix.mappedPct - indLocOz.mappedPct) <= PCT_TOL,
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

try {
  await runWbChecks();
  await runOzonChecks();
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
