#!/usr/bin/env node
// scripts/check-reference.mjs — сверка собранных данных с эталоном отчётов
// маркетплейса (задача 3 плана «эталонные данные», фикс-раунд 2 —
// закрытие находок финального ревью, 2026-08-10).
//
// Подключение — ТОЛЬКО под saas_ro (readonlyPgConfig из scripts/lib/pgpass.mjs):
// у роли нет прав на запись, поэтому сторож физически не может изменить то,
// что проверяет. adminPgConfig здесь намеренно не используется. readonlyPgConfig
// с 2026-08-10 игнорирует SAAS_DB из окружения (см. комментарий в pgpass.mjs) —
// сторож не может быть незаметно переключён на другую базу.
//
// ═══════════════════════════════════════════════════════════════════════════
// C1 (2026-08-10, ревью). Комиссия WB — снята со слоя данных, а не починена
// формулой.
// ═══════════════════════════════════════════════════════════════════════════
// До этого фикс-раунда здесь сравнивался операционный расчёт
// `commission_percent × retail_price_withdisc_rub / 100` (контракт §2.1,
// формула для страниц типа products-summary) с тем, что владелец впишет из
// ОТЧЁТА о реализации. Это сравнение двух РАЗНЫХ по определению величин:
// операционная формула даёт 364 864,36 ₽ за эталонные три недели (проверено
// saas_ro, 2026-08-10), а отчёт о реализации показывает удержанную комиссию
// на порядок меньше. Красная строка здесь означала бы «разные формулы», а
// не «потеря данных», и через неделю такую сверку перестали бы читать.
//
// Что проверено вместо этого — поиск отчётной колонки, из которой можно
// восстановить именно УДЕРЖАННУЮ комиссию:
//   • `ppvz_sales_commission` — колонка WB API, по названию должна быть ей.
//     На деле по строкам 'Продажа' за эталонные недели сумма ОТРИЦАТЕЛЬНА
//     (−5 119,90 ₽), по 'Возврат' тоже (−2 853,99 ₽). Комиссия не может быть
//     отрицательной на 372 реальных продажах — колонка ненадёжна в этих
//     данных (возможно, в неё пишутся построчные корректировки, а не итог).
//   • `ppvz_vw` — та же картина (−16 463,07 ₽ по 'Продажа').
//   • `retail_amount − ppvz_for_pay` (разница между официальной суммой
//     продажи и тем, что реально перечислено) по строкам 'Продажа' даёт
//     18 875,68 ₽ — порядок величины, который владелец скорее всего впишет
//     из отчёта. НО эта разница включает не только комиссию: `acquiring_fee`
//     на тех же строках — 25 122,00 ₽, что уже БОЛЬШЕ самой разницы, то есть
//     `retail_amount − ppvz_for_pay` не раскладывается на комиссию и
//     эквайринг чисто (остаток отрицательный, суммы не бьются с точностью
//     до рубля). Это не изолированная «комиссия», а «всё удержанное», куда
//     эквайринг уже подмешан.
// Ни одна из доступных колонок не даёт величину, которую можно назвать
// «удержанная комиссия» и надёжно просуммировать по строкам — поэтому
// комиссия WB здесь ЧЕСТНО ИСКЛЮЧЕНА из слоя данных (see REQUIRED_KEYS в
// lib/reference.js — 'commission' там остаётся ОБЯЗАТЕЛЬНЫМ полем эталона,
// но не участвует в SQL-сравнении ниже).
//
// Где комиссия WB проверяется вместо этого: значение из expected.json
// пригодится, когда появится слой расчёта (сверка страницы /pnl, а не
// таблицы) — там комиссия уже задокументирована как известный баг
// (docs/metrics-contract.md §2.2, «Известные расхождения», п. 1:
// `/pnl` считает её остаточным методом и на реальных данных обнуляет).
// До появления слоя расчёта эта строка данными не проверяется вовсе — это
// сознательный пробел, а не потеря функциональности (см. docs/data-trust-map.md).
//
// ═══════════════════════════════════════════════════════════════════════════
// I1 (2026-08-10, ревью). Ozon: sales/returns/commission/logistics/payout —
// сняты со слоя данных целиком, не починены по частям.
// ═══════════════════════════════════════════════════════════════════════════
// До этого фикс-раунда здесь стояли пять величин на `tenant.ozon_finance_report`
// (реклама Ozon — на другой таблице, её это не касается и она осталась; см.
// абзац «Реклама Ozon» ниже). Разбор (2026-08-10) нашёл, что у этой таблицы ДВА дефекта
// сборщика (`worker/collectors/ozon_finance.py`), делающих любую сумму по ней
// недостоверной, а не только отдельные поля:
//
//   1. `payout_amount` — побитовая копия `sale_amount` (строки 64, 67:
//      оба поля берут `op.get("amount")`). Проверено: SUM(sale_amount) по
//      ВСЕМ строкам периода = SUM(payout_amount) = 98 361,40 ₽ — совпадение
//      не на округление, а на копейку, потому что это буквально одно и то
//      же число, записанное дважды.
//   2. Строки 100-108: сборщик разворачивает операцию в НЕСКОЛЬКО строк
//      таблицы (по одной на каждый items[] внутри операции), но при этом
//      пишет в каждую такую строку операционные (не построчные!) поля
//      `amount` и `sale_commission` НЕ поделёнными на число товаров. Для
//      мультитоварных операций SUM(sale_amount)/SUM(commission_amount) по
//      группе строк одной операции задвоит (или размножит на N) её сумму.
//      Насколько это искажает итог за конкретный период — заранее не
//      посчитать без построчного аудита, которого эта задача не включает
//      («не чини сборщик — это отдельная работа»).
//
// Числа, которые дали повод усомниться (проверено saas_ro, 2026-08-10, июль
// 2026, кабинет 1 — это НАШИ сырые данные, не эталон):
//   sale_amount       (WHERE 'Доставка покупателю')      = 257 308,31 ₽
//   валовые продажи   (tenant.ozon_order_costs, contract §1.5) = 478 333 ₽
//   commission_amount (WHERE 'Доставка покупателю')      = 253 492,82 ₽
//   известная комиссия (tenant.ozon_order_costs, contract §2.3) = 221 912,58 ₽
//   services_amount (все строки, ABS)                     = 53 634,55 ₽
//     — уже в исходном комментарии этого файла было отмечено, что это не
//       чистая логистика, а общая «сервисная» строка (эквайринг, упаковка,
//       утилизация вперемешку).
// Ни sale_amount, ни commission_amount не совпадают по порядку величины с
// независимо подтверждёнными числами того же кабинета за тот же период —
// это ожидаемо при дефекте 2 (задвоение по items[]), а не просто «другое
// определение».
//
// Решение: sales/returns/commission/logistics/payout Ozon помечены «не
// готовы к сверке до починки сборщика» и НЕ участвуют ни в SQL ниже, ни в
// REQUIRED_KEYS (lib/reference.js) — требовать от владельца заполнить
// значения, которые нечем проверить, значит дать инструкцию, которая никогда
// не сработает (I4). `ad_spend` Ozon не затронут: он с другой таблицы
// (ozon_daily_efficiency), у неё дефектов не найдено, число совпадает с
// docs/metrics-contract.md §8 (60 843,50 ₽ за июль).
//
// Как вернуть эти пять величин: почините worker/collectors/ozon_finance.py
// (не делить `amount`/`sale_commission` на количество items — либо не
// разворачивать операцию на строки, либо переносить сумму только в первую
// строку, либо делить пропорционально), проверьте на реальных данных, что
// SUM(sale_amount | 'Доставка покупателю') сходится с известной валовой
// выручкой (order_costs), и верните ключи в REQUIRED_KEYS.ozon и в SQL ниже.
//
// Реклама Ozon (пояснение к строке ad_spend ниже, унаследовано из
// предыдущего фикс-раунда). Бриф задачи называл источником
// `tenant.ozon_daily_ad`, но эта таблица не имеет сборщика (grep по worker/
// ничего не находит) и пуста для всех кабинетов без исключения. Взята
// таблица из контракта (§8) — `tenant.ozon_daily_efficiency`, колонка
// `ad_spend`: она реально наполняется (worker/collectors/ozon_efficiency.py)
// и её сумма за июль 2026 (60 843,50 ₽) совпадает с числом, зафиксированным
// в контракте. Вечнозелёная проверка на пустой таблице хуже отсутствия
// проверки — поэтому источник заменён, а не скопирован из брифа буквально.
//
// ═══════════════════════════════════════════════════════════════════════════
// I2. Коды выхода разведены — код 2 больше не глушит проблемы с БД.
// ═══════════════════════════════════════════════════════════════════════════
//   0 — сошлось.
//   1 — есть расхождение (провал, разбирать; красная сверка — запрет на деплой).
//   2 — эталон не заполнен владельцем, ИЛИ скрипт вызван без аргумента. Это
//       НЕ провал: до заполнения expected.json сверке не с чем работать.
//   3 — БД недоступна или запрос не выполнился. Это ПРОВАЛ (в отличие от
//       кода 2): если эталон уже заполнен, а мы не можем прочитать боевые
//       данные, чтобы его проверить, — деплой запрещать так же, как на
//       коде 1, а не пропускать молча. До этого фикс-раунда оба случая были
//       одним и тем же кодом 2 — после заполнения эталона любая проблема с
//       БД молча превращалась в «не провал» (находка I2).
//
// Точные имена колонок проверены в БД (\d tenant.wb_finance_report,
// \d tenant.ozon_finance_report, \d tenant.wb_daily_ad,
// \d tenant.ozon_daily_efficiency) 2026-08-10, не взяты по памяти.
//
// Использование: node scripts/check-reference.mjs <каталог-эталона>
import pg from 'pg';
import { loadReference, compare } from '../lib/reference.js';
import { readonlyPgConfig } from './lib/pgpass.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('использование: node scripts/check-reference.mjs <каталог-эталона>');
  process.exit(2); // usage-ошибка приравнена к «эталон не задан» — ни разу не БД (I2)
}

let ref;
try {
  ref = loadReference(dir);
} catch (e) {
  console.error(e.message);
  process.exit(2); // эталон не заполнен — не провал, см. I2 выше
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
const rows = []; // { mp, name, expected, actual, loc }
const skipped = []; // { mp, name, reason } — величины эталона, намеренно не сверяемые на уровне данных

try {
  const cabinetId = ref.cabinet_id;

  // ── WB: суммируем строго по датам недельных периодов эталона, не по календарю ──
  {
    const wbCond = dateConds(ref.wb.periods, 'rr_dt', 2);
    // 'commission' здесь намеренно НЕТ — см. блок C1 в шапке файла.
    const sql = `
      SELECT
        SUM(retail_amount) FILTER (WHERE supplier_oper_name = 'Продажа') AS sales,
        ABS(SUM(retail_amount) FILTER (WHERE supplier_oper_name = 'Возврат')) AS returns,
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

    // Номера строк — на формулу конкретного поля в SQL выше (блок начинается
    // на 'SELECT' перед AS sales). Код меняется — если строка не совпадает,
    // ищите формулу через grep по имени поля в этом файле (та же оговорка,
    // что в docs/metrics-contract.md).
    const v = ref.wb.values;
    rows.push({ mp: 'wb', name: 'sales', expected: v.sales, actual: num(r.sales), loc: 'scripts/check-reference.mjs:187' });
    rows.push({ mp: 'wb', name: 'returns', expected: v.returns, actual: num(r.returns), loc: 'scripts/check-reference.mjs:188' });
    rows.push({ mp: 'wb', name: 'logistics', expected: v.logistics, actual: num(r.logistics), loc: 'scripts/check-reference.mjs:189' });
    rows.push({ mp: 'wb', name: 'storage', expected: v.storage, actual: num(r.storage), loc: 'scripts/check-reference.mjs:190' });
    rows.push({ mp: 'wb', name: 'penalty', expected: v.penalty, actual: num(r.penalty), loc: 'scripts/check-reference.mjs:191' });
    rows.push({ mp: 'wb', name: 'deduction', expected: v.deduction, actual: num(r.deduction), loc: 'scripts/check-reference.mjs:192' });
    rows.push({ mp: 'wb', name: 'for_pay', expected: v.for_pay, actual: num(r.for_pay), loc: 'scripts/check-reference.mjs:193-194' });
    rows.push({
      mp: 'wb', name: 'ad_spend', expected: v.ad_spend, actual: num(ad.ad_spend),
      loc: 'scripts/check-reference.mjs:200',
    });

    skipped.push({
      mp: 'wb', name: 'commission',
      reason: 'нет отчётной колонки, из которой надёжно восстанавливается удержанная комиссия — см. блок C1 в шапке файла',
    });
  }

  // ── Ozon: суммируем за календарный месяц эталона. Только ad_spend — см. I1 в шапке файла ──
  {
    const adCond = dateConds(ref.ozon.periods, 'date', 2);
    const adSql = `SELECT SUM(ad_spend) AS ad_spend FROM tenant.ozon_daily_efficiency WHERE cabinet_id = $1 AND (${adCond.sql})`;
    const { rows: [ad] } = await pool.query(adSql, [cabinetId, ...adCond.params]);

    const v = ref.ozon.values;
    rows.push({
      mp: 'ozon', name: 'ad_spend', expected: v.ad_spend, actual: num(ad.ad_spend),
      loc: 'scripts/check-reference.mjs:229',
    });

    for (const name of ['sales', 'returns', 'commission', 'logistics', 'payout']) {
      skipped.push({
        mp: 'ozon', name,
        reason: 'tenant.ozon_finance_report ненадёжна (payout_amount = sale_amount, суммы дублируются по items[]) — см. блок I1 в шапке файла',
      });
    }
  }
} catch (e) {
  console.error(`БД недоступна или запрос не выполнился: ${e.message}`);
  await pool.end().catch(() => {});
  process.exit(3); // ПРОВАЛ, не «эталон не заполнен» — см. I2 в шапке файла
} finally {
  await pool.end().catch(() => {});
}

// ── печать таблицы ──
const fmtRub = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(
  pad('MP', 6) + pad('величина', 12) + padL('эталон, ₽', 16) + padL('наше, ₽', 16)
  + padL('разница, ₽', 14) + padL('разница, %', 12) + '  вердикт  где считается'
);

let diffCount = 0;
for (const row of rows) {
  const { ok, diffRub, diffPct } = compare(row.expected, row.actual);
  if (!ok) diffCount++;
  console.log(
    pad(row.mp, 6) + pad(row.name, 12) + padL(fmtRub(row.expected), 16) + padL(fmtRub(row.actual), 16)
    + padL(fmtRub(diffRub), 14) + padL(diffPct.toFixed(2) + '%', 12)
    + '  ' + pad(ok ? 'ok' : 'РАСХОЖДЕНИЕ', 14) + row.loc
  );
}

if (skipped.length) {
  console.log('');
  console.log('Не сверяются на уровне данных (см. шапку файла):');
  for (const s of skipped) {
    console.log(`  ${s.mp}.${s.name} — ${s.reason}`);
  }
}

console.log('');
console.log(diffCount ? `${diffCount} РАСХОЖДЕНИЙ` : 'ALL PASS');
process.exit(diffCount ? 1 : 0);
