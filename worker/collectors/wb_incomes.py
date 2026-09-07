"""
SaaS-сборщик ПРИЁМОК FBO WB → tenant.wb_incomes (план «Склады 2.0», этап 3).

statistics-api GET /api/v1/supplier/incomes?dateFrom=<ISO> — все приёмки с даты
(строка = incomeId × nmId × barcode; quantity — принято; dateClose — дата приёмки;
status — текст WB). Окно: последние INCOMES_DAYS (90) дней от даты прогона —
хватает для связи документов и сторожа; полный бэкфилл — SAAS_INCOMES_DAYS=400.
Аргументы дат оркестратора игнорируются. Мягкая деградация. SAAS_PROBE=1 — дамп.

statistics-api лимит — 1 запрос в минуту на метод; один вызов на прогон.
"""
import os
import sys
import time
from datetime import datetime, timedelta

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe

WB_TOKEN = os.getenv("WB_TOKEN")
INCOMES_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/incomes"
INCOMES_DAYS = int(os.getenv("SAAS_INCOMES_DAYS", "90"))
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


def parse_rows(data) -> list[dict]:
    """[{incomeId, number, date, lastChangeDate, techSize, barcode, quantity,
    totalPrice, dateClose, warehouseName, nmId, status}] → колонки tenant.wb_incomes.
    Строки без nmId пропускаем (пришли неполными от WB)."""
    out = []
    for r in data or []:
        nm = r.get("nmId")
        if nm is None:
            continue
        out.append({
            "income_id": int(r.get("incomeId")),
            "nm_id": int(nm),
            "barcode": str(r.get("barcode")) if r.get("barcode") is not None else "",
            "number": r.get("number"),
            "date": (r.get("date") or "")[:10] or None,
            "date_close": (r.get("dateClose") or "")[:10] or None,
            "last_change": r.get("lastChangeDate"),
            "warehouse_name": r.get("warehouseName"),
            "tech_size": r.get("techSize"),
            "quantity": int(r.get("quantity") or 0),
            "total_price": r.get("totalPrice"),
            "status": r.get("status"),
        })
    return out


def collect(*_args, **_kwargs):
    """Аргументы дат оркестратора игнорируются — окно своё (INCOMES_DAYS)."""
    print(f"[wb_incomes] приёмки FBO WB ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_incomes] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    date_from = (datetime.now() - timedelta(days=INCOMES_DAYS)).strftime("%Y-%m-%d")
    data = _get(f"{INCOMES_URL}?dateFrom={date_from}")
    if data is None:
        print("[wb_incomes] ПРОПУСК: API недоступен (exit 0)", flush=True)
        return 0
    if _probe.is_probe():
        _probe.dump(f"GET /api/v1/supplier/incomes?dateFrom={date_from}", data, n=10)
        return 0
    db_pg.init()
    rows = parse_rows(data)
    if not rows:
        print("[wb_incomes] ПРОПУСК: API вернул пусто (exit 0)", flush=True)
        return 0
    written = db_pg.upsert_wb_incomes_many(rows)
    print(f"[wb_incomes] окно {date_from}…сегодня, приёмок {len(data)}, строк {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
