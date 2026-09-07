#!/usr/bin/env python3
"""Разбор ответа statistics-api /api/v1/supplier/incomes. Без сети и БД."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import wb_incomes as m

data = [
    {"incomeId": 41257995, "number": "ПОС-1", "date": "2026-08-28T00:00:00", "lastChangeDate": "2026-08-30T10:00:00",
     "supplierArticle": "SA1", "techSize": "0", "barcode": "2000000000012", "quantity": 120, "totalPrice": 0,
     "dateClose": "2026-08-30T00:00:00", "warehouseName": "Казань", "nmId": 1383643331, "status": "Принято"},
    {"incomeId": 41257995, "number": "ПОС-1", "date": "2026-08-28T00:00:00", "nmId": None, "quantity": 5},  # без nmId — пропуск
]
rows = m.parse_rows(data)
assert rows == [{
    "income_id": 41257995, "nm_id": 1383643331, "barcode": "2000000000012", "number": "ПОС-1",
    "date": "2026-08-28", "date_close": "2026-08-30", "last_change": "2026-08-30T10:00:00",
    "warehouse_name": "Казань", "tech_size": "0", "quantity": 120, "total_price": 0, "status": "Принято",
}], rows
assert m.parse_rows([]) == []
print("OK: 2 проверки")
