"""
Селф-тест ретраев ozon_client на 429 (без сети). Симптом 01–08.09.2026: ozon_metrics
падал в ночном тике 05:15 MSK с «429 … после 5 попыток за 33с» — все попытки
(2+4+8+16 с) укладывались в ОДНО минутное окно лимита Ozon. Контракт:
  • суммарное ожидание на 429 за все попытки ≥ 60 с (переживаем минутное окно);
  • сообщение об исчерпании содержит заголовки лимита Ozon (ratelimit-*/Retry-After)
    и начало тела ответа — чтобы следующий флап был разобран по логу, не гаданием.

Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_client_selftest.py
"""
import os
import sys

os.environ.setdefault("OZON_CLIENT_ID", "selftest")
os.environ.setdefault("OZON_API_KEY", "selftest")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ozon_client as m  # noqa: E402


class FakeResp:
    status_code = 429
    headers = {"ratelimit-remaining": "0", "ratelimit-reset": "42", "Retry-After": "1"}
    text = '{"code":8,"message":"too many requests"}'

    def json(self):
        return {"code": 8, "message": "too many requests"}


slept = []
m.requests.post = lambda url, headers=None, json=None, timeout=None: FakeResp()
m.time.sleep = lambda s: slept.append(s)

failed = 0


def check(cond, msg):
    global failed
    print(("PASS — " if cond else "FAIL — ") + msg, flush=True)
    if not cond:
        failed += 1


cli = m.OzonClient()
err = None
try:
    cli._post(m.SELLER_HOST, "/v1/analytics/data", {"x": 1})
except m.OzonError as e:
    err = str(e)

check(err is not None, "после исчерпания попыток поднят OzonError")
total = sum(slept)
check(total >= 60.0, f"суммарное ожидание на 429 ≥ 60 с (получено {total:.0f} с, паузы {[round(s) for s in slept]})")
check(len(slept) == m.RETRY_ATTEMPTS - 1, f"пауз ровно RETRY_ATTEMPTS-1 = {m.RETRY_ATTEMPTS - 1} (получено {len(slept)})")
check(err is not None and "ratelimit-remaining=0" in err and "ratelimit-reset=42" in err,
      "в сообщении есть заголовки лимита Ozon")
check(err is not None and "too many requests" in err.lower() and '"code":8' in err,
      "в сообщении есть начало тела ответа Ozon")

print("ALL PASS" if not failed else f"{failed} FAIL", flush=True)
sys.exit(1 if failed else 0)
