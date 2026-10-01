"""
Селф-тест wb_stocks.build_rows (без сети и БД): разбивка остатков WB по размерам
(chrtId → tenant.wb_daily_stock_sizes, миграция 063) рядом с прежним агрегатом.

Проверяет:
  • агрегат (nm_id, склад) — прежнее поведение: chrtId свёрнуты, суммы верны;
  • по размерам — строка на (nm_id, chrt_id, склад), дубли chrtId складываются;
  • инвариант Σ по размерам = агрегат по каждому (nm_id, склад) и в целом;
  • чужой nm_id и строка без склада отбрасываются в обеих таблицах;
  • chrtId=None → chrt_id=0 (строка не теряется);
  • quantity_full = quantity + inWayToClient + inWayFromClient.

Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/wb_stocks_selftest.py
"""
import os
import sys
from collections import defaultdict

os.environ.setdefault("WB_TOKEN", "selftest-token")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wb_stocks as m  # noqa: E402

WH = "Склад WB"
DATA = [
    {"nmId": 1, "chrtId": 11, "warehouseId": -999999, "warehouseName": WH, "quantity": 5, "inWayToClient": 1, "inWayFromClient": 0},
    {"nmId": 1, "chrtId": 12, "warehouseId": -999999, "warehouseName": WH, "quantity": 3, "inWayToClient": 0, "inWayFromClient": 2},
    {"nmId": 1, "chrtId": 12, "warehouseId": -999999, "warehouseName": WH, "quantity": 1, "inWayToClient": 0, "inWayFromClient": 0},  # дубль chrt
    {"nmId": 1, "chrtId": 11, "warehouseId": 507, "warehouseName": "Коледино", "quantity": 7, "inWayToClient": 0, "inWayFromClient": 0},
    {"nmId": 2, "chrtId": None, "warehouseId": -999999, "warehouseName": WH, "quantity": 4, "inWayToClient": 0, "inWayFromClient": 1},
    {"nmId": 3, "chrtId": 31, "warehouseId": -999999, "warehouseName": WH, "quantity": 9},                       # чужой nm
    {"nmId": 1, "chrtId": 13, "warehouseId": None, "warehouseName": "", "quantity": 100},                      # без склада
    {"nmId": 2, "chrtId": 21, "warehouseId": -999999, "warehouseName": WH, "quantity": None, "inWayToClient": 3},
]
KNOWN = {1, 2}

fails = 0


def check(cond, msg):
    global fails
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails += 1


agg, sizes, st = m.build_rows(DATA, KNOWN, "2026-10-01")
A = {(r["nm_id"], r["warehouse"]): r for r in agg}
S = {(r["nm_id"], r["chrt_id"], r["warehouse"]): r for r in sizes}

check(len(agg) == 3, f"агрегат: 3 строки (nm×склад), получено {len(agg)}")
check(A[(1, WH)]["quantity"] == 9 and A[(1, WH)]["in_way_to"] == 1 and A[(1, WH)]["in_way_from"] == 2,
      "агрегат nm=1/Склад WB: qty 9, к 1, от 2")
check(A[(1, WH)]["quantity_full"] == 12, "агрегат quantity_full = 9+1+2 = 12")
check(len(sizes) == 5, f"по размерам: 5 строк, получено {len(sizes)}")
check(S[(1, 12, WH)]["quantity"] == 4 and S[(1, 12, WH)]["quantity_full"] == 6, "дубль chrt 12 сложен: qty 4, full 6")
check((2, 0, WH) in S and S[(2, 0, WH)]["quantity"] == 4, "chrtId=None → chrt_id=0, строка сохранена")
check(S[(2, 21, WH)]["quantity"] == 0 and S[(2, 21, WH)]["quantity_full"] == 3, "quantity=None → 0, в пути учтён")
check(not any(r["nm_id"] == 3 for r in sizes) and not any(r["nm_id"] == 3 for r in agg), "чужой nm отброшен в обеих")
check(not any(r["warehouse"] == "" for r in sizes), "строка без склада отброшена")
check(st["no_chrt"] == 1 and st["skipped_unknown_nm"] == 1 and st["skipped_no_wh"] == 1, f"статистика: {st}")
check(all(r["date"] == "2026-10-01" for r in agg + sizes), "дата снимка проставлена")
check(S[(1, 11, "Коледино")]["warehouse_id"] == 507, "warehouse_id сохранён в размерах")

# Инвариант Σ размеров = агрегат по каждому (nm, склад) и каждой метрике.
sums = defaultdict(lambda: defaultdict(int))
for r in sizes:
    for c in ("quantity", "quantity_full", "in_way_to", "in_way_from"):
        sums[(r["nm_id"], r["warehouse"])][c] += r[c]
ok = all(sums[k][c] == A[k][c] for k in A for c in ("quantity", "quantity_full", "in_way_to", "in_way_from"))
check(ok and set(sums) == set(A), "Σ по размерам = агрегат по каждому (nm, склад), Δ=0")

print("ИТОГ:", "ВСЁ ЗЕЛЁНОЕ" if fails == 0 else f"{fails} провал(ов)")
sys.exit(1 if fails else 0)
