"""Сид демо-данных для UI-демо под cabinet 1001 (UTF-8 чистый, через db_pg)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))
os.environ['WB_SaaS_CABINET_ID'] = '1001'
import db_pg
from datetime import date, timedelta

today = date.today().isoformat()
d30 = (date.today() - timedelta(days=29)).isoformat()

# Каталог: 3 товара.
for pid, name, brand in [(1001, 'Кроссовки беговые', 'SportMax'), (1002, 'Футболка хлопок', 'CottonCo'), (1003, 'Рюкзак городской', 'UrbanGear')]:
    db_pg.upsert_article(pid, name, brand, subject='Тест')

# order_costs: продажи за последние 10 дней.
rows = [
    {'srid': f'D{i}', 'nm_id': 1001, 'sale_dt': f'2026-07-0{i%9+1}T12:00:00', 'order_dt': f'2026-07-0{i%9+1}T10:00:00',
     'cost_value_retail': 3500, 'commission': 525, 'acquiring': 70, 'logistics': 95, 'cost': 1800,
     'profit': 1010, 'qty': 1, 'is_return': 0}
    for i in range(8)
] + [
    {'srid': f'E{i}', 'nm_id': 1002, 'sale_dt': f'2026-07-0{i%9+1}T12:00:00', 'order_dt': f'2026-07-0{i%9+1}T10:00:00',
     'cost_value_retail': 1200, 'commission': 180, 'acquiring': 24, 'logistics': 60, 'cost': 400,
     'profit': 536, 'qty': 1, 'is_return': 0}
    for i in range(5)
] + [
    {'srid': f'F{i}', 'nm_id': 1003, 'sale_dt': f'2026-07-0{i%9+1}T12:00:00', 'order_dt': f'2026-07-0{i%9+1}T10:00:00',
     'cost_value_retail': 2800, 'commission': 420, 'acquiring': 56, 'logistics': 110, 'cost': 1200,
     'profit': 1014, 'qty': 1, 'is_return': 0}
    for i in range(3)
]
n = db_pg.upsert_order_costs_many(rows)
print(f'inserted {n} order_costs + 3 articles under cabinet 1001 for UI demo')
