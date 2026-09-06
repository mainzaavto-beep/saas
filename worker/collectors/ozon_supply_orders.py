"""
SaaS-сборщик ЗАКАЗОВ НА ПОСТАВКУ Ozon (FBO) → tenant.ozon_supply_orders (+_items).

/v3/supply-order/list (курсор — непрозрачная строка last_id, все 11 кодов состояний) →
/v3/supply-order/get (пачки ≤50: orders[], склад назначения embedded в
supplies[].storage_warehouse — top-level warehouses[] в /v3 больше нет) →
/v1/supply-order/bundle (состав по bundle_id поставок, без изменений). Нужно
этапу 3 «Поставки» (связь документа отгрузки с фактом приёмки). qty_accepted
всегда NULL: поле принятого количества в ответе Ozon не найдено (проба
06.09.2026) — этап 3 берёт факт приёмки из отчёта приёмки руками.
ВАЖНО: /v2/supply-order/list и /v2/supply-order/get отключены Ozon (404) —
задача 9 перевела клиент на /v3 (иная форма запроса и ответа, см. докстринги
ozon_client.OzonClient.iter_supply_order_ids/supply_order_get).
Тик main. Аргументы дат игнорируются — тянем весь список (сотни строк).
SAAS_PROBE=1 — дамп list/get/bundle без записи.

Ревью раунд 1 (2026-09-06): заказы (orders) пишутся ДО цикла bundle — сбой
одного /v1/supply-order/bundle не откатывает весь прогон (только сам этот
заказ остаётся без позиций, счётчик — в логе и в exit-коде). bundle
запрашивается ТОЛЬКО для заказов, у которых состояние не финальное
(TERMINAL_STATES) или ещё нет ни одной строки состава — см.
db_pg.ozon_supply_orders_with_items_terminal(). Одиночные сбои bundle не
роняют прогон (ПРОПУСК только у полного сбоя list/get) — считаются и дают
exit 3 (partial, контракт orchestrator.py:80-82) при n_bundle_failed > 0.
Состав (items) пишется ИНКРЕМЕНТАЛЬНО каждые ITEMS_FLUSH_EVERY заказов (+
остаток после цикла) — на новом кабинете с длинной историей 900-секундный
таймаут тика раньше терял ВЕСЬ накопленный в памяти состав одним upsert'ом
после цикла и прогон никогда не сходился; теперь уже сброшенные пачки
переживают обрыв.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe
from ozon_client import OzonClient, OzonError

# Финальные состояния заказа на поставку — реально увиденные пробой 06.09.2026 на
# кабинете 1 (см. task-9-report.md): COMPLETED (поставка завершена), CANCELLED
# (отменена), OVERDUE (просрочен таймслот без отгрузки — дальнейших изменений
# состава не бывает). НЕ финальные (там же наблюдались, состав/статус ещё может
# измениться): ACCEPTANCE_AT_STORAGE_WAREHOUSE, IN_TRANSIT — заказ в процессе.
# Единый источник правды — db_pg._OZ_SUPPLY_TERMINAL_STATES (ревью раунд 1,
# 2026-09-06: раньше список дублировался здесь и там, правки могли разойтись).
TERMINAL_STATES = db_pg._OZ_SUPPLY_TERMINAL_STATES

# Каждые ITEMS_FLUSH_EVERY обработанных заказов — промежуточный upsert состава в
# БД (ревью раунд 1, 2026-09-06: раньше items копились в памяти весь цикл bundle
# и писались одним upsert'ом после него — на новом кабинете с длинной историей
# 900-секундный таймаут тика терял ВСЁ, прогон не сходился никогда). Число
# подобрано некритично — просто «не слишком часто» (upsert не бесплатен) и
# «не слишком редко» (не терять много при обрыве).
ITEMS_FLUSH_EVERY = 50

# Счётчик неудачных запросов /v1/supply-order/bundle последнего collect() — читает
# __main__ после вызова (по образцу ozon_accruals.py::_MISMATCHES).
_BUNDLE_FAILED = 0


def select_orders_for_bundles(bundles, skip):
    """bundles: {order_id: [bundle_id,…]} из parse_orders; skip: set order_id, чей
    состав уже известен и не изменится (db_pg.ozon_supply_orders_with_items_terminal).
    Возвращает bundles без order_id из skip. Чистая функция — юнит-тест без БД."""
    return {oid: bids for oid, bids in bundles.items() if oid not in skip}


def partial_exit_code(n_bundle_failed):
    """Контракт exit-кодов (orchestrator.py:80-82, по образцу
    ozon_accruals.py::partial_exit_code): >0 неудачных bundle-запросов → 3
    (partial — заказы и успевшие позиции всё равно записаны, падение по
    сигналу, не по данным). Иначе None. Чистая функция ради юнит-теста."""
    return 3 if n_bundle_failed else None


def parse_orders(get_res):
    """orders[] (/v3/supply-order/get, проба 06.09.2026) → (строки ozon_supply_orders,
    {order_id: [bundle_id,…]}).

    Поля /v3 отличаются от /v2 (документация на момент замысла): order_id (не
    supply_order_id), order_number (не supply_order_number), created_date (не
    creation_date), state — без префикса ORDER_STATE_ (голое "COMPLETED" и т.п.).
    Нет top-level "warehouses" — склад назначения embedded-объектом в каждой
    supplies[].storage_warehouse ({warehouse_id, name, address, arrival_date} или
    null). Для кроссдок/vDC-поставок (несколько supplies) storage_warehouse часто
    null у всех элементов — тогда dest_warehouse_id/name остаются NULL (это не баг,
    склад назначения ещё не определён на момент опроса)."""
    orders, bundles = [], {}
    for o in get_res.get("orders") or []:
        oid = o.get("order_id")
        if oid is None:
            continue
        oid = int(oid)
        ts = ((o.get("timeslot") or {}).get("timeslot") or {}) if isinstance(o.get("timeslot"), dict) else {}
        supplies = o.get("supplies") or []
        dest = next((s.get("storage_warehouse") for s in supplies if s.get("storage_warehouse")), None)
        orders.append({
            "order_id": oid, "number": o.get("order_number"), "state": o.get("state"),
            "created_at": o.get("created_date"),
            "timeslot_from": ts.get("from"), "timeslot_to": ts.get("to"),
            "dest_warehouse_id": int(dest["warehouse_id"]) if dest and dest.get("warehouse_id") is not None else None,
            "dest_warehouse_name": dest.get("name") if dest else None,
        })
        b = [s["bundle_id"] for s in supplies if s.get("bundle_id")]
        if b:
            bundles[oid] = b
    return orders, bundles


def parse_items(order_id, items, sku2pid):
    """items[] (/v1/supply-order/bundle, проба 06.09.2026 — путь и форма подтверждены,
    без изменений). Найдена находка: сам ответ Ozon уже несёт items[].product_id —
    используем как fallback, если sku нет в нашем каталоге ozon_products (sku2pid).
    Принятого количества (qty_accepted) в ответе НЕТ ни одного поля с «accepted»/
    «принят» — оставляем NULL; этап 3 «Поставки» берёт факт приёмки из отчёта
    приёмки руками (эндпоинт не найден)."""
    out = []
    for it in items or []:
        if it.get("sku") is None:
            continue
        sku = int(it["sku"])
        pid = sku2pid.get(sku)
        if pid is None and it.get("product_id") is not None:
            pid = int(it["product_id"])
        out.append({"order_id": int(order_id), "sku": sku, "product_id": pid,
                    "qty_declared": int(it.get("quantity") or 0), "qty_accepted": None})
    return out


def collect():
    global _BUNDLE_FAILED
    _BUNDLE_FAILED = 0
    print(f"[ozon_supply_orders] заказы на поставку FBO ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    cli = OzonClient()
    try:
        ids = list(cli.iter_supply_order_ids())
        if _probe.is_probe():
            _probe.dump("/v3/supply-order/list ids", ids, n=20)
            ids = ids[:5]
        get_res = cli.supply_order_get(ids) if ids else {"orders": []}
        if _probe.is_probe():
            _probe.dump("/v3/supply-order/get", get_res.get("orders") or [], n=2)
        orders, bundles = parse_orders(get_res)
    except OzonError as e:
        print(f"[ozon_supply_orders] ПРОПУСК: Ozon API недоступен ({e}) (exit 0)", flush=True)
        return 0

    if _probe.is_probe():
        for oid, bids in bundles.items():
            raw = cli.supply_order_bundle_items(bids)
            _probe.dump(f"/v1/supply-order/bundle {oid}", raw, n=3)
            break
        return 0

    # Заказы пишутся СРАЗУ, до цикла bundle — сбой одного bundle-запроса не должен
    # откатывать весь список заказов (ревью раунд 1, 2026-09-06).
    n_o = db_pg.upsert_ozon_supply_orders_many(orders)

    skip = db_pg.ozon_supply_orders_with_items_terminal()
    to_fetch = select_orders_for_bundles(bundles, skip)
    print(f"[ozon_supply_orders] bundles: fetched {len(to_fetch)}, "
          f"skipped {len(bundles) - len(to_fetch)} (финальные с составом)", flush=True)

    sku2pid = {int(r["fbo_sku"]): int(r["product_id"]) for r in
               db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL")}
    batch = []
    n_i = 0
    n_bundle_failed = 0
    for n_processed, (oid, bids) in enumerate(to_fetch.items(), start=1):
        try:
            raw = cli.supply_order_bundle_items(bids)
        except OzonError as e:
            print(f"[ozon_supply_orders] bundle заказа {oid} недоступен: {e}", flush=True)
            n_bundle_failed += 1
            continue
        batch.extend(parse_items(oid, raw, sku2pid))
        # Инкрементальный сброс — см. ITEMS_FLUSH_EVERY (ревью раунд 1, 2026-09-06):
        # 900-секундный таймаут тика на новом кабинете не должен терять весь состав.
        if n_processed % ITEMS_FLUSH_EVERY == 0:
            n_i += db_pg.upsert_ozon_supply_order_items_many(batch)
            batch = []

    n_i += db_pg.upsert_ozon_supply_order_items_many(batch)
    _BUNDLE_FAILED = n_bundle_failed
    if n_bundle_failed:
        print(f"[ozon_supply_orders] заказов {n_o}, позиций {n_i}, "
              f"bundle недоступен для {n_bundle_failed} из {len(to_fetch)}", flush=True)
    else:
        print(f"[ozon_supply_orders] заказов {n_o}, позиций {n_i}", flush=True)
    print(f"##OBS rows={n_o}", flush=True)
    return n_o


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
    _code = partial_exit_code(_BUNDLE_FAILED)
    if _code is not None:
        sys.exit(_code)
