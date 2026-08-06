-- 033: подтверждение email, серверная инвалидация сессий, одноразовые токены.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 1;

-- Существующие пользователи (регистрировались до фазы 3) считаются подтверждёнными.
-- Условие по дате делает повторный прогон миграции безопасным: новых
-- неподтверждённых пользователей backfill не тронет.
UPDATE auth.users
   SET email_verified_at = created_at
 WHERE email_verified_at IS NULL
   AND created_at < timestamptz '2026-08-07 00:00:00+03';

-- Одноразовые токены. В БД только SHA-256 от токена: сам токен живёт в письме.
CREATE TABLE IF NOT EXISTS auth.user_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES auth.users(user_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_tokens_live_idx
  ON auth.user_tokens (user_id, kind) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON auth.user_tokens TO saas_app;
