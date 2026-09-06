-- Смоук-сторож «Склады 2.0», этап 1 «Данные». Запуск:
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage1.sql
-- Все проверки должны отдать ok=t (кабинет #1; под saas_ro RLS не скоупит — WHERE явно).

-- 1. Справочник складов продавца: обе площадки
SELECT 'seller_warehouses' AS check,
       COUNT(*) FILTER (WHERE platform='wb' AND is_active) > 0
       AND COUNT(*) FILTER (WHERE platform='ozon' AND is_active) > 0 AS ok,
       COUNT(*) FILTER (WHERE platform='wb') AS wb, COUNT(*) FILTER (WHERE platform='ozon') AS ozon
FROM tenant.mp_seller_warehouses WHERE cabinet_id=1;

-- 2. Штрихкоды WB покрывают каталог
SELECT 'wb_barcodes' AS check,
       COUNT(DISTINCT b.nm_id)::float / GREATEST((SELECT COUNT(*) FROM tenant.wb_articles WHERE cabinet_id=1),1) > 0.9 AS ok,
       COUNT(DISTINCT b.nm_id) AS nm_with_bc,
       (SELECT COUNT(*) FROM tenant.wb_articles WHERE cabinet_id=1) AS articles
FROM tenant.wb_barcodes b WHERE b.cabinet_id=1;

-- 3. Снимок FBS-остатков за сегодня есть по обеим площадкам, склады из справочника
SELECT 'fbs_stock_today' AS check,
       COUNT(*) FILTER (WHERE s.platform='wb') > 0 AND COUNT(*) FILTER (WHERE s.platform='ozon') > 0
       AND COUNT(*) FILTER (WHERE w.warehouse_id IS NULL) = 0 AS ok,
       COUNT(*) FILTER (WHERE s.platform='wb') AS wb_rows, COUNT(*) FILTER (WHERE s.platform='ozon') AS ozon_rows,
       COUNT(*) FILTER (WHERE w.warehouse_id IS NULL) AS orphan_wh
FROM tenant.mp_fbs_daily_stock s
LEFT JOIN tenant.mp_seller_warehouses w
  ON w.cabinet_id=s.cabinet_id AND w.platform=s.platform AND w.warehouse_id=s.warehouse_id
WHERE s.cabinet_id=1 AND s.date=current_date;

-- 4. warehouse_id у FBS-заданий WB за 30 дней = 100 % (COUNT(*)>0 — пустое окно не должно
-- зеленеть: 0=0 иначе тоже true, ревью раунд 1, 2026-09-06)
SELECT 'fbs_tasks_warehouse' AS check,
       COUNT(*) > 0 AND COUNT(*) = COUNT(warehouse_id) AS ok, COUNT(*) AS tasks_30d, COUNT(warehouse_id) AS with_wh
FROM tenant.wb_fbs_tasks WHERE cabinet_id=1 AND created_at >= now() - interval '30 days';

-- 5. FBS-постинги Ozon несут warehouse_id (спека §2.5, проверено 06.09 — правка не нужна);
-- COUNT(*)>0 — та же защита от пустого окна, что и в проверке 4
SELECT 'ozon_fbs_warehouse' AS check,
       COUNT(*) > 0 AND COUNT(*) = COUNT(warehouse_id) AS ok, COUNT(*) AS fbs, COUNT(warehouse_id) AS with_wh
FROM tenant.ozon_orders WHERE cabinet_id=1 AND scheme='fbs' AND order_dt >= '2026-08-01';

-- 6. Поставки Ozon на FBO собраны с составом
SELECT 'ozon_supply_orders' AS check,
       COUNT(DISTINCT o.order_id) > 0 AND COUNT(i.sku) > 0 AS ok,
       COUNT(DISTINCT o.order_id) AS orders, COUNT(i.sku) AS items
FROM tenant.ozon_supply_orders o
LEFT JOIN tenant.ozon_supply_order_items i ON i.cabinet_id=o.cabinet_id AND i.order_id=o.order_id
WHERE o.cabinet_id=1;

-- 7. Места: уникальность привязки соблюдена (индексы), есть хотя бы одно активное место
SELECT 'locations' AS check,
       COUNT(*) FILTER (WHERE is_active) > 0 AS ok,
       COUNT(*) AS places, COUNT(wb_warehouse_id) AS wb_linked, COUNT(ozon_warehouse_id) AS ozon_linked
FROM tenant.stock_ff_locations WHERE cabinet_id=1;
