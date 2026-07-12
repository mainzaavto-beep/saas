-- =====================================================================
--  SaaS-пилот, Этап 1: ядро мультитенантности + RLS-демо.
--  БД: saas (создаётся отдельно). Схемы: auth / tenant / shared / jobs.
--  Фундамент-документ: C:\Agents\SAAS_ARCHITECTURE.md (одобрен 2026-07-10).
--  Решения владельца: 1 кабинет = много МП; 3 предустановленные роли.
--  Идемпотентно (CREATE ... IF NOT EXISTS) — безопасно перезапускать.
-- =====================================================================

-- ---------- РОЛИ (роли подключения приложения) ----------
-- saas_app — роль, от имени которой Node.js app и Python-воркер ходят в БД.
--   НЕ superuser, НЕ может обходить RLS. Все tenant-запросы изолируются.
-- saas_migrator — роль для наката миграций (владелец схемы; пока совпадает с
--   postgres, выделена для будущей дисциплины миграций).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saas_app') THEN
        CREATE ROLE saas_app LOGIN PASSWORD 'WRGwU4ba8oB8Hnvm9LwG+kVNkw9oqEyl'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
        -- дефолтная настройка тенанта = 0 (нет тенанта) — RLS отрезает всё
        ALTER ROLE saas_app SET app.cabinet_id = '0';
    END IF;
END $$;

-- ---------- СХЕМЫ ----------
CREATE SCHEMA IF NOT EXISTS auth;       -- юзеры, кабинеты, membership, роли
CREATE SCHEMA IF NOT EXISTS tenant;     -- клиентские данные (RLS по cabinet_id)
CREATE SCHEMA IF NOT EXISTS shared;     -- общие справочники (категории/тарифы)
CREATE SCHEMA IF NOT EXISTS jobs;       -- очередь сбора данных

GRANT USAGE ON SCHEMA auth, tenant, shared, jobs TO saas_app;

-- =====================================================================
--  auth.* — ядро tenancy
-- =====================================================================

-- Пользователь системы (человек, который логинится).
CREATE TABLE IF NOT EXISTS auth.users (
    user_id        BIGSERIAL PRIMARY KEY,
    email          TEXT UNIQUE NOT NULL,
    password_hash  TEXT NOT NULL,                 -- bcrypt/argon2
    name           TEXT,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Кабинет = изолированный контур данных одного юрлица/магазина.
-- ⚠️ Решение владельца 2026-07-10: ОДИН кабинет = много МП (WB + Ozon).
CREATE TABLE IF NOT EXISTS auth.cabinets (
    cabinet_id     BIGSERIAL PRIMARY KEY,
    owner_user_id  BIGINT NOT NULL REFERENCES auth.users(user_id) ON DELETE RESTRICT,
    display_name   TEXT,
    -- Какие МП подключены (наполняется онбордингом; массив):
    marketplaces   TEXT[] NOT NULL DEFAULT '{}',   -- напр. {'wb','ozon'}
    -- Credentials для ВСЕХ подключённых МП (ШИФРОВАТЬ на Этапе 2, pgcrypto):
    api_creds      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"wb":{"token"}, "ozon":{"client_id","api_key","perf_*"}}
    tax_mode       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"usn_pct":6,"vat":false}
    status         TEXT NOT NULL DEFAULT 'provisioning'
                   CHECK (status IN ('provisioning','active','suspended','deleted')),
    trial_ends_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cabinets_owner ON auth.cabinets(owner_user_id);

-- Membership: какой юзер к какому кабину имеет доступ и с какой ролью.
-- Поддержка white-label/агентств: юзер → много кабинетов (даже чужих).
CREATE TABLE IF NOT EXISTS auth.memberships (
    membership_id  BIGSERIAL PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES auth.users(user_id) ON DELETE CASCADE,
    cabinet_id     BIGINT NOT NULL REFERENCES auth.cabinets(cabinet_id) ON DELETE CASCADE,
    -- Решение владельца 2026-07-10: 3 предустановленные роли.
    -- owner = всё (финансы, роли, ключи); manager = товары+реклама, БЕЗ финансов;
    -- viewer = только чтение.
    role           TEXT NOT NULL CHECK (role IN ('owner','manager','viewer')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, cabinet_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON auth.memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_cabinet ON auth.memberships(cabinet_id);

-- ---------- словарь разрешений ролей (для app-уровня; RLS работает по cabinet_id) ----------
-- owner  → видит всё в кабинете + может править
-- manager→ видит всё КРОМЕ fin.* (финансы) — enforcement на app-уровне
-- viewer → только чтение (SELECT; без INSERT/UPDATE/DELETE) — RLS WRITE ниже
COMMENT ON TABLE auth.memberships IS 'Связь user↔cabinet с ролью. 3 роли: owner/manager/viewer (решение 2026-07-10).';

-- =====================================================================
--  tenant.* — клиентские данные с RLS (демо на 2 таблицах)
--  Полная миграция 48 таблиц — Этап 4. Здесь 2 образца для проверки RLS.
-- =====================================================================

-- Образец WB-таблицы (articles) с cabinet_id в PK.
CREATE TABLE IF NOT EXISTS tenant.wb_articles (
    cabinet_id   BIGINT  NOT NULL,
    nm_id        BIGINT  NOT NULL,
    name         TEXT,
    brand        TEXT,
    subject      TEXT,
    im_url       TEXT,
    PRIMARY KEY (cabinet_id, nm_id)
);

-- Образец фин-таблицы (opex) с cabinet_id.
CREATE TABLE IF NOT EXISTS tenant.fin_opex (
    cabinet_id   BIGINT  NOT NULL,
    id           BIGSERIAL,
    period       TEXT,
    category     TEXT,
    amount       NUMERIC(14,2),
    note         TEXT,
    domain       TEXT NOT NULL DEFAULT 'business',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
-- BIGSERIAL без cabinet_id в default — но PK составной; serial только для уникальности id.
-- (альтернатива — GENERATED ALWAYS AS IDENTITY; для простоты миграции оставлен BIGSERIAL.)

-- ---------- Включаем RLS ----------
ALTER TABLE tenant.wb_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.fin_opex    ENABLE ROW LEVEL SECURITY;

-- Для demo: saas_app видит только строки своего cabinet_id.
-- app.cabinet_id устанавливается через SET LOCAL app.cabinet_id = $1 на транзакцию.
-- ⚠️ PG 16: CREATE POLICY не поддерживает IF NOT EXISTS (только PG 17+).
--    Обёртка в DO-блок с проверкой pg_policies для идемпотентности.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_isolation_wb_articles') THEN
        CREATE POLICY tenant_isolation_wb_articles ON tenant.wb_articles
            FOR ALL TO saas_app
            USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
            WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_isolation_fin_opex') THEN
        CREATE POLICY tenant_isolation_fin_opex ON tenant.fin_opex
            FOR ALL TO saas_app
            USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
            WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

-- Дать saas_app права на tenant-данные (RLS срежет не-своё).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.wb_articles, tenant.fin_opex TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.fin_opex_id_seq TO saas_app;

-- =====================================================================
--  shared.* — общие справочники (без RLS; общие для всех)
-- =====================================================================
CREATE TABLE IF NOT EXISTS shared.mp_list (
    code    TEXT PRIMARY KEY,    -- 'wb' | 'ozon' | 'ya'
    name    TEXT NOT NULL
);
INSERT INTO shared.mp_list (code, name) VALUES
    ('wb','Wildberries'),('ozon','Ozon'),('ya','Yandex Market')
ON CONFLICT (code) DO NOTHING;
GRANT SELECT ON shared.mp_list TO saas_app;

-- =====================================================================
--  jobs.* — очередь сбора
-- =====================================================================
CREATE TABLE IF NOT EXISTS jobs.collect_jobs (
    job_id      BIGSERIAL PRIMARY KEY,
    cabinet_id  BIGINT NOT NULL REFERENCES auth.cabinets(cabinet_id) ON DELETE CASCADE,
    job_type    TEXT NOT NULL CHECK (job_type IN ('daily','resync','onboarding')),
    date_from   DATE,
    date_to     DATE,
    status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed')),
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs.collect_jobs(status);
GRANT SELECT, INSERT, UPDATE ON jobs.collect_jobs TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE jobs.collect_jobs_job_id_seq TO saas_app;

-- =====================================================================
--  права на auth.* (app читает юзеров/кабинеты/memberships; правит при онбординге)
-- =====================================================================
GRANT SELECT, INSERT, UPDATE ON
    auth.users, auth.cabinets, auth.memberships TO saas_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO saas_app;
