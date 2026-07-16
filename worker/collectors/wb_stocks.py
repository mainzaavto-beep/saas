"""
SaaS-сборщик ОСТАТКОВ по складам WB → tenant.wb_daily_stock.

supplier/stocks (dateFrom=сегодня-7 → снимок «сейчас» по складам).
⚠️ Раньше был dateFrom=2020-01-01 — WB отдаёт огромный JSON (все склады за всю
историю), запрос вис >30 мин. Снимок всё равно «на сейчас», дата влияет только
на размер ответа. Сужено до последней недели (2026-07-12, gotcha #140).
Пишется на дату = сегодня (append-only; WB исторические остатки не отдаёт).
Токен из env WB_TOKEN. Идемпотентно по (cabinet_id, nm_id, date, warehouse).

⚠️ Отказоустойчивость к rate-limit (gotcha #141, инцидент 2026-07-14):
endpoint supplier/stocks часто уходит в жёсткий 429 рано утром. Раньше после
5 попыток коллектор кидал RuntimeError → падал весь saas-stocks.service
(вместе с успешным ozon_stocks). Теперь: при недоступности WB APIcollector
завершается УСПЕШНО (exit 0) с предупреждением — снимок просто не пишется
за этот прогон, но сервис не падает и следующий таймер допишет.
"""
import os
import sys
import time
import requests
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
STOCKS_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/stocks"

MAX_ATTEMPTS = 8   # было 5 — при жёстком 429 рано утром не хватало
MAX_TOTAL_WAIT = 600  # потолок суммарного ожидания (10 мин), чтобы не висеть бесконечно


def _fetch():
    """Вернёт list-ответ WB либо None, если API недоступен (rate-limit/сеть).
    None вместо исключения — чтобы collector мог завершиться мягко (см. collect)."""
    if not WB_TOKEN:
        print("[wb_stocks] WB_TOKEN не выставлен — пропуск", flush=True)
        return None
    headers = {"Authorization": WB_TOKEN}
    params = {"dateFrom": (date.today() - timedelta(days=7)).strftime("%Y-%m-%d")}
    waited = 0
    for attempt in range(MAX_ATTEMPTS):
        try:
            r = requests.get(STOCKS_URL, headers=headers, params=params, timeout=120)
        except requests.RequestException as e:
            print(f"  сетевой сбой ({e.__class__.__name__}), попытка {attempt+1}/{MAX_ATTEMPTS}", flush=True)
            time.sleep(10); waited += 10
            continue
        if r.status_code == 429:
            # Жёсткий rate-limit: WB сам говорит, сколько ждать (Retry-After).
            wait = int(r.headers.get("Retry-After", 60))
            if waited + wait > MAX_TOTAL_WAIT:
                print(f"  429: потолок ожидания исчерпан (ждали бы {waited+wait}с > {MAX_TOTAL_WAIT}с) — сдаёмся", flush=True)
                return None
            print(f"  429, жду {wait}с... (попытка {attempt+1}/{MAX_ATTEMPTS}, всего ждали {waited}с)", flush=True)
            time.sleep(wait); waited += wait
            continue
        if r.status_code >= 500:
            print(f"  {r.status_code} (сервер WB), попытка {attempt+1}/{MAX_ATTEMPTS}", flush=True)
            time.sleep(15); waited += 15
            continue
        r.raise_for_status()
        return r.json()
    print(f"  supplier/stocks: недоступен после {MAX_ATTEMPTS} попыток — снимок пропущен", flush=True)
    return None


def collect():
    today = date.today().isoformat()
    print(f"[wb_stocks] снимок остатков на {today}", flush=True)
    db_pg.init()
    data = _fetch()
    if data is None:
        # WB API недоступен — НЕ падаем. Снимок за сегодня просто не запишется,
        # следующий прогон таймера допишет. Это лучше, чем валить весь сервис
        # (ozon_stocks и т.д.). См. инцидент 2026-07-14.
        print("[wb_stocks] ПРОПУСК: WB API недоступен, снимок не записан (exit 0)", flush=True)
        return 0
    known = set(db_pg.active_nm_ids())
    rows = []
    for s in data:
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

