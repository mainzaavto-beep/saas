-- Смоук-сторож «Склады 2.0», этап 2 «Учёт». Запуск:
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage2.sql
-- Все проверки должны отдать ok=t (кабинет #1; под saas_ro RLS не скоупит — WHERE явно).

-- 1. Инвариант ledger: остаток каждой позиции = сумма её движений
SELECT 'ledger_invariant' AS check,
       COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s, 0)) = 0 AS ok,
       COUNT(*) AS positions, COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s, 0)) AS mismatch
FROM tenant.ff_inventory f
LEFT JOIN (SELECT ff_inventory_id, SUM(qty) AS s FROM tenant.stock_moves WHERE cabinet_id=1 GROUP BY 1) m
       ON m.ff_inventory_id = f.id
WHERE f.cabinet_id=1;

-- 2. Начальное сальдо записано для всех ненулевых позиций на момент миграции
SELECT 'opening_balance' AS check,
       COUNT(*) > 0 AND COUNT(*) FILTER (WHERE kind <> 'adjust' OR src_kind <> 'manual') = 0 AS ok,
       COUNT(*) AS opening_moves, SUM(qty) AS opening_qty
FROM tenant.stock_moves WHERE cabinet_id=1 AND src_ref LIKE 'opening:%';

-- 3. Дублей источника нет (уникальный индекс держит; проверка на всякий случай)
SELECT 'no_duplicate_sources' AS check,
       COUNT(*) = 0 AS ok, COUNT(*) AS dups
FROM (SELECT src_kind, src_ref, kind FROM tenant.stock_moves WHERE cabinet_id=1 GROUP BY 1,2,3 HAVING COUNT(*) > 1) d;

-- 4. Каждое отгруженное WB-задание с warehouse_id либо списано, либо в открытом пробеле.
-- Кабинет без активных мест с привязкой к складу WB ФФ-контур не использует: разносить
-- некуда, движений и пробелов нет и быть не должно — проверка вакуумно истинна.
SELECT 'wb_tasks_accounted' AS check,
       NOT (SELECT EXISTS (SELECT 1 FROM tenant.stock_ff_locations
                           WHERE cabinet_id=1 AND is_active AND wb_warehouse_id IS NOT NULL))
       OR (COUNT(*) > 0 AND COUNT(*) FILTER (WHERE mv.src_ref IS NULL AND g.src_ref IS NULL) = 0) AS ok,
       COUNT(*) AS shipped_tasks,
       COUNT(mv.src_ref) AS written_off, COUNT(g.src_ref) AS gaps_open,
       COUNT(*) FILTER (WHERE mv.src_ref IS NULL AND g.src_ref IS NULL) AS unaccounted
FROM tenant.wb_fbs_tasks t
LEFT JOIN tenant.wb_supplies s ON s.cabinet_id=t.cabinet_id AND s.supply_id=t.supply_id
LEFT JOIN (SELECT DISTINCT split_part(src_ref,'#',1) AS src_ref FROM tenant.stock_moves WHERE cabinet_id=1 AND src_kind='wb_fbs_task' AND kind='out_fbs') mv ON mv.src_ref=t.rid
LEFT JOIN tenant.stock_move_gaps g ON g.cabinet_id=t.cabinet_id AND g.src_kind='wb_fbs_task' AND g.src_ref=t.rid AND g.resolved_at IS NULL
WHERE t.cabinet_id=1 AND t.warehouse_id IS NOT NULL AND t.nm_id IS NOT NULL
  AND (s.closed_at IS NOT NULL OR t.wb_status IN ('sorted','ready_for_pickup','sold'))
  AND COALESCE(t.wb_status,'') NOT IN ('canceled_by_client','declined_by_client','defect','canceled');

-- 5. То же для Ozon FBS-постингов (та же вакуумная истина без привязанных мест Ozon)
SELECT 'ozon_postings_accounted' AS check,
       NOT (SELECT EXISTS (SELECT 1 FROM tenant.stock_ff_locations
                           WHERE cabinet_id=1 AND is_active AND ozon_warehouse_id IS NOT NULL))
       OR (COUNT(*) > 0 AND COUNT(*) FILTER (WHERE mv.src_ref IS NULL AND g.src_ref IS NULL) = 0) AS ok,
       COUNT(*) AS shipped_postings, COUNT(mv.src_ref) AS written_off, COUNT(g.src_ref) AS gaps_open
FROM tenant.ozon_orders o
LEFT JOIN (SELECT DISTINCT split_part(src_ref,'#',1) AS src_ref FROM tenant.stock_moves WHERE cabinet_id=1 AND src_kind='ozon_posting' AND kind='out_fbs') mv
       ON mv.src_ref = o.posting_number||':'||o.product_id
LEFT JOIN tenant.stock_move_gaps g ON g.cabinet_id=o.cabinet_id AND g.src_kind='ozon_posting' AND g.src_ref=o.posting_number||':'||o.product_id AND g.resolved_at IS NULL
WHERE o.cabinet_id=1 AND o.scheme='fbs' AND o.warehouse_id IS NOT NULL AND o.status IN ('awaiting_deliver','delivering','delivered');

-- 6. Возвраты не превышают списаний по той же позиции и источнику.
-- split_part(src_ref,'#',1) сводит к базовому рефу оба суффикса: '#<ff_inventory_id>'
-- (разнесение по партиям) и '#r<n>' (второй и последующий частичный возврат).
SELECT 'returns_not_exceed' AS check, COUNT(*) = 0 AS ok, COUNT(*) AS bad
FROM (SELECT ff_inventory_id, split_part(src_ref,'#',1) AS ref,
             SUM(qty) FILTER (WHERE kind='out_fbs') AS out_q, SUM(qty) FILTER (WHERE kind='return_in') AS ret_q
      FROM tenant.stock_moves WHERE cabinet_id=1 AND src_kind IN ('wb_fbs_task','ozon_posting') GROUP BY 1,2
      HAVING COALESCE(SUM(qty) FILTER (WHERE kind='return_in'),0) > -COALESCE(SUM(qty) FILTER (WHERE kind='out_fbs'),0)) x;
