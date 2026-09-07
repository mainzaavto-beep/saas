-- 056_wb_incomes_declared.sql — Склады 2.0, этап 3, фикс раунд 1 (задача 2).
-- Источник приёмок FBO сменился: старый statistics-api /api/v1/supplier/incomes
-- отключён WB (404 на гейтвее ag-statistics, живая проба 2026-09-07) — новый
-- источник supplies-api (POST /api/v1/supplies + GET .../{id} + .../{id}/goods,
-- см. worker/collectors/wb_incomes.py) отдаёт заявленное количество (quantity) и
-- принятое (acceptedQuantity) РАЗДЕЛЬНО по строке товара. quantity в таблице
-- остаётся «принято» (NULL до факта приёмки, как раньше) — добавляем отдельную
-- колонку под заявленное. Идемпотентно.
BEGIN;

ALTER TABLE tenant.wb_incomes ADD COLUMN IF NOT EXISTS quantity_declared INTEGER;

COMMIT;
