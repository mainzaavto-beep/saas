"""
SaaS-сборщик ЗАКАЗОВ Ozon (FBO) → tenant.ozon_orders.

/v3/posting/fbo/list за период. Один posting → несколько строк (по product_id).
sku (fbo_sku) маппится в product_id через tenant.ozon_products.
Токен из env (воркер). Без Google Sheets.
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
    print("[ozon_orders] постинги FBO", flush=True)
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
    print(f"  период: {since.date()}..{to.date()}", flush=True)

    # Карта fbo_sku → product_id из PG (вместо прямого sqlite3.connect).
    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        if r["fbo_sku"] is not None:
            sku2pid[int(r["fbo_sku"])] = int(r["product_id"])
    print(f"  справочник: {len(sku2pid)} sku→product_id", flush=True)

    rows = []
    n_postings = 0
    for p in cli.iter_postings(since, to):
        n_postings += 1
        posting_number = p.get("posting_number")
        status = p.get("status")
        is_cancel = 1 if status == "cancelled" else 0
        order_dt = p.get("in_process_at") or p.get("created_at")
        last_change_dt = p.get("last_change_date") or p.get("shipment_date")
        analytics = p.get("analytics_data") or {}
        warehouse = analytics.get("warehouse", "")
        region = analytics.get("region") or analytics.get("city", "")
        products = p.get("products") or p.get("product") or []
        for prod in products:
            cancel_dt = last_change_dt if is_cancel else None
            price_raw = prod.get("price")
            if isinstance(price_raw, dict):
                price_val = float(price_raw.get("amount", 0) or 0)
            elif isinstance(price_raw, (int, float)):
                price_val = float(price_raw)
            else:
                price_val = 0.0
            qty = int(prod.get("quantity", 1) or 1)
            rows.append({
                "posting_number": posting_number,
                "product_id": sku2pid.get(int(prod.get("sku"))) if prod.get("sku") else None,
                "offer_id": prod.get("offer_id"),
                "order_dt": order_dt,
                "last_change_dt": last_change_dt,
                "in_process_at": p.get("in_process_at"),
                "status": status,
                "is_cancel": is_cancel,
                "cancel_dt": cancel_dt,
                "qty": qty,
                "price": price_val,
                "total": price_val * qty,
                "warehouse": warehouse,
                "region": region,
            })

    clean = [r for r in rows if r["product_id"] is not None]
    n_orphans = len(rows) - len(clean)
    written = db_pg.upsert_ozon_orders_many(clean)
    print(f"[ozon_orders] отправлений {n_postings}, записано {written}"
          + (f", пропущено(нет в каталоге) {n_orphans}" if n_orphans else ""), flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
