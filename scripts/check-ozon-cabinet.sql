-- Сторож данных кабинета Ozon (спека §7). Все строки должны быть ok = t.
-- Запуск: psql -U saas_ro -h localhost -d saas -v cab=1 -f scripts/check-ozon-cabinet.sql
\set ON_ERROR_STOP on
WITH d AS (SELECT DISTINCT date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab)
-- 1. SKU сводки ⊆ SKU запросов и наоборот (по дням)
SELECT '1 sku сводки = sku запросов' AS chk,
       (SELECT count(*) FROM (
          SELECT sku, date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab
          EXCEPT SELECT DISTINCT sku, date FROM tenant.ozon_search_queries_daily WHERE cabinet_id = :cab) x) AS only_summary,
       (SELECT count(*) FROM (
          SELECT DISTINCT sku, date FROM tenant.ozon_search_queries_daily WHERE cabinet_id = :cab
          EXCEPT SELECT sku, date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab) x) AS only_queries,
       ((SELECT count(*) FROM (SELECT DISTINCT sku, date FROM tenant.ozon_search_queries_daily WHERE cabinet_id = :cab
          EXCEPT SELECT sku, date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab) x) = 0) AS ok;
-- 2. Позиция сводки ≈ позиция charts/v3 (|Δ| ≤ 5 у ≥ 90 % SKU дня)
SELECT '2 позиция: сводка vs charts' AS chk, s.date,
       round(100.0 * count(*) FILTER (WHERE abs(s.position - t.search_position) <= 5) / count(*), 1) AS pct_close,
       (100.0 * count(*) FILTER (WHERE abs(s.position - t.search_position) <= 5) / count(*)) >= 90 AS ok
  FROM tenant.ozon_sku_search_daily s
  JOIN tenant.ozon_sku_traffic_daily t ON t.cabinet_id = s.cabinet_id AND t.sku = s.sku AND t.date = s.date
 WHERE s.cabinet_id = :cab AND s.position IS NOT NULL AND t.search_position IS NOT NULL
 GROUP BY s.date ORDER BY s.date;
-- 3. Σ спроса по запросам SKU ≥ 0.8 × спрос сводки
SELECT '3 запросы покрывают спрос сводки' AS chk, s.date,
       count(*) FILTER (WHERE q.su < 0.8 * s.search_users) AS undercovered, count(*) AS total,
       (count(*) FILTER (WHERE q.su < 0.8 * s.search_users)) <= 0.1 * count(*) AS ok
  FROM tenant.ozon_sku_search_daily s
  JOIN (SELECT sku, date, sum(search_users) su FROM tenant.ozon_search_queries_daily WHERE cabinet_id = :cab GROUP BY 1, 2) q
    ON q.sku = s.sku AND q.date = s.date
 WHERE s.cabinet_id = :cab AND s.search_users > 0
 GROUP BY s.date ORDER BY s.date;
-- 4. Нет дыр внутри собранного диапазона
SELECT '4 нет дыр в днях' AS chk, min(date) AS d0, max(date) AS d1, count(*) AS days,
       (max(date) - min(date) + 1) = count(*) AS ok
  FROM (SELECT DISTINCT date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab) x;
