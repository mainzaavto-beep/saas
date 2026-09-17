"""Клиент внутреннего API кабинета продавца Ozon (seller.ozon.ru) под сохранённым
профилем Chromium владельца — ТОЛЬКО ЧТЕНИЕ.

Официальный Seller API не отдаёт позиции по запросам и разложение трафика по SKU,
поэтому эти данные берутся из API самого кабинета (спека docs/superpowers/specs/
2026-09-12-ozon-cabinet-search-traffic-design.md, §3–4).

Правила (обязательные):
  • профиль (OZON_CABINET_PROFILE_DIR) — живая сессия владельца: не копировать, не
    выгружать; один процесс на профиль (flock в run_saas_collect.sh, режим cabinet);
  • headless=False + DISPLAY=:99 обязательны (иначе Ozon режет сессию), процесс
    запускать без HTTP_PROXY/HTTPS_PROXY (Chromium падает на прокси с авторизацией);
  • клиент ходит только по ALLOWED_PATHS (гард в cabinet_client_selftest.py);
  • сессия истекла → CabinetAuthError; сборщик выходит кодом 5 с маркером
    CABINET_AUTH_EXPIRED в stderr (worker/orchestrator.py → cabinet_state.expired).
    Сам клиент НИКОГДА не логинится — код из СМС приходит владельцу.

Ретраи как в ozon_client: сеть/5xx — 2→4→8→16 с, 429 — 5→10→20→40 с (≥ минутного
окна); 4xx кроме 401/403/429 — ошибка сразу. Селф-тест: cabinet_client_selftest.py.
"""
import json
import os
import time

BASE = "https://seller.ozon.ru"
HDRS = {"x-o3-app-name": "seller-ui", "x-o3-language": "ru", "content-type": "application/json"}
TIMEOUT_MS = 60000
LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled", "--window-position=-2400,-2400"]

# Разрешённые точки (все — чтение). Любой другой путь → CabinetError до похода в сеть.
ALLOWED_PATHS = (
    "/api/v1/products/list-by-filter",                                             # check()
    "/api/search-query-analytics/v1/get-dates",                                    # доступный диапазон дат
    "/api/search-query-analytics/v2/get-seller-items-search-query-analytics",      # сводка по SKU
    "/api/search-query-analytics/v2/get-search-query-analytics-details",           # запросы по SKU
    "/api/site/seller-analytics/charts/v3/table/by_sku",                           # трафик по SKU
    "/api/pricing-bff-service/v3/get-common-prices",                               # три цены (соинвест), ozon_cabinet_prices
)

SLEEP = time.sleep  # подменяется в селф-тесте


class CabinetError(Exception):
    pass


class CabinetAuthError(CabinetError):
    """401/403 или форма входа вместо JSON — сессия кабинета истекла."""


class CabinetBusyError(CabinetError):
    """Профиль занят другим процессом (SingletonLock) — попробовать позже."""


def retry_delay(status, attempt):
    """Секунды до следующей попытки или None (не повторять). attempt — номер
    неудачной попытки, начиная с 1; максимум 4 повтора."""
    if attempt > 4:
        return None
    if status == 429:
        return 5 * 2 ** (attempt - 1)
    if status is None or status >= 500:
        return 2 * 2 ** (attempt - 1)
    return None


def classify_response(status, text):
    if status in (401, 403):
        return "auth"
    if status == 429 or status >= 500:
        return "retry"
    if status == 200:
        s = (text or "").lstrip()[:15].lower()
        # кабинет при протухшей сессии отдаёт HTML формы входа с 200
        return "ok" if s.startswith("{") or s.startswith("[") else "auth"
    return "error"


class CabinetClient:
    def __init__(self, company_id, profile_dir, *, request=None):
        self.company_id = str(company_id)
        self.profile_dir = str(profile_dir)
        self._req = request      # тест подсовывает фейк; боевой — ctx.request из __enter__
        self._pw = self._ctx = None

    # ── жизненный цикл браузера ──────────────────────────────────────
    def __enter__(self):
        if self._req is not None:
            return self
        if not os.path.isdir(self.profile_dir):
            raise CabinetError(f"нет профиля браузера: {self.profile_dir}")
        from playwright.sync_api import sync_playwright  # ленивый импорт
        self._pw = sync_playwright().start()
        try:
            self._ctx = self._pw.chromium.launch_persistent_context(
                self.profile_dir, headless=False, args=LAUNCH_ARGS)
        except Exception as e:  # noqa: BLE001 — тип ошибки Playwright не стабилен
            self._pw.stop()
            msg = str(e)
            if "SingletonLock" in msg or "already running" in msg or "Failed to launch" in msg:
                raise CabinetBusyError(f"профиль занят другим процессом: {msg[:200]}") from e
            raise CabinetError(f"не удалось запустить Chromium: {msg[:200]}") from e
        self._req = self._ctx.request
        return self

    def __exit__(self, *exc):
        try:
            if self._ctx is not None:
                self._ctx.close()
        finally:
            if self._pw is not None:
                self._pw.stop()
        self._req = None if self._ctx is not None else self._req
        return False

    # ── вызовы ──────────────────────────────────────────────────────
    def _headers(self):
        return {**HDRS, "x-o3-company-id": self.company_id}

    def _call(self, method, path, params=None, payload=None):
        if path not in ALLOWED_PATHS:
            raise CabinetError(f"путь {path} не входит в ALLOWED_PATHS (клиент только читает)")
        if self._req is None:
            raise CabinetError("клиент не открыт: используйте `with CabinetClient(...) as c:`")
        url = BASE + path
        attempt = 0
        while True:
            attempt += 1
            status, text = None, ""
            try:
                if method == "GET":
                    r = self._req.get(url, headers=self._headers(), params=params or {}, timeout=TIMEOUT_MS)
                else:
                    r = self._req.post(url, headers=self._headers(),
                                       data=json.dumps(payload or {}, ensure_ascii=False), timeout=TIMEOUT_MS)
                status, text = r.status, r.text()
            except Exception as e:  # noqa: BLE001 — сеть/таймаут Playwright
                text = f"{type(e).__name__}: {str(e)[:200]}"
            kind = "retry" if status is None else classify_response(status, text)
            if kind == "ok":
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    # обрезанный/битый 200-ответ — не наша вина, но и не документ;
                    # трактуем как сетевую ошибку (status=None) и идём по тому же плану ретраев
                    kind = "retry"
                    status = None
            if kind == "auth":
                raise CabinetAuthError(f"{path}: HTTP {status} — сессия кабинета истекла: {text[:120]}")
            if kind == "retry":
                delay = retry_delay(status, attempt)
                if delay is not None:
                    reason = f"HTTP {status}" if status is not None else "битый ответ/сеть"
                    print(f"  [cabinet] {path}: {reason}, повтор через {delay}с", flush=True)
                    SLEEP(delay)
                    continue
            raise CabinetError(f"{path}: HTTP {status}: {text[:300]}")

    def get(self, path, params):
        return self._call("GET", path, params=params)

    def post(self, path, payload):
        return self._call("POST", path, payload=payload)

    def check(self):
        """Без исключения = сессия жива."""
        self.post("/api/v1/products/list-by-filter", {
            "company_id": self.company_id, "filters": {"search": "", "categories": [], "flags": []},
            "aggregate": {"parts": ["PART_ITEM"], "human_texts": True}, "return_total_items": True,
            "visibility": "IN_SALE", "sort_by": "SORT_BY_CREATED_AT", "sort_dir": "SORT_DIRECTION_DESC",
            "limit": 1, "cursor": ""})


def from_env():
    cid = os.environ.get("OZON_CABINET_COMPANY_ID")
    pdir = os.environ.get("OZON_CABINET_PROFILE_DIR")
    if not (cid and pdir):
        raise CabinetError("нет OZON_CABINET_COMPANY_ID / OZON_CABINET_PROFILE_DIR — у магазина не настроен кабинет")
    return CabinetClient(cid, pdir)
