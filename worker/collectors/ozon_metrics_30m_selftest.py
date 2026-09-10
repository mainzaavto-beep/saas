"""
Селф-тест ozon_metrics_30m (без сети и БД): разбор ответов аналитики продавца и
Performance API за «сегодня» в снимки 30-минутного слота.

Грабля (живая проба 2026-09-10): /v1/analytics/data МОЛЧА выкидывает метрики,
недоступные кабинету без Premium, и возвращает значения ТОЛЬКО по оставшимся —
кабинет 1008 на 6 запрошенных метрик отдал [1, 7719] (ordered_units, revenue).
Позиционный разбор в таком ответе кладёт выручку в колонку показов.

Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_metrics_30m_selftest.py
"""
import os
import sys
from datetime import datetime

os.environ.setdefault("OZON_CLIENT_ID", "selftest")
os.environ.setdefault("OZON_API_KEY", "selftest")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ozon_client import map_metric_values  # noqa: E402
import ozon_metrics_30m as m  # noqa: E402

failed = 0


def check(name, cond, detail=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failed += 1


REQ = ["hits_view", "hits_view_search", "hits_view_pdp", "hits_tocart", "ordered_units", "revenue"]

# ── map_metric_values: полный ответ (Premium) — позиционно ──
full = map_metric_values(REQ, [44529, 12019, 2435, 131, 42, 66675])
check("полный ответ: показы на месте", full["hits_view"] == 44529, full)
check("полный ответ: корзины на месте", full["hits_tocart"] == 131, full)

# ── map_metric_values: урезанный ответ (без Premium) — только бесплатные метрики ──
free = map_metric_values(REQ, [1, 7719])
check("урезанный ответ: выручка НЕ уезжает в показы", free["hits_view"] is None, free)
check("урезанный ответ: ordered_units=1", free["ordered_units"] == 1, free)
check("урезанный ответ: revenue=7719", free["revenue"] == 7719, free)

# ── map_metric_values: неизвестная форма — None, не угадываем ──
check("неизвестная длина → None", map_metric_values(REQ, [1, 2, 3]) is None)
check("пустой ответ → None", map_metric_values(REQ, []) is None)

# ── parse_analytics: строки day×sku → по product_id, sku одного товара суммируются ──
rows = [
    {"dimensions": [{"id": "2026-09-10"}, {"id": "111"}], "metrics": [100, 60, 10, 3, 2, 1500.5]},
    {"dimensions": [{"id": "2026-09-10"}, {"id": "112"}], "metrics": [50, 30, 5, 1, 1, 700]},
    {"dimensions": [{"id": "2026-09-10"}, {"id": "999"}], "metrics": [7, 7, 7, 7, 7, 7]},   # чужой sku
]
per_pid, orphans = m.parse_analytics(rows, REQ, {111: 5001, 112: 5001})
check("parse_analytics: два sku одного товара суммируются (views)", per_pid[5001]["views"] == 150, per_pid)
check("parse_analytics: корзины суммируются", per_pid[5001]["cart"] == 4, per_pid)
check("parse_analytics: order_sum суммируется", per_pid[5001]["order_sum"] == 2200.5, per_pid)
check("parse_analytics: sku без товара — в сирот", orphans == 1 and 999 not in per_pid, (per_pid, orphans))

per_pid2, _ = m.parse_analytics(
    [{"dimensions": [{"id": "2026-09-10"}, {"id": "111"}], "metrics": [1, 7719]}], REQ, {111: 5001})
check("parse_analytics без Premium: views=None, orders=1", per_pid2[5001]["views"] is None and per_pid2[5001]["orders"] == 1, per_pid2)

# ── parse_perf_daily: CSV Performance /statistics/daily (8 колонок, русская запятая) ──
csv_text = ("ID;Название;Дата;Показы;Клики;Расход, ₽;Заказы, шт.;Заказы, ₽\n"
            "123;Кампания А;10.09.2026;33018;917;4455,49;12;18 300,50\n"
            "124;Кампания Б;10.09.2026;0;0;0,00;0;0,00\n"
            "Всего;;;33018;917;4455,49;12;18300,50\n")
camps = m.parse_perf_daily(csv_text)
check("perf: две кампании, итог отброшен", sorted(camps) == [123, 124], camps)
check("perf: расход с запятой", camps[123]["spend"] == 4455.49, camps)
check("perf: сумма заказов с пробелом-тысячником", camps[123]["orders_sum"] == 18300.5, camps)
check("perf: показы/клики целые", camps[123]["views"] == 33018 and camps[123]["clicks"] == 917, camps)
check("perf: имя кампании", camps[123]["campaign_name"] == "Кампания А", camps)

# ── слот 30 минут ──
check("слот 11:45 → 11:30", m.round_ts_to_30m(datetime(2026, 9, 10, 11, 45, 7)) == "2026-09-10 11:30:00")
check("слот 11:29 → 11:00", m.round_ts_to_30m(datetime(2026, 9, 10, 11, 29, 59)) == "2026-09-10 11:00:00")

print("ALL PASS" if failed == 0 else f"FAILED: {failed}")
sys.exit(1 if failed else 0)
