#!/usr/bin/env python3
"""
check-ozon-profit-map.py — проверка классификатора типов начислений Ozon
(задача 1 плана «переезд финансов Ozon на источник начислений»,
docs/superpowers/specs/2026-08-15-ozon-profit-switch-design.md).

Без БД и без сети (по умолчанию): чистая функция
worker.collectors.ozon_profit_map.classify_row на фикстуре
scripts/fixtures/ozon-accruals/accrual-by-day-2026-08-05-cab1.json (по
образцу scripts/check-ozon-accruals-parse.py).

Проверяет:
  1. Каждая строка каждой записи фикстуры получает ровно одну корзину
     (валидную, без исключений).
  2. POSTING type_id IS NULL -> корзина 'commission'.
  3. ITEM type_id=1 -> корзина 'acquiring'.
  4. NON_ITEM с type_id из перечня продвижения -> 'promo', прочие
     NON_ITEM -> 'cabinet'.
  5. Незнакомый выдуманный type_id (999999): позаказный -> 'logistics'
     (known=False); кабинетный -> 'cabinet' (known=False).
  6. RETURN_TYPE_IDS == {45, 59}.
  7. Все реальные (известные) сочетания из фикстуры классифицируются с
     known=True — в модуле не осталось незаполненных перечней.

Режим --live: подключается к боевой БД через psycopg (v3 — тот же драйвер,
что worker/db_pg.py; НЕ psycopg2) с кредами из окружения воркера (см.
запуск ниже) и проверяет, что КАЖДОЕ фактически встречающееся сочетание
(accrued_category, type_id) за всю историю tenant.ozon_accruals
классифицируется с known=True. Только чтение (SELECT), ничего не пишет.

Запуск:
  /opt/agents/data-presenter-agent/.venv/bin/python scripts/check-ozon-profit-map.py
  /opt/agents/data-presenter-agent/.venv/bin/python scripts/check-ozon-profit-map.py --live
"""
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

FIXTURE_DIR = os.path.join(REPO_ROOT, "scripts", "fixtures", "ozon-accruals")
ACCRUALS_FIXTURE = os.path.join(FIXTURE_DIR, "accrual-by-day-2026-08-05-cab1.json")

VALID_BUCKETS = {"commission", "logistics", "acquiring", "loyalty", "cabinet", "promo"}

failed = 0


def check(name, cond, got=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {got}"))
    if not cond:
        failed += 1


def run_fixture_checks():
    global failed

    if not os.path.exists(ACCRUALS_FIXTURE):
        print(f"FAIL  фикстура не найдена: {ACCRUALS_FIXTURE}")
        sys.exit(1)

    try:
        from worker.collectors.ozon_profit_map import (
            classify_row, RETURN_TYPE_IDS, ACQUIRING_TYPE_IDS, LOYALTY_TYPE_IDS,
            NONITEM_PROMO_TYPE_IDS, PER_ORDER_LOGISTICS_TYPE_IDS, KNOWN_CABINET_TYPE_IDS)
    except ImportError as e:
        print(f"FAIL  модуль worker.collectors.ozon_profit_map не импортируется: {e}")
        sys.exit(1)

    try:
        from worker.collectors.ozon_accruals import parse_accrual
    except ImportError as e:
        print(f"FAIL  модуль worker.collectors.ozon_accruals не импортируется: {e}")
        sys.exit(1)

    # Модуль не должен содержать placeholder-множеств (брифовые "..." из
    # шаблона плана) — если кто-то забыл их заполнить, sets всё равно
    # существуют (Python бы упал на SyntaxError раньше), поэтому проверяем
    # содержательно: перечни непусты там, где по брифу они не могут быть
    # пустыми (loyalty — единственный, кому разрешено остаться пустым).
    check("ACQUIRING_TYPE_IDS = {1}", ACQUIRING_TYPE_IDS == {1}, ACQUIRING_TYPE_IDS)
    check("RETURN_TYPE_IDS = {45, 59}", RETURN_TYPE_IDS == {45, 59}, RETURN_TYPE_IDS)
    check("NONITEM_PROMO_TYPE_IDS непуст", len(NONITEM_PROMO_TYPE_IDS) > 0,
          NONITEM_PROMO_TYPE_IDS)
    check("PER_ORDER_LOGISTICS_TYPE_IDS непуст", len(PER_ORDER_LOGISTICS_TYPE_IDS) > 0,
          PER_ORDER_LOGISTICS_TYPE_IDS)
    check("KNOWN_CABINET_TYPE_IDS непуст", len(KNOWN_CABINET_TYPE_IDS) > 0,
          KNOWN_CABINET_TYPE_IDS)
    check("LOYALTY_TYPE_IDS — множество (может быть пустым по брифу)",
          isinstance(LOYALTY_TYPE_IDS, set), LOYALTY_TYPE_IDS)

    with open(ACCRUALS_FIXTURE, encoding="utf-8") as f:
        fixture = json.load(f)
    accruals = fixture["accruals"]
    check("фикстура содержит 79 записей", len(accruals) == 79, len(accruals))

    # --- 1. Каждая строка каждой записи получает ровно одну валидную
    #        корзину, без исключений (parse_accrual + classify_row на всех
    #        79 записях).
    all_rows_ok = True
    n_rows_total = 0
    unknown_seen = []
    for a in accruals:
        rows = parse_accrual(a)
        for r in rows:
            n_rows_total += 1
            has_unit = r["unit_number"] is not None
            try:
                bucket, known = classify_row(a["accrued_category"], r["type_id"], has_unit)
            except Exception as e:
                all_rows_ok = False
                print(f"  исключение на accrual_id={a['accrual_id']}: {e!r}")
                continue
            if bucket not in VALID_BUCKETS:
                all_rows_ok = False
                print(f"  невалидная корзина {bucket!r} на accrual_id={a['accrual_id']}")
            if not known:
                unknown_seen.append((a["accrued_category"], r["type_id"], bucket))
    check(f"все строки фикстуры ({n_rows_total}) классифицированы без исключений",
          all_rows_ok)
    check("на реальной фикстуре все встреченные типы known=True (перечни не забыты)",
          len(unknown_seen) == 0, unknown_seen)

    # --- 2. POSTING type_id IS NULL -> 'commission'.
    posting_id = 58786286904  # тот же образец, что и в check-ozon-accruals-parse.py
    posting = next(a for a in accruals if a["accrual_id"] == posting_id)
    rows = parse_accrual(posting)
    commission_rows = [r for r in rows if r["type_id"] is None]
    check("POSTING-образец даёт строку комиссии (type_id IS NULL)",
          len(commission_rows) == 1, commission_rows)
    bucket, known = classify_row("POSTING", None, True)
    check("classify_row(POSTING, None, has_unit=True) -> ('commission', True)",
          (bucket, known) == ("commission", True), (bucket, known))

    # --- 3. ITEM type_id=1 -> 'acquiring'.
    item_id = 58786496192  # тот же образец
    item = next(a for a in accruals if a["accrual_id"] == item_id)
    rows = parse_accrual(item)
    check("ITEM-образец: type_id=1 присутствует", rows[0]["type_id"] == 1, rows[0])
    bucket, known = classify_row("ITEM", 1, True)
    check("classify_row(ITEM, 1, has_unit=True) -> ('acquiring', True)",
          (bucket, known) == ("acquiring", True), (bucket, known))

    # --- 4. NON_ITEM: продвижение -> 'promo', прочее -> 'cabinet'.
    #        Фикстура несёт оба случая: 41 (PayPerClick) и 54 (Promotion) —
    #        продвижение; 96, 76, 46 — прочие кабинетные типы.
    non_item = [a for a in accruals if a["accrued_category"] == "NON_ITEM"]
    non_item_type_ids = {a.get("non_item_fee", {}).get("type_id") for a in non_item}
    check("фикстура несёт продвижение (41, 54) среди NON_ITEM",
          {41, 54} <= non_item_type_ids, non_item_type_ids)
    check("фикстура несёт кабинетные NON_ITEM вне продвижения (96, 76, 46)",
          {96, 76, 46} <= non_item_type_ids, non_item_type_ids)
    for tid in (41, 54):
        bucket, known = classify_row("NON_ITEM", tid, False)
        check(f"classify_row(NON_ITEM, {tid}, has_unit=False) -> ('promo', True)",
              (bucket, known) == ("promo", True), (bucket, known))
    for tid in (96, 76, 46):
        bucket, known = classify_row("NON_ITEM", tid, False)
        check(f"classify_row(NON_ITEM, {tid}, has_unit=False) -> ('cabinet', True)",
              (bucket, known) == ("cabinet", True), (bucket, known))

    # --- 5. Незнакомый выдуманный type_id.
    bucket, known = classify_row("POSTING", 999999, True)
    check("незнакомый type_id, has_unit=True -> ('logistics', False)",
          (bucket, known) == ("logistics", False), (bucket, known))
    bucket, known = classify_row("NON_ITEM", 999999, False)
    check("незнакомый type_id, has_unit=False -> ('cabinet', False)",
          (bucket, known) == ("cabinet", False), (bucket, known))

    # --- 6. RETURN_TYPE_IDS — маркер возвратного отправления, не корзина:
    #        оба кода классифицируются в 'logistics' (позаказные POSTING-
    #        сервисы), known=True, ровно как и обычная логистика.
    for tid in RETURN_TYPE_IDS:
        bucket, known = classify_row("POSTING", tid, True)
        check(f"RETURN_TYPE_IDS: classify_row(POSTING, {tid}, True) -> ('logistics', True)",
              (bucket, known) == ("logistics", True), (bucket, known))


def run_live_check():
    """--live: сверка полноты классификатора на всей истории боевой БД.
    Только чтение, креды из окружения воркера (SAAS_DB_*, как в
    worker/db_pg.py). Драйвер — psycopg (v3), как в worker/db_pg.py, а не
    psycopg2 (в .venv проекта установлен только v3)."""
    try:
        import psycopg
    except ImportError:
        print("FAIL  psycopg (v3) не установлен в текущем интерпретаторе")
        sys.exit(1)

    from worker.collectors.ozon_profit_map import classify_row

    dsn = (
        f"host={os.environ.get('SAAS_DB_HOST', 'localhost')} "
        f"port={os.environ.get('SAAS_DB_PORT', '5432')} "
        f"dbname={os.environ.get('SAAS_DB', 'saas')} "
        f"user={os.environ.get('SAAS_DB_USER', 'saas_app')} "
        f"password={os.environ.get('SAAS_DB_PASSWORD', '')}"
    )

    print("[--live] подключение к боевой БД, только чтение (SELECT)", flush=True)
    conn = psycopg.connect(dsn, autocommit=True)
    combos_by_key = {}
    try:
        conn.execute("SET default_transaction_read_only = on")

        # tenant.ozon_accruals защищена RLS-политикой tenant_iso_ozon_accruals
        # (TO saas_app USING cabinet_id = current_setting('app.cabinet_id')) —
        # креды воркера не видят ни строки без SET app.cabinet_id (проверено:
        # 0 строк), значит период истории нужно обойти по кабинетам.
        # auth.shops не под этой политикой (глобальный справочник) — берём
        # список ozon-кабинетов оттуда, а не хардкодим {1, 1008}.
        with conn.cursor() as cur:
            cur.execute("SELECT cabinet_id FROM auth.shops WHERE mp_code = 'ozon' ORDER BY 1")
            cabinet_ids = [row[0] for row in cur.fetchall()]
        print(f"[--live] ozon-кабинетов в auth.shops: {cabinet_ids}", flush=True)

        for cid in cabinet_ids:
            with conn.cursor() as cur:
                cur.execute(f"SET app.cabinet_id = '{int(cid)}'")
                cur.execute(
                    """
                    SELECT accrued_category, type_id,
                           bool_or(unit_number IS NOT NULL) AS has_unit,
                           bool_or(unit_number IS NULL) AS has_no_unit,
                           count(*)
                      FROM tenant.ozon_accruals
                     GROUP BY 1, 2
                    """
                )
                cabinet_combos = cur.fetchall()
            print(f"[--live] кабинет {cid}: сочетаний (category, type_id) = "
                  f"{len(cabinet_combos)}", flush=True)
            for category, type_id, has_unit_seen, has_no_unit_seen, n in cabinet_combos:
                key = (category, type_id)
                prev = combos_by_key.get(key, (False, False, 0))
                combos_by_key[key] = (
                    prev[0] or bool(has_unit_seen),
                    prev[1] or bool(has_no_unit_seen),
                    prev[2] + n,
                )
    finally:
        conn.close()

    combos = [(cat, tid, hu, hnu, n) for (cat, tid), (hu, hnu, n) in combos_by_key.items()]
    print(f"[--live] сочетаний (category, type_id) на всей истории (все кабинеты): "
          f"{len(combos)}", flush=True)

    unknown = []
    mixed_unit = []
    for category, type_id, has_unit_seen, has_no_unit_seen, n in combos:
        if has_unit_seen and has_no_unit_seen:
            # has_unit в живых данных не константа по (category, type_id) —
            # предположение докстрины модуля ("has_unit совпадает с
            # category без исключений") нарушено, проверяем оба варианта.
            mixed_unit.append((category, type_id, n))
            variants = (True, False)
        else:
            variants = (bool(has_unit_seen),)
        for has_unit in variants:
            bucket, known = classify_row(category, type_id, has_unit)
            if not known:
                unknown.append((category, type_id, has_unit, n, bucket))

    check("has_unit — константа по (category, type_id) на всей истории (без смешения)",
          len(mixed_unit) == 0, mixed_unit)
    check(f"0 незнакомых сочетаний (category, type_id) на всей истории "
          f"({len(combos)} проверено)", len(unknown) == 0, unknown)


def main():
    live = "--live" in sys.argv[1:]

    run_fixture_checks()
    if live:
        run_live_check()

    print()
    if failed:
        print(f"ИТОГО: {failed} провалено")
        sys.exit(1)
    print("ИТОГО: все проверки пройдены" + (" (включая --live)" if live else ""))


if __name__ == "__main__":
    main()
