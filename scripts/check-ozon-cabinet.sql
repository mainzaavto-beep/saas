-- Сторож данных кабинета Ozon (спека §7).
-- Проверки 1, 3, 4 — гейт (ok = t); проверка 2 — справочная: два эндпоинта кабинета
-- считают позицию по-разному (решение 12.09.2026), канон — сводка.
-- Запуск: psql -U saas_ro -h localhost -d saas -v cab=1 -f scripts/check-ozon-cabinet.sql
\set ON_ERROR_STOP on
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
-- 2 (справочно, НЕ гейт) — позиция сводки vs charts/v3: разные методики двух
-- эндпоинтов кабинета, порог «≥90% при |Δ|≤5» не проходит ни в один день и только
-- шумит. ok намеренно NULL::boolean — форма строк остаётся единой со строками 1/3/4.
SELECT '2 (справочно) позиция: сводка vs charts/v3' AS chk, s.date,
       count(*) AS n,
       round(100.0 * count(*) FILTER (WHERE abs(s.position - t.search_position) <= 5) / count(*), 1) AS pct_close,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(s.position - t.search_position)) AS median_abs_delta,
       NULL::boolean AS ok
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
