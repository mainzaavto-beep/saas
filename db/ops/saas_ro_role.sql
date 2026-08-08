-- db/ops/saas_ro_role.sql — учётка только для чтения (для диагностики и ассистента).
-- Не миграция схемы: роли живут на уровне кластера, а не базы, и в цепочку
-- migrations не входят. Запускать под postgres, пароль передаётся переменной:
--   psql -h localhost -U postgres -d saas -v pw="'СЕКРЕТ'" -f db/ops/saas_ro_role.sql
--
-- BYPASSRLS обязателен: боевые данные лежат в tenant.* под построчной защитой,
-- политики выданы роли saas_app. Без обхода RLS роль видела бы ноль строк —
-- то есть была бы бесполезна. На запись это не влияет: прав INSERT/UPDATE/DELETE
-- у роли нет ни на одну таблицу, и default privileges их не выдают.

SELECT 'CREATE ROLE saas_ro'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saas_ro') \gexec

ALTER ROLE saas_ro LOGIN BYPASSRLS PASSWORD :'pw';

GRANT CONNECT ON DATABASE saas TO saas_ro;

-- Чтение во всех рабочих схемах. public включён: там ничего нет, но новая
-- таблица могла бы появиться именно в нём.
GRANT USAGE ON SCHEMA auth, billing, jobs, tenant, shared, public TO saas_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA auth, billing, jobs, tenant, shared, public TO saas_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA auth, billing, jobs, tenant, shared, public TO saas_ro;

-- Таблицы, созданные будущими миграциями, тоже должны читаться без ручной
-- выдачи прав. Владелец всех таблиц — postgres, поэтому правило вешаем на него.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA auth, billing, jobs, tenant, shared, public
  GRANT SELECT ON TABLES TO saas_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA auth, billing, jobs, tenant, shared, public
  GRANT SELECT ON SEQUENCES TO saas_ro;

-- Явный запрет на создание объектов: в PG 16 право CREATE на public уже снято
-- по умолчанию, но пусть это будет записано, а не подразумевалось.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE saas FROM PUBLIC;
GRANT CONNECT ON DATABASE saas TO saas_app, saas_ro;
