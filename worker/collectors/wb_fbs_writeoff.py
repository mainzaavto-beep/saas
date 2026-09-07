"""
SaaS-сборщик АВТО-СПИСАНИЯ FBS WB → tenant.stock_moves / stock_move_gaps (спека §3.4).

Источники (всё из БД, API не трогает): tenant.wb_fbs_tasks (статусы часового опроса),
wb_supplies.closed_at, wb_sales 'R…' по srid. План — worker/fbs_writeoff_core.plan_wb,
запись — worker/stock_ledger.apply_moves (идемпотентно по stock_moves_src_uq).
Тик fbsstatus (часовой, после wb_fbs_status) и main. SAAS_PROBE=1 — печатает план
и не пишет. Идемпотентен: повторный прогон → 0 applied, N duplicate.
"""
import os
import sys
from collections import Counter
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe
import fbs_writeoff_core as core
import stock_ledger


def collect():
    print(f"[wb_fbs_writeoff] авто-списание FBS WB ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    tasks = db_pg.wb_fbs_tasks_for_writeoff()
    moves, gaps = core.plan_wb(
        tasks, supplies_closed=db_pg.wb_supplies_closed(), loc_by_wh=db_pg.locations_by_warehouse(),
        items=db_pg.fbs_items_by_location(), existing_out=db_pg.existing_out_moves("wb_fbs_task"),
        returns=db_pg.wb_fbs_returns())
    if _probe.is_probe():
        _probe.dump("план движений", moves, n=10)
        _probe.dump("пробелы", gaps, n=10)
        return 0
    res = stock_ledger.apply_moves(moves)
    for ref in res["insufficient"]:
        base = ref.split("#", 1)[0]
        t = next((x for x in tasks if x["rid"] == base), None)
        gaps.append({"src_kind": "wb_fbs_task", "src_ref": base, "platform": "wb",
                     "warehouse_id": t and t.get("warehouse_id"), "sku_key": t and t.get("nm_id"), "qty": 1, "reason": "insufficient"})
    stock_ledger.record_gaps(gaps)
    done_refs = {m["src_ref"].split("#", 1)[0] for m in moves if m["src_kind"] == "wb_fbs_task" and m["src_ref"].split("#", 1)[0] not in {r.split("#", 1)[0] for r in res["insufficient"]}}
    resolved = stock_ledger.resolve_gaps("wb_fbs_task", done_refs)
    by = Counter(g["reason"] for g in gaps)
    print(f"[wb_fbs_writeoff] задания {len(tasks)}: списано {res['applied']}, дублей {res['duplicate']}, "
          f"не хватило {len(res['insufficient'])}, пробелов {len(gaps)} (no_location {by['no_location']}, "
          f"no_item {by['no_item']}, insufficient {by['insufficient']}), закрыто пробелов {resolved}", flush=True)
    print(f"##OBS rows={res['applied']}", flush=True)
    return res["applied"]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
