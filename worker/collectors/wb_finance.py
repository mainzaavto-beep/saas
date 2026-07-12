"""
SaaS-сборщик ФИНАНСОВОГО ОТЧЁТА WB (reportDetailByPeriod) → tenant.wb_finance_report.

Дневная гранулярность (period=daily, заявка №28): отчёт доступен на следующий день
без недельного лага. Требует ПЕРСОНАЛЬНЫЙ токен клиента (базовый → 204).

Диапазон: по умолчанию 7 дней до вчера; argv[0]=start, argv[1]=end (бэкфилл).
Токен из env WB_TOKEN. Идемпотентно по (cabinet_id, rrd_id).
"""
import os
import sys
import time
import requests
from datetime import datetime, timedelta, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
REPORT_URL = "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod"
PAGE_LIMIT = 100000


def fetch_realization(date_from, date_to, daily=True):
    """Выгрузка строк отчёта за период. cursor-пагинация по rrdid. period=daily."""
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    headers = {"Authorization": WB_TOKEN}
    all_rows = []
    rrdid = 0
    page = 0
    while True:
        page += 1
        params = {"dateFrom": date_from, "dateTo": date_to, "rrdid": rrdid, "limit": PAGE_LIMIT}
        if daily:
            params["period"] = "daily"
        for attempt in range(5):
            try:
                r = requests.get(REPORT_URL, headers=headers, params=params, timeout=90)
            except requests.RequestException as e:
                if attempt == 4:
                    raise
                print(f"    сетевой сбой ({e.__class__.__name__}), повтор...", flush=True)
                time.sleep(10)
                continue
            if r.status_code == 429:
                # WB rate-limit: Retry-After часто НЕ передаёт (None). Прогрессивный
                # backoff 30→60→90→120→150с — ждать всё дольше, не зацикливаться на 60.
                wait = int(r.headers.get("Retry-After") or (30 * (attempt + 1)))
                print(f"    429 (попытка {attempt+1}/5), жду {wait}с...", flush=True)
                time.sleep(wait)
                continue
            # 204/пусто = отчёт ещё не сформирован (напр. за сегодня). Не падаем.
            if r.status_code == 204 or not r.text or not r.text.strip():
                return []
            r.raise_for_status()
            break
        else:
            # Все 5 попыток исчерпаны на 429 — пропускаем окно (не валит весь backfill).
            print(f"    429 после 5 попыток — пропускаю окно", flush=True)
            return []
        rows = r.json()
        if not rows:
            break
        all_rows.extend(rows)
        print(f"  страница {page}: +{len(rows)} (всего {len(all_rows)})", flush=True)
        rrdid = rows[-1]["rrd_id"]
        if len(rows) < PAGE_LIMIT:
            break
        time.sleep(1)
    return all_rows


def fetch_by_days(date_from, date_to):
    """Тянет дневные отчёты, но НЕ по одному дню, а 7-дневными окнами (компромисс
    скорости и надёжности). reportDetailByPeriod отдаёт период任意 длины с period=daily,
    поэтому 7-дневное окно = ОДИН запрос с дневными строками внутри (realizationreport_id
    на каждый день). Это в ~7 раз быстрее по-дневного цикла и меньше подвержено 429.
    Последнее окно может быть короче 7 дней."""
    start = datetime.strptime(date_from, "%Y-%m-%d").date()
    end = datetime.strptime(date_to, "%Y-%m-%d").date()
    all_rows = []
    cur = start
    window = 7
    while cur <= end:
        win_end = min(cur + timedelta(days=window - 1), end)
        rows = fetch_realization(cur.isoformat(), win_end.isoformat(), daily=True)
        if rows:
            print(f"  окно {cur}..{win_end}: {len(rows)} строк (всего {len(all_rows)})", flush=True)
        else:
            print(f"  окно {cur}..{win_end}: 0 (отчёт ещё не сформирован)", flush=True)
        all_rows.extend(rows)
        cur = win_end + timedelta(days=1)
        # Пауза между окнами: WB rate-limit ~1 запрос/мин на аккаунт (429 без Retry-After
        # после большого ответа). 35с держит нас под лимитом, ~10 окон = ~6 мин на full backfill.
        if cur <= end:
            time.sleep(35)
    return all_rows


def collect(start=None, end=None):
    """Собрать финансовый отчёт. По умолчанию 7 дней до вчера."""
    yest = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = start or (date.today() - timedelta(days=7)).strftime("%Y-%m-%d")
    end = end or yest
    print(f"[wb_finance] дневные отчёты {start}…{end}", flush=True)
    db_pg.init()
    rows = fetch_by_days(start, end)
    n = db_pg.upsert_finance_many(rows)
    print(f"[wb_finance] записано {n} строк → tenant.wb_finance_report", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
