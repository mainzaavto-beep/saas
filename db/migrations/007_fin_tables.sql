-- =====================================================================
--  SaaS, Этап 7: таблицы fin_data.db → PostgreSQL (catalog, ff-stock, move).
--  Перенос products_catalog, products_catalog_skus, stock_ff_*,
--  wb_realloc_requests. Все с cabinet_id + RLS.
--  Данные из fin_data.db почти пустые (1-2 строки) — мигрируем схему.
-- =====================================================================

-- ========== products_catalog (внутренний справочник товаров) ==========
CREATE TABLE IF NOT EXISTS tenant.products_catalog (
    cabinet_id     BIGINT  NOT NULL,
    id             BIGSERIAL,
    internal_name  TEXT    NOT NULL,
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

CREATE TABLE IF NOT EXISTS tenant.products_catalog_skus (
    cabinet_id     BIGINT  NOT NULL,
    id             BIGSERIAL,
    catalog_id     BIGINT  NOT NULL,
    platform       TEXT    NOT NULL,
    nm_id          BIGINT,
    product_id     BIGINT,
    yandex_article TEXT,
    display_name   TEXT,
    im_url         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, catalog_id) REFERENCES tenant.products_catalog(cabinet_id, id) ON DELETE CASCADE,
    UNIQUE (cabinet_id, platform, nm_id, product_id)
);

-- ========== stock_ff_snapshots / balances / locations (склад ФФ) ==========
CREATE TABLE IF NOT EXISTS tenant.stock_ff_snapshots (
    cabinet_id   BIGINT  NOT NULL,
    id           BIGSERIAL,
    as_of_date   DATE    NOT NULL,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE TABLE IF NOT EXISTS tenant.stock_ff_balances (
    cabinet_id   BIGINT  NOT NULL,
    id           BIGSERIAL,
    snapshot_id  BIGINT  NOT NULL,
    catalog_id   BIGINT,
    internal_name TEXT,
    sku_label    TEXT,
    platform     TEXT,
    quantity     INTEGER DEFAULT 0,
    location_id  BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE TABLE IF NOT EXISTS tenant.stock_ff_locations (
    cabinet_id  BIGINT  NOT NULL,
    id          BIGSERIAL,
    name        TEXT NOT NULL,
    address     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- ========== wb_realloc_requests (заявки на перемещение) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_realloc_requests (
    cabinet_id     BIGINT  NOT NULL,
    id             BIGSERIAL,
    nm_id          BIGINT,
    catalog_id     BIGINT,
    from_warehouse TEXT,
    to_warehouse   TEXT,
    quantity       INTEGER,
    status         TEXT NOT NULL DEFAULT 'new',
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- RLS для всех
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'products_catalog','products_catalog_skus','stock_ff_snapshots',
    'stock_ff_balances','stock_ff_locations','wb_realloc_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_'||t) THEN
      EXECUTE format($f$
        CREATE POLICY tenant_iso_%I ON tenant.%I FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)
      $f$, t, t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant.products_catalog, tenant.products_catalog_skus,
  tenant.stock_ff_snapshots, tenant.stock_ff_balances, tenant.stock_ff_locations,
  tenant.wb_realloc_requests TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE
  tenant.products_catalog_id_seq, tenant.products_catalog_skus_id_seq,
  tenant.stock_ff_snapshots_id_seq, tenant.stock_ff_balances_id_seq,
  tenant.stock_ff_locations_id_seq, tenant.wb_realloc_requests_id_seq TO saas_app;
