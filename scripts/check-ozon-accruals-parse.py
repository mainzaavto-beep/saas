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

FIXTURE_DIR = os.path.join(REPO_ROOT, "scripts", "fixtures", "ozon-accruals")
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
        from worker.collectors.ozon_accruals import (
            parse_accrual, parse_accrual_types, row_sum_mismatch, check_single_page,
            resolve_window, MIN_LOOKBACK_DAYS, partial_exit_code)
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

    # --- 6. Ревью задачи 3, важный финдинг №1: сторожок пагинации.
    #        /v1/finance/accrual/by-day может отдать last_id — курсор не
    #        реализован, недобор должен падать громко, а не молчать.
    try:
        check_single_page({"accruals": [], "last_id": "abc123"}, "2026-08-05")
        page_guard_raises = False
    except RuntimeError:
        page_guard_raises = True
    check("check_single_page: непустой last_id — исключение (не молчаливый недобор)",
          page_guard_raises)

    no_raise_ok = True
    try:
        check_single_page({"accruals": [], "last_id": ""}, "2026-08-05")
        check_single_page({"accruals": []}, "2026-08-05")  # last_id вовсе отсутствует
    except Exception as e:
        no_raise_ok = False
        print(f"  неожиданное исключение: {e!r}")
    check("check_single_page: пустой/отсутствующий last_id — без исключения", no_raise_ok)

    # Сверка на реальной фикстуре: last_id пуст на всех 79 записях (проба
    # задачи 1), поэтому весь прогон check_single_page должен молча пройти.
    fixture_page_ok = True
    try:
        check_single_page(fixture, "2026-08-05")
    except RuntimeError as e:
        fixture_page_ok = False
        print(f"  {e}")
    check("check_single_page: фикстура задачи 1 (last_id пуст) — без исключения",
          fixture_page_ok)

    # --- 7. Ревью задачи 3, важный финдинг №2: рантайм-сверка Σaccrued по
    #        строкам записи против total_amount (ловит container_fees и любое
    #        другое неразобранное поле, не требуя заранее знать его форму).
    real_mismatches = [a for a in accruals if row_sum_mismatch(a, parse_accrual(a)) is not None]
    check("row_sum_mismatch: на реальной фикстуре расхождений нет (0 из 79)",
          len(real_mismatches) == 0, len(real_mismatches))

    # Синтетическая запись, где total_amount включает вклад "неразобранного"
    # container_fees (условно +15) сверх того, что даёт parse_accrual —
    # имитирует день, когда Ozon впервые заполнит это поле данными.
    non_item_with_container = {
        "accrual_id": 3, "date": "2026-08-05", "accrued_category": "NON_ITEM",
        "total_amount": {"amount": "-10", "currency": "RUB"},  # -25 (fee) + 15 (container, не разобран)
        "posting": None, "item_fees": None,
        "non_item_fee": {"type_id": 41, "accrued": {"amount": "-25", "currency": "RUB"}},
        "container_fees": {"fees": [{"type_id": 999, "accrued": {"amount": "15", "currency": "RUB"}}]},
    }
    diff = row_sum_mismatch(non_item_with_container, parse_accrual(non_item_with_container))
    check("row_sum_mismatch: ловит вклад неразобранного container_fees",
          diff is not None and abs(diff - (-25 - (-10))) < 0.005, diff)

    # Строка-контроль: диапазон допуска (0.01) не должен ловить обычное
    # округление копейки.
    rounding_ok_row = [{"accrued": -10.004}]
    rounding_acc = {"total_amount": {"amount": "-10.00", "currency": "RUB"}}
    check("row_sum_mismatch: копеечное округление в допуске — None",
          row_sum_mismatch(rounding_acc, rounding_ok_row) is None)

    # --- 8. Ревью задачи 3, minor: parse_accrual_types отфильтровывает
    #        записи без id (PK type_id NOT NULL — не ловим NULL-insert).
    raw_types_with_junk = [
        {"id": 1, "name": "Acquiring", "description": "Эквайринг"},
        {"name": "БезID", "description": "запись без id — должна быть отброшена"},
        {"id": None, "name": "СИдNone", "description": "тоже должна быть отброшена"},
    ]
    type_rows = parse_accrual_types(raw_types_with_junk)
    check("parse_accrual_types: записи без id отброшены (осталась 1 из 3)",
          len(type_rows) == 1 and type_rows[0]["type_id"] == 1, type_rows)

    # --- 9. Ревью fixwave задачи «переезд финансов Ozon», F2: вычисление
    #        окна планового/бэкфилл-прогона (resolve_window), без API/БД.
    #        Фиксированный today для детерминизма.
    from datetime import date as _date, timedelta as _timedelta
    TODAY = _date(2026, 8, 15)
    YESTERDAY = _date(2026, 8, 14)

    check("resolve_window: MIN_LOOKBACK_DAYS = 45", MIN_LOOKBACK_DAYS == 45, MIN_LOOKBACK_DAYS)

    # без аргументов — конец вчера, начало раздвинуто на 45 дней назад
    d_from, d_to = resolve_window(None, None, today=TODAY)
    check("resolve_window(): конец = вчера", d_to == YESTERDAY, d_to)
    check("resolve_window(): начало раздвинуто на 45 дней от конца",
          d_from == YESTERDAY - _timedelta(days=45), d_from)

    # плановый прогон run_saas_collect.sh: явный узкий диапазон −2..сегодня —
    # конец должен сжаться до вчера, начало раздвинуться до пола 45 дней
    d_from, d_to = resolve_window("2026-08-13", "2026-08-15", today=TODAY)
    check("resolve_window(план): конец сжат с сегодня до вчера", d_to == YESTERDAY, d_to)
    check("resolve_window(план): начало раздвинуто до пола (было 08-13, 2 дня)",
          d_from == YESTERDAY - _timedelta(days=45), d_from)

    # явный широкий бэкфилл (полностью в прошлом, шире 45 дней) — не трогаем
    d_from, d_to = resolve_window("2026-01-01", "2026-03-01", today=TODAY)
    check("resolve_window(бэкфилл): широкий явный диапазон не изменён",
          d_from == _date(2026, 1, 1) and d_to == _date(2026, 3, 1), (d_from, d_to))

    # явный date_to в будущем относительно today (не только "сегодня") тоже
    # зажимается до вчера
    d_from, d_to = resolve_window("2026-08-10", "2026-09-01", today=TODAY)
    check("resolve_window: date_to из будущего зажат до вчера", d_to == YESTERDAY, d_to)

    # date-объекты вместо строк — тоже поддерживаются (collect() передаёт как
    # есть); окно узкое (9 дней) — по тому же правилу пола раздвигается,
    # ровно как и строковый узкий диапазон выше (не важно, откуда пришла
    # узость — из дефолта, плана или явного, но короткого бэкфилла)
    d_from, d_to = resolve_window(_date(2026, 8, 1), _date(2026, 8, 10), today=TODAY)
    check("resolve_window: принимает date-объекты, узкое окно раздвигается до пола",
          d_from == _date(2026, 8, 10) - _timedelta(days=45) and d_to == _date(2026, 8, 10),
          (d_from, d_to))

    # --- 10. Ревью fixwave, F4: расхождения строка/total_amount → exit 3
    #         (partial по контракту orchestrator.py:80-82), строки не теряются.
    check("partial_exit_code(0): нет расхождений — None (обычный успех)",
          partial_exit_code(0) is None)
    check("partial_exit_code(3): есть расхождения — код 3 (partial)",
          partial_exit_code(3) == 3, partial_exit_code(3))

    print()
    if failed:
        print(f"ИТОГО: {failed} провалено")
        sys.exit(1)
    print("ИТОГО: все проверки пройдены")


if __name__ == "__main__":
    main()
