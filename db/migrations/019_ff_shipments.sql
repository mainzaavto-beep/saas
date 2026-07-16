-- 019_ff_shipments.sql — журнал отгрузок со склада/ФФ на маркетплейс.
--
-- Списание товара при отгрузке на МП. Раньше остаток (ff_inventory.qty) был
-- «снимком» без истории — уменьшение qty теряло след события (кто/когда/сколько/
-- на какой МП списал). Теперь каждая отгрузка фиксируется в этом журнале, а qty
-- в ff_inventory уменьшается атомарно с INSERT (нельзя списать больше остатка).
--
-- Удаление ошибочной отгрузки → qty возвращается (UPDATE + qty + $qty + DELETE).
--
-- Поля:
--   ff_inventory_id — с какой строки остатка списали (логическая FK, без CONSTRAINT
--                     т.к. у ff_inventory PK составной cabinet_id+id; ссылочность
--                     держится в API). NULL не допускаем — всегда знаем источник.
--   qty             — сколько отгружено (≥1), integer
--   platform        — назначение 'wb' | 'ozon' (маркер МП, без артикула — решение
--                     хозяина 2026-07-16)
--   ship_dt         — дата отгрузки (по факту отгрузки на МП и приёмки)
--   note            — комментарий (опц.)

CREATE TABLE IF NOT EXISTS tenant.ff_shipments (
    cabinet_id      BIGINT NOT NULL,
    id              BIGSERIAL,
    ff_inventory_id BIGINT NOT NULL,
    qty             INTEGER NOT NULL,
    platform        TEXT NOT NULL,
    ship_dt         DATE NOT NULL,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    CHECK (qty > 0),
    CHECK (platform IN ('wb', 'ozon'))
);

CREATE INDEX IF NOT EXISTS idx_ff_shipments_inv ON tenant.ff_shipments(ff_inventory_id);
CREATE INDEX IF NOT EXISTS idx_ff_shipments_dt  ON tenant.ff_shipments(ship_dt DESC);

-- ========== RLS (тот же паттерн, что ff_inventory в 014) ==========
DO $$
BEGIN
    EXECUTE 'ALTER TABLE tenant.ff_shipments ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND policyname='tenant_iso_ff_shipments') THEN
        EXECUTE $f$
            CREATE POLICY tenant_iso_ff_shipments
            ON tenant.ff_shipments FOR ALL TO saas_app
            USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
            WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)
        $f$;
    END IF;
END $$;

GRANT SELECT, INSERT, DELETE ON tenant.ff_shipments TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.ff_shipments_id_seq TO saas_app;
