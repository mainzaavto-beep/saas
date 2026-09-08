-- Смоук-сторож «Склады 2.0», этап 3 «Поставки». Запуск:
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-warehouses-stage3.sql
-- Все проверки должны отдать ok=t (кабинет #1; под saas_ro RLS не скоупит — WHERE явно
-- в каждом запросе, включая подзапросы и JOIN-таблицы tenant.*).

-- 0. Регресс-сеть: инвариант ledger этапа 2 всё ещё держится (остаток = сумма движений).
SELECT 'ledger_invariant' AS check,
       COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s, 0)) = 0 AS ok,
       COUNT(*) AS positions, COUNT(*) FILTER (WHERE f.qty <> COALESCE(m.s, 0)) AS mismatch
FROM tenant.ff_inventory f
LEFT JOIN (SELECT ff_inventory_id, SUM(qty) AS s FROM tenant.stock_moves WHERE cabinet_id=1 GROUP BY 1) m
       ON m.ff_inventory_id = f.id
WHERE f.cabinet_id=1;

-- 1. wb_incomes собраны и внутренне непротиворечивы: quantity_declared всегда заполнено,
-- date_close заполнен ⟺ статус '5' («Принято» — по коду WB statusID, не по тексту).
-- status сравниваем через COALESCE(status,''): NULL-статус (WB не прислал statusID) —
-- это тоже «не 5», и с заполненным date_close он обязан считаться несоответствием,
-- а не проваливаться мимо обоих фильтров на трёхзначной логике (ревью 2026-09-08).
SELECT 'wb_incomes_collected' AS check,
       COUNT(*) > 0
       AND COUNT(*) FILTER (WHERE quantity_declared IS NULL) = 0
       AND COUNT(*) FILTER (WHERE COALESCE(status,'') = '5' AND date_close IS NULL) = 0
       AND COUNT(*) FILTER (WHERE COALESCE(status,'') <> '5' AND date_close IS NOT NULL) = 0 AS ok,
       COUNT(*) AS rows_total,
       COUNT(*) FILTER (WHERE quantity_declared IS NULL) AS no_declared,
       COUNT(*) FILTER (WHERE COALESCE(status,'') = '5') AS status5,
       COUNT(*) FILTER (WHERE status IS NULL) AS status_null,
       COUNT(*) FILTER (WHERE date_close IS NOT NULL) AS date_close_filled,
       COUNT(*) FILTER (WHERE COALESCE(status,'') = '5' AND date_close IS NULL) AS mismatch_accepted_no_close,
       COUNT(*) FILTER (WHERE COALESCE(status,'') <> '5' AND date_close IS NOT NULL) AS mismatch_close_not_accepted
FROM tenant.wb_incomes WHERE cabinet_id=1;

-- 2. Приёмки покрывают income_id заказов. Непокрытые income_id — это поставки СТАРШЕ
-- клиентского окна сборщика (SAAS_INCOMES_DAYS=90 дней по createDate, фильтруется на
-- нашей стороне): API supplies-api историю отдаёт целиком, ограничиваем её мы сами,
-- чтобы не выжигать лимиты. То есть это не потеря данных и не сбой источника —
-- разовый бэкфилл `SAAS_INCOMES_DAYS=400 python worker/collectors/wb_incomes.py`
-- поднимает сырое покрытие. Порог ok считаем по СУЖЕННОМУ множеству: MIN(income_id)
-- в wb_incomes — граница собранного (WB присваивает id монотонно по времени создания
-- поставки), заказы со старшими income_id из знаменателя исключаются; календарное
-- окно так не сработало бы — старые income'ы разбросаны по всей истории заказов.
-- Сырая 60-дневная доля идёт диагностикой (incomes_60d_raw / covered_60d_raw).
WITH scope AS (
  SELECT o.income_id,
         EXISTS (SELECT 1 FROM tenant.wb_incomes wi WHERE wi.cabinet_id=1 AND wi.income_id = o.income_id) AS covered
  FROM tenant.wb_orders o
  WHERE o.cabinet_id=1 AND o.income_id IS NOT NULL AND o.income_id <> 0
    AND o.order_dt::timestamptz >= now() - interval '60 days'
  GROUP BY 1
),
minc AS (SELECT COALESCE(MIN(income_id), 0) AS m FROM tenant.wb_incomes WHERE cabinet_id=1),
narrowed AS (SELECT s.* FROM scope s, minc WHERE s.income_id >= minc.m)
SELECT 'incomes_coverage_60d' AS check,
       (SELECT COUNT(*) FROM narrowed) = 0
       OR (SELECT COUNT(*) FILTER (WHERE covered) FROM narrowed)::numeric
          / (SELECT COUNT(*) FROM narrowed) >= 0.8 AS ok,
       (SELECT COUNT(*) FROM scope) AS incomes_60d_raw,
       (SELECT COUNT(*) FILTER (WHERE covered) FROM scope) AS covered_60d_raw,
       (SELECT m FROM minc) AS min_collected_income_id,
       (SELECT COUNT(*) FROM scope) - (SELECT COUNT(*) FROM narrowed) AS excluded_precollector,
       (SELECT COUNT(*) FROM narrowed) AS incomes_in_scope,
       (SELECT COUNT(*) FILTER (WHERE covered) FROM narrowed) AS covered_in_scope;

-- 3. Документы отгрузки согласованы со списаниями: ЛЮБОЙ статус кроме 'draft'
-- (shipped / accepted / partial / rejected) ⇒ у каждой строки есть out_fbo
-- (stock_moves src_kind='ff_shipment_doc', src_ref='<doc_id>:<line_id>'); 'draft' ⇒
-- движения ещё нет. Проверять только 'shipped' было дырой: документ уходит в
-- accepted/partial/rejected сразу после приёмки, и пропавшее списание переставало
-- ловиться ровно там, где документ живёт дольше всего (ревью 2026-09-08).
-- Кабинет без документов новых статусов — вакуумно ok=t.
WITH doc_lines AS (
  SELECT d.id AS doc_id, d.status AS doc_status, l.id AS line_id,
         EXISTS (SELECT 1 FROM tenant.stock_moves m
                 WHERE m.cabinet_id=1 AND m.kind='out_fbo' AND m.src_kind='ff_shipment_doc'
                   AND m.src_ref = d.id::text || ':' || l.id::text) AS has_move
  FROM tenant.ff_shipment_docs d
  JOIN tenant.ff_shipment_lines l ON l.doc_id = d.id AND l.cabinet_id = 1
  WHERE d.cabinet_id = 1
)
SELECT 'doc_status_moves' AS check,
       COUNT(*) FILTER (WHERE doc_status <> 'draft' AND NOT has_move) = 0
       AND COUNT(*) FILTER (WHERE doc_status = 'draft' AND has_move) = 0 AS ok,
       COUNT(*) AS lines_total,
       COUNT(*) FILTER (WHERE doc_status <> 'draft') AS shipped_lines,
       COUNT(*) FILTER (WHERE doc_status <> 'draft' AND NOT has_move) AS shipped_missing_move,
       COUNT(*) FILTER (WHERE doc_status = 'draft') AS draft_lines,
       COUNT(*) FILTER (WHERE doc_status = 'draft' AND has_move) AS draft_unexpected_move
FROM doc_lines;

-- 4. 'partial' ⇒ принято меньше заявленного, 'accepted' ⇒ принято ≥ заявленного
-- (перевыполнение бывает — WB иногда принимает больше строк). Считаем среди строк
-- с заполненным qty_accepted (NULL — витрина ещё не разнесла факт).
WITH doc_agg AS (
  SELECT d.id AS doc_id, d.status AS doc_status,
         SUM(l.qty) FILTER (WHERE l.qty_accepted IS NOT NULL) AS qty_sum,
         SUM(l.qty_accepted) AS accepted_sum,
         COUNT(*) FILTER (WHERE l.qty_accepted IS NOT NULL) AS accepted_lines
  FROM tenant.ff_shipment_docs d
  JOIN tenant.ff_shipment_lines l ON l.doc_id = d.id AND l.cabinet_id = 1
  WHERE d.cabinet_id = 1 AND d.status IN ('partial','accepted')
  GROUP BY 1, 2
)
SELECT 'doc_partial_accepted_qty' AS check,
       COUNT(*) FILTER (WHERE doc_status = 'partial' AND accepted_lines > 0
                          AND NOT (accepted_sum < qty_sum)) = 0
       AND COUNT(*) FILTER (WHERE doc_status = 'accepted' AND accepted_lines > 0
                              AND NOT (accepted_sum >= qty_sum)) = 0 AS ok,
       COUNT(*) AS docs_total,
       COUNT(*) FILTER (WHERE doc_status = 'partial') AS partial_docs,
       COUNT(*) FILTER (WHERE doc_status = 'accepted') AS accepted_docs
FROM doc_agg;

-- 5. mp_supply_id ссылается на существующую приёмку/заказ на поставку своего вида.
WITH doc_ref AS (
  SELECT d.id AS doc_id, d.mp_supply_kind, d.mp_supply_id,
         CASE d.mp_supply_kind
           WHEN 'wb_income' THEN EXISTS (
             SELECT 1 FROM tenant.wb_incomes wi
             WHERE wi.cabinet_id=1 AND wi.income_id = NULLIF(d.mp_supply_id,'')::bigint)
           WHEN 'ozon_supply_order' THEN EXISTS (
             SELECT 1 FROM tenant.ozon_supply_orders oo
             WHERE oo.cabinet_id=1 AND oo.order_id = NULLIF(d.mp_supply_id,'')::bigint)
           ELSE NULL
         END AS ref_exists
  FROM tenant.ff_shipment_docs d
  WHERE d.cabinet_id = 1 AND d.mp_supply_id IS NOT NULL AND d.mp_supply_kind IS NOT NULL
)
SELECT 'doc_mp_supply_ref' AS check,
       COUNT(*) FILTER (WHERE ref_exists IS FALSE) = 0 AS ok,
       COUNT(*) AS refs_total,
       COUNT(*) FILTER (WHERE ref_exists) AS refs_found,
       COUNT(*) FILTER (WHERE ref_exists IS FALSE) AS refs_missing
FROM doc_ref;

-- 6. Настройки планирования: min < target там, где заданы оба, и оба в 1..365.
-- Отсутствие ключей — дефолты 30/14 из lib/supplyPlanData.js, тоже ok.
WITH s AS (
  SELECT (settings->>'supply_min_days')::int AS min_d,
         (settings->>'supply_target_days')::int AS target_d
  FROM auth.cabinets WHERE cabinet_id = 1
)
SELECT 'supply_days_settings' AS check,
       (min_d IS NULL OR target_d IS NULL)
       OR (min_d BETWEEN 1 AND 365 AND target_d BETWEEN 1 AND 365 AND min_d < target_d) AS ok,
       min_d, target_d
FROM s;

-- 7. pack_qty — NULL (кратность 1 по умолчанию) или целое ≥ 1.
SELECT 'ff_inventory_pack_qty' AS check,
       COUNT(*) FILTER (WHERE pack_qty IS NOT NULL AND pack_qty < 1) = 0 AS ok,
       COUNT(*) AS rows_total,
       COUNT(*) FILTER (WHERE pack_qty IS NOT NULL) AS pack_qty_set,
       COUNT(*) FILTER (WHERE pack_qty IS NOT NULL AND pack_qty < 1) AS bad
FROM tenant.ff_inventory WHERE cabinet_id=1;
