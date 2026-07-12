-- =====================================================================
--  SaaS, Этап 3: полная схема tenant.ozon_* (18 таблиц с cabinet_id + RLS).
--  Порт SQLite-схемы боевого collector_ozon/db.py в PostgreSQL.
--  Принципы: cabinet_id первая колонка PK; RLS по app.cabinet_id; типы PG.
--  Идемпотентно. Боевую ozon_data.db НЕ трогаем.
-- =====================================================================

-- ========== products (каталог товаров Ozon) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_products (
    cabinet_id              BIGINT  NOT NULL,
    product_id              BIGINT  NOT NULL,
    offer_id                TEXT,
    name                    TEXT    NOT NULL,
    barcode                 TEXT,
    fbo_sku                BIGINT,
    category                TEXT,
    brand                   TEXT,
    visibility              TEXT,
    commission_pct          DOUBLE PRECISION,
    weight                  DOUBLE PRECISION,
    length                  DOUBLE PRECISION,
    width                   DOUBLE PRECISION,
    height                  DOUBLE PRECISION,
    volume_weight           DOUBLE PRECISION,
    logistics_fbo_tariff    DOUBLE PRECISION,
    last_mile_pct           DOUBLE PRECISION,
    vat                     DOUBLE PRECISION,
    price                   DOUBLE PRECISION,
    old_price               DOUBLE PRECISION,
    im_url                  TEXT,
    description_category_id INTEGER,
    type_name               TEXT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id)
);

-- ========== daily_metrics ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_daily_metrics (
    cabinet_id  BIGINT  NOT NULL,
    product_id  BIGINT  NOT NULL,
    date        DATE    NOT NULL,
    orders      INTEGER,
    clicks      INTEGER,
    cart        INTEGER,
    rating      DOUBLE PRECISION,
    price       INTEGER,
    revenue     DOUBLE PRECISION,
    ad_views    INTEGER,
    ad_clicks   INTEGER,
    ad_orders   INTEGER,
    ad_spend    DOUBLE PRECISION,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id, date)
);
CREATE INDEX IF NOT EXISTS idx_oz_dm_date ON tenant.ozon_daily_metrics(date);

-- ========== daily_ad (реклама по кампаниям) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_daily_ad (
    cabinet_id    BIGINT  NOT NULL,
    product_id    BIGINT  NOT NULL,
    date          DATE    NOT NULL,
    campaign_id   BIGINT  NOT NULL,
    campaign_name TEXT,
    views         INTEGER,
    clicks        INTEGER,
    orders        INTEGER,
    spend         DOUBLE PRECISION,
    revenue       DOUBLE PRECISION,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id, date, campaign_id)
);

-- ========== finance_report (/v1/finance/transaction/list) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_finance_report (
    cabinet_id           BIGINT  NOT NULL,
    posting_id           TEXT    NOT NULL,
    operation_id         BIGINT  NOT NULL,
    operation_type_name  TEXT,
    operation_type_id    INTEGER,
    operation_dt         TEXT,
    product_id           BIGINT,
    item_spp             DOUBLE PRECISION,
    item_category_name   TEXT,
    item_offer_id        TEXT,
    item_name            TEXT,
    item_qty             INTEGER,
    item_price           DOUBLE PRECISION,
    sale_amount          DOUBLE PRECISION,
    accruals_for_sale    DOUBLE PRECISION,
    commission_amount    DOUBLE PRECISION,
    payout_amount        DOUBLE PRECISION,
    services_amount      DOUBLE PRECISION,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, posting_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_oz_fin_op ON tenant.ozon_finance_report(operation_dt);
CREATE INDEX IF NOT EXISTS idx_oz_fin_pid ON tenant.ozon_finance_report(product_id);

-- ========== daily_stock (остатки FBO) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_daily_stock (
    cabinet_id   BIGINT  NOT NULL,
    product_id   BIGINT  NOT NULL,
    date         DATE    NOT NULL,
    warehouse    TEXT    NOT NULL,
    fbo_present  INTEGER,
    fbo_reserved INTEGER,
    fbo_defect   INTEGER,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id, date, warehouse)
);
CREATE INDEX IF NOT EXISTS idx_oz_stock_date ON tenant.ozon_daily_stock(date);

-- ========== orders (постинги /v3/posting/fbo/list) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_orders (
    cabinet_id      BIGINT  NOT NULL,
    posting_number  TEXT    NOT NULL,
    product_id      BIGINT  NOT NULL,
    offer_id        TEXT,
    order_dt        TEXT,
    last_change_dt  TEXT,
    in_process_at   TEXT,
    status          TEXT,
    is_cancel       INTEGER,
    cancel_dt       TEXT,
    qty             INTEGER,
    price           DOUBLE PRECISION,
    total           DOUBLE PRECISION,
    warehouse       TEXT,
    region          TEXT,
    size            TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, posting_number, product_id)
);
CREATE INDEX IF NOT EXISTS idx_oz_orders_dt ON tenant.ozon_orders(order_dt);
CREATE INDEX IF NOT EXISTS idx_oz_orders_region ON tenant.ozon_orders(region);

-- ========== sales (доставленные/отменённые) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_sales (
    cabinet_id      BIGINT  NOT NULL,
    posting_number  TEXT    NOT NULL,
    product_id      BIGINT  NOT NULL,
    offer_id        TEXT,
    sale_dt         TEXT,
    last_change_dt  TEXT,
    status          TEXT,
    is_return       INTEGER,
    qty             INTEGER,
    price           DOUBLE PRECISION,
    revenue         DOUBLE PRECISION,
    payout_amount   DOUBLE PRECISION,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, posting_number, product_id)
);
CREATE INDEX IF NOT EXISTS idx_oz_sales_dt ON tenant.ozon_sales(sale_dt);

-- ========== cogs (себестоимость, ручной ввод) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_cogs (
    cabinet_id  BIGINT  NOT NULL,
    product_id  BIGINT  NOT NULL,
    cost        DOUBLE PRECISION NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id)
);

-- ========== order_costs (прибыль по заказу) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_order_costs (
    cabinet_id        BIGINT  NOT NULL,
    posting_number    TEXT    NOT NULL,
    product_id        BIGINT,
    size              TEXT,
    is_return         INTEGER DEFAULT 0,
    order_dt          TEXT,
    sale_dt           TEXT,
    return_dt         TEXT,
    cost_value_retail DOUBLE PRECISION,
    commission        DOUBLE PRECISION,
    acquiring         DOUBLE PRECISION,
    logistics         DOUBLE PRECISION,
    loyalty           DOUBLE PRECISION,
    cost              DOUBLE PRECISION,
    qty               INTEGER,
    profit            DOUBLE PRECISION,
    self_buyout       INTEGER DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, posting_number)
);
CREATE INDEX IF NOT EXISTS idx_oz_oc_dt ON tenant.ozon_order_costs(sale_dt);

-- ========== daily_efficiency (1 строка/день по кабинету) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_daily_efficiency (
    cabinet_id     BIGINT  NOT NULL,
    date           DATE    NOT NULL,
    orders         INTEGER,
    sales_sum      DOUBLE PRECISION,
    returns_count  INTEGER,
    returns_loss   DOUBLE PRECISION,
    profit         DOUBLE PRECISION,
    ad_spend       DOUBLE PRECISION,
    drr            DOUBLE PRECISION,
    target_drr     DOUBLE PRECISION,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, date)
);

-- ========== per_sku_costs (расходы по SKU) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_per_sku_costs (
    cabinet_id         BIGINT  NOT NULL,
    product_id         BIGINT  NOT NULL,
    date               DATE    NOT NULL,
    ad_spend           DOUBLE PRECISION,
    ad_spend_estimated DOUBLE PRECISION,
    ad_orders          INTEGER,
    ad_revenue         DOUBLE PRECISION,
    ad_views           INTEGER,
    ad_clicks          INTEGER,
    packaging          DOUBLE PRECISION,
    utilization        DOUBLE PRECISION,
    other              DOUBLE PRECISION,
    source             TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id, date)
);

-- ========== cabinet_costs (расходы без привязки к SKU) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_cabinet_costs (
    cabinet_id  BIGINT  NOT NULL,
    cost_type   TEXT    NOT NULL,
    date        DATE    NOT NULL,
    amount      DOUBLE PRECISION NOT NULL,
    description TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, cost_type, date)
);

-- ========== feedbacks (отзывы + workflow) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_feedbacks (
    cabinet_id       BIGINT  NOT NULL,
    id               TEXT    NOT NULL,
    marketplace      TEXT DEFAULT 'ozon',
    product_id       BIGINT,
    sku              BIGINT,
    rating           INTEGER,
    text             TEXT,
    author           TEXT,
    created_at       TEXT,
    was_answered     INTEGER DEFAULT 0,
    mp_answer        TEXT,
    product          TEXT,
    moderation_state TEXT,
    is_hidden        INTEGER DEFAULT 0,
    status           TEXT DEFAULT 'new',
    draft_reply      TEXT,
    replied_at       TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS idx_oz_fb_status ON tenant.ozon_feedbacks(status);

-- ========== feedback_summary / feedback_history ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_feedback_summary (
    cabinet_id       BIGINT  NOT NULL,
    product_id       BIGINT  NOT NULL,
    rating           DOUBLE PRECISION,
    feedbacks_count  INTEGER,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id)
);
CREATE TABLE IF NOT EXISTS tenant.ozon_feedback_history (
    cabinet_id       BIGINT  NOT NULL,
    product_id       BIGINT  NOT NULL,
    date             DATE    NOT NULL,
    rating           DOUBLE PRECISION,
    feedbacks_count  INTEGER,
    PRIMARY KEY (cabinet_id, product_id, date)
);

-- ========== questions (вопросы покупателей) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_questions (
    cabinet_id       BIGINT  NOT NULL,
    id               TEXT    NOT NULL,
    marketplace      TEXT DEFAULT 'ozon',
    product_id       BIGINT,
    sku              BIGINT,
    text             TEXT,
    author           TEXT,
    created_at       TEXT,
    was_answered     INTEGER DEFAULT 0,
    mp_answer        TEXT,
    product          TEXT,
    status           TEXT DEFAULT 'new',
    draft_reply      TEXT,
    replied_at       TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- ========== ozon_actions / ozon_action_products (акции бустинга) ==========
CREATE TABLE IF NOT EXISTS tenant.ozon_actions (
    cabinet_id                 BIGINT  NOT NULL,
    action_id                  BIGINT  NOT NULL,
    title                      TEXT,
    action_type                TEXT,
    discount_type              TEXT,
    discount_value             DOUBLE PRECISION,
    date_start                 TEXT,
    date_end                   TEXT,
    is_participating           INTEGER,
    participating_products_count INTEGER,
    potential_products_count   INTEGER,
    auto_add_dates             TEXT,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, action_id)
);
CREATE TABLE IF NOT EXISTS tenant.ozon_action_products (
    cabinet_id         BIGINT  NOT NULL,
    action_id          BIGINT  NOT NULL,
    product_id         BIGINT  NOT NULL,
    date               DATE    NOT NULL,
    price              DOUBLE PRECISION,
    action_price       DOUBLE PRECISION,
    max_action_price   DOUBLE PRECISION,
    add_mode           TEXT,
    stock              INTEGER,
    current_boost      DOUBLE PRECISION,
    price_min_elastic  DOUBLE PRECISION,
    price_max_elastic  DOUBLE PRECISION,
    min_boost          DOUBLE PRECISION,
    max_boost          DOUBLE PRECISION,
    alert_max_action_price INTEGER,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, action_id, product_id, date)
);

-- =====================================================================
--  RLS: одна политика для всех ozon-таблиц.
-- =====================================================================
DO $$
DECLARE
    t TEXT;
    oz_tables TEXT[] := ARRAY[
        'ozon_products','ozon_daily_metrics','ozon_daily_ad','ozon_finance_report',
        'ozon_daily_stock','ozon_orders','ozon_sales','ozon_cogs','ozon_order_costs',
        'ozon_daily_efficiency','ozon_per_sku_costs','ozon_cabinet_costs','ozon_feedbacks',
        'ozon_feedback_summary','ozon_feedback_history','ozon_questions','ozon_actions',
        'ozon_action_products'
    ];
BEGIN
    FOREACH t IN ARRAY oz_tables LOOP
        EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_'||t) THEN
            EXECUTE format($f$
                CREATE POLICY tenant_iso_%I ON tenant.%I
                FOR ALL TO saas_app
                USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)
            $f$, t, t);
        END IF;
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenant TO saas_app;
