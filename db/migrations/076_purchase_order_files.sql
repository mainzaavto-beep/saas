-- 076_purchase_order_files.sql — документы заказа закупки: накладные карго и фабрик (02.11.2026).
-- Видит ТОЛЬКО владелец кабинета (роут purchase-orders/files — requireRole 'owner'), менеджерам не
-- отдаются ни файлы, ни их список (решение владельца: контакты поставщиков не должны утечь).
-- Байты лежат в БД (bytea): попадают в ночной дамп saas-backup и под ту же RLS. Проверки типа/размера —
-- lib/purchaseOrderFiles.js. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.purchase_order_files (
    cabinet_id   BIGINT      NOT NULL,
    id           BIGSERIAL   NOT NULL,
    order_id     BIGINT      NOT NULL,
    kind         TEXT        NOT NULL CHECK (kind IN ('cargo','factory','other')),
    file_name    TEXT        NOT NULL CHECK (length(btrim(file_name)) > 0),
    mime         TEXT        NOT NULL,
    size_bytes   INTEGER     NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    data         BYTEA       NOT NULL,
    note         TEXT,
    uploaded_by  BIGINT,
    deleted_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    FOREIGN KEY (cabinet_id, order_id) REFERENCES tenant.purchase_orders (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS ix_po_files_order ON tenant.purchase_order_files (cabinet_id, order_id);

ALTER TABLE tenant.purchase_order_files ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='purchase_order_files'
                 AND policyname='tenant_iso_purchase_order_files') THEN
    CREATE POLICY tenant_iso_purchase_order_files ON tenant.purchase_order_files FOR ALL TO saas_app
      USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
      WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
  END IF;
END $$;
-- panel_local_ro (локальная панель владельца) намеренно НЕ получает доступ: там нет проверки роли.
GRANT SELECT, INSERT, UPDATE ON tenant.purchase_order_files TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.purchase_order_files_id_seq TO saas_app;
-- Авторазбор падений (claude под saas_triage) накладные не читает: default privileges дали бы ему SELECT.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='saas_triage') THEN
    REVOKE ALL ON tenant.purchase_order_files FROM saas_triage;
  END IF;
END $$;

COMMIT;
