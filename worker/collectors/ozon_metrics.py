"""
SaaS-сборщик МЕТРИК Ozon → tenant.ozon_daily_metrics.

clicks из analytics (hits_view), orders из tenant.ozon_orders (created, is_cancel=0).
Семантика #61: orders = СПРОС (created), не delivered. Без Google Sheets.
"""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient


def collect(since=None, to=None):
    print("[ozon_metrics] clicks(analytics) + orders(orders)", flush=True)
    db_pg.init()
    cli = OzonClient()
    if since is None:
        since = datetime.now() - timedelta(days=7)
    if to is None:
        to = datetime.now()
    if isinstance(since, str):
        since = datetime.fromisoformat(since)
    if isinstance(to, str):
        to = datetime.fromisoformat(to)
    date_from = since.strftime("%Y-%m-%d")
    date_to = to.strftime("%Y-%m-%d")

    # Очистка orders/revenue за период (как боевой, но через PG).
    with db_pg.get_connection() as conn:
        conn.execute(
            "UPDATE tenant.ozon_daily_metrics SET orders = NULL, revenue = NULL "
            "WHERE date >= %s AND date <= %s", (date_from, date_to))

    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        if r["fbo_sku"] is not None:
            sku2pid[int(r["fbo_sku"])] = int(r["product_id"])

    orders_map = {}
    for r in db_pg.query(
        "SELECT product_id, substr(order_dt,1,10) AS d, COUNT(*) AS cnt "
        "FROM tenant.ozon_orders WHERE is_cancel = 0 AND product_id IS NOT NULL "
        "AND substr(order_dt,1,10) >= %s AND substr(order_dt,1,10) <= %s "
        "GROUP BY product_id, substr(order_dt,1,10)", (date_from, date_to)):
        orders_map[(int(r["product_id"]), r["d"])] = int(r["cnt"])

    dimensions = ["day", "sku"]
    metrics = ["hits_view", "delivered_units", "revenue", "returns"]
    n = 0
    n_orphans = 0
    for row in cli.iter_analytics(since, to, dimensions, metrics):
        dims = row.get("dimensions") or []
        d = dims[0].get("id") if len(dims) > 0 else None
        sku_str = dims[1].get("id") if len(dims) > 1 else None
        if not (d and sku_str):
            continue
        try:
            sku = int(sku_str)
        except (ValueError, TypeError):
            continue
        pid = sku2pid.get(sku)
        if pid is None:
            n_orphans += 1
            continue
        clicks = (row.get("metrics") or [None])[0]
        orders = orders_map.get((pid, d))
        db_pg.upsert_ozon_daily(pid, d, clicks=clicks, orders=orders)
        n += 1
    print(f"[ozon_metrics] записано {n} метрик"
          + (f", пропущено {n_orphans}" if n_orphans else ""), flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
