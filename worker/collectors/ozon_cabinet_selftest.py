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

print("FAILED" if failed else "ALL PASS", failed)
sys.exit(1 if failed else 0)
