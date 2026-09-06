"""
SaaS-сборщик FBS-ОСТАТКОВ складов продавца WB → tenant.mp_fbs_daily_stock (platform='wb').

Почему не stocks-report: с 01.09.2026 stocks-report/wb-warehouses отдаёт кабинету #1
одну строку «Склад WB» (warehouse_id=-999999) — WB скрыл разбивку по складам,
складов продавца там нет (осмотр 06.09). Поэтому marketplace-api:
  POST /api/v3/stocks/{warehouseId}  body {skus:[штрихкоды]} (≤1000 за запрос)
  → {stocks:[{sku, amount}]}. Штрихкод → nm_id по tenant.wb_barcodes ∪ wb_orders,
суммируем по nm_id (размеры/цвета). Склады — активные tenant.mp_seller_warehouses
(wb_seller_warehouses, тик references). Тик stocks (08:00), снимок «на сейчас».

SAAS_PROBE=1 — печатает ответ первого склада, не пишет.
SAAS_PROBE=verify — сверяет ответ API с сегодняшним снимком в БД (Δ по строкам),
exit 1 при расхождении (сторож §6 спеки). Мягкая деградация как у wb_stocks.
"""
import os
import sys
import time
from datetime import date, datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe

WB_TOKEN = os.getenv("WB_TOKEN")
STOCKS_URL = "https://marketplace-api.wildberries.ru/api/v3/stocks/{wid}"
CHUNK = 1000
MAX_ATTEMPTS = 4


def _post(url, body):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.post(url, headers={"Authorization": WB_TOKEN}, json=body, timeout=60)
        except requests.RequestException as e:
            print(f"  сеть ({attempt}/{MAX_ATTEMPTS}): {e}", flush=True)
            time.sleep(2 * attempt)
            continue
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "10") or 10)
            time.sleep(min(wait, 60))
            continue
        if resp.status_code >= 500:
            time.sleep(2 * attempt)
            continue
        print(f"  ОШИБКА {resp.status_code}: {resp.text[:200]}", flush=True)
        return None
    return None


def fetch_warehouse_stocks(wid, barcodes):
    """Все пачки одного склада. None — если хоть одна пачка недоступна."""
    out = []
    for i in range(0, len(barcodes), CHUNK):
        data = _post(STOCKS_URL.format(wid=wid), {"skus": barcodes[i:i + CHUNK]})
        if data is None:
            return None
        out.extend(data.get("stocks") or [])
        time.sleep(0.3)
    return out


def aggregate(warehouse_id, stocks, barcode2nm, today):
    """[{sku, amount}] → строки mp_fbs_daily_stock, сумма amount по nm_id.
    Штрихкоды, которых нет в карте, пропускаются (лог — в collect)."""
    acc = {}
    for s in stocks or []:
        nm = barcode2nm.get(str(s.get("sku")))
        if nm is None:
            continue
        acc[nm] = acc.get(nm, 0) + int(s.get("amount") or 0)
    return [{"platform": "wb", "warehouse_id": int(warehouse_id), "sku_key": nm, "date": today,
             "present": qty, "reserved": None} for nm, qty in acc.items()]


def collect():
    today = date.today().isoformat()
    print(f"[wb_fbs_stocks] FBS-остатки складов продавца на {today} ({datetime.now():%H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_fbs_stocks] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    db_pg.init()
    wids = db_pg.seller_warehouse_ids("wb")
    if not wids:
        print("[wb_fbs_stocks] ПРОПУСК: нет складов продавца (сначала wb_seller_warehouses)", flush=True)
        return 0
    bc = db_pg.wb_barcode_map()
    barcodes = sorted(bc)
    if not barcodes:
        print("[wb_fbs_stocks] ПРОПУСК: нет штрихкодов (сначала wb_catalog)", flush=True)
        return 0
    rows, unknown = [], 0
    for wid in wids:
        stocks = fetch_warehouse_stocks(wid, barcodes)
        if stocks is None:
            print(f"[wb_fbs_stocks] ПРОПУСК: API недоступен на складе {wid}, снимок не записан (exit 0)", flush=True)
            return 0
        if _probe.mode() == "1":
            _probe.dump(f"POST /api/v3/stocks/{wid}", stocks, n=5)
            return 0
        unknown += sum(1 for s in stocks if str(s.get("sku")) not in bc)
        rows.extend(aggregate(wid, stocks, bc, today))
    if _probe.mode() == "verify":
        db_rows = db_pg.mp_fbs_stock_today("wb", today)
        api = {(r["warehouse_id"], r["sku_key"]): r["present"] for r in rows}
        diff = [(k, api.get(k), db_rows.get(k)) for k in set(api) | set(db_rows) if api.get(k) != db_rows.get(k)]
        print(f"[wb_fbs_stocks] verify: api={len(api)} db={len(db_rows)} Δ={len(diff)} {diff[:10]}", flush=True)
        sys.exit(1 if diff else 0)
    n = db_pg.upsert_mp_fbs_stock_many(rows)
    print(f"[wb_fbs_stocks] складов {len(wids)}, строк {n}"
          + (f", неизвестных штрихкодов {unknown}" if unknown else ""), flush=True)
    print(f"##OBS rows={n}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
