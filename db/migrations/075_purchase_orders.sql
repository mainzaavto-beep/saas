-- 075_purchase_orders.sql — закупки «заказ → позиции → отправки» (27.10.2026, спека
-- docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Старые tenant.purchases — архив.
-- Себестоимость считает lib/purchaseOrders.js; здесь только ввод. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.purchase_orders (
    cabinet_id       BIGINT      NOT NULL,
    id               BIGSERIAL   NOT NULL,
    order_no         TEXT,
    supplier         TEXT        NOT NULL CHECK (length(btrim(supplier)) > 0),
    supplier_contact TEXT,
    source_country   TEXT,
    category         TEXT,
    note             TEXT,
    order_dt         DATE,
    rate_cny         NUMERIC(12,4) CHECK (rate_cny IS NULL OR rate_cny > 0),
    status           TEXT        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','ordered','production','shipping','closed')),
    archived_at      TIMESTAMPTZ,
    deleted_at       TIMESTAMPTZ,
    created_by       BIGINT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

CREATE TABLE IF NOT EXISTS tenant.purchase_order_payments (
    cabinet_id  BIGINT      NOT NULL,
    id          BIGSERIAL   NOT NULL,
    order_id    BIGINT      NOT NULL,
    kind        TEXT        NOT NULL CHECK (kind IN ('prepay','balance','other')),
    currency    TEXT        NOT NULL DEFAULT 'cny' CHECK (currency IN ('cny','rub')),
    amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    rate        NUMERIC(12,4) CHECK (rate IS NULL OR rate > 0),
    plan_date   DATE,
    note        TEXT,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, order_id) REFERENCES tenant.purchase_orders (cabinet_id, id),
    CHECK (currency = 'rub' OR rate IS NOT NULL),
    CHECK (kind = 'other' OR currency = 'cny')
);

CREATE TABLE IF NOT EXISTS tenant.purchase_order_lines (
    cabinet_id  BIGINT      NOT NULL,
    id          BIGSERIAL   NOT NULL,
    order_id    BIGINT      NOT NULL,
    platform    TEXT        CHECK (platform IN ('wb','ozon')),
    nm_id       BIGINT,
    product_id  BIGINT,
    label       TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
    variant     TEXT,
    qty         INTEGER     NOT NULL CHECK (qty > 0),
    price_cny   NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (price_cny >= 0),
    weight_kg   NUMERIC(10,4) CHECK (weight_kg IS NULL OR weight_kg > 0),
    photo_url   TEXT,
    note        TEXT,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, order_id) REFERENCES tenant.purchase_orders (cabinet_id, id),
    CHECK (
      (platform = 'wb'   AND nm_id IS NOT NULL AND product_id IS NULL) OR
      (platform = 'ozon' AND product_id IS NOT NULL AND nm_id IS NULL) OR
      (platform IS NULL  AND nm_id IS NULL AND product_id IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS tenant.purchase_shipments (
    cabinet_id   BIGINT      NOT NULL,
    id           BIGSERIAL   NOT NULL,
    order_id     BIGINT      NOT NULL,
    shipment_no  TEXT,
    carrier      TEXT,
    ship_dt      DATE,
    eta          DATE,
    arrived_dt   DATE,
    status       TEXT        NOT NULL DEFAULT 'transit' CHECK (status IN ('transit','arrived','accepted')),
    cargo_rub    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cargo_rub >= 0),
    ff_rub       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (ff_rub >= 0),
    accepted_at  TIMESTAMPTZ,
    accepted_by  BIGINT,
    note         TEXT,
    deleted_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, order_id) REFERENCES tenant.purchase_orders (cabinet_id, id)
);

CREATE TABLE IF NOT EXISTS tenant.purchase_shipment_lines (
    cabinet_id    BIGINT  NOT NULL,
    id            BIGSERIAL NOT NULL,
    shipment_id   BIGINT  NOT NULL,
    line_id       BIGINT  NOT NULL,
    qty_shipped   INTEGER NOT NULL CHECK (qty_shipped > 0),
    qty_accepted  INTEGER CHECK (qty_accepted IS NULL OR qty_accepted >= 0),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, shipment_id, line_id),
    FOREIGN KEY (cabinet_id, shipment_id) REFERENCES tenant.purchase_shipments (cabinet_id, id),
    FOREIGN KEY (cabinet_id, line_id) REFERENCES tenant.purchase_order_lines (cabinet_id, id)
);

CREATE INDEX IF NOT EXISTS ix_po_payments_order ON tenant.purchase_order_payments (cabinet_id, order_id);
CREATE INDEX IF NOT EXISTS ix_po_lines_order ON tenant.purchase_order_lines (cabinet_id, order_id);
CREATE INDEX IF NOT EXISTS ix_po_shipments_order ON tenant.purchase_shipments (cabinet_id, order_id);
CREATE INDEX IF NOT EXISTS ix_po_ship_lines_ship ON tenant.purchase_shipment_lines (cabinet_id, shipment_id);
CREATE INDEX IF NOT EXISTS ix_po_ship_lines_line ON tenant.purchase_shipment_lines (cabinet_id, line_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders','purchase_order_payments','purchase_order_lines',
                           'purchase_shipments','purchase_shipment_lines'] LOOP
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
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tenant.%I TO saas_app', t || '_id_seq');
    EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
  END LOOP;
END $$;

COMMIT;
