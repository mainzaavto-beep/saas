-- 065_memberships_delete_grant.sql — право панели удалять участника кабинета.
-- DELETE /api/cabinets/[id]/members (кнопка ✕ в «Команде») падал 500
-- «permission denied for table memberships»: у saas_app были SELECT/INSERT/UPDATE,
-- но не DELETE. Найдено 2026-10-10 сквозной проверкой «создать сотрудника → удалить».
-- Роут удаляет только не-владельца своего кабинета (проверка в коде). Идемпотентно.
GRANT DELETE ON auth.memberships TO saas_app;
