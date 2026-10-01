-- 063_wb_daily_stock_sizes.sql — остатки WB по размерам (chrt_id).
--
-- stocks-report/wb-warehouses отдаёт строку на каждый chrtId (размер внутри
-- карточки nm_id). tenant.wb_daily_stock хранит их СВЁРНУТЫМИ в (nm_id, склад)
-- (ГРАБЛЯ chrtId в worker/collectors/wb_stocks.py) — её не трогаем. Эта таблица —
-- вторая запись того же снимка без свёртки, для поразмерного вида на /stocks.
-- Имя размера (tech_size) в ответе WB нет — панель берёт его из tenant.wb_barcodes.
-- Инвариант: Σ по chrt_id на (nm_id, date, warehouse) = строка wb_daily_stock.
-- История начинается с 2026-10-01 (WB исторические остатки не отдаёт). Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.wb_daily_stock_sizes (
    cabinet_id    BIGINT  NOT NULL,
    nm_id         BIGINT  NOT NULL,
    chrt_id       BIGINT  NOT NULL,           -- 0, если WB не прислал chrtId
    date          DATE    NOT NULL,
    warehouse     TEXT    NOT NULL,
    warehouse_id  BIGINT,
    quantity      INTEGER,                    -- доступно к продаже (канон покрытия)
    quantity_full INTEGER,                    -- quantity + in_way_to + in_way_from
    in_way_to     INTEGER,
    in_way_from   INTEGER,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, nm_id, chrt_id, date, warehouse)
);
CREATE INDEX IF NOT EXISTS wb_daily_stock_sizes_date_idx ON tenant.wb_daily_stock_sizes (cabinet_id, date);

DO $$
DECLARE t TEXT := 'wb_daily_stock_sizes';
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
  EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
END $$;

COMMIT;
