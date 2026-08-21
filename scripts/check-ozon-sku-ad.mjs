#!/usr/bin/env node
// scripts/check-ozon-sku-ad.mjs — сторож рекламы Ozon по товарам
// (tenant.ozon_daily_sku_ad, задача 3 плана «реклама Ozon по товарам»,
// .superpowers/sdd/2026-08-21-ozon-sku-ads/).
//
// Подключение — ТОЛЬКО saas_ro (readonlyPgConfig, каркас скопирован из
// check-wb-return-cogs.mjs): сторожу не нужны права на запись.
//
// Два чека за 4 последние ЗАКРЫТЫЕ ISO-недели (пн..вс, БЕЗ текущей —
// helper lastClosedIsoWeeks скопирован из check-ozon-profit-invariant.mjs):
//
//   Check 1 (кампания×день): Σ ozon_daily_sku_ad.spend ПРОТИВ
//     ozon_daily_campaign_ad.spend по каждой паре (campaign_id, date), где
//     есть хоть одна из сторон. Проверка ОДНОСТОРОННЯЯ (не |Δ|): кампанийная
//     таблица полнее (строки «Корректировка» и кампании без товарной
//     разбивки живут только в ней) — sku_sum МЕНЬШЕ campaign.spend (вплоть
//     до нуля на отдельных кампания×день) ожидаемо и НЕ FAIL. FAIL — только
//     sku_sum ЗАМЕТНО БОЛЬШЕ кампании (sku_sum − campaign.spend > допуск):
//     это уже не «недостача разбивки», а лишние деньги в товарном слое.
//     Допуск: max(1% от campaign.spend, 50 ₽).
//   Check 2 (день, товарный слой): Σ ozon_daily_metrics.ad_spend по товарам
//     за день <= Σ ozon_daily_campaign_ad.spend за день + тот же допуск —
//     товарный ad_spend (пересчитан из ozon_daily_sku_ad, см.
//     db_pg.py::recompute_ozon_daily_ad) не должен ПРЕВЫШАТЬ кабинетный
//     источник P&L.
//
// Кабинеты по умолчанию: 1 (боевой), 1008 (тест). Кабинет 1008 до бэкфилла
// задачи 5 плана даёт «нет строк» — это PASS с пометкой, не FAIL: сборщик
// ещё не гонялся на нём, отсутствие данных — не расхождение.
//
// Каждый SQL — с явным WHERE cabinet_id = $1 (saas_ro BYPASSRLS, обычные
// RLS-политики его не фильтруют).
//
// Использование:
//   node scripts/check-ozon-sku-ad.mjs
//   node scripts/check-ozon-sku-ad.mjs --cabinet 1
//   node scripts/check-ozon-sku-ad.mjs --weeks 8
import pg from 'pg';
import { readonlyPgConfig } from './lib/pgpass.mjs';

const DEFAULT_CABINETS = [1, 1008];
const DEFAULT_WEEKS = 4;
const TOL_PCT = 0.01;
const TOL_FLOOR_RUB = 50;

function parseArgs(argv) {
  const out = { cabinet: null, weeks: DEFAULT_WEEKS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cabinet') out.cabinet = Number(argv[++i]);
    else if (a === '--weeks') out.weeks = Number(argv[++i]);
    else if (a.startsWith('--cabinet=')) out.cabinet = Number(a.slice('--cabinet='.length));
    else if (a.startsWith('--weeks=')) out.weeks = Number(a.slice('--weeks='.length));
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

// ── 4 последние ЗАКРЫТЫЕ ISO-недели (пн..вс), НЕ включая текущую ──
// (тот же приём, что lib/calendarCalc.js::mondayOfIso и
// check-ozon-profit-invariant.mjs::lastClosedIsoWeeks)
function pad2(n) { return String(n).padStart(2, '0'); }
function toIsoLocal(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function mondayOf(d) {
  const nd = new Date(d);
  const wd = nd.getDay(); // 0=вс..6=сб
  const diff = (wd + 6) % 7; // дней с понедельника
  nd.setDate(nd.getDate() - diff);
  return nd;
}
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

const weeksCount = Number.isFinite(args.weeks) && args.weeks > 0 ? Math.floor(args.weeks) : DEFAULT_WEEKS;
const weeks = lastClosedIsoWeeks(weeksCount);
const windowFrom = weeks[0].from;
const windowTo = weeks[weeks.length - 1].to;

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const fmtRub = (n) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pool = new pg.Pool(readonlyPgConfig());
let failures = 0;
function verdict(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

try {
  const cabinets = args.cabinet ? [args.cabinet] : DEFAULT_CABINETS;

  console.log('Сторож рекламы Ozon по товарам (tenant.ozon_daily_sku_ad) — '
    + `окно ${windowFrom}..${windowTo} (${weeksCount} закрытых ISO-недель), кабинеты: ${cabinets.join(', ')}`);
  console.log('');

  for (const cabinetId of cabinets) {
    console.log(`─── Кабинет ${cabinetId} ───`);

    // Есть ли вообще строки sku_ad в окне? Кабинет 1008 (до бэкфилла
    // задачи 5) может быть пуст — это не FAIL, а информационный PASS.
    const { rows: [presence] } = await pool.query(
      `SELECT count(*) AS n FROM tenant.ozon_daily_sku_ad
       WHERE cabinet_id = $1 AND date >= $2 AND date <= $3`,
      [cabinetId, windowFrom, windowTo]
    );
    if (Number(presence.n) === 0) {
      verdict(`кабинет ${cabinetId}`, true, 'нет строк — сборщик ещё не гонялся в этом окне (не FAIL)');
      console.log('');
      continue;
    }

    // ── Check 1: (campaign_id, date) — Σ sku_ad.spend vs campaign_ad.spend ──
    const { rows: c1rows } = await pool.query(
      `SELECT COALESCE(s.campaign_id, c.campaign_id) AS campaign_id,
              COALESCE(s.date, c.date) AS date,
              COALESCE(s.sku_sum, 0) AS sku_sum,
              COALESCE(c.spend, 0) AS campaign_spend
       FROM (SELECT campaign_id, date, SUM(spend) AS sku_sum
             FROM tenant.ozon_daily_sku_ad
             WHERE cabinet_id = $1 AND date >= $2 AND date <= $3
             GROUP BY 1, 2) s
       FULL JOIN (SELECT campaign_id, date, spend
                  FROM tenant.ozon_daily_campaign_ad
                  WHERE cabinet_id = $1 AND date >= $2 AND date <= $3) c
         ON c.campaign_id = s.campaign_id AND c.date = s.date`,
      [cabinetId, windowFrom, windowTo]
    );
    let c1bad = [];
    for (const r of c1rows) {
      const skuSum = num(r.sku_sum);
      const campaignSpend = num(r.campaign_spend);
      const delta = skuSum - campaignSpend;
      const tol = Math.max(TOL_PCT * campaignSpend, TOL_FLOOR_RUB);
      // ОДНОСТОРОННЯЯ проверка (см. докстринг файла): sku_sum МЕНЬШЕ
      // кампании — ожидаемо (корректировки/кампании без товарной разбивки
      // живут только в campaign_ad), НЕ FAIL сколько угодно. sku_sum
      // ЗАМЕТНО БОЛЬШЕ кампании (delta > допуск) — лишние деньги в товарном
      // слое, всегда FAIL.
      if (delta > tol) {
        c1bad.push({ campaign_id: r.campaign_id, date: r.date, skuSum, campaignSpend, delta });
      }
    }
    verdict(
      'Check 1 — sku_ad.spend не превышает campaign_ad.spend по (campaign_id, date), допуск max(1%, 50₽)',
      c1bad.length === 0,
      `пар с превышением: ${c1bad.length} из ${c1rows.length}`
    );
    if (c1bad.length) {
      c1bad.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      for (const r of c1bad.slice(0, 10)) {
        console.log(`    campaign ${r.campaign_id} ${r.date instanceof Date ? toIsoLocal(r.date) : r.date}: `
          + `sku_sum=${fmtRub(r.skuSum)} ₽ campaign.spend=${fmtRub(r.campaignSpend)} ₽ Δ=${fmtRub(r.delta)} ₽`);
      }
    }

    // ── Check 2: день — Σ ozon_daily_metrics.ad_spend <= Σ campaign_ad.spend + допуск ──
    const { rows: c2rows } = await pool.query(
      `SELECT COALESCE(m.date, c.date) AS date,
              COALESCE(m.ad_spend_sum, 0) AS ad_spend_sum,
              COALESCE(c.campaign_spend_sum, 0) AS campaign_spend_sum
       FROM (SELECT date, SUM(ad_spend) AS ad_spend_sum
             FROM tenant.ozon_daily_metrics
             WHERE cabinet_id = $1 AND date >= $2 AND date <= $3 AND ad_spend IS NOT NULL
             GROUP BY 1) m
       FULL JOIN (SELECT date, SUM(spend) AS campaign_spend_sum
                  FROM tenant.ozon_daily_campaign_ad
                  WHERE cabinet_id = $1 AND date >= $2 AND date <= $3
                  GROUP BY 1) c
         ON c.date = m.date`,
      [cabinetId, windowFrom, windowTo]
    );
    let c2bad = [];
    for (const r of c2rows) {
      const adSpendSum = num(r.ad_spend_sum);
      const campaignSpendSum = num(r.campaign_spend_sum);
      const tol = Math.max(TOL_PCT * campaignSpendSum, TOL_FLOOR_RUB);
      if (adSpendSum - campaignSpendSum > tol) {
        c2bad.push({ date: r.date, adSpendSum, campaignSpendSum, delta: adSpendSum - campaignSpendSum });
      }
    }
    verdict(
      'Check 2 — Σ ozon_daily_metrics.ad_spend <= Σ campaign_ad.spend за день, допуск max(1%, 50₽)',
      c2bad.length === 0,
      `дней вне допуска: ${c2bad.length} из ${c2rows.length}`
    );
    if (c2bad.length) {
      c2bad.sort((a, b) => b.delta - a.delta);
      for (const r of c2bad.slice(0, 10)) {
        console.log(`    ${r.date instanceof Date ? toIsoLocal(r.date) : r.date}: `
          + `ad_spend=${fmtRub(r.adSpendSum)} ₽ campaign.spend=${fmtRub(r.campaignSpendSum)} ₽ Δ=${fmtRub(r.delta)} ₽`);
      }
    }

    console.log('');
  }
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.stack || e.message}`);
  await pool.end().catch(() => {});
  process.exit(3);
} finally {
  await pool.end().catch(() => {});
}

if (failures === 0) {
  console.log('ALL PASS — реклама Ozon по товарам сходится с кампанийным слоем в пределах допуска.');
  process.exit(0);
} else {
  console.log(`ИТОГО ${failures} РАСХОЖДЕНИЕ(Й) — см. блоки выше.`);
  process.exit(1);
}
