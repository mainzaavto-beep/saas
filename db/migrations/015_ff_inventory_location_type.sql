-- 015_ff_inventory_location_type.sql — тип размещения позиции: склад или ФФ.
--
-- location_type: 'stock' (наш склад) | 'ff' (фулфилмент). Редактируется вручную
-- на странице остатков, есть фильтр по нему. При завершении закупки (complete_to_stock)
-- по умолчанию = 'stock'.
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='tenant' AND table_name='ff_inventory' AND column_name='location_type'
  ) THEN
    ALTER TABLE tenant.ff_inventory ADD COLUMN location_type TEXT NOT NULL DEFAULT 'stock';
  END IF;
END $$;
