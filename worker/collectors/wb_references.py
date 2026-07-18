"""
Сборщик справочников WB → shared.* (глобальные, без cabinet_id/RLS).

Раз в неделю (таймер saas-references, понедельник 06:00 — до основного утреннего
сбора) тащит три справочника:
  • склады WB (id→name→address→isActive/isTransitActive)
  • тарифы перевозок между складами (transit→dest, boxTariff, palletTariff)
  • регион/кластер склада (regionName → shared.wb_warehouses.region)

Справочники нужны для вкладки «Эффективность складов» на /stocks: WB не отдаёт
endpoint создания перевозки, но отдаёт эти справочники — на их основе дашборд
строит оборачиваемость, локальность и рекомендации по перевозке. Кластер склада
(region) нужен для расчёта local_pct.

Подтверждено живым probe 2026-07-18 (cabinet #1):
  • GET  supplies-api.../api/v1/warehouses      → 129 складов {ID, name, address,
    workTime, isActive, isTransitActive} (БЕЗ региона!)
  • GET  supplies-api.../api/v1/transit-tariffs → 138 направлений {transitWarehouseName,
    destinationWarehouseName, activeFrom, boxTariff:[{from,to,value}...], palletTariff}
  • POST seller-analytics-api.../api/analytics/v1/stocks-report/wb-warehouses
    body {isSupplyWarehouse:true, isWBWarehouse:true} → {data:{items:[{nmId,
    warehouseId, warehouseName, regionName, ...}]}}. regionName = укрупнённый
    кластер склада (Центральный, Приволжский и т.д.). Это ЕДИНСТВЕННЫЙ источник
    кластера склада — endpoint /warehouses его не отдаёт.

⚠️ Регион собирается как Map<warehouseName, regionName> из stocks-report (там
имена совпадают со stocks-снимком). Сборщик wb_stocks пишет те же warehouseName
в daily_stock — поэтому маппинг по имени надёжный. При upsert region подаётся
через COALESCE — если stocks-report недоступен, старый region не затирается.

⚠️ Отказоустойчивость (как wb_stocks): при недоступности WB API завершается
exit 0, справочник остаётся с прошлой недели. Сервис не падать.
"""
import os
import sys
import time
import requests
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")

WAREHOUSES_URL = "https://supplies-api.wildberries.ru/api/v1/warehouses"
TARIFFS_URL = "https://supplies-api.wildberries.ru/api/v1/transit-tariffs"
# stocks-report — единственный источник regionName (кластер склада).
STOCKS_REPORT_URL = "https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses"

MAX_ATTEMPTS = 4   # справочник не критичен, долго не ждём
MAX_TOTAL_WAIT = 120


def _get(url):
    """GET с retry на 429/5xx. Возвращает parsed JSON или None при недоступности."""
    return _request("GET", url, None)


def _post(url, body):
    """POST с retry на 429/5xx. Возвращает parsed JSON или None при недоступности."""
    return _request("POST", url, body)


def _request(method, url, body):
    """Универсальный HTTP с retry. Возвращает parsed JSON или None."""
    if not WB_TOKEN:
        print("[wb_references] WB_TOKEN не выставлен — пропуск", flush=True)
        return None
    headers = {"Authorization": WB_TOKEN}
    waited = 0
    for attempt in range(MAX_ATTEMPTS):
        try:
            if method == "GET":
                r = requests.get(url, headers=headers, timeout=60)
            else:
                headers["Content-Type"] = "application/json"
                r = requests.post(url, headers=headers, json=body, timeout=120)
        except requests.RequestException as e:
            print(f"  сетевой сбой ({e.__class__.__name__}), попытка {attempt+1}/{MAX_ATTEMPTS}", flush=True)
            time.sleep(8); waited += 8
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 30))
            try:
                detail = (r.json() or {}).get("detail", "")
            except Exception:
                detail = ""
            if "deprecated" in str(detail).lower():
                print(f"  429 + deprecated: endpoint устарел — {detail}", flush=True)
                return None
            if waited + wait > MAX_TOTAL_WAIT:
                print(f"  429: потолок ожидания исчерпан — сдаёмся", flush=True)
                return None
            print(f"  429, жду {wait}с... (попытка {attempt+1}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(wait); waited += wait
            continue
        if r.status_code >= 500:
            print(f"  {r.status_code} (сервер WB), попытка {attempt+1}/{MAX_ATTEMPTS}", flush=True)
            time.sleep(10); waited += 10
            continue
        r.raise_for_status()
        return r.json()
    print(f"  {url}: недоступен после {MAX_ATTEMPTS} попыток — пропуск", flush=True)
    return None


def _collect_warehouses():
    """Сбор справочника складов из ДВУХ источников:
    1. POST stocks-report/wb-warehouses — ПЕРВИЧНЫЙ, содержит warehouseId+warehouseName+
       regionName в одном ответе (имена совпадают с теми, что пишет wb_stocks в снимок).
    2. GET /api/v1/warehouses — ДОПОЛНЕНИЕ для складов без остатков (там 129 активных,
       но БЕЗ regionName; маппинг региона по имени не работает из-за расхождений
       «Воронеж WB» vs «Воронеж»). Поэтому /warehouses идёт ПОСЛЕ stocks-report —
       только новые id (ON CONFLICT) + без региона (COALESCE сохранит уже записанный).
    """
    rows = []
    sr_count = 0
    # 1) stocks-report — первичный, с регионом.
    payload = _post(STOCKS_REPORT_URL, {"isSupplyWarehouse": True, "isWBWarehouse": True})
    if payload is not None:
        items = ((payload or {}).get("data") or {}).get("items") or []
        seen_ids = set()
        for it in items:
            try:
                wid = int(it.get("warehouseId") or 0)
            except (TypeError, ValueError):
                continue
            # Пропускаем только отрицательные. id=0 («Остальные») — легитимный
            # псевдо-склад WB, регион у него есть (обычно «Центральный»).
            if wid < 0 or wid in seen_ids:
                continue
            seen_ids.add(wid)
            rows.append({
                "id": wid,
                "name": it.get("warehouseName"),
                "address": None,            # stocks-report не отдаёт address
                "work_time": None,
                "is_active": True,
                "is_transit_active": None,  # COALESCE сохранит старое при отсутствии
                "region": it.get("regionName"),
            })
        sr_count = len(rows)
        print(f"  stocks-report: {sr_count} складов (с регионом)", flush=True)

    # 2) /warehouses — дополнение (новые id; без региона → COALESCE сохранит старый).
    data = _get(WAREHOUSES_URL)
    wh_count = 0
    if data is not None:
        existing_ids = {r["id"] for r in rows}
        for w in data:
            try:
                wid = int(w.get("ID") or w.get("id") or 0)
            except (TypeError, ValueError):
                continue
            if wid < 0 or wid in existing_ids:
                continue
            existing_ids.add(wid)
            rows.append({
                "id": wid,
                "name": w.get("name"),
                "address": w.get("address"),
                "work_time": w.get("workTime"),
                "is_active": bool(w.get("isActive")),
                "is_transit_active": bool(w.get("isTransitActive")),
                "region": None,  # /warehouses не отдаёт регион — COALESCE сохранит
            })
        wh_count = len(rows) - sr_count
        print(f"  /warehouses: +{wh_count} складов (без региона, дополнение)", flush=True)

    if not rows:
        print("[wb_references] склады: WB API недоступен — справочник не обновлён", flush=True)
        return 0

    n = db_pg.upsert_shared_wb_warehouses(rows)
    print(f"[wb_references] справочник складов: {n} строк → shared.wb_warehouses "
          f"(stocks-report {sr_count} + /warehouses {wh_count})", flush=True)
    return n


def _collect_tariffs():
    data = _get(TARIFFS_URL)
    if data is None:
        return 0
    rows = []
    for d in data:
        src = d.get("transitWarehouseName")
        dst = d.get("destinationWarehouseName")
        if not src or not dst:
            continue
        active_from = d.get("activeFrom")
        # ISO datetime → дату (берём первые 10 симвлов YYYY-MM-DD).
        if isinstance(active_from, str) and len(active_from) >= 10:
            active_from = active_from[:10]
        rows.append({
            "transit_warehouse_name": src,
            "destination_warehouse_name": dst,
            "active_from": active_from,
            "box_tariff": d.get("boxTariff"),     # list of {from,to,value} → JSONB
            "pallet_tariff": d.get("palletTariff"),
        })
    n = db_pg.upsert_shared_wb_transit_tariffs(rows)
    print(f"[wb_references] тарифы перевозок: {n} направлений → shared.wb_transit_tariffs", flush=True)
    return n


def collect():
    print(f"[wb_references] обновление справочников WB ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    # init() — noop, но зовём для единообразия с другими сборщиками.
    db_pg.init()
    nw = _collect_warehouses()
    nt = _collect_tariffs()
    if nw == 0 and nt == 0:
        print("[wb_references] ПРОПУСК: WB API недоступен, справочники не обновлены (exit 0)", flush=True)
        return 0
    return nw + nt


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
