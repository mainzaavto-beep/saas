-- =====================================================================
--  012_purchases_category.sql — колонка category в tenant.purchases.
--  Свободный текст (как opex.category для personal/family): владелец сам
--  группирует партии (напр. «Экшн-камеры», «Видеорегистраторы», «Бельё»).
--  Фильтр на дашборде /finance/purchases группирует по этой колонке.
--  NULL = «без категории» (обратная совместимость, не ломает старые строки).
--  Идемпотентно.
-- =====================================================================

ALTER TABLE tenant.purchases ADD COLUMN IF NOT EXISTS category TEXT;

COMMENT ON COLUMN tenant.purchases.category IS
  'Свободная категория/группа партии (владелец заполняет вручную). NULL = без категории. Фильтр на /finance/purchases.';
