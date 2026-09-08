-- 055_supplies_stage3.sql — Склады 2.0, этап 3 «Поставки» (спека §4).
-- Документ отгрузки получает статусы и связь с фактом приёмки; приёмки FBO WB
-- (supplies-api: POST /api/v1/supplies, GET .../{id}, GET .../{id}/goods — старый
-- statistics-api /supplier/incomes WB отключил 2026-09-07, см. миграцию 056) —
-- новая таблица; пороги планирования — auth.cabinets.settings. Идемпотентно.
BEGIN;

ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS location_id       BIGINT;        -- откуда (место)
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS dest_warehouse_id BIGINT;        -- склад МП по справочнику
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'shipped'
    CHECK (status IN ('draft','shipped','accepted','partial','rejected'));
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS shipped_at        TIMESTAMPTZ;   -- момент списания
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS mp_supply_id      TEXT;          -- wb: income_id; ozon: order_id
ALTER TABLE tenant.ff_shipment_docs ADD COLUMN IF NOT EXISTS mp_supply_kind    TEXT CHECK (mp_supply_kind IN ('wb_income','ozon_supply_order'));
ALTER TABLE tenant.ff_shipment_lines ADD COLUMN IF NOT EXISTS qty_accepted     INTEGER;
ALTER TABLE tenant.ff_inventory      ADD COLUMN IF NOT EXISTS pack_qty         INTEGER;       -- кратность упаковки (NULL = 1)
ALTER TABLE auth.cabinets            ADD COLUMN IF NOT EXISTS settings         JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Приёмки FBO WB: supplies-api (строка = incomeId × nmId × barcode; incomeId = supplyID)
CREATE TABLE IF NOT EXISTS tenant.wb_incomes (
    cabinet_id     BIGINT  NOT NULL,
    income_id      BIGINT  NOT NULL,
    nm_id          BIGINT  NOT NULL,
    barcode        TEXT    NOT NULL DEFAULT '',
    number         TEXT,                 -- номер поставки в ЛК
    date           DATE,                 -- дата создания
    date_close     DATE,                 -- дата приёмки
    last_change    TIMESTAMPTZ,
    warehouse_name TEXT,
    tech_size      TEXT,
    quantity       INTEGER,              -- принято, шт
    total_price    NUMERIC(14,2),
    status         TEXT,                 -- «Принято» и т.п. как отдаёт WB
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, income_id, nm_id, barcode)
);
CREATE INDEX IF NOT EXISTS wb_incomes_date_idx ON tenant.wb_incomes (cabinet_id, date);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wb_incomes'] LOOP
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
