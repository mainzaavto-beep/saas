-- 059_ozon_prices_cabinet.sql — три цены из кабинета продавца в tenant.ozon_prices
-- (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §4).
-- Seller API не отдаёт цену витрины (постскриптум спеки 2026-08-02), поэтому
-- соинвест берём из кабинета: сборщик ozon_cabinet_prices пишет source='cabinet'.
-- Старые строки (Seller API, 02.08.2026) остаются с source='seller_api'. Идемпотентно.
BEGIN;
ALTER TABLE tenant.ozon_prices ADD COLUMN IF NOT EXISTS marketing_oa_price DOUBLE PRECISION; -- цена с Ozon Картой
ALTER TABLE tenant.ozon_prices ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'seller_api';
ALTER TABLE tenant.ozon_prices DROP CONSTRAINT IF EXISTS ozon_prices_source_check;
ALTER TABLE tenant.ozon_prices ADD CONSTRAINT ozon_prices_source_check CHECK (source IN ('seller_api','cabinet'));
CREATE INDEX IF NOT EXISTS ozon_prices_source_date_idx ON tenant.ozon_prices (cabinet_id, source, date);
COMMIT;
