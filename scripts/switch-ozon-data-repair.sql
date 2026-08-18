-- switch-ozon-data-repair.sql — Задача 6 плана «ремонт данных прибыли Ozon»
-- (.superpowers/sdd/2026-08-17-ozon-data-repair/). Журнал одноразовой
-- операции подмены: боевая tenant.ozon_order_costs заменяется тенью
-- tenant.ozon_order_costs_shadow (задача 5) — полный пересчёт исправленным
-- сборщиком (датировка «датой первой операции» бездатных строк, возврат
-- SKU-пропусков с product_id NULL, src_unit_number).
-- Владелец одобрил подмену 2026-08-18 по документу дельты
-- docs/ozon-data-repair-delta.md (шлюз пройден, зафиксировано в ledger
-- .superpowers/sdd/2026-08-17-ozon-data-repair/progress.md).
--
-- Применять АДМИНСКИМ psql ОДНОЙ транзакцией (не dev/app-роль):
--   PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas \
--     -f scripts/switch-ozon-data-repair.sql | tee <куда-то в отчёт задачи 6>
--
-- Перед запуском ОБЯЗАТЕЛЬНО проверить, что плановый таймер saas-worker не
-- выполняется параллельно: `pgrep -af worker.orchestrator` пусто и
-- `jobs.collector_runs` не содержит строк с finished_at IS NULL (подмена не
-- рассчитана на конкурентную запись в ту же таблицу). saas-worker.timer
-- сегодня (2026-08-18) уже отработал слот 17:00 MSK, следующий — 05:15 MSK
-- завтра; saas-backfill.timer (раз в 5 минут) — очередь jobs.collect_jobs
-- пуста (проверено), холостой прогон её не трогает.
--
-- ── Отличие от прошлой подмены (scripts/switch-ozon-profit.sql) ──────────
-- В прошлый раз тень была ПОДМНОЖЕСТВОМ боевой (боевая шире по датам,
-- тень уже — только диапазон пересчёта). В этот раз НАОБОРОТ: тень ШИРЕ
-- боевой (полный год истории против смешанной боевой, где часть строк уже
-- пересчитана предыдущими тиками, часть — ещё старая модель) и содержит
-- БОЛЬШЕ строк (возвращённые SKU-пропуски, задатированные бездатные
-- строки). По сверке задачи 5 (task-5-report.md, документ дельты §4,
-- снимок 2026-08-18 06:09:38 UTC) «строк боевой, отсутствующих в тени» —
-- 0 на обоих кабинетах: пересчёт НИЧЕГО не потерял на момент снимка.
-- Поэтому в этой подмене НЕТ аналога _extra_delete прошлого скрипта
-- (удаления боевых строк вне тени) — единственный риск это условие
-- нарушить: плановый тик успел дописать в боевую что-то НОВОЕ уже ПОСЛЕ
-- снятия снимка задачи 5 (06:09:38 UTC).
--
-- Разбор ПЕРЕД запуском (под saas_ro, см. отчёт задачи 6): на момент
-- проверки нашлось 82 такие строки (все кабинет 1; кабинет 1008 — 0).
-- Первая попытка классифицировать их по ДАТЕ ПОСТИНГА (сравнение с
-- верхней границей покрытия тени) дала бы ЛОЖНУЮ тревогу — 20 из 82
-- датированы 2026-08-05..08-16, РАНЬШЕ покрытия тени кабинета 1
-- (2026-08-16) — и штатно остановили бы транзакцию. Разбор показал:
-- причина не в дате постинга, а в МОМЕНТЕ ПОЯВЛЕНИЯ данных — источник
-- денег, `tenant.ozon_accruals`, живая таблица: начисление по СТАРОМУ
-- постингу (даже 2026-08-05) может доехать в БД позже даты продажи.
-- Прямая проверка `updated_at` всех 82 строк (и в `ozon_accruals`, и в
-- боевой `ozon_order_costs`) показала: ВСЕ 82 — `updated_at = 2026-08-18
-- 14:05:0{4,5} UTC`, что совпадает с прогоном `ozon_accruals`/
-- `ozon_order_costs` планового тика 12:00 MSK (см. `jobs.collector_runs`
-- — слот сработал с опозданием после двух неудачных попыток 09:05/09:08,
-- известный 403-паттерн) — СТРОГО ПОЗЖЕ снимка тени. Поэтому правильный
-- критерий легитимности — НЕ дата постинга, а `updated_at` самой строки
-- боевой относительно момента снятия тени:
--   • `oc.updated_at > '2026-08-18 06:09:38+00'` — строка физически не
--     могла быть такой на момент снятия тени (записана более поздним
--     тиком, уже действующим v2-сборщиком со всеми фиксами этого плана)
--     — легитимно, подмена продолжается, строка НЕ трогается (не
--     удаляется, не заменяется — она уже актуальна);
--   • иначе (`updated_at` РАНЬШЕ снимка тени, то есть строка уже
--     существовала на момент снятия тени, но полный пересчёт её не
--     увидел вовсе) — необъяснимо, транзакция останавливается RAISE
--     EXCEPTION (ROLLBACK) — нужен ручной разбор, подмена автоматически
--     не продолжается.
--
-- После COMMIT: снимок «после» сверить со столбцом «Станет» документа
-- дельты (docs/ozon-data-repair-delta.md, раздел 3), затем ОТДЕЛЬНОЙ
-- админской командой (не в этой транзакции — сначала сверка чисел, потом
-- дроп):
--   PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas \
--     -c 'DROP TABLE tenant.ozon_order_costs_shadow;'
-- Миграция 041 идемпотентна — при повторном применении просто пересоздаст
-- пустую таблицу.

BEGIN;

\echo '=== Снимок ДО подмены (по месяцам, cabinet_id) ==='
SELECT to_char(date_trunc('month', COALESCE(sale_dt, return_dt)::date),'YYYY-MM') AS m,
       cabinet_id, count(*), round(sum(profit)::numeric,2) AS profit
FROM tenant.ozon_order_costs GROUP BY 1,2 ORDER BY 1,2;

\echo '=== Снимок ДО подмены — годовой итог по кабинету (сверить со столбцом «Сейчас» дельты, раздел 1) ==='
SELECT cabinet_id, count(*), round(sum(profit)::numeric,2) AS profit
FROM tenant.ozon_order_costs GROUP BY 1 ORDER BY 1;

-- Момент снятия тени (снимок задачи 5, task-5-report.md / документ дельты).
CREATE TEMP TABLE _shadow_snapshot AS
SELECT '2026-08-18 06:09:38+00'::timestamptz AS ts;

-- Боевые строки, чей (cabinet_id, posting_number) отсутствует в тени —
-- считаем и классифицируем по updated_at ДО любого DELETE, чтобы числа
-- были честными.
CREATE TEMP TABLE _prod_only AS
SELECT oc.cabinet_id, oc.posting_number, oc.updated_at,
       COALESCE(oc.sale_dt, oc.return_dt) AS eff_date,
       oc.profit,
       (oc.updated_at > (SELECT ts FROM _shadow_snapshot)) AS is_fresh
FROM tenant.ozon_order_costs oc
LEFT JOIN tenant.ozon_order_costs_shadow s
  ON oc.cabinet_id = s.cabinet_id AND oc.posting_number = s.posting_number
WHERE s.posting_number IS NULL;

\echo '=== Предохранитель: строки боевой вне видимости тени, ДО удаления (ожидание: только is_fresh=t, записанные тиком ПОСЛЕ снимка тени) ==='
SELECT cabinet_id, is_fresh, count(*), round(sum(profit)::numeric,2) AS profit_sum,
       min(updated_at) AS min_upd, max(updated_at) AS max_upd
FROM _prod_only GROUP BY 1,2 ORDER BY 1,2;

-- СТОП, если среди строк вне тени есть хоть одна НЕ объяснимая более
-- поздним тиком (updated_at РАНЬШЕ/РАВЕН моменту снятия тени — то есть
-- строка существовала уже тогда, а полный пересчёт её не увидел вовсе).
-- Порогового % здесь нет сознательно (в отличие от прошлого скрипта) —
-- по протоколу задачи 6 такая строка не легитимна ни при какой сумме,
-- нужен ручной разбор.
DO $$
DECLARE
  stale_count bigint;
  stale_sum numeric;
BEGIN
  SELECT count(*), coalesce(sum(profit),0) INTO stale_count, stale_sum
  FROM _prod_only WHERE is_fresh IS NOT TRUE;
  RAISE NOTICE 'stale_count=% stale_sum=%', stale_count, stale_sum;
  IF stale_count > 0 THEN
    RAISE EXCEPTION 'СТОП: % боевых строк вне видимости тени существовали УЖЕ на момент снятия тени (updated_at не позже снимка), сумма % ₽ — не объясняются более поздним тиком, нужен ручной разбор перед подменой', stale_count, stale_sum;
  END IF;
END $$;

-- Основная подмена: строки, совпавшие по (cabinet_id, posting_number) с
-- тенью — удаляются, заменяются ниже свежей версией из тени. Строки
-- «только в боевой» (см. _prod_only, все is_fresh=t после проверки выше,
-- либо их нет вовсе) этот DELETE не затрагивает — не входят в USING.
DELETE FROM tenant.ozon_order_costs oc
 USING tenant.ozon_order_costs_shadow s
 WHERE oc.cabinet_id = s.cabinet_id AND oc.posting_number = s.posting_number;

\echo '=== Строк осталось в боевой между DELETE и INSERT (ожидание: только fresh-строки _prod_only, если такие есть) ==='
SELECT cabinet_id, count(*), round(sum(profit)::numeric,2) AS profit
FROM tenant.ozon_order_costs GROUP BY 1 ORDER BY 1;

INSERT INTO tenant.ozon_order_costs SELECT * FROM tenant.ozon_order_costs_shadow;

\echo '=== Снимок ПОСЛЕ подмены (по месяцам, cabinet_id) — сверить со столбцом «Станет» документа дельты, раздел 3 ==='
SELECT to_char(date_trunc('month', COALESCE(sale_dt, return_dt)::date),'YYYY-MM') AS m,
       cabinet_id, count(*), round(sum(profit)::numeric,2) AS profit
FROM tenant.ozon_order_costs GROUP BY 1,2 ORDER BY 1,2;

\echo '=== Снимок ПОСЛЕ подмены — годовой итог по кабинету (сверить со столбцом «Станет» дельты, раздел 1) ==='
SELECT cabinet_id, count(*), round(sum(profit)::numeric,2) AS profit
FROM tenant.ozon_order_costs GROUP BY 1 ORDER BY 1;

DROP TABLE _shadow_snapshot;
DROP TABLE _prod_only;

COMMIT;
