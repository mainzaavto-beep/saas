-- 029_wb_prices_site.sql
-- Реальная цена сайта (с СПП) в tenant.wb_prices.
--
-- Контекст (решение хозяина 2026-08-02): price_buyer из API цен продавца
-- (discountedPrice) НЕ включает СПП — это цена после скидки ПРОДАВЦА
-- (доказано на nm 1181386677: API 8911 ₽, сайт 6344 ₽, СПП 31-45%).
-- Хозяин решил: (1) база налогов = цена, которую платит покупатель;
-- (2) собираем реальную цену сайта с публичного card.wb.ru (без токена).
--
-- price_site — цена покупателя на сайте (с СПП), руб.
-- price_site_at — когда снята (staleness видна: сбой card.wb.ru не затирает
-- значение, просто отметка стареет; обновление отдельным UPDATE, не upsert'ом).
--
-- Идемпотентно. RLS не меняется (колонки в уже защищённой таблице).
BEGIN;
ALTER TABLE tenant.wb_prices
  ADD COLUMN IF NOT EXISTS price_site double precision,
  ADD COLUMN IF NOT EXISTS price_site_at timestamptz;
COMMIT;
