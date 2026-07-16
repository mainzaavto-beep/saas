"""
SaaS-сборщик ОСТАТКОВ Ozon FBO → tenant.ozon_daily_stock.

/v2/analytics/stock_on_warehouses. Грабля #135: новые имена полей API 2026
(free_to_sell_amount, reserved_amount). fbo_defect в новом API нет → NULL.
sku→product_id через PG. Токен из env. Без Google Sheets.

⚠️ Отказоустойчивость (симметрично wb_stocks #141): при недоступности Ozon API
collector завершается УСПЕШНО (exit 0) с предупреждением, не валивая весь
saas-stocks.service.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient, OzonError


def collect():
    today = date.today().isoformat()
    print(f"[ozon_stocks] снимок остатков на {today}", flush=True)
    db_pg.init()

    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        if r["fbo_sku"] is not None:
            sku2pid[int(r["fbo_sku"])] = int(r["product_id"])

    cli = OzonClient()
    rows = []
    n_orphans = 0
    try:
        stock_iter = cli.iter_stock()
    except OzonError as e:
        print(f"[ozon_stocks] ПРОПУСК: Ozon API недоступен ({e}), снимок не записан (exit 0)", flush=True)
        return 0
    for r in stock_iter:
        sku = r.get("sku") or r.get("product_id")
        wh = r.get("warehouse_name") or r.get("warehouse")
        if sku is None or not wh:
            continue
        pid = sku2pid.get(int(sku))
        if pid is None:
            n_orphans += 1
            continue
        fbo_present = (
            r.get("free_to_sell_amount")
            if r.get("free_to_sell_amount") is not None
            else (r.get("promised_amount") or r.get("present") or r.get("fbo_present") or 0)
        )
        fbo_reserved = (
            r.get("reserved_amount")
            if r.get("reserved_amount") is not None
            else (r.get("reserved") or 0)
        )
        rows.append({
            "product_id": pid, "date": today, "warehouse": wh,
            "fbo_present": fbo_present, "fbo_reserved": fbo_reserved, "fbo_defect": None,
        })
    written = db_pg.upsert_ozon_stock_many(rows)
    print(f"[ozon_stocks] записано {written} строк"
          + (f", пропущено {n_orphans}" if n_orphans else ""), flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()

