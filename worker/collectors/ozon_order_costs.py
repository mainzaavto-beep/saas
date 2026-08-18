"""
SaaS-сборщик ПРИБЫЛИ ПО ЗАКАЗУ Ozon → tenant.ozon_order_costs (v2, метод
начислений — задача 3 плана «переезд финансов Ozon на методы начислений»,
docs/superpowers/specs/2026-08-15-ozon-profit-switch-design.md).

Источник денег СМЕНИЛСЯ: раньше — tenant.ozon_finance_report
(/v3/finance/transaction/list, 6 из 14 реально встречающихся типов операций
учитывались, 8 252,58 ₽ на проверенном дне мимо прибыли — см. дизайн-док).
Теперь — tenant.ozon_accruals (/v1/finance/accrual/by-day, задача 2 плана,
все типы операций классифицируются worker.collectors.ozon_profit_map).
Метаданные заказа (product_id/size/order_dt) и себестоимость
(tenant.cost_overrides) берутся ТЕМ ЖЕ способом, что и в v1 (сохранено
дословно) — меняется только откуда берутся деньги.

Единица расчёта — отправление (unit_number начислений). Строки начислений
группируются по unit_number → build_order_costs() (чистая функция без БД,
TDD-покрыта scripts/check-ozon-profit-calc.py) → пакетный upsert в
--target-table (белый список: tenant.ozon_order_costs |
tenant.ozon_order_costs_shadow — см. db_pg.upsert_ozon_order_costs_many).

⚠️ unit_number начислений НЕ ВСЕГДА буквально равен posting_number
tenant.ozon_orders (находка на живых данных 2026-08-05, кабинет 1: 10 из 44
отправлений дня — unit_number без финального "-N", который posting_number
несёт всегда; ещё 2/44 отсутствовали в ozon_orders целиком). product_id
поэтому резолвится НАДЁЖНО через sku (tenant.ozon_products.fbo_sku), а не
через сопоставление unit_number/posting_number — см. resolve_meta().
posting_number в выходной строке ТОЖЕ резолвится (не пишется сырой
unit_number напрямую — иначе потребители, джойнящие по posting_number,
получат обрыв связи и дубли, ревью задачи 3, Critical 2): итог прогона дня
2026-08-05 — 44 записи, 41 буквально совпадает с tenant.ozon_orders.posting_number
(9 «усечённых» дополнительно восстановлены базовым совпадением), 3 честно
помечены нерезолвленными и записаны как unit_number (2 полностью
отсутствуют в ozon_orders; 1 — намеренно НЕ резолвлен базовым совпадением,
т.к. его полная форма ЭТОГО ЖЕ дня САМА есть отдельная accrual-группа —
резолв привёл бы к коллизии ключа с ней, см. комментарий у
exact_unit_numbers в collect()).

NON_ITEM-начисления (расходы уровня кабинета, unit_number всегда NULL —
см. докстрину ozon_accruals.py) классифицируются той же функцией:
корзина 'cabinet' → дневной агрегат в tenant.ozon_cabinet_costs
(cost_type='accrual_<type_id>', description = имя типа из
shared.ozon_accrual_types); корзина 'promo' → НЕ пишется (защита от
двойного счёта рекламы — она уже приходит из Performance API как ad_spend,
см. докстроку ozon_profit_map.py), только считается и печатается в логе,
чтобы сумма периода была видна для сверки.

Инварианты, которые проверяет сборщик на каждом прогоне (нарушение — счётчик
+ русский лог + exit-код 3 по образцу ozon_accruals.py::partial_exit_code;
строки при этом всё равно пишутся — падение по СИГНАЛУ, не по данным):
  - согласованность компонент на каждом отправлении: cost_value_retail −
    commission − logistics − acquiring − loyalty == SUM(accrued строк этого
    отправления) — ЗНАКОВОЕ вычитание (компоненты уже несут знак после
    build_order_costs, не abs()) — см. build_order_costs.consistency_ok;
  - инвариант периода: SUM(accrued всех прочитанных строк начислений) ==
    SUM(accrued строк, попавших в order_costs) + SUM(accrued кабинетных
    строк, включая promo) — если что-то не разнеслось нигде, расхождение
    будет ненулевым и заметным. Отправления без резолвленного product_id
    (задача 3 плана «ремонт данных прибыли Ozon», §3) БОЛЬШЕ НЕ ПРОПУСКАЮТСЯ
    — строка пишется с product_id NULL, деньги разнесены как обычно, счётчик
    «без товара» в итоговой строке лога.
  - незнакомый type_id (classify_row возвращает known=False) — не
    выбрасывается молча, только считается и логируется.
  - инвариант датировки (задача 3 плана «ремонт данных прибыли Ozon», §2):
    после датировки строк с NULL в ОБЕИХ датах (sale_dt и return_dt) быть не
    должно вовсе — счётчик both_dates_null_count, попадает в mismatches,
    exit-код 3 (ревью задачи 3, Important: до этой правки инвариант был
    защищён только тестами, не runtime-проверкой).

self_buyout всегда 0 (грабля #138, сохранено из v1). Токен НЕ нужен —
данные уже в БД (tenant.ozon_accruals собраны отдельным сборщиком
ozon_accruals.py).

⚠️ ОКНО СБОРА vs ПОЛНАЯ ИСТОРИЯ ЮНИТА (фикс-волна финального ревью задачи
«переезд финансов Ozon на методы начислений», Critical 1 + Important 1):
плановый прогон вызывается с узким окном дат (run_saas_collect.sh:50,
−2..0), а бэкфилл/онбординг — с произвольным диапазоном. Раньше collect()
группировал по unit_number ТОЛЬКО строки, попавшие в этот диапазон — если
у отправления есть начисления ЗА ГРАНИЦЕЙ окна (возврат/сторно/упаковка
неделю спустя — обычное дело, docs/ozon-profit-switch-delta.md §6.3 уже
показал тот же класс дефекта на границе календарных месяцев при пересборе
shadow), пересборка узким окном ВИДЕЛА только часть строк юнита и своим
DELETE+INSERT затирала ранее записанную ПОЛНУЮ строку неполной — те же
деньги теряются молча на каждом плановом тике. Починка в два шага:
  1) (I1) окно дат самого SELECT из tenant.ozon_accruals раздвигается тем
     же способом, что и в ozon_accruals.py::resolve_window (импортирован
     отсюда, не продублирован) — MIN_LOOKBACK_DAYS=45, конец окна не
     позже вчера — иначе рестейтменты за пределами узкого планового окна,
     но внутри 45-дневного лага Ozon, никогда не переезжают в прибыль
     (то же самое верно и для кабинетных accrual_%-статей, т.к. они
     читаются из ТОГО ЖЕ окна, просто по дате, а не по unit_number);
  2) (C1) этим (уже раздвинутым) окном определяются только КАКИЕ
     unit_number вообще трогать в этом прогоне (`touched_unit_numbers`) —
     САМИ строки для группировки берутся ВТОРЫМ запросом без фильтра по
     дате (`unit_number = ANY(...)`, вся история юнита). NON_ITEM
     (кабинетные) строки этого раздвоения не касаются — они группируются
     по (type_id, date), не по юниту, поэтому им хватает первого запроса.
"""
import argparse
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_profit_map import classify_row, RETURN_TYPE_IDS
from ozon_accruals import resolve_window

DEFAULT_TARGET_TABLE = "tenant.ozon_order_costs"
ALLOWED_TARGET_TABLES = {"tenant.ozon_order_costs", "tenant.ozon_order_costs_shadow"}

_CONSISTENCY_TOLERANCE = 0.01
_INVARIANT_TOLERANCE = 0.01


def _num(v):
    return 0.0 if v is None else float(v)


def _row_date(v):
    """Дата строки начислений: из БД приходит datetime.date, из фикстур/тестов
    (JSON) — уже str. str() приводит оба варианта к 'YYYY-MM-DD'."""
    return None if v is None else str(v)


def build_order_costs(accrual_rows: list, meta: dict, costs: dict):
    """Чистая функция (без БД): одно отправление → строка tenant.ozon_order_costs.

    accrual_rows — строки tenant.ozon_accruals ОДНОГО unit_number (категории
    POSTING/ITEM, unit_number IS NOT NULL — вызывающий код (collect())
    группирует по unit_number ДО вызова). Порядок строк не важен.
    meta — метаданные заказа: {'product_id', 'size', 'order_dt', 'qty',
    'posting_number', 'posting_number_resolved'} — см. resolve_meta()
    (product_id/size/order_dt тем же способом, что в v1, читались из
    ozon_orders и там же остаются; qty добавлен явно — tenant.ozon_accruals
    не несёт qty, в отличие от старого ozon_finance_report.item_qty, поэтому
    источник qty сместился на ozon_orders.qty, семантика "штук в
    отправлении" не изменилась; posting_number/posting_number_resolved —
    см. ниже).
    costs — cogs_map: {product_id: cost} из tenant.cost_overrides (как в v1).

    ⚠️ ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (не устранено, унаследовано от v1): модель
    «1 unit_number = 1 запись order_costs» не различает товары ВНУТРИ
    мультитоварного отправления. product_id в meta резолвится (см.
    resolve_meta) по ПЕРВОМУ ненулевому sku строк отправления — если в
    отправлении несколько разных SKU, колонка product_id получит только
    один из них (какой именно — зависит от порядка строк ответа Ozon,
    гарантий стабильности порядка нет). v1 вёл себя так же (брал
    product_id первой попавшейся строки/последней строки ozon_orders при
    dict-перезаписи) — это не регресс, а тот же класс упрощения, что и
    раньше. cost_value_retail/commission/logistics/acquiring/loyalty —
    ДЕНЕЖНЫЕ суммы отправления ЦЕЛИКОМ (не одного SKU), поэтому финансово
    корректны независимо от того, чей product_id записан.

    Возвращает None только если accrual_rows пуст (нечего группировать —
    вызывающий код в collect() такого не передаёт по конструкции). Строки без
    резолвленного product_id БОЛЬШЕ НЕ ПРОПУСКАЮТСЯ (задача 3 плана «ремонт
    данных прибыли Ozon», §3) — product_id в результате может быть None,
    деньги отправления пишутся в любом случае. Иначе — dict с колонками
    tenant.ozon_order_costs (включая 'src_unit_number' — исходный, сырой
    unit_number начислений, ВСЕГДА, независимо от того, резолвился ли
    posting_number) ПЛЮС служебные (не-колоночные) поля для collect():
    'consistency_ok' (bool), 'unknown_types' (list[(category, type_id)] с
    known=False среди строк этого отправления), 'posting_number_resolved'
    (bool — резолвлен ли posting_number реальной строкой tenant.ozon_orders
    или записан fallback'ом как unit_number).
    """
    if not accrual_rows:
        return None

    unit_number = accrual_rows[0]["unit_number"]

    # commission_rows — СПИСОК, а не одна строка: мультитоварное отправление
    # (несколько SKU в одном posting) несёт НЕСКОЛЬКО commission-блоков
    # (POSTING, type_id IS NULL) — по одному на каждый sku (ревью задачи 3,
    # находка на боевых данных: unit 60208425-0132-1, кабинет 1008, 20 SKU —
    # 20 commission-строк; взятие только последней теряло seller_price и
    # sale_commission остальных 19). seller_price/sale_commission суммируются
    # по ВСЕМ commission-строкам — тот же приём, что уже применялся к
    # logistics/acquiring/loyalty через `+=` по всем строкам корзины.
    commission_rows = []
    logistics_raw = 0.0
    acquiring_raw = 0.0
    loyalty_raw = 0.0
    return_dates = []
    unknown_types = []

    for r in accrual_rows:
        category = r["accrued_category"]
        type_id = r["type_id"]
        bucket, known = classify_row(category, type_id, True)
        if not known:
            unknown_types.append((category, type_id))
        if bucket == "commission":
            commission_rows.append(r)
        elif bucket == "acquiring":
            acquiring_raw += _num(r.get("accrued"))
        elif bucket == "loyalty":
            loyalty_raw += _num(r.get("accrued"))
        else:  # 'logistics' — в т.ч. незнакомые позаказные типы ("прочее",
               # чтобы роуты панели, вычитающие logistics целиком, ничего не
               # потеряли молча, см. докстроку ozon_profit_map.py)
            logistics_raw += _num(r.get("accrued"))
        if type_id in RETURN_TYPE_IDS:
            return_dates.append(_row_date(r.get("date")))

    # Суммируем СЫРЫЕ (знаковые) accrued по корзине и берём -sum, а НЕ
    # сумму abs() по строкам: у отдельных строк бывают развороты/сторно
    # (например, эквайринг -24.99 и +24.99 в один день — итог 0, а не 49.98,
    # если бы суммировали abs() каждой строки отдельно). -sum(bucket) даёт
    # ТОЧНОЕ тождество с SUM(accrued) отправления при ЛЮБЫХ знаках (обычный
    # случай: сумма корзины отрицательна, -sum == |sum|, визуально то же
    # самое, что и раньше; edge-case с сальдо в плюс — тоже верно, тогда
    # компонента в order_costs отрицательна, и профильная формула роутов
    # (profit = revenue − cost − commission − logistics − acquiring)
    # корректно ДОБАВЛЯЕТ этот возврат к прибыли). Найдено тестом
    # scripts/check-ozon-profit-calc.py на реальных строках фикстуры
    # (unit 02464949-0474, 63981463-0371) — та же логика (сумма корзины,
    # затем -sum) теперь применена и к commission (несколько строк), см.
    # docs/superpowers/specs/2026-08-15-ozon-profit-switch-design.md.

    commission_accrued_sum = sum(_num(r.get("accrued")) for r in commission_rows)

    # is_return: коды 45/59 (RETURN_TYPE_IDS) ИЛИ отрицательный commission-блок
    # (реверс уже начисленной продажи, суммарно по ВСЕМ commission-строкам).
    # Отсутствие commission-блока САМО ПО СЕБЕ возвратом не считается (фикс
    # эвристики ±835 ₽ из дизайн-дока — "нулевые" отправления: чистые
    # сервисные/комиссионные строки без продажи на этом дне, is_return
    # остаётся 0).
    is_return = 0
    return_dt = None
    if return_dates:
        is_return = 1
        non_null_dates = [d for d in return_dates if d is not None]
        return_dt = min(non_null_dates) if non_null_dates else None
    elif commission_rows and commission_accrued_sum < 0:
        is_return = 1
        commission_dates = [_row_date(r.get("date")) for r in commission_rows
                             if r.get("date") is not None]
        return_dt = min(commission_dates) if commission_dates else None

    seller_price = sum(_num(r.get("seller_price")) for r in commission_rows)
    commission_raw = sum(_num(r.get("sale_commission")) for r in commission_rows)
    sale_dates = [_row_date(r.get("date")) for r in commission_rows if r.get("date") is not None]
    sale_dt = min(sale_dates) if sale_dates else None

    # Датировка юнитов БЕЗ commission-блока (задача 3 плана «ремонт данных
    # прибыли Ozon», docs/superpowers/specs/2026-08-17-ozon-data-repair-design.md
    # §2): такой юнит не несёт ни одной commission-строки, поэтому sale_dt
    # выше остаётся None ВСЕГДА (sale_dates строится только из commission_rows)
    # — а return_dt остаётся None тоже, если is_return не взведён строками
    # RETURN_TYPE_IDS (см. return_dates выше). Итог — юнит без commission-
    # блока и без кодов 45/59 не получал вовсе никакой даты, хотя деньги по
    # нему были начислены: −1,81 млн ₽ расходов невидимы в помесячных
    # разрезах панели (находка ревью). Правило спеки: min(date) ВСЕХ строк
    # юнита (не только commission/return-типных) → return_dt, если юнит
    # возвратный (та же is_return, что уже вычислена выше), иначе → sale_dt.
    # Применяется ТОЛЬКО когда commission-блока нет вовсе — юнит С
    # commission-блоком датируется как раньше (регресс-проверка
    # scripts/check-ozon-profit-calc.py, п.12: правило первой операции НЕ
    # должно "утекать" на несвязанную более раннюю логистическую строку).
    if not commission_rows:
        all_dates = [_row_date(r.get("date")) for r in accrual_rows if r.get("date") is not None]
        first_date = min(all_dates) if all_dates else None
        if is_return:
            return_dt = first_date
        else:
            sale_dt = first_date

    commission_sum = round(-commission_raw, 2)
    logistics_sum = round(-logistics_raw, 2)
    acquiring_sum = round(-acquiring_raw, 2)
    loyalty_sum = round(-loyalty_raw, 2)

    cost_value_retail = 0.0 if is_return else round(seller_price, 2)

    # Строки без товара (задача 3 плана, §3): sku, не резолвленный ни через
    # каталог (tenant.ozon_products.fbo_sku), ни через резолв posting_number
    # → tenant.ozon_orders.product_id (обе попытки уже сделаны ВЫШЕ по
    # цепочке вызова — см. resolve_meta()) — product_id остаётся None. Раньше
    # ("if not product_id: return None") строка тихо пропускалась ("continue"
    # в v1) — источник разрыва инварианта ~334 тыс ₽ и 6 284 отправлений
    # старых месяцев кабинета 1, отсутствующих из панели. Теперь строка
    # ВСЁ РАВНО пишется — product_id NULL, деньги (cost_value_retail/
    # commission/logistics/acquiring/loyalty/profit) на месте. Счётчик "без
    # товара" считает collect() по result["product_id"] is None (переименован
    # честно из skipped_no_product — строки больше не пропускаются).
    product_id = meta.get("product_id")
    cost = costs.get(product_id) if product_id is not None else None

    sum_accrued = round(sum(_num(r.get("accrued")) for r in accrual_rows), 2)
    profit = round(sum_accrued - _num(cost), 2)

    comps = round(cost_value_retail - commission_sum - logistics_sum - acquiring_sum - loyalty_sum, 2)
    consistency_ok = abs(comps - sum_accrued) <= _CONSISTENCY_TOLERANCE

    # posting_number: резолвленный tenant.ozon_orders.posting_number (см.
    # resolve_meta), а НЕ сырой unit_number начислений напрямую — потребители
    # (app/api/cabinets/[id]/orders/route.js) джойнят по posting_number,
    # усечённый номер даёт NULL-метаданные и дубль заказа в списке (ревью
    # задачи 3). Если resolve_meta не смог однозначно резолвить —
    # posting_number/posting_number_resolved это отражают явно.
    resolved_posting_number = meta.get("posting_number") or unit_number
    posting_number_resolved = bool(meta.get("posting_number_resolved"))

    return {
        "posting_number": resolved_posting_number,
        "src_unit_number": unit_number,
        "product_id": product_id,
        "size": meta.get("size"),
        "is_return": is_return,
        "order_dt": meta.get("order_dt"),
        "sale_dt": sale_dt,
        "return_dt": return_dt,
        "cost_value_retail": cost_value_retail,
        "commission": round(commission_sum, 2),
        "acquiring": round(acquiring_sum, 2),
        "logistics": round(logistics_sum, 2),
        "loyalty": round(loyalty_sum, 2),
        "cost": round(cost, 2) if cost is not None else None,
        "qty": meta.get("qty") or 1,
        "profit": profit,
        "self_buyout": 0,
        # служебные поля для collect(), НЕ колонки БД (db_pg берёт только
        # известные ему колонки через .get(), лишние ключи безвредны):
        "consistency_ok": consistency_ok,
        "unknown_types": unknown_types,
        "posting_number_resolved": posting_number_resolved,
    }


def resolve_meta(unit_number, unit_rows, order_meta, order_meta_by_base, product_by_sku):
    """Собрать meta для build_order_costs() из ДВУХ источников (находка на
    живых данных 2026-08-05, кабинет 1 — задокументирована в отчёте задачи 3):
    accrual_id.unit_number НЕ ВСЕГДА равен tenant.ozon_orders.posting_number
    буквально — на 10 из 44 отправлений дня unit_number идёт БЕЗ финального
    "-N" (номер товара в отправлении), который posting_number несёт всегда
    (например, unit_number='63981463-0371', posting_number='63981463-0371-1');
    ещё 2/44 отсутствовали в ozon_orders целиком (более старые/вне окна
    синхронизации). Ни один из этих случаев НЕ повод терять деньги отправления
    молча — задача 3 явно требует не пропускать без причины и сигнализировать
    об оставшихся разрывах через инвариант периода.

    product_id резолвится НАДЁЖНЕЕ через sku (accrual несёт sku строки, а
    tenant.ozon_products.fbo_sku — тот же sku в понятной терминах кабинета
    product_id) — это НЕ то же самое, что product_id в ozon_orders/ozon_products
    (разная внутренняя нумерация), и совпадает всегда, даже когда
    posting_number не совпал буквально. Ограничение: если у отправления
    НЕСКОЛЬКО разных sku (мультитоварный unit), берётся ПЕРВЫЙ ненулевой —
    см. предупреждение в докстроке build_order_costs (то же упрощение,
    что было в v1).

    order_dt/size/qty/posting_number берутся из ozon_orders — точным
    совпадением posting_number, а при его отсутствии — «базовым» совпадением
    (posting_number без финального "-N"), если оно ОДНОЗНАЧНО (иначе не
    обогащаем — безопасный дефолт вместо гадания, какой из нескольких товаров
    отправления имелся в виду). posting_number ВСЕГДА возвращается полным
    (реальным ozon_orders.posting_number), когда meta резолвлена (точным ИЛИ
    однозначным базовым совпадением) — вызывающий (build_order_costs) пишет
    его в БД вместо сырого unit_number, чтобы не ломать JOIN потребителей
    (app/api/cabinets/[id]/orders/route.js). posting_number_resolved=False
    означает: meta не найдена (ни точно, ни однозначно по базе) —
    build_order_costs запишет unit_number КАК ЕСТЬ (fallback, не ничего) и
    учтёт это в счётчике collect()."""
    meta = order_meta.get(unit_number)
    resolved = meta is not None
    if meta is None:
        candidates = order_meta_by_base.get(unit_number)
        if candidates and len(candidates) == 1:
            meta = candidates[0]
            resolved = True
        else:
            meta = {}

    resolved_sku = next((r.get("sku") for r in unit_rows if r.get("sku") is not None), None)
    product_id = product_by_sku.get(resolved_sku) if resolved_sku is not None else None
    if product_id is None:
        product_id = meta.get("product_id")

    return {
        "product_id": product_id,
        "size": meta.get("size"),
        "order_dt": meta.get("order_dt"),
        "qty": meta.get("qty"),
        "posting_number": meta.get("posting_number") if resolved else None,
        "posting_number_resolved": resolved,
    }


def _validate_target_table(target_table: str) -> str:
    """Белый список --target-table (брифовое ограничение: НИКАКОЙ подстановки
    произвольной строки в SQL). Возвращает короткое имя (без 'tenant.') для
    db_pg.upsert_ozon_order_costs_many, который проверяет его СВОИМ списком
    ещё раз (defence in depth)."""
    if target_table not in ALLOWED_TARGET_TABLES:
        raise ValueError(
            f"недопустимая --target-table: {target_table!r} "
            f"(разрешено: {sorted(ALLOWED_TARGET_TABLES)})")
    return target_table.split(".", 1)[1]


_MISMATCHES = 0  # согласованность компонент + инвариант периода — читает __main__ после collect()


def partial_exit_code(mismatches: int):
    """Контракт exit-кодов (orchestrator.py:80-82): >0 расхождений
    (согласованность компонент отправления ИЛИ инвариант периода) → 3
    (partial, строки уже записаны — падение по сигналу). Иначе None.
    По образцу ozon_accruals.py::partial_exit_code."""
    return 3 if mismatches else None


def collect(date_from=None, date_to=None, target_table=DEFAULT_TARGET_TABLE):
    global _MISMATCHES
    short_table = _validate_target_table(target_table)
    # I1 (фикс-волна финального ревью): тот же lookback-пол, что у ozon_accruals
    # (45 дней, конец — не позже вчера) — узкое плановое окно (−2..0) само по
    # себе НЕ ловит рестейтменты старше 3 дней; resolve_window раздвигает его,
    # явные широкие бэкфиллы не трогает (см. докстроку модуля).
    d_from, d_to = resolve_window(date_from, date_to)
    print(f"[ozon_order_costs] расчёт прибыли из начислений {d_from}..{d_to} "
          f"-> {target_table}", flush=True)
    db_pg.init()

    window_rows = db_pg.query(
        "SELECT accrual_id, line_no, date, unit_number, accrued_category, type_id, sku, "
        "accrued, seller_price, sale_price, sale_commission, coinvestment, bonus "
        "FROM tenant.ozon_accruals WHERE date >= %s AND date <= %s "
        "ORDER BY unit_number, accrual_id, line_no", [d_from.isoformat(), d_to.isoformat()])

    # cost_overrides — единый источник себестоимости (та же логика, что в v1).
    cogs_map = {r["product_id"]: float(r["cost"]) for r in db_pg.query(
        "SELECT DISTINCT ON (product_id) product_id, cost FROM tenant.cost_overrides "
        "WHERE platform='ozon' AND effective_from <= current_date "
        "ORDER BY product_id, effective_from DESC") if r["cost"] is not None}

    # C1 (фикс-волна финального ревью): окном (уже раздвинутым I1) определяем
    # только КАКИЕ unit_number трогать в этом прогоне — cabinet_rows (NON_ITEM,
    # группировка по дате, юнита не касается) берём прямо из window_rows, а вот
    # САМИ строки для позаказной группировки — ВТОРЫМ запросом без фильтра по
    # дате (вся история юнита, см. докстроку модуля): иначе юнит с начислением
    # за границей окна (возврат/сторно/упаковка неделю спустя) пересобирался бы
    # из неполных строк и затирал полную запись.
    touched_unit_numbers = sorted({r["unit_number"] for r in window_rows if r["unit_number"] is not None})
    cabinet_rows = [r for r in window_rows if r["unit_number"] is None]

    history_rows = db_pg.query(
        "SELECT accrual_id, line_no, date, unit_number, accrued_category, type_id, sku, "
        "accrued, seller_price, sale_price, sale_commission, coinvestment, bonus "
        "FROM tenant.ozon_accruals WHERE unit_number = ANY(%s) "
        "ORDER BY unit_number, accrual_id, line_no",
        [touched_unit_numbers]) if touched_unit_numbers else []

    by_unit = defaultdict(list)
    for r in history_rows:
        by_unit[r["unit_number"]].append(r)

    # order_dt/size/product_id/posting_number — та же логика, что в v1
    # (SELECT из ozon_orders, словарь по posting_number, последняя строка
    # мульти-товарного отправления выигрывает — то же упрощение, что и
    # раньше). qty добавлен явно — см. докстроку build_order_costs (в
    # accruals qty нет). posting_number хранится В САМОЙ строке (SELECT
    # его возвращает) — используется resolve_meta() для восстановления
    # полного номера, когда unit_number начислений урезан (см. ниже).
    order_meta = {r["posting_number"]: r for r in db_pg.query(
        "SELECT posting_number, order_dt, size, product_id, qty FROM tenant.ozon_orders")}
    # «Базовый» индекс (posting_number без финального "-N") — обогащение
    # order_dt/size/qty/posting_number, когда unit_number начислений не
    # совпал буквально (см. resolve_meta). ⚠️ Кандидаты, чей posting_number
    # САМ является отдельным unit_number этого периода (ровно та же дата,
    # своя accrual-группа — т.е. будет резолвлен ТОЧНЫМ совпадением), из
    # индекса ИСКЛЮЧАЮТСЯ: иначе усечённый unit_number (без финального "-N")
    # мог бы однозначно "базово" резолвиться на ТОТ ЖЕ posting_number, что и
    # чужая точно совпавшая accrual-группа — коллизия ключа (cabinet_id,
    # posting_number) при записи, которая молча схлопывает два РАЗНЫХ
    # отправления в одну строку (потеря денег одного из них). Живой пример
    # (кабинет 1, 2026-08-05): unit_number "63981463-0371" (усечён) и
    # "63981463-0371-1" (полный) — ОБА встречаются как отдельные accrual-
    # группы дня; без этого исключения оба резолвились в posting_number
    # "63981463-0371-1", INSERT ... ON CONFLICT молча оставлял только
    # последнего в батче (44 группы -> 43 строки в БД, обнаружено сверкой
    # после ревью задачи 3). exact_unit_numbers == touched_unit_numbers (то же
    # множество, что определило состав second-query выше, C1) — единственные
    # unit_number, которые ТОЧНО резолвятся в этом прогоне.
    exact_unit_numbers = set(touched_unit_numbers)
    order_meta_by_base = defaultdict(list)
    for pn, r in order_meta.items():
        if pn in exact_unit_numbers:
            continue
        base = pn.rsplit("-", 1)[0] if "-" in pn else pn
        order_meta_by_base[base].append(r)
    # product_id надёжнее резолвится через sku (см. докстроку resolve_meta).
    # Схема НЕ гарантирует уникальность fbo_sku (нет UNIQUE-ограничения) —
    # коллизии (два разных product_id с одним fbo_sku) считаем и логируем,
    # а не теряем молча (dict-comprehension держал бы только последнюю
    # запись без предупреждения).
    product_by_sku = {}
    fbo_sku_collisions = 0
    for r in db_pg.query("SELECT product_id, fbo_sku FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        sku = r["fbo_sku"]
        if sku in product_by_sku and product_by_sku[sku] != r["product_id"]:
            fbo_sku_collisions += 1
            print(f"  fbo_sku={sku}: несколько product_id "
                  f"({product_by_sku[sku]}, {r['product_id']}) — оставлен последний "
                  f"из запроса", file=sys.stderr, flush=True)
        product_by_sku[sku] = r["product_id"]
    type_names = {r["type_id"]: r["name"] for r in db_pg.query(
        "SELECT type_id, name FROM shared.ozon_accrual_types")}

    order_costs_out = []
    mismatches = 0
    unknown_types = set()
    # Честное имя (переименовано из skipped_no_product — задача 3 плана
    # «ремонт данных прибыли Ozon», §3): строки с нерезолвленным product_id
    # БОЛЬШЕ НЕ ПРОПУСКАЮТСЯ (build_order_costs всегда возвращает строку,
    # product_id может быть None) — счётчик теперь считает НАПИСАННЫЕ строки
    # без товара, а не пропущенные.
    no_product_count = 0
    unresolved_posting_number = 0
    # Инвариант датировки (задача 3 плана «ремонт данных прибыли Ozon», §2):
    # «после датировки строк с NULL в обеих датах быть не должно вовсе —
    # сборщик проверяет и считает». До сих пор это было защищено ТОЛЬКО
    # тестами (scripts/check-ozon-profit-calc.py) и случайностью схемы
    # (ozon_accruals.date — NOT NULL, поэтому build_order_costs при непустых
    # accrual_rows физически не может отдать обе даты NULL при текущей
    # реализации) — без runtime-проверки регресс в build_order_costs (или
    # смена схемы вверх по потоку) прошёл бы в БД молча. Счётчик — по образцу
    # трёх других инвариантов файла (consistency_ok, инвариант периода,
    # unknown_types): считаем, логируем по-русски, добавляем в mismatches →
    # exit 3 (partial_exit_code), строку при этом всё равно пишем (падение по
    # СИГНАЛУ, не по данным, как и остальные инварианты здесь).
    both_dates_null_count = 0
    sum_order_accrued = 0.0

    for unit_number, unit_rows in by_unit.items():
        meta = resolve_meta(unit_number, unit_rows, order_meta, order_meta_by_base, product_by_sku)
        result = build_order_costs(unit_rows, meta, cogs_map)
        if result is None:
            # Теоретически недостижимо при непустом unit_rows (build_order_costs
            # возвращает None только для accrual_rows=[]) — защитная сетка,
            # не влияет на инвариант периода (строка не разнесена нигде).
            continue
        if result["product_id"] is None:
            no_product_count += 1
        if result["sale_dt"] is None and result["return_dt"] is None:
            both_dates_null_count += 1
            mismatches += 1
            print(f"  ИНВАРИАНТ ДАТИРОВКИ НАРУШЕН: posting_number={unit_number} "
                  f"обе даты NULL (sale_dt и return_dt) — строка записана, "
                  f"но без даты", file=sys.stderr, flush=True)
        if not result["consistency_ok"]:
            mismatches += 1
            comps = (result["cost_value_retail"] - result["commission"] - result["logistics"]
                     - result["acquiring"] - result["loyalty"])
            unit_sum = round(sum(_num(r.get("accrued")) for r in unit_rows), 2)
            print(f"  расхождение согласованности: posting_number={unit_number} "
                  f"cost_value_retail-commission-logistics-acquiring-loyalty="
                  f"{comps:.2f} != SUM(accrued)={unit_sum:.2f}", file=sys.stderr, flush=True)
        unknown_types.update(result.pop("unknown_types"))
        result.pop("consistency_ok")
        if not result.pop("posting_number_resolved"):
            unresolved_posting_number += 1
            print(f"  posting_number не резолвлен через ozon_orders, записан unit_number "
                  f"как есть: {unit_number}", file=sys.stderr, flush=True)
        order_costs_out.append(dict(result, _unit_number=unit_number))
        sum_order_accrued += sum(_num(r.get("accrued")) for r in unit_rows)

    # Защитная сетка (defence in depth) поверх исключения exact_unit_numbers
    # из order_meta_by_base выше: если ДВЕ РАЗНЫЕ accrual-группы этого
    # прогона всё же разрешились в ОДИН И ТОТ ЖЕ posting_number (любым
    # путём, не только через уже закрытый случай усечения "-N"), явный
    # INSERT ... ON CONFLICT молча схлопнул бы их в одну строку — потеря
    # денег одного из отправлений. Ловим ДО записи: коллизии откатываются на
    # собственный unit_number (гарантированно уникален — это ключ by_unit) и
    # громко логируются, вместо того чтобы БД тихо оставила последнего в
    # батче.
    seen_posting_numbers = {}
    for r in order_costs_out:
        pn = r["posting_number"]
        if pn in seen_posting_numbers:
            print(f"  КОЛЛИЗИЯ posting_number={pn}: отправления {seen_posting_numbers[pn]} и "
                  f"{r['_unit_number']} резолвились в один и тот же номер — второе записано "
                  f"под своим unit_number ({r['_unit_number']}), чтобы не потерять деньги "
                  f"первого", file=sys.stderr, flush=True)
            r["posting_number"] = r["_unit_number"]
            mismatches += 1
        else:
            seen_posting_numbers[pn] = r["_unit_number"]
        del r["_unit_number"]

    # NON_ITEM: группировка (type_id, date) -> cabinet | promo (не пишется).
    cab_group = defaultdict(float)
    promo_total = 0.0
    promo_count = 0
    for r in cabinet_rows:
        bucket, known = classify_row(r["accrued_category"], r["type_id"], False)
        if not known:
            unknown_types.add((r["accrued_category"], r["type_id"]))
        amount = _num(r.get("accrued"))
        if bucket == "promo":
            promo_total += amount
            promo_count += 1
        else:  # 'cabinet'
            cab_group[(r["type_id"], _row_date(r.get("date")))] += amount

    cabinet_out = []
    for (type_id, date), amount in cab_group.items():
        tid_label = type_id if type_id is not None else "none"
        cabinet_out.append({
            "cost_type": f"accrual_{tid_label}",
            "date": date,
            "amount": round(amount, 2),
            "description": type_names.get(type_id) or f"тип {type_id}",
        })
    sum_cabinet = sum(cab_group.values())

    # Инвариант периода: всё прочитанное из ozon_accruals должно быть либо в
    # order_costs, либо в кабинетных строках (включая promo, который не
    # пишется, но учтён в сумме). См. докстроку модуля. C1: "прочитанное" —
    # это уже НЕ window_rows напрямую (POSTING/ITEM часть window_rows —
    # подмножество history_rows по конструкции ANY(unit_number), поэтому
    # суммировать оба значило бы задвоить эту часть) — cabinet_rows (окно, по
    # дате) + history_rows (вся история ТРОНУТЫХ юнитов, C1).
    total_read = round(
        sum(_num(r.get("accrued")) for r in cabinet_rows)
        + sum(_num(r.get("accrued")) for r in history_rows), 2)
    allocated = round(sum_order_accrued + sum_cabinet + promo_total, 2)
    invariant_diff = round(total_read - allocated, 2)
    if abs(invariant_diff) > _INVARIANT_TOLERANCE:
        mismatches += 1
        # (задача 3 плана, §3): строки без product_id больше не пропускаются
        # и не создают разрыв здесь — их деньги уже учтены в sum_order_accrued
        # (product_id может быть NULL, но строка всё равно написана и
        # разнесена). Оставшийся разрыв — другая причина (незнакомый тип,
        # арифметика) и требует отдельного разбора.
        print(f"  ИНВАРИАНТ НАРУШЕН: прочитано начислений на {total_read:.2f} ₽, "
              f"разнесено (order_costs + cabinet + promo) на {allocated:.2f} ₽, "
              f"разница {invariant_diff:+.2f} ₽", file=sys.stderr, flush=True)

    # I3 (фикс-волна финального ревью): extra_keys = ИСХОДНЫЕ (сырые)
    # unit_number всех пересобираемых в этом прогоне юнитов — db_pg удаляет
    # ПО НИМ ТОЖЕ, не только по итоговому posting_number этого прогона.
    # Без этого: если прошлый прогон резолвил posting_number в fallback
    # (сырой unit_number, meta не нашлась) и этой строкой попал в БД, а
    # ЭТОТ прогон нашёл meta и резолвил ПОЛНУЮ форму — старая fallback-
    # строка осталась бы сиротой (двойной счёт), т.к. DELETE по одному
    # только новому posting_number её не задевает.
    n_order = db_pg.upsert_ozon_order_costs_many(
        order_costs_out, short_table, extra_keys=touched_unit_numbers)
    eff_from, eff_to = d_from.isoformat(), d_to.isoformat()
    n_cabinet = db_pg.upsert_ozon_cabinet_costs_many(cabinet_out, eff_from, eff_to)

    msg = (f"[ozon_order_costs] отправлений {len(order_costs_out)} (записано {n_order}), "
           f"кабинетных статей {len(cabinet_out)} (записано {n_cabinet}), "
           f"промо не пишется (учтено в ad_spend Performance API): {promo_count} строк, "
           f"Σ={promo_total:.2f} ₽")
    if no_product_count:
        msg += f", без товара (product_id NULL, строка записана): {no_product_count}"
    if both_dates_null_count:
        msg += f", БЕЗ ДАТЫ (sale_dt и return_dt оба NULL, инвариант нарушен): {both_dates_null_count}"
    if unresolved_posting_number:
        msg += f", posting_number не резолвлен (записан unit_number): {unresolved_posting_number}"
    if fbo_sku_collisions:
        msg += f", коллизий fbo_sku: {fbo_sku_collisions}"
    if unknown_types:
        sorted_unknown = sorted(unknown_types, key=lambda x: (x[0], -1 if x[1] is None else x[1]))
        msg += f", незнакомых типов: {len(unknown_types)} {sorted_unknown}"
    if mismatches:
        msg += f", расхождений (согласованность/инвариант): {mismatches}"
    print(msg, flush=True)
    _MISMATCHES = mismatches
    return n_order


def _parse_args(argv):
    ap = argparse.ArgumentParser(description="ozon_order_costs v2 — расчёт прибыли из начислений")
    ap.add_argument("date_from", nargs="?", default=None)
    ap.add_argument("date_to", nargs="?", default=None)
    ap.add_argument("--target-table", dest="target_table", default=DEFAULT_TARGET_TABLE,
                     help=f"белый список: {sorted(ALLOWED_TARGET_TABLES)}")
    return ap.parse_args(argv)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    args = _parse_args(sys.argv[1:])
    collect(args.date_from, args.date_to, target_table=args.target_table)
    code = partial_exit_code(_MISMATCHES)
    if code is not None:
        sys.exit(code)
