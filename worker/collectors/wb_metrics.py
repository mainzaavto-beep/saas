"""
SaaS-сборщик МЕТРИК воронки WB → tenant.wb_daily_metrics.

sales-funnel API: clicks (openCount), cart (cartCount), rating. За вчера.
orders считаем из tenant.wb_orders (count по дате) — как боевой.
Реклама (daily_ad) — отдельный сборщик (позже); здесь только базовая воронка.

БЕЗ Google Sheets — принцип SaaS. Только PostgreSQL.
Токен из env WB_TOKEN. Идемпотентно по (cabinet_id, nm_id, date).
"""
import os
import sys
import time
import requests
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
FUNNEL_URL = "https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products"


def _wb_post(url, body):
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    headers = {"Authorization": WB_TOKEN, "Content-Type": "application/json"}
    for attempt in range(3):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=30)
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 60))
                print(f"  429, жду {wait}с...", flush=True)
                time.sleep(wait)
                continue
            return r
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(5)
    return None


def _fetch_funnel(date_str):
    """{nm_id: {clicks, cart, rating}} за указанную дату."""
    r = _wb_post(FUNNEL_URL, {"selectedPeriod": {"start": date_str, "end": date_str}})
    if r is None or r.status_code != 200:
        print(f"  funnel [{getattr(r,'status_code','?')}]: {(r.text[:150] if r else 'no resp')}", flush=True)
        return {}
    result = {}
    for item in r.json().get("data", {}).get("products", []):
        nm = item["product"]["nmId"]
        stat = item["statistic"]["selected"]
        result[nm] = {
            "clicks": stat.get("openCount", 0),
            "cart": stat.get("cartCount", 0),
            "rating": item["product"].get("feedbackRating", 0),
        }
    return result


def collect(target_date=None):
    """Собрать метрики за target_date (по умолчанию вчера)."""
    ds = target_date or (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    print(f"[wb_metrics] воронка за {ds}", flush=True)
    db_pg.init()
    known = set(db_pg.active_nm_ids())
    funnel = _fetch_funnel(ds)

    # orders по nm_id из tenant.wb_orders (count заказов в этот день).
    order_counts = {}
    rows = db_pg.query(
        "SELECT nm_id, count(*) AS c FROM tenant.wb_orders "
        "WHERE nm_id IS NOT NULL AND substr(order_dt,1,10) = %s GROUP BY nm_id",
        (ds,))
    for r in rows:
        order_counts[r["nm_id"]] = r["c"]

    # Объединяем: все nm из known + funnel (воронка может覆盖 не всё).
    all_nm = known | set(funnel.keys()) | set(order_counts.keys())
    written = 0
    for nm in all_nm:
        f = funnel.get(nm, {})
        if not f and nm not in order_counts:
            continue
        db_pg.upsert_daily(
            nm, ds,
            clicks=f.get("clicks"),
            cart=f.get("cart"),
            rating=f.get("rating"),
            orders=order_counts.get(nm),
        )
        written += 1
    print(f"[wb_metrics] записано {written} метрик → tenant.wb_daily_metrics", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    args = sys.argv[1:]
    collect(args[0] if args else None)
