-- 040_ozon_accruals.sql — строки начислений Ozon (метод начислений) + справочник типов.
--
-- Контекст (2026-08-11): задача 2 плана «переезд финансов Ozon на методы
-- начислений» (см. .superpowers/sdd/2026-08-11-ozon-accrual-migration/).
-- Задача 1 (разбор расхождения) подтвердила состав колонок брифа: для
-- категории POSTING поля seller_price, sale_price, sale_commission,
-- coinvestment, bonus покрывают данные и выполняется тождество
-- total_amount = delivery.total_accrued + sale_price + sale_commission
--              + coinvestment + bonus.
-- Недостающих полей не выявлено — колонки дословно из брифа.
--
-- tenant.ozon_accruals — одна строка на строку начисления (line item внутри
-- начисления accrual_id), PK (cabinet_id, accrual_id, line_no).
-- shared.ozon_accrual_types — общий для всех кабинетов справочник типов
-- начислений (по образцу shared.wb_warehouses и др.: без RLS, без cabinet_id).
--
-- Существующий сборщик ozon_finance и таблица ozon_finance_report не
-- затрагиваются — эта миграция только создаёт новые объекты.
--
-- Идемпотентна (CREATE IF NOT EXISTS + DO $$ для политики RLS).
-- RLS — по образцу tenant.ozon_daily_ad (003_tenant_ozon_tables.sql) /
-- tenant.ozon_daily_campaign_ad (039_ozon_campaign_ad.sql).
BEGIN;

-- =====================================================================
--  tenant.ozon_accruals — строки начислений (per-tenant)
-- =====================================================================
CREATE TABLE IF NOT EXISTS tenant.ozon_accruals (
  cabinet_id      bigint NOT NULL,
  accrual_id      bigint NOT NULL,
  line_no         integer NOT NULL,      -- порядковый номер строки внутри начисления
  date            date NOT NULL,
  unit_number     text,                  -- номер отправления; NULL для расходов уровня кабинета
  accrued_category text NOT NULL,        -- ITEM | POSTING | NON_ITEM
  type_id         integer,
  sku             bigint,
  quantity        integer,
  accrued         double precision,      -- сумма строки
  seller_price    double precision,      -- далее — только для категории POSTING
  sale_price      double precision,
  sale_commission double precision,
  coinvestment    double precision,
  bonus           double precision,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cabinet_id, accrual_id, line_no)
);

CREATE INDEX IF NOT EXISTS ozon_accruals_date_idx ON tenant.ozon_accruals (cabinet_id, date);
CREATE INDEX IF NOT EXISTS ozon_accruals_unit_idx ON tenant.ozon_accruals (cabinet_id, unit_number);

ALTER TABLE tenant.ozon_accruals ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_ozon_accruals') THEN
        CREATE POLICY tenant_iso_ozon_accruals ON tenant.ozon_accruals
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ozon_accruals TO saas_app;

-- =====================================================================
--  shared.ozon_accrual_types — справочник типов начислений (глобальный)
-- =====================================================================
CREATE TABLE IF NOT EXISTS shared.ozon_accrual_types (
  type_id     integer PRIMARY KEY,
  name        text,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON shared.ozon_accrual_types TO saas_app;

COMMIT;
