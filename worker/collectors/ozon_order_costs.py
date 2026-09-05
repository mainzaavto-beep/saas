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

Статья «Сборы Ozon» (задача 1 плана «статья Сборы Ozon», 2026-08-25,
docs/superpowers/specs/2026-08-25-ozon-services-line-design.md, миграция
045): позаказные ITEM-типы сервисов (отзывы/рассрочка/упаковка/размещение/
утилизация и пр. — worker.collectors.ozon_profit_map.PER_ORDER_SERVICE_TYPE_IDS)
и незнакомые позаказные типы (копилка «прочие сборы») классифицируются
бакетом 'services', отдельным от 'logistics' — раньше маскировались под
логистику (находка владельца: FirstCustomerReview 1 813 ₽ выглядел
«космической логистикой» отправления 50588097-1427-1). 'logistics' теперь
строго перевозка/обработка отправлений и возвратов (POSTING-типы).

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
    commission − services − logistics − acquiring − loyalty == SUM(accrued
    строк этого отправления) — ЗНАКОВОЕ вычитание (компоненты уже несут
    знак после build_order_costs, не abs()) — см.
    build_order_costs.consistency_ok;
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
    после датировки НАПИСАННЫХ строк с NULL в ОБЕИХ датах (sale_dt и
    return_dt) быть не должно вовсе — счётчик both_dates_null_count,
    попадает в mismatches, exit-код 3 (ревью задачи 3, Important: до этой
    правки инвариант был защищён только тестами, не runtime-проверкой).
    ⚠️ УТОЧНЕНО задачей 6 (round 3/4, task-6-report.md): юнит без
    commission-блока младше MATURITY_THRESHOLD_DAYS (иначе получил бы обе
    даты NULL) теперь СОВСЕМ НЕ ПИШЕТСЯ (immature_count, отдельный от
    mismatches — это ожидаемое поведение, не находка) — товар в
    пути/только доставлен без финализации Ozon показывается панелью через
    /orders pending-ветку с нулевыми финансами (продуктовое решение
    владельца), а не строкой order_costs с фантомным убытком. См. также
    merge_unit_siblings/_family_key: ДО датировки/порога зрелости юниты,
    чьи данные Ozon репортит под соседними формами сырого unit_number
    (логистика под одной, commission под другой — одно и то же реальное
    отправление), склеиваются в один — устраняет БОЛЬШУЮ ЧАСТЬ ложных
    «незрелых»/нулевых строк без всякого порога.

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
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timezone

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
# Допуск «полного сторно» через пару (и более) commission-блоков — находка
# владельца, заказ 0131642813-0453-1, 2026-08-21 (см. is_return в
# build_order_costs). Та же величина 0.01, что у остальных допусков модуля —
# отдельная константа ради самостоятельного имени/комментария в диффе.
_RETURN_NET_TOLERANCE = 0.01

# Порог зрелости юнита БЕЗ commission-блока (задача 6 плана «ремонт данных
# прибыли Ozon», round 3 фикс — владелец нашёл: 350 строк августа кабинета 1
# показывали «продажу» с нулевой выручкой и profit = −логистика−cost, хотя
# юнит физически ещё в пути/только доставлен, Ozon его не финализировал).
# КАЛИБРОВКА (под saas_ro, снимок 2026-08-18, полный разбор — task-6-report.md
# round 4): лаг «первая операция юнита → приход commission-блока» по 8 529
# юнитам кабинета 1 с продажей — p50=0, p90=0, p99=0, max=1 день (commission,
# когда он вообще приходит, приходит день-в-день с первой строкой юнита
# практически ВСЕГДА). Отдельно проверено (контролёр, перепроверено): 232 из
# 350 «нулевых» строк на самом деле уже ИМЕЮТ продажу в начислениях — просто
# под СОСЕДНЕЙ формой сырого unit_number (см. merge_unit_siblings/_family_key
# ниже) — это ГЛАВНАЯ причина, чинится склейкой, НЕ порогом зрелости. Порог
# ниже — тонкая подстраховка ТОЛЬКО для оставшихся действительно свежих
# юнитов (моложе нескольких дней, без commission ни под одной формой номера)
# — «p99 (0) + буфер» на возможные выходные/таймзонные/технические сдвиги
# коллекции. 3 дня — заметный запас над наблюдённым max=1 день, но короткий
# ровно потому, что calibration показала: если commission вообще будет, он
# почти наверняка уже есть; юнит младше порога получает НУЛИ через pending
# (см. app/api/cabinets/[id]/orders/route.js) вместо фантомного убытка.
MATURITY_THRESHOLD_DAYS = 3

# Разбор 29.08.2026 (задача 8 плана «География 2.0», фикс-раунд по PARTIAL
# кабинета 1): unit_number вида "sr01-…" — это НЕ отправление, а заявка на
# сервисную операцию склада Ozon (вывоз товара и т.п., подтверждено вручную
# на sr01-bx20227797734: SellerReturns + TemporaryPlacementsAgent, 390 ₽,
# деньги учтены верно). У таких юнитов posting_number закономерно НЕ
# резолвится через ozon_orders — это ожидаемо, не находка сторожа полноты,
# и не должно поднимать шумный PARTIAL/failed на каждом тике 45-дневного
# окна. Запись денег «как есть» НЕ меняется ни на копейку — меняется только
# маркировка (обычная info-строка вместо счётчика unresolved_posting_number).
SERVICE_UNIT_PREFIX_RE = re.compile(r"^sr\d+-")

# F3 (фикс-волна финального ревью 2026-08-18): зрелость юнита БЕЗ
# commission-блока меряется от возраста ЕГО ОПЕРАЦИЙ (last_date выше) — а не
# от факта, что заказ физически ещё в пути. Живой симптом до фикса: 48
# строк/−32 183 ₽ августа кабинета 1 с order.status delivering/awaiting_* —
# юнит "созревал" по возрасту операций (>= MATURITY_THRESHOLD_DAYS дней с
# последней логистической строки) ЗАДОЛГО до того, как Ozon его реально
# финализирует (commission-блок приходит только после доставки — см.
# калибровку лага выше). Если резолвится заказ tenant.ozon_orders в одном
# из этих статусов — юнит однозначно ЕЩЁ НЕ финализирован НЕЗАВИСИМО от
# возраста операций -> immature=True безусловно. Если заказ delivered/
# cancelled ИЛИ не резолвится вовсе (unit_number не найден в ozon_orders,
# например, отправление старше 45-дневного окна ozon_orders) — прежняя
# возрастная логика (MATURITY_THRESHOLD_DAYS) остаётся FALLBACK'ом (delivered
# без commission — законный редкий случай, см. регресс-тест 12; заказ не
# найден — статус неизвестен, возраст лучше, чем ничего).
IN_TRANSIT_ORDER_STATUSES = frozenset({"delivering", "awaiting_packaging", "awaiting_deliver"})


def _family_key(unit_number):
    """«Семейный» ключ unit_number для склейки сиблингов при группировке
    (merge_unit_siblings, задача 6 плана, round 3/4 фикс — task-6-report.md):
    Ozon иногда репортит РАЗНЫЕ типы начислений ОДНОГО реального отправления
    под РАЗНЫМИ сырыми unit_number — например, логистика под
    '0115022887-0449' (2-частная форма «префикс-заказ»), commission под
    '0115022887-0449-5' (та же форма + суффикс товара). Суффикс товара
    ВСЕГДА добавляется ПОСЛЕ уже полной 2-частной формы — поэтому ключ
    семьи это 2-частная форма: у строк с ≥2 дефисами срезается ПОСЛЕДНИЙ
    сегмент (суффикс товара), у строк с 1 дефисом (уже 2-частная форма)
    ключ — она сама.

    ⚠️ НЕ путать с построением order_meta_by_base в collect() (та срезает
    ВСЕГДА, `pn.rsplit("-", 1)[0] if "-" in pn else pn`) — её входы
    ИСКЛЮЧИТЕЛЬНО tenant.ozon_orders.posting_number, который по докстроке
    resolve_meta ГАРАНТИРОВАННО 3-частный (полная форма + суффикс товара
    несётся ВСЕГДА). Здесь входы — сырой unit_number начислений, который
    может быть И 2-частным (уже полная форма), И 3-частным — слепое
    применение той же логики (срезать всегда) ошибочно схлопнуло бы РАЗНЫЕ
    отправления, делящие общий числовой префикс: живой пример находки —
    '0229108520-0830' и '0229108520-0831' — ДВА РАЗНЫХ отправления (оба
    2-частные, НЕ братья, отличаются номером заказа), тогда как
    '0229108520-0831' и '0229108520-0831-1' — братья (тот же заказ, второй
    несёт суффикс товара)."""
    return unit_number.rsplit("-", 1)[0] if unit_number.count("-") >= 2 else unit_number


def _has_commission_block(rows):
    """Есть ли среди строк юнита commission-блок (POSTING, type_id IS NULL —
    та же граница, что и bucket 'commission' в ozon_profit_map.classify_row,
    записана здесь явно ради простоты и независимости от исполнения
    classify_row при склейке ДО построения commission_rows внутри
    build_order_costs)."""
    return any(r.get("accrued_category") == "POSTING" and r.get("type_id") is None for r in rows)


def merge_unit_siblings(by_unit):
    """Чистая функция (без БД): склеивает сиблингов base/suffix форм
    unit_number в ОДНУ группу СТРОК, когда РОВНО ОДИН член «семьи»
    (_family_key) несёт commission-блок (задача 6 плана «ремонт данных
    прибыли Ozon», round 3/4 фикс, task-6-report.md). Возвращает НОВЫЙ dict
    (исходный by_unit не мутируется — чистота ради теста без БД,
    scripts/check-ozon-profit-calc.py) и статистику:
        {'merged_units': [(canonical_unit_number, [merged_away, ...]), ...],
         'ambiguous_families': [(family_key, [commission_members, ...]), ...]}

    Правила (симметрично по направлению — не важно, у КАКОЙ формы
    commission-блок):
      • семья из 1 члена — нечего сливать;
      • РОВНО ОДИН член семьи несёт commission-блок — остальные (без
        commission) сливаются В НЕГО (canonical = commission-несущий член,
        его unit_number становится ключом объединённой группы и, ниже по
        цепочке build_order_costs, её src_unit_number — «суффиксная форма
        как основная», если commission именно под суффиксом, но правило
        симметрично: canonical — ЛЮБОЙ член семьи с commission, независимо
        от того, base он или suffix);
      • НОЛЬ членов семьи несёт commission — сливать некуда, все остаются
        независимыми (по-прежнему могут быть учтены сборщиком как
        отдельные, «настоящие» юниты без продажи — маршрут: возврат/сервис,
        либо порог зрелости MATURITY_THRESHOLD_DAYS, если совсем свежие);
      • ДВА И БОЛЕЕ членов семьи несут commission-блок — НЕОДНОЗНАЧНО (не
        решить, к какому из них относится остальная часть семьи без
        commission) — НЕ склеивается, попадает в ambiguous_families для
        счётчика/лога в collect(), юниты обрабатываются раздельно как
        обычно."""
    merged = {u: list(rows) for u, rows in by_unit.items()}
    families = defaultdict(list)
    for u in merged:
        families[_family_key(u)].append(u)

    merged_units = []
    ambiguous_families = []
    for fam_key, members in families.items():
        if len(members) < 2:
            continue
        commission_members = [m for m in members if _has_commission_block(merged[m])]
        if len(commission_members) == 1:
            canonical = commission_members[0]
            merged_away = [m for m in members if m != canonical]
            for m in merged_away:
                merged[canonical].extend(merged[m])
                del merged[m]
            merged_units.append((canonical, merged_away))
        elif len(commission_members) >= 2:
            ambiguous_families.append((fam_key, commission_members))
        # len(commission_members) == 0: сиблинги есть, но ни у кого нет
        # commission-блока — сливать некуда, члены остаются независимыми.
    return merged, {"merged_units": merged_units, "ambiguous_families": ambiguous_families}


def _expand_to_families(touched_unit_numbers, candidate_unit_numbers):
    """Чистая функция (без БД): расширяет touched-юниты окна до ПОЛНЫХ
    семей (F1, фикс-волна финального ревью 2026-08-18 — .superpowers/sdd/
    2026-08-17-ozon-data-repair/). БЕЗ этого шага C1 (см. докстроку модуля)
    расширяет только САМИ строки уже известных touched-юнитов, а не состав
    множества — если в окно попал РОВНО ОДИН член семьи (например, база
    датирована событием старше 45-дневного lookback, а суффиксная форма —
    свежим), history_rows в collect() подтягивает историю ТОЛЬКО этого
    члена, merge_unit_siblings честно собирает "семью" из одного — и
    пересборка ЗАТИРАЕТ ранее склеенную (полными деньгами обоих братьев)
    строку order_costs усечённой версией. Живой пример ревью:
    unit_number '0147423989-0115-1' (суффикс, попал в окно) при отсутствующем
    в touched '0147423989-0115' (база, начисления старше окна) — без этой
    функции пересборка теряет деньги базы.

    candidate_unit_numbers — ШИРОКИЙ (по префиксу базы) SQL-суперсет:
    вызывающий код (collect()) достаёт его дешёвым запросом по индексу
    unit_number by prefix/exact match — сам SQL НЕ решает принадлежность к
    семье (см. предупреждение в докстроке _family_key: наивный срез хвоста
    в SQL сам по себе НЕ равнозначен family_key). Точная фильтрация —
    ЕДИНСТВЕННЫМ источником истины _family_key() — происходит здесь, в
    питоне, чтобы не дублировать/не расходиться с merge_unit_siblings.

    Возвращает НОВЫЙ отсортированный список (touched_unit_numbers ∪
    настоящие члены семей из candidate_unit_numbers)."""
    family_keys = {_family_key(u) for u in touched_unit_numbers}
    members = {u for u in candidate_unit_numbers if _family_key(u) in family_keys}
    return sorted(set(touched_unit_numbers) | members)


def _num(v):
    return 0.0 if v is None else float(v)


def _row_date(v):
    """Дата строки начислений: из БД приходит datetime.date, из фикстур/тестов
    (JSON) — уже str. str() приводит оба варианта к 'YYYY-MM-DD'."""
    return None if v is None else str(v)


def build_order_costs(accrual_rows: list, meta: dict, costs: dict, today: str = None):
    """Чистая функция (без БД): одно отправление → строка tenant.ozon_order_costs.

    accrual_rows — строки tenant.ozon_accruals ОДНОГО unit_number (категории
    POSTING/ITEM, unit_number IS NOT NULL — вызывающий код (collect())
    группирует по unit_number ДО вызова, СНАЧАЛА пропустив группы через
    merge_unit_siblings — см. докстроку). Порядок строк не важен.
    meta — метаданные заказа: {'product_id', 'size', 'order_dt', 'qty',
    'status', 'posting_number', 'posting_number_resolved'} — см. resolve_meta()
    (product_id/size/order_dt тем же способом, что в v1, читались из
    ozon_orders и там же остаются; qty добавлен явно — tenant.ozon_accruals
    не несёт qty, в отличие от старого ozon_finance_report.item_qty, поэтому
    источник qty сместился на ozon_orders.qty, семантика "штук в
    отправлении" не изменилась; status — ozon_orders.status, используется
    ТОЛЬКО для порога зрелости юнита без commission-блока (F3, фикс-волна
    финального ревью 2026-08-18, см. IN_TRANSIT_ORDER_STATUSES); posting_
    number/posting_number_resolved — см. ниже).
    costs — cogs_map: {product_id: cost} из tenant.cost_overrides (как в v1).
    today — ISO-дата 'YYYY-MM-DD' для порога зрелости (см. MATURITY_
    THRESHOLD_DAYS); None → datetime.now(timezone.utc).date() (прод). Тесты
    передают явно ради детерминизма (scripts/check-ozon-profit-calc.py).

    ⚠️ ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (не устранено, унаследовано от v1): модель
    «1 unit_number = 1 запись order_costs» не различает товары ВНУТРИ
    мультитоварного отправления. product_id в meta резолвится (см.
    resolve_meta) по ПЕРВОМУ ненулевому sku строк отправления — если в
    отправлении несколько разных SKU, колонка product_id получит только
    один из них (какой именно — зависит от порядка строк ответа Ozon,
    гарантий стабильности порядка нет). v1 вёл себя так же (брал
    product_id первой попавшейся строки/последней строки ozon_orders при
    dict-перезаписи) — это не регресс, а тот же класс упрощения, что и
    раньше. cost_value_retail/commission/services/logistics/acquiring/
    loyalty — ДЕНЕЖНЫЕ суммы отправления ЦЕЛИКОМ (не одного SKU), поэтому
    финансово корректны независимо от того, чей product_id записан.

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
    или записан fallback'ом как unit_number), 'immature' (bool — задача 6
    плана, round 3/4: юнит без commission-блока, младше MATURITY_
    THRESHOLD_DAYS — collect() ОБЯЗАН пропустить запись этой строки вовсе
    (не писать в БД), см. докстроку модуля/MATURITY_THRESHOLD_DAYS; при
    immature=True sale_dt и return_dt ОБА None — это не «инвариант датировки
    нарушен», а осознанный сигнал «рано» collect()).
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
    services_raw = 0.0
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
        elif bucket == "services":
            services_raw += _num(r.get("accrued"))
        else:  # 'logistics' — строго перевозка/обработка отправлений и
               # возвратов (см. ozon_profit_map.PER_ORDER_LOGISTICS_TYPE_IDS).
               # Незнакомые позаказные типы больше НЕ сюда — они в 'services'
               # (копилка «прочие сборы», known=False), чтобы роуты панели,
               # вычитающие logistics целиком, по-прежнему ничего не теряли
               # молча (см. докстроку ozon_profit_map.py).
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
    # (profit = revenue − cost − commission − services − logistics − acquiring − loyalty)
    # корректно ДОБАВЛЯЕТ этот возврат к прибыли). Найдено тестом
    # scripts/check-ozon-profit-calc.py на реальных строках фикстуры
    # (unit 02464949-0474, 63981463-0371) — та же логика (сумма корзины,
    # затем -sum) теперь применена и к commission (несколько строк), см.
    # docs/superpowers/specs/2026-08-15-ozon-profit-switch-design.md.

    commission_accrued_sum = sum(_num(r.get("accrued")) for r in commission_rows)
    seller_price_sum = sum(_num(r.get("seller_price")) for r in commission_rows)

    # Полное сторно (третья ветка is_return ниже) — ПО КАЖДОМУ sku ОТДЕЛЬНО,
    # не по сумме всех commission-блоков юнита (пробел ревью фикса возврата
    # через полное сторно, 2026-08-21, найден ДО прода): мультитоварное
    # отправление может нести один sku, полностью возвращённый (его блоки
    # гасят друг друга в ноль), И другой sku, реально проданный (net>0) —
    # суммарный Σ seller_price ВСЕГО юнита при этом может СЛУЧАЙНО попасть в
    # допуск ±0.01 (например, проданный товар на копейки дешевле
    # возвращённого), и юнит-по-сумме пометил бы is_return=1 ВЕСЬ юнит,
    # обнулив COGS реально проданного sku. На живых 20 строках фикса это не
    # проявилось (n_skus=1 у всех — не гарантия кода, свойство данных).
    # commission-строка без sku (None) — своя отдельная группа (безопасный
    # дефолт: не смешивается с реальными sku).
    commission_by_sku = defaultdict(list)
    for r in commission_rows:
        commission_by_sku[r.get("sku")].append(r)
    full_storno_all_skus = bool(commission_by_sku) and all(
        abs(sum(_num(rr.get("seller_price")) for rr in rows)) <= _RETURN_NET_TOLERANCE
        and any(_num(rr.get("seller_price")) < 0 for rr in rows)
        for rows in commission_by_sku.values()
    )

    # is_return: коды 45/59 (RETURN_TYPE_IDS) ИЛИ отрицательный commission-блок
    # (реверс уже начисленной продажи, суммарно по ВСЕМ commission-строкам)
    # ИЛИ ПОЛНОЕ СТОРНО через ПАРУ (и более) commission-блоков (находка
    # владельца, заказ 0131642813-0453-1, 2026-08-21): 10.08 блок +1378
    # (продажа), 17.08 второй блок −1378 (сторно) + возвратные сборы ITEM
    # 38/39 (PackageCost/PackingFee — bucket 'services', НЕ RETURN_TYPE_IDS,
    # см. ozon_profit_map.py) — ни первая, ни вторая ветка выше это НЕ ловят:
    # commission_accrued_sum ≈ 0 (не < 0 — блоки гасят друг друга ровно, не
    # уходят в минус), поэтому вторая ветка молчит; RETURN_TYPE_IDS среди
    # строк тоже нет. Признак: >1 commission-блока И у КАЖДОГО sku юнита
    # (full_storno_all_skus выше) чистая Σ seller_price ЕГО блоков ≈ 0
    # (допуск _RETURN_NET_TOLERANCE) И среди его блоков есть отрицательный
    # (иначе Σ≈0 при ВСЕХ неотрицательных блоках sku — вырожденный случай
    # нулевых цен, не сторно). НЕ путать с частичным сторно/корректировкой
    # цены (пара блоков вида +1378/−400 → Σ=978, не ≈0 — остаётся продажей
    # с cost), с легитимной склейкой семьи из НЕСКОЛЬКИХ товаров отправления
    # (Σ>0 — тоже не ≈0), и с мультитоварным юнитом, где вернулся ТОЛЬКО
    # один sku из нескольких (хотя бы у одного sku net не ≈0 —
    # full_storno_all_skus=False, юнит остаётся продажей с cost, известное
    # ограничение модели «1 unit_number = 1 запись», см. докстроку выше).
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
    elif len(commission_rows) > 1 and full_storno_all_skus:
        is_return = 1
        commission_dates = [_row_date(r.get("date")) for r in commission_rows
                             if r.get("date") is not None]
        return_dt = min(commission_dates) if commission_dates else None

    seller_price = seller_price_sum
    commission_raw = sum(_num(r.get("sale_commission")) for r in commission_rows)
    sale_dates = [_row_date(r.get("date")) for r in commission_rows if r.get("date") is not None]
    sale_dt = min(sale_dates) if sale_dates else None

    # Датировка юнитов БЕЗ commission-блока (задача 3 плана «ремонт данных
    # прибыли Ozon», §2): такой юнит не несёт ни одной commission-строки,
    # поэтому sale_dt выше остаётся None ВСЕГДА (sale_dates строится только
    # из commission_rows) — а return_dt остаётся None тоже, если is_return не
    # взведён строками RETURN_TYPE_IDS (см. return_dates выше). Правило: min
    # (date) ВСЕХ строк юнита (не только commission/return-типных) →
    # return_dt, если юнит возвратный (та же is_return, что уже вычислена
    # выше), иначе → sale_dt. Применяется ТОЛЬКО когда commission-блока нет
    # вовсе — юнит С commission-блоком датируется как раньше (регресс-
    # проверка scripts/check-ozon-profit-calc.py, п.12: правило первой
    # операции НЕ должно "утекать" на несвязанную более раннюю логистическую
    # строку).
    #
    # ⚠️ ПОРОГ ЗРЕЛОСТИ (задача 6 плана «ремонт данных прибыли Ozon», round 3
    # фикс — task-6-report.md; см. MATURITY_THRESHOLD_DAYS выше для полной
    # калибровки): если юнит is_return=0 (значит return_dt УЖЕ был бы
    # проставлен веткой return_dates выше, будь он возвратным — is_return==1
    # без commission_rows возможен ТОЛЬКО через return_dates, см. return_dates
    # выше, поэтому return-ветка ниже применяется БЕЗУСЛОВНО, порог зрелости
    # к ней неприменим — у возвратного юнита дата и деньги уже есть) —
    # применяется правило первой операции ТОЛЬКО если юнит «созрел»:
    # последняя операция юнита (max(date) его строк) старше
    # MATURITY_THRESHOLD_DAYS дней. Иначе — юнит «immature»: даты остаются
    # None (ОБЕ), collect() строку СОВСЕМ НЕ ПИШЕТ (владелец, продуктовое
    # решение: товар в пути/только доставлен без финализации Ozon НЕ должен
    # показывать фантомный убыток −логистика−cost — видимость статуса без
    # финансов даёт /orders через pending-ветку, см. app/api/cabinets/[id]/
    # orders/route.js).
    # F3 (фикс-волна финального ревью 2026-08-18, см. IN_TRANSIT_ORDER_
    # STATUSES выше): если заказ резолвится в ozon_orders и его статус —
    # "физически ещё в пути" (delivering/awaiting_packaging/awaiting_deliver),
    # юнит immature БЕЗУСЛОВНО, независимо от возраста операций — возраст
    # (last_date) больше НЕ проверяется в этой ветке. Иначе (delivered/
    # cancelled/статус неизвестен — заказ не резолвился) — прежняя возрастная
    # логика как fallback.
    immature = False
    if not commission_rows:
        all_dates = [_row_date(r.get("date")) for r in accrual_rows if r.get("date") is not None]
        first_date = min(all_dates) if all_dates else None
        if is_return:
            return_dt = first_date
        elif meta.get("status") in IN_TRANSIT_ORDER_STATUSES:
            immature = True
        else:
            last_date = max(all_dates) if all_dates else None
            ref_today = today or datetime.now(timezone.utc).date().isoformat()
            age_days = ((date.fromisoformat(ref_today) - date.fromisoformat(last_date)).days
                        if last_date is not None else None)
            is_mature = age_days is not None and age_days >= MATURITY_THRESHOLD_DAYS
            if is_mature:
                sale_dt = first_date
            else:
                immature = True

    commission_sum = round(-commission_raw, 2)
    services_sum = round(-services_raw, 2)
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
    # commission/services/logistics/acquiring/loyalty/profit) на месте. Счётчик "без
    # товара" считает collect() по result["product_id"] is None (переименован
    # честно из skipped_no_product — строки больше не пропускаются).
    # ФИКС фантомного COGS (находка владельца, заказ 09609165-0986-1,
    # 2026-08-21): себестоимость списывается ТОЛЬКО когда была ФАКТИЧЕСКАЯ
    # продажа юнита — признак: наличие commission-блока (POSTING, type_id
    # IS NULL, commission_rows выше) — Ozon выставляет эту строку
    # ИСКЛЮЧИТЕЛЬНО когда товар реально продан/доставлен (см. докстроку
    # модуля/_has_commission_block). ДО фикса cost списывался БЕЗУСЛОВНО на
    # ЛЮБОЙ юнит с резолвленным product_id — включая отменённые/невыкупленные
    # и чисто сервисные (эквайринг-сторно и т.п.) юниты без единой продажи.
    # Живой пример: 09609165-0986-1 — отменён, начисления ~0 (эквайринг
    # +30,51/−30,51), но cost=1540 списывался ВСЕГДА -> profit=−1540 без
    # всякой продажи. Масштаб (saas_ro, контролёр): кабинет 1 — 607 строк,
    # 235 885 ₽ фантомного COGS за год; кабинет 1008 — 0 (cost_overrides не
    # заданы). Юнит без commission-блока -> cost=0.0 ЯВНО (не None — None
    # означает «cost неизвестен», а не «списывать нечего», см. ниже),
    # profit = sum_accrued.
    #
    # ⚠️ ВОЗВРАТЫ (is_return=1) — РАСШИРЕНИЕ гейтинга has_sale, политика
    # владельца 2026-08-21 (прямое продолжение фикса фантомного COGS выше,
    # тем же днём, дословная цитата): «В возвратах должна учитываться только
    # расходка на них, себестоимость не учитывается, потому что часть из них
    # идут заново в продажу».
    #
    # Это ПЕРЕСМАТРИВАЕТ решение, записанное чуть выше (юнит is_return=1 С
    # commission-блоком — cost раньше НЕ зануляли, сверяясь с v1/WB/каноном).
    # Та сверка была верна как описание того, что БЫЛО — но владелец явно
    # выбрал ДРУГУЮ бизнес-политику для панели: товар физически вернулся на
    # склад и может уйти в повторную продажу — списывать его себестоимость
    # НАВСЕГДА в момент возврата (а затем ещё раз при повторной продаже,
    # если товар переоформляется новым юнитом) задваивает списание. В
    # возврате остаётся только фактическая РАСХОДКА на сам возврат —
    # логистика/комиссия возврата из начислений (sum_accrued), COGS всегда 0.
    # v1/WB/канон при этом объявляются УСТАРЕВШИМИ на этот счёт, не эталоном
    # (WB — worker/collectors/wb_order_costs.py — несёт ТОТ ЖЕ баг незанулённого
    # cost при is_return=1, см. докстроку модуля; сознательно НЕ чинится этой
    # правкой — отдельное решение владельца, WB-модель accrual устроена иначе
    # (ppvz_for_pay), см. GATE_CHECKS/отчёт задачи).
    #
    # Итог: has_sale теперь означает «была продажа И она НЕ вернулась» —
    # is_return=1 гасит has_sale БЕЗУСЛОВНО, независимо от commission-блока:
    #   • is_return=1 БЕЗ commission-блока — уже было cost=0 (класс «юнит без
    #     продажи», см. выше) — без изменений;
    #   • is_return=1 С commission-блоком (реальная продажа была, товар
    #     вернулся) — cost=0 ТЕПЕРЬ ТОЖЕ (было: cost из cost_overrides,
    #     реальный убыток) — profit = sum_accrued (только расходка возврата:
    #     логистика/комиссия возврата из начислений, знак уже учтён в
    #     accrued), COGS в profit не участвует;
    #   • is_return=0 — без изменений (has_sale определяется только
    #     commission-блоком, как раньше).
    has_sale = bool(commission_rows) and not is_return
    product_id = meta.get("product_id")
    if has_sale:
        cost = costs.get(product_id) if product_id is not None else None
    else:
        cost = 0.0

    sum_accrued = round(sum(_num(r.get("accrued")) for r in accrual_rows), 2)
    profit = round(sum_accrued - _num(cost), 2)

    comps = round(cost_value_retail - commission_sum - services_sum - logistics_sum
                  - acquiring_sum - loyalty_sum, 2)
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
        "services": round(services_sum, 2),
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
        "immature": immature,
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
        "status": meta.get("status"),
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

    # F1 (фикс-волна финального ревью 2026-08-18, критично — см. докстроку
    # _expand_to_families): touched_unit_numbers ВЫШЕ — по ЮНИТАМ окна, не по
    # СЕМЬЯМ (merge_unit_siblings/_family_key). Расширяем до полных семей
    # ДЕШЁВЫМ SQL по префиксу базы (candidate-суперсет), точную
    # принадлежность решает ТОЛЬКО _family_key() в питоне (_expand_to_families).
    family_keys = sorted({_family_key(u) for u in touched_unit_numbers})
    family_candidates = db_pg.query(
        "SELECT DISTINCT unit_number FROM tenant.ozon_accruals "
        "WHERE unit_number = ANY(%s) OR unit_number LIKE ANY(%s)",
        [family_keys, [fk + "-%" for fk in family_keys]]) if family_keys else []
    touched_unit_numbers = _expand_to_families(
        touched_unit_numbers, [r["unit_number"] for r in family_candidates])

    history_rows = db_pg.query(
        "SELECT accrual_id, line_no, date, unit_number, accrued_category, type_id, sku, "
        "accrued, seller_price, sale_price, sale_commission, coinvestment, bonus "
        "FROM tenant.ozon_accruals WHERE unit_number = ANY(%s) "
        "ORDER BY unit_number, accrual_id, line_no",
        [touched_unit_numbers]) if touched_unit_numbers else []

    by_unit = defaultdict(list)
    for r in history_rows:
        by_unit[r["unit_number"]].append(r)

    # Склейка сиблингов base/suffix форм unit_number (задача 6 плана, round
    # 3/4 фикс — task-6-report.md): ДО resolve_meta/build_order_costs, чтобы
    # объединённая группа обрабатывалась как ОДИН юнит с ПОЛНЫМИ деньгами
    # (commission + логистика вместе), а не как два независимых (один —
    # фантомная «нулевая продажа», другой — недостача логистики). См.
    # merge_unit_siblings/_family_key выше.
    by_unit, _merge_stats = merge_unit_siblings(by_unit)
    merged_sibling_count = sum(len(away) for _, away in _merge_stats["merged_units"])
    ambiguous_sibling_families = _merge_stats["ambiguous_families"]
    for canonical, away in _merge_stats["merged_units"]:
        print(f"  склейка сиблингов unit_number: {away} -> {canonical} "
              f"(ровно один брат семьи несёт commission-блок)", file=sys.stderr, flush=True)
    for fam_key, commission_members in ambiguous_sibling_families:
        print(f"  НЕОДНОЗНАЧНАЯ семья unit_number (база {fam_key}): "
              f"{len(commission_members)} братьев с commission-блоком "
              f"{sorted(commission_members)} — не склеено, юниты обработаны раздельно",
              file=sys.stderr, flush=True)

    # order_dt/size/product_id/posting_number — та же логика, что в v1
    # (SELECT из ozon_orders, словарь по posting_number, последняя строка
    # мульти-товарного отправления выигрывает — то же упрощение, что и
    # раньше). qty добавлен явно — см. докстроку build_order_costs (в
    # accruals qty нет). posting_number хранится В САМОЙ строке (SELECT
    # его возвращает) — используется resolve_meta() для восстановления
    # полного номера, когда unit_number начислений урезан (см. ниже). status
    # (F3, фикс-волна финального ревью 2026-08-18) — статус заказа Ozon,
    # используется build_order_costs для датировки юнитов без commission-
    # блока (см. IN_TRANSIT_ORDER_STATUSES/MATURITY_THRESHOLD_DAYS выше).
    order_meta = {r["posting_number"]: r for r in db_pg.query(
        "SELECT posting_number, order_dt, size, product_id, qty, status FROM tenant.ozon_orders")}
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
    # Инвариант датировки (задача 3 плана «ремонт данных прибыли Ozon», §2,
    # уточнён задачей 6 round 3/4): «после датировки НАПИСАННЫХ строк с NULL
    # в обеих датах быть не должно вовсе». До round 3 это было безусловно —
    # теперь юнит без commission-блока младше MATURITY_THRESHOLD_DAYS ВООБЩЕ
    # НЕ ПИШЕТСЯ (см. immature_count ниже) именно потому, что у него ОБЕ даты
    # были бы NULL — поэтому both_dates_null_count/«ИНВАРИАНТ ДАТИРОВКИ
    # НАРУШЕН» теперь диагностирует ТОЛЬКО генuinely недостижимый (по
    # конструкции build_order_costs) случай для НАПИСАННЫХ строк — оставлен
    # как защитная сетка на будущий регресс (например, схема ozon_accruals.
    # date перестанет быть NOT NULL), не активный сценарий сегодня.
    both_dates_null_count = 0
    # Незрелые юниты (задача 6 плана, round 3/4 фикс) — без commission-блока,
    # моложе MATURITY_THRESHOLD_DAYS: строка НЕ пишется вовсе (нули через
    # /orders pending-ветку, а не фантомный убыток). Их деньги НЕ попадают в
    # sum_order_accrued — это ОЖИДАЕМЫЙ, посчитанный (не потерянный молча)
    # разрыв: sum_immature_accrued явно вычитается из инварианта периода
    # ниже и печатается отдельной строкой лога; сторож видит их через
    # категорию no_row diagnostic (unit есть в начислениях, строки
    # order_costs — нет).
    immature_count = 0
    sum_immature_accrued = 0.0
    today_str = datetime.now(timezone.utc).date().isoformat()
    sum_order_accrued = 0.0

    for unit_number, unit_rows in by_unit.items():
        meta = resolve_meta(unit_number, unit_rows, order_meta, order_meta_by_base, product_by_sku)
        result = build_order_costs(unit_rows, meta, cogs_map, today=today_str)
        if result is None:
            # Теоретически недостижимо при непустом unit_rows (build_order_costs
            # возвращает None только для accrual_rows=[]) — защитная сетка,
            # не влияет на инвариант периода (строка не разнесена нигде).
            continue
        unknown_types.update(result.pop("unknown_types"))
        if result.pop("immature"):
            immature_count += 1
            sum_immature_accrued += round(sum(_num(r.get("accrued")) for r in unit_rows), 2)
            # 05.09.2026: сама по себе эта ветка mismatches не поднимает — но
            # per-unit print в stderr почти всегда оказывался ПОСЛЕДНЕЙ строкой
            # (при живом потоке заказов свежий незрелый юнит есть всегда), а
            # оркестратор в PARTIAL-статусе показывает именно err[-1]. Итог:
            # настоящая причина PARTIAL (например реальное расхождение
            # согласованности у другого юнита) маскировалась этим текстом,
            # и тик читался как «павший из-за незрелости» — хотя незрелость
            # тут ни при чём, это дизайн-шум (юнит дозревает за
            # MATURITY_THRESHOLD_DAYS, дописывается следующим прогоном в
            # окне 45 дней, деньги не теряются). Убираем per-unit print,
            # оставляем сводную info-строку после цикла — как sr-юниты,
            # коммит 1c7be55. Побочный эффект: теперь err[-1] в PARTIAL
            # покажет настоящую причину, если она есть.
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
            comps = (result["cost_value_retail"] - result["commission"] - result["services"]
                     - result["logistics"] - result["acquiring"] - result["loyalty"])
            unit_sum = round(sum(_num(r.get("accrued")) for r in unit_rows), 2)
            print(f"  расхождение согласованности: posting_number={unit_number} "
                  f"cost_value_retail-commission-services-logistics-acquiring-loyalty="
                  f"{comps:.2f} != SUM(accrued)={unit_sum:.2f}", file=sys.stderr, flush=True)
        result.pop("consistency_ok")
        if not result.pop("posting_number_resolved"):
            if SERVICE_UNIT_PREFIX_RE.match(unit_number):
                # Сервисный юнит (вывоз и т.п., см. SERVICE_UNIT_PREFIX_RE выше)
                # — не отправление, резолва и не будет; НЕ PARTIAL, просто info.
                print(f"  сервисный юнит (заявка на вывоз/сервисную операцию "
                      f"Ozon, не отправление), записан как есть: {unit_number}",
                      flush=True)
            else:
                unresolved_posting_number += 1
                print(f"  posting_number не резолвлен через ozon_orders, записан unit_number "
                      f"как есть: {unit_number}", file=sys.stderr, flush=True)
        order_costs_out.append(dict(result, _unit_number=unit_number))
        sum_order_accrued += sum(_num(r.get("accrued")) for r in unit_rows)

    if immature_count:
        print(f"  незрелых юнитов пропущено: {immature_count}, "
              f"дозреют в следующих прогонах", flush=True)

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
    invariant_diff_raw = round(total_read - allocated, 2)
    # Незрелые юниты (задача 6 плана, round 3/4) сознательно НЕ разнесены —
    # их деньги учтены отдельно (sum_immature_accrued), поэтому вычитаются
    # из невязки ДО сравнения с допуском, точно так же, как строки без
    # product_id (задача 3, §3) уже учтены в sum_order_accrued. Это не
    # подгонка допуска (_INVARIANT_TOLERANCE не меняется) — это честный учёт
    # ИЗВЕСТНОЙ, посчитанной и залогированной причины расхождения.
    invariant_diff = round(invariant_diff_raw - sum_immature_accrued, 2)
    if abs(invariant_diff) > _INVARIANT_TOLERANCE:
        mismatches += 1
        # (задача 3 плана, §3): строки без product_id больше не пропускаются
        # и не создают разрыв здесь — их деньги уже учтены в sum_order_accrued
        # (product_id может быть NULL, но строка всё равно написана и
        # разнесена). Оставшийся разрыв — другая причина (незнакомый тип,
        # арифметика) и требует отдельного разбора.
        print(f"  ИНВАРИАНТ НАРУШЕН: прочитано начислений на {total_read:.2f} ₽, "
              f"разнесено (order_costs + cabinet + promo) на {allocated:.2f} ₽, "
              f"незрелых (не разнесено осознанно) на {sum_immature_accrued:.2f} ₽, "
              f"остаточная разница {invariant_diff:+.2f} ₽", file=sys.stderr, flush=True)

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
    if merged_sibling_count:
        msg += (f", склеено сиблингов base/suffix формы (одна семья, один брат с "
                f"commission-блоком): {merged_sibling_count}")
    if ambiguous_sibling_families:
        msg += (f", неоднозначных семей unit_number (2+ братьев с commission-блоком, "
                f"не склеено): {len(ambiguous_sibling_families)}")
    if immature_count:
        msg += (f", незрелых юнитов (моложе {MATURITY_THRESHOLD_DAYS} дн., без "
                f"commission-блока, строка НЕ записана): {immature_count}, "
                f"Σ={sum_immature_accrued:.2f} ₽")
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
    print(f"##OBS rows={n_order + n_cabinet} from={eff_from} to={eff_to}", flush=True)
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
