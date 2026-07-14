"""
SaaS-сборщик ПРИБЫЛИ ПО ЗАКАЗУ Ozon → tenant.ozon_order_costs.

Агрегирует tenant.ozon_finance_report по posting_id (как боевой, по #61).
Без HTTP — чистый SQL/Python. operation_type_name определяет роль операции.
profit = cost_value_retail − cost − commission − acquiring − logistics − loyalty.
Для возврата cost_value_retail = 0. self_buyout всегда 0 (грабля #138).
Токен НЕ нужен. Идемпотентно по (cabinet_id, posting_number).
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg

OP_SALE = "Доставка покупателю"
OP_RETURN = "Получение возврата, отмены, невыкупа от покупателя"
OP_RETURN_LOGISTICS = "Доставка и обработка возврата, отмены, невыкупа"
OP_ACQUIRING = "Оплата эквайринга"
OP_DELIVERY_INCOME = "Перечисление за доставку от покупателя"
LOGISTICS_OPS = {OP_RETURN_LOGISTICS, OP_DELIVERY_INCOME}


def _num(v):
    return 0.0 if v is None else float(v)


def _abs(v):
    return 0.0 if v is None else abs(float(v))


def collect(date_from=None, date_to=None):
    print(f"[ozon_order_costs] агрегация {date_from or 'начало'}..{date_to or 'конец'}", flush=True)
    db_pg.init()

    where = ""
    params = []
    if date_from:
        where += " AND operation_dt >= %s"; params.append(date_from)
    if date_to:
        where += " AND operation_dt <= %s"; params.append(date_to)

    rows = db_pg.query(
        "SELECT posting_id, operation_type_name, operation_dt, product_id, "
        "item_qty, accruals_for_sale, commission_amount, services_amount, payout_amount "
        "FROM tenant.ozon_finance_report WHERE posting_id != ''" + where, params)
    # cost_overrides — единый источник себестоимости (с 2026-07-14).
    # Актуальный override = последний с effective_from <= сегодня.
    cogs_map = {r["product_id"]: float(r["cost"]) for r in db_pg.query(
        "SELECT DISTINCT ON (product_id) product_id, cost FROM tenant.cost_overrides "
        "WHERE platform='ozon' AND effective_from <= current_date "
        "ORDER BY product_id, effective_from DESC") if r["cost"] is not None}
    order_meta = {r["posting_number"]: r for r in db_pg.query("SELECT posting_number, order_dt, size, product_id FROM tenant.ozon_orders")}

    g = defaultdict(lambda: {
        "product_id": None, "is_return": 0, "order_dt": None, "sale_dt": None,
        "return_dt": None, "cost_value_retail": 0.0,
        "commission": 0.0, "acquiring": 0.0, "logistics": 0.0, "loyalty": 0.0, "qty": None,
    })
    for r in rows:
        pid = r["posting_id"]
        if not pid:
            continue
        op = r["operation_type_name"] or ""
        gr = g[pid]
        if gr["product_id"] is None and r["product_id"]:
            gr["product_id"] = r["product_id"]
        if op == OP_SALE:
            gr["sale_dt"] = r["operation_dt"]
            gr["cost_value_retail"] += _num(r["accruals_for_sale"])
            gr["commission"] += _num(r["commission_amount"])
            gr["logistics"] += _abs(r["services_amount"])
            if gr["qty"] is None and r["item_qty"]:
                gr["qty"] = r["item_qty"]
        elif op == OP_RETURN:
            gr["is_return"] = 1
            gr["return_dt"] = r["operation_dt"]
        elif op in LOGISTICS_OPS:
            gr["logistics"] += _abs(r["services_amount"]) + _abs(r["payout_amount"])
            if op == OP_RETURN_LOGISTICS:
                gr["is_return"] = 1
                if not gr["return_dt"]:
                    gr["return_dt"] = r["operation_dt"]
        elif op == OP_ACQUIRING:
            gr["acquiring"] += _abs(r["payout_amount"])

    out = []
    for pid, gr in g.items():
        if not (gr["sale_dt"] or gr["return_dt"] or gr["cost_value_retail"]):
            continue
        meta = order_meta.get(pid, {})
        product_id = gr["product_id"] or meta.get("product_id")
        if not product_id:
            continue
        cost = cogs_map.get(product_id)
        cost_value_retail = 0.0 if gr["is_return"] else gr["cost_value_retail"]
        comps = (cost or 0) + gr["commission"] + gr["acquiring"] + gr["logistics"] + gr["loyalty"]
        out.append({
            "posting_number": pid, "product_id": product_id, "size": meta.get("size"),
            "is_return": gr["is_return"], "order_dt": gr["order_dt"] or meta.get("order_dt"),
            "sale_dt": gr["sale_dt"], "return_dt": gr["return_dt"],
            "cost_value_retail": round(cost_value_retail, 2),
            "commission": round(gr["commission"], 2), "acquiring": round(gr["acquiring"], 2),
            "logistics": round(gr["logistics"], 2), "loyalty": round(gr["loyalty"], 2),
            "cost": round(cost, 2) if cost is not None else None,
            "qty": gr["qty"] or 1, "profit": round(cost_value_retail - comps, 2),
            "self_buyout": 0,
        })
    n = db_pg.upsert_ozon_order_costs_many(out)
    print(f"[ozon_order_costs] записано {n} строк (из {len(rows)} операций)", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
