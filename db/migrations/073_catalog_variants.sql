-- 073: модель/цвет/размер варианта для «Процента выкупа: одиночные / примерки» (20.10.2026,
-- спека docs/superpowers/specs/2026-10-20-buyout-fitting-design.md). Ozon — из
-- /v4/product/info/attributes (model_info.model_id, атрибуты 10097/10096 цвет, 9533/4295 размер),
-- WB — imtID карточки Content API. Гранты табличные — новые колонки их наследуют.
ALTER TABLE tenant.ozon_products
  ADD COLUMN IF NOT EXISTS model_id bigint,
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS size text;
ALTER TABLE tenant.wb_articles
  ADD COLUMN IF NOT EXISTS imt_id bigint;
