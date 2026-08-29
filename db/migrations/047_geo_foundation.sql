-- 047_geo_foundation.sql — фундамент «Географии 2.0» (этап 1, спека 2026-08-28).
-- 1) Ozon: схема поставки (fbo/fbs), склад отгрузки, тип доставки, даты.
-- 2) tenant.wb_supplies — поставки WB FBS (лаг отгрузки на СЦ).
-- 3) shared.ozon_clusters — справочник «склад Ozon → кластер».
BEGIN;

ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS scheme        TEXT;   -- 'fbo' | 'fbs'
ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS warehouse_id  BIGINT; -- analytics_data.warehouse_id
ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS delivery_type TEXT;   -- PVZ / Courier / ...
ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS shipment_dt   TEXT;   -- posting.shipment_date
-- delivered_dt заполняется UPDATE-ом из начислений (последняя миля 28/29/30),
-- НЕ upsert-ом заказов — поэтому её нет в _OZ_ORDERS_MAP.
ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS delivered_dt  TEXT;
ALTER TABLE tenant.ozon_sales  ADD COLUMN IF NOT EXISTS scheme        TEXT;

CREATE TABLE IF NOT EXISTS tenant.wb_supplies (
    cabinet_id            BIGINT NOT NULL,
    supply_id             TEXT   NOT NULL,   -- WB-GI-…
    name                  TEXT,              -- «Поставка Казань от 28.08.2026»
    created_at            TIMESTAMPTZ,       -- создана продавцом
    closed_at             TIMESTAMPTZ,       -- закрыта (передана в доставку)
    scan_dt               TIMESTAMPTZ,       -- отсканирована на СЦ (приёмка)
    reject_dt             TIMESTAMPTZ,
    done                  BOOLEAN NOT NULL DEFAULT false,
    cargo_type            INTEGER,
    destination_office_id BIGINT,            -- СЦ назначения
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, supply_id)
);
CREATE INDEX IF NOT EXISTS wb_supplies_created_idx ON tenant.wb_supplies (cabinet_id, created_at);

ALTER TABLE tenant.wb_supplies ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='wb_supplies' AND policyname='tenant_iso_wb_supplies') THEN
        CREATE POLICY tenant_iso_wb_supplies ON tenant.wb_supplies
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='wb_supplies' AND policyname='panel_local_ro_cab1') THEN
        CREATE POLICY panel_local_ro_cab1 ON tenant.wb_supplies
        FOR SELECT TO panel_local_ro
        USING (cabinet_id = 1);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.wb_supplies TO saas_app;
-- panel_local_ro_cab1 без базового GRANT SELECT бесполезна (RLS не заменяет
-- табличную привилегию) — как в 041/043/046.
GRANT SELECT ON tenant.wb_supplies TO panel_local_ro;

-- Справочник кластеров Ozon: глобальный, без cabinet_id и RLS (как shared.wb_warehouses).
CREATE TABLE IF NOT EXISTS shared.ozon_clusters (
    warehouse_id   BIGINT PRIMARY KEY,   -- склад/СЦ Ozon
    warehouse_name TEXT NOT NULL,
    warehouse_type TEXT,                 -- FULL_FILLMENT / SORTING_CENTER / CROSS_DOCK
    cluster_id     BIGINT NOT NULL,
    cluster_name   TEXT NOT NULL,        -- «Казань», «Москва, МО и Дальние регионы», …
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON shared.ozon_clusters TO saas_app;
-- Локальная read-only панель владельца (SSH-туннель, кабинет 1) — как у shared.wb_warehouses.
GRANT SELECT ON shared.ozon_clusters TO panel_local_ro;

COMMIT;
