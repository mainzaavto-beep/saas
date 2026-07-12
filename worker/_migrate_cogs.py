"""Перенос cogs (себестоимость, ручной ввод) из боевой SQLite → SaaS PostgreSQL.
Cogs не с API — это данные, введённые владельцем в дашборде. Для обкатки cabinet_id=1
переносим как есть (и WB, и Ozon). cabinet_id=1 в SaaS."""
import sqlite3, psycopg, os
from psycopg.rows import dict_row

pg = psycopg.connect(host="localhost", port=5432, dbname="saas", user="postgres",
                     password=os.environ["POSTGRES_PASSWORD"], row_factory=dict_row)

# --- WB cogs ---
wb = sqlite3.connect(r"C:\AgentsDB\wb_data.db")
wb.row_factory = sqlite3.Row
n_wb = 0
for r in wb.execute("SELECT nm_id, cost FROM cogs"):
    with pg.cursor() as cur:
        cur.execute("""INSERT INTO tenant.wb_cogs (cabinet_id, nm_id, cost, updated_at)
            VALUES (1, %s, %s, now())
            ON CONFLICT (cabinet_id, nm_id) DO UPDATE SET cost = EXCLUDED.cost, updated_at = now()""",
            (r["nm_id"], r["cost"]))
        n_wb += 1
print(f"WB cogs: перенесено {n_wb} строк")

# --- Ozon cogs ---
oz = sqlite3.connect(r"C:\AgentsDB\ozon_data.db")
oz.row_factory = sqlite3.Row
n_oz = 0
for r in oz.execute("SELECT product_id, cost FROM cogs"):
    with pg.cursor() as cur:
        cur.execute("""INSERT INTO tenant.ozon_cogs (cabinet_id, product_id, cost, updated_at)
            VALUES (1, %s, %s, now())
            ON CONFLICT (cabinet_id, product_id) DO UPDATE SET cost = EXCLUDED.cost, updated_at = now()""",
            (r["product_id"], r["cost"]))
        n_oz += 1
print(f"Ozon cogs: перенесено {n_oz} строк")

pg.commit()
wb.close(); oz.close(); pg.close()
print("OK — cogs перенесены")
