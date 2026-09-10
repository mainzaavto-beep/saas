"""
Селф-тест ozon_metrics (без сети и БД): очистка orders/revenue окна и запись новых
строк должны идти ОДНОЙ транзакцией ПОСЛЕ успешного похода в analytics/data.
Симптом 01–08.09.2026: сборщик обнулял orders за 3 дня, затем падал на 429 —
и до следующего тика (3–4 ч) скорость Ozon на /stocks и портрет покупателя
считались по NULL.

Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_metrics_selftest.py
"""
import os
import sys
from contextlib import contextmanager

os.environ.setdefault("OZON_CLIENT_ID", "selftest")
os.environ.setdefault("OZON_API_KEY", "selftest")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ozon_metrics as m  # noqa: E402
from ozon_client import OzonError  # noqa: E402

log = []          # хронология: ('clear'|'upsert'|'commit'|'rollback', ...)


class FakeConn:
    def execute(self, sql, params=None):
        if "SET orders = NULL" in sql:
            log.append(("clear", params))
        elif "INSERT INTO tenant.ozon_daily_metrics" in sql:
            log.append(("upsert", params[1], params[2]))
        return self

    def fetchall(self):
        return []


@contextmanager
def fake_get_connection():
    conn = FakeConn()
    try:
        yield conn
        log.append(("commit",))
    except Exception:
        log.append(("rollback",))
        raise


def fake_query(sql, params=None):
    if "ozon_products" in sql:
        return [{"fbo_sku": 111, "product_id": 1}, {"fbo_sku": 222, "product_id": 2}]
    if "ozon_orders" in sql:
        return [{"product_id": 1, "d": "2026-09-07", "cnt": 3}]
    return []


m.db_pg.init = lambda: None
m.db_pg.get_connection = fake_get_connection
m.db_pg.query = fake_query
m.db_pg._cabinet_id = lambda: 1

ROWS = [
    {"dimensions": [{"id": "2026-09-07"}, {"id": "111"}], "metrics": [10, 0, 0, 0, 4]},
    {"dimensions": [{"id": "2026-09-07"}, {"id": "222"}], "metrics": [5, 0, 0, 0, 1]},
]

failed = 0


def check(cond, msg):
    global failed
    print(("PASS — " if cond else "FAIL — ") + msg, flush=True)
    if not cond:
        failed += 1


# --- сценарий 1: analytics/data недоступен (429 исчерпан) ---
class FailingClient:
    def iter_analytics(self, *a, **k):
        raise OzonError("Исчерпаны попытки запроса /v1/analytics/data: 429 too many requests после 5 попыток за 75с")
        yield  # noqa: unreachable — делает функцию генератором


m.OzonClient = FailingClient
log.clear()
raised = False
try:
    m.collect("2026-09-06", "2026-09-08")
except OzonError:
    raised = True
check(raised, "сценарий 1: ошибка Ozon пробрасывается наверх (сборщик FAIL, оркестратор видит)")
check(not any(e[0] == "clear" for e in log), "сценарий 1: orders/revenue окна НЕ обнулены при падении сети")
check(not any(e[0] == "commit" for e in log), "сценарий 1: ни одной закоммиченной транзакции")

# --- сценарий 2: analytics/data отвечает ---
class OkClient:
    def iter_analytics(self, *a, **k):
        yield from ROWS


m.OzonClient = OkClient
log.clear()
n = m.collect("2026-09-06", "2026-09-08")
kinds = [e[0] for e in log]
check(n == 2, f"сценарий 2: записано 2 строки (получено {n})")
check(kinds and kinds[0] == "clear", "сценарий 2: очистка окна идёт ПЕРВОЙ операцией транзакции записи")
check(kinds.count("upsert") == 2 and kinds.count("commit") == 1 and kinds[-1] == "commit",
      f"сценарий 2: очистка + 2 upsert + один commit в одной транзакции (получено {kinds})")
check(any(e[0] == "clear" and e[1] == ("2026-09-06", "2026-09-08") for e in log),
      "сценарий 2: очистка ровно по окну сборщика")

# --- сценарий 3: кабинет БЕЗ Premium — analytics/data молча выкидывает недоступные
# метрики и отдаёт значения только по оставшимся (живая проба 2026-09-10, каб. 1008:
# из [hits_view, delivered_units, revenue, returns, hits_tocart] пришёл один revenue).
# Позиционный разбор клал выручку (7719 ₽) в колонку clicks (показы) — 04–10.09.2026
# в tenant.ozon_daily_metrics у 1008 clicks = revenue день в день.
class NoPremiumClient:
    def iter_analytics(self, *a, **k):
        yield {"dimensions": [{"id": "2026-09-07"}, {"id": "111"}], "metrics": [7719]}


captured = []
m.db_pg.upsert_ozon_daily = lambda pid, d, conn=None, **f: captured.append((pid, d, f))
m.OzonClient = NoPremiumClient
log.clear()
m.collect("2026-09-06", "2026-09-08")
check(len(captured) == 1, f"сценарий 3: одна строка записана (получено {len(captured)})")
f3 = captured[0][2] if captured else {}
check(f3.get("clicks") is None, f"сценарий 3: выручка НЕ уезжает в clicks (clicks={f3.get('clicks')!r})")
check(f3.get("cart") is None, f"сценарий 3: cart без Premium = None (cart={f3.get('cart')!r})")
check(f3.get("orders") == 3, f"сценарий 3: orders из ozon_orders сохраняются (orders={f3.get('orders')!r})")

print("ALL PASS" if not failed else f"{failed} FAIL", flush=True)
sys.exit(1 if failed else 0)
