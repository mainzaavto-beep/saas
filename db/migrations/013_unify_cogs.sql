-- =====================================================================
--  013_unify_cogs.sql — единый источник правды для себестоимости.
--
--  Раньше себестоимость жила в 2 местах: tenant.wb_cogs/ozon_cogs (база) и
--  tenant.cost_overrides (ручные переопределения с effective_from). Канон
--  (lib/finItems.js) — override приоритетнее cogs, но половина роутов читала
--  только cogs → цифры расходились.
--
--  Решение (одобрено 2026-07-14): единый источник = cost_overrides.
--  Переносим все SKU из cogs в cost_overrides (effective_from='2020-01-01' —
--  действует с самого начала, покрывает всю историю заказов). SKU с уже
--  существующим override НЕ трогаем (override важнее).
--  cogs-таблицы НЕ дропаем (архив/откат), только убираем из SELECT'ов кодом.
--
--  Этап 1 (здесь же): пересчёт cost+profit в order_costs под override —
--  чтобы история заказов отражала актуальную себестоимость.
--
--  Идемпотентно (ON CONFLICT). Безопасно перезапускать.
-- =====================================================================

-- ========== Этап 0: cogs → cost_overrides ==========

-- WB: каждый nm_id из wb_cogs, которого ещё нет в cost_overrides → вставить.
-- effective_from='2020-01-01' (далёкое прошлое) — действует на все заказы.
INSERT INTO tenant.cost_overrides (cabinet_id, platform, nm_id, product_id, cost, effective_from)
SELECT c.cabinet_id, 'wb', c.nm_id, 0, c.cost, DATE '2020-01-01'
FROM tenant.wb_cogs c
WHERE NOT EXISTS (
  SELECT 1 FROM tenant.cost_overrides co
  WHERE co.cabinet_id = c.cabinet_id AND co.platform = 'wb' AND co.nm_id = c.nm_id
)
ON CONFLICT DO NOTHING;

-- Ozon: каждый product_id из ozon_cogs, которого ещё нет → вставить.
INSERT INTO tenant.cost_overrides (cabinet_id, platform, nm_id, product_id, cost, effective_from)
SELECT c.cabinet_id, 'ozon', 0, c.product_id, c.cost, DATE '2020-01-01'
FROM tenant.ozon_cogs c
WHERE NOT EXISTS (
  SELECT 1 FROM tenant.cost_overrides co
  WHERE co.cabinet_id = c.cabinet_id AND co.platform = 'ozon' AND co.product_id = c.product_id
)
ON CONFLICT DO NOTHING;

-- ========== Этап 1: пересчёт order_costs под override ==========

-- WB order_costs: cost = актуальный override на дату продажи (или заказа).
-- profit = cost_value_retail - cost - commission - acquiring - logistics - loyalty
-- (формула из сборщика wb_order_costs.py:73).
-- ⚠️ ROUND(x, 2) требует numeric; колонки order_costs — double precision → ::numeric.
UPDATE tenant.wb_order_costs oc SET
  cost = co.cost,
  profit = ROUND(
    (COALESCE(oc.cost_value_retail, 0) - co.cost
    - COALESCE(oc.commission, 0) - COALESCE(oc.acquiring, 0)
    - COALESCE(oc.logistics, 0) - COALESCE(oc.loyalty, 0))::numeric, 2
  )
FROM tenant.cost_overrides co
WHERE co.cabinet_id = oc.cabinet_id AND co.platform = 'wb' AND co.nm_id = oc.nm_id
  AND co.effective_from <= COALESCE(
    substr(oc.sale_dt, 1, 10)::date,
    substr(oc.order_dt, 1, 10)::date,
    current_date
  )
  AND NOT EXISTS (  -- берём только САМЫЙ свежий override на эту дату
    SELECT 1 FROM tenant.cost_overrides co2
    WHERE co2.cabinet_id = co.cabinet_id AND co2.platform = 'wb'
      AND co2.nm_id = co.nm_id
      AND co2.effective_from <= COALESCE(substr(oc.sale_dt,1,10)::date, substr(oc.order_dt,1,10)::date, current_date)
      AND co2.effective_from > co.effective_from
  );

-- Ozon order_costs: то же по product_id.
UPDATE tenant.ozon_order_costs oc SET
  cost = co.cost,
  profit = ROUND(
    (COALESCE(oc.cost_value_retail, 0) - co.cost
    - COALESCE(oc.commission, 0) - COALESCE(oc.acquiring, 0)
    - COALESCE(oc.logistics, 0) - COALESCE(oc.loyalty, 0))::numeric, 2
  )
FROM tenant.cost_overrides co
WHERE co.cabinet_id = oc.cabinet_id AND co.platform = 'ozon' AND co.product_id = oc.product_id
  AND co.effective_from <= COALESCE(
    substr(oc.sale_dt, 1, 10)::date,
    substr(oc.order_dt, 1, 10)::date,
    current_date
  )
  AND NOT EXISTS (
    SELECT 1 FROM tenant.cost_overrides co2
    WHERE co2.cabinet_id = co.cabinet_id AND co2.platform = 'ozon'
      AND co2.product_id = co.product_id
      AND co2.effective_from <= COALESCE(substr(oc.sale_dt,1,10)::date, substr(oc.order_dt,1,10)::date, current_date)
      AND co2.effective_from > co.effective_from
  );

COMMENT ON TABLE tenant.cost_overrides IS 'Единый источник себестоимости (с 2026-07-14). wb_cogs/ozon_cogs — архив, НЕ читаются кодом. Override с effective_from: актуальный = последний с effective_from <= дата продажи.';
