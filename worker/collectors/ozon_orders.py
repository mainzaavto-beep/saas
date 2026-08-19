"""
SaaS-сборщик ЗАКАЗОВ Ozon (FBO) → tenant.ozon_orders.

/v3/posting/fbo/list за период. Один posting → несколько строк (по product_id).
sku (fbo_sku) маппится в product_id через tenant.ozon_products.
Токен из env (воркер). Без Google Sheets.

⚠️ ОКНО СБОРА — размораживание статусов (задача «Размораживание статусов
ozon_orders», .superpowers/sdd/2026-08-18-orders-vitrina/): /v3/posting/fbo/list
фильтрует по дате СОЗДАНИЯ отправления (`since`/`to`), а плановый прогон
(run_saas_collect.sh, MAIN_COLLECTORS) вызывает сборщик узким окном −2..сегодня
(DAYS_FROM=2, DAYS_TO=0) — отправление старше 2 дней больше никогда не
переспрашивается, и его `status` замерзает навсегда, даже когда продажа давно
завершена (497 строк на живой БД застряли в in-transit, `updated_at` не
двигался месяц — подтверждено ре-ревью чтением кода и данных).

Починка — тот же lookback-пол, что у ozon_accruals.py/ozon_order_costs.py
(resolve_window, MIN_LOOKBACK_DAYS=45 дней, импортирован отсюда, не
продублирован), но с ПРОТИВОПОЛОЖНЫМ концом окна: у начислений конец —
не позже вчера (Ozon дополняет сегодняшний день постепенно), а у заказов
статус СЕГОДНЯШНЕГО отправления нужен сразу — поэтому resolve_window
вызывается с cap_to_yesterday=False. Верхняя граница периода при этом не
округляется до полуночи текущих суток (иначе сегодняшние отправления снова
выпадали бы из окна) — берётся текущий момент `datetime.now(timezone.utc)`.
Каждый плановый прогон переспрашивает и идемпотентно освежает status/
cancel_dt/updated_at всех отправлений, созданных за последние 45 дней.
"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient
from ozon_accruals import resolve_window


def collect(since=None, to=None):
    print("[ozon_orders] постинги FBO", flush=True)
    db_pg.init()
    cli = OzonClient()

    d_from, d_to = resolve_window(since, to, cap_to_yesterday=False)
    now_utc = datetime.now(timezone.utc)
    since_dt = datetime.combine(d_from, datetime.min.time(), tzinfo=timezone.utc)
    if d_to >= now_utc.date():
        # Конец окна — сегодня: берём текущий момент, а не полночь суток
        # (иначе сегодняшние отправления снова выпадали бы из окна).
        to_dt = now_utc
    else:
        to_dt = datetime.combine(d_to, datetime.max.time(), tzinfo=timezone.utc)
    print(f"  период: {d_from}..{d_to}"
          + (" (конец = сейчас)" if d_to >= now_utc.date() else ""), flush=True)
    since, to = since_dt, to_dt

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
