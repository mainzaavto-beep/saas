#!/usr/bin/env python3
"""
check-ozon-profit-calc.py — проверка расчёта прибыли Ozon из начислений
(задача 3 плана «переезд финансов Ozon на источник начислений»,
docs/superpowers/specs/2026-08-15-ozon-profit-switch-design.md).

Без БД и без сети: чистая функция worker.collectors.ozon_order_costs
.build_order_costs на репозиторных фикстурах
scripts/fixtures/ozon-accruals/accrual-by-day-2026-08-05-cab1.json
(79 записей, кабинет 1, 2026-08-05; по образцу
scripts/check-ozon-profit-map.py — тот же приём: parse_accrual разбирает
сырые записи в строки tenant.ozon_accruals, дальше работаем с ними, как
работал бы collect() после SELECT из БД).

Проверяет (пункты брифа задачи 3, шаг 2):
  1. продающее отправление: cost_value_retail == seller_price,
     commission == |sale_commission|, логистика просуммирована, is_return=0;
  2. возвратное отправление (типы 45/59 в фикстуре есть): is_return == 1,
     cost_value_retail == 0;
  3. нулевое отправление (без commission-блока, без 45/59): is_return == 0
     — фикс эвристики ±835 ₽ (раньше отсутствие продажи на дне путалось с
     возвратом);
  4. ITEM-эквайринг (type_id=1) попадает в acquiring СВОЕГО отправления
     (тот же юнит, что и продажа, — показывает точную привязку);
  5. согласованность компонент на КАЖДОМ из 44 отправлений фикстуры:
     cost_value_retail − |commission| − |logistics| − |acquiring| −
     |loyalty| == SUM(accrued строк отправления), допуск 0,01;
  6. инвариант периода: сумма accrued по всем отправлениям (order_costs) +
     сумма accrued кабинетных/промо строк (NON_ITEM) == сумма total_amount
     всех 79 записей фикстуры (31 643,50 ₽), допуск 0,01;
  7. profit == SUM(accrued отправления) − cost при заданном cost;
  8. мультитоварное отправление (синтетика, ревью задачи 3, Critical 1):
     несколько commission-блоков (разные sku) в одном unit_number —
     cost_value_retail/commission суммируются по ВСЕМ блокам, а не по
     последнему;
  9. resolve_meta(): точное совпадение posting_number, однозначное «базовое»
     совпадение (номер без финального "-N"), неоднозначное/отсутствующее —
     явный fallback (Critical 2, ревью задачи 3).

Запуск:
  /opt/agents/data-presenter-agent/.venv/bin/python scripts/check-ozon-profit-calc.py
"""
import json
import os
import sys
from collections import defaultdict

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

FIXTURE_DIR = os.path.join(REPO_ROOT, "scripts", "fixtures", "ozon-accruals")
ACCRUALS_FIXTURE = os.path.join(FIXTURE_DIR, "accrual-by-day-2026-08-05-cab1.json")
KNOWN_TOTAL_AMOUNT = 31643.50  # см. брифы задач 1-3 плана: сверенная сумма дня 2026-08-05, кабинет 1

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
        from worker.collectors.ozon_order_costs import build_order_costs
    except ImportError as e:
        print(f"FAIL  worker.collectors.ozon_order_costs.build_order_costs не импортируется: {e}")
        sys.exit(1)

    from worker.collectors.ozon_accruals import parse_accrual

    with open(ACCRUALS_FIXTURE, encoding="utf-8") as f:
        fixture = json.load(f)
    accruals = fixture["accruals"]
    check("фикстура содержит 79 записей", len(accruals) == 79, len(accruals))

    fixture_total = round(sum(float(a["total_amount"]["amount"]) for a in accruals
                               if a.get("total_amount")), 2)
    check(f"сумма total_amount фикстуры == {KNOWN_TOTAL_AMOUNT}",
          abs(fixture_total - KNOWN_TOTAL_AMOUNT) < 0.01, fixture_total)

    # Разбор фикстуры в строки tenant.ozon_accruals (тот же формат, что вернул
    # бы SELECT из БД), группировка по unit_number — то, что делает collect()
    # ДО вызова build_order_costs.
    by_unit = defaultdict(list)
    cabinet_rows = []
    for a in accruals:
        for r in parse_accrual(a):
            if r["unit_number"] is not None:
                by_unit[r["unit_number"]].append(r)
            else:
                cabinet_rows.append(r)
    check("отправлений (unit_number) в фикстуре: 44", len(by_unit) == 44, len(by_unit))

    def sum_accrued(rows):
        return round(sum((r["accrued"] or 0.0) for r in rows), 2)

    def comps_of(result):
        return round(result["cost_value_retail"] - result["commission"] - result["logistics"]
                     - result["acquiring"] - result["loyalty"], 2)

    # --- 1 + 4. Продающее отправление с ITEM-эквайрингом того же юнита.
    #     unit 0154253981-0534-1: POSTING (услуги 32/29 + commission-блок,
    #     seller_price=3500, sale_commission=-1645) + ITEM type_id=1 (-39.18).
    sale_unit = "0154253981-0534-1"
    sale_rows = by_unit[sale_unit]
    check(f"{sale_unit}: 4 строки начислений в фикстуре (2 логистики + commission + acquiring)",
          len(sale_rows) == 4, len(sale_rows))
    r1 = build_order_costs(sale_rows, {"product_id": 555, "size": "M",
                                        "order_dt": "2026-08-01T00:00:00Z", "qty": 1},
                            {555: 300.0})
    check("продающее: build_order_costs вернул строку (не None)", r1 is not None)
    check("продающее: cost_value_retail == seller_price (3500)", r1["cost_value_retail"] == 3500.0, r1)
    check("продающее: commission == |sale_commission| (1645)", r1["commission"] == 1645.0, r1)
    check("продающее: logistics == сумма логистических строк (304.73)",
          r1["logistics"] == 304.73, r1)
    check("продающее: is_return == 0", r1["is_return"] == 0, r1)
    check("продающее: ITEM-эквайринг (type_id=1, -39.18) попал в acquiring СВОЕГО отправления",
          r1["acquiring"] == 39.18, r1)
    check("продающее: согласованность компонент == SUM(accrued) (допуск 0,01)",
          abs(comps_of(r1) - sum_accrued(sale_rows)) < 0.01,
          (comps_of(r1), sum_accrued(sale_rows)))
    # profit == SUM(accrued) − cost при заданном cost (300).
    expected_profit = round(sum_accrued(sale_rows) - 300.0, 2)
    check(f"продающее: profit == SUM(accrued) − cost ({expected_profit})",
          r1["profit"] == expected_profit, r1["profit"])

    # --- 2. Возвратное отправление (типы 45/59 присутствуют в фикстуре).
    return_unit = "99715651-0185-2"
    return_rows = by_unit[return_unit]
    return_type_ids = {r["type_id"] for r in return_rows}
    check("возвратное: фикстура несёт типы 45 и 59", {45, 59} <= return_type_ids, return_type_ids)
    r2 = build_order_costs(return_rows, {"product_id": 777, "size": "L",
                                          "order_dt": "2026-08-01T00:00:00Z", "qty": 1}, {})
    check("возвратное: build_order_costs вернул строку (не None)", r2 is not None)
    check("возвратное: is_return == 1", r2["is_return"] == 1, r2)
    check("возвратное: cost_value_retail == 0 (нет продажи в периоде)",
          r2["cost_value_retail"] == 0.0, r2)
    check("возвратное: согласованность компонент == SUM(accrued) (допуск 0,01)",
          abs(comps_of(r2) - sum_accrued(return_rows)) < 0.01,
          (comps_of(r2), sum_accrued(return_rows)))

    # --- 3. Нулевое отправление: без commission-блока И без 45/59 — фикс
    #     эвристики ±835 ₽ (раньше отсутствие продажи путалось с возвратом).
    zero_unit = "0184084142-0066"
    zero_rows = by_unit[zero_unit]
    check(f"{zero_unit}: нет commission-блока (seller_price отсутствует ни в одной строке)",
          all(r.get("seller_price") is None for r in zero_rows), zero_rows)
    check(f"{zero_unit}: нет кодов возврата 45/59",
          not ({r["type_id"] for r in zero_rows} & {45, 59}))
    r3 = build_order_costs(zero_rows, {"product_id": 888, "size": "S",
                                        "order_dt": "2026-08-01T00:00:00Z", "qty": 1}, {})
    check("нулевое: build_order_costs вернул строку (не None)", r3 is not None)
    check("нулевое: is_return == 0 (НЕ путается с возвратом)", r3["is_return"] == 0, r3)
    check("нулевое: cost_value_retail == 0 (sale_price=0 / нет продажи)",
          r3["cost_value_retail"] == 0.0, r3)
    check("нулевое: согласованность компонент == SUM(accrued) (допуск 0,01)",
          abs(comps_of(r3) - sum_accrued(zero_rows)) < 0.01,
          (comps_of(r3), sum_accrued(zero_rows)))

    # --- 5. Согласованность компонент на ВСЕХ 44 отправлениях фикстуры
    #     (product_id/cost — заглушки: на арифметику компонент не влияют,
    #     только на product_id-резолв и вычитаемый cost из profit).
    all_ok = True
    n_checked = 0
    for i, (unit_number, rows) in enumerate(by_unit.items()):
        result = build_order_costs(rows, {"product_id": 1, "qty": 1}, {})
        if result is None:
            all_ok = False
            print(f"  build_order_costs(None) на unit_number={unit_number}")
            continue
        n_checked += 1
        diff = abs(comps_of(result) - sum_accrued(rows))
        if diff > 0.01:
            all_ok = False
            print(f"  расхождение на {unit_number}: comps={comps_of(result)} "
                  f"sum_accrued={sum_accrued(rows)} diff={diff:.4f}")
    check(f"согласованность компонент на всех {n_checked} отправлениях фикстуры", all_ok)

    # --- 6. Инвариант периода: order_costs (все 44 отправления, product_id=1
    #     заглушка -> ничего не пропущено) + кабинетные/промо (NON_ITEM) ==
    #     сумма total_amount фикстуры (31 643,50 ₽).
    sum_order = 0.0
    for unit_number, rows in by_unit.items():
        result = build_order_costs(rows, {"product_id": 1, "qty": 1}, {})
        sum_order += sum_accrued(rows) if result is not None else 0.0
    sum_cabinet_all = sum_accrued(cabinet_rows)  # cabinet + promo вместе (обе корзины из total_amount)
    allocated = round(sum_order + sum_cabinet_all, 2)
    check(f"инвариант: order_costs ({round(sum_order,2)}) + cabinet/promo "
          f"({sum_cabinet_all}) == total_amount ({KNOWN_TOTAL_AMOUNT}), допуск 0,01",
          abs(allocated - KNOWN_TOTAL_AMOUNT) < 0.01, allocated)

    # --- 8. Мультитоварное отправление (СИНТЕТИКА — фикстура дня не несёт
    #     такого случая): один unit_number, ДВА commission-блока (разные
    #     sku, как бывает у реального Ozon-отправления с несколькими
    #     товарами — ревью задачи 3, Critical 1, боевой пример
    #     unit=60208425-0132-1, кабинет 1008, 20 SKU). Числа подобраны так,
    #     чтобы seller_price = sale_price + coinvestment + bonus на КАЖДОМ
    #     блоке (доказанное тождество источника):
    #       товар A: seller_price=1000, sale_price=700, sale_commission=-300,
    #                coinvestment=0, bonus=300 -> accrued=700
    #       товар B: seller_price=500,  sale_price=400, sale_commission=-150,
    #                coinvestment=10, bonus=90  -> accrued=350
    #     плюс по одной логистической строке на товар (-50 / -20).
    multi_unit = "TEST-MULTI-0001-1"
    multi_rows = [
        {"unit_number": multi_unit, "accrued_category": "POSTING", "type_id": 32,
         "sku": 111, "accrued": -50.0, "date": "2026-08-05",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
        {"unit_number": multi_unit, "accrued_category": "POSTING", "type_id": None,
         "sku": 111, "accrued": 700.0, "date": "2026-08-05",
         "seller_price": 1000.0, "sale_price": 700.0, "sale_commission": -300.0,
         "coinvestment": 0.0, "bonus": 300.0},
        {"unit_number": multi_unit, "accrued_category": "POSTING", "type_id": 29,
         "sku": 222, "accrued": -20.0, "date": "2026-08-05",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
        {"unit_number": multi_unit, "accrued_category": "POSTING", "type_id": None,
         "sku": 222, "accrued": 350.0, "date": "2026-08-05",
         "seller_price": 500.0, "sale_price": 400.0, "sale_commission": -150.0,
         "coinvestment": 10.0, "bonus": 90.0},
    ]
    r_multi = build_order_costs(multi_rows, {"product_id": 999, "qty": 2}, {})
    check("мультитоварное: build_order_costs вернул строку (не None)", r_multi is not None)
    check("мультитоварное: cost_value_retail == СУММА seller_price двух блоков (1500, не 500 "
          "последнего)", r_multi["cost_value_retail"] == 1500.0, r_multi)
    check("мультитоварное: commission == СУММА |sale_commission| двух блоков (450, не 150 "
          "последнего)", r_multi["commission"] == 450.0, r_multi)
    check("мультитоварное: logistics == сумма обеих логистических строк (70)",
          r_multi["logistics"] == 70.0, r_multi)
    check("мультитоварное: is_return == 0", r_multi["is_return"] == 0, r_multi)
    check("мультитоварное: согласованность компонент == SUM(accrued) (допуск 0,01)",
          abs(comps_of(r_multi) - sum_accrued(multi_rows)) < 0.01,
          (comps_of(r_multi), sum_accrued(multi_rows)))

    # --- 9. resolve_meta(): точное совпадение, однозначное «базовое»
    #     совпадение (Critical 2, ревью задачи 3), неоднозначное/отсутствующее
    #     совпадение — явный fallback на unit_number + posting_number_resolved=False.
    from worker.collectors.ozon_order_costs import resolve_meta

    order_meta = {
        "ABC-1": {"posting_number": "ABC-1", "order_dt": "2026-08-01", "size": "M",
                   "product_id": 10, "qty": 2},
        "DEF-1": {"posting_number": "DEF-1", "order_dt": "2026-08-02", "size": "L",
                   "product_id": 20, "qty": 1},
        "XYZ-1": {"posting_number": "XYZ-1", "order_dt": "2026-08-03", "size": "S",
                   "product_id": 30, "qty": 1},
        "XYZ-2": {"posting_number": "XYZ-2", "order_dt": "2026-08-03", "size": "S",
                   "product_id": 31, "qty": 1},
    }
    order_meta_by_base = defaultdict(list)
    for pn, r in order_meta.items():
        base = pn.rsplit("-", 1)[0] if "-" in pn else pn
        order_meta_by_base[base].append(r)
    product_by_sku = {}

    # 9a. Точное совпадение unit_number == posting_number.
    meta_exact = resolve_meta("ABC-1", [], order_meta, order_meta_by_base, product_by_sku)
    check("resolve_meta: точное совпадение -> posting_number='ABC-1', resolved=True",
          meta_exact["posting_number"] == "ABC-1" and meta_exact["posting_number_resolved"] is True,
          meta_exact)

    # 9b. unit_number урезан (без финального "-N"), но «базовое» совпадение
    #     ОДНОЗНАЧНО (ровно один posting_number с такой базой) -> полный
    #     номер восстанавливается.
    meta_base = resolve_meta("DEF", [], order_meta, order_meta_by_base, product_by_sku)
    check("resolve_meta: однозначное базовое совпадение -> posting_number='DEF-1' "
          "(полный номер восстановлен из 'DEF'), resolved=True",
          meta_base["posting_number"] == "DEF-1" and meta_base["posting_number_resolved"] is True,
          meta_base)

    # 9c. unit_number урезан, «базовое» совпадение НЕОДНОЗНАЧНО (два разных
    #     posting_number с базой 'XYZ') -> НЕ гадаем, fallback (resolved=False,
    #     posting_number=None из resolve_meta — build_order_costs подставит
    #     unit_number сам).
    meta_ambiguous = resolve_meta("XYZ", [], order_meta, order_meta_by_base, product_by_sku)
    check("resolve_meta: неоднозначное базовое совпадение -> НЕ резолвлено "
          "(posting_number=None, resolved=False)",
          meta_ambiguous["posting_number"] is None and meta_ambiguous["posting_number_resolved"] is False,
          meta_ambiguous)

    # 9d. unit_number отсутствует в ozon_orders вовсе -> fallback.
    meta_missing = resolve_meta("GHOST-1", [], order_meta, order_meta_by_base, product_by_sku)
    check("resolve_meta: нет совпадения вовсе -> НЕ резолвлено (resolved=False)",
          meta_missing["posting_number"] is None and meta_missing["posting_number_resolved"] is False,
          meta_missing)

    # 9e. build_order_costs() пишет posting_number ИЗ meta (резолвленный),
    #     не сырой unit_number параметра — и наоборот, при resolved=False
    #     честно пишет unit_number как fallback (не теряет отправление).
    resolved_rows = [{"unit_number": "DEF", "accrued_category": "POSTING", "type_id": None,
                       "sku": 1, "accrued": 100.0, "date": "2026-08-02",
                       "seller_price": 100.0, "sale_price": 100.0, "sale_commission": 0.0,
                       "coinvestment": 0.0, "bonus": 0.0}]
    r_resolved = build_order_costs(resolved_rows, meta_base, {})
    check("build_order_costs: пишет РЕЗОЛВЛЕННЫЙ posting_number ('DEF-1'), не сырой unit_number "
          "('DEF')", r_resolved["posting_number"] == "DEF-1", r_resolved)

    unresolved_rows = [{"unit_number": "XYZ", "accrued_category": "POSTING", "type_id": None,
                         "sku": 1, "accrued": 100.0, "date": "2026-08-03",
                         "seller_price": 100.0, "sale_price": 100.0, "sale_commission": 0.0,
                         "coinvestment": 0.0, "bonus": 0.0}]
    # product_id для неоднозначного случая тоже не резолвлен через meta (пустая
    # meta) — передаём product_id отдельно (через sku 1 нет в product_by_sku),
    # чтобы проверить именно posting_number, не завалив тест на "нет product_id".
    meta_ambiguous_with_product = dict(meta_ambiguous, product_id=42)
    r_unresolved = build_order_costs(unresolved_rows, meta_ambiguous_with_product, {})
    check("build_order_costs: неоднозначный случай -> fallback на unit_number ('XYZ'), "
          "отправление НЕ потеряно (запись есть)",
          r_unresolved is not None and r_unresolved["posting_number"] == "XYZ", r_unresolved)

    print()
    if failed:
        print(f"ИТОГО: {failed} провалено")
        sys.exit(1)
    print("ИТОГО: все проверки пройдены")


if __name__ == "__main__":
    main()
