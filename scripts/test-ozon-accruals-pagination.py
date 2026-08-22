#!/usr/bin/env python3
"""Синтетический тест пагинации accrual_by_day (спека 2026-08-22).
На живых данных многостраничности нет (кабинеты ≤2 тыс. заказов) — стыки
страниц проверяются только здесь. Без сети и БД: _post подменяется."""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import ozon_client as oc


def make_client(pages):
    """pages: список ответов, которые _post отдаёт по очереди."""
    cli = oc.OzonClient.__new__(oc.OzonClient)   # без __init__ (не нужны креды)
    cli.host = "test"
    calls = {"n": 0, "bodies": []}
    def fake_post(host, path, body):
        calls["bodies"].append(dict(body))
        resp = pages[min(calls["n"], len(pages) - 1)]
        calls["n"] += 1
        return resp
    cli._post = fake_post
    return cli, calls


oc.time.sleep = lambda s: None  # межстраничные паузы в тесте не нужны

ok = 0

# 1) Две страницы склеиваются, курсор передан во 2-й запрос, pages=2.
cli, calls = make_client([
    {"accruals": [{"id": 1}, {"id": 2}], "last_id": "abc"},
    {"accruals": [{"id": 3}], "last_id": ""},
])
r = cli.accrual_by_day("2026-08-01")
assert [a["id"] for a in r["accruals"]] == [1, 2, 3], r
assert r["pages"] == 2, r
assert "last_id" not in calls["bodies"][0] and calls["bodies"][1].get("last_id") == "abc", calls
ok += 1

# 2) Повтор last_id → RuntimeError (API игнорирует курсор).
cli, _ = make_client([
    {"accruals": [{"id": 1}], "last_id": "loop"},
    {"accruals": [{"id": 1}], "last_id": "loop"},
])
try:
    cli.accrual_by_day("2026-08-01")
    raise AssertionError("ожидали RuntimeError на повторе last_id")
except RuntimeError as e:
    assert "повтор last_id" in str(e), e
ok += 1

# 3) Непустой last_id, но пустая вторая страница → стоп без ошибки.
cli, _ = make_client([
    {"accruals": [{"id": 1}], "last_id": "next"},
    {"accruals": [], "last_id": "next2"},
])
r = cli.accrual_by_day("2026-08-01")
assert len(r["accruals"]) == 1 and r["pages"] == 2, r
ok += 1

# 4) Одна страница (сегодняшняя норма): pages=1, один запрос.
cli, calls = make_client([{"accruals": [{"id": 7}], "last_id": ""}])
r = cli.accrual_by_day("2026-08-01")
assert r["pages"] == 1 and len(calls["bodies"]) == 1, (r, calls)
ok += 1

print(f"OK {ok}/4")
