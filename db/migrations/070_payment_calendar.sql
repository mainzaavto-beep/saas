-- 070_payment_calendar.sql — платёжный календарь и план поступлений (15.10.2026, спека
-- docs/superpowers/specs/2026-10-15-payment-calendar-design.md). dds_movements — единственная
-- таблица денег: planned → paid. Источник строки — source_kind/source_ref. Идемпотентно.
BEGIN;

ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS source_kind    TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS source_ref     TEXT;
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS amount_planned NUMERIC;
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS date_locked    BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dds_movements_source_kind_chk') THEN
    ALTER TABLE tenant.dds_movements ADD CONSTRAINT dds_movements_source_kind_chk
      CHECK (source_kind IN ('manual','recurring','purchase','mp_payout'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dds_movements_source
    ON tenant.dds_movements (cabinet_id, source_kind, source_ref)
 WHERE source_ref IS NOT NULL AND status <> 'archived';
CREATE INDEX IF NOT EXISTS ix_dds_movements_date ON tenant.dds_movements (cabinet_id, date);

CREATE TABLE IF NOT EXISTS tenant.dds_recurring (
    cabinet_id   BIGINT      NOT NULL,
    id           BIGSERIAL   NOT NULL,
    type         TEXT        NOT NULL CHECK (type IN ('income','expense')),
    amount       NUMERIC     NOT NULL CHECK (amount > 0),
    category     TEXT,
    counterparty TEXT,
    description  TEXT,
    rule         TEXT        NOT NULL CHECK (rule IN ('monthly','weekly','every_n_days')),
    rule_day     INTEGER,
    every_n      INTEGER,
    date_from    DATE        NOT NULL,
    date_to      DATE,
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    CHECK ((rule = 'monthly' AND rule_day BETWEEN 1 AND 31) OR
           (rule = 'weekly' AND rule_day BETWEEN 1 AND 7) OR
           (rule = 'every_n_days' AND every_n BETWEEN 1 AND 365))
);

DO $$
DECLARE t TEXT := 'dds_recurring';
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
