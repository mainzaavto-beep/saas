"""
SaaS-сборщик ФИНАНСОВОГО ОТЧЁТА Ozon → tenant.ozon_finance_report.

/v3/finance/transaction/list за период. Поля на верхнем уровне операции
(выручка/комиссия на верхнем, не в items[]). sku→product_id через PG.
Токен из env. Без Google Sheets.
"""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient


def _to_float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _services_sum(services):
    """Сумма по services[] (логистика/обработка — на верхнем уровне операции /v3).
    Каждая услуга: {name, price}. price отрицательный (расход). Возвращаем сумму."""
    if not services:
        return None
    total = 0.0
    found = False
    for svc in services:
        p = svc.get("price")
        if p is not None:
            total += float(p)
            found = True
    return total if found else None


def _op_row(op, posting_id, item):
    item = item or {}
    type_enum = op.get("operation_type") or ""
    type_name = op.get("operation_type_name") or type_enum
    commission = op.get("sale_commission")
    if commission is not None:
        commission = abs(float(commission))
    return {
        "posting_id": posting_id,
        "operation_id": op.get("operation_id"),
        "operation_type_name": type_name,
        "operation_type_id": None,
        "operation_dt": op.get("operation_date") or op.get("operation_dt") or op.get("date"),
        "product_id": None,  # collect() маппит sku→product_id
        "item_spp": item.get("spp"),
        "item_category_name": item.get("category_name"),
        "item_offer_id": item.get("offer_id"),
        "item_name": item.get("name"),
        "item_qty": item.get("quantity"),
        "item_price": _to_float(item.get("price")),
        # sale_amount — валовая сумма продажи ДО вычетов. op["amount"] — это уже
        # чистая сумма (начисление минус комиссия минус услуги), а не валовая
        # выручка: подтверждено тождеством на боевых данных (кабинет 1, июль,
        # «Доставка покупателю»: 545 525,00 − 253 492,82 − 34 723,87 = 257 308,31 —
        # ровно то, что раньше попадало в sale_amount). Валовая сумма приходит
        # отдельным полем accruals_for_sale — берём её напрямую, без доп. запросов.
        "sale_amount": _to_float(op.get("accruals_for_sale")),
        "accruals_for_sale": _to_float(op.get("accruals_for_sale")),
        "commission_amount": commission,
        # payout_amount — ЧИСТАЯ сумма по операции (amount = начисление минус
        # комиссия минус услуги), а НЕ фактическая выплата продавцу. Настоящая
        # выплата считается по отчёту о взаиморасчётах, где нетируются все типы
        # операций за период — это поле лишь приближение на уровне одной операции.
        "payout_amount": _to_float(op.get("amount")),
        "services_amount": _services_sum(op.get("services") or []),
    }


def collect(since=None, to=None):
    print("[ozon_finance] операции /v3/finance/transaction/list", flush=True)
    db_pg.init()
    cli = OzonClient()
    if since is None:
        since = datetime.now() - timedelta(days=14)
    if to is None:
        to = datetime.now()
    if isinstance(since, str):
        since = datetime.fromisoformat(since)
    if isinstance(to, str):
        to = datetime.fromisoformat(to)
    print(f"  период: {since.date()}..{to.date()}", flush=True)

    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        if r["fbo_sku"] is not None:
            sku2pid[int(r["fbo_sku"])] = int(r["product_id"])

    rows = []
    n_orphans = 0
    # Ozon лимит: 1 месяц на запрос к /v3/finance/transaction/list (400 "too long period").
    # Разбиваем полный диапазон на 25-дневные окна (запас под любой месяц).
    chunk_start = since
    while chunk_start <= to:
        chunk_end = min(chunk_start + timedelta(days=25), to)
        print(f"  окно {chunk_start.date()}..{chunk_end.date()}", flush=True)
        for op in cli.iter_finance(chunk_start, chunk_end):
            posting_id = op.get("posting", {}).get("posting_number") or op.get("posting_number") or ""
            items = op.get("items") or []
            if items:
                for it in items:
                    sku = it.get("sku")
                    if sku and int(sku) in sku2pid:
                        row = _op_row(op, posting_id, it)
                        row["product_id"] = sku2pid[int(sku)]
                        rows.append(row)
                    elif sku:
                        n_orphans += 1
            else:
                rows.append(_op_row(op, posting_id, None))
        chunk_start = chunk_end + timedelta(days=1)

    written = db_pg.upsert_ozon_finance_many(rows)
    print(f"[ozon_finance] операций {len(rows)}, записано {written}"
          + (f", пропущено {n_orphans}" if n_orphans else ""), flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
