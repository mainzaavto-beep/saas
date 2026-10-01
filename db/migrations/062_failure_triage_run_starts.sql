-- 062_failure_triage_run_starts.sql — список моментов запуска claude по эпизоду, чтобы
-- суточный бюджет считал ЗАПУСКИ claude (включая повторы одного эпизода), а не эпизоды
-- (ревью task-9 раунд 1, 01.10.2026: один эпизод с 3 попытками раньше занимал 1 слот
-- из «≤3 эпизода/сутки» вместо честных 3 запусков). Идемпотентно.
BEGIN;
ALTER TABLE jobs.failure_triage ADD COLUMN IF NOT EXISTS run_starts TIMESTAMPTZ[] NOT NULL DEFAULT '{}';
COMMIT;
