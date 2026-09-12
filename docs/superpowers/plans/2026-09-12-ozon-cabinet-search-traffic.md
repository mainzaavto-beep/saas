# Ozon: позиции по запросам и трафик из кабинета — план внедрения

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собирать из кабинета продавца Ozon (seller.ozon.ru, сохранённый профиль Chromium) дневные позиции товаров по поисковым запросам и разложение трафика по SKU, хранить в PG и показывать на новой странице «Поиск и запросы» и в «Детальной сводке».

**Architecture:** Клиент кабинета на Playwright (`worker/cabinet_client.py`, отдельный venv `worker/.venv-cabinet`, только чтение) → два сборщика `ozon_cabinet_search` / `ozon_cabinet_traffic` (парсеры — чистые функции) → три таблицы `tenant.*` (миграция 058) → `lib/ozonSearch.js` (чистые функции) → API `/api/cabinets/[id]/search` + страница `/cabinets/[id]/search`; блок трафика в `/detail`. Доступ к кабинету — свойство магазина (`auth.shops.cabinet_*`), истёкшая сессия изолируется как «сломанные ключи» (состояние, баннер, письмо, `/health`).

**Tech Stack:** Python 3.14 (playwright 1.62.0, psycopg 3.3.4), PostgreSQL 16 (RLS), Next.js 14 App Router, systemd-таймеры, селф-тесты без сети/БД (`check()` PASS/FAIL, exit code).

**Spec:** `docs/superpowers/specs/2026-09-12-ozon-cabinet-search-traffic-design.md`

## Global Constraints

- Кабинет — **только чтение**: клиент ходит лишь по путям из `ALLOWED_PATHS` (§4.2 спеки); никаких методов, меняющих кабинет.
- Профиль `/opt/agents/ozon-panel/backend/.pw-profile` **не копировать, не выгружать**; один процесс на профиль (flock + расписание мимо 07:00 ozon-panel, §4.3).
- Запуск браузера: `headless=False`, `DISPLAY=:99`, без `HTTP_PROXY`/`HTTPS_PROXY`, `--disable-blink-features=AutomationControlled`, `--window-position=-2400,-2400`.
- Playwright **1.62.0**, браузер общий `~/.cache/ms-playwright` — `playwright install` **не запускать**.
- Сессия истекла (401/403, форма входа) → сам **никогда не логинится**; код выхода 5 + маркер `CABINET_AUTH_EXPIRED:` в stderr.
- Пробы и ручные прогоны — **только кабинет #1** (правило AGENTS.md); в боевую БД пишем через `PGPASSFILE=/root/.pgpass-admin`, читаем под `saas_ro`.
- Окно кабинета `get-search-query-analytics-details`/`get-seller-items…`: день `d` = `periodFrom=dT00:00:00Z, periodTo=(d+1)T00:00:00Z` (правая граница исключающая); `charts/v3/table/by_sku`: `date_from=date_to=d` (включающая).
- Сборщик не трогает БД до похода в сеть; запись дня — одной транзакцией; upsert идемпотентен.
- Новые расчёты витрины — только в `lib/ozonSearch.js`, никаких формул в роутах; заказы/GMV кабинетной статистики подписываются «по запросу» и не смешиваются с `ozon_orders`.
- Регистрация сборщика = `worker/orchestrator.py` **и** `worker/run_saas_collect.sh` (гард в задаче 6).
- Коммиты: только явный список файлов в `git add` (урок 26.08), сообщения на русском, хвост `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` и `Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3`.
- Селф-тесты Python запускаются интерпретатором воркера `/opt/agents/data-presenter-agent/.venv/bin/python` (клиент — `worker/.venv-cabinet/bin/python`), JS — `node scripts/<name>.mjs`; все печатают `PASS/FAIL` и выходят ненулевым кодом при провале.

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| `db/migrations/058_ozon_cabinet_search_traffic.sql` | 3 таблицы + RLS, колонки `auth.shops.cabinet_*`, `run_kind 'cabinet'` |
| `worker/cabinet_client.py` | Playwright-клиент кабинета: запуск, заголовки, ретраи, классы ошибок, `ALLOWED_PATHS` |
| `worker/cabinet_client_selftest.py` | ретраи/ошибки/гард путей на фейковом request-контексте |
| `worker/cabinet_state.py` | состояние сессии кабинета магазина (`mark_expired`/`mark_ok`/`should_skip`) |
| `worker/collectors/ozon_cabinet_search.py` | сводка по SKU + запросы по SKU за день → `ozon_sku_search_daily`, `ozon_search_queries_daily` |
| `worker/collectors/ozon_cabinet_traffic.py` | `charts/v3/table/by_sku` за день → `ozon_sku_traffic_daily` |
| `worker/collectors/ozon_cabinet_selftest.py` | парсеры обоих сборщиков на фикстурах |
| `worker/db_pg.py` | `replace_ozon_search_day`, `replace_ozon_traffic_day`, `ozon_sku2pid` |
| `worker/orchestrator.py` | `CABINET_COLLECTORS`, env профиля, пропуск без профиля/при `expired`, код 5 |
| `worker/run_saas_collect.sh` | режим `cabinet` (venv, DISPLAY, без прокси, flock) |
| `deploy/systemd/saas-cabinet.{service,timer}` | таймер 06:00 и 20:00 MSK |
| `scripts/test-cabinet-registration.py` | гард регистрации сборщиков и режима `cabinet` |
| `scripts/check-ozon-cabinet.sql` | сторож данных (4 проверки) |
| `scripts/check-ozon-cabinet-drr.sql` | сверка ДРР кабинета и панели по SKU |
| `app/cabinets/[id]/layout.js`, `scripts/notify-broken-keys.mjs`, `app/api/health/route.js`, `app/health/HealthPage.jsx` | баннер / письмо / health для `cabinet_state='expired'` |
| `lib/ozonSearch.js` + `scripts/check-ozon-search-selftest.mjs` | чистые расчёты страницы «Поиск и запросы» |
| `app/api/cabinets/[id]/search/route.js` | чтение БД + вызов `lib/ozonSearch.js` |
| `app/cabinets/[id]/search/{page.js,SearchPage.jsx}` | страница |
| `app/api/cabinets/[id]/detail/route.js`, `app/cabinets/[id]/detail/DetailPage.jsx` | блок «Трафик по дням» |
| `AGENTS.md`, `docs/metrics-contract.md` | документация |

---

### Task 1: Миграция 058 — таблицы, колонки магазина, run_kind

**Files:**
- Create: `db/migrations/058_ozon_cabinet_search_traffic.sql`

**Interfaces:**
- Produces: таблицы `tenant.ozon_search_queries_daily`, `tenant.ozon_sku_search_daily`, `tenant.ozon_sku_traffic_daily` (колонки — как в спеке §5, ниже дословно); колонки `auth.shops.cabinet_company_id TEXT`, `cabinet_profile_dir TEXT`, `cabinet_state TEXT ('none'|'ok'|'expired')`, `cabinet_last_error TEXT`, `cabinet_failed_at`, `cabinet_last_attempt_at`, `cabinet_notified_at TIMESTAMPTZ`; `run_kind 'cabinet'` в CHECK `jobs.collector_runs`.

- [ ] **Step 1: Написать миграцию**

```sql
-- 058_ozon_cabinet_search_traffic.sql — позиции по запросам и трафик Ozon из
-- кабинета продавца (спека docs/superpowers/specs/2026-09-12-ozon-cabinet-search-
-- traffic-design.md). Три дневные таблицы по SKU (сборщики ozon_cabinet_search /
-- ozon_cabinet_traffic), доступ к кабинету как свойство магазина (auth.shops.
-- cabinet_*), run_kind 'cabinet' для таймера saas-cabinet. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.ozon_search_queries_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,           -- день [d, d+1) по кабинету
    query         TEXT   NOT NULL,
    product_id    BIGINT,                    -- ozon_products по fbo_sku; NULL — нет в каталоге
    position      INTEGER,                   -- средняя позиция по запросу за день
    search_users  INTEGER,                   -- uniqueSearchUsers: спрос
    view_users    INTEGER,                   -- uniqueViewUsers
    ctr           DOUBLE PRECISION,          -- queryCtr, %
    click_users   INTEGER,                   -- uniqueClickUsers
    orders        INTEGER,                   -- orderCount («заказов по запросу»)
    gmv           DOUBLE PRECISION,          -- ₽ («GMV по запросу»)
    query_index   INTEGER,                   -- порядок по спросу в ответе кабинета
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date, query)
);
CREATE INDEX IF NOT EXISTS ozon_search_queries_daily_date_idx  ON tenant.ozon_search_queries_daily (cabinet_id, date);
CREATE INDEX IF NOT EXISTS ozon_search_queries_daily_query_idx ON tenant.ozon_search_queries_daily (cabinet_id, query, date);

CREATE TABLE IF NOT EXISTS tenant.ozon_sku_search_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,
    product_id    BIGINT,
    name          TEXT,
    article       TEXT,
    category      TEXT,
    position      INTEGER,                   -- средняя позиция в поиске по всем запросам (КАНОН)
    search_users  INTEGER,
    view_users    INTEGER,
    ctr           DOUBLE PRECISION,
    gmv           DOUBLE PRECISION,
    showcases_visibility TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date)
);
CREATE INDEX IF NOT EXISTS ozon_sku_search_daily_date_idx ON tenant.ozon_sku_search_daily (cabinet_id, date);

CREATE TABLE IF NOT EXISTS tenant.ozon_sku_traffic_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,
    product_id    BIGINT,
    total_views   INTEGER, search_views INTEGER, pdp_views INTEGER,
    hits_search_to_cart INTEGER, hits_pdp_to_cart INTEGER, total_hits_to_cart INTEGER,
    conv_search_to_pdp  DOUBLE PRECISION, conv_pdp_to_cart DOUBLE PRECISION,
    conv_cart_to_order  DOUBLE PRECISION, conv_views_to_order DOUBLE PRECISION,
    ordered_units INTEGER, delivered_units INTEGER, cancelled_units INTEGER, returned_units INTEGER,
    revenue DOUBLE PRECISION, avg_price DOUBLE PRECISION, price_index TEXT,
    drr DOUBLE PRECISION,                    -- ДРР по SKU за день, % (кабинет; НЕ канон панели)
    days_in_trafarets INTEGER, days_in_promo INTEGER,
    search_position INTEGER,                 -- справочно; канон — ozon_sku_search_daily.position
    last_stock INTEGER, last_stock_fbo INTEGER, last_stock_fbs INTEGER, stockout_days INTEGER,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date)
);
CREATE INDEX IF NOT EXISTS ozon_sku_traffic_daily_date_idx ON tenant.ozon_sku_traffic_daily (cabinet_id, date);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ozon_search_queries_daily','ozon_sku_search_daily','ozon_sku_traffic_daily'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='tenant_iso_'||t) THEN
      EXECUTE format($p$CREATE POLICY %I ON tenant.%I FOR ALL TO saas_app
                       USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                       WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)$p$, 'tenant_iso_'||t, t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='panel_local_ro_cab1') THEN
      EXECUTE format('CREATE POLICY panel_local_ro_cab1 ON tenant.%I FOR SELECT TO panel_local_ro USING (cabinet_id = 1)', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.%I TO saas_app', t);
    EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
  END LOOP;
END $$;

-- Доступ к кабинету продавца — свойство магазина (секретов нет: путь к профилю на сервере).
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_company_id TEXT;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_profile_dir TEXT;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_last_error TEXT;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_failed_at TIMESTAMPTZ;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_last_attempt_at TIMESTAMPTZ;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS cabinet_notified_at TIMESTAMPTZ;
ALTER TABLE auth.shops DROP CONSTRAINT IF EXISTS shops_cabinet_state_check;
ALTER TABLE auth.shops ADD CONSTRAINT shops_cabinet_state_check CHECK (cabinet_state IN ('none','ok','expired'));

-- run_kind 'cabinet' для таймера saas-cabinet (по образцу 050/skuad).
ALTER TABLE jobs.collector_runs DROP CONSTRAINT IF EXISTS collector_runs_run_kind_check;
ALTER TABLE jobs.collector_runs ADD CONSTRAINT collector_runs_run_kind_check CHECK (run_kind IN
    ('main','stocks','metrics30m','references','backfill','systemd','manual','skuad','fbsstatus','cabinet'));

COMMIT;
```

- [ ] **Step 2: Применить миграцию и заполнить профиль кабинета #1**

```bash
cd /opt/agents/saas && PGPASSFILE=/root/.pgpass-admin psql -U postgres -h localhost -d saas -v ON_ERROR_STOP=1 -f db/migrations/058_ozon_cabinet_search_traffic.sql
PGPASSFILE=/root/.pgpass-admin psql -U postgres -h localhost -d saas -c \
  "UPDATE auth.shops SET cabinet_company_id='1428518', cabinet_profile_dir='/opt/agents/ozon-panel/backend/.pw-profile' WHERE shop_id=2 AND cabinet_id=1 AND mp_code='ozon'"
```

Ожидаемо: `UPDATE 1`. (Если `/root/.pgpass-admin` требует другого пользователя — см. память `db-access-split.md`; пользователя брать оттуда, не угадывать.)

- [ ] **Step 3: Проверить**

```bash
psql -U saas_ro -h localhost -d saas -Atc "select shop_id, cabinet_company_id, cabinet_profile_dir, cabinet_state from auth.shops where mp_code='ozon' order by 1"
psql -U saas_ro -h localhost -d saas -Atc "select tablename, count(*) from pg_policies where tablename in ('ozon_search_queries_daily','ozon_sku_search_daily','ozon_sku_traffic_daily') group by 1"
psql -U saas_ro -h localhost -d saas -Atc "select pg_get_constraintdef(oid) from pg_constraint where conname='collector_runs_run_kind_check'"
```

Ожидаемо: у shop 2 заполнены company/profile, `cabinet_state=none`; по 2 политики на таблицу; в CHECK есть `'cabinet'`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/058_ozon_cabinet_search_traffic.sql
git commit -m "feat(db): миграция 058 — позиции по запросам и трафик Ozon из кабинета, cabinet_* у магазина"
```

---

### Task 2: venv кабинета и клиент `worker/cabinet_client.py`

**Files:**
- Create: `worker/cabinet_client.py`, `worker/cabinet_client_selftest.py`
- Modify: `.gitignore` (добавить `worker/.venv-cabinet/`)

**Interfaces:**
- Produces:
  - `class CabinetError(Exception)`, `class CabinetAuthError(CabinetError)`, `class CabinetBusyError(CabinetError)`
  - `ALLOWED_PATHS: tuple[str, ...]`
  - `class CabinetClient(company_id: str, profile_dir: str, *, request=None)` — контекст-менеджер; `get(path: str, params: dict) -> dict`, `post(path: str, payload: dict) -> dict`; `check() -> None`.
  - `retry_delay(status: int | None, attempt: int) -> float | None` — чистая функция плана ретраев (None = не повторять).
  - `classify_response(status: int, text: str) -> str` — `'ok' | 'auth' | 'retry' | 'error'` (чистая).
  - `from_env() -> CabinetClient` — из `OZON_CABINET_COMPANY_ID`, `OZON_CABINET_PROFILE_DIR`.

- [ ] **Step 1: Создать venv (без `playwright install`) и проверить браузер**

```bash
cd /opt/agents/saas && python3 -m venv worker/.venv-cabinet \
 && worker/.venv-cabinet/bin/pip install -q "playwright==1.62.0" "psycopg[binary]==3.3.4" "requests==2.34.2" \
 && worker/.venv-cabinet/bin/python - <<'EOF'
from playwright.sync_api import sync_playwright
import tempfile
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), headless=True)
    print("chromium ok", ctx.browser.version if ctx.browser else "persistent")
    ctx.close()
EOF
printf '\n# venv сборщиков кабинета Ozon (playwright), задача 2 плана 2026-09-12\nworker/.venv-cabinet/\n' >> .gitignore
```

Ожидаемо: `chromium ok …` — значит браузер из `~/.cache/ms-playwright` подходит к 1.62.0. Если Playwright просит `playwright install` — **остановиться и сообщить владельцу** (новый браузер под чужим профилем ставить нельзя без решения).

- [ ] **Step 2: Написать падающий селф-тест клиента**

`worker/cabinet_client_selftest.py`:

```python
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
```

- [ ] **Step 3: Запустить — должен упасть**

Run: `worker/.venv-cabinet/bin/python worker/cabinet_client_selftest.py`
Expected: `ModuleNotFoundError: No module named 'cabinet_client'`

- [ ] **Step 4: Написать клиент**

`worker/cabinet_client.py`:

```python
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
                return json.loads(text)
            if kind == "auth":
                raise CabinetAuthError(f"{path}: HTTP {status} — сессия кабинета истекла: {text[:120]}")
            if kind == "retry":
                delay = retry_delay(status, attempt)
                if delay is not None:
                    print(f"  [cabinet] {path}: HTTP {status}, повтор через {delay}с", flush=True)
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
```

- [ ] **Step 5: Прогнать селф-тест**

Run: `worker/.venv-cabinet/bin/python worker/cabinet_client_selftest.py`
Expected: все `PASS`, `ALL PASS 0`.

- [ ] **Step 6: Живая проверка `check()` (кабинет #1, только чтение, профиль свободен: не 07:00 и ozon-panel не синкается)**

```bash
cd /opt/agents/saas && env -u HTTP_PROXY -u HTTPS_PROXY DISPLAY=:99 OZON_CABINET_COMPANY_ID=1428518 \
  OZON_CABINET_PROFILE_DIR=/opt/agents/ozon-panel/backend/.pw-profile \
  worker/.venv-cabinet/bin/python -c "
import sys; sys.path.insert(0,'worker')
import cabinet_client as cc
with cc.from_env() as c:
    c.check(); print('сессия жива')
    print(c.get('/api/search-query-analytics/v1/get-dates', {'seller_id': '1428518'}))
"
```

Expected: `сессия жива` и `{'actual': {...}, 'minStatisticsTime': '2026-08-04T00:00:00Z'}`. При `CabinetBusyError` — подождать и повторить; при `CabinetAuthError` — сообщить владельцу, не логиниться.

- [ ] **Step 7: Commit**

```bash
git add worker/cabinet_client.py worker/cabinet_client_selftest.py .gitignore
git commit -m "feat(worker): клиент кабинета Ozon на Playwright (только чтение, ретраи, гард путей) + селф-тест"
```

---

### Task 3: Сборщик `ozon_cabinet_search` (сводка по SKU + запросы по дням)

**Files:**
- Create: `worker/collectors/ozon_cabinet_search.py`, `worker/collectors/ozon_cabinet_selftest.py`
- Modify: `worker/db_pg.py` (добавить `ozon_sku2pid`, `replace_ozon_search_day`)

**Interfaces:**
- Consumes: `cabinet_client.from_env()`, `CabinetClient.get/post`, `CabinetAuthError`, `CabinetBusyError`.
- Produces:
  - `db_pg.ozon_sku2pid() -> dict[int, int]` (fbo_sku → product_id, текущий кабинет).
  - `db_pg.replace_ozon_search_day(day: str, sku_rows: list[dict], query_rows: list[dict]) -> tuple[int, int]` — одна транзакция: `DELETE` строк дня по `sku` из `sku_rows` в обеих таблицах, затем `INSERT`.
  - `ozon_cabinet_search.day_window(day: str) -> tuple[str, str]` → `('2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z')`.
  - `parse_items_summary(resp: dict, day: str, sku2pid: dict) -> list[dict]` — строки `ozon_sku_search_daily` (ключи = колонки без `cabinet_id/updated_at`).
  - `parse_query_page(resp: dict, day: str, sku: int, pid) -> list[dict]` — строки `ozon_search_queries_daily`.
  - `collect(date_from: str, date_to: str) -> int` (exit-контракт: 0 ok, 3 partial, 5 auth).

- [ ] **Step 1: Падающий селф-тест парсеров (обоих сборщиков — файл общий, трафик добавится в задаче 4)**

`worker/collectors/ozon_cabinet_selftest.py`:

```python
"""Селф-тест парсеров сборщиков кабинета Ozon (без сети/БД) на фикстурах из
живых проб 12.09.2026 (только наши SKU). Запуск:
/opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_cabinet_selftest.py"""
import os, sys
_D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _D); sys.path.insert(0, os.path.dirname(_D))
os.environ.setdefault("WB_SaaS_CABINET_ID", "1")
import ozon_cabinet_search as s  # noqa: E402

failed = 0
def check(name, cond, detail=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failed += 1

SKU2PID = {4988596186: 1001, 3988620820: 1002}

# ── окно дня: правая граница исключающая ──
check("окно дня", s.day_window("2026-09-10") == ("2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z"), s.day_window("2026-09-10"))

# ── сводка по SKU (get-seller-items-search-query-analytics v2) ──
ITEMS = {"items": [
    {"sku": "4988596186", "name": "TechStore 64 ГБ Карта памяти", "article": "карта 64", "category": "EPG",
     "uniqueSearchUsers": 32209, "position": 29, "uniqueViewUsers": 2785, "queryCtr": 3.1, "gmv": 8313,
     "currency": "RUB", "showcasesVisibility": "SHOWCASES_VISIBILITY_BO", "badges": []},
    {"sku": "5518622944", "name": "Комплект нижнего белья JOIS", "article": "шоколад", "category": "Одежда и обувь",
     "uniqueSearchUsers": 46066, "position": 252, "uniqueViewUsers": 51, "queryCtr": 1.96, "gmv": 0,
     "currency": "RUB", "showcasesVisibility": "SHOWCASES_VISIBILITY_BO", "badges": []},
], "totalNumberOfItems": 0, "totalPagesCount": 0}
rows = s.parse_items_summary(ITEMS, "2026-09-10", SKU2PID)
check("сводка: 2 строки", len(rows) == 2, rows)
r0 = rows[0]
check("сводка: sku int, date, канон position", (r0["sku"], r0["date"], r0["position"]) == (4988596186, "2026-09-10", 29), r0)
check("сводка: product_id из каталога", r0["product_id"] == 1001, r0)
check("сводка: SKU вне каталога → product_id None, строка НЕ теряется", rows[1]["product_id"] is None and rows[1]["sku"] == 5518622944, rows[1])
check("сводка: поля", (r0["search_users"], r0["view_users"], r0["ctr"], r0["gmv"], r0["showcases_visibility"]) == (32209, 2785, 3.1, 8313.0, "SHOWCASES_VISIBILITY_BO"), r0)
check("сводка: пустой ответ → []", s.parse_items_summary({"items": []}, "2026-09-10", SKU2PID) == [])

# ── запросы по SKU (get-search-query-analytics-details v2), страница 10 строк ──
PAGE = {"sku": "4988596186", "periodFrom": "2026-09-10T00:00:00Z", "periodTo": "2026-09-11T00:00:00Z", "queries": [
    {"query": "карта памяти", "position": 72, "competitorSku": "0", "uniqueSearchUsers": 1191, "uniqueViewUsers": 90,
     "queryCtr": 2.56, "gmv": 0, "currency": "RUB", "uniqueClickUsers": 2, "orderCount": 0, "queryIndex": 1},
    {"query": "карта памяти micro sd", "position": 114, "competitorSku": "0", "uniqueSearchUsers": 976, "uniqueViewUsers": 40,
     "queryCtr": 2.4, "gmv": 1455, "currency": "RUB", "uniqueClickUsers": 1, "orderCount": 2, "queryIndex": 2},
], "status": "DATA_EXISTS", "subscription": "PREMIUM_PLUS", "totalNumberOfQueries": 0, "totalPagesCount": 0}
q = s.parse_query_page(PAGE, "2026-09-10", 4988596186, 1001)
check("запросы: 2 строки", len(q) == 2, q)
check("запросы: ключи", (q[0]["sku"], q[0]["date"], q[0]["query"], q[0]["product_id"]) == (4988596186, "2026-09-10", "карта памяти", 1001), q[0])
check("запросы: метрики", (q[1]["position"], q[1]["search_users"], q[1]["orders"], q[1]["gmv"], q[1]["query_index"]) == (114, 976, 2, 1455.0, 2), q[1])
check("запросы: NO_DATA → []", s.parse_query_page({"queries": [], "status": "NO_DATA"}, "2026-09-11", 4988596186, 1001) == [])
check("запросы: пустой текст пропускается", s.parse_query_page({"queries": [{"query": "  ", "position": 1}]}, "2026-09-10", 1, 1) == [])
# дубль запроса внутри дня (кабинет иногда отдаёт один текст на двух страницах) — оставляем первый
dup = s.dedupe_queries(q + [dict(q[0], position=99)])
check("дубли по (sku, query) схлопнуты", len(dup) == 2 and dup[0]["position"] == 72, dup)

print("FAILED" if failed else "ALL PASS", failed)
sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Запустить — падает**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_cabinet_selftest.py`
Expected: `ModuleNotFoundError: No module named 'ozon_cabinet_search'`

- [ ] **Step 3: db_pg — маппинг и запись дня**

В `worker/db_pg.py` после `cleanup_ozon_metrics_30m` добавить:

```python
# ── Кабинет Ozon: позиции по запросам и трафик (миграция 058, план 2026-09-12) ──
_OZ_SKU_SEARCH_COLS = ["sku", "date", "product_id", "name", "article", "category", "position",
                       "search_users", "view_users", "ctr", "gmv", "showcases_visibility"]
_OZ_QUERY_COLS = ["sku", "date", "query", "product_id", "position", "search_users", "view_users",
                  "ctr", "click_users", "orders", "gmv", "query_index"]
_OZ_TRAFFIC_COLS = ["sku", "date", "product_id", "total_views", "search_views", "pdp_views",
                    "hits_search_to_cart", "hits_pdp_to_cart", "total_hits_to_cart",
                    "conv_search_to_pdp", "conv_pdp_to_cart", "conv_cart_to_order", "conv_views_to_order",
                    "ordered_units", "delivered_units", "cancelled_units", "returned_units",
                    "revenue", "avg_price", "price_index", "drr", "days_in_trafarets", "days_in_promo",
                    "search_position", "last_stock", "last_stock_fbo", "last_stock_fbs", "stockout_days"]


def ozon_sku2pid():
    """fbo_sku → product_id текущего кабинета (как в ozon_metrics_30m)."""
    out = {}
    for r in query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        out[int(r["fbo_sku"])] = int(r["product_id"])
    return out


def _replace_day(conn, table, cols, day, skus, rows):
    """Внутри транзакции: удалить строки дня по перечисленным sku, вставить новые."""
    cid = _cabinet_id()
    if skus:
        conn.execute(f"DELETE FROM tenant.{table} WHERE cabinet_id=%s AND date=%s AND sku = ANY(%s)",
                     (cid, day, list(skus)))
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    all_cols = ["cabinet_id"] + cols + ["updated_at"]
    sql = (f"INSERT INTO tenant.{table} ({', '.join(all_cols)}) VALUES ({', '.join(['%s'] * len(all_cols))}) "
           f"ON CONFLICT DO NOTHING")
    with conn.cursor() as cur:
        cur.executemany(sql, [[cid] + [r.get(c) for c in cols] + [now] for r in rows])
    return len(rows)


def replace_ozon_search_day(day, sku_rows, query_rows):
    """Один день кабинетной статистики поиска — одной транзакцией. Чужие SKU дня
    (не пришедшие в sku_rows) не трогаются. Возвращает (n_sku, n_queries)."""
    skus = {r["sku"] for r in sku_rows}
    with get_connection() as conn:
        n1 = _replace_day(conn, "ozon_sku_search_daily", _OZ_SKU_SEARCH_COLS, day, skus, sku_rows)
        n2 = _replace_day(conn, "ozon_search_queries_daily", _OZ_QUERY_COLS, day, skus, query_rows)
    return n1, n2


def replace_ozon_traffic_day(day, rows):
    skus = {r["sku"] for r in rows}
    with get_connection() as conn:
        return _replace_day(conn, "ozon_sku_traffic_daily", _OZ_TRAFFIC_COLS, day, skus, rows)
```

- [ ] **Step 4: Сборщик**

`worker/collectors/ozon_cabinet_search.py`:

```python
"""
SaaS-сборщик ПОЗИЦИЙ ПО ПОИСКОВЫМ ЗАПРОСАМ Ozon из кабинета продавца →
tenant.ozon_sku_search_daily (SKU × день: средняя позиция, спрос, CTR) и
tenant.ozon_search_queries_daily (SKU × день × запрос: позиция, спрос, клики,
заказы, GMV). Источник — раздел кабинета «Запросы моих товаров»
(search-query-analytics v2), спека docs/superpowers/specs/2026-09-12-ozon-cabinet-
search-traffic-design.md §3.1–3.2.

Окно дня: periodFrom = d, periodTo = d+1 (правая граница ИСКЛЮЧАЮЩАЯ — один и
тот же день в обеих границах даёт NO_DATA, проверено 12.09.2026). Лаг кабинета —
до суток: день ещё не готов → сводка пуста → «day_not_ready», БД не трогаем.
Страницы запросов — по 10, pageNumber с нуля, конец — пустой список.

Порядок на день: сводка по всем SKU (один вызов) → запросы только по SKU из
сводки. Запись дня — одной транзакцией ПОСЛЕ всех вызовов (db_pg.replace_ozon_
search_day), чужие SKU дня не трогаются. Идемпотентно.

Exit: 0 ok · 3 partial (день не готов / профиль занят) · 5 сессия кабинета
истекла (маркер CABINET_AUTH_EXPIRED в stderr → orchestrator → cabinet_state).
argv: [date_from] [date_to] (YYYY-MM-DD), по умолчанию — вчера.
SAAS_PROBE=1 — напечатать разбор первого дня и НЕ писать.
Селф-тест парсеров: ozon_cabinet_selftest.py.
"""
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg  # noqa: E402
import cabinet_client as cc  # noqa: E402

P_ITEMS = "/api/search-query-analytics/v2/get-seller-items-search-query-analytics"
P_DETAILS = "/api/search-query-analytics/v2/get-search-query-analytics-details"
PAGE_LIMIT = 200          # предохранитель: 10 запросов × 200 страниц на SKU
BUSY_RETRIES, BUSY_WAIT = 5, 60


def day_window(day):
    d = date.fromisoformat(day)
    return f"{d.isoformat()}T00:00:00Z", f"{(d + timedelta(days=1)).isoformat()}T00:00:00Z"


def _int(v):
    try:
        return int(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _float(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def parse_items_summary(resp, day, sku2pid):
    rows = []
    for it in resp.get("items") or []:
        sku = _int(it.get("sku"))
        if not sku:
            continue
        rows.append({
            "sku": sku, "date": day, "product_id": sku2pid.get(sku),
            "name": it.get("name") or None, "article": it.get("article") or None,
            "category": it.get("category") or None,
            "position": _int(it.get("position")),
            "search_users": _int(it.get("uniqueSearchUsers")),
            "view_users": _int(it.get("uniqueViewUsers")),
            "ctr": _float(it.get("queryCtr")), "gmv": _float(it.get("gmv")),
            "showcases_visibility": it.get("showcasesVisibility") or None,
        })
    return rows


def parse_query_page(resp, day, sku, pid):
    rows = []
    for q in resp.get("queries") or []:
        text = (q.get("query") or "").strip()
        if not text:
            continue
        rows.append({
            "sku": sku, "date": day, "query": text, "product_id": pid,
            "position": _int(q.get("position")),
            "search_users": _int(q.get("uniqueSearchUsers")),
            "view_users": _int(q.get("uniqueViewUsers")),
            "ctr": _float(q.get("queryCtr")),
            "click_users": _int(q.get("uniqueClickUsers")),
            "orders": _int(q.get("orderCount")), "gmv": _float(q.get("gmv")),
            "query_index": _int(q.get("queryIndex")),
        })
    return rows


def dedupe_queries(rows):
    seen, out = set(), []
    for r in rows:
        k = (r["sku"], r["query"])
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def fetch_day(client, company_id, day, sku2pid):
    """Все вызовы дня → (sku_rows, query_rows). Ничего не пишет."""
    pf, pt = day_window(day)
    summary = client.post(P_ITEMS, {"sellerId": company_id, "periodFrom": pf, "periodTo": pt,
                                    "itemsPerPage": 200, "pageNumber": 0})
    sku_rows = parse_items_summary(summary, day, sku2pid)
    query_rows = []
    for r in sku_rows:
        page = 0
        while page < PAGE_LIMIT:
            resp = client.get(P_DETAILS, {"sellerId": company_id, "sku": str(r["sku"]),
                                          "periodFrom": pf, "periodTo": pt, "pageNumber": str(page)})
            got = parse_query_page(resp, day, r["sku"], r["product_id"])
            if not got:
                break
            query_rows += got
            page += 1
    return sku_rows, dedupe_queries(query_rows)


def collect(date_from, date_to):
    probe = bool(os.environ.get("SAAS_PROBE"))
    company_id = os.environ.get("OZON_CABINET_COMPANY_ID", "")
    db_pg.init()
    sku2pid = db_pg.ozon_sku2pid()
    days = []
    d = date.fromisoformat(date_from)
    while d <= date.fromisoformat(date_to):
        days.append(d.isoformat())
        d += timedelta(days=1)
    print(f"[ozon_cabinet_search] дни {days[0]}..{days[-1]} | каталог {len(sku2pid)} sku", flush=True)

    total_sku = total_q = 0
    not_ready = []
    for attempt in range(1, BUSY_RETRIES + 1):
        try:
            with cc.from_env() as client:
                for day in days:
                    sku_rows, query_rows = fetch_day(client, company_id, day, sku2pid)
                    if not sku_rows:
                        not_ready.append(day)
                        print(f"  {day}: сводка пуста — day_not_ready", flush=True)
                        continue
                    if probe:
                        print(f"  PROBE {day}: {len(sku_rows)} sku, {len(query_rows)} запросов; "
                              f"первый sku {sku_rows[0]}; первый запрос {query_rows[0] if query_rows else None}", flush=True)
                        continue
                    n1, n2 = db_pg.replace_ozon_search_day(day, sku_rows, query_rows)
                    total_sku += n1
                    total_q += n2
                    print(f"  {day}: записано {n1} sku, {n2} запросов", flush=True)
            break
        except cc.CabinetBusyError as e:
            print(f"  профиль занят ({attempt}/{BUSY_RETRIES}): {e}", flush=True)
            if attempt == BUSY_RETRIES:
                print("cabinet_busy: профиль занят, тик пропущен", file=sys.stderr, flush=True)
                return 3
            cc.SLEEP(BUSY_WAIT)
        except cc.CabinetAuthError as e:
            print(f"CABINET_AUTH_EXPIRED: {e}", file=sys.stderr, flush=True)
            return 5

    print(f"[ozon_cabinet_search] итого {total_sku} sku, {total_q} запросов"
          + (f", не готовы: {','.join(not_ready)}" if not_ready else ""), flush=True)
    print(f"##OBS rows={total_sku + total_q} from={days[0]} to={days[-1]}", flush=True)
    return 3 if not_ready and len(not_ready) == len(days) else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    yday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    df = sys.argv[1] if len(sys.argv) > 1 else yday
    dt = sys.argv[2] if len(sys.argv) > 2 else df
    sys.exit(collect(df, dt))
```

- [ ] **Step 5: Селф-тест — зелёный**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_cabinet_selftest.py`
Expected: `ALL PASS 0`.

- [ ] **Step 6: Проба без записи, затем боевой прогон за один день (кабинет #1)**

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a
export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas SAAS_DB_USER=saas_app SAAS_DB_PASSWORD="$SAAS_APP_DB_PASSWORD"
export WB_SaaS_CABINET_ID=1 OZON_CABINET_COMPANY_ID=1428518 OZON_CABINET_PROFILE_DIR=/opt/agents/ozon-panel/backend/.pw-profile
D=$(date -d "-2 days" +%F)
env -u HTTP_PROXY -u HTTPS_PROXY DISPLAY=:99 SAAS_PROBE=1 worker/.venv-cabinet/bin/python -m worker.collectors.ozon_cabinet_search $D $D
env -u HTTP_PROXY -u HTTPS_PROXY DISPLAY=:99 worker/.venv-cabinet/bin/python -m worker.collectors.ozon_cabinet_search $D $D; echo "exit=$?"
psql -U saas_ro -h localhost -d saas -Atc "select date, count(*), count(product_id) from tenant.ozon_sku_search_daily where cabinet_id=1 group by 1; select date, count(*), count(distinct sku) from tenant.ozon_search_queries_daily where cabinet_id=1 group by 1"
```

Expected: проба печатает ~60 sku и сотни запросов; боевой прогон `exit=0`; в БД ≈60 строк сводки (почти все с `product_id`) и сотни запросов за день. Повторный запуск той же команды — те же числа (идемпотентность).

- [ ] **Step 7: Commit**

```bash
git add worker/collectors/ozon_cabinet_search.py worker/collectors/ozon_cabinet_selftest.py worker/db_pg.py
git commit -m "feat(worker): ozon_cabinet_search — позиции по запросам и сводка по SKU из кабинета Ozon по дням"
```

---

### Task 4: Сборщик `ozon_cabinet_traffic` (разложение трафика по SKU)

**Files:**
- Create: `worker/collectors/ozon_cabinet_traffic.py`
- Modify: `worker/collectors/ozon_cabinet_selftest.py` (добавить блок трафика)

**Interfaces:**
- Consumes: `db_pg.ozon_sku2pid`, `db_pg.replace_ozon_traffic_day`, `cabinet_client`.
- Produces: `ozon_cabinet_traffic.METRICS: list[str]`, `parse_traffic_page(resp, day, sku2pid) -> list[dict]`, `collect(date_from, date_to) -> int`.

- [ ] **Step 1: Добавить в селф-тест блок трафика (перед финальным `print`)**

```python
import ozon_cabinet_traffic as t  # noqa: E402
BYSKU = {"items": [{
    "productInfo": {"sku": "4988596186", "name": "TechStore 64 ГБ", "article": "карта 64", "sources": ["fbs", "fbo"]},
    "metrics": {"revenue": 368827, "searchPosition": 23, "totalViews": 182368, "searchViews": 32275,
                "convSearchViewsToCart": 0.17, "hitsSearchToCart": 56, "convSearchViewsToPdp": 10.37,
                "pdpViews": 3346, "convPdpViewsToCart": 12.67, "hitsPdpToCart": 424, "totalHitsToCart": 480,
                "convHitsToCartToOrder": 47.17, "convViewsToOrder": 0.11, "orderedUnits": 200,
                "deliveredUnits": 299, "cancelledUnits": 21, "returnedUnits": 8, "avgPrice": 1844,
                "priceIndex": "super", "daysInPromo": 7, "drr": 10, "daysInTrafarets": 7,
                "lastStock": 739, "lastStockFbo": 700, "lastStockFbs": 39, "stockoutDays": 12}},
    {"productInfo": {"sku": "9999", "name": "Без Premium-метрик"}, "metrics": {"orderedUnits": 3}},
]}
tr = t.parse_traffic_page(BYSKU, "2026-09-10", SKU2PID)
check("трафик: 2 строки", len(tr) == 2, tr)
a = tr[0]
check("трафик: ключи", (a["sku"], a["date"], a["product_id"]) == (4988596186, "2026-09-10", 1001), a)
check("трафик: показы/корзины", (a["total_views"], a["search_views"], a["pdp_views"], a["hits_search_to_cart"], a["hits_pdp_to_cart"], a["total_hits_to_cart"]) == (182368, 32275, 3346, 56, 424, 480), a)
check("трафик: конверсии", (a["conv_search_to_pdp"], a["conv_pdp_to_cart"], a["conv_cart_to_order"], a["conv_views_to_order"]) == (10.37, 12.67, 47.17, 0.11), a)
check("трафик: drr/трафареты/позиция", (a["drr"], a["days_in_trafarets"], a["days_in_promo"], a["search_position"], a["price_index"]) == (10.0, 7, 7, 23, "super"), a)
check("трафик: остатки", (a["last_stock"], a["last_stock_fbo"], a["last_stock_fbs"], a["stockout_days"]) == (739, 700, 39, 12), a)
b = tr[1]
check("трафик: отсутствующие метрики → NULL, не 0", b["total_views"] is None and b["drr"] is None and b["ordered_units"] == 3, b)
check("трафик: 22 метрики в запросе, ≤ лимита 30 SKU", len(t.METRICS) == 22 and t.PAGE == 30, t.METRICS)
```

- [ ] **Step 2: Запустить — падает на импорте `ozon_cabinet_traffic`**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_cabinet_selftest.py`
Expected: `ModuleNotFoundError: No module named 'ozon_cabinet_traffic'`

- [ ] **Step 3: Сборщик**

`worker/collectors/ozon_cabinet_traffic.py`:

```python
"""
SaaS-сборщик РАЗЛОЖЕНИЯ ТРАФИКА Ozon по SKU и дням из кабинета продавца →
tenant.ozon_sku_traffic_daily. Источник — таблица «Продажи моих товаров»
(charts/v3/table/by_sku), спека …/2026-09-12-ozon-cabinet-search-traffic-design.md §3.3.

Окно дня здесь ВКЛЮЧАЮЩЕЕ: date_from = date_to = d. Страницы по 30 SKU
(limit/offset, конец — пустой items). Метрики, которых кабинету не дали
(подписка), пишутся NULL, не 0. ДРР кабинета — справочная величина, канон
ДРР панели не подменяет (docs/metrics-contract.md §15.3).

Запись дня — одной транзакцией после всех страниц; exit-контракт как у
ozon_cabinet_search (0/3/5). argv: [date_from] [date_to]; SAAS_PROBE=1 — без записи.
"""
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg  # noqa: E402
import cabinet_client as cc  # noqa: E402

P_BYSKU = "/api/site/seller-analytics/charts/v3/table/by_sku"
PAGE = 30
METRICS = ["revenue", "search_position", "total_views", "search_views", "pdp_views",
           "hits_search_to_cart", "hits_pdp_to_cart", "total_hits_to_cart",
           "conv_search_views_to_pdp", "conv_pdp_views_to_cart", "conv_hits_to_cart_to_order",
           "conv_views_to_order", "ordered_units", "delivered_units", "cancelled_units",
           "returned_units", "avg_price", "drr", "days_in_trafarets", "days_in_promo",
           "last_stock", "stockout_days"]
# ключ ответа кабинета → колонка (int / float / text)
_MAP = [("totalViews", "total_views", int), ("searchViews", "search_views", int), ("pdpViews", "pdp_views", int),
        ("hitsSearchToCart", "hits_search_to_cart", int), ("hitsPdpToCart", "hits_pdp_to_cart", int),
        ("totalHitsToCart", "total_hits_to_cart", int),
        ("convSearchViewsToPdp", "conv_search_to_pdp", float), ("convPdpViewsToCart", "conv_pdp_to_cart", float),
        ("convHitsToCartToOrder", "conv_cart_to_order", float), ("convViewsToOrder", "conv_views_to_order", float),
        ("orderedUnits", "ordered_units", int), ("deliveredUnits", "delivered_units", int),
        ("cancelledUnits", "cancelled_units", int), ("returnedUnits", "returned_units", int),
        ("revenue", "revenue", float), ("avgPrice", "avg_price", float), ("priceIndex", "price_index", str),
        ("drr", "drr", float), ("daysInTrafarets", "days_in_trafarets", int), ("daysInPromo", "days_in_promo", int),
        ("searchPosition", "search_position", int), ("lastStock", "last_stock", int),
        ("lastStockFbo", "last_stock_fbo", int), ("lastStockFbs", "last_stock_fbs", int),
        ("stockoutDays", "stockout_days", int)]
BUSY_RETRIES, BUSY_WAIT = 5, 60


def _cast(v, typ):
    if v in (None, ""):
        return None
    try:
        return typ(v) if typ is not str else str(v)
    except (TypeError, ValueError):
        return None


def parse_traffic_page(resp, day, sku2pid):
    rows = []
    for it in resp.get("items") or []:
        info, m = it.get("productInfo") or {}, it.get("metrics") or {}
        sku = _cast(info.get("sku"), int)
        if not sku:
            continue
        row = {"sku": sku, "date": day, "product_id": sku2pid.get(sku)}
        for src, col, typ in _MAP:
            row[col] = _cast(m.get(src), typ)
        rows.append(row)
    return rows


def fetch_day(client, day, sku2pid):
    rows, offset = [], 0
    while True:
        resp = client.post(P_BYSKU, {
            "current_period": {"date_from": day, "date_to": day},
            "filters": {"desc_type_ids": [], "category_3_ids": [], "category_2_ids": []},
            "limit": str(PAGE), "offset": str(offset), "metrics": METRICS})
        got = parse_traffic_page(resp, day, sku2pid)
        if not got:
            break
        rows += got
        offset += PAGE
        if offset > 10000:
            break
    return rows


def collect(date_from, date_to):
    probe = bool(os.environ.get("SAAS_PROBE"))
    db_pg.init()
    sku2pid = db_pg.ozon_sku2pid()
    days, d = [], date.fromisoformat(date_from)
    while d <= date.fromisoformat(date_to):
        days.append(d.isoformat())
        d += timedelta(days=1)
    print(f"[ozon_cabinet_traffic] дни {days[0]}..{days[-1]}", flush=True)
    total, not_ready = 0, []
    for attempt in range(1, BUSY_RETRIES + 1):
        try:
            with cc.from_env() as client:
                for day in days:
                    rows = fetch_day(client, day, sku2pid)
                    if not rows:
                        not_ready.append(day)
                        print(f"  {day}: пусто — day_not_ready", flush=True)
                        continue
                    if probe:
                        print(f"  PROBE {day}: {len(rows)} sku; первый {rows[0]}", flush=True)
                        continue
                    n = db_pg.replace_ozon_traffic_day(day, rows)
                    total += n
                    print(f"  {day}: записано {n} sku", flush=True)
            break
        except cc.CabinetBusyError as e:
            print(f"  профиль занят ({attempt}/{BUSY_RETRIES}): {e}", flush=True)
            if attempt == BUSY_RETRIES:
                print("cabinet_busy: профиль занят, тик пропущен", file=sys.stderr, flush=True)
                return 3
            cc.SLEEP(BUSY_WAIT)
        except cc.CabinetAuthError as e:
            print(f"CABINET_AUTH_EXPIRED: {e}", file=sys.stderr, flush=True)
            return 5
    print(f"[ozon_cabinet_traffic] итого {total} строк" + (f", не готовы: {','.join(not_ready)}" if not_ready else ""), flush=True)
    print(f"##OBS rows={total} from={days[0]} to={days[-1]}", flush=True)
    return 3 if not_ready and len(not_ready) == len(days) else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    yday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    df = sys.argv[1] if len(sys.argv) > 1 else yday
    dt = sys.argv[2] if len(sys.argv) > 2 else df
    sys.exit(collect(df, dt))
```

- [ ] **Step 4: Селф-тест зелёный**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_cabinet_selftest.py`
Expected: `ALL PASS 0`.

- [ ] **Step 5: Проба и боевой прогон за тот же день (тот же env, что в задаче 3, шаг 6)**

```bash
env -u HTTP_PROXY -u HTTPS_PROXY DISPLAY=:99 SAAS_PROBE=1 worker/.venv-cabinet/bin/python -m worker.collectors.ozon_cabinet_traffic $D $D
env -u HTTP_PROXY -u HTTPS_PROXY DISPLAY=:99 worker/.venv-cabinet/bin/python -m worker.collectors.ozon_cabinet_traffic $D $D; echo "exit=$?"
psql -U saas_ro -h localhost -d saas -Atc "select date, count(*), count(total_views), round(avg(drr)::numeric,1) from tenant.ozon_sku_traffic_daily where cabinet_id=1 group by 1"
```

Expected: `exit=0`, ≈150 строк (все SKU каталога, у части метрики NULL), `total_views` заполнен у активных.

- [ ] **Step 6: Commit**

```bash
git add worker/collectors/ozon_cabinet_traffic.py worker/collectors/ozon_cabinet_selftest.py
git commit -m "feat(worker): ozon_cabinet_traffic — разложение трафика, ДРР и остатки по SKU из кабинета Ozon по дням"
```

---

### Task 5: Состояние сессии кабинета, оркестратор, режим `cabinet`, systemd

**Files:**
- Create: `worker/cabinet_state.py`, `deploy/systemd/saas-cabinet.service`, `deploy/systemd/saas-cabinet.timer`, `scripts/test-cabinet-registration.py`
- Modify: `worker/orchestrator.py` (`_read_cabinets`/`_read_one_cabinet` SELECT, `_group_cabinets` — проверить перенос полей shop, `PAUSE_EXEMPT_COLLECTORS`, `OZON_COLLECTORS`, `_env_for_shop`, `_run_one`), `worker/run_saas_collect.sh`

**Interfaces:**
- Consumes: exit-код 5 + `CABINET_AUTH_EXPIRED:` из сборщиков задач 3–4.
- Produces: `cabinet_state.load_state(shop_id) -> dict`, `mark_expired(shop_id, error)`, `mark_ok(shop_id)`, `should_skip(state, now=None) -> bool` (expired и последняя попытка моложе 20 ч); `orchestrator.CABINET_COLLECTORS = {"ozon_cabinet_search", "ozon_cabinet_traffic"}`; режим `run_saas_collect.sh cabinet`.

- [ ] **Step 1: Гард регистрации (падающий)**

`scripts/test-cabinet-registration.py`:

```python
#!/usr/bin/env python3
"""Гард регистрации сборщиков кабинета Ozon (урок 2026-08-15: регистрация =
оркестратор И run_saas_collect.sh). Часть проверок — исполнением вырезанного
блока shell-скрипта с фейками, не текстом (методика testing-discipline §4).
Запуск: python3 scripts/test-cabinet-registration.py"""
import ast, os, re, subprocess, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failed = 0
def check(name, cond, detail=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failed += 1

COLLS = {"ozon_cabinet_search", "ozon_cabinet_traffic"}

# 1. Оркестратор: списки через AST (без импорта — импорт тянет psycopg/env).
tree = ast.parse(open(os.path.join(ROOT, "worker/orchestrator.py"), encoding="utf-8").read())
lists = {}
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        try:
            lists[node.targets[0].id] = ast.literal_eval(node.value)
        except Exception:
            pass
check("OZON_COLLECTORS содержит оба сборщика", COLLS <= set(lists.get("OZON_COLLECTORS", [])), lists.get("OZON_COLLECTORS"))
check("ozon_catalog раньше сборщиков кабинета", lists["OZON_COLLECTORS"].index("ozon_catalog") < min(lists["OZON_COLLECTORS"].index(c) for c in COLLS))
check("CABINET_COLLECTORS объявлен", set(lists.get("CABINET_COLLECTORS", [])) == COLLS, lists.get("CABINET_COLLECTORS"))
src = open(os.path.join(ROOT, "worker/orchestrator.py"), encoding="utf-8").read()
m = re.search(r'SAAS_PAUSE_EXEMPT",\s*"([^"]+)"', src)
check("PAUSE_EXEMPT по умолчанию включает сборщики кабинета", m and COLLS <= set(m.group(1).split(",")), m and m.group(1))

# 2. run_saas_collect.sh: режим cabinet — исполняем блок case с фейком, смотрим переменные.
sh = open(os.path.join(ROOT, "worker/run_saas_collect.sh"), encoding="utf-8").read()
block = sh[sh.index("# Списки сборщиков по группам."):sh.index("# Диапазон дат")]
script = "MODE=cabinet\nDAYS_FROM=\nDAYS_TO=0\n" + block + "\necho \"COLLECTORS=$COLLECTORS\"; echo \"DAYS_FROM=$DAYS_FROM\"; echo \"DAYS_TO=$DAYS_TO\"; echo \"PY=$PY\"; echo \"DISPLAY=$DISPLAY\"; echo \"HTTP_PROXY=${HTTP_PROXY:-unset}\"\n"
with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
    f.write(script)
out = subprocess.run(["bash", f.name], capture_output=True, text=True, env={**os.environ, "HTTP_PROXY": "http://user:pw@proxy:3128"}).stdout
vals = dict(line.split("=", 1) for line in out.strip().splitlines() if "=" in line)
check("cabinet: оба сборщика", set(vals.get("COLLECTORS", "").split(",")) == COLLS, vals)
check("cabinet: окно 3 дня по вчера", (vals.get("DAYS_FROM"), vals.get("DAYS_TO")) == ("3", "1"), vals)
check("cabinet: интерпретатор .venv-cabinet", vals.get("PY", "").endswith("worker/.venv-cabinet/bin/python"), vals)
check("cabinet: DISPLAY=:99", vals.get("DISPLAY") == ":99", vals)
check("cabinet: прокси снят", vals.get("HTTP_PROXY") == "unset", vals)
check("cabinet: flock на /run/lock/saas-cabinet.lock", "flock" in sh and "/run/lock/saas-cabinet.lock" in sh)

# 3. systemd: юнит и таймер.
svc = open(os.path.join(ROOT, "deploy/systemd/saas-cabinet.service"), encoding="utf-8").read()
tmr = open(os.path.join(ROOT, "deploy/systemd/saas-cabinet.timer"), encoding="utf-8").read()
check("service зовёт режим cabinet", "run_saas_collect.sh cabinet" in svc)
check("service: OnFailure", "OnFailure=saas-failure@%n.service" in svc)
check("timer: 06:00 и 20:00, не 07:00", "06,20:00:00" in tmr and "07:" not in tmr, tmr)

print("FAILED" if failed else "ALL PASS", failed)
sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Запустить — падает (нет CABINET_COLLECTORS, режима, юнитов)**

Run: `python3 scripts/test-cabinet-registration.py`
Expected: несколько `FAIL`, exit 1.

- [ ] **Step 3: `worker/cabinet_state.py`**

```python
"""Состояние сессии кабинета продавца Ozon у магазина (auth.shops.cabinet_*) —
зеркало worker/shop_auth.py для «сломанных ключей», но проще: одно состояние
'expired' без счётчиков (сессия либо жива, либо нет; вход делает только владелец).
Пока expired — оркестратор пропускает сборщики кабинета, раз в RETRY_HOURS
пробует снова (владелец мог войти). Успех → 'ok'. Письмо/баннер читают
cabinet_state/cabinet_failed_at/cabinet_notified_at (задача 6)."""
import os
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

PG = dict(host=os.environ.get("SAAS_DB_HOST", "localhost"), port=int(os.environ.get("SAAS_DB_PORT", "5432")),
          dbname=os.environ.get("SAAS_DB", "saas"), user="postgres",
          password=os.environ.get("POSTGRES_PASSWORD", ""))
RETRY_HOURS = int(os.environ.get("SAAS_CABINET_RETRY_HOURS", "20"))


def load_state(shop_id):
    with psycopg.connect(**PG, row_factory=dict_row) as conn:
        return conn.execute(
            "SELECT cabinet_state, cabinet_failed_at, cabinet_last_attempt_at, cabinet_last_error "
            "FROM auth.shops WHERE shop_id = %s", (shop_id,)).fetchone() or {}


def mark_expired(shop_id, error):
    """Переход в expired; дата начала эпизода ставится один раз (для баннера/письма),
    последняя попытка двигается всегда (для should_skip)."""
    with psycopg.connect(**PG) as conn:
        conn.execute(
            """UPDATE auth.shops
                  SET cabinet_failed_at = CASE WHEN cabinet_state <> 'expired' THEN now() ELSE cabinet_failed_at END,
                      cabinet_notified_at = CASE WHEN cabinet_state <> 'expired' THEN NULL ELSE cabinet_notified_at END,
                      cabinet_state = 'expired',
                      cabinet_last_attempt_at = now(),
                      cabinet_last_error = %s
                WHERE shop_id = %s""", (str(error)[:500], shop_id))


def mark_ok(shop_id):
    with psycopg.connect(**PG) as conn:
        conn.execute(
            "UPDATE auth.shops SET cabinet_state = 'ok', cabinet_failed_at = NULL, cabinet_last_attempt_at = now(), "
            "       cabinet_last_error = NULL, cabinet_notified_at = NULL "
            " WHERE shop_id = %s AND cabinet_state <> 'ok'", (shop_id,))


def should_skip(state, now=None):
    """expired и последняя попытка моложе RETRY_HOURS → пропустить тик."""
    if (state or {}).get("cabinet_state") != "expired":
        return False
    last = state.get("cabinet_last_attempt_at")
    if not last:
        return False
    now = now or datetime.now(timezone.utc)
    return now - last < timedelta(hours=RETRY_HOURS)
```

Пароль `postgres` в воркере — как в `shop_auth.py`: проверить там имя переменной (`POSTGRES_PASSWORD`) и `PG`-словарь и **скопировать точно**, если отличается.

- [ ] **Step 4: Оркестратор**

Правки в `worker/orchestrator.py`:

1. `PAUSE_EXEMPT_COLLECTORS` — дефолт `"ozon_efficiency,ozon_cabinet_search,ozon_cabinet_traffic"`.
2. В `OZON_COLLECTORS` в конец:
```python
    "ozon_cabinet_search",   # кабинет продавца: позиции по запросам (миграция 058, таймер saas-cabinet)
    "ozon_cabinet_traffic",  # кабинет продавца: трафик/ДРР по SKU (тот же таймер)
```
3. После `OZON_COLLECTORS`:
```python
# Сборщики, ходящие не в Seller API, а в кабинет продавца под профилем браузера
# (worker/cabinet_client.py). Запускаются только у магазинов с cabinet_profile_dir;
# отказ сессии — exit 5 → cabinet_state.expired (не auth_state ключей).
CABINET_COLLECTORS = ["ozon_cabinet_search", "ozon_cabinet_traffic"]
```
4. В `_read_cabinets` и `_read_one_cabinet` SELECT добавить `s.cabinet_company_id, s.cabinet_profile_dir, s.cabinet_state,` после `s.mp_code,`. Открыть `_group_cabinets` (строка ~247) и убедиться, что shop-словарь собирается из всех `s.*` полей строки (если там явный список ключей — добавить три новых).
5. В `_env_for_shop` после блока `elif mp == "ozon":`:
```python
    if mp == "ozon" and shop.get("cabinet_profile_dir"):
        env["OZON_CABINET_COMPANY_ID"] = str(shop.get("cabinet_company_id") or "")
        env["OZON_CABINET_PROFILE_DIR"] = shop["cabinet_profile_dir"]
    if os.environ.get("DISPLAY"):          # Xvfb для Chromium (режим cabinet), не секрет
        env["DISPLAY"] = os.environ["DISPLAY"]
```
6. В `_run_one` сразу после `shop_collectors = _collectors_for_mp(mp, collectors)` / `if not shop_collectors: return`:
```python
    # Сборщики кабинета продавца — только у магазинов с профилем и живой сессией.
    cab = [c for c in shop_collectors if c in CABINET_COLLECTORS]
    if cab:
        shop_id_c = shop.get("shop_id")
        if not shop.get("cabinet_profile_dir"):
            for c in cab:
                _record_run(cid, c, "skipped", error="no_cabinet: у магазина не настроен профиль кабинета",
                            date_from=date_from, date_to=date_to)
            shop_collectors = [c for c in shop_collectors if c not in CABINET_COLLECTORS]
        else:
            cstate = cabinet_state.load_state(shop_id_c) if shop_id_c else {}
            if cabinet_state.should_skip(cstate):
                for c in cab:
                    _record_run(cid, c, "skipped", error=f"cabinet_expired: {cstate.get('cabinet_last_error') or 'сессия истекла'}",
                                date_from=date_from, date_to=date_to)
                shop_collectors = [c for c in shop_collectors if c not in CABINET_COLLECTORS]
        if not shop_collectors:
            return [], [], [f"{mp}:cabinet"]
```
   (импорт `import cabinet_state` рядом с `import shop_auth`).
7. В цикле после ветки `elif r.returncode == 3:` добавить ветку **до** общего `else`:
```python
            elif r.returncode == 5 and coll in CABINET_COLLECTORS:
                err = (r.stderr or "").strip().splitlines()
                marker = next((l for l in reversed(err) if l.startswith("CABINET_AUTH_EXPIRED")), err[-1] if err else "сессия истекла")
                print(f"{label} CABINET EXPIRED: {marker}", flush=True)
                statuses[coll] = "skipped"
                _record_run(cid, coll, "skipped", error=f"cabinet_expired: {marker[:300]}",
                            date_from=date_from, date_to=date_to, started_at=started)
                if shop.get("shop_id"):
                    cabinet_state.mark_expired(shop["shop_id"], marker)
                blocked_cabinet.append(coll)
```
   и в ветке `returncode == 0` для `coll in CABINET_COLLECTORS` — `cabinet_state.mark_ok(shop["shop_id"])`. Объявить `blocked_cabinet = []` рядом с `auth_failed_collectors` и добавить его к возвращаемому `blocked` (`blocked = auth_failed + blocked_cabinet + [...]` в обеих точках возврата, где формируется `blocked`).

- [ ] **Step 5: `run_saas_collect.sh` — режим `cabinet`**

В блок списков (перед `case`) добавить:
```bash
# 2026-09-12: сборщики кабинета продавца Ozon (позиции по запросам, трафик по SKU) —
# Playwright под профилем владельца (worker/cabinet_client.py). Свой venv с
# playwright (worker/.venv-cabinet), Xvfb :99, без прокси, flock на профиль
# (один процесс на профиль; ozon-panel синкается в 07:00 — таймер saas-cabinet
# идёт в 06:00 и 20:00). Окно 3 дня по вчера — лаг кабинета до суток.
CABINET_COLLECTORS="ozon_cabinet_search,ozon_cabinet_traffic"
```
В `case`:
```bash
  cabinet)    COLLECTORS="$CABINET_COLLECTORS";    DAYS_FROM="${DAYS_FROM:-3}"; DAYS_TO="${DAYS_TO_ARG:-1}"
              PY=/opt/agents/saas/worker/.venv-cabinet/bin/python
              export DISPLAY=:99; unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
              LOCK="flock -w 600 -E 75 /run/lock/saas-cabinet.lock" ;;
```
Сверху скрипта заменить `DAYS_TO="${3:-0}"` на `DAYS_TO_ARG="${3:-}"; DAYS_TO="${3:-0}"` (чтобы режим мог задать свой дефолт «вчера»). Ниже, где `PY=/opt/agents/data-presenter-agent/.venv/bin/python`, сделать `PY="${PY:-/opt/agents/data-presenter-agent/.venv/bin/python}"`, и строку запуска — `${LOCK:-} $PY -m worker.orchestrator …`. Обновить сообщение `Неизвестный режим` (добавить `cabinet`).

- [ ] **Step 6: systemd**

`deploy/systemd/saas-cabinet.service`:
```ini
[Unit]
Description=SAAS Cabinet — позиции по запросам и трафик Ozon из кабинета продавца (06:00, 20:00)
After=network.target postgresql.service
Requires=postgresql.service
OnFailure=saas-failure@%n.service

[Service]
Type=oneshot
User=root
Group=root
# Playwright под сохранённым профилем владельца (worker/cabinet_client.py, только
# чтение). Xvfb :99 и снятие прокси выставляет run_saas_collect.sh в режиме cabinet.
# Бюджет: ~1000 вызовов на кабинет за тик (3 дня) ≈ 10 мин; таймаут сборщика 25 мин.
Environment=SAAS_COLLECTOR_TIMEOUT_SEC=1500
Environment=TZ=Europe/Moscow
ExecStart=/opt/agents/saas/worker/run_saas_collect.sh cabinet
StandardOutput=journal
StandardError=journal
SyslogIdentifier=saas-cabinet
TimeoutStartSec=40min

[Install]
WantedBy=multi-user.target
```
`deploy/systemd/saas-cabinet.timer`:
```ini
[Unit]
Description=SAAS Cabinet — тики кабинета Ozon 06:00 и 20:00 MSK (мимо синка ozon-panel в 07:00)

[Timer]
OnCalendar=*-*-* 06,20:00:00
Persistent=true
AccuracySec=1min

[Install]
WantedBy=timers.target
```

- [ ] **Step 7: Гард и селф-тест оркестратора зелёные; установка юнитов**

```bash
python3 scripts/test-cabinet-registration.py
/opt/agents/data-presenter-agent/.venv/bin/python worker/orchestrator_selftest.py
bash deploy/install-systemd.sh && systemctl enable --now saas-cabinet.timer && systemctl list-timers 'saas-cabinet*' --no-pager
```
Expected: оба `ALL PASS`; таймер в списке с ближайшим запуском 06:00 или 20:00.

- [ ] **Step 8: Прогон через оркестратор в режиме cabinet (кабинет #1, руками, вне 07:00)**

```bash
cd /opt/agents/saas && worker/run_saas_collect.sh cabinet; echo "EXIT=$?"; tail -30 /opt/agentsDB/logs/saas_worker.log
psql -U saas_ro -h localhost -d saas -Atc "select collector, status, error, rows_written, date_from, date_to from jobs.collector_runs where run_kind='cabinet' order by id desc limit 6"
```
Expected: `EXIT=0`; у кабинета #1 обе строки `ok` (или `partial` с `day_not_ready` для вчерашнего дня, если кабинет ещё не отдал его — это норма); у #1008/#1009 — `skipped` с `no_cabinet`.

- [ ] **Step 9: Commit**

```bash
git add worker/cabinet_state.py worker/orchestrator.py worker/run_saas_collect.sh deploy/systemd/saas-cabinet.service deploy/systemd/saas-cabinet.timer scripts/test-cabinet-registration.py
git commit -m "feat(worker): режим cabinet — регистрация сборщиков кабинета Ozon, состояние сессии, таймер saas-cabinet 06:00/20:00"
```

---

### Task 6: Истёкшая сессия — баннер, письмо, /health

**Files:**
- Modify: `app/cabinets/[id]/layout.js` (после цикла `for (const s of brokenShops)`), `scripts/notify-broken-keys.mjs`, `app/api/health/route.js`, `app/health/HealthPage.jsx`

**Interfaces:**
- Consumes: `auth.shops.cabinet_state/cabinet_failed_at/cabinet_last_error/cabinet_notified_at`.

- [ ] **Step 1: Баннер в шапке кабинета**

В `layout.js` рядом с запросом `brokenShops` добавить:
```js
  // Сессия кабинета продавца Ozon истекла (worker/cabinet_state.py): позиции по
  // запросам и трафик из кабинета не обновляются, пока владелец не войдёт заново.
  const expiredCabinets = await query(
    `SELECT shop_name, cabinet_failed_at FROM auth.shops
      WHERE cabinet_id = $1 AND is_active = true AND cabinet_state = 'expired'`,
    [cabinetId]
  );
```
и после цикла `brokenShops`:
```js
  for (const s of expiredCabinets) {
    const since = s.cabinet_failed_at ? ` с ${new Date(s.cabinet_failed_at).toLocaleDateString("ru-RU")}` : "";
    banners.push({
      tone: "warn",
      text: `Ozon: сессия кабинета продавца истекла${since} — позиции по запросам и трафик не обновляются. Войдите в кабинет заново на вкладке «Сервер» панели panel.sysell.ru.`,
      link: { href: "https://panel.sysell.ru", label: "Открыть панель" },
    });
  }
```

- [ ] **Step 2: Письмо (одно на эпизод) в `scripts/notify-broken-keys.mjs`**

Перед финальным выводом счётчиков добавить второй проход:
```js
// Кабинет продавца Ozon: сессия истекла (auth.shops.cabinet_state, worker/cabinet_state.py).
// Одно письмо на эпизод: бронь через cabinet_notified_at, как выше.
let cabRows = [];
try {
  cabRows = await query(
    `SELECT s.shop_id, s.shop_name, s.cabinet_failed_at, s.cabinet_last_error, c.cabinet_id, c.display_name, u.email
       FROM auth.shops s JOIN auth.cabinets c ON c.cabinet_id = s.cabinet_id
       JOIN auth.users u ON u.user_id = c.owner_user_id
      WHERE s.is_active = true AND s.cabinet_state = 'expired' AND s.cabinet_notified_at IS NULL`);
} catch (e) { console.error(`[notify-keys] кабинет Ozon: не удалось получить список: ${e.message}`); }
for (const r of cabRows) {
  try {
    const claimed = await query(`UPDATE auth.shops SET cabinet_notified_at = now() WHERE shop_id = $1 AND cabinet_notified_at IS NULL RETURNING shop_id`, [r.shop_id]);
    if (!claimed.length) continue;
    const since = r.cabinet_failed_at ? new Date(r.cabinet_failed_at).toLocaleDateString('ru-RU') : '';
    const res = await sendMail({
      to: r.email,
      subject: `SySell: Ozon — сессия кабинета продавца истекла`,
      text: `Здравствуйте!\n\nПанель больше не может читать кабинет продавца Ozon по проекту «${r.display_name}»`
        + `${r.shop_name ? ` (магазин «${r.shop_name}»)` : ''}${since ? ` с ${since}` : ''}: сессия браузера истекла.`
        + ` Позиции по запросам и трафик по товарам не обновляются.\n\n`
        + `Что сделать: открыть панель ${'https://panel.sysell.ru'}, вкладка «Сервер», кнопка «Открыть вход в кабинет Ozon», подтвердить код из СМС.`
        + ` После входа сбор возобновится сам на ближайшем тике (06:00 / 20:00).\n\nПоследняя ошибка: ${String(r.cabinet_last_error || '—').slice(0, 300)}`,
    });
    if (res.ok) { sent++; console.log(`[notify-keys] кабинет Ozon: письмо отправлено, магазин ${r.shop_id}`); }
    else {
      try { await query(`UPDATE auth.shops SET cabinet_notified_at = NULL WHERE shop_id = $1`, [r.shop_id]); }
      catch (e) { console.error(`[notify-keys] кабинет Ozon: БРОНЬ НЕ СНЯТА (магазин ${r.shop_id}): ${e.message}`); }
      failed++; console.error(`[notify-keys] кабинет Ozon: не отправлено (магазин ${r.shop_id}): ${res.error}`);
    }
  } catch (e) { failed++; console.error(`[notify-keys] кабинет Ozon: ошибка (магазин ${r.shop_id}): ${e.message}`); }
}
```
(Переменные `sent`/`failed` уже объявлены выше в файле; вставлять после первого цикла, до итогового `console.log`/`process.exit`.)

- [ ] **Step 3: /health**

В `app/api/health/route.js` рядом с `shopsAuth`:
```js
  const cabinetsExpired = await query(
    `SELECT s.shop_id, s.cabinet_id, c.display_name, s.shop_name, s.cabinet_failed_at, s.cabinet_last_error
       FROM auth.shops s JOIN auth.cabinets c ON c.cabinet_id = s.cabinet_id
      WHERE s.is_active = true AND s.cabinet_state = 'expired'`
  );
```
и в JSON: `cabinets_expired: cabinetsExpired`. В `HealthPage.jsx` после блока `shops_auth` — аналогичный блок с заголовком «Кабинет Ozon: сессия истекла (N)» и строками `display_name · shop_name · с <дата> · ошибка`.

- [ ] **Step 4: Проверить руками (кабинет #1)**

```bash
PGPASSFILE=/root/.pgpass-admin psql -U postgres -h localhost -d saas -c "UPDATE auth.shops SET cabinet_state='expired', cabinet_failed_at=now(), cabinet_last_error='тест баннера' WHERE shop_id=2"
# открыть https://sysell.ru/cabinets/1 — жёлтый баннер про сессию; /health — блок «Кабинет Ozon»
node scripts/notify-broken-keys.mjs   # письмо владельцу #1 (одно); повторный запуск — 0 писем
PGPASSFILE=/root/.pgpass-admin psql -U postgres -h localhost -d saas -c "UPDATE auth.shops SET cabinet_state='ok', cabinet_failed_at=NULL, cabinet_last_error=NULL, cabinet_notified_at=NULL WHERE shop_id=2"
```
Expected: баннер и блок видны, письмо ушло один раз; после сброса баннер исчез. Деплой панели — как в протоколе проверки (`npm run build`, `systemctl restart saas-web`), без `next dev` в каталоге прода.

- [ ] **Step 5: Commit**

```bash
git add "app/cabinets/[id]/layout.js" scripts/notify-broken-keys.mjs app/api/health/route.js app/health/HealthPage.jsx
git commit -m "feat(panel): истёкшая сессия кабинета Ozon — баннер, письмо владельцу, блок на /health"
```

---

### Task 7: Бэкфилл, сторож данных, сверка ДРР

**Files:**
- Create: `scripts/check-ozon-cabinet.sql`, `scripts/check-ozon-cabinet-drr.sql`

- [ ] **Step 1: Сторож**

`scripts/check-ozon-cabinet.sql` (запуск: `psql -U saas_ro -h localhost -d saas -v cab=1 -f scripts/check-ozon-cabinet.sql`):
```sql
-- Сторож данных кабинета Ozon (спека §7). Все строки должны быть ok = t.
\set ON_ERROR_STOP on
WITH d AS (SELECT DISTINCT date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab)
-- 1. SKU сводки ⊆ SKU запросов и наоборот (по дням)
SELECT '1 sku сводки = sku запросов' AS chk,
       (SELECT count(*) FROM (
          SELECT sku, date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab
          EXCEPT SELECT DISTINCT sku, date FROM tenant.ozon_search_queries_daily WHERE cabinet_id = :cab) x) AS only_summary,
       (SELECT count(*) FROM (
          SELECT DISTINCT sku, date FROM tenant.ozon_search_queries_daily WHERE cabinet_id = :cab
          EXCEPT SELECT sku, date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab) x) AS only_queries,
       ((SELECT count(*) FROM (SELECT DISTINCT sku, date FROM tenant.ozon_search_queries_daily WHERE cabinet_id = :cab
          EXCEPT SELECT sku, date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab) x) = 0) AS ok;
-- 2. Позиция сводки ≈ позиция charts/v3 (|Δ| ≤ 5 у ≥ 90 % SKU дня)
SELECT '2 позиция: сводка vs charts' AS chk, s.date,
       round(100.0 * count(*) FILTER (WHERE abs(s.position - t.search_position) <= 5) / count(*), 1) AS pct_close,
       (100.0 * count(*) FILTER (WHERE abs(s.position - t.search_position) <= 5) / count(*)) >= 90 AS ok
  FROM tenant.ozon_sku_search_daily s
  JOIN tenant.ozon_sku_traffic_daily t ON t.cabinet_id = s.cabinet_id AND t.sku = s.sku AND t.date = s.date
 WHERE s.cabinet_id = :cab AND s.position IS NOT NULL AND t.search_position IS NOT NULL
 GROUP BY s.date ORDER BY s.date;
-- 3. Σ спроса по запросам SKU ≥ 0.8 × спрос сводки
SELECT '3 запросы покрывают спрос сводки' AS chk, s.date,
       count(*) FILTER (WHERE q.su < 0.8 * s.search_users) AS undercovered, count(*) AS total,
       (count(*) FILTER (WHERE q.su < 0.8 * s.search_users)) <= 0.1 * count(*) AS ok
  FROM tenant.ozon_sku_search_daily s
  JOIN (SELECT sku, date, sum(search_users) su FROM tenant.ozon_search_queries_daily WHERE cabinet_id = :cab GROUP BY 1, 2) q
    ON q.sku = s.sku AND q.date = s.date
 WHERE s.cabinet_id = :cab AND s.search_users > 0
 GROUP BY s.date ORDER BY s.date;
-- 4. Нет дыр внутри собранного диапазона
SELECT '4 нет дыр в днях' AS chk, min(date) AS d0, max(date) AS d1, count(*) AS days,
       (max(date) - min(date) + 1) = count(*) AS ok
  FROM (SELECT DISTINCT date FROM tenant.ozon_sku_search_daily WHERE cabinet_id = :cab) x;
```

`scripts/check-ozon-cabinet-drr.sql`:
```sql
-- Сверка ДРР кабинета (charts/v3 drr, % за день по SKU) с ДРР панели по SKU
-- (реклама ozon_daily_sku_ad.spend ÷ сумма заказов, решение владельца 08.09).
-- Справочно: до решения владельца канон панели не меняется. Колонки таблицы
-- ozon_daily_sku_ad — проверить в миграции 043 и подставить (spend/ad_spend, orders_sum).
SELECT t.date, t.sku, t.product_id, t.drr AS drr_cabinet,
       round((a.spend / NULLIF(o.orders_sum, 0) * 100)::numeric, 1) AS drr_panel,
       round((t.drr - a.spend / NULLIF(o.orders_sum, 0) * 100)::numeric, 1) AS delta
  FROM tenant.ozon_sku_traffic_daily t
  LEFT JOIN tenant.ozon_daily_sku_ad a ON a.cabinet_id = t.cabinet_id AND a.product_id = t.product_id AND a.date = t.date
  LEFT JOIN (SELECT cabinet_id, product_id, substr(order_dt, 1, 10)::date AS d, sum(total) AS orders_sum
               FROM tenant.ozon_orders GROUP BY 1, 2, 3) o
    ON o.cabinet_id = t.cabinet_id AND o.product_id = t.product_id AND o.d = t.date
 WHERE t.cabinet_id = :cab AND t.drr IS NOT NULL AND t.drr > 0
 ORDER BY abs(t.drr - a.spend / NULLIF(o.orders_sum, 0) * 100) DESC NULLS LAST
 LIMIT 40;
```
Перед запуском: `psql -U saas_ro -h localhost -d saas -Atc "\d tenant.ozon_daily_sku_ad"` и поправить имена колонок в скрипте под реальные.

- [ ] **Step 2: Бэкфилл истории (кабинет #1, руками, вне 07:00; ≈35 дней × ~350 вызовов ≈ 1–1,5 ч)**

```bash
cd /opt/agents/saas && DAYS_FROM=$(( ($(date +%s) - $(date -d 2026-08-04 +%s)) / 86400 )) && \
  DAYS_FROM=$DAYS_FROM worker/run_saas_collect.sh cabinet; echo EXIT=$?
psql -U saas_ro -h localhost -d saas -v cab=1 -f scripts/check-ozon-cabinet.sql
```
Expected: `EXIT=0`, сторож — все `ok = t` (проверка 4: дни с 04.08 по позавчера без дыр; если кабинет отдал `NO_DATA` для отдельных старых дней — зафиксировать список в отчёте владельцу, это ограничение источника).

- [ ] **Step 3: Первая сверка ДРР (справочно, в отчёт)**

```bash
psql -U saas_ro -h localhost -d saas -v cab=1 -f scripts/check-ozon-cabinet-drr.sql
```
Записать в отчёт: медиану |delta| и 3 самых расходящихся SKU. Решение о канонизации — владельца, после недели наблюдений.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-ozon-cabinet.sql scripts/check-ozon-cabinet-drr.sql
git commit -m "chore(scripts): сторож данных кабинета Ozon и сверка ДРР кабинет/панель"
```

---

### Task 8: `lib/ozonSearch.js` — расчёты страницы «Поиск и запросы»

**Files:**
- Create: `lib/ozonSearch.js`, `scripts/check-ozon-search-selftest.mjs`

**Interfaces:**
- Produces (все чистые):
  - `aggregateSkus(rows, prevRows) -> { items: [...], kpi }` — `rows`: строки `ozon_sku_search_daily` периода `{sku, product_id, name, article, date, position, search_users, view_users, ctr, gmv}`; `prevRows` — то же за прошлое окно. `items[]`: `{sku, product_id, name, article, position (взвешенное спросом среднее, 1 знак), positionPrev, positionDelta (prev − cur: положительная = стало лучше), search_users (Σ), view_users (Σ), ctr (Σview/Σsearch·100, 2 знака), gmv (Σ), spark: [{date, position}] по датам периода}`; сортировка по `search_users` desc. `kpi`: `{position, positionPrev, queriesTop10, queriesTop50, search_users, orders}` — `queriesTop10/50` и `orders` считаются в `buildQueryMatrix`, здесь `null` (заполняет роут из `kpiFromQueries`).
  - `buildQueryMatrix(qrows, dates, {minDemand=0, onlyOrders=false}) -> { dates, rows: [{query, search_users, view_users, ctr, click_users, orders, gmv, byDay: {date: position|null}, best, last}] }` — `qrows`: строки `ozon_search_queries_daily` одного SKU за период; сортировка по `search_users` desc.
  - `kpiFromQueries(qrows) -> {queriesTop10, queriesTop50, orders}` — по последней дате в `qrows`: число запросов с `position ≤ 10` / `≤ 50`; `orders` = Σ `orders` за период.
  - `positionTone(pos) -> 'top'|'good'|'mid'|'low'|'none'` — ≤10 / ≤30 / ≤100 / >100 / null.
  - `weightedPosition(rows) -> number|null` — Σ(position·search_users)/Σsearch_users, при нулевом спросе — простое среднее.

- [ ] **Step 1: Падающий селф-тест**

`scripts/check-ozon-search-selftest.mjs`:
```js
#!/usr/bin/env node
// scripts/check-ozon-search-selftest.mjs — чистые расчёты страницы «Поиск и запросы» (lib/ozonSearch.js), без БД.
import { aggregateSkus, buildQueryMatrix, kpiFromQueries, positionTone, weightedPosition } from '../lib/ozonSearch.js';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`); if (!cond) failed++; };

// weightedPosition: (10·100 + 30·300)/400 = 25; без спроса — среднее.
check('взвешенная позиция', weightedPosition([{ position: 10, search_users: 100 }, { position: 30, search_users: 300 }]) === 25);
check('взвешенная: нулевой спрос → среднее', weightedPosition([{ position: 10, search_users: 0 }, { position: 20, search_users: 0 }]) === 15);
check('взвешенная: пусто → null', weightedPosition([]) === null);
check('взвешенная: null позиции пропускаются', weightedPosition([{ position: null, search_users: 5 }, { position: 8, search_users: 5 }]) === 8);

// aggregateSkus
const rows = [
  { sku: 1, product_id: 11, name: 'A', article: 'a', date: '2026-09-09', position: 20, search_users: 100, view_users: 10, ctr: 1, gmv: 0 },
  { sku: 1, product_id: 11, name: 'A', article: 'a', date: '2026-09-10', position: 10, search_users: 300, view_users: 30, ctr: 1, gmv: 500 },
  { sku: 2, product_id: null, name: 'B', article: 'b', date: '2026-09-10', position: 150, search_users: 50, view_users: 1, ctr: 2, gmv: 0 },
];
const prev = [{ sku: 1, product_id: 11, date: '2026-09-02', position: 30, search_users: 100, view_users: 5, ctr: 5, gmv: 0 }];
const agg = aggregateSkus(rows, prev);
check('items: сортировка по спросу', agg.items.map((i) => i.sku).join() === '1,2', agg.items.map((i) => i.sku));
const a = agg.items[0];
check('item: позиция взвешенная 12.5', a.position === 12.5, a);
check('item: prev 30, delta +17.5 (лучше)', a.positionPrev === 30 && a.positionDelta === 17.5, a);
check('item: суммы', a.search_users === 400 && a.view_users === 40 && a.gmv === 500, a);
check('item: ctr = 40/400·100 = 10', a.ctr === 10, a);
check('item: spark по датам', JSON.stringify(a.spark) === JSON.stringify([{ date: '2026-09-09', position: 20 }, { date: '2026-09-10', position: 10 }]), a.spark);
check('item без каталога: product_id null, имя кабинета', agg.items[1].product_id === null && agg.items[1].name === 'B', agg.items[1]);
check('kpi: позиция по кабинету взвешена (12.5·400+150·50)/450', Math.abs(agg.kpi.position - 27.78) < 0.01, agg.kpi);
check('kpi: prev', agg.kpi.positionPrev === 30, agg.kpi);
check('пусто → items [] и kpi null', aggregateSkus([], []).items.length === 0 && aggregateSkus([], []).kpi.position === null);

// buildQueryMatrix
const q = [
  { query: 'карта памяти', date: '2026-09-09', position: 85, search_users: 1159, view_users: 20, ctr: 2, click_users: 2, orders: 0, gmv: 0 },
  { query: 'карта памяти', date: '2026-09-10', position: 72, search_users: 1191, view_users: 25, ctr: 2, click_users: 3, orders: 1, gmv: 900 },
  { query: 'micro sd', date: '2026-09-10', position: 95, search_users: 724, view_users: 5, ctr: 1, click_users: 0, orders: 0, gmv: 0 },
  { query: 'редкий', date: '2026-09-10', position: 3, search_users: 4, view_users: 1, ctr: 1, click_users: 0, orders: 0, gmv: 0 },
];
const dates = ['2026-09-09', '2026-09-10'];
const m = buildQueryMatrix(q, dates, {});
check('матрица: сортировка по спросу', m.rows.map((r) => r.query).join('|') === 'карта памяти|micro sd|редкий', m.rows.map((r) => r.query));
check('матрица: byDay и пропуск = null', m.rows[1].byDay['2026-09-09'] === null && m.rows[1].byDay['2026-09-10'] === 95, m.rows[1].byDay);
check('матрица: суммы и best/last', m.rows[0].search_users === 2350 && m.rows[0].orders === 1 && m.rows[0].best === 72 && m.rows[0].last === 72, m.rows[0]);
check('матрица: ctr = Σview/Σsearch·100 (2 знака)', m.rows[0].ctr === 1.91, m.rows[0]);
check('фильтр minDemand', buildQueryMatrix(q, dates, { minDemand: 100 }).rows.length === 2);
check('фильтр onlyOrders', buildQueryMatrix(q, dates, { onlyOrders: true }).rows.length === 1);

// kpiFromQueries — по последней дате
const k = kpiFromQueries(q);
check('kpi: top10 = 1 (редкий), top50 = 1', k.queriesTop10 === 1 && k.queriesTop50 === 1, k);
check('kpi: orders за период = 1', k.orders === 1, k);

// positionTone
check('tone', [positionTone(5), positionTone(25), positionTone(80), positionTone(300), positionTone(null)].join() === 'top,good,mid,low,none');

console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Запустить — падает (модуля нет)**

Run: `node scripts/check-ozon-search-selftest.mjs`
Expected: `Cannot find module '../lib/ozonSearch.js'`

- [ ] **Step 3: Реализация**

`lib/ozonSearch.js`:
```js
// =====================================================================
//  lib/ozonSearch.js — чистые расчёты страницы «Поиск и запросы» (Ozon):
//  агрегаты по SKU за период, матрица запрос × день, KPI. Без БД.
//  Источник: tenant.ozon_sku_search_daily / tenant.ozon_search_queries_daily
//  (кабинет продавца, сборщик ozon_cabinet_search). Заказы/GMV здесь — «по
//  запросу» (статистика поиска кабинета), они НЕ равны заказам панели и так и
//  подписываются. Селф-тест: scripts/check-ozon-search-selftest.mjs.
// =====================================================================
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const n = (v) => (v == null ? 0 : Number(v) || 0);

export function weightedPosition(rows) {
  let wsum = 0, w = 0, plain = 0, cnt = 0;
  for (const r of rows) {
    if (r.position == null) continue;
    const su = n(r.search_users);
    wsum += r.position * su; w += su; plain += r.position; cnt += 1;
  }
  if (!cnt) return null;
  return w > 0 ? wsum / w : plain / cnt;
}

export function positionTone(pos) {
  if (pos == null) return "none";
  if (pos <= 10) return "top";
  if (pos <= 30) return "good";
  if (pos <= 100) return "mid";
  return "low";
}

function groupBySku(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.sku)) m.set(r.sku, []);
    m.get(r.sku).push(r);
  }
  return m;
}

export function aggregateSkus(rows, prevRows = []) {
  const cur = groupBySku(rows), prev = groupBySku(prevRows);
  const items = [];
  for (const [sku, rs] of cur) {
    const su = rs.reduce((s, r) => s + n(r.search_users), 0);
    const vu = rs.reduce((s, r) => s + n(r.view_users), 0);
    const position = r1(weightedPosition(rs));
    const positionPrev = prev.has(sku) ? r1(weightedPosition(prev.get(sku))) : null;
    const last = rs[rs.length - 1];
    items.push({
      sku, product_id: last.product_id ?? null, name: last.name || String(sku), article: last.article || null,
      position, positionPrev,
      positionDelta: position != null && positionPrev != null ? r1(positionPrev - position) : null,
      search_users: su, view_users: vu, ctr: su > 0 ? r2((vu / su) * 100) : null,
      gmv: rs.reduce((s, r) => s + n(r.gmv), 0),
      spark: [...rs].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, position: r.position ?? null })),
    });
  }
  items.sort((a, b) => b.search_users - a.search_users || a.sku - b.sku);
  const kpi = {
    position: r2(weightedPosition(rows)), positionPrev: r2(weightedPosition(prevRows)),
    queriesTop10: null, queriesTop50: null, orders: null,
    search_users: rows.reduce((s, r) => s + n(r.search_users), 0),
  };
  return { items, kpi };
}

export function buildQueryMatrix(qrows, dates, { minDemand = 0, onlyOrders = false } = {}) {
  const byQ = new Map();
  for (const r of qrows) {
    if (!byQ.has(r.query)) byQ.set(r.query, []);
    byQ.get(r.query).push(r);
  }
  const rows = [];
  for (const [query, rs] of byQ) {
    const su = rs.reduce((s, r) => s + n(r.search_users), 0);
    const vu = rs.reduce((s, r) => s + n(r.view_users), 0);
    const orders = rs.reduce((s, r) => s + n(r.orders), 0);
    if (su < minDemand || (onlyOrders && orders <= 0)) continue;
    const byDay = Object.fromEntries(dates.map((d) => [d, null]));
    for (const r of rs) if (r.date in byDay) byDay[r.date] = r.position ?? null;
    const known = rs.filter((r) => r.position != null).sort((a, b) => a.date.localeCompare(b.date));
    rows.push({
      query, search_users: su, view_users: vu, ctr: su > 0 ? r2((vu / su) * 100) : null,
      click_users: rs.reduce((s, r) => s + n(r.click_users), 0), orders,
      gmv: rs.reduce((s, r) => s + n(r.gmv), 0), byDay,
      best: known.length ? Math.min(...known.map((r) => r.position)) : null,
      last: known.length ? known[known.length - 1].position : null,
    });
  }
  rows.sort((a, b) => b.search_users - a.search_users || a.query.localeCompare(b.query));
  return { dates, rows };
}

export function kpiFromQueries(qrows) {
  const lastDate = qrows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const lastRows = qrows.filter((r) => r.date === lastDate && r.position != null);
  return {
    queriesTop10: lastRows.filter((r) => r.position <= 10).length,
    queriesTop50: lastRows.filter((r) => r.position <= 50).length,
    orders: qrows.reduce((s, r) => s + n(r.orders), 0),
  };
}
```

- [ ] **Step 4: Селф-тест зелёный**

Run: `node scripts/check-ozon-search-selftest.mjs`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add lib/ozonSearch.js scripts/check-ozon-search-selftest.mjs
git commit -m "feat(lib): ozonSearch — агрегаты по SKU, матрица запрос×день, KPI (чистые функции + селф-тест)"
```

---

### Task 9: API и страница «Поиск и запросы»

**Files:**
- Create: `app/api/cabinets/[id]/search/route.js`, `app/cabinets/[id]/search/page.js`, `app/cabinets/[id]/search/SearchPage.jsx`
- Modify: `app/cabinets/[id]/layout.js` (пункт меню)

**Interfaces:**
- Consumes: `lib/ozonSearch.js` (задача 8), `withCabinet`, `DatabaseSync("ozon", {readOnly:true})`, `defaultPeriod` из `lib/period.js`, `PeriodPicker`.
- Produces: `GET /api/cabinets/[id]/search?from&to[&sku&minDemand&onlyOrders]` →
  без `sku`: `{ period:{from,to,prev:{from,to}}, cabinet:{state, hasProfile}, kpi, items }`;
  с `sku`: `{ period, sku, product:{name, article, im_url}, matrix:{dates, rows}, kpi }`.

- [ ] **Step 1: Роут**

`app/api/cabinets/[id]/search/route.js`:
```js
import { NextResponse } from "next/server";
import { DatabaseSync, query } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { defaultPeriod } from "@/lib/period.js";
import { aggregateSkus, buildQueryMatrix, kpiFromQueries } from "@/lib/ozonSearch.js";
// =====================================================================
//  «Поиск и запросы» (Ozon) — позиции по поисковым запросам из кабинета продавца.
//  Источники: tenant.ozon_sku_search_daily (сводка SKU × день, канон позиции) и
//  tenant.ozon_search_queries_daily (SKU × день × запрос). Все расчёты —
//  lib/ozonSearch.js, здесь только чтение БД. Заказы/GMV — «по запросу».
// =====================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function prevWindow(from, to) {
  const f = new Date(from + "T00:00:00Z"), t = new Date(to + "T00:00:00Z");
  const days = Math.round((t - f) / 86400000) + 1;
  const pt = new Date(f.getTime() - 86400000), pf = new Date(pt.getTime() - (days - 1) * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  return { from: ymd(pf), to: ymd(pt) };
}
function dateList(from, to) {
  const out = []; const d = new Date(from + "T00:00:00Z"); const t = new Date(to + "T00:00:00Z");
  for (; d <= t; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const dflt = defaultPeriod(14);
    const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from") : dflt.from;
    const to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to") : dflt.to;
    const sku = url.searchParams.get("sku") || "";
    const prev = prevWindow(from, to);
    const db = new DatabaseSync("ozon", { readOnly: true });

    const shop = (await query(
      `SELECT cabinet_state, cabinet_profile_dir FROM auth.shops WHERE cabinet_id = $1 AND mp_code = 'ozon' AND is_active = true LIMIT 1`,
      [cabinet.cabinet_id])).at(0) || {};
    const cab = { state: shop.cabinet_state || "none", hasProfile: !!shop.cabinet_profile_dir };

    if (!sku) {
      const rows = await db.prepare(
        `SELECT s.sku, s.product_id, COALESCE(p.name, s.name) AS name, COALESCE(p.offer_id, s.article) AS article, p.im_url,
                s.date::text AS date, s.position, s.search_users, s.view_users, s.ctr, s.gmv
           FROM ozon_sku_search_daily s LEFT JOIN products p ON p.product_id = s.product_id
          WHERE s.date >= ? AND s.date <= ? ORDER BY s.sku, s.date`).all(from, to);
      const prevRows = await db.prepare(
        `SELECT sku, product_id, date::text AS date, position, search_users, view_users, ctr, gmv
           FROM ozon_sku_search_daily WHERE date >= ? AND date <= ? ORDER BY sku, date`).all(prev.from, prev.to);
      const { items, kpi } = aggregateSkus(rows, prevRows);
      const qrows = await db.prepare(
        `SELECT query, date::text AS date, position, search_users, orders FROM ozon_search_queries_daily WHERE date >= ? AND date <= ?`).all(from, to);
      Object.assign(kpi, kpiFromQueries(qrows));
      const imByPid = Object.fromEntries(rows.filter((r) => r.im_url).map((r) => [r.product_id, r.im_url]));
      for (const it of items) it.im_url = imByPid[it.product_id] || null;
      return NextResponse.json({ period: { from, to, prev }, cabinet: cab, kpi, items });
    }

    const minDemand = Number(url.searchParams.get("minDemand") || 0) || 0;
    const onlyOrders = url.searchParams.get("onlyOrders") === "1";
    const qrows = await db.prepare(
      `SELECT query, date::text AS date, position, search_users, view_users, ctr, click_users, orders, gmv
         FROM ozon_search_queries_daily WHERE sku = ? AND date >= ? AND date <= ? ORDER BY date`).all(sku, from, to);
    const prod = await db.prepare(
      `SELECT COALESCE(p.name, s.name) AS name, COALESCE(p.offer_id, s.article) AS article, p.im_url
         FROM ozon_sku_search_daily s LEFT JOIN products p ON p.product_id = s.product_id
        WHERE s.sku = ? ORDER BY s.date DESC LIMIT 1`).get(sku) || {};
    const matrix = buildQueryMatrix(qrows, dateList(from, to), { minDemand, onlyOrders });
    return NextResponse.json({ period: { from, to, prev }, sku, product: prod, matrix, kpi: kpiFromQueries(qrows) });
  } catch (e) {
    console.error("[search] ошибка:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
});
```
Проверить, что `convertSql` в `lib/db.js` маппит `ozon_sku_search_daily`/`ozon_search_queries_daily` в `tenant.*` для флага `'ozon'` (как `products` → `tenant.ozon_products`); если маппинг по префиксу `ozon_` автоматический — ничего не делать, иначе добавить две записи в таблицу имён.

- [ ] **Step 2: Страница**

`app/cabinets/[id]/search/page.js`:
```js
import SearchPage from "./SearchPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <SearchPage cabinetId={Number(params.id)} />;
}
```
`app/cabinets/[id]/search/SearchPage.jsx` — клиентский компонент по образцу `TimingPage.jsx` (палитра `C` из `@/lib/palette.js`, `PeriodPicker` из `../PeriodPicker.jsx`):
- состояние: `from/to` (сидируются `defaultPeriod(14)` — импортировать из `@/lib/period.js`), `openSku`, `minDemand`, `onlyOrders`, `q` (поиск по имени/артикулу, фильтр на клиенте);
- загрузка `/api/cabinets/${cabinetId}/search?from&to`; при `openSku` — второй запрос с `sku`;
- шапка: заголовок «Поиск и запросы · Ozon», подпись «позиции по данным кабинета продавца, лаг до суток», `PeriodPicker`;
- если `cabinet.hasProfile === false` → пустое состояние «Кабинет продавца Ozon не подключён к панели: позиции по запросам доступны после подключения профиля кабинета (владелец сервиса)»; если `cabinet.state === 'expired'` → «Сессия кабинета продавца истекла — войдите заново на вкладке «Сервер» panel.sysell.ru»;
- KPI-ряд: «Средняя позиция» (`kpi.position`, дельта к `positionPrev`: положительная = лучше, зелёная), «Запросов в топ-10 / топ-50» (на последний день), «Спрос за период» (`kpi.search_users`), «Заказов по запросам» (`kpi.orders`, подпись «по статистике поиска, не заказы панели»);
- таблица SKU: фото (`Thumb` как в DetailPage — миниатюра 36px), имя + артикул, позиция (цвет по `positionTone`), дельта, спрос, просмотры, CTR, GMV по запросу, спарклайн позиции (SVG-полилиния 80×24, ось Y инвертирована: меньше = выше); клик по строке → раскрытие;
- раскрытие: фильтры «мин. спрос» (число) и «только с заказами» (чекбокс), таблица запрос × дни: слева запрос, спрос, CTR, клики, заказы; далее по одному столбцу на дату с позицией и фоном по `positionTone` (`top` — `C.pos` 25 %, `good` — `C.accent` 18 %, `mid` — `C.surfaceAlt`, `low` — прозрачный серый текст, `none` — пусто); столбцы дат прокручиваются в `overflow-x:auto`;
- подвал: «Источник — «Запросы моих товаров» кабинета Ozon: спрос = уникальные покупатели, искавшие запрос и видевшие товар; позиция — средняя за день».

- [ ] **Step 3: Пункт меню**

В `MENU` `layout.js` в группу «Сводка по товарам» после «Заказы по времени»: `{ href: "/search", label: "Поиск и запросы" }`.

- [ ] **Step 4: Смоук**

```bash
npm run build 2>&1 | tail -5 && systemctl restart saas-web
# под сессией владельца (cookie из браузера) или через смоук-скрипт панели:
curl -s -b "$COOKIE" "https://sysell.ru/api/cabinets/1/search?from=$(date -d '-8 days' +%F)&to=$(date -d '-2 days' +%F)" | head -c 600; echo
curl -s -b "$COOKIE" "https://sysell.ru/api/cabinets/1/search?from=$(date -d '-8 days' +%F)&to=$(date -d '-2 days' +%F)&sku=4988596186" | head -c 600
```
Expected: JSON с `items` (≈60) и KPI; с `sku` — `matrix.rows` (десятки запросов) с `byDay` по 7 датам. В браузере: страница открывается, раскрытие SKU показывает матрицу, у кабинета #1008 — пустое состояние «не подключён».

- [ ] **Step 5: Commit**

```bash
git add "app/api/cabinets/[id]/search/route.js" "app/cabinets/[id]/search/page.js" "app/cabinets/[id]/search/SearchPage.jsx" "app/cabinets/[id]/layout.js"
git commit -m "feat(panel): страница «Поиск и запросы» — позиции Ozon по запросам, матрица запрос×день, KPI"
```

---

### Task 10: Блок «Трафик по дням» на «Детальной сводке» Ozon

**Files:**
- Modify: `app/api/cabinets/[id]/detail/route.js` (функция `collectOzon`, перед `return {`), `app/cabinets/[id]/detail/DetailPage.jsx` (`DetailInner`, после `<Detail …/>`)

**Interfaces:**
- Produces: в ответе Ozon-ветки `/detail` ключ `traffic: { days: [{date, total_views, search_views, pdp_views, hits_search_to_cart, hits_pdp_to_cart, total_hits_to_cart, conv_search_to_pdp, conv_pdp_to_cart, conv_cart_to_order, drr, days_in_trafarets, search_position, position}], totals: {total_views, search_views, pdp_views, hits_search_to_cart, hits_pdp_to_cart, total_hits_to_cart, drr_avg, position_avg} }`. Существующие ключи не меняются.

- [ ] **Step 1: Роут**

В `collectOzon` перед `return {`:
```js
  // Трафик по дням из кабинета продавца (tenant.ozon_sku_traffic_daily, сборщик
  // ozon_cabinet_traffic) + канон позиции из ozon_sku_search_daily. Пусто —
  // если у магазина нет профиля кабинета: блок на странице покажет подсказку.
  let traffic = { days: [], totals: null };
  try {
    const tRows = await db.prepare(
      `SELECT t.date::text AS date, t.total_views, t.search_views, t.pdp_views, t.hits_search_to_cart, t.hits_pdp_to_cart,
              t.total_hits_to_cart, t.conv_search_to_pdp, t.conv_pdp_to_cart, t.conv_cart_to_order, t.drr,
              t.days_in_trafarets, t.search_position, s.position
         FROM ozon_sku_traffic_daily t
         LEFT JOIN ozon_sku_search_daily s ON s.sku = t.sku AND s.date = t.date
        WHERE t.product_id = ? AND t.date >= ? AND t.date <= ? ORDER BY t.date`).all(nm, from, to);
    const sum = (k) => tRows.reduce((a, r) => a + (r[k] ?? 0), 0);
    const avg = (k) => { const v = tRows.filter((r) => r[k] != null); return v.length ? Math.round(v.reduce((a, r) => a + r[k], 0) / v.length * 10) / 10 : null; };
    traffic = { days: tRows, totals: tRows.length ? {
      total_views: sum("total_views"), search_views: sum("search_views"), pdp_views: sum("pdp_views"),
      hits_search_to_cart: sum("hits_search_to_cart"), hits_pdp_to_cart: sum("hits_pdp_to_cart"), total_hits_to_cart: sum("total_hits_to_cart"),
      drr_avg: avg("drr"), position_avg: avg("position") } : null };
  } catch (e) { console.error("[detail] трафик кабинета Ozon:", e); }
```
и в объект ответа добавить `traffic,`.

- [ ] **Step 2: Компонент**

В `DetailPage.jsx` после `<Detail data={data} platform={platform} />`: `{platform === "ozon" && <TrafficBlock traffic={data.traffic} />}`. Компонент в конце файла:
```jsx
// Трафик по дням из кабинета продавца Ozon (ozon_sku_traffic_daily): показы всего /
// в поиске и каталоге / карточка, корзина из поиска и из карточки, конверсии, ДРР
// кабинета (справочно, канон панели не подменяет), позиция (канон — статистика поиска).
function TrafficBlock({ traffic }) {
  const days = traffic?.days || [];
  const t = traffic?.totals;
  if (!days.length) {
    return <LocCard title="Трафик по дням (кабинет Ozon)" hint="нет данных" accent={C.accent}>
      <EmptyHint text="Нет данных кабинета за период: у магазина не подключён профиль кабинета Ozon, либо дни ещё не собраны (лаг до суток)." />
    </LocCard>;
  }
  const cols = [
    ["total_views", "Показы всего"], ["search_views", "В поиске и каталоге"], ["pdp_views", "Просмотры карточки"],
    ["hits_search_to_cart", "В корзину из поиска"], ["hits_pdp_to_cart", "В корзину из карточки"], ["total_hits_to_cart", "В корзину всего"],
    ["conv_search_to_pdp", "Поиск→карточка, %"], ["conv_pdp_to_cart", "Карточка→корзина, %"], ["conv_cart_to_order", "Корзина→заказ, %"],
    ["drr", "ДРР (кабинет), %"], ["days_in_trafarets", "Трафареты, дн"], ["position", "Позиция в поиске"],
  ];
  const tot = { ...t, conv_search_to_pdp: null, conv_pdp_to_cart: null, conv_cart_to_order: null, drr: t?.drr_avg, days_in_trafarets: null, position: t?.position_avg };
  return (
    <LocCard title="Трафик по дням (кабинет Ozon)" hint={`${days.length} дн. · ДРР кабинета — справочно, ДРР панели см. выше`} accent={C.accent}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 900 }}>
          <thead><tr>
            <th style={{ textAlign: "left", padding: "4px 8px", color: C.muted }}>Показатель</th>
            <th style={{ padding: "4px 8px", color: C.ink }}>Итого</th>
            {days.map((d) => <th key={d.date} style={{ padding: "4px 6px", color: C.muted, fontWeight: 500 }}>{d.date.slice(8, 10)}.{d.date.slice(5, 7)}</th>)}
          </tr></thead>
          <tbody>
            {cols.map(([k, label]) => (
              <tr key={k} style={{ borderTop: `1px solid ${C.line}` }}>
                <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{label}</td>
                <td style={{ padding: "4px 8px", textAlign: "right", fontWeight: 600 }}>{tot[k] == null ? "—" : num(tot[k])}</td>
                {days.map((d) => <td key={d.date} style={{ padding: "4px 6px", textAlign: "right", color: d[k] == null ? C.faint : C.ink }}>{d[k] == null ? "—" : num(d[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </LocCard>
  );
}
```
(`LocCard`, `EmptyHint`, `num`, `C` уже есть в файле.)

- [ ] **Step 3: Смоук**

```bash
npm run build 2>&1 | tail -5 && systemctl restart saas-web
curl -s -b "$COOKIE" "https://sysell.ru/api/cabinets/1/detail?platform=ozon&nm=<product_id карты 64>&from=$(date -d '-8 days' +%F)&to=$(date -d '-2 days' +%F)" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['traffic']['days']), d['traffic']['totals'])"
```
(`product_id` карты 64: `psql -U saas_ro -h localhost -d saas -Atc "select product_id from tenant.ozon_products where cabinet_id=1 and fbo_sku=4988596186"`; параметры запроса роута — посмотреть в начале `detail/route.js`, как он читает `platform`/`nm`.)
Expected: 7 дней и итоги; на странице «Детальная сводка» товара Ozon внизу появилась карточка «Трафик по дням (кабинет Ozon)». Существующие цифры страницы не изменились (сравнить `totals` до/после по одному товару).

- [ ] **Step 4: Commit**

```bash
git add "app/api/cabinets/[id]/detail/route.js" "app/cabinets/[id]/detail/DetailPage.jsx"
git commit -m "feat(panel): блок «Трафик по дням (кабинет Ozon)» на детальной сводке товара"
```

---

### Task 11: Документация и память

**Files:**
- Modify: `AGENTS.md` (раздел «Боевое расписание» — строка таймера `saas-cabinet`; новый подраздел «🆕 Кабинет Ozon: позиции по запросам и трафик (с 2026-09-12)»), `docs/metrics-contract.md` (новый § с картой доверия трёх таблиц: канон позиции — `ozon_sku_search_daily.position`; заказы/GMV «по запросу» ≠ заказы панели; ДРР кабинета справочный до решения владельца)
- Память: `/root/.claude/projects/-opt-agents-saas/memory/ozon-cabinet-search-traffic-done.md` + строка в `MEMORY.md`

- [ ] **Step 1: AGENTS.md** — в таблицу расписания строка `| saas-cabinet | 06:00, 20:00 | кабинет Ozon: позиции по запросам + трафик по SKU (Playwright, профиль владельца, только чтение) |`; подраздел с: таблицами и сборщиками, правилами профиля (один процесс, 07:00 у ozon-panel, никогда не логиниться, `cabinet_state`), режимом `cabinet` и venv, окном дня (исключающая граница), сторожем `scripts/check-ozon-cabinet.sql`, ссылкой на спеку.
- [ ] **Step 2: metrics-contract.md** — § «Кабинет Ozon: поиск и трафик»: формулы `lib/ozonSearch.js` (взвешенная позиция, CTR = Σview/Σsearch), подписи «по запросу», статус ДРР кабинета.
- [ ] **Step 3: Память** — файл `project`-типа: что сделано, даты, где сторож, что ждёт владельца (сверка ДРР через неделю; второй кабинет — нужен вход владельца #1008), бэклог из спеки §10; ссылка `[[session-next-steps]]`.
- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/metrics-contract.md
git commit -m "docs: кабинет Ozon — позиции по запросам и трафик: расписание, карта доверия, правила профиля"
```

---

## Самопроверка плана (выполнена при написании)

- **Покрытие спеки:** §3 источники → задачи 2–4; §4.1 колонки магазина → 1, 5; §4.2 клиент/venv → 2; §4.3 замок/расписание → 5; §4.4 регистрация → 5; §4.5 окно/бюджет → 3–4; §4.6 истёкшая сессия → 5–6; §5 схема → 1; §6.1 страница → 8–9; §6.2 детальная сводка → 10; §7 тесты/сторожа → 2, 3, 4, 5, 7, 8; §8 порядок → порядок задач; §9 справочно — без задачи; §10 бэклог — без задачи.
- **Согласованность имён:** `replace_ozon_search_day(day, sku_rows, query_rows)` (задачи 3, db_pg), `replace_ozon_traffic_day(day, rows)` (4), `ozon_sku2pid()` (3–4), `CABINET_COLLECTORS` (5, гард), `cabinet_state.mark_expired/mark_ok/should_skip/load_state` (5), `aggregateSkus/buildQueryMatrix/kpiFromQueries/positionTone/weightedPosition` (8–9), ключ ответа `traffic` (10).
