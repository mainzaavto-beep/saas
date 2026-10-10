-- 064_bonus.sql — премия менеджеров площадок (спека 2026-10-08 «Менеджеры и премия»).
-- bonus_employees — кто в программе (площадка, оклад, % бонуса, порог);
-- bonus_plans — план месяца (продажи, прибыль) на сотрудника, правит только владелец;
-- bonus_exclusions — исключённые артикулы месяца + снятая доля плана;
-- bonus_closings — зафиксированные месяцы: снимок входов и результата (JSONB).
-- user_id — auth.users.user_id (FK не ставим: tenant ↔ auth живут раздельно, как везде). Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.bonus_employees (
    cabinet_id  BIGINT  NOT NULL,
    user_id     BIGINT  NOT NULL,
    platform    TEXT    NOT NULL CHECK (platform IN ('wb','ozon')),
    salary      NUMERIC(14,2) NOT NULL DEFAULT 40000,
    bonus_pct   NUMERIC(6,4)  NOT NULL DEFAULT 0.04,
    threshold   NUMERIC(6,4)  NOT NULL DEFAULT 0.65,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, user_id)
);

CREATE TABLE IF NOT EXISTS tenant.bonus_plans (
    cabinet_id  BIGINT NOT NULL,
    user_id     BIGINT NOT NULL,
    period      TEXT   NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    sales_plan  NUMERIC(14,2) NOT NULL DEFAULT 0,
    profit_plan NUMERIC(14,2) NOT NULL DEFAULT 0,
    updated_by  BIGINT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, user_id, period)
);

CREATE TABLE IF NOT EXISTS tenant.bonus_exclusions (
    cabinet_id      BIGINT NOT NULL,
    id              BIGSERIAL,
    user_id         BIGINT NOT NULL,
    period          TEXT   NOT NULL,
    sku_key         BIGINT NOT NULL,          -- WB nm_id / Ozon product_id (по площадке сотрудника)
    sales_plan_off  NUMERIC(14,2) NOT NULL DEFAULT 0,
    profit_plan_off NUMERIC(14,2) NOT NULL DEFAULT 0,
    reason          TEXT NOT NULL,
    created_by      BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, user_id, period, sku_key)
);

CREATE TABLE IF NOT EXISTS tenant.bonus_closings (
    cabinet_id  BIGINT NOT NULL,
    user_id     BIGINT NOT NULL,
    period      TEXT   NOT NULL,
    snapshot    JSONB  NOT NULL,
    closed_by   BIGINT,
    closed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, user_id, period)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bonus_employees','bonus_plans','bonus_exclusions','bonus_closings'] LOOP
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
  GRANT USAGE, SELECT ON SEQUENCE tenant.bonus_exclusions_id_seq TO saas_app;
END $$;

COMMIT;
