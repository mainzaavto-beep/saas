-- 054_stock_ledger.sql — Склады 2.0, этап 2 «Учёт» (спека §3).
-- Журнал движений поверх ff_inventory.qty: каждое изменение остатка — строка
-- stock_moves; qty позиции = сумма движений (сторож scripts/check-warehouses-stage2.sql).
-- stock_move_gaps — задания/постинги FBS, которые не удалось разнести (нет места,
-- нет позиции, не хватило остатка). ff_transfer_docs/lines — перемещение ФФ→ФФ.
-- Начальное сальдо: по одному движению adjust на каждую позицию с qty<>0, чтобы
-- инвариант «qty = SUM(stock_moves.qty)» выполнялся с первого дня. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.stock_moves (
    cabinet_id      BIGINT      NOT NULL,
    id              BIGSERIAL,
    ff_inventory_id BIGINT      NOT NULL,                  -- → ff_inventory.id (логический FK)
    location_id     BIGINT,                                -- место на момент движения (NULL — позиция без места)
    kind            TEXT        NOT NULL CHECK (kind IN ('in','out_fbo','out_fbs','transfer_out','transfer_in','adjust','return_in')),
    qty             INTEGER     NOT NULL,                  -- со знаком: приход +, списание −
    src_kind        TEXT        NOT NULL CHECK (src_kind IN ('purchase','ff_shipment_doc','wb_fbs_task','ozon_posting','transfer_doc','manual','wb_fbs_return','ozon_return')),
    src_ref         TEXT        NOT NULL,                  -- id/rid/posting_number источника
    moved_at        TIMESTAMPTZ NOT NULL,
    note            TEXT,
    created_by      BIGINT,                                -- auth user_id; NULL — воркер/миграция
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_moves_src_uq ON tenant.stock_moves (cabinet_id, src_kind, src_ref, kind);
CREATE INDEX IF NOT EXISTS stock_moves_inv_idx ON tenant.stock_moves (cabinet_id, ff_inventory_id);
CREATE INDEX IF NOT EXISTS stock_moves_moved_idx ON tenant.stock_moves (cabinet_id, moved_at);

CREATE TABLE IF NOT EXISTS tenant.stock_move_gaps (
    cabinet_id    BIGINT NOT NULL,
    id            BIGSERIAL,
    src_kind      TEXT   NOT NULL,
    src_ref       TEXT   NOT NULL,
    platform      TEXT   NOT NULL CHECK (platform IN ('wb','ozon')),
    warehouse_id  BIGINT,
    sku_key       BIGINT,                                  -- wb: nm_id; ozon: product_id
    qty           INTEGER NOT NULL,
    reason        TEXT   NOT NULL CHECK (reason IN ('no_location','no_item','insufficient')),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ,
    PRIMARY KEY (cabinet_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_move_gaps_src_uq ON tenant.stock_move_gaps (cabinet_id, src_kind, src_ref);
CREATE INDEX IF NOT EXISTS stock_move_gaps_open_idx ON tenant.stock_move_gaps (cabinet_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant.ff_transfer_docs (
    cabinet_id       BIGINT NOT NULL,
    id               BIGSERIAL,
    from_location_id BIGINT NOT NULL,
    to_location_id   BIGINT NOT NULL,
    moved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    note             TEXT,
    created_by       BIGINT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    CHECK (from_location_id <> to_location_id)
);
CREATE TABLE IF NOT EXISTS tenant.ff_transfer_lines (
    cabinet_id         BIGINT  NOT NULL,
    id                 BIGSERIAL,
    doc_id             BIGINT  NOT NULL,
    ff_inventory_id    BIGINT  NOT NULL,                   -- позиция-источник
    to_ff_inventory_id BIGINT  NOT NULL,                   -- позиция-приёмник (найдена или создана)
    qty                INTEGER NOT NULL CHECK (qty > 0),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS ff_transfer_lines_doc_idx ON tenant.ff_transfer_lines (cabinet_id, doc_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_moves','stock_move_gaps','ff_transfer_docs','ff_transfer_lines'] LOOP
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
  END LOOP;
END $$;

-- Начальное сальдо: qty на момент миграции = одно движение adjust (все кабинеты;
-- миграция идёт под postgres, RLS не мешает). Повторный запуск — ON CONFLICT DO NOTHING.
INSERT INTO tenant.stock_moves (cabinet_id, ff_inventory_id, location_id, kind, qty, src_kind, src_ref, moved_at, note)
SELECT f.cabinet_id, f.id, f.location_id, 'adjust', f.qty, 'manual', 'opening:' || f.id, now(),
       'начальное сальдо 2026-09-06 (миграция 054)'
FROM tenant.ff_inventory f
WHERE f.qty <> 0
ON CONFLICT (cabinet_id, src_kind, src_ref, kind) DO NOTHING;

COMMIT;
