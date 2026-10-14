-- 067_order_matrix_hidden.sql — «Матрица заказов» (14.10.2026): артикулы, скрытые владельцем
-- или менеджером на этой странице. Свой список: на юнитку/сводку/потребность не влияет
-- (там — tenant.item_status). sku_key = nm_id (WB) / product_id (Ozon). Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.order_matrix_hidden (
    cabinet_id  BIGINT      NOT NULL,
    platform    TEXT        NOT NULL CHECK (platform IN ('wb','ozon')),
    sku_key     BIGINT      NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, platform, sku_key)
);

DO $$
DECLARE t TEXT := 'order_matrix_hidden';
BEGIN
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
END $$;

COMMIT;
