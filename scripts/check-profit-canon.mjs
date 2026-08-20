#!/usr/bin/env node
// scripts/check-profit-canon.mjs — сторож канонического слоя прибыли
// (план «унификация формул прибыли», docs/superpowers/plans/
// 2026-08-20-profit-unification.md, задача 1 — Ozon-секция; задача 2
// добавит WB-секцию тем же файлом).
//
// Проверяет РЕАЛЬНЫЕ функции lib/ozonMetrics.js::ozProfitProduct/
// ozProfitCabinet/ozCabinetCostLabel (не переизобретает их формулу) против
// НЕЗАВИСИМОГО SQL, посчитанного этим скриптом с нуля. Расхождение = баг
// канона (finance-discrepancy-rule), не повод подгонять эталон.
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
// reconciliation-*). --cabinet/--from/--to меняют период вручную.
//
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
//   3. ozProfitCabinet(period).profit = ozProfitProduct(period).profit минус
//      Σ|cabinetCosts[].amount| — сверка внутренней арифметики канона
//      (буквальное прочтение плана: «− Σ|cabinetCosts|», см. коммент в
//      lib/ozonMetrics.js у ozProfitCabinet), допуск 0,01 ₽.
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

const fmtRub = (n) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

let failures = 0;
function verdict(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log(`Сторож канонического слоя прибыли Ozon — кабинет ${CABINET_ID}, период ${FROM}..${TO}`);
console.log('');

const roPool = new pg.Pool(readonlyPgConfig());

try {
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
  const indCabinetDeduction = cabinetCostRows.reduce((acc, r) => acc + Math.abs(num(r.s)), 0);

  console.log('Независимый SQL (saas_ro):');
  console.log(`  revenue=${fmtRub(indRevenue)} cogs=${fmtRub(indCogs)} commission=${fmtRub(indCommission)} logistics=${fmtRub(indLogistics)} acquiring=${fmtRub(indAcquiring)} loyalty=${fmtRub(indLoyalty)}`);
  console.log(`  SUM(profit) сырой (все строки, без фильтра is_return) = ${fmtRub(indRawProfit)}`);
  console.log(`  ad_spend = ${fmtRub(indAdSpend)}, налог (calcTotalTax) = ${fmtRub(indTax)}`);
  console.log(`  profit независимый = SUM(profit) − ad_spend − налог = ${fmtRub(indProfit)}`);
  console.log(`  Σ|cabinetCosts.amount| = ${fmtRub(indCabinetDeduction)}`);
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

  // ── Проверка 3: ozProfitCabinet.profit = ozProfitProduct.profit − Σ|cabinetCosts| ──
  const expectedCabinetProfit = Math.round((canon.profitProduct.profit - indCabinetDeduction) * 100) / 100;
  verdict(
    'ozProfitCabinet.profit = ozProfitProduct.profit − Σ|cabinetCosts[].amount|',
    Math.abs(canon.profitCabinet.profit - expectedCabinetProfit) <= TOL,
    `канон=${fmtRub(canon.profitCabinet.profit)}, ожидание=${fmtRub(expectedCabinetProfit)}`
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
  const PRODUCT_SUM_TOL = 0.05;
  const sumByProductMinusAds = Math.round((canon.sumByProduct - canon.profitProduct.ads) * 100) / 100;
  verdict(
    'productId-фильтр аддитивен: Σ ozProfitProduct(товар).profit − ads(кабинета) = ozProfitProduct(без фильтра).profit',
    Math.abs(sumByProductMinusAds - canon.profitProduct.profit) <= PRODUCT_SUM_TOL,
    `Σ по товарам=${fmtRub(canon.sumByProduct)} (${canon.productCount} тов.), −ads=${fmtRub(canon.profitProduct.ads)} ⇒ ${fmtRub(sumByProductMinusAds)}, без фильтра=${fmtRub(canon.profitProduct.profit)}`
  );
  if (canon.nullProductRows > 0) {
    console.log(`  ⚠️ product_id IS NULL строк в периоде: ${canon.nullProductRows} — их деньги в Σ по товарам не попадают (ожидаемо, не баг проверки).`);
  }
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.stack || e.message}`);
  await roPool.end().catch(() => {});
  process.exit(3);
} finally {
  await roPool.end().catch(() => {});
}

console.log('');
if (failures === 0) {
  console.log('ALL PASS — канонический слой прибыли Ozon сходится с независимым SQL до копейки.');
  process.exit(0);
} else {
  console.log(`ИТОГО ${failures} РАСХОЖДЕНИЕ(Й) — см. блоки выше.`);
  process.exit(1);
}
