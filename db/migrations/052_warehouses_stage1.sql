-- 052_warehouses_stage1.sql — Склады 2.0, этап 1 «Данные»
-- (спека docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md, §1–2).
-- Места хранения привязываются к складам продавца WB/Ozon; справочник этих
-- складов и их FBS-остатки собираются с МП; штрихкоды WB нужны для
-- marketplace-api /api/v3/stocks; warehouse_id у FBS-заданий — для авто-списания
-- (этап 2); поставки Ozon на FBO — для этапа 3. Идемпотентно.
BEGIN;

-- 1.1 места хранения ↔ склады продавца на МП
ALTER TABLE tenant.stock_ff_locations ADD COLUMN IF NOT EXISTS wb_warehouse_id   BIGINT;
ALTER TABLE tenant.stock_ff_locations ADD COLUMN IF NOT EXISTS ozon_warehouse_id BIGINT;
ALTER TABLE tenant.stock_ff_locations ADD COLUMN IF NOT EXISTS city              TEXT;
ALTER TABLE tenant.stock_ff_locations ADD COLUMN IF NOT EXISTS is_active         BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS stock_ff_locations_wb_wh_uq
    ON tenant.stock_ff_locations (cabinet_id, wb_warehouse_id) WHERE wb_warehouse_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_ff_locations_ozon_wh_uq
    ON tenant.stock_ff_locations (cabinet_id, ozon_warehouse_id) WHERE ozon_warehouse_id IS NOT NULL;

-- 1.2 справочник складов продавца (WB /api/v3/warehouses, Ozon /v1/warehouse/list)
CREATE TABLE IF NOT EXISTS tenant.mp_seller_warehouses (
    cabinet_id    BIGINT  NOT NULL,
    platform      TEXT    NOT NULL CHECK (platform IN ('wb','ozon')),
    warehouse_id  BIGINT  NOT NULL,
    name          TEXT    NOT NULL,
    kind          TEXT,                                   -- wb: deliveryType; ozon: fbs|rfbs
    is_active     BOOLEAN NOT NULL DEFAULT true,          -- false, если склад пропал из ответа МП
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, platform, warehouse_id)
);

-- 2.1 дневной снимок FBS-остатков складов продавца
CREATE TABLE IF NOT EXISTS tenant.mp_fbs_daily_stock (
    cabinet_id   BIGINT  NOT NULL,
    platform     TEXT    NOT NULL CHECK (platform IN ('wb','ozon')),
    warehouse_id BIGINT  NOT NULL,
    sku_key      BIGINT  NOT NULL,                        -- wb: nm_id; ozon: product_id
    date         DATE    NOT NULL,
    present      INTEGER,
    reserved     INTEGER,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, platform, warehouse_id, sku_key, date)
);
CREATE INDEX IF NOT EXISTS mp_fbs_daily_stock_date_idx ON tenant.mp_fbs_daily_stock (cabinet_id, date);

-- 2.2 штрихкоды WB (Content API cards sizes[].skus) — ключ /api/v3/stocks
CREATE TABLE IF NOT EXISTS tenant.wb_barcodes (
    cabinet_id BIGINT NOT NULL,
    barcode    TEXT   NOT NULL,
    nm_id      BIGINT NOT NULL,
    chrt_id    BIGINT,
    tech_size  TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, barcode)
);
CREATE INDEX IF NOT EXISTS wb_barcodes_nm_idx ON tenant.wb_barcodes (cabinet_id, nm_id);

-- 2.5 склад продавца у FBS-задания (marketplace-api /api/v3/orders → warehouseId)
ALTER TABLE tenant.wb_fbs_tasks ADD COLUMN IF NOT EXISTS warehouse_id BIGINT;

-- 2.6 поставки Ozon на FBO (/v2/supply-order/list + /get + /v1/supply-order/bundle)
CREATE TABLE IF NOT EXISTS tenant.ozon_supply_orders (
    cabinet_id          BIGINT NOT NULL,
    order_id            BIGINT NOT NULL,
    number              TEXT,
    state               TEXT,
    created_at          TIMESTAMPTZ,
    timeslot_from       TIMESTAMPTZ,
    timeslot_to         TIMESTAMPTZ,
    dest_warehouse_id   BIGINT,
    dest_warehouse_name TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, order_id)
);
CREATE TABLE IF NOT EXISTS tenant.ozon_supply_order_items (
    cabinet_id   BIGINT  NOT NULL,
    order_id     BIGINT  NOT NULL,
    sku          BIGINT  NOT NULL,
    product_id   BIGINT,
    qty_declared INTEGER,
    qty_accepted INTEGER,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, order_id, sku)
);

-- RLS + гранты для всех новых таблиц (образец: миграция 049)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['mp_seller_warehouses','mp_fbs_daily_stock','wb_barcodes',
                           'ozon_supply_orders','ozon_supply_order_items'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='tenant_iso_'||t) THEN
      EXECUTE format($p$CREATE POLICY %I ON tenant.%I FOR ALL TO saas_app
                       USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                       WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)$p$, 'tenant_iso_'||t, t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='panel_local_ro_cab1') THEN
      EXECUTE format('CREATE POLICY panel_local_ro_cab1 ON tenant.%I FOR SELECT TO panel_local_ro USING (cabinet_id = 1)', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.%I TO saas_app', t);
    EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
  END LOOP;
END $$;

COMMIT;
