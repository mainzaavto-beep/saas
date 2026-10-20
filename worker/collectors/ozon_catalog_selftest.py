"""
Селф-тест ozon_catalog.variant_attrs (без сети и БД): модель/цвет/размер варианта из
/v4/product/info/attributes (проба каб. #1 20.10.2026).
Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_catalog_selftest.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ozon_catalog as m  # noqa: E402


def attr(i, *vals):
    return {"id": i, "values": [{"value": v} for v in vals]}


bra = {"model_info": {"model_id": 6175686419, "count": 30}, "attributes": [
    attr(10096, "баклажановый", "фиолетово-баклажанный"), attr(10097, "баклажановый"),
    attr(4295, "42", "44"), attr(9533, "M"), attr(4508, "S")]}
assert m.variant_attrs(bra) == (6175686419, "баклажановый", "M"), m.variant_attrs(bra)

no_letter = {"model_info": {"model_id": 1}, "attributes": [attr(10096, "коричневый", "шоколадный"), attr(4295, "42", "44")]}
assert m.variant_attrs(no_letter) == (1, "коричневый", "42/44"), m.variant_attrs(no_letter)

cover = {"model_info": {"model_id": 5315790675}, "attributes": [attr(8415, "160"), attr(10097, "коричневый")]}
assert m.variant_attrs(cover) == (5315790675, "коричневый", None), m.variant_attrs(cover)

assert m.variant_attrs({}) == (None, None, None)
assert m.variant_attrs({"model_info": {"model_id": 0}, "attributes": [attr(10097, "  ")]}) == (None, None, None)
print("ozon_catalog_selftest OK")
