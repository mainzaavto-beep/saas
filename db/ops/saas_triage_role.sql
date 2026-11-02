-- db/ops/saas_triage_role.sql — роль БД авторазбора падений (claude -p, worker/bin/triage-sql).
-- Не миграция: роли живут на уровне кластера. Запуск под postgres, пароль переменной:
--   PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v pw="'СЕКРЕТ'" -f db/ops/saas_triage_role.sql
-- (deploy/install-triage-user.sh делает это сам и кладёт пароль в ~saas-triage/.pgpass).
--
-- Отличие от saas_ro (вариант 2, 02.10.2026): saas_ro видит ВСЁ, включая зашифрованные ключи
-- маркетплейсов (auth.shops/cabinets.api_creds_enc), хэши паролей и токены входа. Разбору падений
-- сборщиков это не нужно: tenant/jobs/shared целиком, из auth/billing — только колонки без
-- секретов и персональных данных. Новые таблицы auth/billing НЕ выдаются автоматически (по
-- умолчанию закрыто) — нужна явная правка этого файла.
--
-- BYPASSRLS — как у saas_ro: tenant.* под построчной защитой, иначе ноль строк. Записи нет:
-- ни одного INSERT/UPDATE/DELETE, плюс triage-sql держит транзакцию read-only.

SELECT 'CREATE ROLE saas_triage'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saas_triage') \gexec

ALTER ROLE saas_triage LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'pw';
ALTER ROLE saas_triage SET default_transaction_read_only = on;
ALTER ROLE saas_triage SET statement_timeout = '60s';

GRANT CONNECT ON DATABASE saas TO saas_triage;

-- Сбросить всё ранее выданное (идемпотентность при сужении списков ниже).
REVOKE ALL ON ALL TABLES IN SCHEMA auth, billing, jobs, tenant, shared, public FROM saas_triage;

GRANT USAGE ON SCHEMA auth, billing, jobs, tenant, shared TO saas_triage;
GRANT SELECT ON ALL TABLES IN SCHEMA jobs, tenant, shared TO saas_triage;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA jobs, tenant, shared
  GRANT SELECT ON TABLES TO saas_triage;
-- Накладные заказов закупки (контакты поставщиков) — только владельцу в панели, не разбору (миграция 076).
DO $$ BEGIN
  IF to_regclass('tenant.purchase_order_files') IS NOT NULL THEN
    REVOKE ALL ON tenant.purchase_order_files FROM saas_triage;
  END IF;
END $$;

-- auth: без api_creds/api_creds_enc/external_keys, без email/телефонов/ФИО/хэшей,
-- без auth.invitations (token) и auth.user_tokens целиком.
GRANT SELECT (cabinet_id, display_name, marketplaces, tax_mode, status, trial_ends_at,
              created_at, paid_until, settings)
  ON auth.cabinets TO saas_triage;
GRANT SELECT (shop_id, cabinet_id, mp_code, shop_name, legal_name, is_active, created_at, tax_mode,
              auth_state, auth_fail_count, auth_failed_at, auth_last_error, auth_notified_at,
              auth_last_attempt_at, cabinet_company_id, cabinet_profile_dir, cabinet_state,
              cabinet_last_error, cabinet_failed_at, cabinet_last_attempt_at, cabinet_notified_at)
  ON auth.shops TO saas_triage;
GRANT SELECT (cabinet_id, mp_code, shop_name, created_at) ON auth.cabinet_marketplaces TO saas_triage;
GRANT SELECT (membership_id, user_id, cabinet_id, role, created_at) ON auth.memberships TO saas_triage;
GRANT SELECT (user_id, status, created_at, email_verified_at, last_login_at) ON auth.users TO saas_triage;

-- billing: тарифы целиком, платежи без raw (ответ платёжки).
GRANT SELECT ON billing.plans TO saas_triage;
GRANT SELECT (payment_id, cabinet_id, plan_code, months, amount_rub, status,
              paid_until_before, paid_until_after, created_at, updated_at)
  ON billing.payments TO saas_triage;
