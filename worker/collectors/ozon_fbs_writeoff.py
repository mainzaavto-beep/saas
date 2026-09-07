"""
SaaS-сборщик АВТО-СПИСАНИЯ FBS Ozon → tenant.stock_moves / stock_move_gaps (спека §3.4).

Источники (всё из БД, API не трогает): tenant.ozon_orders scheme='fbs' (статусы постингов),
tenant.ozon_sales is_return=1 по posting_number/product_id, existing_return_qty (дедуп
возврата по количеству — статусный и продажный путь не зачисляют одну единицу дважды,
а частичные возвраты по одному постингу зачисляются оба). План —
worker/fbs_writeoff_core.plan_ozon, запись — worker/stock_ledger.apply_moves (идемпотентно
по stock_moves_src_uq). Тик main (после ozon_orders/ozon_sales). SAAS_PROBE=1 — печатает
план и не пишет. Идемпотентен: повторный прогон → 0 applied, N duplicate.

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
    loc_by_wh = db_pg.locations_by_warehouse()
    if not loc_by_wh:
        # Кабинет не использует ФФ-контур: нет ни одного активного места с привязкой к
        # складу продавца — разносить некуда, планировать и копить пробелы бессмысленно
        # (иначе КАЖДЫЙ отгруженный постинг падал бы в gap no_location). Уже открытые
        # пробелы закрываем — они откроются заново сами, как только места будут привязаны.
        closed = stock_ledger.close_gaps_all("ozon")
        print("[ozon_fbs_writeoff] ПРОПУСК: нет мест с привязкой к складам продавца — разносить некуда (exit 0)", flush=True)
        print(f"[ozon_fbs_writeoff] закрыто пробелов {closed} — ФФ-контур не используется", flush=True)
        print("##OBS rows=0", flush=True)
        return 0
    postings = db_pg.ozon_fbs_postings_for_writeoff()
    moves, gaps, closed_refs = core.plan_ozon(
        postings, loc_by_wh=loc_by_wh, items=db_pg.fbs_items_by_location(),
        existing_out=db_pg.existing_out_moves("ozon_posting"), returns=db_pg.ozon_fbs_returns(),
        existing_returns=db_pg.existing_return_qty(["ozon_posting", "ozon_return"]))
    if _probe.is_probe():
        _probe.dump("план движений", moves, n=10)
        _probe.dump("пробелы", gaps, n=10)
        return 0
    res = stock_ledger.apply_moves(moves)
    _FAILED = len(res["failed"])
    by_ref = {f"{p['posting_number']}:{p['product_id']}": p for p in postings}

    def _gap(ref, src_kind, reason):
        # Пробел заводится под src_kind ТОГО движения, которое не прошло: у возврата это
        # ozon_return, у списания — ozon_posting. Базовый реф у обоих один
        # (posting_number:product_id), склад/артикул/кол-во берутся из постинга.
        base = ref.split("#", 1)[0]
        p = by_ref.get(base)
        gaps.append({"src_kind": src_kind, "src_ref": base, "platform": "ozon",
                     "warehouse_id": p and p.get("warehouse_id"), "sku_key": p and p.get("product_id"),
                     "qty": (p and int(p.get("qty") or 0)) or 1, "reason": reason})

    for ref, src_kind in res["insufficient"]:
        _gap(ref, src_kind, "insufficient")
    for ref, src_kind in res["missing"]:
        _gap(ref, src_kind, "no_item")
    stock_ledger.record_gaps(gaps)
    bad = {(k, r.split("#", 1)[0]) for r, k in res["insufficient"]} \
        | {(k, r.split("#", 1)[0]) for r, k in res["missing"]} \
        | {(k, r.split("#", 1)[0]) for r, k, _ in res["failed"]}
    done = {(m["src_kind"], m["src_ref"].split("#", 1)[0]) for m in moves} - bad
    # closed_refs — постинги, по которым списания уже не будет никогда (отменены до отгрузки):
    # их пробелы закрываем наравне с отработанными, иначе они висят вечно.
    done |= {("ozon_posting", ref) for ref in closed_refs}
    resolved = stock_ledger.resolve_gaps(done)
    by = Counter(g["reason"] for g in gaps)
    err_note = f", ошибок {len(res['failed'])}: {res['failed'][0][2]}" if res["failed"] else f", ошибок {len(res['failed'])}"
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
