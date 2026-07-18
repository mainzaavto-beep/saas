-- 023_ff_inventory_skus.sql — таблица-связка «позиция склада ↔ много артикулов МП».
--
-- Раньше (014) артикул МП хранился прямо в строке tenant.ff_inventory (5 колонок:
-- platform/nm_id/product_id/sku_name/im_url) → максимум 1 привязка на позицию.
-- Теперь одна позиция склада может быть привязана к нескольким артикулам с разных
-- маркетплейсов (1 товар = много SKU: WB nm_id + Ozon product_id, и т.д.).
--
-- Колонки в ff_inventory НЕ дропаем — оставляем как dead back-compat (на случай
-- сторонних читателей и для безопасного отката). Источник правды с 2026-07-18 —
-- эта таблица. GET /inventory отдаёт skus[] + плоские поля (primary = первый по
-- created_at) для обратной совместимости с любым кодом, читающим it.platform.
--
-- Контракт 2026-07-16 сохраняется: привязка НЕ пишет в cost_overrides
-- (складская unit_cost — внутренняя цифра партии; себестоимость для P&L/юнитки
-- заводится отдельно на /items).
--
-- Идемпотентна (CREATE IF NOT EXISTS + бэкпорт ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS tenant.ff_inventory_skus (
    cabinet_id      BIGINT      NOT NULL,
    id              BIGSERIAL,
    ff_inventory_id BIGINT      NOT NULL,                  -- → tenant.ff_inventory.id
    platform        TEXT        NOT NULL CHECK (platform IN ('wb','ozon')),
    nm_id           BIGINT,                                -- WB (для platform='wb')
    product_id      BIGINT,                                -- Ozon (для platform='ozon')
    sku_name        TEXT,                                  -- кэш имени карточки МП
    im_url          TEXT,                                  -- кэш фото карточки МП
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id)
);

-- Один и тот же артикул нельзя привязать дважды к одной позиции.
-- ⚠ Стандартный UNIQUE по (…, nm_id, product_id) НЕ ловит дубликаты, когда одна из
-- колонок NULL (в PG NULL != NULL): WB-привязки имеют nm_id и NULL product_id,
-- и тот же nm_id можно вставить много раз. Поэтому — ДВА partial unique indexes
-- по платформе (WHERE platform='wb' / 'ozon'), каждый только по нужному id:
CREATE UNIQUE INDEX IF NOT EXISTS uq_ff_inventory_skus_wb
    ON tenant.ff_inventory_skus (cabinet_id, ff_inventory_id, nm_id)
    WHERE platform = 'wb';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ff_inventory_skus_ozon
    ON tenant.ff_inventory_skus (cabinet_id, ff_inventory_id, product_id)
    WHERE platform = 'ozon';

-- Индекс для bulk-SELECT по позиции (GET /inventory тянет все привязки пачкой).
CREATE INDEX IF NOT EXISTS ix_ff_inventory_skus_inv
    ON tenant.ff_inventory_skus (ff_inventory_id);

-- RLS: строка видна, если cabinet_id = текущему GUC app.cabinet_id (как ff_inventory).
DROP POLICY IF EXISTS tenant_iso_ff_inventory_skus ON tenant.ff_inventory_skus;
CREATE POLICY tenant_iso_ff_inventory_skus ON tenant.ff_inventory_skus
    USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
    WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
ALTER TABLE tenant.ff_inventory_skus ENABLE ROW LEVEL SECURITY;

-- DML-гранты для роли приложения saas_app (аналогично другим tenant-таблицам;
-- saas_app не имеет прав CREATE на схему, только DML на конкретные таблицы).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ff_inventory_skus TO saas_app;
GRANT USAGE, SELECT ON SEQUENCE tenant.ff_inventory_skus_id_seq TO saas_app;

-- Бэкпорт: переносим существующие привязки из ff_inventory (legacy-колонки)
-- в новую таблицу. Идемпотентно. created_at = updated_at строки (порядок
-- добавления ≈ порядок завершения закупок / ручных правок).
INSERT INTO tenant.ff_inventory_skus
    (cabinet_id, ff_inventory_id, platform, nm_id, product_id, sku_name, im_url, created_at)
SELECT fi.cabinet_id, fi.id, fi.platform, fi.nm_id, fi.product_id, fi.sku_name, fi.im_url,
       COALESCE(fi.updated_at, fi.created_at)
FROM tenant.ff_inventory fi
WHERE fi.platform IS NOT NULL
ON CONFLICT DO NOTHING;
