"""
SaaS-сборщик СКЛАДОВ ПРОДАВЦА Ozon → tenant.mp_seller_warehouses (platform='ozon').

POST /v2/warehouse/list → [{warehouse_id, name, is_rfbs, status, ...}]. kind:
'rfbs' если is_rfbs, иначе 'fbs'. Тик references (weekly) + онбординг. Аргументы
дат игнорируются. SAAS_PROBE=1 — печатает ответ и не пишет.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe
from ozon_client import OzonClient, OzonError


def parse_warehouses(data) -> list[dict]:
    out = []
    for w in data or []:
        if w.get("warehouse_id") is None:
            continue
        out.append({"warehouse_id": int(w["warehouse_id"]),
                    "name": w.get("name") or str(w["warehouse_id"]),
                    "kind": "rfbs" if w.get("is_rfbs") else "fbs"})
    return out


def collect():
    print(f"[ozon_seller_warehouses] склады продавца Ozon ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    cli = OzonClient()
    try:
        data = cli.warehouse_list()
    except OzonError as e:
        print(f"[ozon_seller_warehouses] ПРОПУСК: Ozon API недоступен ({e}) (exit 0)", flush=True)
        return 0
    if _probe.is_probe():
        _probe.dump("POST /v2/warehouse/list", data, n=10)
        return 0
    db_pg.init()
    rows = parse_warehouses(data)
    if not rows:
        print("[ozon_seller_warehouses] ПРОПУСК: API вернул пусто (exit 0)", flush=True)
        return 0
    written = db_pg.upsert_mp_seller_warehouses("ozon", rows)
    print(f"[ozon_seller_warehouses] складов {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
