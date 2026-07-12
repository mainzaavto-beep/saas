-- =====================================================================
--  SaaS-пилот, Этап 1: СИД для демонстрации RLS.
--  Создаёт 2 тестовых кабинета + по 1 товару в каждом.
--  Запускать от postgres (superuser, обходит RLS) ДО теста 002.
--  НЕ production-данные — только proof-of-concept изоляции.
-- =====================================================================

-- чистим (на случай повторного прогона)
DELETE FROM tenant.wb_articles WHERE cabinet_id IN (1001,1002);
DELETE FROM auth.memberships WHERE cabinet_id IN (1001,1002);
DELETE FROM auth.cabinets WHERE cabinet_id IN (1001,1002);
DELETE FROM auth.users WHERE email LIKE 'demo%@saas.test';

-- 2 демо-юзера (владельцы кабинетов)
INSERT INTO auth.users (user_id, email, password_hash, name) VALUES
  (1001, 'demo_a@saas.test', 'bcrypt_hash_placeholder', 'Клиент A'),
  (1002, 'demo_b@saas.test', 'bcrypt_hash_placeholder', 'Клиент B')
ON CONFLICT (user_id) DO NOTHING;
SELECT setval('auth.users_user_id_seq', 1002);

-- 2 кабинета (фиксированные id для детерминированного теста)
INSERT INTO auth.cabinets (cabinet_id, owner_user_id, display_name, marketplaces, status) VALUES
  (1001, 1001, 'Кабинет A (ИП Иванов)', '{wb,ozon}', 'active'),
  (1002, 1002, 'Кабинет B (ООО Петров)', '{wb}', 'active')
ON CONFLICT (cabinet_id) DO NOTHING;
SELECT setval('auth.cabinets_cabinet_id_seq', 1002);

-- membership (владельцы своих кабинетов)
INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES
  (1001, 1001, 'owner'),
  (1002, 1002, 'owner')
ON CONFLICT (user_id, cabinet_id) DO NOTHING;

-- данные: у каждого кабинета СВОЙ товар (nm_id может совпадать между клиентами!)
INSERT INTO tenant.wb_articles (cabinet_id, nm_id, name, brand, subject) VALUES
  (1001, 1, 'Товар клиента A', 'Бренд A', 'Аксессуары'),
  (1002, 999, 'Товар клиента B', 'Бренд B', 'Одежда');
-- 注意: nm_id=1 у A и nm_id=999 у B — разные. RLS изолирует по cabinet_id.

\echo 'Сид насеян: 2 кабинета (1001, 1002), по 1 товару в каждом.'
