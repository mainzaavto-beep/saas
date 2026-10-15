-- 069_purchase_receipts.sql — «Доставлено на склад» (15.10.2026, спека
-- docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md): партия закупки после
-- «✓ Доставлено» ждёт приёмки ФФ; приёмка = строки «артикул → принято, шт». Конечная точка:
-- ни ff_inventory, ни stock_moves, ни cost_overrides эти данные не трогают. Идемпотентно.
BEGIN;

ALTER TABLE tenant.purchases ADD COLUMN IF NOT EXISTS delivered_at    DATE;
ALTER TABLE tenant.purchases ADD COLUMN IF NOT EXISTS receipt_done_at TIMESTAMPTZ;
ALTER TABLE tenant.purchases ADD COLUMN IF NOT EXISTS receipt_done_by BIGINT;

-- Уже завершённые партии появляются на странице «Ждёт приёмки».
UPDATE tenant.purchases
   SET delivered_at = COALESCE(CASE WHEN delivery_dt ~ '^\d{4}-\d{2}-\d{2}' THEN substr(delivery_dt,1,10)::date END, created_at::date)
 WHERE archived AND delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant.purchase_receipt_lines (
    cabinet_id   BIGINT      NOT NULL,
    id           BIGSERIAL   NOT NULL,
    purchase_id  BIGINT      NOT NULL,
    platform     TEXT        CHECK (platform IN ('wb', 'ozon')),
    nm_id        BIGINT,
    product_id   BIGINT,
    label        TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
    qty_accepted INTEGER     NOT NULL CHECK (qty_accepted >= 0),
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, purchase_id) REFERENCES tenant.purchases (cabinet_id, id),
    CHECK (
      (platform = 'wb'   AND nm_id IS NOT NULL AND product_id IS NULL) OR
      (platform = 'ozon' AND product_id IS NOT NULL AND nm_id IS NULL) OR
      (platform IS NULL  AND nm_id IS NULL AND product_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS ix_purchase_receipt_lines_purchase
    ON tenant.purchase_receipt_lines (cabinet_id, purchase_id);

DO $$
DECLARE t TEXT := 'purchase_receipt_lines';
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
