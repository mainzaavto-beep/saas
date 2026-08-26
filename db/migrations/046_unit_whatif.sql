-- 046: tenant.unit_whatif — персист what-if прикидок на странице /unit.
--
-- Контекст (2026-08-26): задача 1 плана «юнит-экономика: ширина, читаемость,
-- персист» (см. .superpowers/sdd/2026-08-26-unit-page-usability/). Строка
-- ПРИКИДКА на /unit (редактируемые входы what-if, отдельно от «↧ в факт» —
-- tenant.unit_inputs) сейчас живёт только в клиентском стейте и теряется
-- при перезагрузке страницы. Эта таблица хранит последний набор what-if
-- входов по товару целиком (один JSONB-документ вместо построчных
-- (key, value) как в unit_inputs) — ключи произвольные (см. WHATIF_INPUTS
-- в UnitPage.jsx), значения — доли/суммы как приходят с клиента.
--
-- item_id — nmId для wb, productId для ozon (тот же sku, что в unit_inputs,
-- но здесь как число: платформенный идентификатор товара).
--
-- Идемпотентна (CREATE IF NOT EXISTS + DO $$ для политик RLS).
-- RLS — по образцу tenant.ozon_daily_sku_ad (043_ozon_sku_ad.sql):
-- tenant_iso для saas_app + panel_local_ro_cab1 для panel_local_ro.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.unit_whatif (
    cabinet_id  BIGINT NOT NULL,
    platform    TEXT NOT NULL CHECK (platform IN ('wb', 'ozon')),
    item_id     BIGINT NOT NULL,
    inputs      JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, platform, item_id)
);

ALTER TABLE tenant.unit_whatif ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='unit_whatif' AND policyname='tenant_iso_unit_whatif') THEN
        CREATE POLICY tenant_iso_unit_whatif ON tenant.unit_whatif
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='unit_whatif' AND policyname='panel_local_ro_cab1') THEN
        CREATE POLICY panel_local_ro_cab1 ON tenant.unit_whatif
        FOR SELECT TO panel_local_ro
        USING (cabinet_id = 1);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.unit_whatif TO saas_app;
-- panel_local_ro_cab1 без базового GRANT SELECT бесполезна (RLS не заменяет
-- табличную привилегию) — как в 041/043.
GRANT SELECT ON tenant.unit_whatif TO panel_local_ro;

COMMIT;
