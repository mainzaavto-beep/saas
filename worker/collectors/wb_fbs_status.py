"""
SaaS-сборщик СТАТУСОВ FBS-ЗАДАНИЙ WB → tenant.wb_fbs_tasks.wb_status / pvz_at.

marketplace-api POST /api/v3/orders/status (до 1000 id за запрос) отдаёт
только ТЕКУЩИЙ wbStatus без времени смены (проба 06.09.2026: поля id,
supplierStatus, wbStatus, isCancellable). Момент «доехало до ПВЗ» ловим
сами: часовой таймер saas-fbs-status опрашивает незавершённые задания
(db_pg.wb_fbs_open_order_ids) и db_pg.apply_wb_fbs_statuses ставит pvz_at
при переходе waiting|sorted → ready_for_pickup. Точность = шаг опроса (1 ч).
order_id задания приходит из ленты /api/v3/orders (wb_fbs_tasks, main-тик).
Аргументы дат оркестратора игнорируются. Нужен колонке «До ПВЗ, дн» секции
«FBS-отгрузки» (lib/geoMetrics.js wbSuppliesOps, §16.8 контракта).
"""
import os
import sys
import time
from datetime import datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
STATUS_URL = "https://marketplace-api.wildberries.ru/api/v3/orders/status"
BATCH = 1000
MAX_ATTEMPTS = 4


def _post_status(ids):
    """POST с ретраями на 429/5xx; None при недоступности (не роняем прогон)."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.post(STATUS_URL, headers={"Authorization": WB_TOKEN},
                                 json={"orders": ids}, timeout=60)
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
    print(f"[wb_fbs_status] статусы FBS-заданий ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_fbs_status] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    db_pg.init()
    ids = db_pg.wb_fbs_open_order_ids()
    if not ids:
        print("[wb_fbs_status] открытых заданий нет", flush=True)
        print("##OBS rows=0", flush=True)
        return 0
    pairs = []
    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        data = _post_status(chunk)
        if data is None:
            if not pairs:
                print("[wb_fbs_status] ПРОПУСК: API недоступен (exit 0)", flush=True)
                return 0
            break
        for o in data.get("orders") or []:
            if o.get("id") is not None and o.get("wbStatus"):
                pairs.append((int(o["id"]), str(o["wbStatus"])))
        if i + BATCH < len(ids):
            time.sleep(0.5)
    arrived = db_pg.apply_wb_fbs_statuses(pairs)
    from collections import Counter
    dist = ", ".join(f"{k}={v}" for k, v in sorted(Counter(st for _, st in pairs).items()))
    print(f"[wb_fbs_status] опрошено {len(ids)}, статусов {len(pairs)} [{dist}], доехало до ПВЗ: {arrived}", flush=True)
    print(f"##OBS rows={len(pairs)}", flush=True)
    return len(pairs)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
