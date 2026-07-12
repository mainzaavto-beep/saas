"""Сверка данных SaaS (PG) vs боевой (SQLite ozon_data.db) — Ozon."""
import sqlite3, psycopg, os
from psycopg.rows import dict_row
b = sqlite3.connect(r"C:\AgentsDB\ozon_data.db"); b.row_factory = sqlite3.Row
pg = psycopg.connect(host="localhost", port=5432, dbname="saas", user="postgres",
                     password=os.environ["POSTGRES_PASSWORD"], row_factory=dict_row)
def bc(t): return b.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
def sc(t):
    with pg.cursor() as c:
        c.execute(f"SELECT count(*) FROM tenant.{t} WHERE cabinet_id=1"); return c.fetchone()["count"]
def bsum(t, col): return round(b.execute(f"SELECT COALESCE(SUM({col}),0) FROM {t}").fetchone()[0], 2)
def ssum(t, col):
    with pg.cursor() as cur:
        cur.execute(f"SELECT COALESCE(SUM({col}),0) FROM tenant.{t} WHERE cabinet_id=1"); return round(float(cur.fetchone()["sum"]), 2)

print(f"{'OZON СВЕРКА':<42}{'Боевая':>10}{'SaaS':>10}{'Δ':>10}")
print("-" * 74)
checks = [
    ("products", lambda: bc("products"), lambda: sc("ozon_products")),
    ("orders", lambda: bc("orders"), lambda: sc("ozon_orders")),
    ("sales", lambda: bc("sales"), lambda: sc("ozon_sales")),
    ("finance_report", lambda: bc("finance_report"), lambda: sc("ozon_finance_report")),
    ("order_costs (строк)", lambda: bc("order_costs"), lambda: sc("ozon_order_costs")),
    ("oc SUM(profit)", lambda: bsum("order_costs", "profit"), lambda: ssum("ozon_order_costs", "profit")),
    ("oc SUM(cost_value_retail)", lambda: bsum("order_costs", "cost_value_retail"), lambda: ssum("ozon_order_costs", "cost_value_retail")),
]
ok = True
for name, bf, sf in checks:
    try: bv, sv = bf(), sf()
    except Exception as e: print(f"  {name}: ERR {e}"); continue
    d = round(sv - bv, 2); mark = "✅" if abs(d) < 1 else "❌"
    if abs(d) >= 1: ok = False
    print(f"{mark} {name:<40}{bv:>10}{sv:>10}{d:>+10}")
print(f"\n{'ВСЁ СОВПАЛО ✅' if ok else 'ЕСТЬ РАСХОЖДЕНИЯ ❌'}")
b.close(); pg.close()
