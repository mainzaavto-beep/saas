"""Оценка объёма боевых данных для прогноза времени backfill."""
import sqlite3
for f, tables in [("wb_data.db", ["articles","orders","sales","finance_report","order_costs"]),
                  ("ozon_data.db", ["products","orders","sales","finance_report","order_costs"])]:
    conn = sqlite3.connect(r"C:\AgentsDB\\" + f)
    print(f"=== {f} ===")
    for t in tables:
        try:
            c = conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            print(f"  {t}: {c}")
        except Exception as e:
            print(f"  {t}: ERR {e}")
    conn.close()
