-- =====================================================================
--  SaaS, Этап 9: финансовые таблицы fin_data.db → PostgreSQL.
--  dds_movements, balance_*, bank_transactions, sales_plan, plan_targets,
--  opex, purchases, purchase_plan, purchase_payments, self_buyouts.
--  Все с cabinet_id + RLS. Данные: 1-52 строк на таблицу (старт).
-- =====================================================================

-- ========== dds_movements (движение денежных средств) ==========
CREATE TABLE IF NOT EXISTS tenant.dds_movements (
    cabinet_id   BIGINT NOT NULL,
    id           BIGSERIAL,
    date         TEXT NOT NULL,
    type         TEXT NOT NULL,
    amount       NUMERIC(14,2) NOT NULL,
    category     TEXT,
    counterparty TEXT,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'paid',
    platform     TEXT,
    nm_id        BIGINT,
    income_type  TEXT,
    account_from TEXT,
    account_to   TEXT,
    source       TEXT NOT NULL DEFAULT 'manual',
    reference    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ,
    PRIMARY KEY (cabinet_id, id)
);

-- ========== balance_accounts (баланс по счетам) ==========
CREATE TABLE IF NOT EXISTS tenant.balance_accounts (
    cabinet_id   BIGINT NOT NULL,
    id           BIGSERIAL,
    as_of_date   TEXT NOT NULL,
    subject      TEXT NOT NULL,
    account_name TEXT NOT NULL,
    amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, as_of_date, subject, account_name)
);

-- ========== balance_snapshot (снапшот баланса) ==========
CREATE TABLE IF NOT EXISTS tenant.balance_snapshot (
    cabinet_id        BIGINT NOT NULL,
    id                BIGSERIAL,
    as_of_date        TEXT NOT NULL,
    cash_on_hand      NUMERIC(14,2) DEFAULT 0,
    mp_balance        NUMERIC(14,2) DEFAULT 0,
    stock_value       NUMERIC(14,2) DEFAULT 0,
    stock_in_transit  NUMERIC(14,2) DEFAULT 0,
    receivables       NUMERIC(14,2) DEFAULT 0,
    other_assets      NUMERIC(14,2) DEFAULT 0,
    payables          NUMERIC(14,2) DEFAULT 0,
    loans             NUMERIC(14,2) DEFAULT 0,
    owner_equity      NUMERIC(14,2) DEFAULT 0,
    retained_earnings NUMERIC(14,2) DEFAULT 0,
    other_liabilities NUMERIC(14,2) DEFAULT 0,
    ff_stock          NUMERIC(14,2) DEFAULT 0,
    note              TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, as_of_date)
);

-- ========== bank_transactions (календарь платежей) ==========
CREATE TABLE IF NOT EXISTS tenant.bank_transactions (
    cabinet_id   BIGINT NOT NULL,
    id           BIGSERIAL,
    date         TEXT NOT NULL,
    type         TEXT NOT NULL,
    amount       NUMERIC(14,2) NOT NULL,
    currency     TEXT DEFAULT 'RUB',
    category     TEXT,
    counterparty TEXT,
    status       TEXT DEFAULT 'paid',
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- ========== sales_plan (план продаж) ==========
CREATE TABLE IF NOT EXISTS tenant.sales_plan (
    cabinet_id      BIGINT NOT NULL,
    id              BIGSERIAL,
    period          TEXT NOT NULL,
    platform        TEXT NOT NULL,
    nm_id           BIGINT,
    product_id      BIGINT,
    sku_label       TEXT NOT NULL,
    category        TEXT,
    qty_plan        INTEGER DEFAULT 0,
    buyout_rate_plan NUMERIC(6,4),
    revenue_plan    NUMERIC(14,2) DEFAULT 0,
    drr_plan        NUMERIC(6,4) DEFAULT 0,
    margin_plan_pct NUMERIC(6,4) DEFAULT 0,
    price_no_spp    NUMERIC(14,2),
    cost_plan       NUMERIC(14,2),
    launch_date     TEXT,
    is_new_sku      INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'active',
    approved        INTEGER DEFAULT 0,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- ========== plan_targets (целевые показатели) ==========
CREATE TABLE IF NOT EXISTS tenant.plan_targets (
    cabinet_id        BIGINT NOT NULL,
    target_period     TEXT NOT NULL,
    platform          TEXT NOT NULL,
    revenue_target    NUMERIC(14,2) DEFAULT 0,
    margin_target_pct NUMERIC(6,4) DEFAULT 0,
    profit_target     NUMERIC(14,2) DEFAULT 0,
    drr_target        NUMERIC(6,4) DEFAULT 0,
    note              TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, target_period, platform)
);

-- ========== opex (сопутствующие расходы) ==========
CREATE TABLE IF NOT EXISTS tenant.opex (
    cabinet_id     BIGINT NOT NULL,
    id             BIGSERIAL,
    period         TEXT NOT NULL,
    category       TEXT NOT NULL,
    amount         NUMERIC(14,2) NOT NULL,
    note           TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    counterparty   TEXT,
    op_date        TEXT,
    domain         TEXT NOT NULL DEFAULT 'business',
    source         TEXT NOT NULL DEFAULT 'manual',
    included_in_cogs INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ,
    PRIMARY KEY (cabinet_id, id)
);

-- ========== purchases (закупки) ==========
CREATE TABLE IF NOT EXISTS tenant.purchases (
    cabinet_id        BIGINT NOT NULL,
    id                BIGSERIAL,
    nm_id             BIGINT,
    qty               INTEGER NOT NULL,
    unit_cost         NUMERIC(14,2),
    inbound_logistics NUMERIC(14,2) DEFAULT 0,
    date              TEXT,
    supplier          TEXT,
    supplier_name     TEXT,
    paid              INTEGER DEFAULT 1,
    note              TEXT,
    order_dt          TEXT,
    delivery_dt       TEXT,
    ship_dt           TEXT,
    status            TEXT,
    lifecycle_status  TEXT,
    source            TEXT,
    source_country    TEXT,
    order_no          TEXT,
    total_amount      NUMERIC(14,2),
    unit_cost_yuan    NUMERIC(14,2),
    unit_cost_est     NUMERIC(14,2),
    exchange_rate     NUMERIC(14,4),
    logistics_yuan    NUMERIC(14,2),
    logistics_rub     NUMERIC(14,2),
    logistics_rub_per_unit NUMERIC(14,2),
    prepay_yuan       NUMERIC(14,2),
    prepay_rate       NUMERIC(14,4),
    plan_order_dt     TEXT,
    plan_ship_dt      TEXT,
    plan_arrival_dt   TEXT,
    pay_status        TEXT DEFAULT 'none',
    photo_url         TEXT,
    deleted_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- ========== purchase_plan (план закупок) ==========
CREATE TABLE IF NOT EXISTS tenant.purchase_plan (
    cabinet_id BIGINT NOT NULL,
    id         BIGSERIAL,
    week       TEXT NOT NULL,
    nm_id      BIGINT NOT NULL,
    type       TEXT NOT NULL,
    amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    qty        INTEGER,
    note       TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, week, nm_id, type)
);

-- ========== purchase_payments (платежи по закупкам) ==========
CREATE TABLE IF NOT EXISTS tenant.purchase_payments (
    cabinet_id  BIGINT NOT NULL,
    id          BIGSERIAL,
    purchase_id BIGINT NOT NULL,
    due_dt      TEXT NOT NULL,
    paid_dt     TEXT,
    amount      NUMERIC(14,2) NOT NULL,
    ratio       NUMERIC(6,4),
    status      TEXT NOT NULL DEFAULT 'planned',
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ,
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, purchase_id) REFERENCES tenant.purchases(cabinet_id, id) ON DELETE CASCADE
);

-- ========== self_buyouts (самовыкупы) ==========
CREATE TABLE IF NOT EXISTS tenant.self_buyouts (
    cabinet_id       BIGINT NOT NULL,
    id               BIGSERIAL,
    claim_dt         TEXT,
    nm_id            BIGINT,
    seller_article   TEXT,
    qty              INTEGER NOT NULL,
    price            NUMERIC(14,2),
    wb_discount      NUMERIC(6,4),
    spp              NUMERIC(6,4),
    commission_pct   NUMERIC(6,4),
    constructor_pct  NUMERIC(6,4),
    logistics_unit   NUMERIC(14,2),
    buyout_price     NUMERIC(14,2),
    tax_pct          NUMERIC(6,4),
    total            NUMERIC(14,2),
    source           TEXT DEFAULT 'manual',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- ========== RLS для всех ==========
DO $$
DECLARE
    t TEXT;
    fin_tables TEXT[] := ARRAY[
        'dds_movements','balance_accounts','balance_snapshot','bank_transactions',
        'sales_plan','plan_targets','opex','purchases','purchase_plan',
        'purchase_payments','self_buyouts'
    ];
BEGIN
    FOREACH t IN ARRAY fin_tables LOOP
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
    tenant.dds_movements, tenant.balance_accounts, tenant.balance_snapshot,
    tenant.bank_transactions, tenant.sales_plan, tenant.plan_targets,
    tenant.opex, tenant.purchases, tenant.purchase_plan,
    tenant.purchase_payments, tenant.self_buyouts TO saas_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA tenant TO saas_app;
