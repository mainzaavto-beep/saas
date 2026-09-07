#!/usr/bin/env python3
"""Планировщик авто-списания FBS (worker/fbs_writeoff_core.py). Без сети и БД."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker"))
import fbs_writeoff_core as c

# resolve_item: FIFO по completed_at (NULL последними), затем id
rows = [{"id": 3, "qty": 2, "completed_at": None}, {"id": 1, "qty": 1, "completed_at": "2026-07-15"},
        {"id": 2, "qty": 5, "completed_at": "2026-08-01"}]
assert c.resolve_item(rows, 3) == ([(1, 1), (2, 2)], 0)
# ПРАВКА ФИКСТУРЫ (отчёт задачи 4): resolve_item мутирует rows[i]["qty"] — это спека
# («Остаток расходуется в пределах прогона», нужно _writeoff/plan_wb для r1/r5 ниже).
# Повторный вызов на ТОМ ЖЕ объекте после первого списания видел бы id1.qty=0, id2.qty=3
# (расход первого вызова), а не исходные 1/5 — тогда ожидание ([(1,1),(2,5),(3,2)],1)
# было бы недостижимо в принципе. Пересобираем rows со свежими значениями перед вторым вызовом.
rows = [{"id": 3, "qty": 2, "completed_at": None}, {"id": 1, "qty": 1, "completed_at": "2026-07-15"},
        {"id": 2, "qty": 5, "completed_at": "2026-08-01"}]
assert c.resolve_item(rows, 9) == ([(1, 1), (2, 5), (3, 2)], 1)
assert c.resolve_item([], 1) == ([], 1)

loc = {("wb", 500): 7, ("ozon", 9): 8}
items = {(7, "wb", 111): [{"id": 10, "qty": 1, "completed_at": "2026-07-15"}],
         (8, "ozon", 4988): [{"id": 20, "qty": 3, "completed_at": None}]}

# WB: уехало (поставка закрыта) → out_fbs; статус waiting без закрытой поставки → ничего;
# нет места → gap no_location; нет позиции → no_item; не хватило → insufficient.
tasks = [
    {"rid": "r1", "nm_id": 111, "warehouse_id": 500, "wb_status": "waiting", "supply_id": "S1", "wb_status_at": None, "created_at": "2026-09-01T10:00:00+03:00"},
    {"rid": "r2", "nm_id": 111, "warehouse_id": 500, "wb_status": "waiting", "supply_id": "S2", "wb_status_at": None, "created_at": "2026-09-01T11:00:00+03:00"},
    {"rid": "r3", "nm_id": 111, "warehouse_id": 999, "wb_status": "sold", "supply_id": None, "wb_status_at": "2026-09-02T10:00:00+03:00", "created_at": "2026-09-01T12:00:00+03:00"},
    {"rid": "r4", "nm_id": 222, "warehouse_id": 500, "wb_status": "sorted", "supply_id": None, "wb_status_at": "2026-09-02T10:00:00+03:00", "created_at": "2026-09-01T13:00:00+03:00"},
    {"rid": "r5", "nm_id": 111, "warehouse_id": 500, "wb_status": "sold", "supply_id": None, "wb_status_at": "2026-09-02T10:00:00+03:00", "created_at": "2026-09-01T14:00:00+03:00"},
]
moves, gaps = c.plan_wb(tasks, supplies_closed={"S1"}, loc_by_wh=loc, items=items, existing_out={}, returns=[])
assert [(m["src_ref"], m["kind"], m["qty"], m["ff_inventory_id"]) for m in moves] == [("r1", "out_fbs", -1, 10)], moves
assert sorted((g["src_ref"], g["reason"]) for g in gaps) == [("r3", "no_location"), ("r4", "no_item"), ("r5", "insufficient")], gaps
assert moves[0]["src_kind"] == "wb_fbs_task" and moves[0]["moved_at"] == "2026-09-01T10:00:00+03:00"

# WB: остаток внутри одного прогона расходуется (r1 и r5 на одну штуку — вторая insufficient) — проверено выше.
# WB: отмена после списания → return_in на ту же позицию; отмена без списания → ничего;
# возвратная продажа (R…) по rid со списанием → return_in src_kind wb_fbs_return.
tasks2 = [
    {"rid": "r1", "nm_id": 111, "warehouse_id": 500, "wb_status": "canceled_by_client", "supply_id": "S1", "wb_status_at": "2026-09-03T10:00:00+03:00", "created_at": "2026-09-01T10:00:00+03:00"},
    {"rid": "r6", "nm_id": 111, "warehouse_id": 500, "wb_status": "canceled", "supply_id": None, "wb_status_at": "2026-09-03T10:00:00+03:00", "created_at": "2026-09-01T10:00:00+03:00"},
]
moves, gaps = c.plan_wb(tasks2, supplies_closed={"S1"}, loc_by_wh=loc, items=items, existing_out={"r1": 10},
                        returns=[{"sale_id": "R77", "srid": "r1", "sale_dt": "2026-09-05"}])
kinds = sorted((m["src_kind"], m["src_ref"], m["kind"], m["qty"], m["ff_inventory_id"]) for m in moves)
assert kinds == [("wb_fbs_return", "R77", "return_in", 1, 10), ("wb_fbs_task", "r1", "return_in", 1, 10)], kinds
assert gaps == []

# Ozon: delivered → out_fbs на qty; cancelled без списания → ничего; cancelled со списанием → return_in;
# возврат покупателем → return_in ozon_return.
postings = [
    {"posting_number": "P1", "product_id": 4988, "qty": 2, "warehouse_id": 9, "status": "delivered", "last_change_dt": "2026-09-02T10:00:00Z", "in_process_at": "2026-09-01T10:00:00Z"},
    {"posting_number": "P2", "product_id": 4988, "qty": 1, "warehouse_id": 9, "status": "cancelled", "last_change_dt": "2026-09-02T10:00:00Z", "in_process_at": None},
    {"posting_number": "P3", "product_id": 4988, "qty": 1, "warehouse_id": 9, "status": "cancelled", "last_change_dt": "2026-09-03T10:00:00Z", "in_process_at": None},
    {"posting_number": "P4", "product_id": 4988, "qty": 1, "warehouse_id": 9, "status": "awaiting_packaging", "last_change_dt": None, "in_process_at": "2026-09-05T10:00:00Z"},
]
moves, gaps = c.plan_ozon(postings, loc_by_wh=loc, items=items, existing_out={"P3:4988": 20},
                          returns=[{"posting_number": "P1", "product_id": 4988, "qty": 2}])
got = sorted((m["src_kind"], m["src_ref"], m["kind"], m["qty"], m["ff_inventory_id"]) for m in moves)
assert got == [("ozon_posting", "P1:4988", "out_fbs", -2, 20), ("ozon_posting", "P3:4988", "return_in", 1, 20),
               ("ozon_return", "P1:4988", "return_in", 2, 20)], got
assert gaps == []
print("OK: 9 проверок")
