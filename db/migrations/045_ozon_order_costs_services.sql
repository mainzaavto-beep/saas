-- 045: статья «Сборы Ozon» — позаказные сервисные операции (FirstCustomerReview,
-- рассрочка, упаковка, размещение, утилизация и пр.) выходят из logistics
-- в отдельную колонку. Прибыль строк не меняется — только раскладка.
-- Спека: docs/superpowers/specs/2026-08-25-ozon-services-line-design.md
-- Идемпотентна (ADD COLUMN IF NOT EXISTS).
BEGIN;

ALTER TABLE tenant.ozon_order_costs ADD COLUMN IF NOT EXISTS services NUMERIC NOT NULL DEFAULT 0;

COMMIT;
