-- 074_cost_calcs.sql — «Калькулятор себестоимости» (22.10.2026): сохранённые расчёты себестоимости
-- товара из Китая до ФФ. Храним только ввод — результат всегда считает lib/costCalc.js.
-- Прикидка, не учёт: с закупками и cost_overrides не связана. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.cost_calcs (
    cabinet_id          BIGINT      NOT NULL,
    id                  BIGSERIAL   NOT NULL,
    name                TEXT        NOT NULL,
    qty                 NUMERIC     NOT NULL DEFAULT 0,
    weight_kg           NUMERIC     NOT NULL DEFAULT 0,   -- вес 1 шт
    price_cny           NUMERIC     NOT NULL DEFAULT 0,   -- цена 1 шт, ¥
    china_delivery_cny  NUMERIC     NOT NULL DEFAULT 0,   -- доставка по Китаю, ¥ за партию
    cargo_usd_per_kg    NUMERIC     NOT NULL DEFAULT 0,   -- ставка карго, $/кг
    ff_logistics_rub    NUMERIC     NOT NULL DEFAULT 0,   -- карго → ФФ, ₽ за партию
    rate_cny            NUMERIC     NOT NULL DEFAULT 0,   -- ₽ за ¥
    rate_usd            NUMERIC     NOT NULL DEFAULT 0,   -- ₽ за $
    note                TEXT        NOT NULL DEFAULT '',
    created_by          BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

DO $$
DECLARE t TEXT := 'cost_calcs';
BEGIN
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
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tenant.%I TO saas_app', t || '_id_seq');
  EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
END $$;

COMMIT;
