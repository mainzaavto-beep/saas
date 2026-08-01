-- 028_wb_prices_buyer.sql
-- Добавить колонку price_buyer в tenant.wb_prices.
--
-- Контекст (фикс 2026-07-28): сборщик wb_prices.py раньше сохранял только
-- price_seller (цена ДО скидки, поле `price` из WB API) и discount (% скидки
-- продавца). Финальная цена покупателя на сайте (поле `discountedPrice` из WB
-- API /api/v2/list/goods/filter) ТЕРЯЛАСЬ — её восстанавливали на лету как
-- price_seller*(1-discount), что численно совпадало, только пока spp=0 (что и
-- было у всех 145 товаров cab #1 — WB не применяет отдельный СПП).
--
-- Теперь price_buyer пишется напрямую из API — это реальная цена сделки,
-- от которой методически правильно считать НДС/УСН/эквайринг (ст. 248/346.15
-- НК РФ: выручка = поступления от покупателя).
--
-- Идемпотентно (ADD COLUMN IF NOT EXISTS). RLS не меняется (колонка в уже
-- защищённой таблице). Тип double precision — как у price_seller.
BEGIN;
ALTER TABLE tenant.wb_prices
  ADD COLUMN IF NOT EXISTS price_buyer double precision;
COMMIT;
