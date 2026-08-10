#!/usr/bin/env node
// scripts/check-reference.mjs — сверка собранных данных с эталоном отчётов
// маркетплейса (задача 3 плана «эталонные данные»).
//
// Подключение — ТОЛЬКО под saas_ro (readonlyPgConfig из scripts/lib/pgpass.mjs):
// у роли нет прав на запись, поэтому сторож физически не может изменить то,
// что проверяет. adminPgConfig здесь намеренно не используется.
//
// Определения величин взяты из docs/metrics-contract.md. Два места, где
// контракт не покрывает нужную величину буквально (обе — про Ozon), решены
// так и задокументированы прямо здесь, а не по памяти:
//
//   1. Реклама Ozon. Бриф задачи называет источником tenant.ozon_daily_ad,
//      но эта таблица не имеет сборщика (grep по worker/ ничего не находит)
//      и пуста для всех кабинетов без исключения. Взята таблица из контракта
//      (§8) — tenant.ozon_daily_efficiency, колонка ad_spend: она реально
//      наполняется (worker/collectors/ozon_efficiency.py) и её сумма за июль
//      2026 (60 843,50 ₽) совпадает с числом, зафиксированным в контракте.
//      Вечнозелёная проверка на пустой таблице хуже отсутствия проверки —
//      поэтому источник заменён, а не скопирован из брифа буквально.
//
//   2. Продажи/возврат/комиссия/логистика/выплата Ozon.
//      tenant.ozon_finance_report в контракте не описан вообще (контракт
//      писался по коду витрин, а эта таблица — отдельный сборщик
//      worker/collectors/ozon_finance.py специально под финансовый отчёт
//      Ozon, симметричный wb_finance_report). Разбивка на «продажи» и
//      «возврат» через знак суммы (>0 / <0) даёт бессмысленно раздутый
//      возврат — в сумме туда попадают все расходные операции (реклама,
//      упаковка, эквайринг и т.д.), а не только реальные возвраты. Поэтому,
//      по аналогии с фильтром supplier_oper_name у WB, здесь фильтр по
//      operation_type_name:
//        sales      = sale_amount       WHERE 'Доставка покупателю'
//        returns    = |sale_amount|     WHERE 'Получение возврата, отмены, невыкупа от покупателя'
//        commission = commission_amount WHERE 'Доставка покупателю' (аналогично WB
//                     §2.1 — комиссия считается по строкам продажи, без
//                     обратной коррекции на возврат)
//        logistics  = |services_amount| по ВСЕМ строкам периода — в API Ozon
//                     это общая «услуги» строка операции (см. комментарий
//                     _services_sum в ozon_finance.py: «логистика/обработка»),
//                     но по факту в неё попадают и эквайринг, и упаковка, и
//                     утилизация — то есть это не чистая логистика, а «прочие
//                     сервисные списания». Названо logistics, чтобы совпасть
//                     с ключом эталона, с этой оговоркой.
//        payout     = SUM(payout_amount) по ВСЕМ строкам периода — задумано
//                     как «к выплате» (аналог ppvz_for_pay у WB), но сборщик
//                     сейчас пишет payout_amount = sale_amount построчно для
//                     КАЖДОЙ операции (ozon_finance.py:64,67), то есть это
//                     поле пока не является независимым от sale_amount. Это
//                     не чинится здесь — сверка отражает то, что реально в
//                     колонке, а не то, что должно там быть.
//
// Точные имена колонок проверены в БД (\d tenant.wb_finance_report,
// \d tenant.ozon_finance_report, \d tenant.wb_daily_ad,
// \d tenant.ozon_daily_efficiency) 2026-08-10, не взяты по памяти.
//
// Коды выхода: 0 — сошлось, 1 — есть расхождение, 2 — эталон не заполнен
// или БД недоступна.
//
// Использование: node scripts/check-reference.mjs <каталог-эталона>
import pg from 'pg';
import { loadReference, compare } from '../lib/reference.js';
import { readonlyPgConfig } from './lib/pgpass.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('использование: node scripts/check-reference.mjs <каталог-эталона>');
  process.exit(2);
}

let ref;
try {
  ref = loadReference(dir);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

// Строит условие "колонка BETWEEN date_from AND date_to OR ... " по списку
// периодов эталона и возвращает вместе с параметрами (начиная с $offset).
function dateConds(periods, col, offset) {
  const parts = [];
  const params = [];
  periods.forEach((p, i) => {
    const a = offset + i * 2;
    const b = a + 1;
    parts.push(`(${col} BETWEEN $${a} AND $${b})`);
    params.push(p.date_from, p.date_to);
  });
  return { sql: parts.join(' OR '), params };
}

const pool = new pg.Pool(readonlyPgConfig());
const rows = []; // { mp, name, expected, actual }

try {
  const cabinetId = ref.cabinet_id;

  // ── WB: суммируем строго по датам недельных периодов эталона, не по календарю ──
  {
    const wbCond = dateConds(ref.wb.periods, 'rr_dt', 2);
    const sql = `
      SELECT
        SUM(retail_amount) FILTER (WHERE supplier_oper_name = 'Продажа') AS sales,
        ABS(SUM(retail_amount) FILTER (WHERE supplier_oper_name = 'Возврат')) AS returns,
        SUM(commission_percent * retail_price_withdisc_rub / 100.0)
          FILTER (WHERE supplier_oper_name = 'Продажа') AS commission,
        SUM(delivery_rub) FILTER (WHERE supplier_oper_name = 'Логистика') AS logistics,
        SUM(storage_fee) FILTER (WHERE supplier_oper_name = 'Хранение') AS storage,
        SUM(penalty) FILTER (WHERE supplier_oper_name = 'Штраф') AS penalty,
        SUM(deduction) FILTER (WHERE supplier_oper_name = 'Удержание') AS deduction,
        COALESCE(SUM(ppvz_for_pay) FILTER (WHERE supplier_oper_name = 'Продажа'), 0)
          - ABS(COALESCE(SUM(ppvz_for_pay) FILTER (WHERE supplier_oper_name = 'Возврат'), 0)) AS for_pay
      FROM tenant.wb_finance_report
      WHERE cabinet_id = $1 AND (${wbCond.sql})`;
    const { rows: [r] } = await pool.query(sql, [cabinetId, ...wbCond.params]);

    const adCond = dateConds(ref.wb.periods, 'date', 2);
    const adSql = `SELECT SUM(spend) AS ad_spend FROM tenant.wb_daily_ad WHERE cabinet_id = $1 AND (${adCond.sql})`;
    const { rows: [ad] } = await pool.query(adSql, [cabinetId, ...adCond.params]);

    const v = ref.wb.values;
    rows.push({ mp: 'wb', name: 'sales', expected: v.sales, actual: num(r.sales) });
    rows.push({ mp: 'wb', name: 'returns', expected: v.returns, actual: num(r.returns) });
    rows.push({ mp: 'wb', name: 'commission', expected: v.commission, actual: num(r.commission) });
    rows.push({ mp: 'wb', name: 'logistics', expected: v.logistics, actual: num(r.logistics) });
    rows.push({ mp: 'wb', name: 'storage', expected: v.storage, actual: num(r.storage) });
    rows.push({ mp: 'wb', name: 'penalty', expected: v.penalty, actual: num(r.penalty) });
    rows.push({ mp: 'wb', name: 'deduction', expected: v.deduction, actual: num(r.deduction) });
    rows.push({ mp: 'wb', name: 'for_pay', expected: v.for_pay, actual: num(r.for_pay) });
    rows.push({ mp: 'wb', name: 'ad_spend', expected: v.ad_spend, actual: num(ad.ad_spend) });
  }

  // ── Ozon: суммируем за календарный месяц эталона ──
  {
    const finCond = dateConds(ref.ozon.periods, "substr(operation_dt, 1, 10)", 2);
    const sql = `
      SELECT
        SUM(sale_amount) FILTER (WHERE operation_type_name = 'Доставка покупателю') AS sales,
        ABS(SUM(sale_amount) FILTER (
          WHERE operation_type_name = 'Получение возврата, отмены, невыкупа от покупателя'
        )) AS returns,
        SUM(commission_amount) FILTER (WHERE operation_type_name = 'Доставка покупателю') AS commission,
        ABS(SUM(services_amount)) AS logistics,
        SUM(payout_amount) AS payout
      FROM tenant.ozon_finance_report
      WHERE cabinet_id = $1 AND (${finCond.sql})`;
    const { rows: [r] } = await pool.query(sql, [cabinetId, ...finCond.params]);

    const adCond = dateConds(ref.ozon.periods, 'date', 2);
    const adSql = `SELECT SUM(ad_spend) AS ad_spend FROM tenant.ozon_daily_efficiency WHERE cabinet_id = $1 AND (${adCond.sql})`;
    const { rows: [ad] } = await pool.query(adSql, [cabinetId, ...adCond.params]);

    const v = ref.ozon.values;
    rows.push({ mp: 'ozon', name: 'sales', expected: v.sales, actual: num(r.sales) });
    rows.push({ mp: 'ozon', name: 'returns', expected: v.returns, actual: num(r.returns) });
    rows.push({ mp: 'ozon', name: 'commission', expected: v.commission, actual: num(r.commission) });
    rows.push({ mp: 'ozon', name: 'logistics', expected: v.logistics, actual: num(r.logistics) });
    rows.push({ mp: 'ozon', name: 'payout', expected: v.payout, actual: num(r.payout) });
    rows.push({ mp: 'ozon', name: 'ad_spend', expected: v.ad_spend, actual: num(ad.ad_spend) });
  }
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.message}`);
  await pool.end().catch(() => {});
  process.exit(2);
} finally {
  await pool.end().catch(() => {});
}

// ── печать таблицы ──
const fmtRub = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(
  pad('MP', 6) + pad('величина', 12) + padL('эталон, ₽', 16) + padL('наше, ₽', 16)
  + padL('разница, ₽', 14) + padL('разница, %', 12) + '  вердикт'
);

let diffCount = 0;
for (const row of rows) {
  const { ok, diffRub, diffPct } = compare(row.expected, row.actual);
  if (!ok) diffCount++;
  console.log(
    pad(row.mp, 6) + pad(row.name, 12) + padL(fmtRub(row.expected), 16) + padL(fmtRub(row.actual), 16)
    + padL(fmtRub(diffRub), 14) + padL(diffPct.toFixed(2) + '%', 12)
    + '  ' + (ok ? 'ok' : 'РАСХОЖДЕНИЕ')
  );
}

console.log('');
console.log(diffCount ? `${diffCount} РАСХОЖДЕНИЙ` : 'ALL PASS');
process.exit(diffCount ? 1 : 0);
