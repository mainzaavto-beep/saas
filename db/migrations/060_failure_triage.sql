-- 060_failure_triage.sql — эпизоды авторазбора падений сборщиков
-- (спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §3).
-- Пишет: worker/failure_triage.py (под postgres). Читает: /api/health и
-- scripts/notify-triage.mjs (saas_app; последний ещё ставит notified_at), saas_ro.
-- Без RLS: операторские данные, как jobs.collector_runs. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS jobs.failure_triage (
    id                 BIGSERIAL PRIMARY KEY,
    collector          TEXT NOT NULL,          -- имя сборщика или 'unit:<юнит>'
    cabinet_id         BIGINT,                 -- NULL для unit:*
    status             TEXT NOT NULL CHECK (status IN ('queued','running','done','error','closed')),
    opened_at          TIMESTAMPTZ NOT NULL,   -- started_at первого падения серии
    last_failed_run_id BIGINT,
    closed_at          TIMESTAMPTZ,
    started_at         TIMESTAMPTZ,            -- начало разбора
    finished_at        TIMESTAMPTZ,
    summary            TEXT,
    cause              TEXT,
    confidence         TEXT,
    urgent             BOOLEAN,
    report_json        JSONB,
    raw_output         TEXT,
    notified_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS failure_triage_open_uq
    ON jobs.failure_triage (collector, (COALESCE(cabinet_id, 0)))
    WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS failure_triage_started ON jobs.failure_triage (started_at);

GRANT SELECT ON jobs.failure_triage TO saas_app;
GRANT UPDATE (notified_at) ON jobs.failure_triage TO saas_app;
GRANT SELECT ON jobs.failure_triage TO saas_ro;

COMMIT;
