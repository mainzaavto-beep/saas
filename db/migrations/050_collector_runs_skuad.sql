-- 050_collector_runs_skuad.sql — run_kind 'skuad' для ночного тика ozon_sku_ad.
-- Таймер saas-sku-ad-night (03:30 MSK, с 05.09.2026) зовёт
-- run_saas_collect.sh skuad → orchestrator --run-kind skuad, а CHECK из 031
-- этот вид не знал: первый прогон 06.09.2026 08:22 (догон после простоя) не
-- записал ни одной строки в jobs.collector_runs — «violates check constraint
-- collector_runs_run_kind_check». Сбор при этом не ломался, но тик был слеп
-- для /api/health и для «умного ритма» самого сборщика (свежий ok читается
-- из этой же таблицы). Идемпотентно.
BEGIN;

ALTER TABLE jobs.collector_runs DROP CONSTRAINT IF EXISTS collector_runs_run_kind_check;
ALTER TABLE jobs.collector_runs ADD CONSTRAINT collector_runs_run_kind_check CHECK (run_kind IN
    ('main','stocks','metrics30m','references','backfill','systemd','manual','skuad'));

COMMIT;
