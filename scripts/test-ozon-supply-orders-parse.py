#!/usr/bin/env python3
"""Разбор ответа /v3/supply-order/get и /v1/supply-order/bundle. Без сети и БД.
Форма выровнена по живой пробе (задача 9, шаг 6, 06.09.2026 — Ozon отключил /v2,
клиент переведён на /v3, форма ответа иная: order_id/order_number/created_date,
голое state без префикса ORDER_STATE_, склад назначения embedded-объектом в
supplies[].storage_warehouse, нет top-level warehouses[])."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import ozon_supply_orders as m

get_res = {
    "orders": [{
        "order_id": 501, "order_number": "SO-501", "state": "COMPLETED",
        "created_date": "2026-08-30T10:00:00Z",
        "timeslot": {"timeslot": {"from": "2026-09-02T09:00:00Z", "to": "2026-09-02T12:00:00Z"}},
        "supplies": [{"supply_id": 1, "bundle_id": "b-1",
                      "storage_warehouse": {"warehouse_id": 77, "name": "ХОРУГВИНО_РФЦ"}}],
    }, {
        "order_id": 502, "order_number": "SO-502", "state": "DATA_FILLING",
        "created_date": "2026-09-05T10:00:00Z", "timeslot": None, "supplies": [],
    }, {
        # кроссдок/vDC: несколько supplies, storage_warehouse у всех null — dest остаётся NULL
        "order_id": 503, "order_number": "SO-503", "state": "IN_TRANSIT",
        "created_date": "2026-09-01T10:00:00Z", "timeslot": None,
        "supplies": [{"supply_id": 2, "bundle_id": "b-3a", "storage_warehouse": None},
                     {"supply_id": 3, "bundle_id": "b-3b", "storage_warehouse": None}],
    }],
}
orders, bundles = m.parse_orders(get_res)
assert orders == [
    {"order_id": 501, "number": "SO-501", "state": "COMPLETED",
     "created_at": "2026-08-30T10:00:00Z", "timeslot_from": "2026-09-02T09:00:00Z",
     "timeslot_to": "2026-09-02T12:00:00Z", "dest_warehouse_id": 77, "dest_warehouse_name": "ХОРУГВИНО_РФЦ"},
    {"order_id": 502, "number": "SO-502", "state": "DATA_FILLING",
     "created_at": "2026-09-05T10:00:00Z", "timeslot_from": None, "timeslot_to": None,
     "dest_warehouse_id": None, "dest_warehouse_name": None},
    {"order_id": 503, "number": "SO-503", "state": "IN_TRANSIT",
     "created_at": "2026-09-01T10:00:00Z", "timeslot_from": None, "timeslot_to": None,
     "dest_warehouse_id": None, "dest_warehouse_name": None},
], orders
assert bundles == {501: ["b-1"], 503: ["b-3a", "b-3b"]}, bundles

# sku 700 — в нашем каталоге (sku2pid); 701 — тоже (sku как строка в ответе Ozon);
# 999 — нет в sku2pid, но Ozon сам прислал product_id (999001) — fallback на него;
# 1000 — нет нигде → None
items = m.parse_items(501, [
    {"sku": 700, "quantity": 12}, {"sku": "701", "quantity": 3},
    {"sku": 999, "quantity": 1, "product_id": 999001}, {"sku": 1000, "quantity": 2},
], {700: 1001, 701: 1002})
assert items == [
    {"order_id": 501, "sku": 700, "product_id": 1001, "qty_declared": 12, "qty_accepted": None},
    {"order_id": 501, "sku": 701, "product_id": 1002, "qty_declared": 3, "qty_accepted": None},
    {"order_id": 501, "sku": 999, "product_id": 999001, "qty_declared": 1, "qty_accepted": None},
    {"order_id": 501, "sku": 1000, "product_id": None, "qty_declared": 2, "qty_accepted": None},
], items

# select_orders_for_bundles: заказ 501 уже финальный с составом (в skip) — пропускаем;
# 503 — нет (не финальный/нет состава ещё) — тянем (ревью раунд 1, ограничение стоимости).
assert m.select_orders_for_bundles(bundles, {501}) == {503: ["b-3a", "b-3b"]}, bundles
assert m.select_orders_for_bundles(bundles, set()) == bundles
assert m.select_orders_for_bundles(bundles, {501, 503}) == {}

# partial_exit_code: контракт exit-кодов (по образцу ozon_accruals.py)
assert m.partial_exit_code(0) is None
assert m.partial_exit_code(3) == 3

print("OK: 7 проверок")
