-- =====================================================================
--  SaaS-пилот, Этап 1: ТЕСТ изоляции RLS.
--  Цель: доказать, что 2 разных кабинета НЕ видят данные друг друга.
--  Запускать от роли saas_app (после 001_tenant_core.sql + 003_seed_demo.sql).
--  Вывод: cabinet A видит 1 строку (свою), cabinet B видит 1 строку (свою),
--  попытка вставить чужой cabinet_id → ошибка (WITH CHECK).
-- =====================================================================

\echo '=== ТЕСТ 1: кабинет 1001 видит ТОЛЬКО свои данные ==='
SET ROLE saas_app;
SET app.cabinet_id = '1001';
SELECT cabinet_id, nm_id, name FROM tenant.wb_articles ORDER BY nm_id;
-- ожидание: 1 строка (cabinet_id=1001, nm_id=1)

\echo '=== ТЕСТ 2: кабинет 1002 видит ТОЛЬКО свои данные ==='
SET app.cabinet_id = '1002';
SELECT cabinet_id, nm_id, name FROM tenant.wb_articles ORDER BY nm_id;
-- ожидание: 1 строка (cabinet_id=1002, nm_id=999)

\echo '=== ТЕСТ 3: попытка ВСТАВИТЬ чужой cabinet_id (должна упасть) ==='
SET app.cabinet_id = '1001';
-- INSERT с cabinet_id=1002 должен отклониться WITH CHECK policy:
INSERT INTO tenant.wb_articles (cabinet_id, nm_id, name)
VALUES (1002, 777, 'попытка утечки');
-- ожидание: ERROR: new row violates row-level security policy

\echo '=== ТЕСТ 4: app.cabinet_id=0 (нет тенанта) — видит НИЧЕГО ==='
SET app.cabinet_id = '0';
SELECT count(*) AS rows_visible FROM tenant.wb_articles;
-- ожидание: 0

RESET ROLE;
