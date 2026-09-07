"""
SaaS-сборщик АВТО-СПИСАНИЯ FBS WB → tenant.stock_moves / stock_move_gaps (спека §3.4).

Источники (всё из БД, API не трогает): tenant.wb_fbs_tasks (статусы часового опроса),
wb_supplies.closed_at, wb_sales 'R…' по srid, existing_return_refs (дедуп возврата —
статусный и продажный путь не зачисляют одну единицу дважды). План —
worker/fbs_writeoff_core.plan_wb, запись — worker/stock_ledger.apply_moves (идемпотентно
по stock_moves_src_uq). Тик fbsstatus (часовой, после wb_fbs_status) и main. SAAS_PROBE=1 —
печатает план и не пишет. Идемпотентен: повторный прогон → 0 applied, N duplicate.

Кабинет без мест с привязкой к складам продавца (ФФ-контур не используется) —
ПРОПУСК до планирования: 0 движений, 0 новых пробелов, открытые пробелы закрываются.

apply_moves() возвращает 5 корзин: applied/duplicate — ок; insufficient — не хватило
остатка (gap); missing — позиция не найдена/архивна на момент UPDATE (gap, reason
no_item — с точки зрения списания это то же самое «списывать некуда»); failed — любая
другая ошибка на движении (не gap, только счётчик и exit-код, см. partial_exit_code).
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

# Счётчик ошибочных движений (failed) последнего collect() — читает __main__ после вызова
# (по образцу ozon_supply_orders.py::_BUNDLE_FAILED).
_FAILED = 0


def partial_exit_code(n_failed):
    """Контракт exit-кодов (orchestrator.py, по образцу
    ozon_supply_orders.py::partial_exit_code): >0 движений упало с ошибкой (не insufficient/
    missing — это ожидаемые gap-исходы, а именно failed) → 3 (partial — успевшие движения
    всё равно записаны, падение по сигналу, не по данным). Иначе None."""
    return 3 if n_failed else None


def collect():
    global _FAILED
    print(f"[wb_fbs_writeoff] авто-списание FBS WB ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    loc_by_wh = db_pg.locations_by_warehouse()
    if not loc_by_wh:
        # Кабинет не использует ФФ-контур: нет ни одного активного места с привязкой к
        # складу продавца — разносить некуда, планировать и копить пробелы бессмысленно
        # (иначе КАЖДОЕ отгруженное задание падало бы в gap no_location). Уже открытые
        # пробелы закрываем — они откроются заново сами, как только места будут привязаны.
        closed = stock_ledger.close_gaps_all("wb")
        print("[wb_fbs_writeoff] ПРОПУСК: нет мест с привязкой к складам продавца — разносить некуда (exit 0)", flush=True)
        print(f"[wb_fbs_writeoff] закрыто пробелов {closed} — ФФ-контур не используется", flush=True)
        print("##OBS rows=0", flush=True)
        return 0
    tasks = db_pg.wb_fbs_tasks_for_writeoff()
    moves, gaps = core.plan_wb(
        tasks, supplies_closed=db_pg.wb_supplies_closed(), loc_by_wh=loc_by_wh,
        items=db_pg.fbs_items_by_location(), existing_out=db_pg.existing_out_moves("wb_fbs_task"),
        returns=db_pg.wb_fbs_returns(),
        existing_returns=db_pg.existing_return_refs(["wb_fbs_task", "wb_fbs_return"]))
    if _probe.is_probe():
        _probe.dump("план движений", moves, n=10)
        _probe.dump("пробелы", gaps, n=10)
        return 0
    res = stock_ledger.apply_moves(moves)
    _FAILED = len(res["failed"])
    for ref in res["insufficient"]:
        base = ref.split("#", 1)[0]
        t = next((x for x in tasks if x["rid"] == base), None)
        gaps.append({"src_kind": "wb_fbs_task", "src_ref": base, "platform": "wb",
                     "warehouse_id": t and t.get("warehouse_id"), "sku_key": t and t.get("nm_id"), "qty": 1, "reason": "insufficient"})
    for ref in res["missing"]:
        base = ref.split("#", 1)[0]
        t = next((x for x in tasks if x["rid"] == base), None)
        gaps.append({"src_kind": "wb_fbs_task", "src_ref": base, "platform": "wb",
                     "warehouse_id": t and t.get("warehouse_id"), "sku_key": t and t.get("nm_id"), "qty": 1, "reason": "no_item"})
    stock_ledger.record_gaps(gaps)
    bad_refs = {r.split("#", 1)[0] for r in res["insufficient"]} | {r.split("#", 1)[0] for r in res["missing"]} \
        | {r.split("#", 1)[0] for r, _ in res["failed"]}
    done_refs = {m["src_ref"].split("#", 1)[0] for m in moves if m["src_kind"] == "wb_fbs_task" and m["src_ref"].split("#", 1)[0] not in bad_refs}
    resolved = stock_ledger.resolve_gaps("wb_fbs_task", done_refs)
    by = Counter(g["reason"] for g in gaps)
    print(f"[wb_fbs_writeoff] задания {len(tasks)}: списано {res['applied']}, дублей {res['duplicate']}, "
          f"не хватило {len(res['insufficient'])}, пропало {len(res['missing'])}, ошибок {len(res['failed'])}, "
          f"пробелов {len(gaps)} (no_location {by['no_location']}, no_item {by['no_item']}, "
          f"insufficient {by['insufficient']}), закрыто пробелов {resolved}", flush=True)
    print(f"##OBS rows={res['applied']}", flush=True)
    return res["applied"]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
    _code = partial_exit_code(_FAILED)
    if _code is not None:
        sys.exit(_code)
