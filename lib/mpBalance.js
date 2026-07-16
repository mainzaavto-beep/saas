// =====================================================================
//  lib/mpBalance.js — «Деньги в кабинете МП» по API (заявка 2026-06-25).
//
//  Тянет текущий остаток на счету продавца в кабинетах WB и Ozon напрямую
//  через их API. Яндекс Маркет = 0 (коллектора нет, заглушка — как в остатках).
//
//  WB:   GET https://finance-api.wildberries.ru/api/v1/account/balance
//        header Authorization = WB_TOKEN. Отдаёт {current, for_withdraw}.
//  Ozon: POST https://api-seller.ozon.ru/v1/finance/balance {date_from,date_to}
//        headers Client-Id + Api-Key. closing_balance.value на сегодня = текущий.
//
//  SaaS (мультитенант): креды читаются ИЗ БД — auth.shops.api_creds_enc
//  (pgcrypto, ключ SAAS_CRED_MASTER_KEY из .env.local). У каждого кабинета свои
//  токены, поэтому баланс МП всегда актуальный и изолированный. Раньше (legacy
//  single-tenant) читались из process.env — работало только для cabinet #1.
//
//  КЭШ: per-cabinet (Map), CACHE_MS = 5 мин. Глобальный кэш УТЕКАЛ бы балансом
//  кабинета A в кабинет B — критично для мультитенанта.
//
//  Это ЖИВЫЕ данные «на сейчас», не исторический снапшот. mp_balance всегда
//  отражает актуальное состояние (решение владельца 2026-06-25).
//
//  Граница: только чтение API, ничего не пишет в кабинеты.
// =====================================================================

import { query } from "@/lib/db.js";

const CACHE_MS = 5 * 60 * 1000; // 5 минут
const _cache = new Map(); // key: cabinetId → { ts, data }

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Расшифровать API-креды ВСЕХ активных магазинов кабинета.
 * SQL тот же, что в worker/orchestrator.py:_decrypt_creds:
 *   SELECT pgp_sym_decrypt(api_creds_enc::bytea, $key) AS plain
 * ⚠ ::bytea обязателен — колонка TEXT (hex-форма), pgp_sym_decrypt ждёт bytea.
 * auth.shops без RLS — изолируем через WHERE cabinet_id (как withCabinet.js).
 *
 * @returns {Promise<Array<{shop_id:number, mp_code:string, creds:Object}>>}
 *   creds по МП (вложенная структура, как в route.js shops POST):
 *     wb   → { token, token_feedbacks? }
 *     ozon → { client_id, api_key, perf_client_id?, perf_client_secret? }
 */
async function getShopCredsForCabinet(cabinetId) {
  const masterKey = process.env.SAAS_CRED_MASTER_KEY;
  const shops = await query(
    `SELECT shop_id, mp_code, api_creds_enc
     FROM auth.shops
     WHERE cabinet_id = $1 AND is_active = true
     ORDER BY shop_id`,
    [cabinetId]
  );
  const out = [];
  for (const s of shops) {
    let full = {};
    if (s.api_creds_enc && masterKey) {
      try {
        // ⚠ FROM auth.shops + WHERE shop_id — ОБЯЗАТЕЛЬНО. Без FROM колонка
        // api_creds_enc не видна (PG: "column does not exist"). Тот же паттерн,
        // что в worker/orchestrator.py:_decrypt_creds.
        const rows = await query(
          `SELECT pgp_sym_decrypt(api_creds_enc::bytea, $1) AS plain
           FROM auth.shops WHERE shop_id = $2`,
          [masterKey, s.shop_id]
        );
        full = JSON.parse(rows[0]?.plain || "{}");
      } catch {
        full = {};
      }
    }
    // Креды вложены по mp_code даже для магазина с одним МП (см. shops POST route.js).
    out.push({ shop_id: s.shop_id, mp_code: s.mp_code, creds: full[s.mp_code] || {} });
  }
  return out;
}

/** Текущий баланс WB через finance-api. */
async function wbBalance(token) {
  if (!token) return { value: 0, error: "WB_TOKEN не задан" };
  try {
    const r = await fetch("https://finance-api.wildberries.ru/api/v1/account/balance", {
      headers: { Authorization: token },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { value: 0, error: `WB HTTP ${r.status}: ${t.slice(0, 120)}` };
    }
    const j = await r.json();
    return { value: round2(j.current ?? 0), for_withdraw: round2(j.for_withdraw ?? 0) };
  } catch (e) {
    return { value: 0, error: `WB: ${e.message}` };
  }
}

/** Текущий баланс Ozon: closing_balance за сегодня = текущий остаток. */
async function ozonBalance(clientId, apiKey) {
  if (!clientId || !apiKey) return { value: 0, error: "Ozon creds не заданы" };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch("https://api-seller.ozon.ru/v1/finance/balance", {
      method: "POST",
      headers: { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ date_from: today, date_to: today }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { value: 0, error: `Ozon HTTP ${r.status}: ${t.slice(0, 120)}` };
    }
    const j = await r.json();
    return { value: round2(j?.total?.closing_balance?.value ?? 0) };
  } catch (e) {
    return { value: 0, error: `Ozon: ${e.message}` };
  }
}

/**
 * Разбивка балансов МП по маркетплейсам на текущую дату.
 * @param {{cabinetId:number, force?:boolean}} opts — cabinetId ОБЯЗАТЕЛЕН (мультитенант).
 * @returns {Promise<{ wb:number, ozon:number, yandex:number, total:number,
 *                     wb_withdraw?:number, errors?:string[], cached:boolean }>}
 */
export async function mpBalanceBreakdown(opts = {}) {
  const cabinetId = Number(opts.cabinetId);
  if (!cabinetId) {
    // Без cabinetId вернуть безопасные нули (не крашить баланс) — но это баг вызова.
    return { wb: 0, ozon: 0, yandex: 0, total: 0, errors: ["cabinetId required"], cached: false };
  }

  // Кэш per-cabinet (Map) — иначе баланс кабинета A утечёт в B.
  const cached = _cache.get(cabinetId);
  if (!opts.force && cached && Date.now() - cached.ts < CACHE_MS) {
    return { ...cached.data, cached: true };
  }

  const shops = await getShopCredsForCabinet(cabinetId);
  const wbShops = shops.filter((s) => s.mp_code === "wb" && s.creds.token);
  const ozShops = shops.filter((s) => s.mp_code === "ozon" && s.creds.client_id && s.creds.api_key);

  const [wbResults, ozResults] = await Promise.all([
    Promise.all(wbShops.map((s) => wbBalance(s.creds.token))),
    Promise.all(ozShops.map((s) => ozonBalance(s.creds.client_id, s.creds.api_key))),
  ]);

  // Суммируем по магазинам (обычно магазин один на МП, но наFuture-proof — сумма).
  const wbSum = wbResults.reduce((a, r) => a + (r.value || 0), 0);
  const wbWithdraw = wbResults.reduce((a, r) => a + (r.for_withdraw || 0), 0);
  const ozSum = ozResults.reduce((a, r) => a + (r.value || 0), 0);
  const yandex = 0; // Заглушка: коллектора Яндекс Маркета нет.

  const errors = [...wbResults, ...ozResults].map((r) => r.error).filter(Boolean);

  const data = {
    wb: round2(wbSum),
    ozon: round2(ozSum),
    yandex,
    total: round2(wbSum + ozSum + yandex),
    wb_withdraw: round2(wbWithdraw),
    errors: errors.length ? errors : undefined,
    cached: false,
  };
  _cache.set(cabinetId, { ts: Date.now(), data });
  return data;
}
