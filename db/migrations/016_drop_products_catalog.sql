-- 016_drop_products_catalog.sql — удаляем справочник товаров.
--
-- Страница «Справочник товаров» (/catalog) и API /api/cabinets/[id]/catalog
-- убраны (решение 2026-07-15): внутренний справочник товаров с привязкой SKU
-- не нужен — привязка артикулов МП делается напрямую на остатках склад/ФФ
-- (inventory). Таблицы products_catalog / products_catalog_skus не используются
-- больше нигде в коде. Дропаем полностью.
--
-- ВНИМАНИЕ: данные этих таблиц будут потеряны. Бэкап кода: см.
-- /opt/agentsDB/backups/catalog_removed_*. Перед выполнением рекомендуется
-- сделать полный дамп БД (saas-backup).
-- =====================================================================

-- Сначала stock_ff_balances.catalog_id ссылался на products_catalog (логически,
-- без FK), но ff_inventory (используется сейчас) НЕ зависит от products_catalog —
-- привязка артикула хранится прямо в ff_inventory.nm_id/product_id. Так что дроп
-- безопасен для текущей функциональности склада.

DROP TABLE IF EXISTS tenant.products_catalog_skus;
DROP TABLE IF EXISTS tenant.products_catalog;
