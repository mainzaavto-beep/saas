-- =====================================================================
--  SaaS, Этап 6: управление товарами (себестоимость с историей, группы,
--  статусы) + what-if прикидка юнит-экономики.
--  Перенос таблиц fin_data.db (cost_overrides/item_groups/item_status/
--  item_group_members) + unit_inputs.db в PostgreSQL (схема tenant).
--
--  Принципы (как в 002/003): cabinet_id первая колонка PK; RLS по
--  app.cabinet_id; идемпотентно (CREATE ... IF NOT EXISTS).
--  Отличие от эталона: item_groups теперь per-cabinet (в эталоне глобальная),
--  что правильно для мультитенантности — группы продавца изолированы.
-- =====================================================================

-- ========== cost_overrides (история себестоимости с датой начала) ==========
CREATE TABLE IF NOT EXISTS tenant.cost_overrides (
    cabinet_id     BIGINT  NOT NULL,
    id             BIGSERIAL,
    platform       TEXT    NOT NULL,            -- 'wb' | 'ozon'
    nm_id          BIGINT  NOT NULL DEFAULT 0,  -- WB: ID товара; Ozon = 0
    product_id     BIGINT  NOT NULL DEFAULT 0,  -- Ozon: ID товара; WB = 0
    cost           NUMERIC(14,2) NOT NULL,
    effective_from DATE    NOT NULL,            -- дата начала действия
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, platform, nm_id, product_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_cost_overrides_sku
    ON tenant.cost_overrides(cabinet_id, platform, nm_id, product_id);

-- ========== item_groups (группы товаров, per-cabinet) ==========
CREATE TABLE IF NOT EXISTS tenant.item_groups (
    cabinet_id  BIGINT  NOT NULL,
    id          BIGINT  NOT NULL,
    name        TEXT    NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, name)
);

-- ========== item_group_members (какие SKU в каких группах) ==========
CREATE TABLE IF NOT EXISTS tenant.item_group_members (
    cabinet_id  BIGINT  NOT NULL,
    platform    TEXT    NOT NULL,
    nm_id       BIGINT  NOT NULL DEFAULT 0,
    product_id  BIGINT  NOT NULL DEFAULT 0,
    group_id    BIGINT  NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, platform, nm_id, product_id),
    FOREIGN KEY (cabinet_id, group_id) REFERENCES tenant.item_groups(cabinet_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_igm_group ON tenant.item_group_members(cabinet_id, group_id);

-- ========== item_status (active/inactive per SKU) ==========
CREATE TABLE IF NOT EXISTS tenant.item_status (
    cabinet_id  BIGINT  NOT NULL,
    id          BIGSERIAL,
    platform    TEXT    NOT NULL,
    nm_id       BIGINT  NOT NULL DEFAULT 0,
    product_id  BIGINT  NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'active',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, platform, nm_id, product_id)
);

-- ========== unit_inputs (what-if прикидка, перебивка авто-слоя) ==========
CREATE TABLE IF NOT EXISTS tenant.unit_inputs (
    cabinet_id  BIGINT  NOT NULL,
    platform    TEXT    NOT NULL,
    sku         TEXT    NOT NULL,           -- nm_id/product_id как строка
    key         TEXT    NOT NULL,           -- 'spp','cost','defectRate',...
    value       NUMERIC(14,4),              -- nullable (сброс = NULL)
    note        TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, platform, sku, key)
);

-- =====================================================================
--  RLS: одна политика для всех 5 таблиц (по app.cabinet_id).
-- =====================================================================
DO $$
DECLARE
    t TEXT;
    new_tables TEXT[] := ARRAY[
        'cost_overrides','item_groups','item_group_members','item_status','unit_inputs'
    ];
BEGIN
    FOREACH t IN ARRAY new_tables LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE ON
    tenant.cost_overrides, tenant.item_groups, tenant.item_group_members,
    tenant.item_status, tenant.unit_inputs TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE
    tenant.cost_overrides_id_seq, tenant.item_status_id_seq TO saas_app;

COMMENT ON TABLE tenant.cost_overrides IS 'История себестоимости per-SKU с датой начала (effective_from). Замена fin_data.db/cost_overrides (2026-07-12).';
COMMENT ON TABLE tenant.item_groups  IS 'Группы товаров per-cabinet. Замена fin_data.db/item_groups (2026-07-12).';
COMMENT ON TABLE tenant.item_status  IS 'Статус товара (active/inactive) per-SKU. Замена fin_data.db/item_status (2026-07-12).';
COMMENT ON TABLE tenant.unit_inputs  IS 'What-if прикидка юнит-экономики: перебивка авто-слоя. Замена unit_inputs.db (2026-07-12).';
