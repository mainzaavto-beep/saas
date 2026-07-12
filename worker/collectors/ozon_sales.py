"""
SaaS-сборщик ПРОДАЖ/ВОЗВРАТОВ Ozon → tenant.ozon_sales.

/v3/posting/fbo/list со статусом: delivered = продажа, cancelled = возврат.
sku→product_id через PG. Токен из env. Без Google Sheets.
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


def _rows_for_status(cli, since, to, status, is_return, sku2pid):
    rows = []
    for p in cli.iter_postings(since, to, status=status):
        posting_number = p.get("posting_number")
        sale_dt = p.get("in_process_at") or p.get("last_change_date") or p.get("created_at")
        last_change_dt = p.get("last_change_date")
        for prod in (p.get("products") or []):
            price_raw = prod.get("price")
            if isinstance(price_raw, dict):
                price = float(price_raw.get("amount", 0) or 0)
            elif isinstance(price_raw, (int, float)):
                price = float(price_raw)
            else:
                price = 0.0
            qty = int(prod.get("quantity", 1) or 1)
            revenue = price * qty
            if is_return:
                revenue = -abs(revenue)
            sku = prod.get("sku")
            pid = sku2pid.get(int(sku)) if (sku2pid and sku) else (prod.get("product_id") or prod.get("sku"))
            rows.append({
                "posting_number": posting_number,
                "product_id": pid,
                "offer_id": prod.get("offer_id"),
                "sale_dt": sale_dt,
                "last_change_dt": last_change_dt,
                "status": status,
                "is_return": 1 if is_return else 0,
                "qty": qty,
                "price": price,
                "revenue": revenue,
                "payout_amount": None,
            })
    return rows


def collect(since=None, to=None):
    print("[ozon_sales] delivered + cancelled", flush=True)
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

    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        if r["fbo_sku"] is not None:
            sku2pid[int(r["fbo_sku"])] = int(r["product_id"])

    delivered = _rows_for_status(cli, since, to, "delivered", False, sku2pid)
    cancelled = _rows_for_status(cli, since, to, "cancelled", True, sku2pid)
    all_rows = [r for r in (delivered + cancelled) if r["product_id"] is not None]
    n_orphans = len(delivered) + len(cancelled) - len(all_rows)
    written = db_pg.upsert_ozon_sales_many(all_rows)
    print(f"[ozon_sales] delivered {len(delivered)}, cancelled {len(cancelled)}, записано {written}"
          + (f", пропущено {n_orphans}" if n_orphans else ""), flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
