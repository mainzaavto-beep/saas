-- 025_wb_references.sql — справочник складов WB + тарифы перевозок между ними.
--
-- Контекст (2026-07-18): на странице «Склады и индексы» появилась вкладка
-- «Перевозки» — рекомендации по перемещению остатков между складами WB.
-- Само перемещение через API оформить НЕЛЬЗЯ (WB не публикует такой endpoint),
-- но WB отдаёт справочник складов и тарифы транзитных направлений — на их
-- основе дашборд строит рекомендации «товар X перевезти со склада A на B,
-- тариф N ₽», а исполнение — вручную в ЛК продавца.
--
-- Источники (probe 2026-07-18 на cabinet #1, оба подтверждены):
--   GET https://supplies-api.wildberries.ru/api/v1/warehouses
--     → [{ID, name, address, workTime, isActive, isTransitActive}] (129 складов)
--   GET https://supplies-api.wildberries.ru/api/v1/transit-tariffs
--     → [{transitWarehouseName, destinationWarehouseName, activeFrom,
--         boxTariff:[{from,to,value}...], palletTariff}] (138 направлений)
--
-- Обе таблицы — в схеме shared.* (без RLS, без cabinet_id): склады WB едины для
-- всех кабинетов, дублировать per-tenant бессмысленно. Грант только SELECT для
-- saas_app (это сервисные данные; пишет сборщик wb_references через
-- суперпользовательское подключение воркера, как остальные shared-таблицы).
--
-- Дополнительно: ALTER tenant.wb_daily_stock ADD warehouse_id BIGINT — сборщик
-- wb_stocks уже получает warehouseId из API, просто не сохранял. ID даёт
-- надёжный маппинг stocks↔warehouses (по именам совпадение только 45%,
-- по ID — 84%+; см. кросс-чек от 2026-07-18).
--
-- Частота сбора: таймер saas-references (weekly, Mon 06:00) — справочник и
-- тарифы практически статичны, тащить ежедневно нет смысла.
--
-- Идемпотентна (CREATE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS + DO $$).

-- =====================================================================
--  shared.wb_warehouses — справочник складов WB (глобальный)
-- =====================================================================
CREATE TABLE IF NOT EXISTS shared.wb_warehouses (
    id                  BIGINT PRIMARY KEY,        -- WB warehouseId (из /warehouses)
    name                TEXT NOT NULL UNIQUE,      -- каноничное имя (для маппинга тарифов)
    address             TEXT,
    work_time           TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    is_transit_active   BOOLEAN NOT NULL DEFAULT false,  -- может быть источником перевозки
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- saas_app пишет справочник через сборщик wb_references (DB-DSN воркера — saas_app,
-- см. db_pg.py:30). Другие роли (Next.js route) читают SELECT.
GRANT SELECT, INSERT, UPDATE ON shared.wb_warehouses TO saas_app;

-- =====================================================================
--  shared.wb_transit_tariffs — тарифы перевозок между складами WB
-- =====================================================================
CREATE TABLE IF NOT EXISTS shared.wb_transit_tariffs (
    id                          BIGSERIAL PRIMARY KEY,
    transit_warehouse_name      TEXT NOT NULL,           -- откуда (источник перевозки)
    destination_warehouse_name  TEXT NOT NULL,           -- куда (назначение)
    active_from                 DATE,                    -- с какой даты тариф актуален
    box_tariff                  JSONB,                   -- [{from,to,value}] — диапазоны веса коробки
    pallet_tariff               NUMERIC(12,2),           -- тариф за палету, ₽
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (transit_warehouse_name, destination_warehouse_name)
);
GRANT SELECT, INSERT, UPDATE ON shared.wb_transit_tariffs TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE shared.wb_transit_tariffs_id_seq TO saas_app;

-- =====================================================================
--  tenant.wb_daily_stock: добавить warehouse_id (надёжный маппинг)
-- =====================================================================
ALTER TABLE tenant.wb_daily_stock ADD COLUMN IF NOT EXISTS warehouse_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_wb_stock_wh_id ON tenant.wb_daily_stock(warehouse_id);
