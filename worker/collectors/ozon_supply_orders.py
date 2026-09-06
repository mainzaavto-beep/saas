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
        sku2pid = {int(r["fbo_sku"]): int(r["product_id"]) for r in
                   db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL")}
        items = []
        for oid, bids in bundles.items():
            raw = cli.supply_order_bundle_items(bids)
            if _probe.is_probe():
                _probe.dump(f"/v1/supply-order/bundle {oid}", raw, n=3)
                break
            items.extend(parse_items(oid, raw, sku2pid))
    except OzonError as e:
        print(f"[ozon_supply_orders] ПРОПУСК: Ozon API недоступен ({e}) (exit 0)", flush=True)
        return 0
    if _probe.is_probe():
        return 0
    n_o = db_pg.upsert_ozon_supply_orders_many(orders)
    n_i = db_pg.upsert_ozon_supply_order_items_many(items)
    print(f"[ozon_supply_orders] заказов {n_o}, позиций {n_i}", flush=True)
    print(f"##OBS rows={n_o}", flush=True)
    return n_o


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
