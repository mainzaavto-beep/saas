#!/usr/bin/env python3
"""Агрегация FBS-остатков WB/Ozon в строки mp_fbs_daily_stock. Без сети и БД."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import wb_fbs_stocks as wb

bc = {"200001": 11, "200002": 11, "200003": 22}
rows = wb.aggregate(500, [{"sku": "200001", "amount": 3}, {"sku": "200002", "amount": 2},
                          {"sku": "200003", "amount": 0}, {"sku": "999", "amount": 9}], bc, "2026-09-06")
assert sorted(rows, key=lambda r: r["sku_key"]) == [
    {"platform": "wb", "warehouse_id": 500, "sku_key": 11, "date": "2026-09-06", "present": 5, "reserved": None},
    {"platform": "wb", "warehouse_id": 500, "sku_key": 22, "date": "2026-09-06", "present": 0, "reserved": None},
], rows
assert wb.aggregate(500, [], bc, "2026-09-06") == []
print("OK: wb 2 проверки")

try:
    import ozon_fbs_stocks as oz
except ImportError:
    oz = None
if oz:
    sku2pid = {700: 1001, 701: 1002}
    rows = oz.rows_from_result([
        {"sku": 700, "warehouse_id": 5, "present": 4, "reserved": 1},
        {"sku": "701", "warehouse_id": 5, "present": 0, "reserved": 0},
        {"sku": 702, "warehouse_id": 5, "present": 9, "reserved": 0},   # нет в каталоге
        {"sku": 700, "warehouse_id": None, "present": 1},                # без склада
    ], sku2pid, "2026-09-06")
    assert rows == [
        {"platform": "ozon", "warehouse_id": 5, "sku_key": 1001, "date": "2026-09-06", "present": 4, "reserved": 1},
        {"platform": "ozon", "warehouse_id": 5, "sku_key": 1002, "date": "2026-09-06", "present": 0, "reserved": 0},
    ], rows
    print("OK: ozon 1 проверка")
