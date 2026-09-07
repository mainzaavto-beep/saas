#!/usr/bin/env python3
"""Разбор ответа supplies-api GET /api/v1/supplies/{id} + .../{id}/goods.
Без сети и БД. Форма подтверждена живой пробой 2026-09-07 (кабинет #1) —
старый statistics-api /api/v1/supplier/incomes отключён WB (404 на гейтвее)."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import wb_incomes as m

# Поставка принята целиком (statusID=5, factDate есть) — quantity = принято.
detail_accepted = {
    "statusID": 5, "createDate": "2026-08-22T11:08:24+03:00", "factDate": "2026-08-26T22:59:12+03:00",
    "updatedDate": "2026-09-01T19:43:58+03:00", "warehouseName": "СЦ Подольск 4",
    "actualWarehouseName": "СЦ Подольск 4", "quantity": 128, "acceptedQuantity": 128,
}
goods_accepted = [
    {"barcode": "2054515494906", "nmID": 1378330874, "techSize": "L", "quantity": 6, "acceptedQuantity": 6},
    {"barcode": "2054515494913", "nmID": None, "techSize": "M", "quantity": 6, "acceptedQuantity": 6},  # без nmID — пропуск
]
rows = m.parse_rows(41257995, detail_accepted, goods_accepted)
assert rows == [{
    "income_id": 41257995, "nm_id": 1378330874, "barcode": "2054515494906", "number": None,
    "date": "2026-08-22", "date_close": "2026-08-26", "last_change": "2026-09-01T19:43:58+03:00",
    "warehouse_name": "СЦ Подольск 4", "tech_size": "L", "quantity": 6, "quantity_declared": 6,
    "total_price": None, "status": "5",
}], rows

# Поставка ещё не принята (statusID=3, factDate=None, actualWarehouseName="") —
# quantity=None (не acceptedQuantity=0 — «ещё не известно», а не «принято 0»).
detail_open = {
    "statusID": 3, "createDate": "2026-07-20T10:45:19+03:00", "factDate": None,
    "updatedDate": "2026-07-20T10:51:04+03:00", "warehouseName": "Краснодар (Тихорецкая)",
    "actualWarehouseName": "", "quantity": 78, "acceptedQuantity": 0,
}
goods_open = [{"barcode": "2049111040176", "nmID": 831685664, "techSize": "S", "quantity": 15, "acceptedQuantity": 0}]
rows2 = m.parse_rows(40977598, detail_open, goods_open)
assert rows2 == [{
    "income_id": 40977598, "nm_id": 831685664, "barcode": "2049111040176", "number": None,
    "date": "2026-07-20", "date_close": None, "last_change": "2026-07-20T10:51:04+03:00",
    "warehouse_name": "Краснодар (Тихорецкая)", "tech_size": "S", "quantity": None, "quantity_declared": 15,
    "total_price": None, "status": "3",
}], rows2

assert m.parse_rows(1, None, []) == []
assert m.parse_rows(1, {"statusID": 5, "createDate": "2026-01-01T00:00:00+03:00",
                         "factDate": "2026-01-02T00:00:00+03:00", "updatedDate": "x",
                         "warehouseName": "W"}, []) == []

# Товарная строка без ключа "quantity" — quantity_declared=None (не 0: 0 значило бы
# «заявлено 0 шт», а тут форма ответа неожиданная — фикс раунд 1, 2026-09-07).
goods_no_declared = [{"barcode": "2049111040183", "nmID": 831685665, "techSize": "M", "acceptedQuantity": 4}]
rows3 = m.parse_rows(40977599, detail_accepted, goods_no_declared)
assert rows3[0]["quantity_declared"] is None, rows3
assert rows3[0]["quantity"] == 4, rows3

print("OK: 5 проверок")
