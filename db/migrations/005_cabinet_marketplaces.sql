-- =====================================================================
--  SaaS, Этап 5: per-МП метаданные кабинета (имена магазинов).
--  Проблема: имена магазинов WB/Ozon были захардкожены в коде роутов
--  (WB_SHOP="ИП Матвеев", OZ_SHOP="Мяумолл озон") — это ломало
--  мультитенантность (нельзя масштабировать на других продавцов).
--
--  Решение (одобрено 2026-07-12): отдельная таблица auth.cabinet_marketplaces.
--  Один кабинет → много МП, у каждого своё shop_name и settings.
--  Это auth.* (как memberships) — БЕЗ RLS, изоляция через WHERE cabinet_id.
--  Идемпотентно (CREATE ... IF NOT EXISTS + ON CONFLICT).
-- =====================================================================

CREATE TABLE IF NOT EXISTS auth.cabinet_marketplaces (
    cabinet_id  BIGINT NOT NULL REFERENCES auth.cabinets(cabinet_id) ON DELETE CASCADE,
    mp_code     TEXT   NOT NULL,            -- 'wb' | 'ozon' | 'ya' | ...
    shop_name   TEXT,                       -- имя продавца на этом МП ("ИП Матвеев")
    settings    JSONB  NOT NULL DEFAULT '{}'::jsonb,  -- будущие настройки МП (тариф, регион и пр.)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, mp_code)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_mps_cabinet ON auth.cabinet_marketplaces(cabinet_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.cabinet_marketplaces TO saas_app;

COMMENT ON TABLE auth.cabinet_marketplaces IS 'Per-МП метаданные кабинета: имя магазина на каждом маркетплейсе, настройки. Мультитенантная замена захардкоженным WB_SHOP/OZ_SHOP (2026-07-12).';

-- =====================================================================
--  Seed: для существующих кабинетов проставить имена МП из marketplaces[].
--  Боевому кабинету #1 — известные имена из старого хардкода (чтобы
--  ничего не сломалось при переходе на чтение из БД).
-- =====================================================================
INSERT INTO auth.cabinet_marketplaces (cabinet_id, mp_code, shop_name)
VALUES
    (1, 'wb',   'ИП Матвеев'),
    (1, 'ozon', 'Мяумолл озон')
ON CONFLICT (cabinet_id, mp_code) DO NOTHING;
