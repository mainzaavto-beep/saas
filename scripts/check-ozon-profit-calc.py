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

# «today» для тестов датировки/зрелости (задача 6 плана, round 3/4 фикс —
# MATURITY_THRESHOLD_DAYS в worker/collectors/ozon_order_costs.py): ВСЕ
# фикстурные/синтетические даты этого файла лежат между 2026-06-01 и
# 2026-08-05 — MATURE_TODAY заведомо (на месяцы) старше порога зрелости
# (3 дня) для любой из них, поэтому тесты, ожидающие «юнит датирован»,
# передают его явно — БЕЗ этого build_order_costs брал бы реальный
# datetime.now(timezone.utc) (прод-дефолт), и тест либо проходил случайно
# по совпадению с датой запуска, либо стал бы хрупким/детерминированным
# только сегодня (антипаттерн: тест обязан быть детерминирован всегда, не
# «пока не прошло 3 дня с сегодня»).
MATURE_TODAY = "2026-12-01"

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
                                        "order_dt": "2026-08-01T00:00:00Z", "qty": 1}, {},
                            today=MATURE_TODAY)
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
        result = build_order_costs(rows, {"product_id": 1, "qty": 1}, {}, today=MATURE_TODAY)
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
    r_nodate_sale = build_order_costs(nodate_sale_rows, {"product_id": 1, "qty": 1}, {},
                                       today=MATURE_TODAY)
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

    # --- 15. Инвариант: после датировки ЗРЕЛЫХ (today=MATURE_TODAY, задача 6
    #     round 3/4 — иначе кандидаты без commission-блока моложе порога
    #     зрелости остаются НЕ датированы намеренно, см. 16 ниже) строк с
    #     NULL в ОБЕИХ датах быть не должно вовсе — ни на одном из 44
    #     реальных отправлений фикстуры, ни на синтетике этого файла
    #     (мультитоварное, окно C1, без-commission, без товара).
    all_dated = True
    for unit_number, rows in by_unit.items():
        result = build_order_costs(rows, {"product_id": 1, "qty": 1}, {}, today=MATURE_TODAY)
        if result is not None and result["sale_dt"] is None and result["return_dt"] is None:
            all_dated = False
            print(f"  ОБЕ ДАТЫ NULL: unit_number={unit_number}")
    check("инвариант датировки: ни один из 44 реальных отправлений фикстуры (все зрелые "
          "относительно MATURE_TODAY) не имеет NULL в обеих датах", all_dated)
    synthetic_results = [r1, r2, r3, r_multi, r_full, r_nodate_ret, r_nodate_sale,
                          r_commission_regress, r_no_product, r_resolved, r_unresolved]
    check("инвариант датировки: ни одна синтетическая/фикстурная строка теста не имеет "
          "NULL в обеих датах",
          all(not (r["sale_dt"] is None and r["return_dt"] is None) for r in synthetic_results))

    # --- 16. Порог зрелости (MATURITY_THRESHOLD_DAYS) — задача 6 плана
    #     «ремонт данных прибыли Ozon», round 3/4 фикс (task-6-report.md).
    #     ДО этого раунда «инвариант датировки» требовал, чтобы ЛЮБОЙ юнит
    #     без commission-блока и без 45/59 всё равно получал дату (min(date)
    #     всех строк) — задача 3. Владелец нашёл дефект: для СВЕЖИХ (юнит в
    #     пути/только доставлен) юнитов это давало фантомную «продажу» с
    #     нулевой выручкой и profit = −логистика−cost, хотя Ozon ещё не
    #     финализировал сделку. Правило уточнено: датируем ТОЛЬКО «зрелые»
    #     (last_date старше MATURITY_THRESHOLD_DAYS дней относительно today);
    #     свежие остаются immature=True, sale_dt/return_dt ОБА None,
    #     collect() строку вовсе не пишет (см. докстроку build_order_costs).
    from worker.collectors.ozon_order_costs import MATURITY_THRESHOLD_DAYS

    fresh_rows = [
        {"unit_number": "TEST-FRESH-0001", "accrued_category": "POSTING", "type_id": 32,
         "sku": 1, "accrued": -10.0, "date": "2026-08-16",  # последняя операция юнита
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    # today на 2 дня позже последней операции — МЕНЬШЕ порога (3 дня) -> immature.
    r_fresh = build_order_costs(fresh_rows, {"product_id": 1, "qty": 1}, {}, today="2026-08-18")
    check(f"порог зрелости (16): юнит младше {MATURITY_THRESHOLD_DAYS} дн. (возраст 2 дн.) -> "
          "immature=True, строка НЕ будет записана collect()",
          r_fresh is not None and r_fresh["immature"] is True, r_fresh)
    check("порог зрелости (16): immature -> sale_dt и return_dt ОБА None (осознанный сигнал "
          "«рано», не инвариант-нарушение)",
          r_fresh["sale_dt"] is None and r_fresh["return_dt"] is None, r_fresh)

    # today РОВНО на пороге (MATURITY_THRESHOLD_DAYS дней) -> уже зрелый (>=,
    # не >) -> датирован как обычно.
    r_exactly_mature = build_order_costs(
        fresh_rows, {"product_id": 1, "qty": 1}, {},
        today="2026-08-19")  # 2026-08-19 − 2026-08-16 = 3 дня == порог
    check(f"порог зрелости (16): возраст РОВНО {MATURITY_THRESHOLD_DAYS} дн. -> зрелый "
          "(граница включительно, >=) -> immature=False, sale_dt проставлен",
          r_exactly_mature["immature"] is False and r_exactly_mature["sale_dt"] == "2026-08-16",
          r_exactly_mature)

    # today далеко в будущем (MATURE_TODAY) -> тот же юнит давно созрел.
    r_mature = build_order_costs(fresh_rows, {"product_id": 1, "qty": 1}, {}, today=MATURE_TODAY)
    check("порог зрелости (16): тот же юнит с today=MATURE_TODAY -> зрелый, immature=False, "
          "sale_dt == min(date) строк ('2026-08-16')",
          r_mature["immature"] is False and r_mature["sale_dt"] == "2026-08-16", r_mature)

    # Возвратный (45/59) юнит — порог зрелости НЕПРИМЕНИМ: return_dt уже
    # проставлен веткой return_dates независимо от commission-блока/today.
    fresh_return_rows = [
        {"unit_number": "TEST-FRESH-RETURN-0001", "accrued_category": "POSTING", "type_id": 45,
         "sku": 1, "accrued": -10.0, "date": "2026-08-17",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_fresh_return = build_order_costs(fresh_return_rows, {"product_id": 1, "qty": 1}, {},
                                        today="2026-08-18")  # возраст 1 день — младше порога
    check("порог зрелости (16): возвратный юнит (код 45) младше порога — ВСЁ РАВНО "
          "immature=False (return_dates уже даёт дату безусловно, порог его не касается)",
          r_fresh_return["immature"] is False and r_fresh_return["is_return"] == 1
          and r_fresh_return["return_dt"] == "2026-08-17", r_fresh_return)

    # Полностью dateless (date=None у единственной строки) — last_date=None,
    # age_days не вычислим -> считается immature (безопасная деградация:
    # раньше это давало ЗАПИСАННУЮ строку с обеими датами NULL — задача 3;
    # теперь просто не пишется вовсе, тот же дух «не терять деньги молча»,
    # деньги остаются видны сторожу через no_row).
    dateless_rows = [
        {"unit_number": "TEST-ALLNULL-DATE-1", "accrued_category": "POSTING", "type_id": 32,
         "sku": 1, "accrued": -10.0, "date": None,
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_dateless = build_order_costs(dateless_rows, {"product_id": 1, "qty": 1}, {}, today=MATURE_TODAY)
    check("порог зрелости (16): строка без даты вовсе (date=None) -> immature=True "
          "(нет last_date -> возраст не вычислим -> консервативно 'рано'), обе даты None",
          r_dateless is not None and r_dateless["immature"] is True
          and r_dateless["sale_dt"] is None and r_dateless["return_dt"] is None,
          r_dateless)

    # --- 17. Склейка сиблингов base/suffix форм unit_number (задача 6 плана,
    #     round 3/4 фикс, task-6-report.md): контролёр перепроверил числом —
    #     232 из 350 «нулевых» строк августа кабинета 1 на самом деле УЖЕ
    #     имеют продажу в начислениях, просто под СОСЕДНЕЙ формой сырого
    #     unit_number (логистика под базовой '0115022887-0449', commission
    #     под суффиксной '0115022887-0449-5' — ОДНО реальное отправление,
    #     разделённое Ozon'ом на два сырых unit_number). merge_unit_siblings
    #     — чистая функция без БД, склеивает ТАКИЕ пары ДО build_order_costs.
    from worker.collectors.ozon_order_costs import merge_unit_siblings, _family_key

    # 17a. _family_key — регрессия НАЙДЕННОЙ живой ошибки: слепое "срезать
    #     последний дефис всегда" (как в order_meta_by_base, чьи входы
    #     ГАРАНТИРОВАННО 3-частные — posting_number из tenant.ozon_orders)
    #     ошибочно схлопнуло бы РАЗНЫЕ отправления с общим числовым
    #     префиксом ('0229108520-0830' и '0229108520-0831' — два РАЗНЫХ
    #     заказа) в одну "семью". Правильно: строки с 1 дефисом (уже полная
    #     2-частная форма) — САМИ себе семья; только 2+ дефиса срезают
    #     последний сегмент (суффикс товара).
    check("_family_key: 2-частная форма (1 дефис) — сама себе ключ, НЕ срезается "
          "('0229108520-0830' остаётся собой)",
          _family_key("0229108520-0830") == "0229108520-0830", _family_key("0229108520-0830"))
    check("_family_key: РАЗНЫЕ отправления с общим префиксом НЕ считаются семьёй "
          "('0229108520-0830' != '0229108520-0831')",
          _family_key("0229108520-0830") != _family_key("0229108520-0831"))
    check("_family_key: 3-частная форма (2 дефиса) срезает суффикс товара -> "
          "совпадает с базовым братом ('0115022887-0449-5' -> '0115022887-0449')",
          _family_key("0115022887-0449-5") == "0115022887-0449")
    check("_family_key: суффиксный брат и его база — ОДНА семья",
          _family_key("0115022887-0449-5") == _family_key("0115022887-0449"))

    def _commission_row(unit, date_, accrued=300.0, seller_price=300.0):
        return {"unit_number": unit, "accrued_category": "POSTING", "type_id": None,
                "sku": 1, "accrued": accrued, "date": date_,
                "seller_price": seller_price, "sale_price": accrued, "sale_commission": 0.0,
                "coinvestment": 0.0, "bonus": 0.0}

    def _logistics_row(unit, date_, accrued=-12.12):
        return {"unit_number": unit, "accrued_category": "ITEM", "type_id": 1,
                "sku": 1, "accrued": accrued, "date": date_,
                "seller_price": None, "sale_price": None, "sale_commission": None,
                "coinvestment": None, "bonus": None}

    # 17b. «Одна база + один брат»: РОВНО один член семьи несёт commission —
    #     однозначно, склеивается. Направление А (живой пример round 3/4):
    #     логистика под базовой формой, commission под суффиксной.
    by_unit_pair = {
        "0115022887-0449": [_logistics_row("0115022887-0449", "2026-08-14")],
        "0115022887-0449-5": [_commission_row("0115022887-0449-5", "2026-08-14")],
    }
    merged_pair, stats_pair = merge_unit_siblings(by_unit_pair)
    check("склейка (17b): «база + один брат» — база пропала из результата "
          "(слита в суффиксную форму)",
          "0115022887-0449" not in merged_pair, merged_pair)
    check("склейка (17b): суффиксная форма (canonical, несёт commission) осталась и "
          "получила ОБЕ строки (логистика + commission)",
          "0115022887-0449-5" in merged_pair and len(merged_pair["0115022887-0449-5"]) == 2,
          merged_pair.get("0115022887-0449-5"))
    check("склейка (17b): stats.merged_units == [('0115022887-0449-5', ['0115022887-0449'])]",
          stats_pair["merged_units"] == [("0115022887-0449-5", ["0115022887-0449"])],
          stats_pair)
    check("склейка (17b): stats.ambiguous_families пуст", stats_pair["ambiguous_families"] == [],
          stats_pair)

    # 17b-symmetric. Направление Б: commission под БАЗОВОЙ формой, логистика
    #     под суффиксной — «подумай о симметрии» (round 3/4), canonical —
    #     ЛЮБОЙ член семьи с commission, независимо от того, base он или suffix.
    by_unit_pair_reverse = {
        "9998887770-0001": [_commission_row("9998887770-0001", "2026-08-15")],
        "9998887770-0001-2": [_logistics_row("9998887770-0001-2", "2026-08-15")],
    }
    merged_reverse, stats_reverse = merge_unit_siblings(by_unit_pair_reverse)
    check("склейка (17b-симметрия): commission под БАЗОВОЙ формой -> canonical = база, "
          "суффиксный брат слит в неё (не наоборот)",
          "9998887770-0001" in merged_reverse and len(merged_reverse["9998887770-0001"]) == 2
          and "9998887770-0001-2" not in merged_reverse, merged_reverse)

    # 17c. «Одна база + два брата» — ДВА члена семьи несут commission-блок ->
    #     неоднозначно (не решить, к какому относится остальная часть семьи
    #     без commission) — НЕ склеивается, попадает в ambiguous_families.
    by_unit_ambiguous = {
        "7776665550-0009": [_logistics_row("7776665550-0009", "2026-08-10")],
        "7776665550-0009-1": [_commission_row("7776665550-0009-1", "2026-08-10")],
        "7776665550-0009-2": [_commission_row("7776665550-0009-2", "2026-08-10", accrued=150.0,
                                               seller_price=150.0)],
    }
    merged_ambiguous, stats_ambiguous = merge_unit_siblings(by_unit_ambiguous)
    check("склейка (17c): «база + два брата с commission» — НЕОДНОЗНАЧНО, все 3 юнита "
          "остались независимыми (ничего не слито)",
          set(merged_ambiguous.keys()) == set(by_unit_ambiguous.keys()), merged_ambiguous)
    check("склейка (17c): stats.merged_units пуст (не склеено)",
          stats_ambiguous["merged_units"] == [], stats_ambiguous)
    check("склейка (17c): stats.ambiguous_families несёт семью '7776665550-0009' с "
          "обоими commission-братьями",
          stats_ambiguous["ambiguous_families"] ==
          [("7776665550-0009", ["7776665550-0009-1", "7776665550-0009-2"])]
          or stats_ambiguous["ambiguous_families"] ==
          [("7776665550-0009", ["7776665550-0009-2", "7776665550-0009-1"])],
          stats_ambiguous)

    # 17d. Семья есть, но НИ У КОГО нет commission-блока — сливать некуда,
    #     оба остаются независимыми (не ambiguous, не merged — «нейтральный»
    #     случай, каждый идёт своим путём — обычно порог зрелости).
    by_unit_no_commission = {
        "5554443330-0007": [_logistics_row("5554443330-0007", "2026-08-01")],
        "5554443330-0007-1": [_logistics_row("5554443330-0007-1", "2026-08-01", accrued=-5.0)],
    }
    merged_nc, stats_nc = merge_unit_siblings(by_unit_no_commission)
    check("склейка (17d): семья без единого commission-блока — не склеена, не помечена "
          "неоднозначной, оба юнита независимы",
          set(merged_nc.keys()) == set(by_unit_no_commission.keys())
          and stats_nc["merged_units"] == [] and stats_nc["ambiguous_families"] == [],
          (merged_nc, stats_nc))

    # 17e. Одиночный unit_number (семья из 1) — merge_unit_siblings не трогает.
    by_unit_single = {"LONE-0001": [_commission_row("LONE-0001", "2026-08-05")]}
    merged_single, stats_single = merge_unit_siblings(by_unit_single)
    check("склейка (17e): одиночный unit_number (семья из 1) не трогается",
          merged_single == by_unit_single and stats_single["merged_units"] == []
          and stats_single["ambiguous_families"] == [], (merged_single, stats_single))

    # --- 18. F1 (фикс-волна финального ревью 2026-08-18, .superpowers/sdd/
    #     2026-08-17-ozon-data-repair/): touched-юниты окна (по ЮНИТАМ) должны
    #     расширяться до ПОЛНЫХ семей (_family_key/merge_unit_siblings) ДО
    #     сборки history_rows/by_unit — иначе, если в окно попал ОДИН член
    #     семьи, merge_unit_siblings честно склеивает "семью" из одного, и
    #     пересборка ЗАТИРАЕТ ранее склеенную (полными деньгами обоих братьев)
    #     строку order_costs усечённой версией. Живой пример ревью:
    #     unit_number '0147423989-0115-1' (суффикс, в окне), база
    #     '0147423989-0115' — вне окна (старше 45-дневного lookback).
    from worker.collectors.ozon_order_costs import _expand_to_families

    # 18a. Чистая функция: широкий SQL-суперсет (LIKE-кандидаты по префиксу
    #     базы) содержит И настоящего брата, И ПОСТОРОННЕЕ отправление с
    #     общим числовым префиксом ('0147423989-0116' — другой заказ, НЕ
    #     семья, та же ловушка, что и _family_key #17a) — доклассификация в
    #     питоне обязана включить первого и исключить второго.
    touched_f1 = ["0147423989-0115-1"]
    candidates_f1 = ["0147423989-0115-1", "0147423989-0115", "0147423989-0116"]
    expanded_f1 = _expand_to_families(touched_f1, candidates_f1)
    check("F1 (18a): _expand_to_families включает настоящего брата вне окна "
          "('0147423989-0115', база) в touched",
          "0147423989-0115" in expanded_f1, expanded_f1)
    check("F1 (18a): _expand_to_families ИСКЛЮЧАЕТ постороннее отправление с общим "
          "числовым префиксом, но другим family_key ('0147423989-0116')",
          "0147423989-0116" not in expanded_f1, expanded_f1)
    check("F1 (18a): результат — РОВНО {суффикс, база}, без постороннего",
          expanded_f1 == sorted({"0147423989-0115-1", "0147423989-0115"}), expanded_f1)
    check("F1 (18b): пустой touched_unit_numbers -> пустой результат, не падает",
          _expand_to_families([], ["irrelevant-0001"]) == [], None)

    # 18c. Сквозной сценарий (ревью: «в окне один член семьи -> собраны
    #     оба»). Симулируем collect() руками: touched видит ТОЛЬКО суффиксную
    #     форму (окно), _expand_to_families тянет и базу, history (после
    #     расширения) несёт ОБЕ строки, merge_unit_siblings склеивает как
    #     обычно. Без фикса F1 by_unit нёс бы ТОЛЬКО суффикс (семья из 1) —
    #     логистика базы (−30 ₽) терялась бы молча.
    # ⚠️ Пре-существующий хелпер _logistics_row (17b) даёт type_id=1
    # (ITEM/Acquiring, см. classify_row/ACQUIRING_TYPE_IDS) — бакет
    # "acquiring", не "logistics" (имя хелпера — про роль в семье/повествование
    # теста 17, не про итоговую корзину). Здесь нужна ИМЕННО корзина
    # logistics, поэтому строка базы собрана явно с type_id=32 (POSTING/
    # Logistic, PER_ORDER_LOGISTICS_TYPE_IDS).
    def _real_logistics_row(unit, date_, accrued=-30.0):
        return {"unit_number": unit, "accrued_category": "POSTING", "type_id": 32,
                "sku": 1, "accrued": accrued, "date": date_,
                "seller_price": None, "sale_price": None, "sale_commission": None,
                "coinvestment": None, "bonus": None}

    family_rows_by_unit = {
        "0147423989-0115-1": [_commission_row("0147423989-0115-1", "2026-07-20",
                                                accrued=1500.0, seller_price=1500.0)],
        "0147423989-0115": [_real_logistics_row("0147423989-0115", "2026-06-30", accrued=-30.0)],
    }
    touched_narrow_f1 = ["0147423989-0115-1"]  # окно видит только суффикс
    expanded_narrow_f1 = _expand_to_families(touched_narrow_f1, list(family_rows_by_unit.keys()))
    merged_family_f1, stats_family_f1 = merge_unit_siblings(
        {u: family_rows_by_unit[u] for u in expanded_narrow_f1})
    check("F1 (18c): расширенный by_unit несёт ОБОИХ братьев ДО склейки (без фикса — "
          "только суффикс)",
          set(expanded_narrow_f1) == {"0147423989-0115-1", "0147423989-0115"}, expanded_narrow_f1)
    check("F1 (18c): merge_unit_siblings склеил базу в суффикс (canonical — "
          "commission-несущий)",
          stats_family_f1["merged_units"] == [("0147423989-0115-1", ["0147423989-0115"])],
          stats_family_f1)
    r_f1 = build_order_costs(merged_family_f1["0147423989-0115-1"],
                              {"product_id": 1, "qty": 1}, {}, today=MATURE_TODAY)
    check("F1 (18c): собранная строка несёт ЛОГИСТИКУ базы (30, не 0 — иначе деньги "
          "брата вне окна потеряны молча, живой пример ревью: comps 1581,03)",
          r_f1["logistics"] == 30.0, r_f1)
    check("F1 (18c): согласованность компонент == SUM(accrued обеих строк) (1500 − 30 = 1470)",
          abs((r_f1["cost_value_retail"] - r_f1["commission"] - r_f1["logistics"]
               - r_f1["acquiring"] - r_f1["loyalty"]) - 1470.0) <= 0.01, r_f1)

    # --- 19. F3 (та же фикс-волна): зрелость юнита БЕЗ commission-блока — по
    #     СТАТУСУ заказа Ozon (если резолвится), а не по возрасту операций.
    #     Живой симптом до фикса: 48 строк/−32 183 ₽ августа кабинета 1 со
    #     status delivering/awaiting_* «созревали» по возрасту операций
    #     задолго до реальной финализации Ozon.
    from worker.collectors.ozon_order_costs import IN_TRANSIT_ORDER_STATUSES

    old_rows_no_commission = [
        {"unit_number": "TEST-INTRANSIT-OLD-0001", "accrued_category": "ITEM", "type_id": 1,
         "sku": 1, "accrued": -10.0, "date": "2026-06-01",  # ДАВНО старше порога 3 дн.
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    for _status in ("delivering", "awaiting_packaging", "awaiting_deliver"):
        _r = build_order_costs(old_rows_no_commission,
                                {"product_id": 1, "qty": 1, "status": _status}, {}, today=MATURE_TODAY)
        check(f"F3 (19): статус заказа '{_status}' (в пути) -> immature=True БЕЗУСЛОВНО, "
              "несмотря на возраст операций далеко за порогом (регрессия старой "
              "чисто-возрастной логики, дающей фантомный убыток)",
              _r is not None and _r["immature"] is True, _r)

    # Заказ delivered без commission-блока (законный редкий случай, п.12) —
    # fallback на прежнюю возрастную логику: старый -> датирован как раньше.
    r_delivered_old = build_order_costs(old_rows_no_commission,
                                         {"product_id": 1, "qty": 1, "status": "delivered"},
                                         {}, today=MATURE_TODAY)
    check("F3 (19): статус 'delivered' -> fallback на возрастную логику, юнит старый -> "
          "immature=False, sale_dt проставлен",
          r_delivered_old["immature"] is False and r_delivered_old["sale_dt"] == "2026-06-01",
          r_delivered_old)

    # Заказ delivered, но СВЕЖИЙ (возраст меньше порога) — fallback на
    # возрастную логику даёт immature=True, как и раньше (F3 не отменяет
    # возрастной запас на свежедоставленные).
    fresh_delivered_rows = [
        {"unit_number": "TEST-DELIVERED-FRESH-0001", "accrued_category": "ITEM", "type_id": 1,
         "sku": 1, "accrued": -10.0, "date": "2026-08-16",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_delivered_fresh = build_order_costs(fresh_delivered_rows,
                                           {"product_id": 1, "qty": 1, "status": "delivered"},
                                           {}, today="2026-08-18")  # возраст 2 дн., младше порога
    check("F3 (19): статус 'delivered', но СВЕЖИЙ (возраст 2 дн. < порога) -> fallback "
          "на возрастную логику -> immature=True (F3 не отменяет возрастной запас на "
          "свежедоставленные)",
          r_delivered_fresh["immature"] is True, r_delivered_fresh)

    # Заказ НЕ резолвился (status отсутствует в meta) -> статус неизвестен ->
    # тот же fallback на возрастную логику, что и раньше (регресс: F3 не
    # требует резолва заказа).
    r_no_status = build_order_costs(old_rows_no_commission, {"product_id": 1, "qty": 1}, {},
                                     today=MATURE_TODAY)
    check("F3 (19): заказ НЕ резолвился (status отсутствует в meta) -> fallback на "
          "возрастную логику как раньше -> immature=False (юнит старый)",
          r_no_status["immature"] is False and r_no_status["sale_dt"] == "2026-06-01", r_no_status)

    # Возвратный юнит (45/59) со статусом «в пути» — статусная проверка
    # НЕПРИМЕНИМА, return-ветка безусловна (регрессия того же правила, что и
    # тест 16 для возрастного порога).
    r_return_intransit = build_order_costs(fresh_return_rows,
                                            {"product_id": 1, "qty": 1, "status": "delivering"},
                                            {}, today="2026-08-18")
    check("F3 (19): возвратный юнит со статусом 'delivering' — статусная проверка "
          "НЕПРИМЕНИМА (return-ветка безусловна), immature=False, return_dt проставлен",
          r_return_intransit["immature"] is False and r_return_intransit["is_return"] == 1
          and r_return_intransit["return_dt"] == "2026-08-17", r_return_intransit)

    check("F3 (19): IN_TRANSIT_ORDER_STATUSES содержит ровно три статуса Ozon "
          "(delivering, awaiting_packaging, awaiting_deliver)",
          IN_TRANSIT_ORDER_STATUSES == frozenset({"delivering", "awaiting_packaging", "awaiting_deliver"}),
          IN_TRANSIT_ORDER_STATUSES)

    # --- 20. ФИКС ФАНТОМНОГО COGS (находка владельца, заказ 09609165-0986-1,
    #     2026-08-21): cost списывается ТОЛЬКО при ФАКТИЧЕСКОЙ продаже
    #     (есть commission-блок) — юниты без единой продажи (отменённые/
    #     невыкупленные/чисто сервисные) НЕ должны терять себестоимость.
    #     Костс-мэп ниже сознательно НЕПУСТОЙ (999: 1540.0) — это ключевое
    #     отличие от прежних тестов (использовавших {}), где cost и раньше
    #     был None по совпадению отсутствия override, а не по признаку
    #     «продажи не было»: без этого различия регресс фикса был бы
    #     незаметен тесту.
    COGS_MAP_20 = {999: 1540.0}

    # 20a. Живой пример владельца: отменённый юнит, начисления сальдо ~0
    #     (эквайринг +30,51/−30,51, взаимно гасятся), БЕЗ commission-блока,
    #     is_return=0. ДО фикса: cost=1540 списывался всегда -> profit=−1540
    #     без всякой продажи. ПОСЛЕ фикса: cost=0, profit=0 (== sum_accrued).
    cancelled_rows = [
        {"unit_number": "TEST-CANCELLED-0001", "accrued_category": "ITEM", "type_id": 1,
         "sku": 1, "accrued": 30.51, "date": "2026-08-01",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
        {"unit_number": "TEST-CANCELLED-0001", "accrued_category": "ITEM", "type_id": 1,
         "sku": 1, "accrued": -30.51, "date": "2026-08-01",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_cancelled = build_order_costs(cancelled_rows, {"product_id": 999, "qty": 1}, COGS_MAP_20,
                                     today=MATURE_TODAY)
    check("фикс COGS (20a): отменённый юнит (нулевые начисления, без commission-блока) -> "
          "cost == 0.0 (не 1540, несмотря на cost_overrides)",
          r_cancelled is not None and r_cancelled["cost"] == 0.0, r_cancelled)
    check("фикс COGS (20a): отменённый юнит -> profit == 0.0 (== sum_accrued, было бы −1540)",
          r_cancelled is not None and r_cancelled["profit"] == 0.0, r_cancelled)

    # 20b. Сервисный юнит: без commission-блока, БЕЗ 45/59 (не возврат),
    #     ненулевые начисления (например, чистая логистическая корректировка
    #     без факта продажи). profit == SUM(accrued), БЕЗ вычета COGS.
    service_rows = [
        {"unit_number": "TEST-SERVICE-0001", "accrued_category": "POSTING", "type_id": 32,
         "sku": 1, "accrued": -45.0, "date": "2026-08-01",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_service = build_order_costs(service_rows, {"product_id": 999, "qty": 1}, COGS_MAP_20,
                                   today=MATURE_TODAY)
    check("фикс COGS (20b): сервисный юнит (без commission, не возврат) -> cost == 0.0",
          r_service is not None and r_service["cost"] == 0.0, r_service)
    check("фикс COGS (20b): сервисный юнит -> profit == SUM(accrued) (−45.0), БЕЗ COGS "
          "(было бы −45.0 − 1540 = −1585.0 до фикса)",
          r_service is not None and r_service["profit"] == -45.0, r_service)

    # 20c. Возврат БЕЗ commission-блока (невыкуп/отмена, оформленная Ozon как
    #     return-flow типы 45/59, но продажи в истории юнита не было) — тот
    #     же класс, что 20a/20b: cost == 0.0 (уже неявно проверялось п.12
    #     через r2/r_nodate_ret с пустым costs-мэпом — здесь ЯВНО с непустым).
    return_no_commission_rows = [
        {"unit_number": "TEST-RETURN-NOCOMM-0001", "accrued_category": "POSTING", "type_id": 45,
         "sku": 1, "accrued": -20.0, "date": "2026-08-01",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_return_nocomm = build_order_costs(return_no_commission_rows, {"product_id": 999, "qty": 1},
                                         COGS_MAP_20, today=MATURE_TODAY)
    check("фикс COGS (20c): возврат БЕЗ commission-блока (невыкуп/отмена как return-flow) -> "
          "is_return == 1, cost == 0.0 (продажи не было — списывать нечего)",
          r_return_nocomm is not None and r_return_nocomm["is_return"] == 1
          and r_return_nocomm["cost"] == 0.0, r_return_nocomm)

    # 20d. Возврат С commission-блоком (реальная продажа БЫЛА, товар потом
    #     вернулся — is_return=1 через отрицательный commission-блок,
    #     реверс уже начисленной продажи). ПОЛИТИКА ВЛАДЕЛЬЦА 2026-08-21
    #     (расширение фикса 20a-c, см. докстроку build_order_costs у секции
    #     «ВОЗВРАТЫ», дословная цитата: «В возвратах должна учитываться
    #     только расходка на них, себестоимость не учитывается, потому что
    #     часть из них идут заново в продажу») — ПЕРЕСМОТРЕНО относительно
    #     прежнего теста (был: cost НЕ зануляется, сверено с v1/WB/каноном):
    #     cost == 0.0 ТЕПЕРЬ И ЗДЕСЬ, profit == sum_accrued (только расходка
    #     возврата, COGS не участвует).
    return_with_commission_rows = [
        {"unit_number": "TEST-RETURN-COMM-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 1, "accrued": -700.0, "date": "2026-08-01",
         "seller_price": 1000.0, "sale_price": -700.0, "sale_commission": 300.0,
         "coinvestment": 0.0, "bonus": -300.0},
    ]
    r_return_comm = build_order_costs(return_with_commission_rows, {"product_id": 999, "qty": 1},
                                       COGS_MAP_20, today=MATURE_TODAY)
    check("фикс COGS (20d): возврат С commission-блоком (реверс продажи, commission_accrued<0) "
          "-> is_return == 1", r_return_comm is not None and r_return_comm["is_return"] == 1,
          r_return_comm)
    check("фикс COGS (20d, политика владельца 2026-08-21): возврат С commission-блоком -> "
          "cost == 0.0 (ЗАНУЛЯЕТСЯ — было 1540 ДО политики возвратного COGS, товар может "
          "уйти в повторную продажу)",
          r_return_comm is not None and r_return_comm["cost"] == 0.0, r_return_comm)
    check("фикс COGS (20d, политика владельца 2026-08-21): возврат С commission-блоком -> "
          "profit == sum_accrued (-700.0, только расходка возврата, COGS не вычитается)",
          r_return_comm is not None and r_return_comm["profit"] == -700.0, r_return_comm)

    # 20e. Регресс: продающий юнит (sale_unit, п.1) — cost как был (300, из
    #     costs-мэпа теста 1), поведение с commission-блоком не изменилось.
    check("фикс COGS (20e регресс): продающий юнит (commission-блок есть) -> cost == 300.0 "
          "как раньше (без изменений)",
          r1["cost"] == 300.0, r1)
    check("фикс COGS (20e регресс): продающий юнит -> profit == SUM(accrued) − cost, как раньше",
          r1["profit"] == expected_profit, r1["profit"])

    # --- 21. Политика возвратного COGS (решение владельца 2026-08-21,
    #     прямое продолжение фикса 20, задача «возвраты без списания COGS»):
    #     возвратный юнит с commission-блоком И ОТДЕЛЬНОЙ строкой расходки
    #     возврата (логистика/комиссия ВОЗВРАТА, отдельная POSTING-строка,
    #     не сам commission-блок) — profit должен нести ИМЕННО эту расходку,
    #     а не «0 минус COGS». Показывает, что «cost=0» не означает
    #     «profit=0» — возврат остаётся видимым убытком РОВНО на сумму
    #     фактических затрат на сам возврат, без фантомной себестоимости
    #     сверху.
    # commission-строка сделана САМОСОГЛАСОВАННОЙ под тождество компонент
    # (sale_commission == accrued этой строки, т.к. cost_value_retail
    # принудительно 0 при is_return=1 — seller_price/sale_price/bonus сюда
    # не входят вовсе; ⚠️ фикстура 20d/21 (return_with_commission_rows) этому
    # тождеству НЕ следует (унаследована из ДО-политики теста, где
    # consistency_ok не проверялся) — здесь взяты независимые, согласованные
    # числа именно ради проверки инварианта согласованности).
    return_with_logistics_rows = [
        {"unit_number": "TEST-RETURN-LOGISTICS-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 1, "accrued": -700.0, "date": "2026-08-01",
         "seller_price": 1000.0, "sale_price": -700.0, "sale_commission": -700.0,
         "coinvestment": 0.0, "bonus": -300.0},
        # Расходка возврата: отдельная логистическая строка (доставка товара
        # обратно на склад) — реальные деньги, которые ДОЛЖНЫ остаться в
        # profit (это и есть «расходка на возврат» из цитаты владельца).
        {"unit_number": "TEST-RETURN-LOGISTICS-0001", "accrued_category": "POSTING", "type_id": 32,
         "sku": 1, "accrued": -85.30, "date": "2026-08-03",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    r_return_log = build_order_costs(return_with_logistics_rows, {"product_id": 999, "qty": 1},
                                      COGS_MAP_20, today=MATURE_TODAY)
    check("политика возвратного COGS (21a): возврат с commission-блоком + расходка возврата "
          "(логистика -85.30) -> is_return == 1",
          r_return_log is not None and r_return_log["is_return"] == 1, r_return_log)
    check("политика возвратного COGS (21a): cost == 0.0 (COGS не учитывается)",
          r_return_log is not None and r_return_log["cost"] == 0.0, r_return_log)
    check("политика возвратного COGS (21a): profit == sum_accrued (-785.30 = -700 реверс "
          "+ -85.30 расходка возврата) — РАСХОДКА на возврат остаётся в profit, COGS — нет",
          r_return_log is not None and r_return_log["profit"] == -785.30, r_return_log)
    check("политика возвратного COGS (21a): согласованность компонент == SUM(accrued)",
          abs(comps_of(r_return_log) - sum_accrued(return_with_logistics_rows)) < 0.01,
          (comps_of(r_return_log), sum_accrued(return_with_logistics_rows)))

    # --- 21b. Симуляция предиката LATERAL app/api/cabinets/[id]/orders/route.js
    #     (`oc.cost IS DISTINCT FROM 0`, фикс a817f97) — та же защита от
    #     "воскрешения" фантомного cost на новом классе строк (возврат С
    #     commission-блоком), не только на прежнем (юнит без продажи). Без БД,
    #     чистая имитация предиката ради теста (тот же приём, что
    #     _simulate_order_costs_delete в проверке 11e).
    def _simulate_orders_lateral_cost(oc_cost, cost_overrides_cost):
        """Возвращает итоговый cost, который увидела бы витрина /orders:
        предикат LATERAL — `oc.cost IS DISTINCT FROM 0` (a817f97). SQL
        IS DISTINCT FROM трактует NULL как обычное сравниваемое значение —
        NULL IS DISTINCT FROM 0 == true (LATERAL СРАБАТЫВАЕТ: cost неизвестен,
        не «списывать нечего»), 0 IS DISTINCT FROM 0 == false (LATERAL
        ПРОПУСКАЕТСЯ: cost явно занулён сборщиком). Итог витрины —
        COALESCE(co.cost, oc.cost) — co.cost, если LATERAL сработала и нашла
        override, иначе oc.cost как есть."""
        lateral_fires = (oc_cost is None) or (oc_cost != 0)
        co_cost = cost_overrides_cost if lateral_fires else None
        return co_cost if co_cost is not None else oc_cost

    # Возврат с commission-блоком под НОВОЙ политикой -> сборщик пишет
    # oc.cost=0.0 явно -> LATERAL обязана быть пропущена -> витрина видит 0,
    # а НЕ переоткрытый cost_overrides (1540) — иначе фикс сборщика
    # "воскрешался" бы той же LATERAL, что уже чинили в a817f97 для
    # юнитов без продажи.
    witness_cost = _simulate_orders_lateral_cost(oc_cost=r_return_comm["cost"], cost_overrides_cost=1540.0)
    check("политика возвратного COGS (21b): витрина /orders (LATERAL, a817f97) НЕ "
          "воскрешает COGS у возвратного юнита с cost=0 (тот же механизм, что уже "
          "защищает юниты без продажи) — витрина видит 0.0, не 1540.0",
          witness_cost == 0.0, witness_cost)
    # Контроль: юнит с NULL cost (сборщик не резолвил cost_overrides вовсе,
    # а НЕ «списывать нечего») — LATERAL по-прежнему ДОЛЖНА сработать
    # (регресс-проверка, что симуляция не сломала штатный путь a817f97).
    witness_null = _simulate_orders_lateral_cost(oc_cost=None, cost_overrides_cost=1540.0)
    check("политика возвратного COGS (21b, регресс a817f97): oc.cost IS NULL (cost "
          "неизвестен, не 'списывать нечего') -> LATERAL по-прежнему подставляет "
          "cost_overrides (1540.0)", witness_null == 1540.0, witness_null)

    # --- 21c. Регрессия: продающий юнит БЕЗ возврата (r1, п.1) — cost как
    #     был, политика возвратного COGS его не касается (is_return=0).
    check("политика возвратного COGS (21c регресс): продающий юнит (is_return=0) -> "
          "cost == 300.0, не затронут политикой возвратов", r1["cost"] == 300.0, r1)
    # --- 21d. Регрессия: отменённый юнит без продажи (20a) — cost как был
    #     (уже 0.0 через has_sale=False независимо от is_return — этот класс
    #     is_return=0, политика возвратов на него физически не влияет).
    check("политика возвратного COGS (21d регресс): отменённый юнит без продажи "
          "(is_return=0, фикс 20a) -> cost == 0.0, как раньше",
          r_cancelled is not None and r_cancelled["cost"] == 0.0, r_cancelled)

    # --- 22. ВОЗВРАТ ЧЕРЕЗ ПОЛНОЕ СТОРНО (находка владельца, заказ
    #     0131642813-0453-1, 2026-08-21): >1 commission-блока, чистая Σ
    #     seller_price ≈ 0 (допуск 0,01) при наличии отрицательного блока ->
    #     is_return=1 (см. is_return в build_order_costs, третья ветка).
    #     Контролёр (saas_ro): 20 строк / 12 485 ₽ кабинета 1 попадали под
    #     этот класс (>1 commission-блока, |Σ seller_price| < 0,01,
    #     is_return=0, cost>0) — cost списывался вопреки политике владельца
    #     («cost=0 на возврате», 5a3221d), потому что ни первая ветка (коды
    #     45/59 среди строк юнита), ни вторая (commission_accrued_sum < 0,
    #     строго отрицательный итог) не ловят блоки, которые гасят друг
    #     друга РОВНО в ноль, а не уходят в минус.

    # 22a. Эталонный кейс (буквально из находки владельца, числа сведены):
    #     10.08 commission-блок seller_price=+1378 (продажа), 17.08 второй
    #     commission-блок seller_price=-1378 (полное сторно) — sale_commission
    #     обнулена в обоих блоках (фикстура ради простоты не моделирует
    #     отдельно комиссию/её реверс, только сумму реализации, как в
    #     формулировке владельца) + возвратные сборы ITEM 38 (PackageCost)/
    #     39 (PackingFee) — bucket 'logistics' (НЕ RETURN_TYPE_IDS={45,59}),
    #     поэтому return_dates остаётся пуст, ветка 1 не срабатывает; сумма
    #     commission-блоков (0) не строго отрицательна — ветка 2 тоже не
    #     срабатывает. cost_overrides=730 (как у владельца) — ДО фикса
    #     profit = -127.28 (sum_accrued) - 730 = -857.28; ПОСЛЕ — cost=0,
    #     profit = -127.28.
    full_storno_rows = [
        {"unit_number": "0131642813-0453-1", "accrued_category": "POSTING", "type_id": None,
         "sku": 1, "accrued": 1378.0, "date": "2026-08-10",
         "seller_price": 1378.0, "sale_price": 1378.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
        {"unit_number": "0131642813-0453-1", "accrued_category": "POSTING", "type_id": None,
         "sku": 1, "accrued": -1378.0, "date": "2026-08-17",
         "seller_price": -1378.0, "sale_price": -1378.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
        {"unit_number": "0131642813-0453-1", "accrued_category": "ITEM", "type_id": 38,
         "sku": 1, "accrued": -100.00, "date": "2026-08-17",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
        {"unit_number": "0131642813-0453-1", "accrued_category": "ITEM", "type_id": 39,
         "sku": 1, "accrued": -27.28, "date": "2026-08-17",
         "seller_price": None, "sale_price": None, "sale_commission": None,
         "coinvestment": None, "bonus": None},
    ]
    COGS_MAP_22 = {42: 730.0}
    r_full_storno = build_order_costs(full_storno_rows, {"product_id": 42, "qty": 1},
                                       COGS_MAP_22, today=MATURE_TODAY)
    check("полное сторно (22a, эталон 0131642813-0453-1): 2 commission-блока, "
          "Σ seller_price == 0 -> is_return == 1",
          r_full_storno is not None and r_full_storno["is_return"] == 1, r_full_storno)
    check("полное сторно (22a): cost == 0.0 (COGS не списывается, было бы 730)",
          r_full_storno is not None and r_full_storno["cost"] == 0.0, r_full_storno)
    check("полное сторно (22a): profit == sum_accrued (-127.28 = 1378 - 1378 - 100 - 27.28), "
          "было бы -857.28 (-127.28 - 730) до фикса",
          r_full_storno is not None and r_full_storno["profit"] == -127.28, r_full_storno)
    check("полное сторно (22a): согласованность компонент == SUM(accrued) (допуск 0,01)",
          r_full_storno is not None
          and abs(comps_of(r_full_storno) - sum_accrued(full_storno_rows)) < 0.01,
          (comps_of(r_full_storno) if r_full_storno else None, sum_accrued(full_storno_rows)))

    # 22b. Частичное сторно/корректировка цены (НЕ путать с полным сторно):
    #     блоки +1378 / -400 -> Σ seller_price = 978 (не ≈ 0) -> остаётся
    #     продажей, cost списывается как обычно.
    partial_storno_rows = [
        {"unit_number": "TEST-PARTIAL-STORNO-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 1, "accrued": 1378.0, "date": "2026-08-10",
         "seller_price": 1378.0, "sale_price": 1378.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
        {"unit_number": "TEST-PARTIAL-STORNO-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 1, "accrued": -400.0, "date": "2026-08-17",
         "seller_price": -400.0, "sale_price": -400.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
    ]
    r_partial_storno = build_order_costs(partial_storno_rows, {"product_id": 999, "qty": 1},
                                          COGS_MAP_20, today=MATURE_TODAY)
    check("частичное сторно (22b регресс): 2 commission-блока, Σ seller_price == 978 "
          "(не ≈ 0) -> is_return == 0 (остаётся продажей)",
          r_partial_storno is not None and r_partial_storno["is_return"] == 0, r_partial_storno)
    check("частичное сторно (22b регресс): cost_value_retail == 978.0 (Σ seller_price)",
          r_partial_storno is not None and r_partial_storno["cost_value_retail"] == 978.0,
          r_partial_storno)
    check("частичное сторно (22b регресс): cost == 1540.0 (COGS списывается как на продаже)",
          r_partial_storno is not None and r_partial_storno["cost"] == 1540.0, r_partial_storno)
    check("частичное сторно (22b регресс): profit == sum_accrued - cost (978 - 1540 = -562.0)",
          r_partial_storno is not None and r_partial_storno["profit"] == -562.0, r_partial_storno)

    # 22c. Легитимные множественные commission-блоки склеенной семьи с
    #     net > 0 (мультитоварное отправление, тот же класс, что тест 8) —
    #     не должно путаться с полным сторно: Σ seller_price = 1500 (не ≈ 0)
    #     -> is_return остаётся 0.
    glued_family_rows = [
        {"unit_number": "TEST-GLUED-FAMILY-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 1, "accrued": 800.0, "date": "2026-08-10",
         "seller_price": 800.0, "sale_price": 800.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
        {"unit_number": "TEST-GLUED-FAMILY-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 2, "accrued": 700.0, "date": "2026-08-10",
         "seller_price": 700.0, "sale_price": 700.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
    ]
    r_glued_family = build_order_costs(glued_family_rows, {"product_id": 999, "qty": 2},
                                        COGS_MAP_20, today=MATURE_TODAY)
    check("склеенная семья, net > 0 (22c регресс): 2 commission-блока (разные sku), "
          "Σ seller_price == 1500 (не ≈ 0) -> is_return == 0",
          r_glued_family is not None and r_glued_family["is_return"] == 0, r_glued_family)
    check("склеенная семья, net > 0 (22c регресс): cost == 1540.0 (продажа, COGS списывается)",
          r_glued_family is not None and r_glued_family["cost"] == 1540.0, r_glued_family)

    # 22d. Регресс: правило 45/59 (return_dates, ветка 1) не затронуто новой
    #     веткой — юнит 2 (r2, п.2) по-прежнему is_return=1 через коды 45/59,
    #     а не через новую ветку (у него всего 1 commission-блок, новая
    #     ветка физически не может сработать — len(commission_rows) > 1
    #     обязателен).
    check("регресс 45/59 (22d): возвратное отправление (r2, п.2) по-прежнему is_return == 1 "
          "через RETURN_TYPE_IDS, не через новую ветку", r2["is_return"] == 1, r2)
    # 22e. Регресс: правило «отрицательный единственный commission-блок»
    #     (ветка 2, commission_accrued_sum < 0) не затронуто — юнит 20d
    #     (1 commission-блок, отрицательный) по-прежнему is_return=1 через
    #     ветку 2 (новая ветка требует len(commission_rows) > 1).
    check("регресс отрицательного единственного блока (22e): возврат с 1 commission-блоком "
          "(20d, r_return_comm) по-прежнему is_return == 1 через ветку 2",
          r_return_comm["is_return"] == 1, r_return_comm)

    # --- 23. ВЕТКА-3 ВОЗВРАТА — NET ПО КАЖДОМУ SKU (пробел ревью фикса 22,
    #     найден ДО прода, 2026-08-21): в мультитоварном отправлении Σ
    #     seller_price ВСЕГО юнита (22a-22c мерили её ПО ВСЕМ commission-
    #     блокам разом, независимо от sku) могла СЛУЧАЙНО попасть в допуск
    #     ±0.01, даже если РЕАЛЬНО возвращён только ОДИН sku, а другой
    #     остался продан — старое условие пометило бы is_return=1 ВЕСЬ юнит
    #     и обнулило бы COGS проданного sku. Фикс: full_storno_all_skus
    #     группирует commission_rows по sku и требует, чтобы У КАЖДОГО sku
    #     ЕГО СОБСТВЕННАЯ Σ seller_price была ≈0 (допуск) И несла
    #     отрицательный блок — если хотя бы у одного sku net не ≈0, юнит
    #     остаётся продажей.
    COGS_MAP_23 = {777: 500.0}

    # 23a. Кейс ревью: 2 sku, sku 1001 продан (+1000, НЕ возвращён, ни
    #     одного отрицательного блока), sku 1002 возвращён (-1000,
    #     отдельный sku, единственный его блок отрицателен) — Σ ВСЕГО
    #     юнита == 0 (совпадение цен), но у sku 1001 net == 1000 (не ≈0) ->
    #     full_storno_all_skus == False -> is_return ДОЛЖЕН остаться 0.
    mixed_sku_rows = [
        {"unit_number": "TEST-MIXED-SKU-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 1001, "accrued": 1000.0, "date": "2026-08-10",
         "seller_price": 1000.0, "sale_price": 1000.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
        {"unit_number": "TEST-MIXED-SKU-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 1002, "accrued": -1000.0, "date": "2026-08-10",
         "seller_price": -1000.0, "sale_price": -1000.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
    ]
    r_mixed_sku = build_order_costs(mixed_sku_rows, {"product_id": 777, "qty": 2},
                                     COGS_MAP_23, today=MATURE_TODAY)
    check("ветка-3 net по sku (23a, пробел ревью): sku 1001 продан (+1000), sku 1002 "
          "возвращён (-1000) -> Σ ЮНИТА == 0, но у sku 1001 net != 0 -> is_return == 0 "
          "(НЕ весь юнит полное сторно)",
          r_mixed_sku is not None and r_mixed_sku["is_return"] == 0, r_mixed_sku)
    check("ветка-3 net по sku (23a): cost == 500.0 (COGS проданного sku НЕ обнуляется "
          "ошибочно политикой возврата)",
          r_mixed_sku is not None and r_mixed_sku["cost"] == 500.0, r_mixed_sku)

    # 23b. Регресс: ГЕНУИННЫЙ мультитоварный полный возврат — ОБА sku
    #     (a: +500/-500, b: +300/-300) имеют net == 0 СО своим отрицательным
    #     блоком -> full_storno_all_skus == True -> is_return == 1, cost == 0
    #     (фикс 23 не должен сломать сам класс 22a на мультитоварных
    #     отправлениях).
    both_skus_returned_rows = [
        {"unit_number": "TEST-BOTH-SKU-RETURNED-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 2001, "accrued": 500.0, "date": "2026-08-10",
         "seller_price": 500.0, "sale_price": 500.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
        {"unit_number": "TEST-BOTH-SKU-RETURNED-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 2001, "accrued": -500.0, "date": "2026-08-17",
         "seller_price": -500.0, "sale_price": -500.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
        {"unit_number": "TEST-BOTH-SKU-RETURNED-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 2002, "accrued": 300.0, "date": "2026-08-10",
         "seller_price": 300.0, "sale_price": 300.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
        {"unit_number": "TEST-BOTH-SKU-RETURNED-0001", "accrued_category": "POSTING", "type_id": None,
         "sku": 2002, "accrued": -300.0, "date": "2026-08-17",
         "seller_price": -300.0, "sale_price": -300.0, "sale_commission": 0.0,
         "coinvestment": 0.0, "bonus": 0.0},
    ]
    r_both_skus_returned = build_order_costs(both_skus_returned_rows, {"product_id": 777, "qty": 2},
                                              COGS_MAP_23, today=MATURE_TODAY)
    check("ветка-3 net по sku (23b регресс): ОБА sku полностью возвращены (каждый net == 0 "
          "со своим отрицательным блоком) -> is_return == 1 (класс 22a на мультитоварных "
          "отправлениях не сломан)",
          r_both_skus_returned is not None and r_both_skus_returned["is_return"] == 1,
          r_both_skus_returned)
    check("ветка-3 net по sku (23b регресс): cost == 0.0 (COGS не списывается)",
          r_both_skus_returned is not None and r_both_skus_returned["cost"] == 0.0,
          r_both_skus_returned)

    # 23c. Регресс: секция 22a (эталон, ОДИН sku) должна остаться зелёной —
    #     commission_by_sku из одного sku ведёт себя тождественно старой
    #     проверке по сумме юнита.
    check("ветка-3 net по sku (23c регресс): эталон 0131642813-0453-1 (22a, один sku) "
          "по-прежнему is_return == 1 (группировка по sku не ломает однотоварный случай)",
          r_full_storno["is_return"] == 1, r_full_storno)

    print()
    if failed:
        print(f"ИТОГО: {failed} провалено")
        sys.exit(1)
    print("ИТОГО: все проверки пройдены")


if __name__ == "__main__":
    main()
