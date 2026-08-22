-- 044: наблюдаемость воркера (спека 2026-08-21, одобрена владельцем).
-- 1) eff_date_from/eff_date_to — ФАКТИЧЕСКОЕ окно прогона сборщика из
--    ##OBS-маркера stdout (date_from/date_to остаются CLI-окном «что просили»);
-- 2) статус 'blocked' в jobs.collector_runs — контрольные попытки паузы ключей
--    больше не пишутся как failed (шум, неотличимый от реальных сбоев);
-- 3) auth_state 'disabled' — перманентно битые ключи: после
--    SAAS_AUTH_DISABLE_AFTER суточных контрольных отказов попытки прекращаются.
-- Идемпотентна (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS + ADD).
BEGIN;

ALTER TABLE jobs.collector_runs ADD COLUMN IF NOT EXISTS eff_date_from DATE;
ALTER TABLE jobs.collector_runs ADD COLUMN IF NOT EXISTS eff_date_to DATE;

ALTER TABLE jobs.collector_runs DROP CONSTRAINT IF EXISTS collector_runs_status_check;
ALTER TABLE jobs.collector_runs ADD CONSTRAINT collector_runs_status_check
    CHECK (status IN ('ok','partial','failed','timeout','no_token','skipped','blocked'));

ALTER TABLE auth.shops DROP CONSTRAINT IF EXISTS shops_auth_state_check;
ALTER TABLE auth.shops ADD CONSTRAINT shops_auth_state_check
    CHECK (auth_state IN ('ok','failing','paused','disabled'));

COMMIT;
