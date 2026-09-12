"""
SaaS-сборщик ПОЗИЦИЙ ПО ПОИСКОВЫМ ЗАПРОСАМ Ozon из кабинета продавца →
tenant.ozon_sku_search_daily (SKU × день: средняя позиция, спрос, CTR) и
tenant.ozon_search_queries_daily (SKU × день × запрос: позиция, спрос, клики,
заказы, GMV). Источник — раздел кабинета «Запросы моих товаров»
(search-query-analytics v2), спека docs/superpowers/specs/2026-09-12-ozon-cabinet-
search-traffic-design.md §3.1–3.2.

Окно дня: periodFrom = d, periodTo = d+1 (правая граница ИСКЛЮЧАЮЩАЯ — один и
тот же день в обеих границах даёт NO_DATA, проверено 12.09.2026). Лаг кабинета —
до суток: день ещё не готов → сводка пуста → «day_not_ready», БД не трогаем.
Страницы запросов — по 10, pageNumber с нуля, конец — пустой список.

Порядок на день: сводка по всем SKU (один вызов) → запросы только по SKU из
сводки. Запись дня — одной транзакцией ПОСЛЕ всех вызовов (db_pg.replace_ozon_
search_day), чужие SKU дня не трогаются. Идемпотентно.

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

P_ITEMS = "/api/search-query-analytics/v2/get-seller-items-search-query-analytics"
P_DETAILS = "/api/search-query-analytics/v2/get-search-query-analytics-details"
PAGE_LIMIT = 200          # предохранитель: 10 запросов × 200 страниц на SKU
BUSY_RETRIES, BUSY_WAIT = 5, 60


def day_window(day):
    d = date.fromisoformat(day)
    return f"{d.isoformat()}T00:00:00Z", f"{(d + timedelta(days=1)).isoformat()}T00:00:00Z"


def _int(v):
    try:
        return int(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _float(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def parse_items_summary(resp, day, sku2pid):
    rows = []
    for it in resp.get("items") or []:
        sku = _int(it.get("sku"))
        if not sku:
            continue
        rows.append({
            "sku": sku, "date": day, "product_id": sku2pid.get(sku),
            "name": it.get("name") or None, "article": it.get("article") or None,
            "category": it.get("category") or None,
            "position": _int(it.get("position")),
            "search_users": _int(it.get("uniqueSearchUsers")),
            "view_users": _int(it.get("uniqueViewUsers")),
            "ctr": _float(it.get("queryCtr")), "gmv": _float(it.get("gmv")),
            "showcases_visibility": it.get("showcasesVisibility") or None,
        })
    return rows


def parse_query_page(resp, day, sku, pid):
    rows = []
    for q in resp.get("queries") or []:
        text = (q.get("query") or "").strip()
        if not text:
            continue
        rows.append({
            "sku": sku, "date": day, "query": text, "product_id": pid,
            "position": _int(q.get("position")),
            "search_users": _int(q.get("uniqueSearchUsers")),
            "view_users": _int(q.get("uniqueViewUsers")),
            "ctr": _float(q.get("queryCtr")),
            "click_users": _int(q.get("uniqueClickUsers")),
            "orders": _int(q.get("orderCount")), "gmv": _float(q.get("gmv")),
            "query_index": _int(q.get("queryIndex")),
        })
    return rows


def dedupe_queries(rows):
    seen, out = set(), []
    for r in rows:
        k = (r["sku"], r["query"])
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def fetch_day(client, company_id, day, sku2pid):
    """Все вызовы дня → (sku_rows, query_rows). Ничего не пишет."""
    pf, pt = day_window(day)
    summary = client.post(P_ITEMS, {"sellerId": company_id, "periodFrom": pf, "periodTo": pt,
                                    "itemsPerPage": 200, "pageNumber": 0})
    sku_rows = parse_items_summary(summary, day, sku2pid)
    query_rows = []
    for r in sku_rows:
        page = 0
        while page < PAGE_LIMIT:
            resp = client.get(P_DETAILS, {"sellerId": company_id, "sku": str(r["sku"]),
                                          "periodFrom": pf, "periodTo": pt, "pageNumber": str(page)})
            got = parse_query_page(resp, day, r["sku"], r["product_id"])
            if not got:
                break
            query_rows += got
            page += 1
    return sku_rows, dedupe_queries(query_rows)


def collect(date_from, date_to):
    probe = bool(os.environ.get("SAAS_PROBE"))
    company_id = os.environ.get("OZON_CABINET_COMPANY_ID", "")
    db_pg.init()
    sku2pid = db_pg.ozon_sku2pid()
    days = []
    d = date.fromisoformat(date_from)
    while d <= date.fromisoformat(date_to):
        days.append(d.isoformat())
        d += timedelta(days=1)
    print(f"[ozon_cabinet_search] дни {days[0]}..{days[-1]} | каталог {len(sku2pid)} sku", flush=True)

    total_sku = total_q = 0
    not_ready = []
    for attempt in range(1, BUSY_RETRIES + 1):
        try:
            with cc.from_env() as client:
                for day in days:
                    sku_rows, query_rows = fetch_day(client, company_id, day, sku2pid)
                    if not sku_rows:
                        not_ready.append(day)
                        print(f"  {day}: сводка пуста — day_not_ready", flush=True)
                        continue
                    if probe:
                        print(f"  PROBE {day}: {len(sku_rows)} sku, {len(query_rows)} запросов; "
                              f"первый sku {sku_rows[0]}; первый запрос {query_rows[0] if query_rows else None}", flush=True)
                        continue
                    n1, n2 = db_pg.replace_ozon_search_day(day, sku_rows, query_rows)
                    total_sku += n1
                    total_q += n2
                    print(f"  {day}: записано {n1} sku, {n2} запросов", flush=True)
            break
        except cc.CabinetBusyError as e:
            print(f"  профиль занят ({attempt}/{BUSY_RETRIES}): {e}", flush=True)
            if attempt == BUSY_RETRIES:
                print("cabinet_busy: профиль занят, тик пропущен", file=sys.stderr, flush=True)
                return 3
            cc.SLEEP(BUSY_WAIT)
        except cc.CabinetAuthError as e:
            print(f"CABINET_AUTH_EXPIRED: {e}", file=sys.stderr, flush=True)
            return 5

    print(f"[ozon_cabinet_search] итого {total_sku} sku, {total_q} запросов"
          + (f", не готовы: {','.join(not_ready)}" if not_ready else ""), flush=True)
    print(f"##OBS rows={total_sku + total_q} from={days[0]} to={days[-1]}", flush=True)
    return 3 if not_ready and len(not_ready) == len(days) else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    yday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    df = sys.argv[1] if len(sys.argv) > 1 else yday
    dt = sys.argv[2] if len(sys.argv) > 2 else df
    sys.exit(collect(df, dt))
