#!/usr/bin/env python3
"""Разбор штрихкодов из карточки Content API (sizes[].skus). Без сети и БД."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import wb_catalog as m

card = {"nmID": 111, "sizes": [
    {"chrtID": 1, "techSize": "0", "skus": ["2000000000012", "2000000000029"]},
    {"chrtID": 2, "techSize": "M", "skus": []},
    {"chrtID": 3},
]}
rows = m.parse_card_barcodes(card)
assert rows == [
    {"barcode": "2000000000012", "nm_id": 111, "chrt_id": 1, "tech_size": "0"},
    {"barcode": "2000000000029", "nm_id": 111, "chrt_id": 1, "tech_size": "0"},
], rows
assert m.parse_card_barcodes({"nmID": 5}) == []
assert m.parse_card_barcodes({"nmID": 5, "sizes": None}) == []
print("OK: 3 проверки")
