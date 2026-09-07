"""
SaaS-сборщик АВТО-СПИСАНИЯ FBS Ozon → tenant.stock_moves / stock_move_gaps (спека §3.4).

Источники (всё из БД, API не трогает): tenant.ozon_orders scheme='fbs' (статусы постингов),
tenant.ozon_sales is_return=1 по posting_number/product_id, existing_return_refs (дедуп
возврата — статусный и продажный путь не зачисляют одну единицу дважды). План —
worker/fbs_writeoff_core.plan_ozon, запись — worker/stock_ledger.apply_moves (идемпотентно
по stock_moves_src_uq). Тик main (после ozon_orders/ozon_sales). SAAS_PROBE=1 — печатает
план и не пишет. Идемпотентен: повторный прогон → 0 applied, N duplicate.

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
# (по образцу wb_fbs_writeoff.py / ozon_supply_orders.py::_BUNDLE_FAILED).
_FAILED = 0


def partial_exit_code(n_failed):
    """Контракт exit-кодов (orchestrator.py, по образцу wb_fbs_writeoff.py /
    ozon_supply_orders.py::partial_exit_code): >0 движений упало с ошибкой (не insufficient/
    missing — это ожидаемые gap-исходы, а именно failed) → 3 (partial — успевшие движения
    всё равно записаны, падение по сигналу, не по данным). Иначе None."""
    return 3 if n_failed else None


def collect():
    global _FAILED
    print(f"[ozon_fbs_writeoff] авто-списание FBS Ozon ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    postings = db_pg.ozon_fbs_postings_for_writeoff()
    moves, gaps = core.plan_ozon(
        postings, loc_by_wh=db_pg.locations_by_warehouse(), items=db_pg.fbs_items_by_location(),
        existing_out=db_pg.existing_out_moves("ozon_posting"), returns=db_pg.ozon_fbs_returns(),
        existing_returns=db_pg.existing_return_refs(["ozon_posting", "ozon_return"]))
    if _probe.is_probe():
        _probe.dump("план движений", moves, n=10)
        _probe.dump("пробелы", gaps, n=10)
        return 0
    res = stock_ledger.apply_moves(moves)
    _FAILED = len(res["failed"])

    def _posting_for(base):
        posting_number, product_id = base.split(":")
        return next((x for x in postings if x["posting_number"] == posting_number and str(x["product_id"]) == product_id), None)

    for ref in res["insufficient"]:
        base = ref.split("#", 1)[0]
        p = _posting_for(base)
        gaps.append({"src_kind": "ozon_posting", "src_ref": base, "platform": "ozon",
                     "warehouse_id": p and p.get("warehouse_id"), "sku_key": p and p.get("product_id"),
                     "qty": (p and int(p.get("qty") or 0)) or 1, "reason": "insufficient"})
    for ref in res["missing"]:
        base = ref.split("#", 1)[0]
        p = _posting_for(base)
        gaps.append({"src_kind": "ozon_posting", "src_ref": base, "platform": "ozon",
                     "warehouse_id": p and p.get("warehouse_id"), "sku_key": p and p.get("product_id"),
                     "qty": (p and int(p.get("qty") or 0)) or 1, "reason": "no_item"})
    stock_ledger.record_gaps(gaps)
    bad_refs = {r.split("#", 1)[0] for r in res["insufficient"]} | {r.split("#", 1)[0] for r in res["missing"]} \
        | {r.split("#", 1)[0] for r, _ in res["failed"]}
    done_refs = {m["src_ref"].split("#", 1)[0] for m in moves if m["src_kind"] == "ozon_posting" and m["src_ref"].split("#", 1)[0] not in bad_refs}
    resolved = stock_ledger.resolve_gaps("ozon_posting", done_refs)
    by = Counter(g["reason"] for g in gaps)
    err_note = f", ошибок {len(res['failed'])}: {res['failed'][0][1]}" if res["failed"] else f", ошибок {len(res['failed'])}"
    print(f"[ozon_fbs_writeoff] постинги {len(postings)}: списано {res['applied']}, дублей {res['duplicate']}, "
          f"не хватило {len(res['insufficient'])}, пропало {len(res['missing'])}{err_note}, "
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
