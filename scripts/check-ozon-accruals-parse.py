#!/usr/bin/env python3
"""
check-ozon-accruals-parse.py — проверка разбора ответа Ozon
/v1/finance/accrual/by-day на сохранённой фикстуре (задача 1 плана
«переезд финансов Ozon на методы начислений»).

Без БД и без сети: только чистая функция разбора
worker.collectors.ozon_accruals.parse_accrual. Соседние проверки в scripts/
написаны на Node (check-*.mjs) под стек Node-сервисов; здесь стек — Python
(worker/collectors), поэтому проверка тоже на Python (см. брифы задачи 3:
"выбрать по тому, как устроены соседние проверки в проекте").

Проверяет пять утверждений брифа:
  1. POSTING даёт по строке на каждую услугу доставки + строку комиссии,
     sku и коммерческие поля заполнены.
  2. ITEM даёт строки из item_fees.fees[] с sku и type_id.
  3. NON_ITEM даёт одну строку без sku и без unit_number.
  4. Сумма accrued по строкам одной записи равна её total_amount.
  5. Отсутствие unit_number/sku не роняет разбор.

Запуск: python3 scripts/check-ozon-accruals-parse.py
"""
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

FIXTURE_DIR = os.path.join(
    REPO_ROOT, ".superpowers", "sdd", "2026-08-11-ozon-accrual-migration", "fixtures")
ACCRUALS_FIXTURE = os.path.join(FIXTURE_DIR, "accrual-by-day-2026-08-05-cab1.json")

failed = 0


def check(name, cond, got=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {got}"))
    if not cond:
        failed += 1


def main():
    global failed

    if not os.path.exists(ACCRUALS_FIXTURE):
        print(f"FAIL  фикстура не найдена: {ACCRUALS_FIXTURE}")
        sys.exit(1)

    try:
        from worker.collectors.ozon_accruals import parse_accrual
    except ImportError as e:
        print(f"FAIL  модуль worker.collectors.ozon_accruals не импортируется: {e}")
        sys.exit(1)

    with open(ACCRUALS_FIXTURE, encoding="utf-8") as f:
        fixture = json.load(f)
    accruals = fixture["accruals"]
    check("фикстура содержит 79 записей", len(accruals) == 79, len(accruals))

    by_id = {a["accrual_id"]: a for a in accruals}

    # --- 1. POSTING: строка на услугу + строка комиссии, sku и коммерческие
    #        поля заполнены. Разобрано на конкретной записи (2 услуги логистики
    #        + продающий блок commission), сверено с сырыми числами фикстуры.
    posting_id = 58786286904
    posting = by_id[posting_id]
    check("POSTING-фикстура найдена и это POSTING",
          posting["accrued_category"] == "POSTING")
    rows = parse_accrual(posting)
    check("POSTING: 3 строки (2 услуги + 1 комиссия)", len(rows) == 3, len(rows))
    svc_rows = [r for r in rows if r["type_id"] is not None]
    commission_rows = [r for r in rows if r["type_id"] is None]
    check("POSTING: 2 строки услуг с type_id", len(svc_rows) == 2, svc_rows)
    check("POSTING: 1 строка комиссии без type_id", len(commission_rows) == 1, commission_rows)
    check("POSTING: sku заполнен во всех строках",
          all(r["sku"] == 3988831040 for r in rows), rows)
    check("POSTING: type_id услуг — {32, 29}",
          {r["type_id"] for r in svc_rows} == {32, 29}, svc_rows)
    crow = commission_rows[0]
    check("POSTING: коммерческие поля строки комиссии заполнены",
          crow["seller_price"] == 3500.0 and crow["sale_price"] == 2061.85
          and crow["sale_commission"] == -1645.0 and crow["coinvestment"] == 20.62
          and crow["bonus"] == 1417.53, crow)
    check("POSTING: unit_number строк = номер отправления записи",
          all(r["unit_number"] == posting["unit_number"] for r in rows), rows)

    # Общее свойство по ВСЕМ POSTING-записям: если есть блок commission —
    # ровно одна строка комиссии со всеми коммерческими полями, и во всех
    # строках заполнен sku.
    posting_records = [a for a in accruals if a["accrued_category"] == "POSTING"]
    check("POSTING-записей в фикстуре: 37", len(posting_records) == 37, len(posting_records))
    posting_ok = True
    for a in posting_records:
        rs = parse_accrual(a)
        if not all(r["sku"] is not None for r in rs):
            posting_ok = False
            break
        crows = [r for r in rs if r["type_id"] is None]
        n_products_with_commission = sum(
            1 for p in a["posting"]["products"] if p.get("commission"))
        if len(crows) != n_products_with_commission:
            posting_ok = False
            break
        for r in crows:
            if r["seller_price"] is None or r["sale_price"] is None \
                    or r["sale_commission"] is None or r["coinvestment"] is None \
                    or r["bonus"] is None:
                posting_ok = False
                break
    check("POSTING (все 37): sku заполнен, строка комиссии = коммерческие поля", posting_ok)

    # --- 2. ITEM: строки из item_fees.fees[] с sku и type_id.
    item_id = 58786496192
    item = by_id[item_id]
    check("ITEM-фикстура найдена и это ITEM", item["accrued_category"] == "ITEM")
    rows = parse_accrual(item)
    check("ITEM: 1 строка", len(rows) == 1, rows)
    check("ITEM: sku и type_id заполнены",
          rows[0]["sku"] == 3988831040 and rows[0]["type_id"] == 1, rows[0])
    check("ITEM: accrued = -39.18", rows[0]["accrued"] == -39.18, rows[0])

    item_records = [a for a in accruals if a["accrued_category"] == "ITEM"]
    check("ITEM-записей в фикстуре: 27", len(item_records) == 27, len(item_records))
    item_ok = all(
        all(r["sku"] is not None and r["type_id"] is not None for r in parse_accrual(a))
        for a in item_records)
    check("ITEM (все 27): sku и type_id заполнены в каждой строке", item_ok)

    # --- 3. NON_ITEM: одна строка без sku и без unit_number (даже если сырой
    #        ответ несёт непустой unit_number для этой категории — см. докстроку
    #        ozon_accruals.parse_accrual: это не номер отправления).
    non_item_records = [a for a in accruals if a["accrued_category"] == "NON_ITEM"]
    check("NON_ITEM-записей в фикстуре: 15", len(non_item_records) == 15, len(non_item_records))
    has_raw_unit_number = any("unit_number" in a for a in non_item_records)
    check("NON_ITEM: часть сырых записей несёт unit_number (сверка допущения)",
          has_raw_unit_number)
    non_item_ok = True
    for a in non_item_records:
        rs = parse_accrual(a)
        if len(rs) != 1 or rs[0]["sku"] is not None or rs[0]["unit_number"] is not None:
            non_item_ok = False
            break
    check("NON_ITEM (все 15): ровно 1 строка, sku=None, unit_number=None", non_item_ok)

    # --- 4. Сумма accrued по строкам записи равна её total_amount (на всех
    #        79 записях фикстуры, включая POSTING/ITEM/NON_ITEM).
    sum_ok = True
    total_all = 0.0
    for a in accruals:
        rs = parse_accrual(a)
        total_amount = float(a["total_amount"]["amount"])
        row_sum = sum(r["accrued"] or 0.0 for r in rs)
        total_all += total_amount
        if abs(row_sum - total_amount) > 0.005:
            sum_ok = False
            print(f"  расхождение: accrual_id={a['accrual_id']} "
                  f"total_amount={total_amount} row_sum={row_sum}")
    check("Σaccrued по строкам = total_amount (все 79 записей)", sum_ok)
    check("Σtotal_amount фикстуры = 31 643,50 ₽ (сверка с задачей 1)",
          abs(total_all - 31643.50) < 0.005, round(total_all, 2))

    # --- 5. Отсутствие unit_number/sku не роняет разбор — синтетические
    #        записи с намеренно вырезанными полями.
    try:
        posting_no_unit = {
            "accrual_id": 1, "date": "2026-08-05", "accrued_category": "POSTING",
            "total_amount": {"amount": "-10", "currency": "RUB"},
            # unit_number нарочно отсутствует целиком (не просто None)
            "posting": {"products": [{
                # sku нарочно отсутствует
                "delivery": {"total_accrued": {"amount": "-10", "currency": "RUB"},
                             "services": [{"type_id": 32,
                                           "accrued": {"amount": "-10", "currency": "RUB"}}]},
                "commission": None,
            }]},
            "item_fees": None, "non_item_fee": None, "container_fees": None,
        }
        rs = parse_accrual(posting_no_unit)
        robust_posting = len(rs) == 1 and rs[0]["unit_number"] is None and rs[0]["sku"] is None

        item_no_sku = {
            "accrual_id": 2, "date": "2026-08-05", "accrued_category": "ITEM",
            "total_amount": {"amount": "-5", "currency": "RUB"},
            "posting": None,
            "item_fees": {"fees": [{
                # sku нарочно отсутствует
                "fees": [{"type_id": 1, "accrued": {"amount": "-5", "currency": "RUB"}}],
            }]},
            "non_item_fee": None, "container_fees": None,
        }
        rs2 = parse_accrual(item_no_sku)
        robust_item = len(rs2) == 1 and rs2[0]["sku"] is None and rs2[0]["type_id"] == 1

        robust = robust_posting and robust_item
        err = ""
    except Exception as e:
        robust = False
        err = repr(e)
    check("Отсутствие unit_number/sku не роняет разбор (синтетические записи)",
          robust, err)

    print()
    if failed:
        print(f"ИТОГО: {failed} провалено")
        sys.exit(1)
    print("ИТОГО: все проверки пройдены")


if __name__ == "__main__":
    main()
