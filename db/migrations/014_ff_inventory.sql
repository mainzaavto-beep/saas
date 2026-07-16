-- 014_ff_inventory.sql — остатки склада/ФФ (маршрут: закупка → завершить → склад).
--
-- Новая таблица tenant.ff_inventory — независимый накопитель приходов:
-- при завершении закупки (кнопка «Завершить → склад») партия копируется сюда
-- со своей себестоимостью (AA = себест. до МП). Кол-во можно править вручную.
-- Привязка артикула МП (platform + nm_id/product_id) — опционально, на строке
-- остатка; при привязке создаётся cost_override → себестоимость течёт в
-- P&L/юнитку/mp-stock автоматически.
--
-- Старые stock_ff_* (snapshots-модель) НЕ трогаем — оставлены как есть.
-- =====================================================================

-- ========== tenant.ff_inventory ==========
CREATE TABLE IF NOT EXISTS tenant.ff_inventory (
    cabinet_id    BIGINT       NOT NULL,
    id            BIGSERIAL,
    purchase_id   BIGINT,                          -- ссылка на источник (tenant.purchases.id)
    internal_name TEXT,                            -- наименование товара (из supplier_name закупки)
    qty           INTEGER      NOT NULL DEFAULT 0,
    unit_cost     NUMERIC(14,2),                   -- себест. до МП (AA из закупки), ₽/ед
    category      TEXT,
    platform      TEXT,                            -- 'wb' | 'ozon' (после привязки артикула)
    nm_id         BIGINT,                          -- WB (после привязки)
    product_id    BIGINT,                          -- Ozon (после привязки)
    sku_name      TEXT,                            -- имя карточки МП (подтягивается при привязке)
    im_url        TEXT,                            -- фото карточки МП (подтягивается при привязке)
    completed_at  DATE,                            -- дата завершения закупки (для effective_from override)
    archived_at   TIMESTAMPTZ,                     -- если строка склада тоже архивируется
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- RLS (как на других tenant.* таблицах — эталон 007).
ALTER TABLE tenant.ff_inventory ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_ff_inventory') THEN
    EXECUTE $f$
      CREATE POLICY tenant_iso_ff_inventory ON tenant.ff_inventory FOR ALL TO saas_app
      USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
      WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)
    $f$;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ff_inventory TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.ff_inventory_id_seq TO saas_app;

-- ========== archived на purchases (флаг «завершена → скрыта из активных») ==========
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='tenant' AND table_name='purchases' AND column_name='archived'
  ) THEN
    ALTER TABLE tenant.purchases ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
