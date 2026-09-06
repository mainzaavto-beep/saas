"""
SaaS-сборщик СКЛАДОВ ПРОДАВЦА WB → tenant.mp_seller_warehouses (platform='wb').

marketplace-api GET /api/v3/warehouses → [{id, officeId, name, cargoType, deliveryType}]
(10 складов у кабинета #1, проба 27.08.2026). Нужен привязке «склад МП → место
хранения» (спека «Склады 2.0» §1.2) и сборщику wb_fbs_stocks. Почти статичен —
тик references (weekly) + онбординг. Аргументы дат игнорируются.
SAAS_PROBE=1 — печатает ответ и не пишет.
"""
import os
import sys
import time
from datetime import datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe

WB_TOKEN = os.getenv("WB_TOKEN")
WAREHOUSES_URL = "https://marketplace-api.wildberries.ru/api/v3/warehouses"
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
            time.sleep(min(wait, 60))
            continue
        if resp.status_code >= 500:
            time.sleep(2 * attempt)
            continue
        print(f"  ОШИБКА {resp.status_code}: {resp.text[:200]}", flush=True)
        return None
    return None


def parse_warehouses(data) -> list[dict]:
    """[{id, name, deliveryType}] → [{warehouse_id, name, kind}]."""
    out = []
    for w in data or []:
        if w.get("id") is None:
            continue
        out.append({"warehouse_id": int(w["id"]), "name": w.get("name") or str(w["id"]),
                    "kind": str(w.get("deliveryType")) if w.get("deliveryType") is not None else None})
    return out


def collect():
    print(f"[wb_seller_warehouses] склады продавца WB ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_seller_warehouses] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    data = _get(WAREHOUSES_URL)
    if data is None:
        print("[wb_seller_warehouses] ПРОПУСК: API недоступен (exit 0)", flush=True)
        return 0
    if _probe.is_probe():
        _probe.dump("GET /api/v3/warehouses", data, n=10)
        return 0
    db_pg.init()
    rows = parse_warehouses(data)
    written = db_pg.upsert_mp_seller_warehouses("wb", rows)
    print(f"[wb_seller_warehouses] складов {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
