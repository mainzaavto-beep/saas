-- 061_failure_triage_attempts.sql — счётчик попыток разбора (повтор при сбое claude,
-- решение 01.10.2026: до 3 попыток, не чаще раза в час). Идемпотентно.
BEGIN;
ALTER TABLE jobs.failure_triage ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
COMMIT;
