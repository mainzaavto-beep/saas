-- 058_ozon_cabinet_search_traffic.sql — позиции по запросам и трафик Ozon из
-- кабинета продавца (спека docs/superpowers/specs/2026-09-12-ozon-cabinet-search-
-- traffic-design.md). Три дневные таблицы по SKU (сборщики ozon_cabinet_search /
-- ozon_cabinet_traffic), доступ к кабинету как свойство магазина (auth.shops.
-- cabinet_*), run_kind 'cabinet' для таймера saas-cabinet. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.ozon_search_queries_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,           -- день [d, d+1) по кабинету
    query         TEXT   NOT NULL,
    product_id    BIGINT,                    -- ozon_products по fbo_sku; NULL — нет в каталоге
    position      INTEGER,                   -- средняя позиция по запросу за день
    search_users  INTEGER,                   -- uniqueSearchUsers: спрос
    view_users    INTEGER,                   -- uniqueViewUsers
    ctr           DOUBLE PRECISION,          -- queryCtr, %
    click_users   INTEGER,                   -- uniqueClickUsers
    orders        INTEGER,                   -- orderCount («заказов по запросу»)
    gmv           DOUBLE PRECISION,          -- ₽ («GMV по запросу»)
    query_index   INTEGER,                   -- порядок по спросу в ответе кабинета
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date, query)
);
CREATE INDEX IF NOT EXISTS ozon_search_queries_daily_date_idx  ON tenant.ozon_search_queries_daily (cabinet_id, date);
CREATE INDEX IF NOT EXISTS ozon_search_queries_daily_query_idx ON tenant.ozon_search_queries_daily (cabinet_id, query, date);

CREATE TABLE IF NOT EXISTS tenant.ozon_sku_search_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,
    product_id    BIGINT,
    name          TEXT,
    article       TEXT,
    category      TEXT,
    position      INTEGER,                   -- средняя позиция в поиске по всем запросам (КАНОН)
    search_users  INTEGER,
    view_users    INTEGER,
    ctr           DOUBLE PRECISION,
    gmv           DOUBLE PRECISION,
    showcases_visibility TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date)
);
CREATE INDEX IF NOT EXISTS ozon_sku_search_daily_date_idx ON tenant.ozon_sku_search_daily (cabinet_id, date);

CREATE TABLE IF NOT EXISTS tenant.ozon_sku_traffic_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,
    product_id    BIGINT,
    total_views   INTEGER, search_views INTEGER, pdp_views INTEGER,
    hits_search_to_cart INTEGER, hits_pdp_to_cart INTEGER, total_hits_to_cart INTEGER,
    conv_search_to_pdp  DOUBLE PRECISION, conv_pdp_to_cart DOUBLE PRECISION,
    conv_cart_to_order  DOUBLE PRECISION, conv_views_to_order DOUBLE PRECISION,
    ordered_units INTEGER, delivered_units INTEGER, cancelled_units INTEGER, returned_units INTEGER,
    revenue DOUBLE PRECISION, avg_price DOUBLE PRECISION, price_index TEXT,
    drr DOUBLE PRECISION,                    -- ДРР по SKU за день, % (кабинет; НЕ канон панели)
    days_in_trafarets INTEGER, days_in_promo INTEGER,
    search_position INTEGER,                 -- справочно; канон — ozon_sku_search_daily.position
    last_stock INTEGER, last_stock_fbo INTEGER, last_stock_fbs INTEGER, stockout_days INTEGER,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date)
);
CREATE INDEX IF NOT EXISTS ozon_sku_traffic_daily_date_idx ON tenant.ozon_sku_traffic_daily (cabinet_id, date);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ozon_search_queries_daily','ozon_sku_search_daily','ozon_sku_traffic_daily'] LOOP
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

-- Доступ к кабинету продавца — свойство магазина (секретов нет: путь к профилю на сервере).
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_company_id TEXT;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_profile_dir TEXT;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_last_error TEXT;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_failed_at TIMESTAMPTZ;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_last_attempt_at TIMESTAMPTZ;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_notified_at TIMESTAMPTZ;
ALTER TABLE auth.shops DROP CONSTRAINT IF EXISTS shops_cabinet_state_check;
ALTER TABLE auth.shops ADD CONSTRAINT shops_cabinet_state_check CHECK (cabinet_state IN ('none','ok','expired'));

-- run_kind 'cabinet' для таймера saas-cabinet (по образцу 050/skuad).
ALTER TABLE jobs.collector_runs DROP CONSTRAINT IF EXISTS collector_runs_run_kind_check;
ALTER TABLE jobs.collector_runs ADD CONSTRAINT collector_runs_run_kind_check CHECK (run_kind IN
    ('main','stocks','metrics30m','references','backfill','systemd','manual','skuad','fbsstatus','cabinet'));

COMMIT;
