"""
SaaS-сборщик ЗАКАЗОВ и ПРОДАЖ WB → tenant.wb_orders / tenant.wb_sales.

statistics-api supplier/orders + supplier/sales. flag=0 = все записи (вкл.
отменённые). Пишет по ВСЕМ товарам клиента (фильтра по «активному» ярлыку нет).
Диапазон: по умолчанию за вчера; argv[0]=start, argv[1]=end (бэкфилл).

Идемпотентно по (cabinet_id, srid) / (cabinet_id, sale_id). Токен из env WB_TOKEN.
Артикулы регистрируются из самого фида (если нет в каталоге) — для FK.
"""
import os
import sys
import time
import requests
from datetime import datetime, timedelta, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
ORDERS_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/orders"
SALES_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/sales"


def _fetch(url, date_from):
    """Все записи начиная с date_from одним запросом. flag=0 = все. Retry на 429."""
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    headers = {"Authorization": WB_TOKEN}
    params = {"dateFrom": f"{date_from}T00:00:00", "flag": 0}
    for attempt in range(5):
        try:
            r = requests.get(url, headers=headers, params=params, timeout=120)
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
    raise RuntimeError(f"{url}: не удалось получить данные после 5 попыток")


def _in_range(rec, start, end):
    # flag=0 отдаёт от WB всё, у чего lastChangeDate >= dateFrom (что ИЗМЕНИЛОСЬ),
    # а не что создано в окне. rec["date"] — дата СОЗДАНИЯ заказа/продажи и не
    # меняется при отмене — фильтр по нему выбрасывал заказы, созданные раньше
    # окна, но отменённые внутри него (и любые другие поздние изменения записи).
    # Фильтруем по lastChangeDate — так совпадает с тем, что реально просили у API.
    d = (rec.get("lastChangeDate") or "")[:10]
    return start <= d <= end


def collect(start=None, end=None):
    """Собрать заказы/продажи. start/end — YYYY-MM-DD (None = вчера)."""
    yest = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = start or yest
    end = end or yest
    datetime.strptime(start, "%Y-%m-%d")
    datetime.strptime(end, "%Y-%m-%d")
    print(f"[wb_orders] фид {start}…{end}", flush=True)

    db_pg.init()
    orders = [o for o in _fetch(ORDERS_URL, start) if _in_range(o, start, end)]
    print(f"  заказов в периоде: {len(orders)}", flush=True)
    time.sleep(0.5)
    sales = [s for s in _fetch(SALES_URL, start) if _in_range(s, start, end)]
    print(f"  продаж/возвратов: {len(sales)}", flush=True)

    # Регистрируем артикулы из фида (если нет в каталоге) — для FK/консистентности.
    known = set(db_pg.active_nm_ids())
    extra = {}
    for rec in orders + sales:
        nm = rec.get("nmId")
        if nm and nm not in known and nm not in extra:
            extra[nm] = rec.get("supplierArticle") or str(nm)
    for nm, name in extra.items():
        db_pg.upsert_article(nm, name)
    if extra:
        print(f"  +{len(extra)} артикулов из фида (нет в каталоге)", flush=True)
        known |= set(extra)

    orders = [o for o in orders if o.get("nmId") in known]
    sales = [s for s in sales if s.get("nmId") in known]
    no = db_pg.upsert_orders_many(orders)
    ns = db_pg.upsert_sales_many(sales)
    print(f"[wb_orders] записано: orders +{no}, sales +{ns}", flush=True)
    print(f"##OBS rows={no + ns} from={start} to={end}", flush=True)
    return no + ns


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
