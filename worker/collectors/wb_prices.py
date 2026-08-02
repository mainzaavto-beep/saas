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
import json
import os
import sys
import time
import urllib.request
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
ENDPOINT = "https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter"
# Публичная карточка (без токена) — единственный источник РЕАЛЬНОЙ цены сайта
# (с СПП). Решение хозяина 2026-08-02, миграция 029. dest=-1257786 — Москва.
# ⚠️ Версия пути дрейфует: v1/v2/v3 отдают 404, рабочая v4 (проверено
# 2026-08-02 на nm 1181386677: basic=948000 коп, product=625500 коп = цена
# с СПП). Если снова 404 всем батчам — проверить новую версию вручную.
# ⚠️⚠️ БЛОКИРОВКА IP (2026-08-02): антибот WB отдаёт 403 на ПРЯМЫЕ запросы
# с этого сервера (хостинговая подсеть) — 403 и curl'у, и urllib. Через
# внешний прокси — 200. Т.е. с боевого сервера цена сайта НЕ собирается,
# пока хозяин не решит вопрос прокси (см. память сессии). Сбой деградирует
# мягко: price_site просто стареет (виден по price_site_at), UI падает
# на fallback «последний СПП из заказов».
CARD_ENDPOINT = "https://card.wb.ru/cards/v4/detail"


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
    collect_site_prices([r["nm_id"] for r in rows])
    return n


def collect_site_prices(nm_ids):
    """Реальная цена сайта (с СПП) с публичного card.wb.ru, батчами по 100 nm.
    Сбой здесь НЕ валит основной сбор цен и НЕ затирает старые price_site
    (отдельный UPDATE только по пришедшим nm, см. db_pg.update_site_prices_many);
    свежесть видна по price_site_at.
    ⚠️ Только urllib, НЕ requests: защита WB отдаёт requests'у 403 при любых
    заголовках (отпечаток соединения), urllib проходит (проверено 2026-08-02).
    Плюс requests кодирует ';' в %3B — WB это тоже режет. Формат ответа гуляет:
    товары то в data.products, то в products верхнего уровня — читаем оба."""
    site_rows = []
    failed_batches = 0
    for i in range(0, len(nm_ids), 100):
        chunk = nm_ids[i:i + 100]
        url = (CARD_ENDPOINT + "?appType=1&curr=rub&dest=-1257786&nm="
               + ";".join(str(x) for x in chunk))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                d = json.loads(resp.read())
            products = (d.get("data") or {}).get("products") or d.get("products") or []
            for p in products:
                sizes = p.get("sizes") or []
                price = None
                for sz in sizes:
                    pr = (sz.get("price") or {}).get("product")
                    if pr:  # копейки
                        price = round(pr / 100)
                        break
                if price:
                    site_rows.append({"nm_id": p.get("id"), "price_site": price})
        except Exception as e:
            print(f"  [site] батч {i//100}: {e}", flush=True)
            failed_batches += 1
        time.sleep(0.3)
    try:
        m = db_pg.update_site_prices_many(site_rows)
        print(f"[wb_prices] цена сайта: {m} из {len(nm_ids)} nm"
              + (f", сбойных батчей: {failed_batches}" if failed_batches else ""), flush=True)
    except Exception as e:
        # Колонок 029 ещё нет → не валим основной сбор, но кричим в лог.
        print(f"[wb_prices] цена сайта НЕ записана: {e}", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
