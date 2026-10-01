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
   • chrtId (размер) — с 2026-10-01 пишется во ВТОРУЮ таблицу
     tenant.wb_daily_stock_sizes (миграция 063, см. build_rows); regionName — не
     пишем. warehouseId — пишем.

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


def build_rows(data, known, today):
    """Чистая функция (без сети и БД): ответ stocks-report → строки двух таблиц.

    Возвращает (agg_rows, size_rows, stats):
      • agg_rows  — одна строка на (nm_id, склад), chrtId свёрнуты (ГРАБЛЯ chrtId,
        фикс 2026-07-22) → tenant.wb_daily_stock, поведение НЕ менялось;
      • size_rows — одна строка на (nm_id, chrt_id, склад) → tenant.wb_daily_stock_sizes
        (миграция 063, с 2026-10-01). Размер (tech_size) в ответе WB нет — только
        chrtId; имя размера панель берёт из tenant.wb_barcodes (Content API).
        chrtId=None → 0 (строка не теряется, Σ по размерам = агрегату).
    Инвариант (проверяет селф-тест): Σ size_rows по (nm, склад) == agg_rows.
    """
    grouped = {}  # (nm_id, warehouse_name) → {quantity, in_to, in_from, warehouse_id}
    by_size = {}  # (nm_id, chrt_id, warehouse_name) → то же
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
        qty = int(s.get("quantity", 0) or 0)
        in_to = int(s.get("inWayToClient", 0) or 0)
        in_from = int(s.get("inWayFromClient", 0) or 0)
        chrt = int(s.get("chrtId") or 0)
        for acc_map, key in ((grouped, (nm, wh)), (by_size, (nm, chrt, wh))):
            acc = acc_map.get(key)
            if acc is None:
                # warehouse_id одинаковый для всех строк одного склада, но кладём
                # только при первом появлении (на случай NULL в какой-то строке).
                acc_map[key] = {
                    "quantity": qty, "in_to": in_to, "in_from": in_from,
                    "warehouse_id": s.get("warehouseId"),
                }
            else:
                acc["quantity"] += qty
                acc["in_to"] += in_to
                acc["in_from"] += in_from
                if acc.get("warehouse_id") is None:
                    acc["warehouse_id"] = s.get("warehouseId")

    def _row(acc, **extra):
        # ⚠️ Новый endpoint НЕ отдаёт quantityFull — считаем сами:
        # полный остаток = склад + в пути к клиенту + в пути от клиента.
        r = dict(extra)
        r.update({
            "date": today,
            "warehouse_id": acc["warehouse_id"],  # для маппинга к shared.wb_warehouses (миграция 025)
            "quantity": acc["quantity"],
            "quantity_full": acc["quantity"] + acc["in_to"] + acc["in_from"],
            "in_way_to": acc["in_to"],
            "in_way_from": acc["in_from"],
        })
        return r

    agg_rows = [_row(acc, nm_id=nm, warehouse=wh) for (nm, wh), acc in grouped.items()]
    size_rows = [_row(acc, nm_id=nm, chrt_id=chrt, warehouse=wh)
                 for (nm, chrt, wh), acc in by_size.items()]
    stats = {
        "src": len(data),
        "skipped_unknown_nm": skipped_unknown_nm,
        "skipped_no_wh": skipped_no_wh,
        "merged": len(data) - len(agg_rows) - skipped_unknown_nm - skipped_no_wh,
        "no_chrt": sum(1 for (_, c, _) in by_size if c == 0),
    }
    return agg_rows, size_rows, stats


def collect():
    """Возвращает код выхода: 0 ok · 3 partial (основной снимок записан, размеры — нет)."""
    today = date.today().isoformat()
    probe = os.environ.get("SAAS_PROBE")
    print(f"[wb_stocks] снимок остатков на {today}" + (f" (ПРОБА {probe}: без записи)" if probe else ""), flush=True)
    db_pg.init()
    data = _fetch()
    if data is None:
        # WB API недоступен — НЕ падаем. Снимок за сегодня просто не запишется,
        # следующий прогон таймера допишет. Это лучше, чем валить весь сервис
        # (ozon_stocks и т.д.). См. инцидент 2026-07-14.
        print("[wb_stocks] ПРОПУСК: WB API недоступен, снимок не записан (exit 0)", flush=True)
        return 0
    known = set(db_pg.active_nm_ids())
    rows, size_rows, st = build_rows(data, known, today)

    # Диагностика: сколько характеристик было свёрнуто (лог помогает заметить
    # регрессию, если WB поменяет структуру ответа).
    if st["merged"] > 0:
        print(f"[wb_stocks] свёрнуто chrtId-дублей: {st['merged']} "
              f"({st['src']} строк API → {len(rows)} уникальных nm_id+склад, "
              f"{len(size_rows)} строк по размерам)", flush=True)
    if st["no_chrt"]:
        print(f"[wb_stocks] ⚠ строк без chrtId: {st['no_chrt']} (записаны с chrt_id=0)", flush=True)

    if probe:
        import json
        print("[wb_stocks] ПРОБА: первые сырые строки API:", flush=True)
        for s in data[:5]:
            print("   " + json.dumps(s, ensure_ascii=False), flush=True)
        whs = sorted({(r["warehouse"], r["warehouse_id"]) for r in rows}, key=str)
        multi = {}
        for r in size_rows:
            multi.setdefault(r["nm_id"], set()).add(r["chrt_id"])
        n_multi = sum(1 for v in multi.values() if len(v) > 1)
        # Сводка — ПОСЛЕДНЕЙ строкой: оркестратор показывает только её.
        print(f"[wb_stocks] ПРОБА: api={st['src']} чужих_nm={st['skipped_unknown_nm']} "
              f"без_склада={st['skipped_no_wh']} без_chrt={st['no_chrt']} → agg={len(rows)} "
              f"sizes={len(size_rows)} nm_с_>1_размером={n_multi} "
              f"Σqty agg/sizes={sum(r['quantity'] for r in rows)}/{sum(r['quantity'] for r in size_rows)} "
              f"складов={len(whs)} {whs[:5]}", flush=True)
        return 0

    n = db_pg.upsert_stock_many(rows)
    print(f"[wb_stocks] записано {n} строк → tenant.wb_daily_stock", flush=True)
    print(f"##OBS rows={n}", flush=True)

    # Разбивка по размерам — ОТДЕЛЬНОЙ транзакцией ПОСЛЕ основного снимка:
    # её сбой (нет миграции 063, ошибка записи) не откатывает и не ломает
    # агрегат, а делает прогон partial (exit 3) — видно в jobs.collector_runs.
    try:
        ns = db_pg.upsert_stock_sizes_many(size_rows)
        print(f"[wb_stocks] записано {ns} строк → tenant.wb_daily_stock_sizes", flush=True)
    except Exception as e:
        print(f"[wb_stocks] ⚠ ОШИБКА записи по размерам ({e.__class__.__name__}: {e}) — "
              f"основной снимок записан, прогон partial", flush=True)
        return 3
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    sys.exit(collect())
