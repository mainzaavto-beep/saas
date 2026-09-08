-- Смоук-сторож «Склады 2.0», этап 4 «Витрина». Запуск:
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage4.sql
-- Все проверки должны отдать ok=t (кабинет #1; под saas_ro RLS не скоупит — WHERE явно
-- в каждом запросе, включая подзапросы и JOIN-таблицы tenant.*).

-- 1. Регресс-сеть: инвариант ledger этапов 2-3 всё ещё держится (остаток = сумма движений).
SELECT 'ledger_invariant' AS check,
       COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s, 0)) = 0 AS ok,
       COUNT(*) AS positions, COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s, 0)) AS mismatch
FROM tenant.ff_inventory f
LEFT JOIN (SELECT ff_inventory_id, SUM(qty) AS s FROM tenant.stock_moves WHERE cabinet_id=1 GROUP BY 1) m
       ON m.ff_inventory_id = f.id
WHERE f.cabinet_id=1;

-- 2. «Свой» в матрице (lib/warehousesMetrics.js buildMatrix, ячейка ФФ: own = Σ qty позиций
-- компоненты на месте) нечему разойтись с /inventory: сумма по позициям с местом + сумма по
-- позициям без места = сумма по всем активным позициям (тождество), и отдельно — по
-- независимому GROUP BY location_id (как читает витрина по местам), чтобы поймать возможный
-- перекос группировки, а не только арифметику. Диагностика — сколько позиций/штук без места:
-- они не попадают ни в одну ФФ-колонку матрицы (buildMatrix ffCols — по location_id).
WITH inv AS (
  SELECT id, qty, location_id FROM tenant.ff_inventory WHERE cabinet_id=1 AND archived_at IS NULL
),
by_loc AS (
  SELECT location_id, SUM(qty) AS s FROM inv WHERE location_id IS NOT NULL GROUP BY 1
)
SELECT 'matrix_own_equals_inventory' AS check,
       (SELECT COALESCE(SUM(qty),0) FROM inv WHERE location_id IS NOT NULL)
         + (SELECT COALESCE(SUM(qty),0) FROM inv WHERE location_id IS NULL)
         = (SELECT COALESCE(SUM(qty),0) FROM inv)
       AND (SELECT COALESCE(SUM(s),0) FROM by_loc)
         = (SELECT COALESCE(SUM(qty),0) FROM inv WHERE location_id IS NOT NULL) AS ok,
       (SELECT COUNT(*) FROM inv) AS positions_total,
       (SELECT COALESCE(SUM(qty),0) FROM inv) AS qty_total,
       (SELECT COUNT(*) FROM inv WHERE location_id IS NULL) AS unplaced_positions,
       (SELECT COALESCE(SUM(qty),0) FROM inv WHERE location_id IS NULL) AS unplaced_units,
       (SELECT COALESCE(SUM(s),0) FROM by_loc) AS placed_units_by_group;

-- 3. Снимок FBS-остатков (mp_fbs_daily_stock, читает lib/warehousesData.js loadWarehousesInput)
-- не старше 2 дней у каждой площадки, у которой вообще есть склады продавца (mp_seller_
-- warehouses) — площадка без складов продавца не собирает снимок, это не деградация.
WITH platforms AS (SELECT unnest(ARRAY['wb','ozon']) AS platform),
haswh AS (SELECT DISTINCT platform FROM tenant.mp_seller_warehouses WHERE cabinet_id=1),
snap AS (SELECT platform, MAX(date) AS last_date FROM tenant.mp_fbs_daily_stock WHERE cabinet_id=1 GROUP BY 1)
SELECT 'fbs_snapshot_fresh' AS check,
       COUNT(*) FILTER (WHERE p.platform IN (SELECT platform FROM haswh)
                          AND (s.last_date IS NULL OR s.last_date < current_date - 2)) = 0 AS ok,
       jsonb_object_agg(p.platform, jsonb_build_object(
         'has_seller_warehouses', p.platform IN (SELECT platform FROM haswh),
         'last_snapshot_date', s.last_date)) AS by_platform
FROM platforms p LEFT JOIN snap s ON s.platform = p.platform;

-- 4. Открытые stock_move_gaps — сигнал, не ошибка (ok=t всегда), но каждый обязан нести
-- platform (CHECK 'wb'|'ozon') и qty > 0 — иначе карточка места (PlaceCard.problems.gaps) и
-- сигнал buildSignals('gaps') получат мусорную строку молча.
WITH g AS (SELECT * FROM tenant.stock_move_gaps WHERE cabinet_id=1 AND resolved_at IS NULL),
by_reason AS (SELECT reason, COUNT(*) AS c FROM g GROUP BY reason)
SELECT 'gaps_open_count' AS check,
       (SELECT COUNT(*) FROM g WHERE platform IS NULL OR qty <= 0) = 0 AS ok,
       (SELECT COUNT(*) FROM g) AS open_total,
       (SELECT jsonb_object_agg(reason, c) FROM by_reason) AS by_reason,
       (SELECT COUNT(*) FROM g WHERE platform IS NULL) AS no_platform,
       (SELECT COUNT(*) FROM g WHERE qty <= 0) AS non_positive_qty;

-- 5. Один склад продавца не привязан к двум местам одновременно (частичные индексы этапа 1,
-- stock_ff_locations_wb_wh_uq / stock_ff_locations_ozon_wh_uq, — контроль, что не сняты).
WITH dup AS (
  SELECT 'wb' AS platform, wb_warehouse_id AS warehouse_id, COUNT(*) AS c
  FROM tenant.stock_ff_locations WHERE cabinet_id=1 AND wb_warehouse_id IS NOT NULL
  GROUP BY 1,2 HAVING COUNT(*) > 1
  UNION ALL
  SELECT 'ozon', ozon_warehouse_id, COUNT(*)
  FROM tenant.stock_ff_locations WHERE cabinet_id=1 AND ozon_warehouse_id IS NOT NULL
  GROUP BY 1,2 HAVING COUNT(*) > 1
)
SELECT 'bindings_unique' AS check,
       COUNT(*) = 0 AS ok,
       COUNT(*) AS duplicate_bindings
FROM dup;

-- 6. Документы 'shipped' старше WAITING_ACCEPT_DAYS=7 без приёмки — сигнал buildSignals
-- ('waiting_accept'), не ошибка (ok=t всегда).
SELECT 'waiting_accept_docs' AS check,
       true AS ok,
       COUNT(*) AS count
FROM tenant.ff_shipment_docs
WHERE cabinet_id=1 AND status = 'shipped' AND shipped_at IS NOT NULL
  AND shipped_at < now() - interval '7 days';

-- 7. FBS-скорость мест (lib/warehousesData.js fbsVelocity) читает wb_fbs_tasks.warehouse_id
-- (неотменённые: без canceled_by_client/declined_by_client/defect/canceled) и
-- ozon_orders.warehouse_id (scheme='fbs', is_cancel=0) за 28 дней — доля строк с заполненным
-- складом должна быть ≥ 0.95, иначе скорость мест в матрице занижена молча (заказы без склада
-- никуда не попадают). Площадка без строк в окне (например, Ozon FBS сейчас неактивен на
-- кабинете #1 — последняя запись 2026-08-12, вне 28-дневного окна) не портит числитель/
-- знаменатель: считаем СОВМЕСТНО по обеим площадкам, 0/0 по одной не топит другую.
WITH wb AS (
  SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE warehouse_id IS NOT NULL) AS with_wh
  FROM tenant.wb_fbs_tasks
  WHERE cabinet_id=1 AND created_at >= now() - interval '28 days'
    AND COALESCE(wb_status,'') <> ALL(ARRAY['canceled_by_client','declined_by_client','defect','canceled'])
),
oz AS (
  SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE warehouse_id IS NOT NULL) AS with_wh
  FROM tenant.ozon_orders
  WHERE cabinet_id=1 AND scheme='fbs' AND COALESCE(is_cancel,0)=0
    AND order_dt >= to_char(now() - interval '28 days', 'YYYY-MM-DD')
)
SELECT 'fbs_velocity_sources' AS check,
       (wb.total + oz.total) = 0
       OR (wb.with_wh + oz.with_wh)::numeric / (wb.total + oz.total) >= 0.95 AS ok,
       wb.total AS wb_total, wb.with_wh AS wb_with_warehouse,
       oz.total AS ozon_total, oz.with_wh AS ozon_with_warehouse,
       CASE WHEN (wb.total + oz.total) = 0 THEN NULL
            ELSE round((wb.with_wh + oz.with_wh)::numeric / (wb.total + oz.total), 4) END AS ratio
FROM wb, oz;
