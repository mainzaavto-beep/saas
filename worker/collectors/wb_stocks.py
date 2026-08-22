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
   • Новые поля chrtId / regionName — не пишем (схема не менялась, колонок
     для них нет; при желании добавим миграцией). warehouseId — пишем.

⚠️ ГРАБЛЯ chrtId (фикс 2026-07-22): WB отдаёт ОТДЕЛЬНУЮ строку на каждый
   chrtId (характеристика = размер/цвет внутри карточки nm_id). Товары с
   размерами дают несколько строк на один (nm_id, warehouseName). PK таблицы
   = (cabinet_id, nm_id, date, warehouse) → без агрегации эти строки
   перезаписывали друг друга через ON CONFLICT DO UPDATE, выживала последняя.
   Симптом: по Невинномысску WB ЛК показывал ~225 шт, у нас 135 (разница 90
   = два размерных товара: 63→12 и 54→15, выжили последние chrtId).
   Фикс: в collect() строки группируются по (nm_id, warehouse) ДО upsert,
   quantity/inWay* складываются. Код чтения трогать не нужно — все SELECT'ы
   в stocks/route.js уже используют SUM+GROUP BY.

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

    # ⚠️ АГРЕГАЦИЯ chrtId → одна строка на (nm_id, склад) [фикс 2026-07-22].
    # WB отдаёт ОТДЕЛЬНУЮ строку на каждый chrtId (характеристика = размер/цвет
    # внутри карточки nm_id). Товары с размерами дают 2-5 строк на один (nm_id,
    # warehouseName). PK таблицы = (cabinet_id, nm_id, date, warehouse) → без
    # агрегации строки перезаписывали друг друга через ON CONFLICT DO UPDATE,
    # выживала последняя (терялось до 90 шт на Невинномысске: 63→12, 54→15).
    # Группируем заранее: складываем quantity / inWay* всех характеристик.
    # warehouse_id берём из первой строки группы (одинаков для одного склада).
    grouped = {}  # (nm_id, warehouse_name) → {quantity, in_to, in_from, warehouse_id}
    skipped_unknown_nm = 0
    skipped_no_wh = 0
    for s in data:
        nm = s.get("nmId")
        if nm not in known:
            skipped_unknown_nm += 1
            continue  # только артикулы каталога
        wh = s.get("warehouseName")
        if not wh:
            skipped_no_wh += 1
            continue
        key = (nm, wh)
        qty = int(s.get("quantity", 0) or 0)
        in_to = int(s.get("inWayToClient", 0) or 0)
        in_from = int(s.get("inWayFromClient", 0) or 0)
        acc = grouped.get(key)
        if acc is None:
            # warehouse_id одинаковый для всех строк одного склада, но кладём
            # только при первом появлении (на случай NULL в какой-то строке).
            grouped[key] = {
                "quantity": qty, "in_to": in_to, "in_from": in_from,
                "warehouse_id": s.get("warehouseId"),
            }
        else:
            acc["quantity"] += qty
            acc["in_to"] += in_to
            acc["in_from"] += in_from
            if acc.get("warehouse_id") is None:
                acc["warehouse_id"] = s.get("warehouseId")

    # Разворот аккумулированных групп в строки для upsert.
    rows = []
    for (nm, wh), acc in grouped.items():
        qty = acc["quantity"]
        in_to = acc["in_to"]
        in_from = acc["in_from"]
        # ⚠️ Новый endpoint НЕ отдаёт quantityFull — считаем сами:
        # полный остаток = склад + в пути к клиенту + в пути от клиента.
        rows.append({
            "nm_id": nm, "date": today, "warehouse": wh,
            "warehouse_id": acc["warehouse_id"],  # для маппинга к shared.wb_warehouses (миграция 025)
            "quantity": qty,
            "quantity_full": qty + in_to + in_from,
            "in_way_to": in_to,
            "in_way_from": in_from,
        })

    # Диагностика: сколько характеристик было свёрнуто (лог помогает заметить
    # регрессию, если WB поменяет структуру ответа).
    n_src = len(data)
    n_merged = n_src - len(rows) - skipped_unknown_nm - skipped_no_wh
    if n_merged > 0:
        print(f"[wb_stocks] свёрнуто chrtId-дублей: {n_merged} "
              f"({n_src} строк API → {len(rows)} уникальных nm_id+склад)", flush=True)
    n = db_pg.upsert_stock_many(rows)
    print(f"[wb_stocks] записано {n} строк → tenant.wb_daily_stock", flush=True)
    print(f"##OBS rows={n}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
