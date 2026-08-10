-- 039_ozon_campaign_ad.sql — реклама Ozon в разрезе кампаний (Performance API).
--
-- Контекст (2026-08-10): worker/collectors/ozon_efficiency.py::_collect_ads
-- уже тянет CSV из GET /api/client/statistics/daily (Performance API), но
-- раньше читал из него только дату и суммарный расход, а построчный разрез
-- по кампаниям выбрасывал — агрегировал всё в одну цифру ad_spend/день
-- (tenant.ozon_daily_efficiency). Задача — сохранять и разрез.
--
-- Уровень агрегации источника: кампания × день. Товарного разреза в этом
-- отчёте НЕТ (Performance API отдаёт статистику по кампании целиком, а не
-- по SKU внутри неё). Поэтому tenant.ozon_daily_ad (product_id NOT NULL,
-- часть PK) не подходит — писать в product_id заглушку нельзя: схема будет
-- обещать товарный разрез, которого нет, а когда/если он появится из
-- другого источника, PK (cabinet_id, product_id, date, campaign_id)
-- с фиктивным product_id даст двойной счёт вместо честного объединения.
-- Поэтому — отдельная таблица без product_id, PK (cabinet_id, campaign_id, date).
--
-- Колонки CSV (разделитель «;», см. живой пример в отчёте задачи):
--   0 ID · 1 Название · 2 Дата · 3 Показы · 4 Клики · 5 Расход, ₽
--   6 Заказы, шт. · 7 Заказы, ₽
-- Расход приходит с русской десятичной запятой («554,80») — парсинг уже
-- есть в _collect_ads (replace(',', '.')), переиспользуем как есть.
--
-- ozon_daily_efficiency.ad_spend (суммарный расход/день) НЕ трогаем и не
-- заменяем — на него опирается расчёт прибыли и сверка с эталоном; эта
-- таблица дополняет его разрезом по кампаниям, сумма которого должна
-- сходиться с ad_spend за тот же день.
--
-- Идемпотентно (CREATE IF NOT EXISTS). RLS — по образцу ozon_daily_ad
-- (003_tenant_ozon_tables.sql) / ozon_prices (030_ozon_prices.sql).
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.ozon_daily_campaign_ad (
    cabinet_id    BIGINT  NOT NULL,
    campaign_id   BIGINT  NOT NULL,
    date          DATE    NOT NULL,
    campaign_name TEXT,
    views         INTEGER,
    clicks        INTEGER,
    spend         DOUBLE PRECISION,
    orders        INTEGER,
    orders_sum    DOUBLE PRECISION,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, campaign_id, date)
);
CREATE INDEX IF NOT EXISTS idx_oz_daily_campaign_ad_date ON tenant.ozon_daily_campaign_ad(date);

ALTER TABLE tenant.ozon_daily_campaign_ad ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_ozon_daily_campaign_ad') THEN
        CREATE POLICY tenant_iso_ozon_daily_campaign_ad ON tenant.ozon_daily_campaign_ad
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ozon_daily_campaign_ad TO saas_app;

COMMIT;
