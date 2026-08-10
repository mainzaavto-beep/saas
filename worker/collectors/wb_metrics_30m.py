"""
SaaS-сборщик 30-минутных метрик воронки WB → tenant.wb_metrics_30m.

Перенос collector_wb/wb_metrics_30m.py под PostgreSQL через db_pg.
Принцип: WB sales-funnel отдаёт метрики НАРАСТАЮЩИМ ИТОГОМ с начала дня.
Снимаем кумулятивный снапшот раз в 30 минут, пишем как есть.
Дельту (прирост за 30 мин) считает API на чтение.

Поля: clicks (openCount), cart (cartCount), orders (orderCount),
order_sum (orderSum), favorites (addToWishlist), buyouts (buyoutCount),
cancels (cancelCount). Только по активным товарам каталога.

Токен из env WB_TOKEN. Идемпотентно по (cabinet_id, nm_id, ts).
Запуск: python -m worker.collectors.wb_metrics_30m
"""
import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

try:
    import requests
except ImportError:
    requests = None

WB_TOKEN = os.getenv("WB_TOKEN")
FUNNEL_URL = "https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products"


def _wb_post(url, body, retries=3):
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    if requests is None:
        raise RuntimeError("модуль requests не установлен")
    headers = {"Authorization": WB_TOKEN, "Content-Type": "application/json"}
    for attempt in range(retries):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=30)
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 60))
                print(f"  429, жду {wait}с...", flush=True)
                time.sleep(wait)
                continue
            return r
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(5)
    return None


def round_ts_to_30m(dt):
    """Округляет время вниз до 30-минутного слота: 11:45 → 11:30."""
    minute = 0 if dt.minute < 30 else 30
    slot = dt.replace(minute=minute, second=0, microsecond=0)
    return slot.strftime("%Y-%m-%d %H:%M:%S")


def fetch_funnel_live(day_str, active_nm_ids):
    """Снимает кумулятивные метрики за day_str по активным товарам.
    Возвращает {nm_id: {clicks, cart, orders, order_sum, favorites, buyouts, cancels}}."""
    r = _wb_post(FUNNEL_URL, {"selectedPeriod": {"start": day_str, "end": day_str}})
    if r is None or r.status_code != 200:
        print(f"  sales-funnel [{getattr(r,'status_code','?')}]: {(r.text[:200] if r else 'no resp')}", flush=True)
        return {}
    result = {}
    for item in r.json().get("data", {}).get("products", []):
        nm = item["product"]["nmId"]
        if nm not in active_nm_ids:
            continue
        s = item["statistic"]["selected"]
        result[nm] = {
            "clicks": int(s.get("openCount", 0) or 0),
            "cart": int(s.get("cartCount", 0) or 0),
            "orders": int(s.get("orderCount", 0) or 0),
            "order_sum": round(float(s.get("orderSum", 0) or 0), 2),
            "favorites": int(s.get("addToWishlist", 0) or 0),
            "buyouts": int(s.get("buyoutCount", 0) or 0),
            "cancels": int(s.get("cancelCount", 0) or 0),
        }
    return result


def collect():
    """Главный цикл: каталог → снимок → upsert → cleanup."""
    now = datetime.now()
    day_str = now.strftime("%Y-%m-%d")
    ts = round_ts_to_30m(now)
    print(f"[wb_metrics_30m] снимок | слот {ts}", flush=True)

    db_pg.init()
    active_nm_ids = set(db_pg.active_nm_ids())
    if not active_nm_ids:
        print("[wb_metrics_30m] каталог пуст — нечего собирать", flush=True)
        return 0
    print(f"[wb_metrics_30m] активных товаров: {len(active_nm_ids)}", flush=True)

    funnel = fetch_funnel_live(day_str, active_nm_ids)
    if not funnel:
        print("[wb_metrics_30m] снимок пуст (нет данных или ошибка API)", flush=True)
        return 0

    written = 0
    for nm, m in funnel.items():
        db_pg.upsert_metric_30m(
            nm, day_str, ts,
            clicks=m["clicks"], cart=m["cart"], orders=m["orders"],
            order_sum=m["order_sum"], favorites=m["favorites"],
            buyouts=m["buyouts"], cancels=m["cancels"],
        )
        written += 1

    # Cleanup старых снапшотов (хранение 60 дней). Вспомогательная операция —
    # её сбой не должен ронять прогон сбора метрик, но и молчать о сбое
    # нельзя: раньше пустой except маскировал NameError (сломанный импорт
    # timedelta в db_pg.py) и retention 60 дней ни разу не отрабатывал,
    # при этом лог показывал «удалено старых: 0», как будто всё в порядке.
    try:
        removed = db_pg.cleanup_metrics_30m(days=60)
    except Exception as e:
        print(f"[wb_metrics_30m] cleanup старых снапшотов НЕ выполнен: {type(e).__name__}: {e}", flush=True)
        removed = None

    print(f"[wb_metrics_30m] записано {written} снапшотов на слот {ts}, удалено старых: {removed}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
