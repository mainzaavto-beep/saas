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
    # hits_tocart — добавления в корзину. ⚠️ Грабля 2026-08-02: правильное имя
    # БЕЗ подчёркивания (hits_tocart, не hits_to_cart) — из-за опечатки метрику
    # считали «недоступной в API» и cart в ozon_daily_metrics пустовал.
    metrics = ["hits_view", "delivered_units", "revenue", "returns", "hits_tocart"]
    # 1) Сначала СЕТЬ — весь ответ analytics/data в память. Очистка окна в БД идёт
    #    только после успешного похода: раньше orders/revenue за 3 дня обнулялись
    #    ДО запроса, и при 429-исчерпании (ночной тик 01–08.09.2026) скорость Ozon
    #    на /stocks и портрет покупателя до следующего тика считались по NULL.
    #    Селф-тест: ozon_metrics_selftest.py.
    pending = []
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
        mvals = row.get("metrics") or []
        clicks = mvals[0] if len(mvals) > 0 else None
        cart = mvals[4] if len(mvals) > 4 else None
        pending.append((pid, d, clicks, orders_map.get((pid, d)), cart))

    # 2) Одна транзакция: очистка orders/revenue окна + запись новых строк.
    n = 0
    with db_pg.get_connection() as conn:
        conn.execute(
            "UPDATE tenant.ozon_daily_metrics SET orders = NULL, revenue = NULL "
            "WHERE date >= %s AND date <= %s", (date_from, date_to))
        for pid, d, clicks, orders, cart in pending:
            db_pg.upsert_ozon_daily(pid, d, conn=conn, clicks=clicks, orders=orders, cart=cart)
            n += 1
    print(f"[ozon_metrics] записано {n} метрик"
          + (f", пропущено {n_orphans}" if n_orphans else ""), flush=True)
    print(f"##OBS rows={n} from={date_from} to={date_to}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
