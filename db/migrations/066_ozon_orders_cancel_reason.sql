-- 066: причины отмен Ozon в tenant.ozon_orders (12.10.2026, решение владельца — канон невыкупа Ozon,
-- docs/metrics-contract.md §18.3). Источник — cancellation.{cancel_reason, cancellation_type,
-- cancellation_initiator} из /v3/posting/fbo/list и /v3/posting/fbs/list (оба отдают объект).
-- Гранты: у tenant.ozon_orders табличные (saas_app arwd, saas_ro/panel_local_ro/saas_triage r) —
-- новые колонки их наследуют, колоночных грантов нет. RLS-политика таблицы колонки не касается.
ALTER TABLE tenant.ozon_orders
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancellation_type text,
  ADD COLUMN IF NOT EXISTS cancel_initiator text;
