"""
SaaS-сборщик СПРАВОЧНИКА КЛАСТЕРОВ Ozon → shared.ozon_clusters.

/v1/cluster/list (CLUSTER_TYPE_OZON): кластер → logistic_clusters → склады
(warehouse_id, name, type). Нужен вкладке «География» для локальности Ozon
(склад отгрузки → кластер). Почти статичен — тик references (weekly),
как wb_references. Аргументы дат игнорируются. Глобальный справочник:
пишется без cabinet_id, кредами любого Ozon-кабинета.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient


def collect():
    print(f"[ozon_references] кластеры Ozon ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    cli = OzonClient()
    clusters = cli.cluster_list()
    rows = []
    for c in clusters:
        for lc in c.get("logistic_clusters") or []:
            for w in lc.get("warehouses") or []:
                if w.get("warehouse_id") is None:
                    continue
                rows.append({
                    "warehouse_id": w["warehouse_id"],
                    "warehouse_name": w.get("name") or "",
                    "warehouse_type": w.get("type"),
                    "cluster_id": c.get("id"),
                    "cluster_name": c.get("name") or "",
                })
    if not rows:
        print("[ozon_references] ПРОПУСК: API вернул пусто (exit 0)", flush=True)
        return 0
    written = db_pg.upsert_shared_ozon_clusters(rows)
    print(f"[ozon_references] кластеров {len(clusters)}, складов {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
