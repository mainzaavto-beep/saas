-- =====================================================================
--  SaaS, Этап 8: notifications (оповещения) → PostgreSQL.
--  Перенос таблицы notifications из agent_memory.db (SQLite) в PG с RLS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS tenant.notifications (
    cabinet_id  BIGINT  NOT NULL,
    id          BIGSERIAL,
    ts          TEXT    NOT NULL,
    level       TEXT    NOT NULL DEFAULT 'warn',   -- crit | warn | info
    source      TEXT,
    category    TEXT,
    title       TEXT,
    message     TEXT,
    ref         TEXT,
    read        INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON tenant.notifications(cabinet_id, read);

DO $$
BEGIN
  ALTER TABLE tenant.notifications ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_notifications') THEN
    CREATE POLICY tenant_iso_notifications ON tenant.notifications FOR ALL TO saas_app
      USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
      WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.notifications TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.notifications_id_seq TO saas_app;
