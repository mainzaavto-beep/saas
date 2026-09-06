#!/usr/bin/env python3
"""Методы OzonClient для складов продавца / FBS-остатков / заказов на поставку.
Без сети и БД: _post подменяется, проверяются пачки и курсоры."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import ozon_client as oc

oc.time.sleep = lambda s: None


def make_client(handler):
    cli = oc.OzonClient.__new__(oc.OzonClient)
    cli.host = "test"
    calls = []
    def fake_post(host, path, body=None, *a, **k):
        calls.append((path, dict(body or {})))
        return handler(path, body or {}, len(calls))
    cli._post = fake_post
    return cli, calls

ok = 0

# 1a) warehouse_list: список складов без обёртки, путь /v2 (v1 отключён Ozon 07.04.2026)
cli, calls = make_client(lambda p, b, n: [{"warehouse_id": 1, "name": "A", "is_rfbs": False}])
assert cli.warehouse_list() == [{"warehouse_id": 1, "name": "A", "is_rfbs": False}]
assert calls[0][0] == "/v2/warehouse/list"
ok += 1

# 1b) warehouse_list: реальная форма ответа Ozon — список в "warehouses" (проба 06.09.2026)
cli, calls = make_client(lambda p, b, n: {"warehouses": [{"warehouse_id": 2, "name": "B", "is_rfbs": True}]})
assert cli.warehouse_list() == [{"warehouse_id": 2, "name": "B", "is_rfbs": True}]
ok += 1

# 1c) warehouse_list: fallback на "result" (форма других методов клиента), если "warehouses" нет
cli, calls = make_client(lambda p, b, n: {"result": [{"warehouse_id": 3, "name": "C", "is_rfbs": False}]})
assert cli.warehouse_list() == [{"warehouse_id": 3, "name": "C", "is_rfbs": False}]
ok += 1

# 2) stocks_by_warehouse_fbs: 250 sku → 3 пачки по 100 (v2, обёртка "products"), результат склеен
def h2(p, b, n):
    assert p == "/v2/product/info/stocks-by-warehouse/fbs", p
    assert b["limit"] == 1000, b
    return {"products": [{"sku": s, "present": 1, "reserved": 0, "warehouse_id": 7} for s in b["sku"]],
            "has_next": False, "cursor": ""}
cli, calls = make_client(h2)
res = cli.stocks_by_warehouse_fbs(list(range(250)))
assert len(res) == 250 and [len(c[1]["sku"]) for c in calls] == [100, 100, 50], calls
assert all(isinstance(s, str) for s in calls[0][1]["sku"]), "sku в теле — строки"
ok += 1

# 2b) stocks_by_warehouse_fbs: внутри одной пачки — пагинация has_next/cursor
pages2b = [
    {"products": [{"sku": 1, "present": 1, "reserved": 0, "warehouse_id": 7}],
     "has_next": True, "cursor": "c1"},
    {"products": [{"sku": 2, "present": 2, "reserved": 0, "warehouse_id": 7}],
     "has_next": False, "cursor": ""},
]
cli, calls = make_client(lambda p, b, n: pages2b[n - 1])
res = cli.stocks_by_warehouse_fbs([1, 2], chunk=100)
assert [r["sku"] for r in res] == [1, 2], res
assert "cursor" not in calls[0][1] and calls[1][1]["cursor"] == "c1", calls
ok += 1

# 3) iter_supply_order_ids: /v3, курсор — непрозрачная строка last_id, filter.states —
# все коды 1..11 (проба 06.09.2026: /v2 отключён Ozon, отвечал 404)
pages = [
    {"order_ids": [10, 11], "last_id": "c1"},
    {"order_ids": [12], "last_id": "c2"},
    {"order_ids": [], "last_id": ""},
]
cli, calls = make_client(lambda p, b, n: pages[n - 1])
ids = list(cli.iter_supply_order_ids(limit=2))
assert ids == [10, 11, 12], ids
assert calls[0][0] == "/v3/supply-order/list", calls[0]
assert calls[0][1]["filter"]["states"] == list(range(1, 12)), calls[0]
assert calls[0][1]["sort_by"] != 0 and "last_id" not in calls[0][1], calls[0]
assert calls[1][1]["last_id"] == "c1", calls[1]
ok += 1

# 4) supply_order_get: /v3, 120 id → 3 запроса по 50, orders склеены; НЕТ top-level
# "warehouses" (был в /v2, проба 06.09.2026 — склад назначения в supplies[].storage_warehouse)
def h4(p, b, n):
    assert p == "/v3/supply-order/get"
    return {"orders": [{"order_id": i} for i in b["order_ids"]]}
cli, calls = make_client(h4)
res = cli.supply_order_get(list(range(120)))
assert len(res["orders"]) == 120 and "warehouses" not in res, res
assert [len(c[1]["order_ids"]) for c in calls] == [50, 50, 20]
ok += 1

# 5) supply_order_bundle_items: пагинация has_next/last_id
pages5 = [
    {"items": [{"sku": 1, "quantity": 5}], "has_next": True, "last_id": "x"},
    {"items": [{"sku": 2, "quantity": 3}], "has_next": False, "last_id": ""},
]
cli, calls = make_client(lambda p, b, n: pages5[n - 1])
items = cli.supply_order_bundle_items(["b1"])
assert [i["sku"] for i in items] == [1, 2], items
assert "last_id" not in calls[0][1] and calls[1][1]["last_id"] == "x", calls
ok += 1

print(f"OK: {ok} проверок")
