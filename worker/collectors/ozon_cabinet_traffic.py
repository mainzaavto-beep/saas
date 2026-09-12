"""
SaaS-сборщик РАЗЛОЖЕНИЯ ТРАФИКА Ozon по SKU и дням из кабинета продавца →
tenant.ozon_sku_traffic_daily. Источник — таблица «Продажи моих товаров»
(charts/v3/table/by_sku), спека …/2026-09-12-ozon-cabinet-search-traffic-design.md §3.3.

Окно дня здесь ВКЛЮЧАЮЩЕЕ: date_from = date_to = d. Страницы по 30 SKU
(limit/offset, конец пагинации — пустой СЫРОЙ resp["items"], не отфильтрованный
результат парсера: страница может целиком состоять из строк без sku и это ещё
не конец). Метрики, которых кабинету не дали (подписка), пишутся NULL, не 0.
ДРР кабинета — справочная величина, канон ДРР панели не подменяет
(docs/metrics-contract.md §15.3).

Живьём 12.09.2026 обнаружено: тело запроса из спеки §3.3 без `sort` кабинет
отклоняет (`sort is required`), а `sort` списком `[{...}]` — тоже (`proto:
syntax error … unexpected token [`): сервер по факту ждёт `sort` ОДНИМ объектом
`{"key": ..., "order": "DESC"}`, не списком (в отличие от Seller API
`/v1/analytics/data` в ozon_client.py, где sort — список). Добавлено ниже.

Запись дня — одной транзакцией после всех страниц. Идемпотентно.
Exit: 0 ok · 3 partial (день не готов / профиль занят) · 5 сессия кабинета
истекла (маркер CABINET_AUTH_EXPIRED в stderr → orchestrator → cabinet_state).
argv: [date_from] [date_to] (YYYY-MM-DD), по умолчанию — вчера.
SAAS_PROBE=1 — напечатать разбор первого дня и НЕ писать.
Селф-тест парсеров: ozon_cabinet_selftest.py.
"""
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg  # noqa: E402
import cabinet_client as cc  # noqa: E402

P_BYSKU = "/api/site/seller-analytics/charts/v3/table/by_sku"
PAGE = 30
METRICS = ["revenue", "search_position", "total_views", "search_views", "pdp_views",
           "hits_search_to_cart", "hits_pdp_to_cart", "total_hits_to_cart",
           "conv_search_views_to_pdp", "conv_pdp_views_to_cart", "conv_hits_to_cart_to_order",
           "conv_views_to_order", "ordered_units", "delivered_units", "cancelled_units",
           "returned_units", "avg_price", "drr", "days_in_trafarets", "days_in_promo",
           "last_stock", "stockout_days"]
# ключ ответа кабинета → колонка (int / float / text)
_MAP = [("totalViews", "total_views", int), ("searchViews", "search_views", int), ("pdpViews", "pdp_views", int),
        ("hitsSearchToCart", "hits_search_to_cart", int), ("hitsPdpToCart", "hits_pdp_to_cart", int),
        ("totalHitsToCart", "total_hits_to_cart", int),
        ("convSearchViewsToPdp", "conv_search_to_pdp", float), ("convPdpViewsToCart", "conv_pdp_to_cart", float),
        ("convHitsToCartToOrder", "conv_cart_to_order", float), ("convViewsToOrder", "conv_views_to_order", float),
        ("orderedUnits", "ordered_units", int), ("deliveredUnits", "delivered_units", int),
        ("cancelledUnits", "cancelled_units", int), ("returnedUnits", "returned_units", int),
        ("revenue", "revenue", float), ("avgPrice", "avg_price", float), ("priceIndex", "price_index", str),
        ("drr", "drr", float), ("daysInTrafarets", "days_in_trafarets", int), ("daysInPromo", "days_in_promo", int),
        ("searchPosition", "search_position", int), ("lastStock", "last_stock", int),
        ("lastStockFbo", "last_stock_fbo", int), ("lastStockFbs", "last_stock_fbs", int),
        ("stockoutDays", "stockout_days", int)]
BUSY_RETRIES, BUSY_WAIT = 5, 60


def _cast(v, typ):
    if v in (None, ""):
        return None
    try:
        return typ(v) if typ is not str else str(v)
    except (TypeError, ValueError):
        return None


def parse_traffic_page(resp, day, sku2pid):
    rows = []
    for it in resp.get("items") or []:
        info, m = it.get("productInfo") or {}, it.get("metrics") or {}
        sku = _cast(info.get("sku"), int)
        if not sku:
            continue
        row = {"sku": sku, "date": day, "product_id": sku2pid.get(sku)}
        for src, col, typ in _MAP:
            row[col] = _cast(m.get(src), typ)
        rows.append(row)
    return rows


def fetch_day(client, day, sku2pid):
    rows, offset = [], 0
    while True:
        resp = client.post(P_BYSKU, {
            "current_period": {"date_from": day, "date_to": day},
            "filters": {"desc_type_ids": [], "category_3_ids": [], "category_2_ids": []},
            "sort": {"key": "ordered_units", "order": "DESC"},
            "limit": str(PAGE), "offset": str(offset), "metrics": METRICS})
        raw = resp.get("items") or []
        if not raw:
            break
        rows += parse_traffic_page(resp, day, sku2pid)
        offset += PAGE
        if offset > 10000:
            break
    return rows


def _obs(total, days):
    print(f"##OBS rows={total} from={days[0]} to={days[-1]}", flush=True)


def collect(date_from, date_to):
    probe = bool(os.environ.get("SAAS_PROBE"))
    db_pg.init()
    sku2pid = db_pg.ozon_sku2pid()
    days, d = [], date.fromisoformat(date_from)
    while d <= date.fromisoformat(date_to):
        days.append(d.isoformat())
        d += timedelta(days=1)
    print(f"[ozon_cabinet_traffic] дни {days[0]}..{days[-1]} | каталог {len(sku2pid)} sku", flush=True)

    total, not_ready = 0, []
    for attempt in range(1, BUSY_RETRIES + 1):
        try:
            with cc.from_env() as client:
                for day in days:
                    rows = fetch_day(client, day, sku2pid)
                    if not rows:
                        not_ready.append(day)
                        print(f"  {day}: пусто — day_not_ready", flush=True)
                        continue
                    if probe:
                        print(f"  PROBE {day}: {len(rows)} sku; первый {rows[0]}", flush=True)
                        continue
                    n = db_pg.replace_ozon_traffic_day(day, rows)
                    total += n
                    print(f"  {day}: записано {n} sku", flush=True)
            break
        except cc.CabinetBusyError as e:
            print(f"  профиль занят ({attempt}/{BUSY_RETRIES}): {e}", flush=True)
            if attempt == BUSY_RETRIES:
                print("cabinet_busy: профиль занят, тик пропущен", file=sys.stderr, flush=True)
                _obs(total, days)
                return 3
            cc.SLEEP(BUSY_WAIT)
        except cc.CabinetAuthError as e:
            print(f"CABINET_AUTH_EXPIRED: {e}", file=sys.stderr, flush=True)
            _obs(total, days)
            return 5
        except cc.CabinetError as e:
            print(f"cabinet_error: {e}", file=sys.stderr, flush=True)
            _obs(total, days)
            return 1

    print(f"[ozon_cabinet_traffic] итого {total} строк"
          + (f", не готовы: {','.join(not_ready)}" if not_ready else ""), flush=True)
    _obs(total, days)
    return 3 if not_ready and len(not_ready) == len(days) else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    yday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    df = sys.argv[1] if len(sys.argv) > 1 else yday
    dt = sys.argv[2] if len(sys.argv) > 2 else df
    sys.exit(collect(df, dt))
