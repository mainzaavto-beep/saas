-- 053_wb_order_costs_withdisc.sql — выручка WB по цене со скидкой продавца
-- (спека docs/superpowers/specs/2026-09-06-wb-revenue-by-price-design.md).
-- Σ retail_price_withdisc_rub строк «Продажа» по srid; 0 на возвратах (как
-- cost_value_retail/cost_value_pay). Заполняет сборщик wb_order_costs; бэкфилл
-- кабинета 1 — прогон за всю историю (2026-05-01..). Идемпотентно.
BEGIN;
ALTER TABLE tenant.wb_order_costs ADD COLUMN IF NOT EXISTS cost_value_withdisc DOUBLE PRECISION;
COMMIT;
