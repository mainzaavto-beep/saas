-- 057_ozon_metrics_30m.sql — 30-минутные снимки Ozon для страницы «Заказы по
-- времени» (режим «По 30 минут»), двойник tenant.wb_metrics_30m. Сборщик
-- worker/collectors/ozon_metrics_30m.py снимает кумулятивные счётчики «сегодня»
-- раз в 30 минут (таймер saas-metrics30m): по товарам — из аналитики продавца
-- (/v1/analytics/data), по кампаниям — из Performance API (/statistics/daily;
-- товарного разреза внутри дня API не даёт). Дельту за слот считает панель
-- (lib/timing30m.js). Хранение 60 дней (cleanup в сборщике). Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.ozon_metrics_30m (
    cabinet_id     BIGINT  NOT NULL,
    product_id     BIGINT  NOT NULL,
    date           DATE    NOT NULL,           -- календарный день снимка (МСК)
    ts             TEXT    NOT NULL,           -- слот 'YYYY-MM-DD HH:MM:SS' (МСК), как у WB
    views          INTEGER,                    -- hits_view: показы всего (NULL без Premium)
    views_search   INTEGER,                    -- hits_view_search: показы в поиске/каталоге
    views_pdp      INTEGER,                    -- hits_view_pdp: просмотры карточки
    cart           INTEGER,                    -- hits_tocart: добавления в корзину
    orders         INTEGER,                    -- ordered_units: заказано, шт
    order_sum      DOUBLE PRECISION,           -- revenue: заказано, ₽
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, product_id, ts)
);
CREATE INDEX IF NOT EXISTS ozon_metrics_30m_date_idx ON tenant.ozon_metrics_30m (cabinet_id, date);

CREATE TABLE IF NOT EXISTS tenant.ozon_ads_30m (
    cabinet_id     BIGINT  NOT NULL,
    campaign_id    BIGINT  NOT NULL,
    date           DATE    NOT NULL,
    ts             TEXT    NOT NULL,
    campaign_name  TEXT,
    views          INTEGER,
    clicks         INTEGER,
    spend          DOUBLE PRECISION,           -- расход, ₽ с НДС (как ozon_daily_campaign_ad)
    orders         INTEGER,
    orders_sum     DOUBLE PRECISION,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, campaign_id, ts)
);
CREATE INDEX IF NOT EXISTS ozon_ads_30m_date_idx ON tenant.ozon_ads_30m (cabinet_id, date);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ozon_metrics_30m','ozon_ads_30m'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='tenant_iso_'||t) THEN
      EXECUTE format($p$CREATE POLICY %I ON tenant.%I FOR ALL TO saas_app
                       USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                       WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)$p$, 'tenant_iso_'||t, t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='panel_local_ro_cab1') THEN
      EXECUTE format('CREATE POLICY panel_local_ro_cab1 ON tenant.%I FOR SELECT TO panel_local_ro USING (cabinet_id = 1)', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.%I TO saas_app', t);
    EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
  END LOOP;
END $$;

COMMIT;
