"""
SaaS-сборщик 30-МИНУТНЫХ СНИМКОВ Ozon → tenant.ozon_metrics_30m (по товарам) и
tenant.ozon_ads_30m (реклама по кампаниям). Двойник wb_metrics_30m.py.

Принцип: и аналитика продавца (/v1/analytics/data за «сегодня»), и Performance
API (/api/client/statistics/daily за «сегодня») отдают счётчики НАРАСТАЮЩИМ
ИТОГОМ в течение дня (живая проба 2026-09-10: 14:09 → 18:28 показы 39 068 →
44 190, расход 3 886 → 4 455 ₽). Снимаем кумулятив раз в 30 минут, пишем как
есть; дельту (прирост за слот) считает API страницы «Заказы по времени»
(lib/timing30m.js) — та же схема, что у WB.

Товары: показы всего / в поиске / просмотры карточки, корзины, заказано шт и ₽.
Без Premium аналитика отдаёт только заказано шт/₽ — остальное NULL (см.
map_metric_values в ozon_client.py). Реклама: по кампаниям (товарного разреза
Performance API внутри дня не даёт — товарный отчёт строится минутами в очереди);
без perf-кредов рекламная часть мягко пропускается, как в ozon_efficiency.

Часовой пояс: сервер в TZ=Europe/Moscow, «сегодня» и слот — местные, как у WB.
Идемпотентно по (cabinet_id, product_id|campaign_id, ts). Хранение 60 дней.
Селф-тест (без сети/БД): ozon_metrics_30m_selftest.py.
"""
import csv
import io
import os
import sys
import requests
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient, OzonError, map_metric_values

PERF_HOST = "https://api-performance.ozon.ru"
ANALYTICS_METRICS = ["hits_view", "hits_view_search", "hits_view_pdp",
                     "hits_tocart", "ordered_units", "revenue"]
# имя метрики API → колонка tenant.ozon_metrics_30m
_COL = {"hits_view": "views", "hits_view_search": "views_search", "hits_view_pdp": "views_pdp",
        "hits_tocart": "cart", "ordered_units": "orders", "revenue": "order_sum"}
RETENTION_DAYS = 60


def round_ts_to_30m(dt):
    """Округляет время вниз до 30-минутного слота: 11:45 → 11:30."""
    minute = 0 if dt.minute < 30 else 30
    return dt.replace(minute=minute, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M:%S")


def _num(s):
    try:
        return float(str(s or "0").replace("\xa0", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return 0.0


def _add(acc, key, v):
    """Сумма с учётом None: None + None = None, None + 5 = 5."""
    if v is None:
        return
    acc[key] = (acc.get(key) or 0) + v


def parse_analytics(rows, requested, sku2pid):
    """Строки day×sku → {product_id: {views, views_search, views_pdp, cart, orders,
    order_sum}} (sku одного товара суммируются). Возвращает (dict, число sku без
    товара в каталоге). Строки с неразобранными метриками пропускаются."""
    per_pid = {}
    orphans = 0
    for row in rows:
        dims = row.get("dimensions") or []
        sku_str = dims[1].get("id") if len(dims) > 1 else None
        try:
            sku = int(sku_str)
        except (ValueError, TypeError):
            continue
        pid = sku2pid.get(sku)
        if pid is None:
            orphans += 1
            continue
        mapped = map_metric_values(requested, row.get("metrics"))
        if mapped is None:
            continue
        acc = per_pid.setdefault(pid, {c: None for c in _COL.values()})
        for name, col in _COL.items():
            _add(acc, col, mapped.get(name))
    return per_pid, orphans


def parse_perf_daily(csv_text):
    """CSV Performance /statistics/daily (ID;Название;Дата;Показы;Клики;Расход;
    Заказы шт;Заказы ₽) → {campaign_id: {...}}. Строка «Всего» и строки без
    числового ID отбрасываются."""
    out = {}
    reader = csv.reader(io.StringIO(csv_text), delimiter=";")
    next(reader, None)
    for row in reader:
        if len(row) < 8:
            continue
        try:
            cid = int(row[0])
        except (ValueError, TypeError):
            continue
        out[cid] = {
            "campaign_name": row[1] or None,
            "views": int(_num(row[3])),
            "clicks": int(_num(row[4])),
            "spend": round(_num(row[5]), 2),
            "orders": int(_num(row[6])),
            "orders_sum": round(_num(row[7]), 2),
        }
    return out


def is_rate_limited(err):
    """OzonError от исчерпания ретраев на 429 (а не 4xx-ошибка запроса и не 5xx)."""
    return isinstance(err, OzonError) and "429 too many requests" in str(err)


def _perf_token():
    perf_id = os.environ.get("OZON_PERF_CLIENT_ID")
    perf_secret = os.environ.get("OZON_PERF_CLIENT_SECRET")
    if not (perf_id and perf_secret):
        return None
    tr = requests.post(PERF_HOST + "/api/client/token",
                       json={"client_id": perf_id, "client_secret": perf_secret,
                             "grant_type": "client_credentials"}, timeout=30)
    if tr.status_code != 200:
        print(f"  Performance token HTTP {tr.status_code}: {tr.text[:120]}", flush=True)
        return None
    return tr.json().get("access_token")


def _fetch_perf_today(day_str):
    token = _perf_token()
    if not token:
        print("[ozon_metrics_30m] perf-кредов нет — реклама пропущена", flush=True)
        return None
    r = requests.get(PERF_HOST + "/api/client/statistics/daily",
                     headers={"Authorization": f"Bearer {token}"},
                     params={"dateFrom": day_str, "dateTo": day_str}, timeout=60)
    if r.status_code != 200:
        print(f"  Performance /daily HTTP {r.status_code}: {r.text[:120]}", flush=True)
        return None
    return parse_perf_daily(r.text)


def collect():
    now = datetime.now()
    day_str = now.strftime("%Y-%m-%d")
    ts = round_ts_to_30m(now)
    print(f"[ozon_metrics_30m] снимок | слот {ts}", flush=True)
    db_pg.init()

    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        if r["fbo_sku"] is not None:
            sku2pid[int(r["fbo_sku"])] = int(r["product_id"])
    if not sku2pid:
        print("[ozon_metrics_30m] каталог пуст — нечего собирать", flush=True)
        return 0

    cli = OzonClient()
    try:
        rows = list(cli.iter_analytics(day_str, day_str, ["day", "sku"], ANALYTICS_METRICS))
    except OzonError as e:
        if not is_rate_limited(e):
            raise
        # Лимит Ozon не отпустил за все ретраи — слот пропущен, следующий тик снимет
        # тот же нарастающий итог дня. Exit 3 (partial): оркестратор не роняет юнит
        # (SOFT_PARTIAL_COLLECTORS), в журнале остаётся "partial" с причиной.
        print(f"[ozon_metrics_30m] слот {ts} пропущен: {e}", file=sys.stderr, flush=True)
        sys.exit(3)
    per_pid, orphans = parse_analytics(rows, ANALYTICS_METRICS, sku2pid)
    written = db_pg.upsert_ozon_metrics_30m_many([
        {"product_id": pid, "date": day_str, "ts": ts, **vals} for pid, vals in per_pid.items()
    ])

    ads_written = 0
    try:
        camps = _fetch_perf_today(day_str)
    except Exception as e:  # реклама — вспомогательная часть, снимок товаров не роняем
        print(f"  Performance ошибка: {type(e).__name__}: {str(e)[:120]}", flush=True)
        camps = None
    if camps:
        ads_written = db_pg.upsert_ozon_ads_30m_many([
            {"campaign_id": cid, "date": day_str, "ts": ts, **vals} for cid, vals in camps.items()
        ])

    try:
        removed = db_pg.cleanup_ozon_metrics_30m(days=RETENTION_DAYS)
    except Exception as e:
        print(f"[ozon_metrics_30m] cleanup старых снапшотов НЕ выполнен: {type(e).__name__}: {e}", flush=True)
        removed = None

    print(f"[ozon_metrics_30m] записано {written} товаров, {ads_written} кампаний на слот {ts}"
          + (f", sku без товара: {orphans}" if orphans else "")
          + f", удалено старых: {removed}", flush=True)
    print(f"##OBS rows={written + ads_written}", flush=True)
    return written + ads_written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
