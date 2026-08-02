-- 031_collector_runs.sql
-- Журнал прогонов сборщиков (спек docs/superpowers/specs/2026-08-02-worker-alerting-design.md).
-- Пишут: orchestrator.py (под postgres) и worker/record_failure.py (OnFailure-хук systemd).
-- Читает: /api/health (saas_app, без-тенантный query()).
-- Без RLS: операторские данные; доступ ограничен allowlist'ом SAAS_OPS_USER_IDS в API.
-- cabinet_id NULL = запись уровня systemd-юнита (прогон умер целиком).
-- Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS jobs.collector_runs (
    id           BIGSERIAL PRIMARY KEY,
    cabinet_id   BIGINT,
    collector    TEXT NOT NULL,      -- 'wb_finance' | ... | 'unit:saas-worker.service' | '_cabinet'
    run_kind     TEXT NOT NULL CHECK (run_kind IN
                 ('main','stocks','metrics30m','references','backfill','systemd','manual')),
    date_from    DATE,               -- окно сбора (NULL для snapshot-сборщиков и unit-записей)
    date_to      DATE,
    status       TEXT NOT NULL CHECK (status IN
                 ('ok','partial','failed','timeout','no_token','skipped')),
    rows_written INTEGER,            -- задел на будущее (пока NULL всегда)
    error        TEXT,               -- последняя строка stderr / причина skip
    started_at   TIMESTAMPTZ NOT NULL,
    finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS collector_runs_coll_fin ON jobs.collector_runs (collector, finished_at DESC);
CREATE INDEX IF NOT EXISTS collector_runs_status   ON jobs.collector_runs (status);

GRANT USAGE  ON SCHEMA jobs TO saas_app;
GRANT SELECT ON jobs.collector_runs TO saas_app;

COMMIT;
