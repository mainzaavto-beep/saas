-- =====================================================================
--  SaaS, Этап 22: support_chat — чат поддержки (per-cabinet, с RLS).
--
--  Поток: клиент пишет → AI (glm-5.2) отвечает первым → при запросе
--  человека/AI-ошибке тред эскалируется (status='escalated').
--  Polling подбирает новые сообщения (GET ?since=<id>).
--
--  Один активный тред на cabinet (создаётся автоматически при первом
--  обращении). Сообщения: role='user' (клиент) | 'assistant' (AI/поддержка).
-- =====================================================================

CREATE TABLE IF NOT EXISTS tenant.support_threads (
    cabinet_id  BIGINT  NOT NULL,
    id          BIGSERIAL,
    user_id     BIGINT,                     -- кто создал/обновлял последним
    user_name   TEXT,
    status      TEXT     NOT NULL DEFAULT 'ai',  -- ai | escalated | closed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS idx_support_threads_status ON tenant.support_threads(cabinet_id, status);

CREATE TABLE IF NOT EXISTS tenant.support_messages (
    cabinet_id  BIGINT  NOT NULL,
    id          BIGSERIAL,
    thread_id   BIGINT  NOT NULL,
    role        TEXT    NOT NULL,           -- user | assistant
    content     TEXT    NOT NULL,
    by_ai       BOOLEAN NOT NULL DEFAULT false,  -- true = ответ AI, false = ответ оператора
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON tenant.support_messages(cabinet_id, thread_id, id);

DO $$
BEGIN
  ALTER TABLE tenant.support_threads ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_support_threads') THEN
    CREATE POLICY tenant_iso_support_threads ON tenant.support_threads FOR ALL TO saas_app
      USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
      WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
  END IF;

  ALTER TABLE tenant.support_messages ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_support_messages') THEN
    CREATE POLICY tenant_iso_support_messages ON tenant.support_messages FOR ALL TO saas_app
      USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
      WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.support_threads TO saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.support_messages TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.support_threads_id_seq TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.support_messages_id_seq TO saas_app;
