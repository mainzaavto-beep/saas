"""Сверка данных SaaS (PostgreSQL tenant.*) vs боевой (SQLite wb_data.db).
Сравнивает ключевые агрегаты за период — должны совпасть копейка-в-копейку (#61).

Считает по WB: articles, orders, sales, finance_report, order_costs (count + суммы).
Источник SaaS: PostgreSQL saas.tenant.wb_* (cabinet_id=1).
Источник боевой: C:\\AgentsDB\\wb_data.db (SQLite).
"""
import sqlite3
import psycopg
from psycopg.rows import dict_row

PERIOD_FROM = "2026-05-01"
PERIOD_TO = "2026-07-10"

# --- Боевая SQLite ---
battle = sqlite3.connect(r"C:\AgentsDB\wb_data.db")
battle.row_factory = sqlite3.Row

def b_count(table, where=""):
    return battle.execute(f"SELECT count(*) FROM {table} {('WHERE '+where) if where else ''}").fetchone()[0]

def b_sum(table, col, where=""):
    r = battle.execute(f"SELECT COALESCE(SUM({col}),0) FROM {table} {('WHERE '+where) if where else ''}").fetchone()
    return round(r[0], 2)

# --- SaaS PostgreSQL ---
PG = dict(host="localhost", port=5432, dbname="saas", user="postgres",
          password=__import__("os").environ.get("POSTGRES_PASSWORD", ""))
pg = psycopg.connect(**PG, row_factory=dict_row)

def s_count(table, where="cabinet_id=1"):
    with pg.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM tenant.{table} WHERE {where}")
        return cur.fetchone()["count"]

def s_sum(table, col, where="cabinet_id=1"):
    with pg.cursor() as cur:
        cur.execute(f"SELECT COALESCE(SUM({col}),0) FROM tenant.{table} WHERE {where}")
        return round(float(cur.fetchone()["sum"]), 2)

print(f"=== СВЕРКА SaaS vs БОЕВОЙ (WB, период {PERIOD_FROM}..{PERIOD_TO}) ===\n")
print(f"{'Метрика':<45} {'Боевая':>12} {'SaaS':>12} {'Δ':>10}")
print("-" * 82)

checks = [
    ("Артикулы (всего)", lambda: b_count("articles"), lambda: s_count("wb_articles")),
    ("Заказы (всего)", lambda: b_count("orders"), lambda: s_count("wb_orders")),
    ("Продажи (всего)", lambda: b_count("sales"), lambda: s_count("wb_sales")),
    ("Finance report (строк)", lambda: b_count("finance_report"), lambda: s_count("wb_finance_report")),
    ("Order costs (строк)", lambda: b_count("order_costs"), lambda: s_count("wb_order_costs")),
    ("Order costs: SUM(profit)", lambda: b_sum("order_costs", "profit"), lambda: s_sum("wb_order_costs", "profit")),
    ("Order costs: SUM(cost_value_retail)", lambda: b_sum("order_costs", "cost_value_retail"), lambda: s_sum("wb_order_costs", "cost_value_retail")),
]

ok = True
for name, bf, sf in checks:
    try:
        bv, sv = bf(), sf()
    except Exception as e:
        print(f"  {name}: ERR {e}")
        continue
    diff = round(sv - bv, 2)
    mark = "✅" if abs(diff) < 0.5 else "❌"
    if abs(diff) >= 0.5:
        ok = False
    print(f"{mark} {name:<43} {bv:>12} {sv:>12} {diff:>+10}")

print(f"\n{'ВСЁ СОВПАЛО ✅' if ok else 'ЕСТЬ РАСХОЖДЕНИЯ ❌ — см. выше'}")
battle.close()
pg.close()
