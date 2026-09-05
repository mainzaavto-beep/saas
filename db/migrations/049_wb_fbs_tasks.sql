-- 049_wb_fbs_tasks.sql — связка FBS-задание ↔ поставка WB («время до покупателя»,
-- запрос владельца 05.09.2026). rid ленты /api/v3/orders == srid статистики
-- (проба 05.09: 201/223 совпали) — через него выкуп из wb_sales.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.wb_fbs_tasks (
    cabinet_id BIGINT NOT NULL,
    rid        TEXT   NOT NULL,   -- == wb_orders.srid / wb_sales.srid
    supply_id  TEXT,              -- WB-GI-…; NULL пока задание не в поставке
    created_at TIMESTAMPTZ,
    nm_id      BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, rid)
);
CREATE INDEX IF NOT EXISTS wb_fbs_tasks_supply_idx ON tenant.wb_fbs_tasks (cabinet_id, supply_id);

ALTER TABLE tenant.wb_fbs_tasks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='wb_fbs_tasks' AND policyname='tenant_iso_wb_fbs_tasks') THEN
        CREATE POLICY tenant_iso_wb_fbs_tasks ON tenant.wb_fbs_tasks
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='wb_fbs_tasks' AND policyname='panel_local_ro_cab1') THEN
        CREATE POLICY panel_local_ro_cab1 ON tenant.wb_fbs_tasks
        FOR SELECT TO panel_local_ro
        USING (cabinet_id = 1);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.wb_fbs_tasks TO saas_app;
GRANT SELECT ON tenant.wb_fbs_tasks TO panel_local_ro;

COMMIT;
