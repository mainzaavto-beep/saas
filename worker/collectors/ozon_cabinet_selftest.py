"""Селф-тест парсеров сборщиков кабинета Ozon (без сети/БД) на фикстурах из
живых проб 12.09.2026 (только наши SKU). Запуск:
/opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_cabinet_selftest.py"""
import contextlib
import io
import os, sys
_D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _D); sys.path.insert(0, os.path.dirname(_D))
os.environ.setdefault("WB_SaaS_CABINET_ID", "1")
import ozon_cabinet_search as s  # noqa: E402

failed = 0
def check(name, cond, detail=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failed += 1

SKU2PID = {4988596186: 1001, 3988620820: 1002}

# ── окно дня: правая граница исключающая ──
check("окно дня", s.day_window("2026-09-10") == ("2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z"), s.day_window("2026-09-10"))

# ── сводка по SKU (get-seller-items-search-query-analytics v2) ──
ITEMS = {"items": [
    {"sku": "4988596186", "name": "TechStore 64 ГБ Карта памяти", "article": "карта 64", "category": "EPG",
     "uniqueSearchUsers": 32209, "position": 29, "uniqueViewUsers": 2785, "queryCtr": 3.1, "gmv": 8313,
     "currency": "RUB", "showcasesVisibility": "SHOWCASES_VISIBILITY_BO", "badges": []},
    {"sku": "5518622944", "name": "Комплект нижнего белья JOIS", "article": "шоколад", "category": "Одежда и обувь",
     "uniqueSearchUsers": 46066, "position": 252, "uniqueViewUsers": 51, "queryCtr": 1.96, "gmv": 0,
     "currency": "RUB", "showcasesVisibility": "SHOWCASES_VISIBILITY_BO", "badges": []},
], "totalNumberOfItems": 0, "totalPagesCount": 0}
rows = s.parse_items_summary(ITEMS, "2026-09-10", SKU2PID)
check("сводка: 2 строки", len(rows) == 2, rows)
r0 = rows[0]
check("сводка: sku int, date, канон position", (r0["sku"], r0["date"], r0["position"]) == (4988596186, "2026-09-10", 29), r0)
check("сводка: product_id из каталога", r0["product_id"] == 1001, r0)
check("сводка: SKU вне каталога → product_id None, строка НЕ теряется", rows[1]["product_id"] is None and rows[1]["sku"] == 5518622944, rows[1])
check("сводка: поля", (r0["search_users"], r0["view_users"], r0["ctr"], r0["gmv"], r0["showcases_visibility"]) == (32209, 2785, 3.1, 8313.0, "SHOWCASES_VISIBILITY_BO"), r0)
check("сводка: пустой ответ → []", s.parse_items_summary({"items": []}, "2026-09-10", SKU2PID) == [])

# ── запросы по SKU (get-search-query-analytics-details v2), страница 10 строк ──
PAGE = {"sku": "4988596186", "periodFrom": "2026-09-10T00:00:00Z", "periodTo": "2026-09-11T00:00:00Z", "queries": [
    {"query": "карта памяти", "position": 72, "competitorSku": "0", "uniqueSearchUsers": 1191, "uniqueViewUsers": 90,
     "queryCtr": 2.56, "gmv": 0, "currency": "RUB", "uniqueClickUsers": 2, "orderCount": 0, "queryIndex": 1},
    {"query": "карта памяти micro sd", "position": 114, "competitorSku": "0", "uniqueSearchUsers": 976, "uniqueViewUsers": 40,
     "queryCtr": 2.4, "gmv": 1455, "currency": "RUB", "uniqueClickUsers": 1, "orderCount": 2, "queryIndex": 2},
], "status": "DATA_EXISTS", "subscription": "PREMIUM_PLUS", "totalNumberOfQueries": 0, "totalPagesCount": 0}
q = s.parse_query_page(PAGE, "2026-09-10", 4988596186, 1001)
check("запросы: 2 строки", len(q) == 2, q)
check("запросы: ключи", (q[0]["sku"], q[0]["date"], q[0]["query"], q[0]["product_id"]) == (4988596186, "2026-09-10", "карта памяти", 1001), q[0])
check("запросы: метрики", (q[1]["position"], q[1]["search_users"], q[1]["orders"], q[1]["gmv"], q[1]["query_index"]) == (114, 976, 2, 1455.0, 2), q[1])
check("запросы: NO_DATA → []", s.parse_query_page({"queries": [], "status": "NO_DATA"}, "2026-09-11", 4988596186, 1001) == [])
check("запросы: пустой текст пропускается", s.parse_query_page({"queries": [{"query": "  ", "position": 1}]}, "2026-09-10", 1, 1) == [])
# дубль запроса внутри дня (кабинет иногда отдаёт один текст на двух страницах) — оставляем первый
dup = s.dedupe_queries(q + [dict(q[0], position=99)])
check("дубли по (sku, query) схлопнуты", len(dup) == 2 and dup[0]["position"] == 72, dup)

# ── fetch_day: конец пагинации по СЫРОМУ списку, не по отфильтрованному ──
# страница 1 — один запрос с пустым текстом (после parse_query_page даёт []),
# но это НЕ конец: страница 2 несёт нормальный запрос, страница 3 — пустая (конец).
class _FakeClientPaging:
    def __init__(self):
        self.calls = 0

    def post(self, path, payload):
        return {"items": [{"sku": "4988596186", "name": "x", "article": "a", "category": "c",
                            "uniqueSearchUsers": 1, "position": 1, "uniqueViewUsers": 1,
                            "queryCtr": 1.0, "gmv": 0, "showcasesVisibility": "SHOWCASES_VISIBILITY_BO"}]}

    def get(self, path, params):
        self.calls += 1
        if self.calls == 1:
            return {"queries": [{"query": "  ", "position": 99}]}
        if self.calls == 2:
            return {"queries": [{"query": "карта памяти", "position": 5, "uniqueSearchUsers": 10,
                                  "uniqueViewUsers": 2, "queryCtr": 1.0, "uniqueClickUsers": 0,
                                  "orderCount": 0, "gmv": 0, "queryIndex": 1}]}
        return {"queries": []}


_sku_rows, _query_rows = s.fetch_day(_FakeClientPaging(), "123", "2026-09-10", SKU2PID)
check("пагинация: не останавливается на странице с пустым (после фильтра) запросом",
      len(_query_rows) == 1 and _query_rows[0]["query"] == "карта памяти", _query_rows)

# ── collect(): голый CabinetError → код 1, ##OBS напечатан до возврата ──
class _FakeCtxError:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, path, payload):
        raise s.cc.CabinetError("сбой без под-класса")

    def get(self, path, params):
        raise s.cc.CabinetError("сбой без под-класса")


_orig_from_env, _orig_sku2pid, _orig_init = s.cc.from_env, s.db_pg.ozon_sku2pid, s.db_pg.init
s.cc.from_env = lambda: _FakeCtxError()
s.db_pg.ozon_sku2pid = lambda: {}
s.db_pg.init = lambda: None
_buf = io.StringIO()
try:
    with contextlib.redirect_stdout(_buf):
        _rc = s.collect("2026-09-10", "2026-09-10")
finally:
    s.cc.from_env, s.db_pg.ozon_sku2pid, s.db_pg.init = _orig_from_env, _orig_sku2pid, _orig_init
_out = _buf.getvalue()
check("collect: голый CabinetError → exit 1", _rc == 1, _rc)
check("collect: ##OBS rows=0 напечатан на пути ошибки", "##OBS rows=0" in _out, _out)

# ══════════════════════════ трафик (charts/v3/table/by_sku) ══════════════════════════
import ozon_cabinet_traffic as t  # noqa: E402
BYSKU = {"items": [{
    "productInfo": {"sku": "4988596186", "name": "TechStore 64 ГБ", "article": "карта 64", "sources": ["fbs", "fbo"]},
    "metrics": {"revenue": 368827, "searchPosition": 23, "totalViews": 182368, "searchViews": 32275,
                "convSearchViewsToCart": 0.17, "hitsSearchToCart": 56, "convSearchViewsToPdp": 10.37,
                "pdpViews": 3346, "convPdpViewsToCart": 12.67, "hitsPdpToCart": 424, "totalHitsToCart": 480,
                "convHitsToCartToOrder": 47.17, "convViewsToOrder": 0.11, "orderedUnits": 200,
                "deliveredUnits": 299, "cancelledUnits": 21, "returnedUnits": 8, "avgPrice": 1844,
                "priceIndex": "super", "daysInPromo": 7, "drr": 10, "daysInTrafarets": 7,
                "lastStock": 739, "lastStockFbo": 700, "lastStockFbs": 39, "stockoutDays": 12}},
    {"productInfo": {"sku": "9999", "name": "Без Premium-метрик"}, "metrics": {"orderedUnits": 3}},
]}
tr = t.parse_traffic_page(BYSKU, "2026-09-10", SKU2PID)
check("трафик: 2 строки", len(tr) == 2, tr)
a = tr[0]
check("трафик: ключи", (a["sku"], a["date"], a["product_id"]) == (4988596186, "2026-09-10", 1001), a)
check("трафик: показы/корзины", (a["total_views"], a["search_views"], a["pdp_views"], a["hits_search_to_cart"], a["hits_pdp_to_cart"], a["total_hits_to_cart"]) == (182368, 32275, 3346, 56, 424, 480), a)
check("трафик: конверсии", (a["conv_search_to_pdp"], a["conv_pdp_to_cart"], a["conv_cart_to_order"], a["conv_views_to_order"]) == (10.37, 12.67, 47.17, 0.11), a)
check("трафик: drr/трафареты/позиция", (a["drr"], a["days_in_trafarets"], a["days_in_promo"], a["search_position"], a["price_index"]) == (10.0, 7, 7, 23, "super"), a)
check("трафик: остатки", (a["last_stock"], a["last_stock_fbo"], a["last_stock_fbs"], a["stockout_days"]) == (739, 700, 39, 12), a)
b = tr[1]
check("трафик: отсутствующие метрики → NULL, не 0", b["total_views"] is None and b["drr"] is None and b["ordered_units"] == 3, b)
check("трафик: 22 метрики в запросе, ≤ лимита 30 SKU", len(t.METRICS) == 22 and t.PAGE == 30, t.METRICS)

# ── fetch_day: конец пагинации по СЫРОМУ items, не по отфильтрованному ──
# страница 1 — один item без sku (после parse_traffic_page даёт []), но это НЕ
# конец: страница 2 несёт нормальный item, страница 3 — пустая (настоящий конец).
class _FakeClientPagingTraffic:
    def __init__(self):
        self.calls = 0

    def post(self, path, payload):
        self.calls += 1
        if self.calls == 1:
            return {"items": [{"productInfo": {"name": "без sku"}, "metrics": {}}]}
        if self.calls == 2:
            return {"items": [{"productInfo": {"sku": "4988596186", "name": "x"}, "metrics": {"orderedUnits": 1}}]}
        return {"items": []}


_tr_rows = t.fetch_day(_FakeClientPagingTraffic(), "2026-09-10", SKU2PID)
check("трафик: пагинация не останавливается на странице с item без sku",
      len(_tr_rows) == 1 and _tr_rows[0]["sku"] == 4988596186, _tr_rows)

# ── collect(): голый CabinetError → код 1, ##OBS напечатан до возврата ──
class _FakeCtxErrorTraffic:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, path, payload):
        raise t.cc.CabinetError("сбой без под-класса")


_orig_from_env_t, _orig_sku2pid_t, _orig_init_t = t.cc.from_env, t.db_pg.ozon_sku2pid, t.db_pg.init
t.cc.from_env = lambda: _FakeCtxErrorTraffic()
t.db_pg.ozon_sku2pid = lambda: {}
t.db_pg.init = lambda: None
_buf_t = io.StringIO()
try:
    with contextlib.redirect_stdout(_buf_t):
        _rc_t = t.collect("2026-09-10", "2026-09-10")
finally:
    t.cc.from_env, t.db_pg.ozon_sku2pid, t.db_pg.init = _orig_from_env_t, _orig_sku2pid_t, _orig_init_t
_out_t = _buf_t.getvalue()
check("трафик collect: голый CabinetError → exit 1", _rc_t == 1, _rc_t)
check("трафик collect: ##OBS rows=0 напечатан на пути ошибки", "##OBS rows=0" in _out_t, _out_t)

# ── цены кабинета (get-common-prices) → ozon_cabinet_prices ──
import ozon_cabinet_prices as cp  # noqa: E402
LIST_RESP = {"products": [
    {"item_id": "5393596117", "part_item": {"offer_id": "карта 64"}},
    {"item_id": "4192317618", "part_item": {"offer_id": "Серый квадрат 90*210"}},
    {"item_id": "999", "part_item": {}},                     # без offer_id — пропуск
], "cursor": "abc"}
check("list-by-filter: item_id → offer_id", cp.parse_list_page(LIST_RESP) == {"5393596117": "карта 64", "4192317618": "Серый квадрат 90*210"}, cp.parse_list_page(LIST_RESP))

PRICES_RESP = {"items": [
    {"item_id": "5393596117", "marketing_seller_price": "1800", "marketing_price": "1260", "marketing_oa_price": "887"},
    {"item_id": "4192317618", "marketing_seller_price": "2550", "marketing_price": None, "marketing_oa_price": "1366"},
    {"item_id": "777", "marketing_seller_price": "10"},        # нет в каталоге — пропуск
    {"item_id": "4192317618", "marketing_seller_price": "0"},  # нули → строка без цен не пишется
]}
ID2PID = {"5393596117": 5393596117, "4192317618": 4192317618}
rows = cp.parse_common_prices(PRICES_RESP, ID2PID, "2026-09-17")
check("common-prices: три цены", rows[0] == {"product_id": 5393596117, "date": "2026-09-17",
      "marketing_seller_price": 1800.0, "marketing_price": 1260.0, "marketing_oa_price": 887.0}, rows[0])
check("common-prices: marketing_price None сохраняется как None", rows[1]["marketing_price"] is None and rows[1]["marketing_oa_price"] == 1366.0, rows[1])
check("common-prices: чужой item и нулевые цены пропущены", len(rows) == 2, rows)

# ── fetch_id2offer: конец пагинации по СЫРОМУ списку products, не по отфильтрованному ──
# страница 1 — два товара без offer_id (после parse_list_page даёт {}), но это НЕ
# конец: страница 2 несёт товар с offer_id, страница 3 — пустая (настоящий конец).
class _FakeClientPagingPrices:
    def __init__(self):
        self.calls = 0

    def post(self, path, payload):
        self.calls += 1
        if self.calls == 1:
            return {"products": [{"item_id": "1", "part_item": {}}, {"item_id": "2", "part_item": {}}], "cursor": "c1"}
        if self.calls == 2:
            return {"products": [{"item_id": "3", "part_item": {"offer_id": "офер 3"}}], "cursor": "c2"}
        return {"products": [], "cursor": "c2"}


_fake_paging = _FakeClientPagingPrices()
_id2offer = cp.fetch_id2offer(_fake_paging, "1428518")
check("fetch_id2offer: не останавливается на странице без offer_id",
      _id2offer == {"3": "офер 3"}, _id2offer)
check("fetch_id2offer: 3 запроса (не остановился после страницы 1)", _fake_paging.calls == 3, _fake_paging.calls)

# ── collect(): три гейта ошибок (ревью 2026-09-17, находка F4) ──
_orig_from_env_p, _orig_query_p, _orig_init_p, _orig_upsert_p = cp.cc.from_env, cp.db_pg.query, cp.db_pg.init, cp.db_pg.upsert_ozon_cabinet_prices_many
cp.db_pg.init = lambda: None
_upsert_calls = []
cp.db_pg.upsert_ozon_cabinet_prices_many = lambda rows: (_upsert_calls.append(rows), len(rows))[1]


class _FakeCtxEmpty:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, path, payload):
        return {"products": [], "cursor": ""} if path == cp.P_LIST else {"items": []}


# (a) кабинет не отдал ни одного товара в продаже → cabinet_empty, exit 3
cp.cc.from_env = lambda: _FakeCtxEmpty()
cp.db_pg.query = lambda *a, **kw: []
_buf_p1 = io.StringIO()
try:
    with contextlib.redirect_stdout(_buf_p1):
        _rc_p1 = cp.collect()
finally:
    cp.cc.from_env, cp.db_pg.query = _orig_from_env_p, _orig_query_p
_out_p1 = _buf_p1.getvalue()
check("цены collect: пустой список товаров → exit 3 (cabinet_empty)", _rc_p1 == 3, _rc_p1)
check("цены collect: ##OBS rows=0 при cabinet_empty", "##OBS rows=0" in _out_p1, _out_p1)


class _FakeCtxNoMap:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, path, payload):
        return {"products": [{"item_id": "555", "part_item": {"offer_id": "офер-Х"}}], "cursor": ""} if path == cp.P_LIST else {"items": []}


# (b) товары есть, но ни один item_id/offer_id не связан с каталогом → id_mapping_failed, exit 1
cp.cc.from_env = lambda: _FakeCtxNoMap()
cp.db_pg.query = lambda *a, **kw: [{"product_id": 999, "offer_id": "другой-офер"}]
_buf_p2 = io.StringIO()
try:
    with contextlib.redirect_stdout(_buf_p2):
        _rc_p2 = cp.collect()
finally:
    cp.cc.from_env, cp.db_pg.query = _orig_from_env_p, _orig_query_p
_out_p2 = _buf_p2.getvalue()
check("цены collect: товары есть, связки нет → exit 1 (id_mapping_failed)", _rc_p2 == 1, _rc_p2)
check("цены collect: ##OBS rows=0 при id_mapping_failed", "##OBS rows=0" in _out_p2, _out_p2)


class _FakeCtxOk:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, path, payload):
        if path == cp.P_LIST:
            return {"products": [{"item_id": "555", "part_item": {"offer_id": "офер-Х"}}], "cursor": ""}
        if path == cp.P_PRICES:
            return {"items": [{"item_id": "555", "marketing_seller_price": "1000",
                                "marketing_price": "800", "marketing_oa_price": "700"}]}
        return {}


# (c) нормальный путь: один связанный товар, цены пришли → exit 0, upsert с одной строкой
cp.cc.from_env = lambda: _FakeCtxOk()
cp.db_pg.query = lambda *a, **kw: [{"product_id": 501, "offer_id": "офер-Х"}]
_upsert_calls.clear()
_buf_p3 = io.StringIO()
try:
    with contextlib.redirect_stdout(_buf_p3):
        _rc_p3 = cp.collect()
finally:
    cp.cc.from_env, cp.db_pg.query, cp.db_pg.init, cp.db_pg.upsert_ozon_cabinet_prices_many = _orig_from_env_p, _orig_query_p, _orig_init_p, _orig_upsert_p
_out_p3 = _buf_p3.getvalue()
check("цены collect: норм. путь → exit 0", _rc_p3 == 0, _rc_p3)
check("цены collect: upsert вызван с одной строкой (product_id из связки offer_id)",
      len(_upsert_calls) == 1 and len(_upsert_calls[0]) == 1 and _upsert_calls[0][0]["product_id"] == 501, _upsert_calls)

print("FAILED" if failed else "ALL PASS", failed)
sys.exit(1 if failed else 0)
