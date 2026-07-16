-- 017_locations.sql — поименованные места хранения (несколько складов + несколько ФФ).
--
-- Модель: tenant.stock_ff_locations — справочник мест (name, address, loc_type).
-- loc_type = 'stock' (наш склад) | 'ff' (фулфилмент). В ff_inventory добавляем
-- location_id — ссылку на конкретное место. Тип позиции (stock/ff) определяется
-- типом места (один источник правды). Колонку location_type на ff_inventory
-- оставляем для back-compat, но фронт/расчёты берут тип из места.
-- =====================================================================

-- 1. loc_type на stock_ff_locations (тип места: склад/ФФ).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='tenant' AND table_name='stock_ff_locations' AND column_name='loc_type'
  ) THEN
    ALTER TABLE tenant.stock_ff_locations ADD COLUMN loc_type TEXT NOT NULL DEFAULT 'stock';
  END IF;
END $$;

-- 2. location_id на ff_inventory (ссылка на конкретное место хранения).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='tenant' AND table_name='ff_inventory' AND column_name='location_id'
  ) THEN
    ALTER TABLE tenant.ff_inventory ADD COLUMN location_id BIGINT;
  END IF;
END $$;
