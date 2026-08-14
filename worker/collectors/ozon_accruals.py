"""
SaaS-сборщик НАЧИСЛЕНИЙ Ozon (метод начислений) → tenant.ozon_accruals +
shared.ozon_accrual_types.

/v1/finance/accrual/by-day — начисления за сутки. Одна запись (accrual) —
одна логическая операция (продажа отправления / комиссия за товар / расход
уровня кабинета); внутри записи — от одной до нескольких строк (line item),
которые и попадают в tenant.ozon_accruals по одной. /v1/finance/accrual/types
— общий (не per-кабинет) справочник кодов типов начислений.

Контекст, проверенные факты о структуре ответа и разбор расхождения со
старым источником (ozon_finance/ozon_finance_report) — задача 1 плана
«переезд финансов Ozon на методы начислений»
(.superpowers/sdd/2026-08-11-ozon-accrual-migration/), см.
docs/ozon-accrual-reconciliation.md.

Формула категории POSTING (сходится без расхождений на 37 из 37 проверенных
записях, §2/§4 разбора):
    total_amount = Σ posting.products[].delivery.total_accrued (по услугам,
                     каждая — отдельная строка с type_id)
                  + sale_price + sale_commission + coinvestment + bonus
                    (блок commission — одна строка "продажи" без type_id, ПРИ
                     УСЛОВИИ что блок присутствует: часть POSTING-записей —
                     чистая логистика возврата без продажи, там commission
                     пуст и строки продажи нет).
seller_price ≡ sale_amount, sale_commission ≡ commission — дублирующие поля
одного значения, в строку берём по одному разу (seller_price/sale_commission).

Категория NON_ITEM в части ответов несёт непустой unit_number, но это НЕ
номер отправления (значения не в формате posting_number, а иной ID —
промо-акции/отзыва/т.п., см. задачу 1) — в строку эта запись НЕ переносится
намеренно, unit_number для NON_ITEM в БД всегда NULL.

Незнакомый type_id (нет в справочнике /v1/finance/accrual/types на момент
сбора) не роняет и не пропускает строку молча — строка пишется как обычно,
а код лишь считается и печатается в итоговой строке лога.

Существующий сборщик worker/collectors/ozon_finance.py и таблица
tenant.ozon_finance_report НЕ затрагиваются — другой источник
(/v3/finance/transaction/list), другая семантика (см. §4 разбора: payout_amount
≡ total_amount, но раскладка на статьи расходится по конструкции ответа).
"""
import os, sys, time
os.environ["NO_PROXY"] = "*"          # иначе запрос уходит через прокси окружения и виснет

REQUEST_PAUSE_SEC = 1.0                # Ozon отдаёт code 8 на третьем запросе подряд;
                                       # заголовков с лимитами нет, поэтому пауза явная

from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient


def _amount(d):
    """{"amount": "-96.00", "currency": "RUB"} → -96.0. None/пусто → None."""
    if not d:
        return None
    v = d.get("amount")
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_accrual(accrual: dict) -> list:
    """Разобрать одну запись /v1/finance/accrual/by-day в строки для
    tenant.ozon_accruals (без cabinet_id — его добавляет db_pg при записи).

    line_no — 1-based, детерминирован порядком полей в ответе Ozon (одна и
    та же запись при повторном разборе даёт те же line_no → upsert по
    (cabinet_id, accrual_id, line_no) идемпотентен).
    """
    accrual_id = accrual.get("accrual_id")
    date = accrual.get("date")
    category = accrual.get("accrued_category")
    line_no = 0
    rows = []

    def _row(unit_number, sku, type_id, accrued, *, seller_price=None,
             sale_price=None, sale_commission=None, coinvestment=None, bonus=None):
        nonlocal line_no
        line_no += 1
        return {
            "accrual_id": accrual_id, "line_no": line_no, "date": date,
            "unit_number": unit_number, "accrued_category": category,
            "type_id": type_id, "sku": sku, "quantity": None,
            "accrued": accrued, "seller_price": seller_price,
            "sale_price": sale_price, "sale_commission": sale_commission,
            "coinvestment": coinvestment, "bonus": bonus,
        }

    if category == "POSTING":
        unit_number = accrual.get("unit_number")
        posting = accrual.get("posting") or {}
        for prod in posting.get("products") or []:
            sku = prod.get("sku")
            delivery = prod.get("delivery") or {}
            for svc in delivery.get("services") or []:
                rows.append(_row(unit_number, sku, svc.get("type_id"),
                                  _amount(svc.get("accrued"))))
            commission = prod.get("commission")
            if commission:
                sale_price = _amount(commission.get("sale_price"))
                sale_commission = _amount(commission.get("sale_commission"))
                coinvestment = _amount(commission.get("coinvestment"))
                bonus = _amount(commission.get("bonus"))
                accrued = sum(v for v in (sale_price, sale_commission, coinvestment, bonus)
                              if v is not None)
                rows.append(_row(
                    unit_number, sku, None, accrued,
                    seller_price=_amount(commission.get("seller_price")),
                    sale_price=sale_price, sale_commission=sale_commission,
                    coinvestment=coinvestment, bonus=bonus))
    elif category == "ITEM":
        unit_number = accrual.get("unit_number")
        item_fees = accrual.get("item_fees") or {}
        for sku_entry in item_fees.get("fees") or []:
            sku = sku_entry.get("sku")
            for fee in sku_entry.get("fees") or []:
                rows.append(_row(unit_number, sku, fee.get("type_id"),
                                  _amount(fee.get("accrued"))))
    elif category == "NON_ITEM":
        # unit_number сырого ответа сюда намеренно НЕ переносится — см. докстроку модуля.
        non_item_fee = accrual.get("non_item_fee") or {}
        rows.append(_row(None, None, non_item_fee.get("type_id"),
                          _amount(non_item_fee.get("accrued"))))
    else:
        # Незнакомая категория (не POSTING/ITEM/NON_ITEM) — не роняем разбор
        # и не теряем сумму молча: одна строка с total_amount без раскладки.
        rows.append(_row(accrual.get("unit_number"), None, None,
                          _amount(accrual.get("total_amount"))))

    return rows


def parse_accrual_types(raw_types: list) -> list:
    """/v1/finance/accrual/types → строки для shared.ozon_accrual_types."""
    return [{"type_id": t.get("id"), "name": t.get("name"),
             "description": t.get("description")} for t in (raw_types or [])]


def collect(date_from=None, date_to=None):
    print("[ozon_accruals] начисления /v1/finance/accrual/by-day", flush=True)
    db_pg.init()
    cli = OzonClient()

    if date_from is None:
        d_from = (datetime.now(timezone.utc) - timedelta(days=1)).date()
    elif isinstance(date_from, str):
        d_from = datetime.fromisoformat(date_from).date()
    else:
        d_from = date_from
    if date_to is None:
        d_to = d_from
    elif isinstance(date_to, str):
        d_to = datetime.fromisoformat(date_to).date()
    else:
        d_to = date_to

    print(f"  период: {d_from}..{d_to}", flush=True)

    # 1) справочник типов — сначала, чтобы уметь отличать незнакомые коды
    #    в строках начислений, которые разбираем следом.
    raw_types = cli.accrual_types()
    time.sleep(REQUEST_PAUSE_SEC)
    type_rows = parse_accrual_types(raw_types)
    written_types = db_pg.upsert_ozon_accrual_types(type_rows)
    known_type_ids = {r["type_id"] for r in type_rows if r["type_id"] is not None}
    print(f"  справочник типов: {len(raw_types)}, записано {written_types}", flush=True)

    # 2) по одному запросу на день, пауза между запросами — не быстрее
    #    1 запроса в секунду (проба показала code 8 на третьем подряд).
    rows = []
    unknown_types = set()
    n_days = 0
    day = d_from
    while day <= d_to:
        data = cli.accrual_by_day(day)
        n_days += 1
        time.sleep(REQUEST_PAUSE_SEC)
        accruals = data.get("accruals") or [] if isinstance(data, dict) else []
        for acc in accruals:
            for row in parse_accrual(acc):
                if row["type_id"] is not None and row["type_id"] not in known_type_ids:
                    unknown_types.add(row["type_id"])
                rows.append(row)
        day = day + timedelta(days=1)

    written = db_pg.upsert_ozon_accruals_many(rows)
    msg = f"[ozon_accruals] дней {n_days}, строк {len(rows)}, записано {written}"
    if unknown_types:
        msg += f", незнакомых type_id: {len(unknown_types)} {sorted(unknown_types)}"
    print(msg, flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
