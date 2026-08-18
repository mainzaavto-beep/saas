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
     commission == -sale_commission (знаковое), логистика просуммирована, is_return=0;
  2. возвратное отправление (типы 45/59 в фикстуре есть): is_return == 1,
     cost_value_retail == 0;
  3. нулевое отправление (без commission-блока, без 45/59): is_return == 0
     — фикс эвристики ±835 ₽ (раньше отсутствие продажи на дне путалось с
     возвратом);
  4. ITEM-эквайринг (type_id=1) попадает в acquiring СВОЕГО отправления
     (тот же юнит, что и продажа, — показывает точную привязку);
  5. согласованность компонент на КАЖДОМ из 44 отправлений фикстуры:
     cost_value_retail − commission − logistics − acquiring − loyalty
     (ЗНАКОВОЕ вычитание, не abs()) == SUM(accrued строк отправления), допуск 0,01;
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

    # --- 10. C1 (фикс-волна финального ревью, .superpowers/sdd/
    #     2026-08-15-ozon-profit-switch/finalfix-report.md): юнит с
    #     начислениями в ДВУХ далёких датах (продажа внутри планового окна +
    #     упаковка неделю/месяц спустя, за границей окна) — collect() должен
    #     группировать ПОЛНУЮ историю юнита (второй запрос без фильтра по
    #     дате), а не только строки, попавшие в узкое плановое окно. Синтетика
    #     подобрана так, чтобы seller_price = sale_price + coinvestment + bonus
    #     (доказанное тождество источника, см. п.8 выше) — тогда полная запись
    #     самосогласована (comps == SUM(accrued)), а НЕПОЛНАЯ (только строка
    #     внутри окна, без более поздней) молча теряет логистическую строку и
    #     завышает profit — тот самый systematic minus из C1, только с обратным
    #     знаком на этой синтетике (потерянный МИНУС логистики завышает
    #     прибыль; в находке C1 терялся более крупный МИНУС и профит уходил в
    #     минус — эффект тот же класс, знак зависит от того, что именно
    #     обрезано).
    window_unit = "TEST-WINDOW-0001-1"
    row_in_window = {
        "unit_number": window_unit, "accrued_category": "POSTING", "type_id": None,
        "sku": 1, "accrued": 700.0, "date": "2026-08-05",
        "seller_price": 1000.0, "sale_price": 700.0, "sale_commission": -300.0,
        "coinvestment": 0.0, "bonus": 300.0,
    }
    row_outside_window = {
        "unit_number": window_unit, "accrued_category": "POSTING", "type_id": 39,  # PackingFee
        "sku": 1, "accrued": -50.0, "date": "2026-09-20",  # 6 недель спустя — за пределами планового окна
        "seller_price": None, "sale_price": None, "sale_commission": None,
        "coinvestment": None, "bonus": None,
    }
    full_history_rows = [row_in_window, row_outside_window]

    r_full = build_order_costs(full_history_rows, {"product_id": 1, "qty": 1}, {})
    check("C1: полная история юнита -> build_order_costs вернул строку (не None)",
          r_full is not None)
    check("C1: полная история -> logistics учитывает строку ЗА ГРАНИЦЕЙ окна (50)",
          r_full["logistics"] == 50.0, r_full)
    check("C1: полная история -> согласованность компонент == SUM(accrued) (допуск 0,01)",
          abs(comps_of(r_full) - sum_accrued(full_history_rows)) < 0.01,
          (comps_of(r_full), sum_accrued(full_history_rows)))
    expected_full_profit = round(sum_accrued(full_history_rows) - 0.0, 2)
    check(f"C1: полная история -> profit == SUM(accrued обеих строк) ({expected_full_profit})",
          r_full["profit"] == expected_full_profit, r_full["profit"])

    # Контрольный пример дефекта (ДО фикса C1): группировка ТОЛЬКО строки
    # окна (без row_outside_window) молча теряет -50 логистики и завышает
    # profit — «выглядит» самосогласованной (comps == SUM видимых строк), но
    # расходится с профилем полной истории. Ровно это и чинит второй SQL-
    # запрос в collect() (см. докстроку модуля, докстроку collect()).
    r_window_only = build_order_costs([row_in_window], {"product_id": 1, "qty": 1}, {})
    check("C1: узкое окно (без row_outside_window) само по себе НЕ падает на "
          "consistency_ok (иначе баг был бы заметен сторожем сразу)",
          r_window_only["consistency_ok"] is True, r_window_only)
    check("C1: но узкое окно ЗАНИЖАЕТ логистику относительно полной истории (0 != 50)",
          r_window_only["logistics"] == 0.0 and r_full["logistics"] == 50.0,
          (r_window_only["logistics"], r_full["logistics"]))
    check("C1: и, как следствие, ЗАВЫШАЕТ profit относительно полной истории (700 != 650)",
          r_window_only["profit"] != r_full["profit"] and r_window_only["profit"] == 700.0
          and r_full["profit"] == 650.0,
          (r_window_only["profit"], r_full["profit"]))

    # --- 11. I3 (та же фикс-волна): DELETE-список upsert_ozon_order_costs_many
    #     должен включать ИСХОДНЫЙ (сырой) unit_number пересобираемых юнитов,
    #     а не только posting_number строк ЭТОГО прогона — иначе смена
    #     резолва posting_number между прогонами (сырой fallback -> полная
    #     форма) оставляет сироту в БД (двойной счёт, живой кандидат
    #     49789280-0223, каб.1). Чистая функция без БД:
    #     worker.db_pg._order_costs_delete_keys.
    from worker.db_pg import _order_costs_delete_keys

    # 11a. Прошлый прогон писал под сырым unit_number (meta не нашлась,
    #      fallback) -> строка "49789280-0223" уже в БД. Этот прогон нашёл
    #      meta и резолвил ПОЛНУЮ форму -> rows несёт только новый
    #      posting_number. extra_keys (исходные unit_number пересобираемых
    #      юнитов этого прогона) обязаны вернуть И старый ключ тоже.
    prior_raw_key = "49789280-0223"
    this_run_rows = [{"posting_number": "49789280-0223-1", "product_id": 1}]
    keys = _order_costs_delete_keys(this_run_rows, extra_keys=[prior_raw_key])
    check("I3: DELETE-список = {новый posting_number} ∪ {исходный unit_number} "
          "(сирота под старым ключом будет удалена)",
          keys == sorted({"49789280-0223-1", "49789280-0223"}), keys)

    # 11b. Без extra_keys (старое поведение) сирота осталась бы НЕ удалённой —
    #      явно показываем разницу, чтобы регресс на "забыли передать extra_keys"
    #      был заметен.
    keys_without_extra = _order_costs_delete_keys(this_run_rows, extra_keys=None)
    check("I3: БЕЗ extra_keys старый ключ в DELETE-список не попадает (это и есть "
          "баг, который чинит extra_keys)",
          prior_raw_key not in keys_without_extra, keys_without_extra)

    # 11c. extra_keys, совпадающий с posting_number этого прогона (юнит
    #      всегда резолвился одинаково) — не даёт дублей в списке.
    keys_dedup = _order_costs_delete_keys(
        [{"posting_number": "STABLE-1"}], extra_keys=["STABLE-1"])
    check("I3: дедупликация — одинаковый ключ из rows и extra_keys не дублируется",
          keys_dedup == ["STABLE-1"], keys_dedup)

    # 11d. rows пустой (все пересобираемые юниты этого прогона не резолвили
    #      product_id -> skipped), но extra_keys непуст -> сироты всё равно
    #      должны попасть под DELETE (юнит "пересобирался", просто ничего не
    #      получилось записать заново).
    keys_only_extra = _order_costs_delete_keys([], extra_keys=["ORPHAN-ONLY-1"])
    check("I3: rows пуст, extra_keys непуст -> ключ всё равно в списке (сирота "
          "'пересобираемого', но не резолвленного юнита тоже чистится)",
          keys_only_extra == ["ORPHAN-ONLY-1"], keys_only_extra)

    # --- 11e. I4 (задача 6 плана «ремонт данных прибыли Ozon», НАХОДКА
    #     после подмены — task-6-report.md): I3 закрывает ТОЛЬКО переход
    #     «юнит записан под сырым unit_number (fallback) -> резолвится в
    #     этом прогоне». Живые данные 2026-08-18 показали ДРУГОЙ, не
    #     покрытый I3 переход: юнит УЖЕ был резолвлен на прошлом прогоне
    #     (суффиксная форма "0115022887-0449-5" — resolve_meta нашёл
    #     только уникального base-кандидата), а в этом прогоне resolve_meta
    #     нашёл ТОЧНОЕ совпадение в tenant.ozon_orders (которая сама живая,
    #     пополняется независимым сборщиком) и отдал БАЗОВУЮ форму
    #     "0115022887-0449" — 20 таких пар кабинета 1 задвоили деньги
    #     (полная сверка сумм — task-6-report.md). Ни posting_number этого
    #     прогона, ни сырой unit_number (I3 extra_keys) не совпадают со
    #     СТАРЫМ суффиксным posting_number -> I3-ключей недостаточно.
    #     Фикс: ВТОРОЕ условие DELETE — по src_unit_number (worker/
    #     db_pg.py::_order_costs_delete_unit_keys) — эта колонка хранит
    #     ИСХОДНЫЙ unit_number буквально независимо от формы posting_number,
    #     поэтому находит старую строку под ЛЮБОЙ её прежней формой.
    from worker.db_pg import _order_costs_delete_unit_keys

    def _simulate_order_costs_delete(existing_rows, posting_keys, unit_keys):
        """Локальная имитация предиката DELETE
        upsert_ozon_order_costs_many (posting_number = ANY(posting_keys) OR
        src_unit_number = ANY(unit_keys)) — БЕЗ БД, только ради этого теста."""
        pk, uk = set(posting_keys), set(unit_keys)
        return [r for r in existing_rows
                if r["posting_number"] not in pk and r.get("src_unit_number") not in uk]

    prior_suffixed_row = {"posting_number": "0115022887-0449-5",
                           "src_unit_number": "0115022887-0449"}
    unrelated_row = {"posting_number": "UNRELATED-1", "src_unit_number": "UNRELATED-1"}
    this_run_rows_i4 = [{"posting_number": "0115022887-0449", "product_id": 1}]
    extra_keys_i4 = ["0115022887-0449"]  # touched_unit_numbers этого прогона

    posting_keys_i4 = _order_costs_delete_keys(this_run_rows_i4, extra_keys=extra_keys_i4)
    check("I4: I3-ключей (posting_number этого прогона ∪ сырой unit_number) НЕДОСТАТОЧНО "
          "— старый суффиксный posting_number среди них отсутствует (это и есть баг)",
          "0115022887-0449-5" not in posting_keys_i4, posting_keys_i4)

    unit_keys_i4 = _order_costs_delete_unit_keys(extra_keys_i4)
    check("I4: _order_costs_delete_unit_keys вернул сырой unit_number этого прогона",
          unit_keys_i4 == ["0115022887-0449"], unit_keys_i4)

    survivors_without_fix = _simulate_order_costs_delete(
        [prior_suffixed_row, unrelated_row], posting_keys_i4, unit_keys=[])
    check("I4: БЕЗ второго условия (src_unit_number) старая суффиксная строка "
          "выжила бы — это и есть баг, который чинит I4",
          survivors_without_fix == [prior_suffixed_row, unrelated_row], survivors_without_fix)

    survivors_with_fix = _simulate_order_costs_delete(
        [prior_suffixed_row, unrelated_row], posting_keys_i4, unit_keys_i4)
    check("I4: С фиксом старая суффиксная строка удаляется по src_unit_number "
          "(не осиротеет, двойного счёта не будет), не связанная строка выживает",
          survivors_with_fix == [unrelated_row], survivors_with_fix)

    # --- 12. Датировка юнитов БЕЗ commission-блока (задача 3 плана «ремонт
    #     данных прибыли Ozon», docs/superpowers/specs/
    #     2026-08-17-ozon-data-repair-design.md §2): −1,81 млн ₽ расходов были
    #     невидимы в помесячных разрезах, т.к. такие юниты не получали ни
    #     sale_dt, ни return_dt (оба NULL). Правило: min(date) строк юнита →
    #     return_dt, если юнит возвратный (та же логика, что ставит is_return),
    #     иначе → sale_dt. Реальные примеры фикстуры (все строки датированы
    #     2026-08-05 — единственный день фикстуры):
    #       0184084142-0066 — без commission-блока, НЕ возвратный (уже
    #         покрыт проверкой "нулевое" выше как zero_unit);
    #       99715651-0185-2 — без commission-блока, возвратный (типы 45/59;
    #         уже покрыт проверкой "возвратное" выше как return_unit).
    check("нулевое (без commission, не возврат): sale_dt == min(date) строк ('2026-08-05'), "
          "return_dt IS NULL (было: оба NULL)",
          r3["sale_dt"] == "2026-08-05" and r3["return_dt"] is None, r3)
    check("возвратное без commission-блока: return_dt == min(date) строк ('2026-08-05'), "
          "sale_dt IS NULL (было: оба NULL)",
          r2["return_dt"] == "2026-08-05" and r2["sale_dt"] is None, r2)

    # Синтетика: различает "min(date) ВСЕХ строк юнита" от "min(date) только
    # return-типных строк" (45/59) — правило спеки берёт первое, не второе.
    nodate_return_rows = [
        {"unit_number": "TEST-NODATE-RET-1", "accrued_category": "POSTING", "type_id": 32,
         "sku": 1, "accrued": -50.0, "date": "2026-07-01",  # раньше return-строки
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
        {"unit_number": "TEST-NODATE-RET-1", "accrued_category": "POSTING", "type_id": 45,
         "sku": 1, "accrued": -20.0, "date": "2026-07-10",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_nodate_ret = build_order_costs(nodate_return_rows, {"product_id": 1, "qty": 1}, {})
    check("без commission, возврат (синтетика): is_return == 1", r_nodate_ret["is_return"] == 1, r_nodate_ret)
    check("без commission, возврат (синтетика): return_dt == min ВСЕХ строк юнита ('2026-07-01'), "
          "а не только return-типной строки ('2026-07-10')",
          r_nodate_ret["return_dt"] == "2026-07-01", r_nodate_ret)
    check("без commission, возврат (синтетика): sale_dt IS NULL", r_nodate_ret["sale_dt"] is None, r_nodate_ret)

    nodate_sale_rows = [
        {"unit_number": "TEST-NODATE-SALE-1", "accrued_category": "POSTING", "type_id": 32,
         "sku": 1, "accrued": -10.0, "date": "2026-07-05",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
        {"unit_number": "TEST-NODATE-SALE-1", "accrued_category": "POSTING", "type_id": 29,
         "sku": 1, "accrued": -5.0, "date": "2026-07-01",  # самая ранняя строка
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_nodate_sale = build_order_costs(nodate_sale_rows, {"product_id": 1, "qty": 1}, {})
    check("без commission, не возврат (синтетика): sale_dt == min ВСЕХ строк юнита ('2026-07-01')",
          r_nodate_sale["sale_dt"] == "2026-07-01", r_nodate_sale)
    check("без commission, не возврат (синтетика): return_dt IS NULL", r_nodate_sale["return_dt"] is None, r_nodate_sale)

    # Регресс: юнит С commission-блоком — правило «первой операции» НЕ
    # применяется, даты как раньше (baseline снят ДО фикса задачи 3: sale_unit
    # sale_dt='2026-08-05', return_dt=None — единственная дата фикстуры, но
    # путь вычисления другой: sale_dates строится из commission_rows, а не из
    # ВСЕХ строк юнита — регресс ловится синтетикой ниже, не датой самой по
    # себе).
    check("commission-блок есть: sale_dt как раньше (из commission_rows, не всех строк)",
          r1["sale_dt"] == "2026-08-05" and r1["return_dt"] is None, r1)
    # Синтетика: у юнита С commission-блоком есть более ранняя логистическая
    # строка ВНЕ commission — правило первой операции игнорирует её, sale_dt
    # берётся только из commission-строки (регресс, если sale_dt "утечёт" на
    # более раннюю дату несвязанной логистики).
    commission_regress_rows = [
        {"unit_number": "TEST-COMMISSION-REGRESS-1", "accrued_category": "POSTING", "type_id": 32,
         "sku": 1, "accrued": -50.0, "date": "2026-06-01",  # заведомо раньше commission-строки
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
        {"unit_number": "TEST-COMMISSION-REGRESS-1", "accrued_category": "POSTING", "type_id": None,
         "sku": 1, "accrued": 700.0, "date": "2026-08-05",
         "seller_price": 1000.0, "sale_price": 700.0, "sale_commission": -300.0,
         "coinvestment": 0.0, "bonus": 300.0},
    ]
    r_commission_regress = build_order_costs(commission_regress_rows, {"product_id": 1, "qty": 1}, {})
    check("commission-блок есть + более ранняя несвязанная логистика: sale_dt == дата "
          "commission-строки ('2026-08-05'), НЕ min всех строк ('2026-06-01') — правило "
          "первой операции применяется ТОЛЬКО к юнитам без commission-блока",
          r_commission_regress["sale_dt"] == "2026-08-05", r_commission_regress)

    # --- 13. Строки без товара (задача 3 плана, §3): sku, отсутствующий и в
    #     каталоге (product_by_sku), и в заказах (ozon_orders) — meta пустая,
    #     product_id не резолвится НИКАК. Раньше build_order_costs возвращал
    #     None (юнит пропускался молча — источник разрыва инварианта ~334
    #     тыс ₽). Теперь: строка ЕСТЬ, product_id IS NULL, деньги на месте.
    r_no_product = build_order_costs(sale_rows, {}, {})
    check("без товара: build_order_costs вернул строку (не None — раньше пропускал)",
          r_no_product is not None, r_no_product)
    check("без товара: product_id IS NULL", r_no_product is not None and r_no_product.get("product_id") is None,
          r_no_product)
    check("без товара: деньги на месте (cost_value_retail == 3500, как в резолвленном случае)",
          r_no_product is not None and r_no_product["cost_value_retail"] == 3500.0, r_no_product)
    check("без товара: commission на месте (1645)",
          r_no_product is not None and r_no_product["commission"] == 1645.0, r_no_product)
    check("без товара: cost IS NULL (costs.get(None) не резолвится), profit == SUM(accrued)",
          r_no_product is not None and r_no_product["cost"] is None
          and r_no_product["profit"] == round(sum_accrued(sale_rows), 2), r_no_product)

    # --- 14. src_unit_number: исходный (сырой) unit_number начислений — в
    #     каждой строке, независимо от того, резолвился ли posting_number.
    check("src_unit_number: продающее отправление == unit_number строк фикстуры",
          r1.get("src_unit_number") == sale_unit, r1)
    check("src_unit_number: без товара (product_id NULL) — тоже заполнен",
          r_no_product is not None and r_no_product.get("src_unit_number") == sale_unit, r_no_product)
    # Резолвленный posting_number ('DEF-1') ОТЛИЧАЕТСЯ от исходного unit_number
    # ('DEF') — src_unit_number должен нести именно ВХОДНОЙ unit_number, а не
    # переписанный posting_number (иначе поле бесполезно для сторожа, задача 4).
    check("src_unit_number: резолвленный posting_number ('DEF-1') != src_unit_number, "
          "src_unit_number несёт ИСХОДНЫЙ unit_number ('DEF')",
          r_resolved["posting_number"] == "DEF-1" and r_resolved.get("src_unit_number") == "DEF",
          r_resolved)
    check("src_unit_number: нерезолвленный posting_number (fallback на unit_number 'XYZ') — "
          "src_unit_number тоже 'XYZ' (совпадает, т.к. posting_number сам fallback на него)",
          r_unresolved.get("src_unit_number") == "XYZ", r_unresolved)

    # --- 15. Инвариант: после датировки строк с NULL в ОБЕИХ датах быть не
    #     должно вовсе — ни на одном из 44 реальных отправлений фикстуры, ни
    #     на синтетике этого файла (мультитоварное, окно C1, без-commission,
    #     без товара).
    all_dated = True
    for unit_number, rows in by_unit.items():
        result = build_order_costs(rows, {"product_id": 1, "qty": 1}, {})
        if result is not None and result["sale_dt"] is None and result["return_dt"] is None:
            all_dated = False
            print(f"  ОБЕ ДАТЫ NULL: unit_number={unit_number}")
    check("инвариант датировки: ни один из 44 реальных отправлений фикстуры не имеет "
          "NULL в обеих датах", all_dated)
    synthetic_results = [r1, r2, r3, r_multi, r_full, r_nodate_ret, r_nodate_sale,
                          r_commission_regress, r_no_product, r_resolved, r_unresolved]
    check("инвариант датировки: ни одна синтетическая/фикстурная строка теста не имеет "
          "NULL в обеих датах",
          all(not (r["sale_dt"] is None and r["return_dt"] is None) for r in synthetic_results))

    # --- 16. Runtime-инструментирование инварианта датировки в collect()
    #     (ревью задачи 3, Important): «после датировки строк с NULL в обеих
    #     датах быть не должно вовсе — сборщик проверяет и считает» (спека
    #     §2) — до этой правки инвариант был защищён ТОЛЬКО тестами выше и
    #     случайностью схемы (tenant.ozon_accruals.date — NOT NULL,
    #     db/migrations/040_ozon_accruals.sql:32), а не runtime-проверкой:
    #     регресс в build_order_costs прошёл бы в БД молча. collect() теперь
    #     считает both_dates_null_count по ТОМУ ЖЕ условию, что и проверка
    #     15 выше (result["sale_dt"] is None and result["return_dt"] is None),
    #     инкрементирует mismatches → exit-код 3 (partial_exit_code) и
    #     печатает русский лог — см. worker/collectors/ozon_order_costs.py,
    #     докстрока модуля (список инвариантов) + тело collect(). Без БД
    #     collect() целиком не протестировать (он делает SELECT) — этот тест
    #     доказывает ДРУГУЮ половину контракта: что build_order_costs МОЖЕТ
    #     физически вернуть обе даты NULL, если строки начислений приходят с
    #     date=None (наперекор документированному NOT NULL — например, будущий
    #     баг парсинга ИЛИ смена схемы вверх по потоку) — то есть условие
    #     срабатывания счётчика в collect() достижимо, не dead code.
    dateless_rows = [
        {"unit_number": "TEST-ALLNULL-DATE-1", "accrued_category": "POSTING", "type_id": 32,
         "sku": 1, "accrued": -10.0, "date": None,
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_dateless = build_order_costs(dateless_rows, {"product_id": 1, "qty": 1}, {})
    check("runtime-инвариант (16): build_order_costs МОЖЕТ вернуть обе даты NULL, если "
          "строки приходят без даты (date=None) — условие счётчика both_dates_null_count "
          "в collect() достижимо, не dead code",
          r_dateless is not None and r_dateless["sale_dt"] is None and r_dateless["return_dt"] is None,
          r_dateless)
    # То самое условие, которое collect() использует для инкремента
    # both_dates_null_count (скопировано дословно из тела collect(), чтобы
    # регресс в условии там был бы замечен здесь тоже, если кто-то поправит
    # одно и забудет другое).
    would_trigger_counter = r_dateless["sale_dt"] is None and r_dateless["return_dt"] is None
    check("runtime-инвариант (16): та же строка НЕ триггерит счётчик, когда дата есть "
          "(normalной фикстурный r1) — счётчик не ложноположительный",
          not (r1["sale_dt"] is None and r1["return_dt"] is None))
    check("runtime-инвариант (16): условие счётчика both_dates_null_count в collect() "
          "истинно для этой синтетики (would_trigger_counter)", would_trigger_counter)

    print()
    if failed:
        print(f"ИТОГО: {failed} провалено")
        sys.exit(1)
    print("ИТОГО: все проверки пройдены")


if __name__ == "__main__":
    main()
