-- switch-ozon-profit.sql — Задача 5 плана «переезд финансов Ozon на методы
-- начислений» (.superpowers/sdd/2026-08-15-ozon-profit-switch/). Журнал
-- одноразовой операции подмены: боевая tenant.ozon_order_costs
-- переключается со старой модели (tenant.ozon_finance_report, «список
-- транзакций») на новую (tenant.ozon_accruals, «начисления по дням»).
-- Владелец одобрил подмену 2026-08-17 по документу дельты
-- docs/ozon-profit-switch-delta.md (шлюз пройден, зафиксировано в ledger
-- .superpowers/sdd/2026-08-15-ozon-profit-switch/progress.md).
--
-- Применять АДМИНСКИМ psql ОДНОЙ транзакцией (не dev/app-роль):
--   PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas \
--     -f scripts/switch-ozon-profit.sql | tee <куда-то в отчёт задачи 5>
--
-- Перед запуском ОБЯЗАТЕЛЬНО проверить, что плановый таймер saas-worker не
-- выполняется параллельно: `pgrep -af worker.orchestrator` пусто и
-- `jobs.collector_runs` не содержит строк с finished_at IS NULL. Если прогон
-- идёт — подождать его завершения, не запускать поверх (подмена не рассчитана
-- на конкурентную запись в ту же таблицу). После подмены плановый прогон,
-- сработавший в ближайший тик, просто перепишет свежие дни (14-17 августа)
-- идемпотентно — это ожидаемо и безопасно.
--
-- ── Анализ ДО запуска (под saas_ro, зафиксирован в task-5-report.md) ──────
-- Покрытие shadow по кабинету (min/max sale_dt непустых строк — совпадает
-- с фактическим диапазоном теневого прогона задачи 4, 2025-08-14..2026-08-16,
-- ниже в скрипте вычисляется динамически, а не зашито датами):
--   кабинет 1:    2025-08-14 .. 2026-08-16
--   кабинет 1008: 2025-08-14 .. 2026-08-16
--
-- Боевая tenant.ozon_order_costs (снимок 2026-08-17, 2192 строки) целиком лежит
-- в этом покрытии (старая модель физически не имеет данных раньше мая 2026)
-- — проверено:
--   • строк с sale_dt NOT NULL, отсутствующих в shadow по (cabinet_id,
--     posting_number) — 0 (весь боевой диапазон май-август 2026 совпадает с
--     shadow по posting_number, будет заменён основным DELETE...USING ниже);
--   • строк с sale_dt IS NULL, отсутствующих в shadow по posting_number — 26
--     (все кабинет 1), сумма profit −15 866,73 ₽; у всех 26 posting_number
--     ВСТРЕЧАЕТСЯ в tenant.ozon_accruals периода покрытия (новый источник их
--     «видел», но не записал в shadow — типично SKU-пропуск без резолва
--     product_id, санкционировано решением владельца, см. docs/
--     ozon-profit-switch-delta.md §8 п.4) — считаются «заменёнными», подлежат
--     удалению;
--   • строк «genuinely вне видимости нового источника» (posting_number вообще
--     не встречается в accruals покрытия) — 0.
--   • −15 866,73 ₽ ≈ 0,50% от суммарного profit боевой таблицы на момент
--     проверки (3 163 740,82 ₽) — НИЖЕ порога 1%, отдельного разбора/остановки
--     не требуется.
--
-- ── Правило удаления боевых строк, отсутствующих в shadow ─────────────────
-- (реализовано ниже через временную таблицу _extra_delete, вычисляемую ДО
-- любого DELETE, чтобы числа «до удаления» были честными):
--   1) любая боевая строка, чей (cabinet_id, posting_number) есть в shadow —
--      удаляется основным DELETE...USING (заменяется свежей строкой из shadow
--      при INSERT ниже, INSERT покрывает и её тоже);
--   2) боевая строка с sale_dt NOT NULL, НЕ найденная в shadow, чей
--      sale_dt::date попадает в покрытие shadow этого кабинета — удаляется
--      («отправление исчезло из нового источника»); в текущих данных таких
--      строк 0, правило оставлено для честности при повторном/будущем
--      применении скрипта на другом снимке;
--   3) боевая строка с sale_dt IS NULL, НЕ найденная в shadow — удаляется
--      ТОЛЬКО если её posting_number встречается хотя бы раз в
--      tenant.ozon_accruals в пределах покрытия shadow (новый источник её
--      «видел», просто не записал в shadow — SKU-пропуск/is_return-резолв);
--      если posting_number НЕ встречается в accruals вовсе — строка вне
--      видимости нового источника и СОХРАНЯЕТСЯ как есть (не подпадает ни под
--      один пункт правила, DELETE её не касается).
--
-- После COMMIT: снимок «после» сверить со столбцом «новая» документа дельты,
-- затем ОТДЕЛЬНОЙ админской командой (не в этой транзакции — сначала
-- сверка чисел, потом дроп):
--   PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas \
--     -c 'DROP TABLE tenant.ozon_order_costs_shadow;'
-- Миграция 041 идемпотентна — при повторном применении просто пересоздаст
-- пустую таблицу.

BEGIN;

\echo '=== Снимок ДО подмены (по месяцам, cabinet_id) ==='
SELECT to_char(date_trunc('month', sale_dt::date),'YYYY-MM') AS m, cabinet_id,
       count(*), round(sum(profit)::numeric,2) AS profit
FROM tenant.ozon_order_costs GROUP BY 1,2 ORDER BY 1,2;

-- Покрытие shadow по кабинету (из непустых sale_dt самой shadow — совпадает
-- с диапазоном её сбора, см. врезку выше).
CREATE TEMP TABLE _cov AS
SELECT cabinet_id, min(sale_dt::date) AS lo, max(sale_dt::date) AS hi
FROM tenant.ozon_order_costs_shadow
WHERE sale_dt IS NOT NULL
GROUP BY cabinet_id;

\echo '=== Покрытие shadow по кабинету ==='
SELECT * FROM _cov ORDER BY cabinet_id;

-- Боевые строки, отсутствующие в shadow по (cabinet_id, posting_number),
-- подпадающие под правило удаления (см. врезку выше) — считаем ДО удаления.
CREATE TEMP TABLE _extra_delete AS
SELECT oc.cabinet_id, oc.posting_number, oc.sale_dt, oc.profit,
       (oc.sale_dt IS NOT NULL) AS was_dated
FROM tenant.ozon_order_costs oc
JOIN _cov c ON c.cabinet_id = oc.cabinet_id
LEFT JOIN tenant.ozon_order_costs_shadow s
  ON oc.cabinet_id = s.cabinet_id AND oc.posting_number = s.posting_number
WHERE s.posting_number IS NULL
  AND (
        (oc.sale_dt IS NOT NULL AND oc.sale_dt::date BETWEEN c.lo AND c.hi)
     OR (oc.sale_dt IS NULL AND EXISTS (
            SELECT 1 FROM tenant.ozon_accruals a
            WHERE a.cabinet_id = oc.cabinet_id AND a.unit_number = oc.posting_number
              AND a.date BETWEEN c.lo AND c.hi))
      );

\echo '=== Строки боевой, отсутствующие в shadow, подлежащие удалению ОТДЕЛЬНО от основного DELETE (ДО удаления) ==='
SELECT cabinet_id, was_dated, count(*), round(sum(profit)::numeric,2) AS profit_sum
FROM _extra_delete GROUP BY 1,2 ORDER BY 1,2;

-- Страховка порога владельца (>1% суммарного profit боевой — СТОП). Числа
-- проверены заранее вручную под saas_ro (см. врезку выше); эта проверка —
-- защита на случай, если данные между проверкой и запуском изменились
-- (например, плановый прогон успел что-то дописать).
DO $$
DECLARE
  extra_sum numeric;
  total_sum numeric;
BEGIN
  SELECT coalesce(sum(profit),0) INTO extra_sum FROM _extra_delete;
  SELECT coalesce(sum(profit),0) INTO total_sum FROM tenant.ozon_order_costs;
  RAISE NOTICE 'extra_sum=% total_sum=%', extra_sum, total_sum;
  IF total_sum <> 0 AND abs(extra_sum) > abs(total_sum) * 0.01 THEN
    RAISE EXCEPTION 'СТОП: сумма сверх-удаления % превышает 1%% от общего profit % — нужен разбор владельца, не удалять автоматически', extra_sum, total_sum;
  END IF;
END $$;

-- Основная подмена: строки, совпавшие по (cabinet_id, posting_number) с
-- shadow — удаляются, заменяются ниже свежей версией из shadow.
DELETE FROM tenant.ozon_order_costs oc
 USING tenant.ozon_order_costs_shadow s
 WHERE oc.cabinet_id = s.cabinet_id AND oc.posting_number = s.posting_number;

-- Строки, отсутствующие в shadow, но подпадающие под правило «заменена»
-- (см. врезку выше и _extra_delete).
DELETE FROM tenant.ozon_order_costs oc
 USING _extra_delete e
 WHERE oc.cabinet_id = e.cabinet_id AND oc.posting_number = e.posting_number;

\echo '=== Строк осталось в боевой между двумя DELETE и INSERT (ожидается: только строки вне видимости нового источника, если такие есть) ==='
SELECT cabinet_id, count(*), round(sum(profit)::numeric,2) AS profit
FROM tenant.ozon_order_costs GROUP BY 1 ORDER BY 1;

INSERT INTO tenant.ozon_order_costs SELECT * FROM tenant.ozon_order_costs_shadow;

\echo '=== Снимок ПОСЛЕ подмены (по месяцам, cabinet_id) — сверить со столбцом «новая» документа дельты ==='
SELECT to_char(date_trunc('month', sale_dt::date),'YYYY-MM') AS m, cabinet_id,
       count(*), round(sum(profit)::numeric,2) AS profit
FROM tenant.ozon_order_costs GROUP BY 1,2 ORDER BY 1,2;

DROP TABLE _cov;
DROP TABLE _extra_delete;

COMMIT;
