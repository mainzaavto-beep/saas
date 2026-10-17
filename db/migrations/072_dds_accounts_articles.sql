-- 072_dds_accounts_articles.sql — ДДС: справочники счетов и статей, счёт/статья у движения, перевод
-- (17.10.2026, спека docs/superpowers/specs/2026-10-17-dds-design.md §2). Идемпотентно.
-- Устаревшие колонки dds_movements (category, income_type, account_from, account_to, source, nm_id)
-- код больше не читает и не пишет; platform пишет только receivePayout. Удаление — отдельной задачей.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.dds_accounts (
    cabinet_id      BIGINT        NOT NULL,
    id              BIGSERIAL     NOT NULL,
    name            TEXT          NOT NULL,
    kind            TEXT          NOT NULL DEFAULT 'other'
                    CHECK (kind IN ('bank_ip','card_person','cash','mp_wb','mp_ozon','other')),
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    opening_date    DATE          NOT NULL,
    sort            INTEGER       NOT NULL DEFAULT 0,
    is_archived     BOOLEAN       NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

CREATE TABLE IF NOT EXISTS tenant.dds_articles (
    cabinet_id  BIGINT      NOT NULL,
    key         TEXT        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    label       TEXT        NOT NULL,
    direction   TEXT        NOT NULL CHECK (direction IN ('income','expense')),
    activity    TEXT        NOT NULL CHECK (activity IN ('operating','investing','financing')),
    color       TEXT        NOT NULL DEFAULT 'line',
    sort        INTEGER     NOT NULL DEFAULT 0,
    is_system   BOOLEAN     NOT NULL DEFAULT false,
    is_archived BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, key)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dds_accounts','dds_articles'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='tenant_iso_'||t) THEN
      EXECUTE format($p$CREATE POLICY %I ON tenant.%I FOR ALL TO saas_app
                       USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                       WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)$p$, 'tenant_iso_'||t, t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='panel_local_ro_cab1') THEN
      EXECUTE format('CREATE POLICY panel_local_ro_cab1 ON tenant.%I FOR SELECT TO panel_local_ro USING (cabinet_id = 1)', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON tenant.%I TO saas_app', t);
    EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
  END LOOP;
  EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tenant.dds_accounts_id_seq TO saas_app';
END $$;

ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS account_id    BIGINT;
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS account_to_id BIGINT;
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS article_key   TEXT;
ALTER TABLE tenant.dds_recurring ADD COLUMN IF NOT EXISTS article_key   TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dds_movements_type_chk') THEN
    ALTER TABLE tenant.dds_movements ADD CONSTRAINT dds_movements_type_chk
      CHECK (type IN ('income','expense','transfer'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dds_movements_transfer_chk') THEN
    ALTER TABLE tenant.dds_movements ADD CONSTRAINT dds_movements_transfer_chk
      CHECK ((type = 'transfer' AND article_key IS NULL AND account_id IS NOT NULL
              AND account_to_id IS NOT NULL AND account_id <> account_to_id)
          OR (type <> 'transfer' AND account_to_id IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_dds_movements_paid ON tenant.dds_movements (cabinet_id, date) WHERE status = 'paid';

-- Перенос category → article_key. Правило = articleKeyOf в lib/dds.js (менять вместе).
UPDATE tenant.dds_movements SET article_key = CASE
    WHEN type = 'income' THEN CASE
      WHEN source_kind = 'mp_payout' AND platform = 'wb'   THEN 'mp_wb'
      WHEN source_kind = 'mp_payout' AND platform = 'ozon' THEN 'mp_ozon'
      WHEN category IN ('Выплата МП','Возврат МП')         THEN 'mp'
      ELSE 'other_in' END
    ELSE CASE
      WHEN category IN ('Поставщик','Закупка') THEN 'supplier'
      WHEN category = 'Карго/логистика'       THEN 'cargo'
      WHEN category = 'Фулфилмент'            THEN 'ff'
      WHEN category = 'Налоги'                THEN 'tax'
      WHEN category IN ('Зарплата','ЗП')      THEN 'salary'
      WHEN category = 'Аренда'                THEN 'rent'
      WHEN category = 'Подписки'              THEN 'subs'
      WHEN category = 'Реклама'               THEN 'ads'
      ELSE 'other' END
  END
 WHERE article_key IS NULL AND type IN ('income','expense');

UPDATE tenant.dds_recurring SET article_key = CASE
    WHEN type = 'income' THEN CASE WHEN category IN ('Выплата МП','Возврат МП') THEN 'mp' ELSE 'other_in' END
    ELSE CASE
      WHEN category IN ('Поставщик','Закупка') THEN 'supplier'
      WHEN category = 'Карго/логистика'       THEN 'cargo'
      WHEN category = 'Фулфилмент'            THEN 'ff'
      WHEN category = 'Налоги'                THEN 'tax'
      WHEN category IN ('Зарплата','ЗП')      THEN 'salary'
      WHEN category = 'Аренда'                THEN 'rent'
      WHEN category = 'Подписки'              THEN 'subs'
      WHEN category = 'Реклама'               THEN 'ads'
      ELSE 'other' END
  END
 WHERE article_key IS NULL;

-- Стартовые счета — только кабинет #1, из последнего снимка «Баланса», если счетов ещё нет.
INSERT INTO tenant.dds_accounts (cabinet_id, name, kind, opening_balance, opening_date, sort)
SELECT 1,
       b.account_name || CASE WHEN b.subject = 'ip' THEN ' (ИП)' ELSE ' (физлицо)' END,
       CASE WHEN b.account_name = 'ВБ' THEN 'mp_wb' WHEN b.subject = 'ip' THEN 'bank_ip' ELSE 'card_person' END,
       b.amount, b.as_of_date::date,
       row_number() OVER (ORDER BY b.subject, b.id)
  FROM tenant.balance_accounts b
 WHERE b.cabinet_id = 1
   AND b.as_of_date = (SELECT max(as_of_date) FROM tenant.balance_accounts WHERE cabinet_id = 1)
   AND NOT EXISTS (SELECT 1 FROM tenant.dds_accounts WHERE cabinet_id = 1);

COMMIT;
