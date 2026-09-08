"""
Селф-тест wb_references (без сети и БД): WB отключил supplies-api
/api/v1/warehouses и /transit-tariffs (404 «This method is temporarily disabled»,
release-notes?id=570, с 2026-08-24). Сборщик обязан:
  • не падать на 4xx (докстринг: «при недоступности WB API — exit 0»);
  • дописать в shared.wb_warehouses то, что отдал stocks-report (первичный источник);
  • тарифы при 404 — просто пропустить.

Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/wb_references_selftest.py
"""
import os
import sys

os.environ["WB_TOKEN"] = "selftest-token"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wb_references as m  # noqa: E402

import requests  # noqa: E402


class FakeResp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.headers = {}
        self.reason = "Not Found"

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error: Not Found for url: x")


DISABLED = {"status": 404, "statusText": "Not Found", "title": "Not Found",
            "detail": "This method is temporarily disabled. Link: https://dev.wildberries.ru/release-notes?id=570"}

STOCKS_REPORT = {"data": {"items": [
    {"warehouseId": 507, "warehouseName": "Коледино", "regionName": "Центральный"},
    {"warehouseId": 686, "warehouseName": "Новосибирск", "regionName": "Сибирский"},
]}}


def fake_get(url, headers=None, timeout=None):
    assert url in (m.WAREHOUSES_URL, m.TARIFFS_URL), url
    return FakeResp(404, DISABLED)


def fake_post(url, headers=None, json=None, timeout=None):
    assert url == m.STOCKS_REPORT_URL, url
    return FakeResp(200, STOCKS_REPORT)


written = {"warehouses": None, "tariffs": None}


def fake_upsert_wh(rows):
    written["warehouses"] = rows
    return len(rows)


def fake_upsert_tt(rows):
    written["tariffs"] = rows
    return len(rows)


m.requests.get = fake_get
m.requests.post = fake_post
m.time.sleep = lambda s: None
m.db_pg.init = lambda: None
m.db_pg.upsert_shared_wb_warehouses = fake_upsert_wh
m.db_pg.upsert_shared_wb_transit_tariffs = fake_upsert_tt

failed = 0


def check(cond, msg):
    global failed
    print(("PASS — " if cond else "FAIL — ") + msg, flush=True)
    if not cond:
        failed += 1


try:
    total = m.collect()
except Exception as e:  # noqa: BLE001
    total = None
    print(f"FAIL — collect() упал: {e.__class__.__name__}: {e}", flush=True)
    failed += 1

check(total == 2, f"collect() вернул число строк stocks-report (2), получено {total}")
check(written["warehouses"] is not None and [r["id"] for r in written["warehouses"]] == [507, 686],
      "склады из stocks-report записаны несмотря на 404 у /warehouses")
check(written["warehouses"] is not None and all(r["region"] for r in written["warehouses"]),
      "регион из stocks-report сохранён")
check(written["tariffs"] is None, "тарифы при 404 не трогаем (upsert не вызван)")

print("ALL PASS" if not failed else f"{failed} FAIL", flush=True)
sys.exit(1 if failed else 0)
