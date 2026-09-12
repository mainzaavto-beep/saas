-- Сверка ДРР кабинета (charts/v3 drr, % за день по SKU) с ДРР панели по SKU.
-- Справочно (задача 7, план ozon-cabinet-search-traffic): решение о канонизации — владельца,
-- после недели наблюдений. Формула:
--   drr_panel = Σ ozon_daily_sku_ad.spend (реклама по кампании×SKU×день, суммируем по
--                (cabinet_id, product_id, date), т.к. один product_id может крутиться в
--                нескольких кампаниях за день)
--             ÷ Σ ozon_orders.total (сумма заказов панели по (cabinet_id, product_id, дата
--                заказа order_dt::date)) × 100.
-- Колонки проверены под saas_ro: tenant.ozon_daily_sku_ad(cabinet_id, date, campaign_id, sku
-- text, product_id, spend numeric, ...); tenant.ozon_orders(cabinet_id, product_id,
-- order_dt text ISO-timestamp, total double precision, ...) — совпадают с предположением брифа,
-- правка не потребовалась.
-- Запуск: psql -U saas_ro -h localhost -d saas -v cab=1 -f scripts/check-ozon-cabinet-drr.sql
WITH ad AS (
  SELECT cabinet_id, product_id, date, sum(spend) AS spend
    FROM tenant.ozon_daily_sku_ad
   WHERE cabinet_id = :cab
   GROUP BY 1, 2, 3
), o AS (
  SELECT cabinet_id, product_id, substr(order_dt, 1, 10)::date AS d, sum(total) AS orders_sum
    FROM tenant.ozon_orders
   WHERE cabinet_id = :cab
   GROUP BY 1, 2, 3
)
SELECT t.date, t.sku, t.product_id, t.drr AS drr_cabinet,
       round((ad.spend / NULLIF(o.orders_sum, 0) * 100)::numeric, 1) AS drr_panel,
       round((t.drr - ad.spend / NULLIF(o.orders_sum, 0) * 100)::numeric, 1) AS delta
  FROM tenant.ozon_sku_traffic_daily t
  LEFT JOIN ad ON ad.cabinet_id = t.cabinet_id AND ad.product_id = t.product_id AND ad.date = t.date
  LEFT JOIN o ON o.cabinet_id = t.cabinet_id AND o.product_id = t.product_id AND o.d = t.date
 WHERE t.cabinet_id = :cab AND t.drr IS NOT NULL AND t.drr > 0
 ORDER BY abs(t.drr - ad.spend / NULLIF(o.orders_sum, 0) * 100) DESC NULLS LAST
 LIMIT 40;
