-- 045: статья «Сборы Ozon» — позаказные сервисные операции (FirstCustomerReview,
-- рассрочка, упаковка, размещение, утилизация и пр.) выходят из logistics
-- в отдельную колонку. Прибыль строк не меняется — только раскладка.
-- Спека: docs/superpowers/specs/2026-08-25-ozon-services-line-design.md
-- Идемпотентна (ADD COLUMN IF NOT EXISTS).
--
-- Примечание (fresh-DB порядок, минор пост-ревью 2026-08-25): tenant.
-- ozon_order_costs_shadow (миграция 041) в проде УЖЕ дропнута (задача 5
-- плана «переезд финансов Ozon», подмена/чистка) — эта миграция её
-- сознательно НЕ трогает. Если shadow-таблица когда-нибудь вернётся (новая
-- миграция создаст её заново по образцу 041, LIKE ... INCLUDING DEFAULTS
-- INCLUDING CONSTRAINTS) — на fresh-DB (миграции применяются по порядку
-- номеров, 041 раньше 045) LIKE-копия структуры не подхватит эту колонку,
-- т.к. 045 применяется уже к существующей ozon_order_costs, а не к shadow.
-- Залатать явным ADD COLUMN на shadow в момент, когда/если она вернётся —
-- не раньше.
BEGIN;

ALTER TABLE tenant.ozon_order_costs ADD COLUMN IF NOT EXISTS services NUMERIC NOT NULL DEFAULT 0;

COMMIT;
