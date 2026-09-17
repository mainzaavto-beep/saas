"""
SaaS-сборщик ТРЁХ ЦЕН Ozon из кабинета продавца → tenant.ozon_prices (source='cabinet').
Цель — СОИНВЕСТ (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §4):
  marketing_seller_price — цена продавца с его акциями (то, что он получает);
  marketing_price        — цена для всех покупателей с соинвестом Ozon;
  marketing_oa_price     — цена с Ozon Картой.
Соинвест % = 1 − marketing_price / marketing_seller_price (считает роут unit/all).
Seller API этих цен не отдаёт (постскриптум спеки 2026-08-02) — только кабинет.
Два вызова: список товаров в продаже (list-by-filter, курсор, по 200) → item_id ↔
offer_id; цены батчами по 100 (get-common-prices). item_id кабинета = product_id
Seller API (проверено пробой 17.09.2026 — см. спеку §8); связка через
offer_id ↔ tenant.ozon_products как страховка.
Снимок на СЕГОДНЯ (argv-даты принимаются для совместимости с таймером и игнорируются);
второй тик дня перезаписывает. Идемпотентно.
Exit: 0 ok · 3 профиль занят · 5 сессия кабинета истекла (маркер CABINET_AUTH_EXPIRED)
· 1 прочее. SAAS_PROBE=1 — напечатать первые 5 товаров и НЕ писать.
Селф-тест парсеров: ozon_cabinet_selftest.py.
"""
import os
import sys
from datetime import date, datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg  # noqa: E402
import cabinet_client as cc  # noqa: E402

P_LIST = "/api/v1/products/list-by-filter"
P_PRICES = "/api/pricing-bff-service/v3/get-common-prices"
LIST_PAGE = 200
PRICE_BATCH = 100
BUSY_RETRIES, BUSY_WAIT = 5, 60


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def parse_list_page(resp):
    """products[] → {item_id: offer_id}; строки без offer_id пропускаются."""
    out = {}
    for pr in resp.get("products") or []:
        offer = (pr.get("part_item") or {}).get("offer_id")
        iid = pr.get("item_id")
        if iid is not None and offer:
            out[str(iid)] = offer
    return out


def parse_common_prices(resp, id2pid, day):
    """items[] → строки ozon_prices. Только товары из id2pid; строка без единой
    цены > 0 не пишется (нули кабинета — не цены)."""
    rows = []
    for it in resp.get("items") or []:
        pid = id2pid.get(str(it.get("item_id")))
        if pid is None:
            continue
        sp, mp, oa = _num(it.get("marketing_seller_price")), _num(it.get("marketing_price")), _num(it.get("marketing_oa_price"))
        if sp is None and mp is None and oa is None:
            continue
        rows.append({"product_id": pid, "date": day, "marketing_seller_price": sp,
                     "marketing_price": mp, "marketing_oa_price": oa})
    return rows


def fetch_id2offer(client, company_id):
    id2offer, cursor = {}, ""
    for _ in range(100):  # предохранитель: 100 × 200 = 20 000 товаров
        resp = client.post(P_LIST, {
            "company_id": company_id,
            "filters": {"search": "", "categories": [], "flags": []},
            "aggregate": {"parts": ["PART_ITEM"], "human_texts": True},
            "return_total_items": True, "visibility": "IN_SALE",
            "sort_by": "SORT_BY_CREATED_AT", "sort_dir": "SORT_DIRECTION_DESC",
            "limit": LIST_PAGE, "cursor": cursor})
        page = parse_list_page(resp)
        id2offer.update(page)
        new_cursor = resp.get("cursor") or ""
        if not page or not new_cursor or new_cursor == cursor:
            break
        cursor = new_cursor
    return id2offer


def fetch_prices(client, company_id, item_ids, id2pid, day):
    rows = []
    for i in range(0, len(item_ids), PRICE_BATCH):
        resp = client.post(P_PRICES, {"company_id": company_id, "item_ids": item_ids[i:i + PRICE_BATCH]})
        rows += parse_common_prices(resp, id2pid, day)
    return rows


def _id2pid(id2offer):
    """item_id → product_id: прямое совпадение с каталогом, иначе через offer_id."""
    offer2pid = {r["offer_id"]: int(r["product_id"]) for r in db_pg.query(
        "SELECT product_id, offer_id FROM tenant.ozon_products WHERE offer_id IS NOT NULL")}
    pids = set(offer2pid.values())
    out = {}
    for iid, offer in id2offer.items():
        if iid.isdigit() and int(iid) in pids:
            out[iid] = int(iid)
        elif offer in offer2pid:
            out[iid] = offer2pid[offer]
    return out


def _obs(n, day):
    print(f"##OBS rows={n} from={day} to={day}", flush=True)


def collect(date_from=None, date_to=None):
    probe = bool(os.environ.get("SAAS_PROBE"))
    company_id = os.environ.get("OZON_CABINET_COMPANY_ID", "")
    day = date.today().isoformat()
    db_pg.init()
    print(f"[ozon_cabinet_prices] снимок трёх цен кабинета на {day}", flush=True)
    for attempt in range(1, BUSY_RETRIES + 1):
        try:
            with cc.from_env() as client:
                id2offer = fetch_id2offer(client, company_id)
                id2pid = _id2pid(id2offer)
                missing = len(id2offer) - len(id2pid)
                print(f"  в продаже {len(id2offer)}, в каталоге {len(id2pid)}"
                      + (f", не связано {missing}" if missing else ""), flush=True)
                rows = fetch_prices(client, company_id, list(id2pid), id2pid, day)
                if probe:
                    for r in rows[:5]:
                        print(f"  PROBE {id2offer.get(str(r['product_id']), r['product_id'])}: {r}", flush=True)
                    _obs(0, day)
                    return 0
                if id2pid and not rows:
                    print("[ozon_cabinet_prices] FAIL: товары есть, цен нет", file=sys.stderr, flush=True)
                    _obs(0, day)
                    return 1
                n = db_pg.upsert_ozon_cabinet_prices_many(rows)
                print(f"[ozon_cabinet_prices] записано {n} товаров", flush=True)
                _obs(n, day)
                return 0
        except cc.CabinetBusyError as e:
            print(f"  профиль занят ({attempt}/{BUSY_RETRIES}): {e}", flush=True)
            if attempt == BUSY_RETRIES:
                print("cabinet_busy: профиль занят, тик пропущен", file=sys.stderr, flush=True)
                _obs(0, day)
                return 3
            cc.SLEEP(BUSY_WAIT)
        except cc.CabinetAuthError as e:
            print(f"CABINET_AUTH_EXPIRED: {e}", file=sys.stderr, flush=True)
            _obs(0, day)
            return 5
        except cc.CabinetError as e:
            print(f"cabinet_error: {e}", file=sys.stderr, flush=True)
            _obs(0, day)
            return 1
    return 3


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    yday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    df = sys.argv[1] if len(sys.argv) > 1 else yday
    dt = sys.argv[2] if len(sys.argv) > 2 else df
    sys.exit(collect(df, dt))
