"""
SaaS-сборщик FBS-ЗАДАНИЙ WB → tenant.wb_fbs_tasks.

marketplace-api /api/v3/orders (лента сборочных заданий, курсор next):
rid (== srid статистики, проба 05.09.2026: 201/223) + supplyId. Нужен секции
«FBS-отгрузки» для метрики «время до покупателя» (закрытие поставки → выкуп).
Окно скользящее 30 дней (dateFrom unix), аргументы дат оркестратора
игнорируются. Upsert идемпотентен; supplyId дозаполняется при попадании
задания в поставку.
"""
import os
import sys
import time
from datetime import datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
ORDERS_URL = "https://marketplace-api.wildberries.ru/api/v3/orders"
PAGE_LIMIT = 1000
WINDOW_DAYS = int(os.getenv("SAAS_FBS_TASKS_WINDOW_DAYS", "30"))  # 90 для разового бэкфилла хвоста ленты
MAX_ATTEMPTS = 4


def _get(url):
    """GET с ретраями на 429/5xx; None при недоступности (не роняем прогон)."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(url, headers={"Authorization": WB_TOKEN}, timeout=60)
        except requests.RequestException as e:
            print(f"  сеть ({attempt}/{MAX_ATTEMPTS}): {e}", flush=True)
            time.sleep(2 * attempt)
            continue
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "10") or 10)
            print(f"  429, ждём {wait}с ({attempt}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(min(wait, 60))
            continue
        if resp.status_code >= 500:
            print(f"  {resp.status_code} ({attempt}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(2 * attempt)
            continue
        print(f"  ОШИБКА {resp.status_code}: {resp.text[:200]}", flush=True)
        return None
    return None


def collect():
    print(f"[wb_fbs_tasks] FBS-задания ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_fbs_tasks] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    db_pg.init()
    date_from = int(time.time()) - WINDOW_DAYS * 86400
    rows, nxt, pages = [], 0, 0
    while True:
        data = _get(f"{ORDERS_URL}?limit={PAGE_LIMIT}&next={nxt}&dateFrom={date_from}")
        if data is None:
            if not rows:
                print("[wb_fbs_tasks] ПРОПУСК: API недоступен (exit 0)", flush=True)
                return 0
            break
        page = data.get("orders") or []
        rows.extend(r for r in page if r.get("rid"))
        pages += 1
        nxt = data.get("next")
        if len(page) < PAGE_LIMIT or not nxt:
            break
        time.sleep(0.5)
    written = db_pg.upsert_wb_fbs_tasks_many(rows)
    print(f"[wb_fbs_tasks] страниц {pages}, заданий {len(rows)}, записано {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
