"""
SaaS-сборщик РЕКЛАМЫ WB → tenant.wb_daily_ad + tenant.wb_daily_metrics.ad_*.

Тот же канон что боевой collector_wb/backfill_ads.py + wb_ads.py, адаптированный
под PostgreSQL через db_pg (без SQLite, без Google Sheets).

3 шага:
  1. fetch_campaign_models() — /api/advert/v2/adverts: {advertId: model}
     (cliki=cpc, ruchnaya=manual, иначе edinaya)
  2. /adv/v1/promotion/count — список всех advertId кабинета
  3. /adv/v3/fullstats — статистика батчами ≤50 кампаний за диапазон
     (диапазон бьётся на окна ≤31 дня). Поля: views/clicks/atbs/orders/sum(spend)

Пишет:
  - tenant.wb_daily_ad (PK cabinet_id,nm_id,date,model) — per-модель
  - tenant.wb_daily_metrics.ad_* — суммарно по моделям (для overview/Сводки)

Идемпотентно. Токен из env WB_TOKEN (воркер выставляет).
Запуск: python -m worker.collectors.wb_ads [YYYY-MM-DD] [YYYY-MM-DD]
  (по умолчанию — вчера; backfill: две даты).
"""
import os
import sys
import time
import math
from collections import defaultdict
from datetime import datetime, timedelta, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

try:
    import requests
except ImportError:
    requests = None

WB_TOKEN = os.getenv("WB_TOKEN")

ADVERTS_URL = "https://advert-api.wildberries.ru/api/advert/v2/adverts"
COUNT_URL = "https://advert-api.wildberries.ru/adv/v1/promotion/count"
FULLSTATS_URL = "https://advert-api.wildberries.ru/adv/v3/fullstats"

MODELS = ("edinaya", "ruchnaya", "cliki")


def _wb_get(url, params=None):
    """GET с retry (429 → Retry-After). Тот же паттерн что в wb_metrics._wb_post."""
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    if requests is None:
        raise RuntimeError("модуль requests не установлен")
    headers = {"Authorization": WB_TOKEN}
    for attempt in range(4):
        try:
            r = requests.get(url, headers=headers, params=params, timeout=30)
        except requests.RequestException as e:
            if attempt == 3:
                raise
            print(f"  сетевой сбой ({e.__class__.__name__}), повтор...", flush=True)
            time.sleep(5)
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 60))
            print(f"  429, жду {wait}с...", flush=True)
            time.sleep(wait)
            continue
        return r
    return None


def classify(bid_type, payment_type):
    """(bid_type, payment_type) → модель блока (как боевой wb_ads.classify)."""
    if payment_type == "cpc":
        return "cliki"
    if bid_type == "manual":
        return "ruchnaya"
    return "edinaya"


def fetch_campaign_models():
    """{advertId: model} по всем кампаниям кабинета."""
    r = _wb_get(ADVERTS_URL)
    if r is None or r.status_code != 200:
        print(f"  adverts [{getattr(r,'status_code','?')}]: {(r.text[:150] if r else 'no resp')}", flush=True)
        return {}
    out = {}
    for a in r.json().get("adverts", []):
        model = classify(a.get("bid_type"), a.get("settings", {}).get("payment_type"))
        out[a["id"]] = model
    return out


def _date_windows(begin, end, max_days=31):
    """Разбивает [begin, end] на окна ≤ max_days — fullstats не принимает >31 дня."""
    b = datetime.strptime(begin, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date()
    out, cur = [], b
    while cur <= e:
        win_end = min(cur + timedelta(days=max_days - 1), e)
        out.append((cur.isoformat(), win_end.isoformat()))
        cur = win_end + timedelta(days=1)
    return out


def _empty_metric():
    return {"views": 0, "clicks": 0, "atbs": 0, "orders": 0, "spend": 0.0}


def fetch_ads_range(begin, end, campaign_models, known):
    """{date: {nm: {model: {views,clicks,atbs,orders,spend}}}} за [begin, end].
    Диапазон бьётся на окна ≤31 дня, каждое окно — по батчам ≤50 кампаний."""
    r = _wb_get(COUNT_URL)
    if r is None or r.status_code != 200:
        raise RuntimeError(f"ads count [{getattr(r,'status_code','?')}]: {(r.text[:200] if r else 'no resp')}")
    all_ids = [
        item["advertId"]
        for group in r.json().get("adverts", [])
        for item in group.get("advert_list", [])
    ]
    windows = _date_windows(begin, end)
    print(f"  кампаний: {len(all_ids)} | окон ≤31д: {len(windows)}", flush=True)

    agg = defaultdict(lambda: defaultdict(lambda: {m: _empty_metric() for m in MODELS}))
    batch_size = 50
    num_batches = math.ceil(len(all_ids) / batch_size) if all_ids else 0
    for win_begin, win_end in windows:
        for i in range(num_batches):
            batch = all_ids[i * batch_size:(i + 1) * batch_size]
            r = _wb_get(FULLSTATS_URL, params={
                "ids": ",".join(str(x) for x in batch),
                "beginDate": win_begin, "endDate": win_end,
            })
            if r is None or r.status_code != 200:
                print(f"    fullstats [{getattr(r,'status_code','?')}]: {(r.text[:100] if r else 'no resp')}", flush=True)
                time.sleep(2)
                continue
            data = r.json()
            if not data:
                time.sleep(0.5)
                continue
            for camp in data:
                model = campaign_models.get(camp.get("advertId"), "edinaya")
                for day in camp.get("days", []):
                    d = day.get("date", "")[:10]
                    if not (begin <= d <= end):
                        continue
                    for app in day.get("apps", []):
                        for ns in app.get("nms", []):
                            nm = ns.get("nmId")
                            if nm not in known:
                                continue
                            b = agg[d][nm][model]
                            b["views"] += ns.get("views", 0)
                            b["clicks"] += ns.get("clicks", 0)
                            b["atbs"] += ns.get("atbs", 0)
                            b["orders"] += ns.get("orders", 0)
                            b["spend"] += ns.get("sum", 0.0)
            time.sleep(0.3)
    return agg


def collect(start=None, end=None):
    """Собрать рекламу. start/end — YYYY-MM-DD. По умолчанию — вчера."""
    yest = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = start or yest
    end = end or yest
    if end < start:
        start, end = end, start
    print(f"[wb_ads] реклама {start}…{end}", flush=True)
    db_pg.init()
    known = set(db_pg.active_nm_ids())
    if not known:
        print("[wb_ads] каталог пуст — нечего фильтровать", flush=True)
        return 0

    print("  классификация кампаний...", flush=True)
    campaign_models = fetch_campaign_models()
    agg = fetch_ads_range(start, end, campaign_models, known)

    days_written, ad_rows, total_spend = 0, 0, 0.0
    for d, by_nm in sorted(agg.items()):
        any_day = False
        for nm, models in by_nm.items():
            kept = {m: b for m, b in models.items() if any(b.values())}
            if not kept:
                continue
            any_day = True
            ad_total = _empty_metric()
            for model, b in kept.items():
                for k in ad_total:
                    ad_total[k] += b[k]
                db_pg.upsert_ad(nm, d, model,
                                views=b["views"], clicks=b["clicks"],
                                atbs=b["atbs"], orders=b["orders"],
                                spend=round(b["spend"], 2))
                ad_rows += 1
            total_spend += ad_total["spend"]
            db_pg.upsert_daily(nm, d,
                               ad_views=ad_total["views"], ad_clicks=ad_total["clicks"],
                               ad_atbs=ad_total["atbs"], ad_orders=ad_total["orders"],
                               ad_spend=round(ad_total["spend"], 2))
        if any_day:
            days_written += 1

    print(f"[wb_ads] дней с рекламой: {days_written}, строк daily_ad: {ad_rows}, расход: {round(total_spend)}₽", flush=True)
    print(f"##OBS rows={ad_rows} from={start} to={end}", flush=True)
    return ad_rows


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
