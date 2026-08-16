-- 041_ozon_order_costs_shadow.sql — теневая таблица для пересчёта прибыли Ozon.
--
-- Контекст (2026-08-15): задача 2 плана «переезд финансов Ozon на методы
-- начислений» (см. .superpowers/sdd/2026-08-15-ozon-profit-switch/).
-- Задача 1 (классификатор) готова. tenant.ozon_order_costs_shadow — точная
-- копия структуры tenant.ozon_order_costs, приёмник теневого пересчёта
-- прибыли по методу начислений (задачи 3-4). После сверки и подмены
-- (задача 5) таблицу дропнут — эта миграция только создаёт новый объект,
-- существующие tenant.ozon_order_costs и сборщики не затрагиваются.
--
-- Идемпотентна (CREATE IF NOT EXISTS + DO $$ для политик RLS).
-- Структура и политики — по образцу tenant.ozon_order_costs (см. \d в БД):
-- LIKE ... INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES
-- копирует колонки, PK и индекс idx_oz_oc_dt, но не RLS-политики — их
-- создаём отдельно, дословно повторяя обе политики оригинала.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.ozon_order_costs_shadow
  (LIKE tenant.ozon_order_costs INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);

ALTER TABLE tenant.ozon_order_costs_shadow ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='ozon_order_costs_shadow' AND policyname='tenant_iso_ozon_order_costs_shadow') THEN
        CREATE POLICY tenant_iso_ozon_order_costs_shadow ON tenant.ozon_order_costs_shadow
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='ozon_order_costs_shadow' AND policyname='panel_local_ro_cab1') THEN
        CREATE POLICY panel_local_ro_cab1 ON tenant.ozon_order_costs_shadow
        FOR SELECT TO panel_local_ro
        USING (cabinet_id = 1);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ozon_order_costs_shadow TO saas_app;
-- panel_local_ro_cab1 без базового GRANT SELECT бесполезна (RLS не заменяет
-- табличную привилегию) — оригинал ozon_order_costs имеет такой же грант.
GRANT SELECT ON tenant.ozon_order_costs_shadow TO panel_local_ro;

COMMIT;
