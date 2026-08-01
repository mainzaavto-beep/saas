-- 027_buyer_portrait.sql — «Портрет покупателя» (подписка «Джем» WB).
--
-- Коллега оказался прав: WB публикует «Джем»-only методы в открытой API-документации
-- (хост seller-analytics-api.wildberries.ru), дающие поисковые запросы, позиции в поиске
-- и воронку конверсий. Пол/возраст через API так и НЕ отдаётся (виджет в ЛК без endpoint'а,
-- подтверждено форумом dev.wildberries.ru/forum/1308) — но поисковые запросы + позиции +
-- воронка = 80% коммерческого «портрета».
--
-- ⚠️ Поля колонок ниже сверены ЖИВЫМ probe'ом на cabinet #1 (2026-07-19), а не догадками
-- из доки WB (которая систематически расходится с реальностью, грабля #18/#57).
--
-- Источники данных (см. worker/collectors/wb_jem.py):
--   1. POST /api/v2/search-report/report       — агрегированно по nm_id (воронка + позиция)
--   2. POST /api/v2/search-report/product/search-texts — по ключевым запросам (keyword-level)
--
-- Две таблицы (RLS по образцу 023_ff_inventory_skus.sql / 002_tenant_wb_tables.sql):

-- =====================================================================
--  1) Поисковые запросы по товарам (источник: search-texts)
--     PK (cabinet_id, nm_id, date, keyword) — keyword = поле "text" ответа WB.
--     Одна запись = «по такому-то запросу товар №X за дату D».
-- =====================================================================
CREATE TABLE IF NOT EXISTS tenant.wb_search_queries (
    cabinet_id        BIGINT  NOT NULL,
    nm_id             BIGINT  NOT NULL,
    date              DATE    NOT NULL,            -- конец периода currentPeriod.end (снимок)
    keyword           TEXT    NOT NULL,            -- WB поле "text"
    freq              INTEGER,                     -- частота запроса (frequency.current)
    week_freq         INTEGER,                     -- недельная частота (weekFrequency)
    avg_position      INTEGER,                     -- средняя позиция (avgPosition.current)
    median_position   INTEGER,                     -- медианная позиция (medianPosition.current)
    open_card         INTEGER,                     -- открытия карточки (openCard.current)
    add_to_cart       INTEGER,                     -- добавления в корзину (addToCart.current)
    open_to_cart      INTEGER,                     -- конверсия показ→корзина, % (openToCart.current)
    orders            INTEGER,                     -- заказы с этого запроса (orders.current)
    cart_to_order     INTEGER,                     -- конверсия корзина→заказ, % (cartToOrder.current)
    visibility        INTEGER,                     -- видимость, % (visibility.current)
    open_card_pct     INTEGER,                     -- перцентиль по открытиям (openCard.percentile)
    orders_pct        INTEGER,                     -- перцентиль по заказам (orders.percentile)
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id, date, keyword)
);
CREATE INDEX IF NOT EXISTS ix_wb_sq_date ON tenant.wb_search_queries(date);
CREATE INDEX IF NOT EXISTS ix_wb_sq_keyword ON tenant.wb_search_queries(keyword);

-- =====================================================================
--  2) Воронка конверсий по товару×дню (источник: search-report/report)
--     PK (cabinet_id, nm_id, date) — снимок по товару на дату (конец периода).
--     Один товар — одна строка воронки. Метрики WB отдаёт только current (без динамики)
--     поэтому date = currentPeriod.end. При ежедневном сборе складывается история.
-- =====================================================================
CREATE TABLE IF NOT EXISTS tenant.wb_funnel_daily (
    cabinet_id      BIGINT  NOT NULL,
    nm_id           BIGINT  NOT NULL,
    date            DATE    NOT NULL,              -- currentPeriod.end
    avg_position    INTEGER,                       -- средняя позиция в поиске
    visibility      INTEGER,                       -- видимость, %
    open_card       INTEGER,                       -- переходы в карточку
    add_to_cart     INTEGER,                       -- добавления в корзину
    open_to_cart    INTEGER,                       -- CR показ→корзина, %
    orders          INTEGER,                       -- заказы
    cart_to_order   INTEGER,                       -- CR корзина→заказ, %
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id, date)
);
CREATE INDEX IF NOT EXISTS ix_wb_fd_date ON tenant.wb_funnel_daily(date);

-- =====================================================================
--  RLS: строка видна, если cabinet_id = текущему GUC app.cabinet_id.
--  (Паттерн из 023:49-53 и 002:370-392.)
-- =====================================================================
DO $$
BEGIN
    -- wb_search_queries
    ALTER TABLE tenant.wb_search_queries ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_iso_wb_search_queries ON tenant.wb_search_queries;
    CREATE POLICY tenant_iso_wb_search_queries ON tenant.wb_search_queries
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);

    -- wb_funnel_daily
    ALTER TABLE tenant.wb_funnel_daily ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_iso_wb_funnel_daily ON tenant.wb_funnel_daily;
    CREATE POLICY tenant_iso_wb_funnel_daily ON tenant.wb_funnel_daily
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
END $$;

-- DML-гранты для saas_app (как на всех tenant.wb_* таблицах).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.wb_search_queries TO saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.wb_funnel_daily TO saas_app;
