-- 018_balance_account_catalog.sql — постоянный каталог счетов баланса.
--
-- Недореализованная фича (заявка №38-счета): UI баланса (/fin-balance) ведёт
-- редактируемый каталог счетов (add/rename/soft-delete), но таблицы под него
-- не было — catalog всегда пуст → фронт показывал «нет счетов», хотя суммы по
-- счетам в balance_accounts были.
--
-- balance_account_catalog — постоянный список названий счетов (cross-snapshot),
-- в отличие от balance_accounts, который хранит суммы на ДАТУ (snapshot-строки).
-- sort_order — ручная сортировка; archived — soft-delete (1 = скрыт из UI).

CREATE TABLE IF NOT EXISTS tenant.balance_account_catalog (
    cabinet_id   BIGINT NOT NULL,
    id           BIGSERIAL,
    subject      TEXT NOT NULL,                  -- 'ip' | 'person'
    account_name TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    archived     INTEGER NOT NULL DEFAULT 0,     -- 0 = активен, 1 = скрыт (soft-delete)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, subject, account_name)
);

-- ========== RLS (тот же паттерн, что balance_accounts в 009) ==========
DO $$
BEGIN
    EXECUTE 'ALTER TABLE tenant.balance_account_catalog ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_balance_account_catalog') THEN
        EXECUTE $f$
            CREATE POLICY tenant_iso_balance_account_catalog
            ON tenant.balance_account_catalog FOR ALL TO saas_app
            USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
            WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)
        $f$;
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.balance_account_catalog TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.balance_account_catalog_id_seq TO saas_app;

-- ========== Seed: заполнить каталог существующими счетами ==========
-- DISTINCT (subject, account_name) из balance_accounts — чтобы 8 текущих счетов
-- cabinet #1 сразу появились в дропдаунах. ON CONFLICT — идемпотентно при повторах.
INSERT INTO tenant.balance_account_catalog (cabinet_id, subject, account_name, sort_order)
SELECT DISTINCT b.cabinet_id, b.subject, b.account_name, 0
FROM tenant.balance_accounts b
WHERE b.account_name IS NOT NULL AND b.account_name <> ''
  AND NOT EXISTS (
      SELECT 1 FROM tenant.balance_account_catalog c
      WHERE c.cabinet_id = b.cabinet_id
        AND c.subject = b.subject
        AND c.account_name = b.account_name
  );
