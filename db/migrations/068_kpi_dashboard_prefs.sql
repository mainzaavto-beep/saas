-- 068_kpi_dashboard_prefs.sql — «Дашборд показателей» (15.10.2026): личная настройка плиток
-- (порядок, скрытые, добавленные из каталога) — своя у каждого пользователя кабинета.
-- layout = {order:[tileKey…], hidden:[…], extra:[…]}; неизвестные ключи панель отбрасывает
-- при чтении (lib/kpiDashboard.js normalizeLayout). Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.kpi_dashboard_prefs (
    cabinet_id  BIGINT      NOT NULL,
    user_id     BIGINT      NOT NULL,
    layout      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, user_id)
);

DO $$
DECLARE t TEXT := 'kpi_dashboard_prefs';
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
