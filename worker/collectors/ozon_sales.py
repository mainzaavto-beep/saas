"""
SaaS-сборщик ПРОДАЖ/ВОЗВРАТОВ Ozon → tenant.ozon_sales.

Обе схемы: fbo/list + fbs/list, колонка scheme. Статус: delivered = продажа,
cancelled = возврат. product_id — через тот же _resolve_pid, что в
ozon_orders (sku→product_id, fallback по offer_id — нужен для FBS, где sku
может отсутствовать в fbo_sku). Токен из env. Без Google Sheets.
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


def _resolve_pid(prod, sku2pid, offer2pid):
    """product_id по sku (fbo_sku), иначе по offer_id (нужно для FBS)."""
    sku = prod.get("sku")
    if sku:
        pid = sku2pid.get(int(sku))
        if pid:
            return pid
    return offer2pid.get(prod.get("offer_id"))


def _rows_for_status(cli, since, to, status, is_return, sku2pid, offer2pid, scheme):
    rows = []
    it = (cli.iter_fbs_postings(since, to, status=status) if scheme == "fbs"
          else cli.iter_postings(since, to, status=status))
    for p in it:
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
            rows.append({
                "posting_number": posting_number,
                "product_id": _resolve_pid(prod, sku2pid, offer2pid),
                "offer_id": prod.get("offer_id"),
                "sale_dt": sale_dt,
                "last_change_dt": last_change_dt,
                "status": status,
                "is_return": 1 if is_return else 0,
                "qty": qty,
                "price": price,
                "revenue": revenue,
                "payout_amount": None,
                "scheme": scheme,
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

    # Fallback-карта offer_id → product_id (та же, что в ozon_orders): FBS-
    # постингам sku из fbo_sku может не хватать.
    offer2pid = {}
    for r in db_pg.query("SELECT offer_id, product_id FROM tenant.ozon_products WHERE offer_id IS NOT NULL"):
        offer2pid[r["offer_id"]] = int(r["product_id"])

    delivered = _rows_for_status(cli, since, to, "delivered", False, sku2pid, offer2pid, "fbo") \
              + _rows_for_status(cli, since, to, "delivered", False, sku2pid, offer2pid, "fbs")
    cancelled = _rows_for_status(cli, since, to, "cancelled", True, sku2pid, offer2pid, "fbo") \
              + _rows_for_status(cli, since, to, "cancelled", True, sku2pid, offer2pid, "fbs")
    all_rows = [r for r in (delivered + cancelled) if r["product_id"] is not None]
    n_orphans = len(delivered) + len(cancelled) - len(all_rows)
    written = db_pg.upsert_ozon_sales_many(all_rows)
    print(f"[ozon_sales] delivered {len(delivered)}, cancelled {len(cancelled)}, записано {written}"
          + (f", пропущено {n_orphans}" if n_orphans else ""), flush=True)
    print(f"##OBS rows={written} from={since.strftime('%Y-%m-%d')} to={to.strftime('%Y-%m-%d')}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
