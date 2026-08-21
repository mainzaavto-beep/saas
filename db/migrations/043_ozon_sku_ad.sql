-- 043: tenant.ozon_daily_sku_ad — рекламный расход Ozon в разрезе
-- кампания × день × sku. Источник: Performance API POST /api/client/statistics
-- (groupBy=DATE, async) → ZIP → CSV на кампанию; доказано живой пробой
-- 2026-08-21 (сверка с tenant.ozon_daily_campaign_ad Δ=0.00 на закрытых днях).
-- sku здесь = tenant.ozon_products.fbo_sku (строка!); product_id — резолв
-- на момент записи (NULL, если товара нет в каталоге — архив и т.п.).
-- Дополняет ozon_daily_campaign_ad товарным разрезом; кампанийная таблица
-- остаётся источником кабинетного итога (P&L) — она полнее: строки
-- «Корректировка» и кампании без товарной разбивки не имеют sku.
-- Идемпотентна (CREATE IF NOT EXISTS + DO $$ для политик RLS).
-- Спека: docs/superpowers/specs/2026-08-21-ozon-sku-ads-design.md.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.ozon_daily_sku_ad (
    cabinet_id     BIGINT NOT NULL,
    date           DATE NOT NULL,
    campaign_id    BIGINT NOT NULL,
    sku            TEXT NOT NULL,
    product_id     BIGINT,
    spend          NUMERIC(14,2) NOT NULL DEFAULT 0,
    views          BIGINT,
    clicks         BIGINT,
    ordered_units  BIGINT,
    ordered_amount NUMERIC(14,2),
    updated_at     TEXT,
    PRIMARY KEY (cabinet_id, date, campaign_id, sku)
);

CREATE INDEX IF NOT EXISTS ozon_daily_sku_ad_product_idx
    ON tenant.ozon_daily_sku_ad (cabinet_id, product_id, date);

ALTER TABLE tenant.ozon_daily_sku_ad ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='ozon_daily_sku_ad' AND policyname='tenant_iso_ozon_daily_sku_ad') THEN
        CREATE POLICY tenant_iso_ozon_daily_sku_ad ON tenant.ozon_daily_sku_ad
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='ozon_daily_sku_ad' AND policyname='panel_local_ro_cab1') THEN
        CREATE POLICY panel_local_ro_cab1 ON tenant.ozon_daily_sku_ad
        FOR SELECT TO panel_local_ro
        USING (cabinet_id = 1);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ozon_daily_sku_ad TO saas_app;
-- panel_local_ro_cab1 без базового GRANT SELECT бесполезна (RLS не заменяет
-- табличную привилегию) — как в 041.
GRANT SELECT ON tenant.ozon_daily_sku_ad TO panel_local_ro;

COMMIT;
