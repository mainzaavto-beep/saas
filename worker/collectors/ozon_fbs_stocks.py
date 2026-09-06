"""
SaaS-сборщик FBS-ОСТАТКОВ складов продавца Ozon → tenant.mp_fbs_daily_stock (platform='ozon').

POST /v2/product/info/stocks-by-warehouse/fbs {sku:[...]} → {products:[{sku, warehouse_id,
warehouse_name, present, reserved, product_id}], has_next, cursor}. v1 отключён Ozon
(«obsolete method cannot be used», код 9 — проверено живой пробой задачи 7 плана
«Склады 2.0» 06.09.2026, тот же код, что при отключении /v1/warehouse/list); путь и
пагинацию v1→v2 внутри пачки — см. OzonClient.stocks_by_warehouse_fbs. sku = ozon_products.fbo_sku
(с 2024 у Ozon единый sku для FBO/FBS). Пачки по 100 (OzonClient). Тик stocks (08:00).
SAAS_PROBE=1 — дамп без записи; SAAS_PROBE=verify — сверка с сегодняшним снимком, exit 1 при Δ.
Мягкая деградация как у ozon_stocks.
"""
import os
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe
from ozon_client import OzonClient, OzonError


def rows_from_result(result, sku2pid, today):
    """Строки снимка: только sku из каталога и с warehouse_id."""
    out = []
    for r in result or []:
        sku, wid = r.get("sku"), r.get("warehouse_id")
        if sku is None or wid is None:
            continue
        pid = sku2pid.get(int(sku))
        if pid is None:
            continue
        out.append({"platform": "ozon", "warehouse_id": int(wid), "sku_key": pid, "date": today,
                    "present": int(r.get("present") or 0), "reserved": int(r.get("reserved") or 0)})
    return out


def collect():
    today = date.today().isoformat()
    print(f"[ozon_fbs_stocks] FBS-остатки складов продавца на {today} ({datetime.now():%H:%M})", flush=True)
    db_pg.init()
    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        sku2pid[int(r["fbo_sku"])] = int(r["product_id"])
    if not sku2pid:
        print("[ozon_fbs_stocks] ПРОПУСК: нет sku в каталоге (сначала ozon_catalog)", flush=True)
        return 0
    cli = OzonClient()
    try:
        result = cli.stocks_by_warehouse_fbs(sorted(sku2pid))
    except OzonError as e:
        print(f"[ozon_fbs_stocks] ПРОПУСК: Ozon API недоступен ({e}), снимок не записан (exit 0)", flush=True)
        return 0
    if _probe.mode() == "1":
        _probe.dump("POST /v2/product/info/stocks-by-warehouse/fbs", result, n=5)
        return 0
    rows = rows_from_result(result, sku2pid, today)
    if _probe.mode() == "verify":
        db_rows = db_pg.mp_fbs_stock_today("ozon", today)
        api = {(r["warehouse_id"], r["sku_key"]): r["present"] for r in rows}
        diff = [(k, api.get(k), db_rows.get(k)) for k in set(api) | set(db_rows) if api.get(k) != db_rows.get(k)]
        print(f"[ozon_fbs_stocks] verify: api={len(api)} db={len(db_rows)} Δ={len(diff)} {diff[:10]}", flush=True)
        sys.exit(1 if diff else 0)
    n = db_pg.upsert_mp_fbs_stock_many(rows)
    print(f"[ozon_fbs_stocks] строк {n} (ответ API {len(result)})", flush=True)
    print(f"##OBS rows={n}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
