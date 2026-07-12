// =====================================================================
//  lib/mpBalance.js — «Деньги в кабинете МП» по API (заявка 2026-06-25).
//
//  Тянет текущий остаток на счету продавца в кабинетах WB и Ozon напрямую
//  через их API. Яндекс Маркет = 0 (коллектора нет, заглушка — как в остатках).
//
//  WB:   GET https://finance-api.wildberries.ru/api/v1/account/balance
//        header Authorization = WB_TOKEN (барн). Отдаёт {current, for_withdraw}.
//  Ozon: POST https://api-seller.ozon.ru/v1/finance/balance {date_from,date_to}
//        headers Client-Id + Api-Key. closing_balance.value на сегодня = текущий.
//
//  КЭШ: WB rate-limit (429 при частых запросах). Кэшируем результат на CACHE_MS
//  (5 минут) — на одно открытие страницы один запрос, не дёргаем при каждом чихе.
//
//  Это ЖИВЫЕ данные «на сейчас», не исторический снапшот. Баланс — снапшот на дату,
//  но mp_balance всегда отражает актуальное состояние (решение владельца 2026-06-25:
//  «тянуть на текущую дату и вносить, чтобы были всегда актуальные»).
//
//  Граница: только чтение API, ничего не пишет в кабинеты. Токены из env.
// =====================================================================

const WB_TOKEN = process.env.WB_TOKEN;
const OZ_CLIENT = process.env.OZON_CLIENT_ID;
const OZ_KEY = process.env.OZON_API_KEY;

const CACHE_MS = 5 * 60 * 1000; // 5 минут
let _cache = null; // { ts, data }

async function round2(v) {
  const n = Number(v) || 0;
  return Math.round(n * 100) / 100;
}

/** Текущий баланс WB через finance-api. */
async function wbBalance() {
  if (!WB_TOKEN) return { value: 0, error: "WB_TOKEN не задан" };
  const r = await fetch("https://finance-api.wildberries.ru/api/v1/account/balance", {
    headers: { Authorization: WB_TOKEN },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { value: 0, error: `WB HTTP ${r.status}: ${t.slice(0, 120)}` };
  }
  const j = await r.json();
  return { value: round2(j.current ?? 0), for_withdraw: round2(j.for_withdraw ?? 0) };
}

/** Текущий баланс Ozon: closing_balance за сегодня = текущий остаток. */
async function ozonBalance() {
  if (!OZ_CLIENT || !OZ_KEY) return { value: 0, error: "OZON_CLIENT_ID/OZON_API_KEY не заданы" };
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetch("https://api-seller.ozon.ru/v1/finance/balance", {
    method: "POST",
    headers: { "Client-Id": OZ_CLIENT, "Api-Key": OZ_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ date_from: today, date_to: today }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { value: 0, error: `Ozon HTTP ${r.status}: ${t.slice(0, 120)}` };
  }
  const j = await r.json();
  const val = j?.total?.closing_balance?.value ?? 0;
  return { value: round2(val) };
}

/**
 * Разбивка балансов МП по маркетплейсам на текущую дату.
 * @param {{force?: boolean}} [opts] — force=true игнорирует кэш.
 * @returns {Promise<{ wb:number, ozon:number, yandex:number, total:number,
 *                       wb_withdraw?:number, errors?:string[], cached:boolean }>}
 */
export async function mpBalanceBreakdown(opts = {}) {
  // Кэш (кроме force) — экономим запросы к WB (rate-limit).
  if (!opts.force && _cache && Date.now() - _cache.ts < CACHE_MS) {
    return { ..._cache.data, cached: true };
  }
  const [wb, oz] = await Promise.all([wbBalance(), ozonBalance()]);
  const yandex = 0; // Заглушка: коллектора Яндекс Маркета нет (как в остатках).
  const errors = [];
  if (wb.error) errors.push(wb.error);
  if (oz.error) errors.push(oz.error);
  const data = {
    wb: wb.value,
    ozon: oz.value,
    yandex,
    total: round2(wb.value + oz.value + yandex),
    wb_withdraw: wb.for_withdraw,
    errors: errors.length ? errors : undefined,
    cached: false,
  };
  _cache = { ts: Date.now(), data };
  return data;
}
