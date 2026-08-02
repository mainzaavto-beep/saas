-- 030_ozon_prices.sql
-- Дневные снимки цен Ozon → соинвест (спек docs/superpowers/specs/2026-08-02-ozon-coinvest-design.md).
--
-- Соинвест = часть скидки за счёт ОЗОНА (решение хозяина 2026-08-02: буст из
-- акций — это скидки продавца, НЕ соинвест). Источник: официальный API
-- product_info_prices: marketing_seller_price (цена со скидками продавца) и
-- marketing_price (итог с доплатой Озона; NULL = соинвеста нет → честный 0%).
-- Соинвест % = 1 − marketing_price / marketing_seller_price.
--
-- Дневной снимок: PK (cabinet_id, product_id, date), повторный прогон в тот же
-- день перезаписывает строку, история по дням копится (динамика на РНП).
-- Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.ozon_prices (
    cabinet_id             BIGINT  NOT NULL,
    product_id             BIGINT  NOT NULL,
    date                   DATE    NOT NULL,
    price                  DOUBLE PRECISION,
    old_price              DOUBLE PRECISION,
    marketing_seller_price DOUBLE PRECISION,
    marketing_price        DOUBLE PRECISION,
    min_price              DOUBLE PRECISION,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id, date)
);

ALTER TABLE tenant.ozon_prices ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_ozon_prices') THEN
        CREATE POLICY tenant_iso_ozon_prices ON tenant.ozon_prices
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ozon_prices TO saas_app;

COMMIT;
