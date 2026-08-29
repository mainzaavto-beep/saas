-- Смоук-сторож фундамента «Географии 2.0» (этап 1). Запуск:
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-geo-foundation.sql
-- Все четыре проверки должны отдать ok=t.

-- 1. Склад Ozon больше не пустой (свежие FBO-заказы)
SELECT 'ozon_warehouse_filled' AS check,
       COUNT(*) FILTER (WHERE warehouse='') = 0 AS ok, COUNT(*) AS n
FROM tenant.ozon_orders WHERE scheme='fbo' AND order_dt >= '2026-06-01';

-- 2. FBS-постинги появились и попали в деньги
SELECT 'ozon_fbs_in_money' AS check,
       COUNT(DISTINCT o.posting_number) > 0
       AND COUNT(DISTINCT c.posting_number) > 0 AS ok,
       COUNT(DISTINCT o.posting_number) AS fbs_orders,
       COUNT(DISTINCT c.posting_number) AS fbs_costs
FROM tenant.ozon_orders o
LEFT JOIN tenant.ozon_order_costs c
       ON c.cabinet_id=o.cabinet_id AND c.posting_number=o.posting_number
WHERE o.scheme='fbs';

-- 3. delivered_dt покрывает большинство доставленных (последняя миля ~89%)
SELECT 'ozon_delivered_dt' AS check,
       COUNT(*) FILTER (WHERE delivered_dt IS NOT NULL)::float / GREATEST(COUNT(*),1) > 0.7 AS ok,
       COUNT(*) FILTER (WHERE delivered_dt IS NOT NULL) AS with_dd, COUNT(*) AS delivered
FROM tenant.ozon_orders WHERE status='delivered' AND order_dt >= '2026-06-01';

-- 4. Поставки WB собраны, лаг отгрузки на СЦ считается
SELECT 'wb_supplies' AS check,
       COUNT(*) > 0 AND COUNT(scan_dt) > 0 AS ok,
       COUNT(*) AS supplies, COUNT(scan_dt) AS scanned
FROM tenant.wb_supplies;
