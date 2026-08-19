#!/usr/bin/env python3
"""
check-ozon-orders-window.py — проверка вычисления окна сбора ozon_orders
(задача «Размораживание статусов ozon_orders»,
.superpowers/sdd/2026-08-18-orders-vitrina/).

Без БД и без сети: проверяет только worker.collectors.ozon_accruals.resolve_window
с cap_to_yesterday=False — именно так его вызывает worker/collectors/ozon_orders.py.
Отличие от плановой проверки resolve_window() в check-ozon-accruals-parse.py (там
cap_to_yesterday=True, конец окна — вчера): у заказов конец окна — СЕГОДНЯ, статус
сегодняшнего отправления нужен сразу.

Проверяет:
  1. Узкое плановое окно −2..сегодня расширяется до пола MIN_LOOKBACK_DAYS=45
     (корень бага: без расширения отправление старше 2 дней никогда не
     переспрашивается, status замерзает навсегда — 497 строк на живой БД).
  2. Явный широкий бэкфилл (90 дней) не сужается.
  3. Конец окна — СЕГОДНЯ (не вчера, в отличие от resolve_window по умолчанию).
  4. Явный date_to из будущего зажимается до сегодня (не до вчера).
  5. Дефолтное поведение (cap_to_yesterday=True, начисления/order_costs) не
     задето параметризацией — регресс-щит.

Запуск: python3 scripts/check-ozon-orders-window.py
"""
import os
import sys
from datetime import date as _date, timedelta as _timedelta

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

failed = 0


def check(name, cond, got=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {got}"))
    if not cond:
        failed += 1


def main():
    try:
        from worker.collectors.ozon_accruals import resolve_window, MIN_LOOKBACK_DAYS
    except ImportError as e:
        print(f"FAIL  модуль worker.collectors.ozon_accruals не импортируется: {e}")
        sys.exit(1)

    try:
        import worker.collectors.ozon_orders as ozon_orders
    except ImportError as e:
        print(f"FAIL  модуль worker.collectors.ozon_orders не импортируется: {e}")
        sys.exit(1)

    # Не `is` — sys.path-трюк коллекторов (каждый модуль сам добавляет свою
    # директорию в sys.path) даёт ДВА разных объекта модуля ozon_accruals
    # (top-level "ozon_accruals" и "worker.collectors.ozon_accruals"), поэтому
    # у функции, физически импортированной из ОДНОГО и того же файла, будут
    # разные id. Byte-код — надёжный признак "это тот же исходник, не копипаста".
    oo_resolve_window = getattr(ozon_orders, "resolve_window", None)
    check("ozon_orders.py использует resolve_window из ozon_accruals (не копипаста)",
          oo_resolve_window is not None
          and oo_resolve_window.__code__.co_code == resolve_window.__code__.co_code)

    TODAY = _date(2026, 8, 19)

    # --- 1. Узкое плановое окно −2..сегодня (run_saas_collect.sh: DAYS_FROM=2,
    #        DAYS_TO=0) должно расшириться до пола 45 дней — это и есть починка
    #        корня бага (497 замёрзших строк).
    d_from, d_to = resolve_window("2026-08-17", "2026-08-19", today=TODAY,
                                   cap_to_yesterday=False)
    check("узкое окно(план): конец = СЕГОДНЯ (не вчера)", d_to == TODAY, d_to)
    check("узкое окно(план): начало раздвинуто до пола 45 дней от сегодня",
          d_from == TODAY - _timedelta(days=MIN_LOOKBACK_DAYS), d_from)

    # --- 2. Явный широкий бэкфилл (90 дней, шире пола 45) не сужается —
    #        именно такой бэкфилл нужен для добивки 497 замороженных строк.
    d_from, d_to = resolve_window("2026-05-21", "2026-08-19", today=TODAY,
                                   cap_to_yesterday=False)
    check("бэкфилл(90д): диапазон не сужен",
          d_from == _date(2026, 5, 21) and d_to == TODAY, (d_from, d_to))

    # --- 3. Без явных аргументов — конец окна тоже сегодня (не вчера, как у
    #        resolve_window по умолчанию).
    d_from, d_to = resolve_window(None, None, today=TODAY, cap_to_yesterday=False)
    check("без аргументов: конец = сегодня", d_to == TODAY, d_to)
    check("без аргументов: начало раздвинуто на 45 дней от сегодня",
          d_from == TODAY - _timedelta(days=MIN_LOOKBACK_DAYS), d_from)

    # --- 4. date_to из будущего зажимается до СЕГОДНЯ, не до вчера.
    d_from, d_to = resolve_window("2026-08-10", "2026-09-01", today=TODAY,
                                   cap_to_yesterday=False)
    check("date_to из будущего зажат до сегодня (не до вчера)", d_to == TODAY, d_to)

    # --- 5. Регресс-щит: дефолт (cap_to_yesterday=True — начисления/order_costs)
    #        не задет параметризацией.
    YESTERDAY = TODAY - _timedelta(days=1)
    d_from, d_to = resolve_window("2026-08-17", "2026-08-19", today=TODAY)
    check("регресс: cap_to_yesterday по умолчанию True — конец вчера",
          d_to == YESTERDAY, d_to)

    print()
    if failed:
        print(f"ИТОГО: {failed} провалено")
        sys.exit(1)
    print("ИТОГО: все проверки пройдены")


if __name__ == "__main__":
    main()
