-- 051_wb_fbs_status.sql — статусы FBS-заданий WB и момент «доехало до ПВЗ»
-- (запрос владельца 06.09.2026: «ещё едут» в «До покупателя» смешивало
-- «едет» и «лежит на ПВЗ, покупатель не пришёл» — нужна колонка «До ПВЗ»).
-- marketplace-api POST /api/v3/orders/status отдаёт ТОЛЬКО текущий wbStatus
-- (waiting/sorted/ready_for_pickup/sold/canceled/canceled_by_client/
-- declined_by_client/defect) без времени смены (проба 06.09) — момент
-- прибытия ловим сами: часовой опрос (таймер saas-fbs-status, сборщик
-- wb_fbs_status) ставит pvz_at при переходе waiting|sorted → ready_for_pickup.
-- Задания, уже лежавшие на ПВЗ/выкупленные на момент первого опроса,
-- остаются без pvz_at — честный NULL, а не «сейчас».
-- run_kind 'fbsstatus' — метка часового тика в jobs.collector_runs.
-- Идемпотентно.
BEGIN;

ALTER TABLE tenant.wb_fbs_tasks ADD COLUMN IF NOT EXISTS order_id     BIGINT;       -- id задания (ключ /orders/status)
ALTER TABLE tenant.wb_fbs_tasks ADD COLUMN IF NOT EXISTS wb_status    TEXT;         -- последний увиденный wbStatus
ALTER TABLE tenant.wb_fbs_tasks ADD COLUMN IF NOT EXISTS wb_status_at TIMESTAMPTZ;  -- когда текущий статус увиден впервые
ALTER TABLE tenant.wb_fbs_tasks ADD COLUMN IF NOT EXISTS pvz_at       TIMESTAMPTZ;  -- первый ready_for_pickup после waiting|sorted
CREATE INDEX IF NOT EXISTS wb_fbs_tasks_order_idx ON tenant.wb_fbs_tasks (cabinet_id, order_id);

ALTER TABLE jobs.collector_runs DROP CONSTRAINT IF EXISTS collector_runs_run_kind_check;
ALTER TABLE jobs.collector_runs ADD CONSTRAINT collector_runs_run_kind_check CHECK (run_kind IN
    ('main','stocks','metrics30m','references','backfill','systemd','manual','skuad','fbsstatus'));

COMMIT;
