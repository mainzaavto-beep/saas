"""
SaaS-сборщик АКТУАЛЬНЫХ ЦЕН WB → tenant.wb_prices.

discounts-prices-api /api/v2/list/goods/filter (limit/offset пагинация).
Снимок: цена продавца ДО скидки + размер скидки % + СПП (всегда NULL — WB не отдаёт).
Токен из env WB_TOKEN. Идемпотентно по (cabinet_id, nm_id).
"""
import os
import sys
import time
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
ENDPOINT = "https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter"


def _wb_get(params):
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    headers = {"Authorization": WB_TOKEN, "Content-Type": "application/json"}
    for attempt in range(3):
        try:
            r = requests.get(ENDPOINT, headers=headers, params=params, timeout=30)
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 60))
                print(f"  429, жду {wait}с...", flush=True)
                time.sleep(wait)
                continue
            return r
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(5)
    return None


def collect():
    print("[wb_prices] снимок актуальных цен/скидок", flush=True)
    db_pg.init()
    rows = []
    seen = set()
    offset = 0
    limit = 1000
    while offset <= 50000:
        r = _wb_get({"limit": limit, "offset": offset})
        if r is None or r.status_code != 200:
            print(f"  ошибка [{getattr(r,'status_code','?')}]", flush=True)
            break
        items = r.json().get("data", {}).get("listGoods", [])
        if not items:
            break
        for item in items:
            nm = item.get("nmID")
            if nm is None or nm in seen:
                continue
            seen.add(nm)
            sizes = item.get("sizes") or []
            sz0 = sizes[0] if sizes else {}
            price_seller = sz0.get("price")
            if price_seller is None:
                continue
            rows.append({
                "nm_id": nm,
                "price_seller": round(float(price_seller)),
                "discount": int(item.get("discount") or 0),
                "spp_auto": None,
            })
        offset += limit
        time.sleep(0.2)
    n = db_pg.upsert_prices_many(rows)
    print(f"[wb_prices] записано {n} цен → tenant.wb_prices", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
