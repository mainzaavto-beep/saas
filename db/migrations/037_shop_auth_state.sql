-- 037: состояние ключей магазина. Нужно, чтобы магазин со сломанной
-- авторизацией вставал на паузу и не тратил окно прогона на бесполезные
-- запросы (кабинет 1009 с конца июля даёт 6 отказов Ozon 403 каждый прогон).
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_state TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_fail_count INT NOT NULL DEFAULT 0;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_failed_at TIMESTAMPTZ;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_last_error TEXT;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_notified_at TIMESTAMPTZ;

ALTER TABLE auth.shops DROP CONSTRAINT IF EXISTS shops_auth_state_check;
ALTER TABLE auth.shops ADD CONSTRAINT shops_auth_state_check
  CHECK (auth_state IN ('ok','failing','paused'));
