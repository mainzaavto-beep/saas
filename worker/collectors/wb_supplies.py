"""
SaaS-сборщик ПОСТАВОК WB FBS → tenant.wb_supplies.

marketplace-api /api/v3/supplies, курсорная пагинация (limit/next).
Даты жизненного цикла: createdAt (создана) → closedAt (закрыта, передана
в доставку) → scanDt (отсканирована на СЦ). Лаг closedAt→scanDt — «время
отгрузки на СЦ» для вкладки «География» (спека 2026-08-28-geography-v2).

Список отдаётся целиком с начала работы кабинета (сотни строк) — тянем все
страницы каждый прогон, upsert идемпотентен. Аргументы дат от оркестратора
игнорируются (как wb_references).
"""
import os
import sys
import time
from datetime import datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
SUPPLIES_URL = "https://marketplace-api.wildberries.ru/api/v3/supplies"
PAGE_LIMIT = 1000
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
    print(f"[wb_supplies] поставки FBS ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    rows, nxt, pages = [], 0, 0
    while True:
        data = _get(f"{SUPPLIES_URL}?limit={PAGE_LIMIT}&next={nxt}")
        if data is None:
            if not rows:
                print("[wb_supplies] ПРОПУСК: API недоступен (exit 0)", flush=True)
                return 0
            break  # часть страниц уже есть — пишем что собрали
        page = data.get("supplies") or []
        rows.extend(page)
        pages += 1
        nxt = data.get("next")
        if len(page) < PAGE_LIMIT or not nxt:
            break
        time.sleep(0.5)
    written = db_pg.upsert_wb_supplies_many(rows)
    print(f"[wb_supplies] страниц {pages}, поставок {len(rows)}, записано {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
