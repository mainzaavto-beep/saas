"""
SaaS-сборщик ОСТАТКОВ по складам WB → tenant.wb_daily_stock.

supplier/stocks (dateFrom=2020-01-01 → все записи). Снимок «сейчас» по складам.
Пишется на дату = сегодня (append-only; WB исторические остатки не отдаёт).
Токен из env WB_TOKEN. Идемпотентно по (cabinet_id, nm_id, date, warehouse).
"""
import os
import sys
import time
import requests
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
STOCKS_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/stocks"


def _fetch():
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    headers = {"Authorization": WB_TOKEN}
    for attempt in range(5):
        try:
            r = requests.get(STOCKS_URL, headers=headers,
                             params={"dateFrom": "2020-01-01"}, timeout=120)
        except requests.RequestException as e:
            if attempt == 4:
                raise
            print(f"  сетевой сбой ({e.__class__.__name__}), повтор...", flush=True)
            time.sleep(10)
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 60))
            print(f"  429, жду {wait}с...", flush=True)
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("supplier/stocks: не удалось после 5 попыток")


def collect():
    today = date.today().isoformat()
    print(f"[wb_stocks] снимок остатков на {today}", flush=True)
    db_pg.init()
    known = set(db_pg.active_nm_ids())
    rows = []
    for s in _fetch():
        nm = s.get("nmId")
        if nm not in known:
            continue  # только артикулы каталога
        wh = s.get("warehouseName")
        if not wh:
            continue
        rows.append({
            "nm_id": nm, "date": today, "warehouse": wh,
            "quantity": s.get("quantity", 0),
            "quantity_full": s.get("quantityFull", 0),
            "in_way_to": s.get("inWayToClient", 0),
            "in_way_from": s.get("inWayFromClient", 0),
        })
    n = db_pg.upsert_stock_many(rows)
    print(f"[wb_stocks] записано {n} строк → tenant.wb_daily_stock", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
