-- =====================================================================
--  SaaS, Этап 3: полная схема tenant.wb_* (19 таблиц с cabinet_id + RLS).
--  Порт SQLite-схемы боевого collector_wb/db.py в PostgreSQL.
--  Принципы: cabinet_id первая колонка PK; RLS по app.cabinet_id; типы PG.
--  Идемпотентно (CREATE ... IF NOT EXISTS). Боевую wb_data.db НЕ трогаем.
-- =====================================================================

-- ==========Articles (каталог продавца) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_articles (
    cabinet_id BIGINT  NOT NULL,
    nm_id      BIGINT  NOT NULL,
    name       TEXT    NOT NULL,
    brand      TEXT,
    subject    TEXT,
    im_url     TEXT,
    PRIMARY KEY (cabinet_id, nm_id)
);
CREATE INDEX IF NOT EXISTS idx_wb_articles_subject ON tenant.wb_articles(subject);

-- ========== daily_metrics (воронка за день) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_daily_metrics (
    cabinet_id BIGINT  NOT NULL,
    nm_id      BIGINT  NOT NULL,
    date       DATE    NOT NULL,
    orders     INTEGER,
    clicks     INTEGER,
    cart       INTEGER,
    rating     DOUBLE PRECISION,
    price      INTEGER,
    spp        DOUBLE PRECISION,
    ad_views   INTEGER,
    ad_clicks  INTEGER,
    ad_atbs    INTEGER,
    ad_orders  INTEGER,
    ad_spend   DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id, date)
);
CREATE INDEX IF NOT EXISTS idx_wb_dm_date ON tenant.wb_daily_metrics(date);

-- ========== daily_ad (реклама по модели ставки) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_daily_ad (
    cabinet_id BIGINT  NOT NULL,
    nm_id      BIGINT  NOT NULL,
    date       DATE    NOT NULL,
    model      TEXT    NOT NULL,       -- edinaya | ruchnaya | cliki
    views      INTEGER,
    clicks     INTEGER,
    atbs       INTEGER,
    orders     INTEGER,
    spend      DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id, date, model)
);
CREATE INDEX IF NOT EXISTS idx_wb_da_date ON tenant.wb_daily_ad(date);

-- ========== finance_report (отчёт о реализации WB) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_finance_report (
    cabinet_id              BIGINT  NOT NULL,
    rrd_id                  BIGINT  NOT NULL,   -- может быть <0 (ручной импорт)
    realizationreport_id    BIGINT,
    date_from               TEXT,
    date_to                 TEXT,
    rr_dt                   TEXT,               -- дата операции
    nm_id                   BIGINT,
    sa_name                 TEXT,
    subject_name            TEXT,
    supplier_oper_name      TEXT,
    doc_type_name           TEXT,
    bonus_type_name         TEXT,
    quantity                INTEGER,
    retail_price            DOUBLE PRECISION,
    retail_amount           DOUBLE PRECISION,
    retail_price_withdisc_rub DOUBLE PRECISION,
    ppvz_for_pay            DOUBLE PRECISION,
    delivery_rub            DOUBLE PRECISION,
    storage_fee             DOUBLE PRECISION,
    penalty                 DOUBLE PRECISION,
    additional_payment      DOUBLE PRECISION,
    deduction               DOUBLE PRECISION,
    acceptance              DOUBLE PRECISION,
    acquiring_fee           DOUBLE PRECISION,
    ppvz_sales_commission   DOUBLE PRECISION,
    ppvz_vw                 DOUBLE PRECISION,
    return_amount           DOUBLE PRECISION,
    sale_percent            DOUBLE PRECISION,
    commission_percent      DOUBLE PRECISION,
    srid                    TEXT,                  -- id заказа (для order_costs агрегации)
    order_dt                TEXT,                  -- дата заказа (order_dt из report-detail)
    sale_dt                 TEXT,                  -- дата продажи (sale_dt из операции «Продажа»)
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, rrd_id)
);
CREATE INDEX IF NOT EXISTS idx_wb_fin_nm ON tenant.wb_finance_report(nm_id);
CREATE INDEX IF NOT EXISTS idx_wb_fin_dt ON tenant.wb_finance_report(rr_dt);
CREATE INDEX IF NOT EXISTS idx_wb_fin_srid ON tenant.wb_finance_report(srid);

-- ========== daily_stock (остатки по складам) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_daily_stock (
    cabinet_id    BIGINT  NOT NULL,
    nm_id         BIGINT  NOT NULL,
    date          DATE    NOT NULL,
    warehouse     TEXT    NOT NULL,
    quantity      INTEGER,
    quantity_full INTEGER,
    in_way_to     INTEGER,
    in_way_from   INTEGER,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id, date, warehouse)
);
CREATE INDEX IF NOT EXISTS idx_wb_stock_date ON tenant.wb_daily_stock(date);

-- ========== cogs (себестоимость, ручной ввод) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_cogs (
    cabinet_id BIGINT  NOT NULL,
    nm_id      BIGINT  NOT NULL,
    cost       DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id)
);

-- ========== wb_prices (цена продавца ДО скидки) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_prices (
    cabinet_id  BIGINT  NOT NULL,
    nm_id       BIGINT  NOT NULL,
    price_seller DOUBLE PRECISION,
    discount    INTEGER,
    spp_auto    INTEGER,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id)
);

-- ========== orders (сырой фид заказов) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_orders (
    cabinet_id       BIGINT  NOT NULL,
    srid             TEXT    NOT NULL,
    g_number         TEXT,
    order_dt         TEXT,
    last_change_dt   TEXT,
    nm_id            BIGINT,
    supplier_article TEXT,
    barcode          TEXT,
    tech_size        TEXT,
    brand            TEXT,
    category         TEXT,
    subject          TEXT,
    warehouse_name   TEXT,
    warehouse_type   TEXT,
    country_name     TEXT,
    okrug_name       TEXT,
    region_name      TEXT,
    income_id        INTEGER,
    is_cancel        INTEGER,
    cancel_dt        TEXT,
    total_price      DOUBLE PRECISION,
    discount_percent DOUBLE PRECISION,
    price_with_disc  DOUBLE PRECISION,
    finished_price   DOUBLE PRECISION,
    spp              DOUBLE PRECISION,
    sticker          TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, srid)
);
CREATE INDEX IF NOT EXISTS idx_wb_orders_dt ON tenant.wb_orders(order_dt);
CREATE INDEX IF NOT EXISTS idx_wb_orders_region ON tenant.wb_orders(region_name);

-- ========== sales (продажи/возвраты) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_sales (
    cabinet_id       BIGINT  NOT NULL,
    sale_id          TEXT    NOT NULL,   -- 'S…' продажа / 'R…' возврат
    srid             TEXT,
    sale_dt          TEXT,
    last_change_dt   TEXT,
    nm_id            BIGINT,
    supplier_article TEXT,
    barcode          TEXT,
    tech_size        TEXT,
    brand            TEXT,
    category         TEXT,
    subject          TEXT,
    warehouse_name   TEXT,
    warehouse_type   TEXT,
    country_name     TEXT,
    okrug_name       TEXT,
    region_name      TEXT,
    income_id        INTEGER,
    is_realization   INTEGER,
    total_price      DOUBLE PRECISION,
    discount_percent DOUBLE PRECISION,
    price_with_disc  DOUBLE PRECISION,
    finished_price   DOUBLE PRECISION,
    for_pay          DOUBLE PRECISION,
    payment_sale_amount DOUBLE PRECISION,
    spp              DOUBLE PRECISION,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sale_id)
);
CREATE INDEX IF NOT EXISTS idx_wb_sales_dt ON tenant.wb_sales(sale_dt);

-- ========== order_costs (прибыль по заказу) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_order_costs (
    cabinet_id       BIGINT  NOT NULL,
    srid             TEXT    NOT NULL,
    nm_id            BIGINT,
    sa_name          TEXT,
    is_return        INTEGER,
    return_dt        TEXT,
    self_buyout      INTEGER,
    order_dt         TEXT,
    sale_dt          TEXT,
    cost_value_total DOUBLE PRECISION,
    cost_value_retail DOUBLE PRECISION,
    cost_value_pay   DOUBLE PRECISION,
    commission       DOUBLE PRECISION,
    acquiring        DOUBLE PRECISION,
    logistics        DOUBLE PRECISION,
    loyalty          DOUBLE PRECISION,
    cost             DOUBLE PRECISION,
    profit           DOUBLE PRECISION,
    profit_alt       DOUBLE PRECISION,
    qty              INTEGER,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, srid)
);
CREATE INDEX IF NOT EXISTS idx_wb_oc_dt ON tenant.wb_order_costs(sale_dt);

-- ========== per_sku_costs (расходы по SKU) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_per_sku_costs (
    cabinet_id        BIGINT  NOT NULL,
    nm_id             BIGINT  NOT NULL,
    period_from       DATE    NOT NULL,
    period_to         DATE    NOT NULL,
    penalty           DOUBLE PRECISION DEFAULT 0,
    logistics_correction DOUBLE PRECISION DEFAULT 0,
    loyalty_correction DOUBLE PRECISION DEFAULT 0,
    voluntary_comp    DOUBLE PRECISION DEFAULT 0,
    other             DOUBLE PRECISION DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id, period_from, period_to)
);

-- ========== cabinet_costs (кабинетные расходы, без привязки к SKU) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_cabinet_costs (
    cabinet_id  BIGINT  NOT NULL,
    cost_type   TEXT    NOT NULL,
    period_from DATE    NOT NULL,
    period_to   DATE    NOT NULL,
    amount      DOUBLE PRECISION DEFAULT 0,
    detail      TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, cost_type, period_from, period_to)
);

-- ========== metrics_30m (30-мин снапшоты воронки) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_metrics_30m (
    cabinet_id BIGINT  NOT NULL,
    nm_id      BIGINT  NOT NULL,
    date       DATE    NOT NULL,
    ts         TEXT    NOT NULL,
    clicks     INTEGER,
    cart       INTEGER,
    orders     INTEGER,
    order_sum  DOUBLE PRECISION,
    favorites  INTEGER,
    buyouts    INTEGER,
    cancels    INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_wb_m30m_date ON tenant.wb_metrics_30m(date);

-- ========== cards_glue (склейки карточек) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_cards_glue (
    cabinet_id   BIGINT  NOT NULL,
    nm_id        BIGINT  NOT NULL,
    imt_id       BIGINT  NOT NULL,
    imt_nm_count INTEGER,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id)
);

-- ========== feedback_summary / feedback_history ==========
CREATE TABLE IF NOT EXISTS tenant.wb_feedback_summary (
    cabinet_id       BIGINT  NOT NULL,
    scope            TEXT    NOT NULL,   -- nm | imt
    key_id           BIGINT  NOT NULL,
    rating           DOUBLE PRECISION,
    feedbacks_count  INTEGER,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, scope, key_id)
);
CREATE TABLE IF NOT EXISTS tenant.wb_feedback_history (
    cabinet_id       BIGINT  NOT NULL,
    scope            TEXT    NOT NULL,
    key_id           BIGINT  NOT NULL,
    date             DATE    NOT NULL,
    rating           DOUBLE PRECISION,
    feedbacks_count  INTEGER,
    PRIMARY KEY (cabinet_id, scope, key_id, date)
);

-- ========== feedbacks (полные тексты отзывов + workflow) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_feedbacks (
    cabinet_id       BIGINT  NOT NULL,
    id               TEXT    NOT NULL,
    nm_id            BIGINT,
    imt_id           BIGINT,
    rating           INTEGER,
    text             TEXT,
    author           TEXT,
    created_at       TEXT,
    was_answered     INTEGER DEFAULT 0,
    wb_answer        TEXT,
    product          TEXT,
    marketplace      TEXT DEFAULT 'wb',
    status           TEXT DEFAULT 'new',
    draft_reply      TEXT,
    replied_at       TEXT,
    moderation_state TEXT,
    is_hidden        INTEGER DEFAULT 0,
    was_viewed       INTEGER DEFAULT 0,
    published_at     TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS idx_wb_fb_status ON tenant.wb_feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_wb_fb_rating ON tenant.wb_feedbacks(rating, created_at);

-- ========== questions (вопросы покупателей) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_questions (
    cabinet_id       BIGINT  NOT NULL,
    id               TEXT    NOT NULL,
    marketplace      TEXT DEFAULT 'wb',
    nm_id            BIGINT,
    imt_id           BIGINT,
    text             TEXT,
    author           TEXT,
    created_at       TEXT,
    was_answered     INTEGER DEFAULT 0,
    mp_answer        TEXT,
    answer_editable  INTEGER DEFAULT 0,
    product          TEXT,
    moderation_state TEXT,
    is_warned        INTEGER DEFAULT 0,
    is_hidden        INTEGER DEFAULT 0,
    was_viewed       INTEGER DEFAULT 0,
    status           TEXT DEFAULT 'new',
    draft_reply      TEXT,
    replied_at       TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- ========== item_keywords (позиции по ключам MPStats) ==========
CREATE TABLE IF NOT EXISTS tenant.wb_item_keywords (
    cabinet_id BIGINT  NOT NULL,
    nm_id      BIGINT  NOT NULL,
    date       DATE    NOT NULL,
    keyword    TEXT    NOT NULL,
    position   INTEGER,
    is_ad      INTEGER DEFAULT 0,
    traffic    INTEGER,
    PRIMARY KEY (cabinet_id, nm_id, date, keyword)
);

-- =====================================================================
--  RLS: одна политика для всех wb-таблиц (по app.cabinet_id).
--  PG 16: CREATE POLICY без IF NOT EXISTS → DO-блок с проверкой.
-- =====================================================================
DO $$
DECLARE
    t TEXT;
    wb_tables TEXT[] := ARRAY[
        'wb_articles','wb_daily_metrics','wb_daily_ad','wb_finance_report',
        'wb_daily_stock','wb_cogs','wb_prices','wb_orders','wb_sales',
        'wb_order_costs','wb_per_sku_costs','wb_cabinet_costs','wb_metrics_30m',
        'wb_cards_glue','wb_feedback_summary','wb_feedback_history',
        'wb_feedbacks','wb_questions','wb_item_keywords'
    ];
BEGIN
    FOREACH t IN ARRAY wb_tables LOOP
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

-- Права saas_app на все wb-таблицы + секвенции (RLS срежет не-своё).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenant TO saas_app;
