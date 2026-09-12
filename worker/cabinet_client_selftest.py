"""Селф-тест cabinet_client (без браузера и сети): план ретраев, классификация
ответов, гард «только разрешённые пути», разбор ошибок на фейковом request.
Запуск: worker/.venv-cabinet/bin/python worker/cabinet_client_selftest.py
(годится и /opt/agents/data-presenter-agent/.venv/bin/python — playwright импортируется лениво)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cabinet_client as cc  # noqa: E402

failed = 0
def check(name, cond, detail=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failed += 1


class FakeResp:
    def __init__(self, status, text): self.status, self._t = status, text
    def text(self): return self._t
    @property
    def ok(self): return 200 <= self.status < 300

class FakeReq:
    """Очередь ответов; пишет историю вызовов."""
    def __init__(self, responses): self.responses, self.calls = list(responses), []
    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append(("GET", url, params)); return self.responses.pop(0)
    def post(self, url, headers=None, data=None, timeout=None):
        self.calls.append(("POST", url, data)); return self.responses.pop(0)

# 1. План ретраев: сеть/5xx — 2,4,8,16; 429 — 5,10,20,40; 4xx — не повторять; 5-я попытка — стоп.
check("5xx: 2→4→8→16", [cc.retry_delay(502, i) for i in range(1, 5)] == [2, 4, 8, 16])
check("429: 5→10→20→40", [cc.retry_delay(429, i) for i in range(1, 5)] == [5, 10, 20, 40])
check("сеть (None): как 5xx", cc.retry_delay(None, 1) == 2)
check("400: не повторять", cc.retry_delay(400, 1) is None)
check("после 4 ретраев — стоп", cc.retry_delay(502, 5) is None)

# 2. Классификация ответов.
check("200 JSON → ok", cc.classify_response(200, '{"a":1}') == "ok")
check("401 → auth", cc.classify_response(401, "{}") == "auth")
check("403 → auth", cc.classify_response(403, '{"error":{"code":"PermissionDenied"}}') == "auth")
check("200 HTML (форма входа) → auth", cc.classify_response(200, "<!doctype html><html>…login…") == "auth")
check("429 → retry", cc.classify_response(429, "") == "retry")
check("503 → retry", cc.classify_response(503, "") == "retry")
check("400 → error", cc.classify_response(400, '{"code":3}') == "error")

# 3. Гард путей: чужой путь — исключение ДО похода в сеть.
req = FakeReq([])
c = cc.CabinetClient("1428518", "/nonexistent", request=req)
try:
    c.post("/api/pricing/set-price", {})
    check("чужой путь запрещён", False)
except cc.CabinetError as e:
    check("чужой путь запрещён", "ALLOWED_PATHS" in str(e), e)
check("сеть не тронута", req.calls == [])
for p in cc.ALLOWED_PATHS:
    check(f"путь только чтение: {p}", not any(w in p for w in ("set", "update", "delete", "enable", "add", "remove")))

# 4. Успех: заголовки и company_id, JSON разобран.
req = FakeReq([FakeResp(200, '{"items":[1]}')])
c = cc.CabinetClient("1428518", "/nonexistent", request=req)
out = c.post("/api/site/seller-analytics/charts/v3/table/by_sku", {"x": 1})
check("json разобран", out == {"items": [1]}, out)
check("URL собран", req.calls[0][1] == "https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/by_sku", req.calls)

# 5. 401 → CabinetAuthError без ретраев.
req = FakeReq([FakeResp(401, "{}")])
c = cc.CabinetClient("1428518", "/nonexistent", request=req)
try:
    c.get("/api/search-query-analytics/v1/get-dates", {"seller_id": "1428518"}); check("401 → CabinetAuthError", False)
except cc.CabinetAuthError:
    check("401 → CabinetAuthError", True)
check("401 без ретраев", len(req.calls) == 1, req.calls)

# 6. 503 → ретрай → 200 (задержки подменены нулём).
cc.SLEEP = lambda s: None
req = FakeReq([FakeResp(503, ""), FakeResp(200, '{"ok":true}')])
c = cc.CabinetClient("1428518", "/nonexistent", request=req)
check("503→200 после ретрая", c.get("/api/search-query-analytics/v1/get-dates", {})["ok"] is True)
check("две попытки", len(req.calls) == 2)

# 7. 400 → CabinetError с телом.
req = FakeReq([FakeResp(400, '{"code":3,"message":"validation error"}')])
c = cc.CabinetClient("1428518", "/nonexistent", request=req)
try:
    c.get("/api/search-query-analytics/v1/get-dates", {}); check("400 → CabinetError", False)
except cc.CabinetError as e:
    check("400 → CabinetError с телом", "validation error" in str(e), e)

print("FAILED" if failed else "ALL PASS", failed)
sys.exit(1 if failed else 0)
