-- =====================================================================
--  SaaS, Этап 10: профиль пользователя, магазины (shops), приглашения.
--
--  1. auth.users — поля профиля (ФИО, телефон)
--  2. auth.shops — магазины проекта (несколько МП, разные юрлица)
--  3. auth.invitations — приглашения сотрудников по ссылке
-- =====================================================================

-- ========== 1. users — поля профиля ==========
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS patronymic TEXT;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Backfill: существующее name → first_name (если first_name пуст).
UPDATE auth.users SET first_name = name WHERE first_name IS NULL AND name IS NOT NULL;

-- ========== 2. shops — магазины проекта ==========
-- Замена cabinet_marketplaces: один проект → много магазинов,
-- каждый магазин = один кабинет МП. Может быть несколько одного МП
-- (разные ИП/ООО). api_creds_enc — шифрованные ключи (pgcrypto).
CREATE TABLE IF NOT EXISTS auth.shops (
    shop_id      BIGSERIAL PRIMARY KEY,
    cabinet_id   BIGINT NOT NULL REFERENCES auth.cabinets(cabinet_id) ON DELETE CASCADE,
    mp_code      TEXT NOT NULL,           -- wb|ozon|ya|avito
    shop_name    TEXT,                    -- "ИП Матвеев WB"
    legal_name   TEXT,                    -- ИП/ООО (разные юрлица)
    api_creds    JSONB DEFAULT '{}',      -- метаданные (has_token и т.д.)
    api_creds_enc TEXT,                   -- шифрованные ключи
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shops_cabinet ON auth.shops(cabinet_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.shops TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE auth.shops_shop_id_seq TO saas_app;

-- Миграция существующих cabinet_marketplaces → shops.
-- Проверим есть ли данные.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.cabinet_marketplaces LIMIT 1) THEN
    INSERT INTO auth.shops (cabinet_id, mp_code, shop_name, created_at)
    SELECT cabinet_id, mp_code, shop_name, created_at
    FROM auth.cabinet_marketplaces
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- ========== 3. invitations — приглашения по ссылке ==========
CREATE TABLE IF NOT EXISTS auth.invitations (
    token        TEXT PRIMARY KEY,        -- uuid
    cabinet_id   BIGINT NOT NULL REFERENCES auth.cabinets(cabinet_id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('manager','viewer')),
    email        TEXT,                    -- опционально (кому приглашение)
    created_by   BIGINT NOT NULL REFERENCES auth.users(user_id),
    accepted_by  BIGINT REFERENCES auth.users(user_id),
    accepted_at  TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invitations_cabinet ON auth.invitations(cabinet_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.invitations TO saas_app;

COMMENT ON TABLE auth.shops IS 'Магазины проекта: несколько МП, разные ИП/ООО. api_creds_enc — pgcrypto.';
COMMENT ON TABLE auth.invitations IS 'Приглашения сотрудников по инвайт-ссылке (token). Срок 7 дней.';
