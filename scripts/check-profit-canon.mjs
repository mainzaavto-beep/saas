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
//   5. productId-фильтр аддитивен: Σ по всем товарам периода ozProfitProduct
//      (period, productId).profit, МИНУС ads кабинета (см. ниже — ПОЧЕМУ),
//      = ozProfitProduct(period).profit без фильтра, допуск 0,05 ₽ (шире
//      базового 0,01 — см. обоснование допуска ниже, у самого чека).
//      ⚠️ ПОЧЕМУ «−ads», а не голое сравнение сумм: Ozon Performance API не
//      даёт пер-SKU расход рекламы (см. докстроку ozAdSpend в
//      lib/ozonMetrics.js) — ozProfitProduct(pid).ads ВСЕГДА 0 (честно, а не
//      «размазано»), поэтому Σ profit(товар) НИКОГДА не вычитает рекламу.
//      Кабинетный вызов (без productId) вычитает её РОВНО ОДИН раз — Σ по
//      товарам оттого ВЫШЕ (менее убыточна), чем profit(без фильтра), РОВНО
//      на ads кабинета: Σ profit(товар) = profit(без фильтра) + ads. Если бы
//      проверка сравнивала голые суммы без поправки, она была бы
//      математически невыполнима при ЛЮБОЙ ненулевой рекламе (кабинет 1,
//      июль-2026: 63 947,03 ₽) — не баг канона, а неизбежное следствие
//      отсутствия пер-SKU данных. Налог при этом ОСТАЁТСЯ в сумме по
//      товарам без поправки (под usn_income он линеен по выручке —
//      Σtax(товар) = tax(кабинет) с точностью до округления round2 на
//      каждый товар, см. коммент в lib/ozonMetrics.js) — поправка нужна
//      только для ads.
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
//   5. nmId-фильтр аддитивен: Σ wbProfitProduct(period, nmId).profit по
//      всем nm периода, МИНУС ads(кабинета) (та же причина, что у Ozon —
//      см. докстроку wbProfitProduct в lib/wbMetrics.js: реклама по nm_id У
//      WB ЕСТЬ, но часть ad_spend «осиротела» на nm без строк order_costs
//      в периоде — 7 077,17 ₽ на кабинете 1 за июль-2026 — поэтому канон
//      тоже даёт ads=0 при nmId), допуск 0,05 ₽.
//   6. ⚠️ is_return НЕ фильтруется — независимая проверка №1 явно НЕ
//      добавляет "AND is_return=0"; отдельно выводится информационная
//      строка «что было бы, если» (см. WB_IS_RETURN_FILTER_LOSS ниже) —
//      это находка задачи 2 (брифинг явно просил её зафиксировать), не
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
const { ozProfitProduct, ozProfitCabinet } = await import('../lib/ozonMetrics.js');
const { wbProfitProduct, wbProfitCabinet } = await import('../lib/wbMetrics.js');
const { calcTotalTax, normalizeTaxMode } = await import('../lib/tax.js');

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

const fmtRub = (n) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

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

    let sumByProduct = 0;
    for (const row of productRows) {
      const pp = await ozProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, row.product_id);
      sumByProduct += pp.profit;
    }

    return {
      profitProduct, profitCabinet,
      productCount: productRows.length,
      nullProductRows: Number(nullProductRow?.n) || 0,
      sumByProduct: Math.round(sumByProduct * 100) / 100,
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
  const indLogistics = num(rawRow.logistics);
  const indAcquiring = num(rawRow.acquiring);
  const indLoyalty = num(rawRow.loyalty);
  const indRawProfit = num(rawRow.profit);
  const indAdSpend = num(adRow.s);
  const indExpenses = indCogs + indCommission + indLogistics + indAcquiring + indLoyalty + indAdSpend;
  const indTax = calcTotalTax(taxMode, indRevenue, indExpenses).total;
  const indProfit = Math.round((indRawProfit - indAdSpend - indTax) * 100) / 100;
  // Знаковая сумма (правильная, после fix-раунда ревью задачи 1) и модульная
  // (старая, ошибочная формула — считаем ОБЕ, чтобы явно показать до/после
  // на живой положительной статье, не только использовать одну из них).
  const indCabinetSignedSum = cabinetCostRows.reduce((acc, r) => acc + num(r.s), 0);
  const indCabinetAbsSum = cabinetCostRows.reduce((acc, r) => acc + Math.abs(num(r.s)), 0);
  const positiveRows = cabinetCostRows.filter((r) => num(r.s) > 0);

  console.log('Независимый SQL (saas_ro):');
  console.log(`  revenue=${fmtRub(indRevenue)} cogs=${fmtRub(indCogs)} commission=${fmtRub(indCommission)} logistics=${fmtRub(indLogistics)} acquiring=${fmtRub(indAcquiring)} loyalty=${fmtRub(indLoyalty)}`);
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

  // ── Проверка 2: слагаемые аддитивны (revenue−cogs−commission−logistics−
  // acquiring−loyalty = сырой SUM(profit), знаковая формула сборщика). ──
  const compsProfit = canon.profitProduct.revenue - canon.profitProduct.cogs - canon.profitProduct.commission
    - canon.profitProduct.logistics - canon.profitProduct.acquiring - canon.profitProduct.loyalty;
  verdict(
    'слагаемые аддитивны: revenue−cogs−commission−logistics−acquiring−loyalty = SUM(order_costs.profit)',
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

  // ── Проверка 5: productId-фильтр аддитивен (см. докстроку файла, п.5) ──
  // Допуск шире базового (0,05 ₽ вместо 0,01): 44 товара, у каждого свой
  // round2(tax) — независимые округления могут накопить пару копеек, что не
  // является расхождением канона (в отличие от проверок 1-3, где сравнение
  // идёт «один канон-вызов vs один независимый SQL» без per-item округлений).
  const sumByProductMinusAds = Math.round((canon.sumByProduct - canon.profitProduct.ads) * 100) / 100;
  verdict(
    'productId-фильтр аддитивен: Σ ozProfitProduct(товар).profit − ads(кабинета) = ozProfitProduct(без фильтра).profit',
    Math.abs(sumByProductMinusAds - canon.profitProduct.profit) <= PRODUCT_SUM_TOL,
    `Σ по товарам=${fmtRub(canon.sumByProduct)} (${canon.productCount} тов.), −ads=${fmtRub(canon.profitProduct.ads)} ⇒ ${fmtRub(sumByProductMinusAds)}, без фильтра=${fmtRub(canon.profitProduct.profit)}`
  );
  if (canon.nullProductRows > 0) {
    console.log(`  ⚠️ product_id IS NULL строк в периоде: ${canon.nullProductRows} — их деньги в Σ по товарам не попадают (ожидаемо, не баг проверки).`);
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
    for (const row of nmRows) {
      const pp = await wbProfitProduct(db, taxMode, { cabinetId: CABINET_ID, from: FROM, to: TO }, row.nm_id);
      sumByNm += pp.profit;
    }

    return {
      profitProduct, profitCabinet,
      nmCount: nmRows.length,
      nullNmRows: Number(nullNmRow?.n) || 0,
      sumByNm: Math.round(sumByNm * 100) / 100,
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

  // ── Проверка 5: nmId-фильтр аддитивен (см. докстроку файла, WB п.5) ──
  const sumByNmMinusAds = Math.round((canon.sumByNm - canon.profitProduct.ads) * 100) / 100;
  verdict(
    'nmId-фильтр аддитивен: Σ wbProfitProduct(nm).profit − ads(кабинета) = wbProfitProduct(без фильтра).profit',
    Math.abs(sumByNmMinusAds - canon.profitProduct.profit) <= PRODUCT_SUM_TOL,
    `Σ по nm=${fmtRub(canon.sumByNm)} (${canon.nmCount} nm), −ads=${fmtRub(canon.profitProduct.ads)} ⇒ ${fmtRub(sumByNmMinusAds)}, без фильтра=${fmtRub(canon.profitProduct.profit)}`
  );
  if (canon.nullNmRows > 0) {
    console.log(`  ⚠️ nm_id IS NULL строк в периоде: ${canon.nullNmRows} — их деньги в Σ по nm не попадают (ожидаемо, не баг проверки).`);
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
