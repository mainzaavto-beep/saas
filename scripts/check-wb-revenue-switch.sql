-- scripts/check-wb-revenue-switch.sql — сторож переезда выручки WB
-- («выручка WB по цене со скидкой продавца», 06.09.2026, spec
-- docs/superpowers/specs/2026-09-06-wb-revenue-by-price-design.md).
--
-- Что сторожит:
--   1) rawProfit/cogs/logistics/payout/realized помесячно — БИТ-В-БИТ с
--      снимком «до» (scratchpad wb-canon-baseline-2026-09-06.txt): переезд
--      меняет ТОЛЬКО состав выручки и налоговую базу, сами строки
--      order_costs не пересобираются. Разошлось — переезд задел данные;
--   2) cost_value_withdisc заполнен (null_withdisc = 0) — иначе выручка
--      канона молча занижается на NULL-строках;
--   3) withdisc_lt_realized — цена со скидкой продавца НЕ МЕНЬШЕ
--      «реализовано», то есть spp = revenue − realized ≥ 0 на каждой
--      строке продажи. Отрицательный spp — обычно частично заполненный/
--      NULL cost_value_withdisc (СПП не может быть отрицательной: WB не
--      продаёт дороже цены продавца).
--      ⚠️ ИЗВЕСТНОЕ ИСКЛЮЧЕНИЕ на 06.09.2026 (кабинет 1): ОДНА строка из
--      2379 — 2026-06, nm_id 831685664, srid
--      ebT.ib99b84823cb493d267accd5fa1289815.0.0, withdisc 2257,84 <
--      retail 2276,27, spp = −18,43 ₽. Это данные САМОГО WB (в
--      tenant.wb_finance_report у строки «Продажа» ровно эти два числа) —
--      не дыра бэкфилла и не баг канона; на прибыль не влияет (profit
--      считается от payout). Ожидание: 2026-06 → 1, остальные месяцы → 0.
--      Любая ДРУГАЯ строка — регресс, разбирать вторым запросом ниже.
--
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-wb-revenue-switch.sql
SELECT substr(COALESCE(sale_dt,return_dt),1,7) AS m, COUNT(*) n,
       ROUND(SUM(cost_value_withdisc)::numeric,2) AS revenue,
       ROUND(SUM(cost_value_retail)::numeric,2) AS realized,
       ROUND(SUM(cost_value_pay)::numeric,2) AS payout,
       ROUND(SUM(cost)::numeric,2) AS cogs, ROUND(SUM(logistics)::numeric,2) AS logistics,
       ROUND(SUM(profit)::numeric,2) AS raw_profit,
       COUNT(*) FILTER (WHERE cost_value_withdisc IS NULL) AS null_withdisc,
       COUNT(*) FILTER (WHERE is_return=0 AND cost_value_withdisc < cost_value_retail - 0.01) AS withdisc_lt_realized
FROM tenant.wb_order_costs WHERE cabinet_id=1 GROUP BY 1 ORDER BY 1;
-- ok: null_withdisc=0 везде; withdisc_lt_realized=0, КРОМЕ 2026-06 (=1, известное
-- исключение выше — сама выгрузка WB); revenue (Σ withdisc) на 06.09.2026:
-- 2026-05: 2107415.55; 2026-06: 1305084.70; 2026-07: 1270392.81; 2026-08: 877498.97;
-- payout/realized/cogs/logistics/raw_profit = снимок «до» (2026-05: 1412170.27/1524641.21/727842.00/111298.63/573029.64;
-- 2026-06: 894789.86/878716.46/483215.00/57679.05/353895.81; 2026-07: 796215.76/818305.82/387800.00/57208.38/351207.38;
-- 2026-08: 504154.17/597758.83/243450.00/28232.28/232471.89 — сентябрь растёт, не сравнивается).

-- Построчный сторож spp ≥ 0 (тот же смысл, что withdisc_lt_realized выше,
-- но с «уликами»): при регрессе печатает до 20 худших строк — по ним сразу
-- видно, это дыра сборщика (withdisc IS NULL) или реальная аномалия цены.
-- ok: РОВНО одна строка — известное исключение 2026-06 из шапки
-- (nm_id 831685664, spp = −18,43 ₽). Появилась вторая — регресс.
SELECT substr(COALESCE(sale_dt,return_dt),1,7) AS m, nm_id, srid,
       cost_value_withdisc, cost_value_retail,
       ROUND((cost_value_withdisc - cost_value_retail)::numeric,2) AS spp
FROM tenant.wb_order_costs
WHERE cabinet_id=1 AND is_return=0
  AND (cost_value_withdisc IS NULL OR cost_value_withdisc < cost_value_retail - 0.01)
ORDER BY (cost_value_withdisc - cost_value_retail) NULLS FIRST
LIMIT 20;
