-- 024_ff_shipment_docs.sql — отгрузка как документ (шапка + строки).
--
-- С 2026-07-18 отгрузка = документ (№ поставки + дата + склад назначения + платформа)
-- с составом из многих товаров. Раньше (019) модель была плоской: одна строка
-- ff_shipments = один товар, без номера поставки и склада назначения.
--
-- Старая tenant.ff_shipments НЕ дропается — остаётся как архив. Новые отгрузки
-- пишутся в ff_shipment_docs (шапка) + ff_shipment_lines (строки). Существующие
-- записи бэкпортируются (каждая старая строка → документ с одной строкой),
-- чтобы история на /inventory и /shipments была единой.
--
-- Читатели ff_shipments (по отчёту): только inventory/route.js (журнал UI) и сам
-- inventory в action shipment. P&L/баланс/ffStockValue её НЕ используют — нулевое
-- влияние на финансы. Новая страница /shipments и inventory читают новый формат.
--
-- Идемпотентна (CREATE IF NOT EXISTS + бэкпорт WHERE NOT EXISTS).

-- ── Шапка документа отгрузки ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant.ff_shipment_docs (
    cabinet_id     BIGINT NOT NULL,
    id             BIGSERIAL,
    doc_no         TEXT,                            -- № поставки (как в ЛК WB/Ozon), nullable
    platform       TEXT   NOT NULL CHECK (platform IN ('wb','ozon')),
    ship_dt        DATE   NOT NULL,                 -- дата отгрузки (по факту приёмки МП)
    dest_warehouse TEXT,                            -- склад назначения (TEXT; подсказки из собранных данных, как /move)
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS ix_ff_shipment_docs_dt ON tenant.ff_shipment_docs (ship_dt DESC);

-- ── Строки документа: что отгружено и сколько ─────────────────────────
CREATE TABLE IF NOT EXISTS tenant.ff_shipment_lines (
    cabinet_id      BIGINT  NOT NULL,
    id              BIGSERIAL,
    doc_id          BIGINT  NOT NULL,                -- → ff_shipment_docs.id (логический FK)
    ff_inventory_id BIGINT  NOT NULL,                -- → ff_inventory.id (логический FK; без CONSTRAINT из-за составного PK)
    qty             INTEGER NOT NULL CHECK (qty > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);
CREATE INDEX IF NOT EXISTS ix_ff_shipment_lines_doc ON tenant.ff_shipment_lines (doc_id);
CREATE INDEX IF NOT EXISTS ix_ff_shipment_lines_inv ON tenant.ff_shipment_lines (ff_inventory_id);

-- ── RLS + гранты (аналогично ff_inventory / ff_shipments) ─────────────
DROP POLICY IF EXISTS tenant_iso_ff_shipment_docs ON tenant.ff_shipment_docs;
CREATE POLICY tenant_iso_ff_shipment_docs ON tenant.ff_shipment_docs
    USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
    WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
ALTER TABLE tenant.ff_shipment_docs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso_ff_shipment_lines ON tenant.ff_shipment_lines;
CREATE POLICY tenant_iso_ff_shipment_lines ON tenant.ff_shipment_lines
    USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
    WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
ALTER TABLE tenant.ff_shipment_lines ENABLE ROW LEVEL SECURITY;

-- DML-гранты для saas_app (как на других tenant-таблицах; saas_app не имеет CREATE на схеме).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ff_shipment_docs TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.ff_shipment_docs_id_seq TO saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ff_shipment_lines TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.ff_shipment_lines_id_seq TO saas_app;

-- ── БЭКПОРТ: каждая старая строка ff_shipments → документ с одной строкой ──
-- Идемпотентно. Совпадение определяем по полному набору полей (platform/ship_dt/
-- note/created_at) — двух разных отгрузок с идентичным набором на практике не бывает,
-- created_at уникален до мс. Если миграция уже применялась — ничего не вставляет.
INSERT INTO tenant.ff_shipment_docs (cabinet_id, platform, ship_dt, note, created_at)
SELECT s.cabinet_id, s.platform, s.ship_dt, s.note, s.created_at
FROM tenant.ff_shipments s
WHERE NOT EXISTS (
    SELECT 1 FROM tenant.ff_shipment_docs d
    WHERE d.cabinet_id = s.cabinet_id
      AND d.platform = s.platform
      AND d.ship_dt = s.ship_dt
      AND COALESCE(d.note, '') = COALESCE(s.note, '')
      AND d.created_at = s.created_at
);

INSERT INTO tenant.ff_shipment_lines (cabinet_id, doc_id, ff_inventory_id, qty, created_at)
SELECT s.cabinet_id, d.id, s.ff_inventory_id, s.qty, s.created_at
FROM tenant.ff_shipments s
JOIN tenant.ff_shipment_docs d
  ON d.cabinet_id = s.cabinet_id
  AND d.platform = s.platform
  AND d.ship_dt = s.ship_dt
  AND COALESCE(d.note, '') = COALESCE(s.note, '')
  AND d.created_at = s.created_at
WHERE NOT EXISTS (
    SELECT 1 FROM tenant.ff_shipment_lines l
    WHERE l.cabinet_id = s.cabinet_id
      AND l.doc_id = d.id
      AND l.ff_inventory_id = s.ff_inventory_id
      AND l.qty = s.qty
);
