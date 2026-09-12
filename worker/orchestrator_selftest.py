"""
Селф-тест оркестратора (без сети и БД): сборщики 30-минутного тика обязаны
проходить фильтр по площадке. Симптом 14.07–10.09.2026: wb_metrics_30m не был
в WB_COLLECTORS → _collectors_for_mp выкидывал его, таймер saas-metrics30m
каждые полчаса отчитывался «failed=нет», а tenant.wb_metrics_30m не пополнялась.

Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/orchestrator_selftest.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from worker import orchestrator as o  # noqa: E402

failed = 0


def check(name, cond, detail=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + detail}")
    if not cond:
        failed += 1


pool = ["wb_metrics_30m", "ozon_metrics_30m"]
check("wb_metrics_30m проходит фильтр WB",
      o._collectors_for_mp("wb", pool) == ["wb_metrics_30m"],
      repr(o._collectors_for_mp("wb", pool)))
check("ozon_metrics_30m проходит фильтр Ozon",
      o._collectors_for_mp("ozon", pool) == ["ozon_metrics_30m"],
      repr(o._collectors_for_mp("ozon", pool)))
check("WB-фильтр не пропускает Ozon-сборщик",
      "ozon_metrics_30m" not in o._collectors_for_mp("wb", pool))

# Ревью задачи 6, находка №6 / спека §4.5: _collectors_for_marketplaces питает
# --all (главный тик, системный python3) и drain_queue (backfill onboarding до
# 75 дней) — сборщики кабинета (Playwright, .venv-cabinet) там ходить не должны,
# иначе онбординг/бэкфилл погнал бы их под чужим интерпретатором без профиля.
cab_result = o._collectors_for_marketplaces(["ozon"])
check("_collectors_for_marketplaces: без сборщиков кабинета",
      not (set(o.CABINET_COLLECTORS) & set(cab_result)), cab_result)
check("_collectors_for_marketplaces: остальные Ozon-сборщики на месте",
      "ozon_catalog" in cab_result and "ozon_orders" in cab_result, cab_result)

print("ALL PASS" if failed == 0 else f"FAILED: {failed}")
sys.exit(1 if failed else 0)
