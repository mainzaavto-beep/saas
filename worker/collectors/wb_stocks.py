"""
SaaS-сборщик ОСТАТКОВ по складам WB → tenant.wb_daily_stock.

⚠️ МИГРАЦИЯ 2026-07-18: старый endpoint GET /api/v1/supplier/stocks отключён WB
   (429 + detail "This method is deprecated", дедлайн 23 июня / 15 июля 2026 —
   release-notes #494/#431). Новый: POST /api/analytics/v1/stocks-report/
   wb-warehouses на хосте seller-analytics-api (модуль Analytics, не Supplier).

   Отличия нового endpoint (проверены живым probe'ом 2026-07-18):
   • POST, а не GET; параметры в body, не в query.
   • Body: {isSupplyWarehouse: true, isWBWarehouse: true} — оба типа складов
     (поставочные + маркетплейс). Без body → 400 "Request body is empty".
   • Ответ: {data:{items:[{nmId, chrtId, warehouseId, warehouseName, regionName,
     quantity, inWayToClient, inWayFromClient}]}}.
   • ⚠️ НЕТ поля quantityFull (как в старом) → считаем сами:
       quantity_full = quantity + inWayToClient + inWayFromClient
     (склад + в пути обе стороны). Это и есть «полный остаток».
   • Новые поля chrtId / warehouseId / regionName — не пишем (схема не менялась,
     колонок для них нет; при желании добавим миграцией).

Пишется на дату = сегодня (append-only; WB исторические остатки не отдаёт).
Токен из env WB_TOKEN. Идемпотентно по (cabinet_id, nm_id, date, warehouse).

⚠️ Отказоустойчивость к недоступности WB API (gotcha #141, инцидент 2026-07-14):
при недоступности collector завершается УСПЕШНО (exit 0) с предупреждением —
снимок просто не пишется за этот прогон, но сервис не падает и следующий
таймер допишет. Это спасает ozon_stocks, который бежит в той же services-группе.
"""
import os
import sys
import time
import requests
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")

# Новый endpoint (Analytics) — замена депрекейтного supplier/stocks.
# Хост seller-analytics-api тот же, что у wb_metrics (воронка продаж).
STOCKS_URL = "https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses"

MAX_ATTEMPTS = 8   # при жёстком 429 рано утром может не хватать
MAX_TOTAL_WAIT = 600  # потолок суммарного ожидания (10 мин)


def _fetch():
    """Вернёт list-ответ WB (items) либо None, если API недоступен (rate-limit/сеть).
    None вместо исключения — чтобы collector мог завершиться мягко (см. collect)."""
    if not WB_TOKEN:
        print("[wb_stocks] WB_TOKEN не выставлен — пропуск", flush=True)
        return None
    headers = {"Authorization": WB_TOKEN, "Content-Type": "application/json"}
    # Body: оба типа складов WB (поставочные + обычные маркетплейс-склады).
    body = {"isSupplyWarehouse": True, "isWBWarehouse": True}
    waited = 0
    for attempt in range(MAX_ATTEMPTS):
        try:
            r = requests.post(STOCKS_URL, headers=headers, json=body, timeout=120)
        except requests.RequestException as e:
            print(f"  сетевой сбой ({e.__class__.__name__}), попытка {attempt+1}/{MAX_ATTEMPTS}", flush=True)
            time.sleep(10); waited += 10
            continue
        if r.status_code == 429:
            # Rate-limit. WB сам говорит, сколько ждать (Retry-After).
            # ⚠️ Но 429 может означать и депрекацию (как со старым endpoint) —
            # проверим тело на "deprecated", чтобы не loops'ить бесконечно.
            wait = int(r.headers.get("Retry-After", 60))
            try:
                detail = (r.json() or {}).get("detail", "")
            except Exception:
                detail = ""
            if "deprecated" in str(detail).lower():
                print(f"  429 + deprecated: endpoint устарел или невалиден — {detail}", flush=True)
                return None
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
        # Ответ: {data:{items:[...]}}. Возвращаем именно items (list).
        payload = r.json()
        items = ((payload or {}).get("data") or {}).get("items") or []
        return items
    print(f"  stocks-report/wb-warehouses: недоступен после {MAX_ATTEMPTS} попыток — снимок пропущен", flush=True)
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
        qty = int(s.get("quantity", 0) or 0)
        in_to = int(s.get("inWayToClient", 0) or 0)
        in_from = int(s.get("inWayFromClient", 0) or 0)
        # ⚠️ Новый endpoint НЕ отдаёт quantityFull — считаем сами:
        # полный остаток = склад + в пути к клиенту + в пути от клиента.
        rows.append({
            "nm_id": nm, "date": today, "warehouse": wh,
            "quantity": qty,
            "quantity_full": qty + in_to + in_from,
            "in_way_to": in_to,
            "in_way_from": in_from,
        })
    n = db_pg.upsert_stock_many(rows)
    print(f"[wb_stocks] записано {n} строк → tenant.wb_daily_stock", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
