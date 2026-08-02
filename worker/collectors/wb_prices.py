"""
SaaS-сборщик АКТУАЛЬНЫХ ЦЕН WB → tenant.wb_prices.

discounts-prices-api /api/v2/list/goods/filter (limit/offset пагинация).
Снимок: цена продавца ДО скидки (price_seller) + размер скидки % (discount) +
цена после скидки продавца (price_buyer = discountedPrice).

⚠️ ОПРОВЕРГНУТО 2026-08-02 (было «discountedPrice = финальная цена сайта»):
`discountedPrice` НЕ включает СПП — это цена только после скидки ПРОДАВЦА.
Доказательство на nm 1181386677 (cab #1): API=8911 ₽ (=price_seller×(1−disc)),
реальная цена на сайте=6344 ₽, СПП в заказах 31-45%. Вывод «spp=0 у всех 145
товаров» от 07-28 был артефактом этого же заблуждения (price_buyer≡расчётной
цене по построению). РЕАЛЬНАЯ цена сайта в этом API недоступна — нужен
публичный card.wb.ru (см. queue в памяти сессии) либо finished_price/spp из
заказов. price_buyer оставляем: как база налогов он корректен (выручка
продавца = цена после ЕГО скидки; СПП компенсирует WB, а не продавец).
Колонка spp_auto — NULL (legacy).
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
            # discountedPrice = финальная цена покупателя на сайте (после скидки
            # продавца). Раньше терялось — теперь пишем в price_buyer (миграция 028).
            # Если WB не отдал (старый товар) — None, на лету не вычисляем.
            dprice = sz0.get("discountedPrice")
            price_buyer = round(float(dprice)) if dprice is not None else None
            rows.append({
                "nm_id": nm,
                "price_seller": round(float(price_seller)),
                "discount": int(item.get("discount") or 0),
                "price_buyer": price_buyer,
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
