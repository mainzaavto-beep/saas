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

Один сторож против молчаливой потери данных (добавлен по ревью задачи 3):
  - `row_sum_mismatch` — рантайм-сверка Σaccrued строк записи с её
    total_amount. Ловит любое неразобранное поле, в т.ч. container_fees
    (есть в каждой записи фикстуры, всегда null, поэтому не разобран —
    но если Ozon когда-нибудь заполнит его данными, тождество перестанет
    сходиться и сверка это заметит без угадывания структуры поля заранее).
    Расхождение не роняет сбор — считается и печатается в итоговой строке.

Пагинация по last_id реализована в accrual_by_day (2026-08-22), так что
многостраничные дни обрабатываются полностью. Защита от зацикливания
(повтор last_id, превышение потолка страниц) — исключение в методе.

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
    """/v1/finance/accrual/types → строки для shared.ozon_accrual_types.
    Записи без id пропускаем (PK type_id NOT NULL — незачем ловить сбой
    вставки на мусорной записи справочника)."""
    return [{"type_id": t.get("id"), "name": t.get("name"),
             "description": t.get("description")}
            for t in (raw_types or []) if t.get("id") is not None]


def row_sum_mismatch(accrual: dict, rows: list, tolerance: float = 0.01):
    """Сверка одной записи: сумма accrued разобранных строк должна равняться
    total_amount записи (см. докстроку модуля — формула для POSTING проверена
    на 37/37, но офлайн, на замороженной фикстуре). В рантайме структура
    ответа может дать неразобранное поле (например, container_fees — есть в
    каждой записи фикстуры, всегда null, но НИКОГДА не встречался заполненным
    и потому не разобран; появись он с данными — тождество перестанет
    сходиться) или незнакомую разновидность записи. Функция это ловит без
    попытки угадать структуру непроверенных полей: если сумма строк не
    сошлась с total_amount, возвращает разницу (row_sum - total_amount);
    иначе — None."""
    total_amount = _amount(accrual.get("total_amount"))
    if total_amount is None:
        return None
    row_sum = sum(r["accrued"] or 0.0 for r in rows)
    diff = row_sum - total_amount
    return diff if abs(diff) > tolerance else None



# Ревью fixwave задачи «переезд финансов Ozon» (F2, .superpowers/sdd/
# 2026-08-11-ozon-accrual-migration/): плановый прогон (run_saas_collect.sh,
# MAIN_COLLECTORS) вызывает этот сборщик с явным узким диапазоном −2..сегодня
# (DAYS_FROM=2, DAYS_TO=0). Раньше без аргументов сборщик брал ровно «вчера»
# (день) — с явными датами планового прогона получалось трёхдневное окно,
# упирающееся в сегодняшний ещё не досчитанный Ozon'ом день. Тот же приём,
# что и в worker/collectors/ozon_finance.py (см. его докстроку collect()):
# раздвигаем начало окна назад минимум на MIN_LOOKBACK_DAYS от конца, если
# запрошенный диапазон уже — ловит начисления, которые Ozon доначисляет по
# факту позже своей даты (возвраты, акты сверки на стыке месяца). Широкие
# явные бэкфиллы (date_from старше порога) не трогаем — там и так шире.
# Плюс к этому: конец окна никогда не позже вчера, даже если date_to явно
# передан как сегодня (как в плановом прогоне) — Ozon дополняет сегодняшний
# день в течение суток, собирать его раньше срока значит собрать неполным.
MIN_LOOKBACK_DAYS = 45


def resolve_window(date_from=None, date_to=None, *, today=None, cap_to_yesterday=True):
    """Вычислить фактический период сбора из CLI-аргументов даты (или их
    отсутствия). См. комментарий выше модуля MIN_LOOKBACK_DAYS. `today` —
    только для тестов (юнит-проверка без зависимости от реального времени),
    в проде не передаётся. Возвращает (d_from, d_to) — datetime.date.

    `cap_to_yesterday` (по умолчанию True, поведение не меняется для
    начислений/order_costs): конец окна не позже вчера — Ozon дополняет
    сегодняшний день в течение суток, финансовые методы собирать его раньше
    срока не должны. Параметризовано ради ozon_orders.py — у заказов
    противоположная семантика: статус СЕГОДНЯШНЕГО отправления нужен сразу
    (задача «Размораживание статусов ozon_orders»), поэтому там конец окна —
    сегодня (cap_to_yesterday=False), пол в MIN_LOOKBACK_DAYS дней тот же."""
    today = today or datetime.now(timezone.utc).date()
    yesterday = today - timedelta(days=1)
    ceiling = yesterday if cap_to_yesterday else today

    if date_to is None:
        d_to = ceiling
    elif isinstance(date_to, str):
        d_to = datetime.fromisoformat(date_to).date()
    else:
        d_to = date_to
    if d_to > ceiling:
        d_to = ceiling

    if date_from is None:
        d_from = d_to
    elif isinstance(date_from, str):
        d_from = datetime.fromisoformat(date_from).date()
    else:
        d_from = date_from

    floor = d_to - timedelta(days=MIN_LOOKBACK_DAYS)
    if d_from > floor:
        d_from = floor
    if d_from > d_to:
        d_from = d_to

    return d_from, d_to


# F4 ревью fixwave: счётчик расхождений строка/total_amount последнего
# запуска collect() — __main__ проверяет его после вызова и завершается
# кодом 3 (partial), см. worker/collectors/wb_finance.py::_SKIPPED_429 —
# тот же приём.
_MISMATCHES = 0


def partial_exit_code(mismatches: int):
    """Контракт exit-кодов (orchestrator.py:80-82): >0 расхождений
    строка/total_amount → 3 (partial, строки при этом всё равно записаны —
    падение не по данным, а по сигналу). Иначе None (обычный успех, __main__
    ничего не делает с кодом возврата). Вынесено чистой функцией ради
    юнит-теста без БД/API."""
    return 3 if mismatches else None


def collect(date_from=None, date_to=None):
    global _MISMATCHES
    print("[ozon_accruals] начисления /v1/finance/accrual/by-day", flush=True)
    db_pg.init()
    cli = OzonClient()

    d_from, d_to = resolve_window(date_from, date_to)

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
    mismatches = 0
    n_days = 0
    day = d_from
    while day <= d_to:
        data = cli.accrual_by_day(day)
        n_days += 1
        time.sleep(REQUEST_PAUSE_SEC)
        # Пагинация курсором last_id реализована в accrual_by_day (2026-08-22);
        # многостраничные дни — норма для крупных кабинетов, но видимость оставляем.
        if data.get("pages", 1) > 1:
            print(f"  {day}: {data['pages']} страниц начислений", flush=True)
        accruals = data.get("accruals") or [] if isinstance(data, dict) else []
        for acc in accruals:
            acc_rows = parse_accrual(acc)
            diff = row_sum_mismatch(acc, acc_rows)
            if diff is not None:
                mismatches += 1
                print(f"  расхождение: accrual_id={acc.get('accrual_id')} "
                      f"category={acc.get('accrued_category')} строки на {diff:+.2f} "
                      f"не совпали с total_amount (возможно, container_fees или другое "
                      f"неразобранное поле записи)", file=sys.stderr, flush=True)
            for row in acc_rows:
                if row["type_id"] is not None and row["type_id"] not in known_type_ids:
                    unknown_types.add(row["type_id"])
                rows.append(row)
        day = day + timedelta(days=1)

    written = db_pg.upsert_ozon_accruals_many(rows)
    msg = f"[ozon_accruals] дней {n_days}, строк {len(rows)}, записано {written}"
    if unknown_types:
        msg += f", незнакомых type_id: {len(unknown_types)} {sorted(unknown_types)}"
    if mismatches:
        msg += f", расхождений строки/total_amount: {mismatches}"
    print(msg, flush=True)
    print(f"##OBS rows={written} from={d_from} to={d_to}", flush=True)
    _MISMATCHES = mismatches
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
    code = partial_exit_code(_MISMATCHES)
    if code is not None:
        # Сообщение уже напечатано в stderr выше (по каждому расхождению) —
        # новое не изобретаем, только код возврата.
        sys.exit(code)
