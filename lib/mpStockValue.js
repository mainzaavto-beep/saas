
// =====================================================================
//  lib/mpStockValue.js — себестоимость остатков на МП по дате (заявка 2026-06-25).
//
//  Переиспользуется /api/mp-stock (детализация по SKU) и /api/balance
//  (авто-сумма stock_value в балансе). Один источник истины для логики
//  «quantity_full × cost по ближайшей дате <= D», чтобы баланс и страница
//  остатков не разъезжались.
//
//  stockBreakdown(asOfDate?) →
//    { wb, ozon, yandex, total, dateWb, dateOzon }
//  где wb/ozon/yandex/total = valueCost (себестоимость). yandex = 0
//  (коллектора нет, заглушка — подтянется когда появится).
//
//  Дата: если asOfDate передан — берём ближайшую date <= asOfDate в daily_stock
//  (как баланс грузит ближайший снапшот). Иначе — MAX(date).
//
//  Граница: читает wb_data.db / ozon_data.db RO; НЕ пишет; НЕ трогает cogs/
//  cost_overrides (использует плоский cogs как /api/mp-stock). Данные по остаткам
//  на МП принадлежат сборщику (collector_wb/collector_ozon) — тут только чтение.
// =====================================================================

const WB_DB = process.env.WB_DB_PATH || "/opt/agentsDB/wb_data.db";
const OZON_DB = process.env.OZON_DB_PATH || "/opt/agentsDB/ozon_data.db";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

let _wb = null, _oz = null;
async function wbDb() { if (!_wb) _wb = new DatabaseSync(WB_DB, { readOnly: true }); return _wb; }
async function ozonDb() { if (!_oz) _oz = new DatabaseSync(OZON_DB, { readOnly: true }); return _oz; }

async function resolveStockDate(db, dateParam) {
  if (dateParam && ISO_DATE.test(dateParam)) {
    const r = await db.prepare("SELECT MAX(date) AS d FROM daily_stock WHERE date <= ?").get(dateParam);
    if (r?.d) return r.d;
  }
  return await db.prepare("SELECT MAX(date) AS d FROM daily_stock").get()?.d || null;
}

/** Себестоимость остатков WB на дату (quantity_full × cogs.cost), с округлением. */
async function wbValueCost(dateParam) {
  const db = wbDb();
  const date = resolveStockDate(db, dateParam);
  if (!date) return { valueCost: 0, date: null };
  const r = await db
    .prepare(
      `SELECT ROUND(SUM(st.quantity_full * COALESCE(c.cost, 0)), 2) AS v
       FROM (
         SELECT nm_id, SUM(quantity_full) AS quantity_full
         FROM daily_stock WHERE date = ? GROUP BY nm_id
       ) st
       LEFT JOIN cogs c ON c.nm_id = st.nm_id`
    )
    .get(date);
  return { valueCost: round2(r?.v || 0), date };
}

/** Себестоимость остатков Ozon на дату (fbo_present × cogs.cost). */
async function ozonValueCost(dateParam) {
  const db = ozonDb();
  const date = resolveStockDate(db, dateParam);
  if (!date) return { valueCost: 0, date: null };
  const r = await db
    .prepare(
      `SELECT ROUND(SUM(st.fbo_present * COALESCE(c.cost, 0)), 2) AS v
       FROM (
         SELECT product_id, SUM(fbo_present) AS fbo_present
         FROM daily_stock WHERE date = ? GROUP BY product_id
       ) st
       LEFT JOIN cogs c ON c.product_id = st.product_id`
    )
    .get(date);
  return { valueCost: round2(r?.v || 0), date };
}

/**
 * Разбивка себестоимости остатков по МП на дату.
 * @param {string|null} asOfDate YYYY-MM-DD или null (тогда MAX(date)).
 * @returns {{wb:number, ozon:number, yandex:number, total:number, dateWb:string|null, dateOzon:string|null}}
 */
export async function stockBreakdown(asOfDate = null) {
  const wb = wbValueCost(asOfDate);
  const oz = ozonValueCost(asOfDate);
  const yandex = 0; // Заглушка: коллектора Яндекс Маркета нет (решение владельца 2026-06-25).
  return {
    wb: wb.valueCost,
    ozon: oz.valueCost,
    yandex,
    total: round2(wb.valueCost + oz.valueCost + yandex),
    dateWb: wb.date,
    dateOzon: oz.date,
  };
}

async function round2(v) {
  const n = Number(v) || 0;
  return Math.round(n * 100) / 100;
}
