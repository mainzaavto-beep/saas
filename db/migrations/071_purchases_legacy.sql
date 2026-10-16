-- 071_purchases_legacy.sql — архив «до 16.10» (решение владельца 16.10.2026): закупки,
-- сделанные ДО нового маршрута «Закупки → Доставлено на склад → приёмка по артикулам →
-- платежи в календаре», уходят в read-only архив (legacy_at). Новые закупки — по новому
-- маршруту. Только кабинет #1 (единственный боевой на эту дату). Идемпотентно.
BEGIN;

ALTER TABLE tenant.purchases ADD COLUMN IF NOT EXISTS legacy_at DATE;

UPDATE tenant.purchases
   SET legacy_at = DATE '2026-10-16'
 WHERE cabinet_id = 1
   AND deleted_at IS NULL
   AND archived
   AND legacy_at IS NULL
   AND receipt_done_at IS NULL
   AND created_at < TIMESTAMPTZ '2026-10-16 00:00+03';

-- Партия #53 — реальный аванс (владелец подтвердил факт оплаты), а не черновик плана:
-- закрываем плановую строку ДДС как оплаченную.
UPDATE tenant.dds_movements
   SET status = 'paid',
       paid_at = TIMESTAMPTZ '2026-06-25 12:00+03',
       date = '2026-06-25',
       date_locked = true,
       updated_at = now()
 WHERE cabinet_id = 1
   AND source_kind = 'purchase'
   AND source_ref LIKE 'purchase:53:%'
   AND status = 'planned';

COMMIT;
