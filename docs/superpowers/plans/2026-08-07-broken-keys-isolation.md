# Изоляция магазинов со сломанными ключами — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Магазин, у которого маркетплейс отказывает в доступе, встаёт на паузу и перестаёт мешать остальным; его владелец видит баннер и получает письмо; владелец сервиса перестаёт получать ежедневные ложные алерты (спека `docs/superpowers/specs/2026-08-07-broken-keys-isolation-design.md`).

**Architecture:** Состояние ключей живёт на строке магазина (`auth.shops`), меняет его только воркер — через один модуль `worker/shop_auth.py`, чтобы логика перехода не расползлась. Классификация «это отказ авторизации, а не сбой сети» вынесена в чистую функцию `worker/auth_errors.py` и потому тестируется без БД и без сети. Письмо шлёт отдельный Node-скрипт по таймеру (в панели уже есть nodemailer и «раковина»), воркер писем не отправляет — Python-части SMTP не нужен.

**Tech Stack:** Python 3 (воркер, psycopg), PostgreSQL, Next.js 14 (панель), nodemailer, systemd-таймеры.

## Global Constraints

- Прод-хост = репозиторий `/opt/agents/saas`, ветка master, remote нет.
- **ЗАПРЕЩЕНО `next dev` в каталоге прода** (затирает `.next`, роняет прод — правило AGENTS.md). Проверка панели: `npm run build && (SAAS_YOOKASSA_MOCK=1 npx next start -p 3210 &)`, после — убить процесс **только на 3210** (прод на 3200); порт проверить дважды, процесс умеет пере-форкаться.
- Деплой панели (задача 6): `npm run build && systemctl restart saas-web`.
- Воркер запускать только через окружение таймера: `set -a; . /etc/saas-worker.env; . /etc/collectors.env; set +a; export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas` и интерпретатор `/opt/agents/data-presenter-agent/.venv/bin/python`.
- Backup боевого файла перед правкой → `/opt/agentsDB/backups/<имя>.bak-2026-08-07iso`.
- Регресс панели: `scripts/smoke-auth-phase4.mjs`, `phase3`, `phase2`, `phase1`, `phase0`, `smoke-billing.mjs` (с `SAAS_YOOKASSA_MOCK=1`), `scripts/check-billing-lib.mjs`. Тестовых записей в боевой БД оставаться не должно.
- Миграции идемпотентны, нумерация с `037_`; новым колонкам — значения по умолчанию, чтобы существующие магазины не остановились.
- Отказом авторизации считаются **только** 401/403 и отсутствие сохранённых кредов. Сетевые сбои, 429, 5xx и таймауты паузу не вызывают.
- Порог паузы — **два отказа подряд**; любой успех обнуляет счётчик. Контрольная попытка — **раз в сутки**.
- Тексты для клиента — по-русски. Комментарии — по-русски.

---

### Task 1: Схема и модуль состояния ключей

**Files:**
- Create: `db/migrations/037_shop_auth_state.sql`
- Create: `worker/shop_auth.py`

**Interfaces:**
- Produces: колонки `auth.shops.auth_state` (`ok`|`failing`|`paused`), `auth_fail_count`, `auth_failed_at`, `auth_last_error`, `auth_notified_at`; функции `load_state(shop_id) -> dict|None`, `mark_failure(shop_id, error) -> str` (возвращает новое состояние), `mark_ok(shop_id) -> None`, `should_skip(state_row, now=None) -> bool`.
- Consumes: `psycopg` и параметры подключения — так же, как `worker/orchestrator.py` (`PG_SUPER`).

- [ ] **Step 1: Миграция**

`db/migrations/037_shop_auth_state.sql`:

```sql
-- 037: состояние ключей магазина. Нужно, чтобы магазин со сломанной
-- авторизацией вставал на паузу и не тратил окно прогона на бесполезные
-- запросы (кабинет 1009 с конца июля даёт 6 отказов Ozon 403 каждый прогон).
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_state TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_fail_count INT NOT NULL DEFAULT 0;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_failed_at TIMESTAMPTZ;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_last_error TEXT;
ALTER TABLE auth.shops ADD COLUMN IF NOT EXISTS auth_notified_at TIMESTAMPTZ;

ALTER TABLE auth.shops DROP CONSTRAINT IF EXISTS shops_auth_state_check;
ALTER TABLE auth.shops ADD CONSTRAINT shops_auth_state_check
  CHECK (auth_state IN ('ok','failing','paused'));
```

Применить: `psql -h localhost -U postgres -d saas -f db/migrations/037_shop_auth_state.sql`
Проверить: `psql -h localhost -U postgres -d saas -Atc "select auth_state, count(*) from auth.shops group by 1"` → все `ok`.

- [ ] **Step 2: Модуль состояния**

`worker/shop_auth.py`:

```python
"""Состояние ключей магазина: пауза при отказах авторизации и возврат в работу.

Единственное место, где меняется auth_state. Правило простое:
  ok → failing → paused, любой успех сбрасывает в ok.
Пауза проверяется по времени: раз в сутки магазин пробуется снова — вдруг
отказ был на стороне маркетплейса, а не у клиента.
"""
import os
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

# Сколько отказов подряд до паузы и как часто пробовать паузу на прочность.
FAIL_THRESHOLD = int(os.environ.get("SAAS_AUTH_FAIL_THRESHOLD", "2"))
RETRY_AFTER = timedelta(hours=int(os.environ.get("SAAS_AUTH_RETRY_HOURS", "24")))

PG = {
    "host": os.environ.get("SAAS_DB_HOST", "localhost"),
    "port": int(os.environ.get("SAAS_DB_PORT", "5432")),
    "dbname": os.environ.get("SAAS_DB", "saas"),
    "user": os.environ.get("POSTGRES_USER", "postgres"),
    "password": os.environ.get("POSTGRES_PASSWORD"),
}


def load_state(shop_id):
    """Строка состояния магазина или None, если магазина нет."""
    with psycopg.connect(**PG, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT shop_id, mp_code, auth_state, auth_fail_count, auth_failed_at, "
                "       auth_last_error FROM auth.shops WHERE shop_id = %s",
                (shop_id,),
            )
            return cur.fetchone()


def mark_failure(shop_id, error):
    """Засчитать отказ авторизации. Возвращает новое состояние ('failing'|'paused')."""
    with psycopg.connect(**PG, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE auth.shops
                      SET auth_fail_count = auth_fail_count + 1,
                          auth_state = CASE WHEN auth_fail_count + 1 >= %s
                                            THEN 'paused' ELSE 'failing' END,
                          auth_failed_at = now(),
                          auth_last_error = %s
                    WHERE shop_id = %s
                RETURNING auth_state""",
                (FAIL_THRESHOLD, str(error)[:500], shop_id),
            )
            row = cur.fetchone()
            return row["auth_state"] if row else None


def mark_ok(shop_id):
    """Успешный сбор: сбрасываем счётчик и состояние. Серия отказов должна быть
    непрерывной, иначе редкие одиночные сбои за месяц накопятся в ложную паузу."""
    with psycopg.connect(**PG) as conn:
        conn.execute(
            "UPDATE auth.shops SET auth_state = 'ok', auth_fail_count = 0, "
            "       auth_last_error = NULL, auth_notified_at = NULL "
            " WHERE shop_id = %s AND (auth_state <> 'ok' OR auth_fail_count <> 0)",
            (shop_id,),
        )


def should_skip(state_row, now=None):
    """Пропустить магазин в этом прогоне? Пауза держится сутки, потом даём
    контрольную попытку (её результат снова пройдёт через mark_ok/mark_failure)."""
    if not state_row or state_row.get("auth_state") != "paused":
        return False
    failed_at = state_row.get("auth_failed_at")
    if not failed_at:
        return False
    now = now or datetime.now(timezone.utc)
    return (now - failed_at) < RETRY_AFTER
```

- [ ] **Step 3: Проверка переходов**

Одноразовым скриптом (после проверки удалить, в репозиторий не класть):

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && \
export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas && \
/opt/agents/data-presenter-agent/.venv/bin/python - <<'PY'
from datetime import datetime, timedelta, timezone
import psycopg
from worker import shop_auth

# Тестовый кабинет и магазин — удаляем в конце.
with psycopg.connect(**shop_auth.PG) as conn:
    cid = conn.execute("INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, status) "
                       "VALUES (1, 'smoke-auth-state', '{ozon}', 'provisioning') RETURNING cabinet_id").fetchone()[0]
    sid = conn.execute("INSERT INTO auth.shops (cabinet_id, mp_code, shop_name) "
                       "VALUES (%s, 'ozon', 'smoke') RETURNING shop_id", (cid,)).fetchone()[0]
try:
    assert shop_auth.load_state(sid)["auth_state"] == "ok"
    assert shop_auth.should_skip(shop_auth.load_state(sid)) is False, "новый магазин не пропускаем"
    assert shop_auth.mark_failure(sid, "Ozon API 403") == "failing", "первый отказ — ещё не пауза"
    assert shop_auth.should_skip(shop_auth.load_state(sid)) is False, "failing не пропускаем"
    assert shop_auth.mark_failure(sid, "Ozon API 403") == "paused", "второй отказ — пауза"
    st = shop_auth.load_state(sid)
    assert shop_auth.should_skip(st) is True, "пауза свежая — пропускаем"
    old = datetime.now(timezone.utc) - timedelta(hours=25)
    assert shop_auth.should_skip({**st, "auth_failed_at": old}) is False, "через сутки — контрольная попытка"
    shop_auth.mark_ok(sid)
    st = shop_auth.load_state(sid)
    assert st["auth_state"] == "ok" and st["auth_fail_count"] == 0, "успех сбрасывает всё"
    print("ALL OK")
finally:
    with psycopg.connect(**shop_auth.PG) as conn:
        conn.execute("DELETE FROM auth.shops WHERE shop_id = %s", (sid,))
        conn.execute("DELETE FROM auth.cabinets WHERE cabinet_id = %s", (cid,))
PY
```

Expected: `ALL OK`. Затем проверить, что тестовых записей не осталось: `psql -h localhost -U postgres -d saas -Atc "select count(*) from auth.cabinets where display_name='smoke-auth-state'"` → `0`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/037_shop_auth_state.sql worker/shop_auth.py
git commit -m "feat(worker): состояние ключей магазина — пауза после отказов авторизации"
```

---

### Task 2: Распознавание отказа авторизации

**Files:**
- Create: `worker/auth_errors.py`

**Interfaces:**
- Produces: `is_auth_error(text) -> bool` — чистая функция, ни БД, ни сети.
- Consumes: ничего.

- [ ] **Step 1: Модуль**

`worker/auth_errors.py`:

```python
"""Отличить «ключи не работают» от обычного сбоя.

Останавливать сбор можно только из-за отказа в доступе (401/403). Сетевые
сбои, 429 и пятисотые — обычное поведение маркетплейсов, из-за них магазин
на паузу не ставим. Смотрим на текст ошибки сборщика: явного кода выхода у
сборщиков пока нет, а переписывать два десятка файлов ради этого — лишнее.
"""
import re

# Каждый шаблон — узкий, чтобы случайное «403» в данных не считалось отказом.
_PATTERNS = [
    re.compile(r"\bOzon API 40[13]\b", re.I),          # ozon_client: "Ozon API 403 [7]: ..."
    re.compile(r"\b40[13] Client Error\b", re.I),      # requests.raise_for_status()
    re.compile(r"Api-Key is missing", re.I),           # Ozon: ключ без нужной роли
    re.compile(r"\bUnauthorized\b", re.I),
    re.compile(r"\bForbidden\b", re.I),
    re.compile(r"токен[^\n]{0,40}(недействителен|истёк|истек)", re.I),
]


def is_auth_error(text):
    """Похоже ли сообщение об ошибке на отказ авторизации."""
    if not text:
        return False
    return any(p.search(str(text)) for p in _PATTERNS)
```

- [ ] **Step 2: Проверка на реальных и на обманчивых сообщениях**

Одноразовым скриптом (после проверки удалить):

```bash
cd /opt/agents/saas && /opt/agents/data-presenter-agent/.venv/bin/python - <<'PY'
from worker.auth_errors import is_auth_error

# Настоящие отказы авторизации (первые два — дословно из журнала кабинета 1009).
yes = [
    "ozon_client.OzonError: Ozon API 403 [7]: Api-Key is missing a required role for a method",
    "ozon_client.OzonError: Ozon API 401 [16]: Invalid Api-Key",
    "requests.exceptions.HTTPError: 401 Client Error: Unauthorized for url: https://...",
    "requests.exceptions.HTTPError: 403 Client Error: Forbidden for url: https://...",
    "RuntimeError: токен WB недействителен",
]
# НЕ отказы: сеть, лимиты, пятисотые, и числа 401/403 внутри данных.
no = [
    "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='...', port=443)",
    "ozon_client.OzonError: Ozon API 429 [8]: Too Many Requests",
    "requests.exceptions.HTTPError: 500 Server Error: Internal Server Error for url: ...",
    "ozon_client.OzonError: Исчерпаны попытки запроса /v1/analytics: timeout",
    "записано 403 строк → tenant.wb_orders",
    "nm_id 401 пропущен: нет себестоимости",
    "",
    None,
]
bad = [t for t in yes if not is_auth_error(t)] + [t for t in no if is_auth_error(t)]
print("ALL OK" if not bad else f"НЕВЕРНО: {bad}")
PY
```

Expected: `ALL OK`.

- [ ] **Step 3: Commit**

```bash
git add worker/auth_errors.py
git commit -m "feat(worker): распознавание отказа авторизации отдельно от сбоев сети"
```

---

### Task 3: Оркестратор — пропуск, отметки, тишина в алертах

**Files:**
- Modify: `worker/orchestrator.py` (бэкап → `/opt/agentsDB/backups/orchestrator.py.bak-2026-08-07iso`)

**Interfaces:**
- Consumes: `shop_auth.load_state/mark_failure/mark_ok/should_skip` (задача 1), `auth_errors.is_auth_error` (задача 2).
- Produces: строка журнала `jobs.collector_runs` со статусом `skipped` и ошибкой `auth_paused: <mp>` для магазина в паузе; отказы авторизации не попадают в `failed[]`, который валит прогон.

- [ ] **Step 1: Импорты и таймаут из окружения**

В шапке `worker/orchestrator.py` рядом с прочими импортами добавить:

```python
from worker import shop_auth
from worker.auth_errors import is_auth_error
```

(если импорты в файле идут без префикса `worker.` — например `import db_pg`, — используй тот же стиль: `import shop_auth` и `from auth_errors import is_auth_error`; проверь, как импортируются соседние модули, и повтори этот способ.)

Рядом с константами добавить:

```python
# Таймаут одного сборщика. Замер по журналу за 14 дней: самый долгий успешный
# прогон — wb_ads 5 мин 9 с, остальные до 20 с. Часовой лимит остался от
# отключённого wb_jem, который висел намертво. Значение вынесено в env, чтобы
# поднять без правки кода, если у крупного кабинета сбор окажется дольше.
COLLECTOR_TIMEOUT = int(os.environ.get("SAAS_COLLECTOR_TIMEOUT_SEC", "900"))
```

и заменить `timeout=3600` в вызове `subprocess.run` на `timeout=COLLECTOR_TIMEOUT`, а текст сообщения `TIMEOUT (>3600s)` — на `TIMEOUT (>{COLLECTOR_TIMEOUT}s)` (f-строка), и `error="timeout >3600s"` — на `error=f"timeout >{COLLECTOR_TIMEOUT}s"`.

- [ ] **Step 2: Пропуск магазина в паузе**

В `_run_one`, сразу после вычисления `shop_collectors` и до проверки кредов, вставить:

```python
    # Магазин со сломанными ключами не должен тратить окно прогона: пока он в
    # паузе, сборщики не запускаем вовсе. Раз в сутки shop_auth.should_skip
    # пропустит одну контрольную попытку — вдруг чинил не клиент, а маркетплейс.
    shop_id = shop.get("shop_id")
    state = shop_auth.load_state(shop_id) if shop_id else None
    if shop_auth.should_skip(state):
        since = state.get("auth_failed_at")
        print(f"    shop #{shop_id} {mp}: ключи не работают, пауза (с {since}) — пропуск", flush=True)
        _record_run(cid, f"{mp}:credentials", "skipped",
                    error=f"auth_paused: {state.get('auth_last_error') or 'отказ авторизации'}")
        return [], []
```

Возврат пустых списков — принципиален: пауза не должна попадать в `failed`, иначе прогон останется красным и алерт продолжит будить владельца сервиса.

- [ ] **Step 3: Отсутствие кредов — тоже отказ авторизации**

В том же `_run_one` заменить обе ветки проверки кредов, чтобы они отмечали состояние и не роняли прогон:

```python
    if mp == "wb" and not env.get("WB_TOKEN"):
        print(f"    shop #{shop_id} {mp}: нет WB_TOKEN — пропуск", flush=True)
        _record_run(cid, "wb:credentials", "no_token", error=f"shop #{shop_id}: нет WB_TOKEN")
        if shop_id:
            shop_auth.mark_failure(shop_id, "нет сохранённого токена WB")
        return [], []
    if mp == "ozon" and not (env.get("OZON_CLIENT_ID") and env.get("OZON_API_KEY")):
        print(f"    shop #{shop_id} {mp}: нет OZON creds — пропуск", flush=True)
        _record_run(cid, "ozon:credentials", "no_token", error=f"shop #{shop_id}: нет OZON creds")
        if shop_id:
            shop_auth.mark_failure(shop_id, "нет сохранённых ключей Ozon")
        return [], []
```

(было `return [], [f"{mp}:no_token"]` — теперь пустой список: отсутствующие ключи чинит клиент, а не владелец сервиса, и валить из-за этого прогон незачем.)

- [ ] **Step 4: Отметка результата после прогона сборщиков**

В конце `_run_one`, перед `return ok, failed`, вставить:

```python
    # Состояние ключей: отказ авторизации хотя бы в одном сборщике — засчитываем
    # неудачу, любой успех — сбрасываем. Сетевые сбои и 429 состояние не трогают:
    # маркетплейсы падают регулярно, останавливать из-за этого сбор нельзя.
    if shop_id:
        auth_errors_seen = [e for e in auth_error_texts if is_auth_error(e)]
        if auth_errors_seen:
            new_state = shop_auth.mark_failure(shop_id, auth_errors_seen[0])
            if new_state == "paused":
                print(f"    shop #{shop_id} {mp}: ключи не работают — магазин на паузе", flush=True)
            # Отказ авторизации не считаем сбоем сборки: чинит его клиент.
            failed = [f for f in failed if f not in auth_failed_collectors]
        elif ok:
            shop_auth.mark_ok(shop_id)
    return ok, failed
```

Для этого в начале цикла по сборщикам (там, где объявлены `ok`, `failed`, `statuses`) добавить два накопителя:

```python
    auth_error_texts = []      # тексты ошибок, похожих на отказ авторизации
    auth_failed_collectors = []  # какие сборщики упали именно по авторизации
```

и в ветке обычного падения (`else:` с `FAIL (exit …)`) после `_record_run(...)` добавить:

```python
                err_text = "\n".join(err[-3:]) if err else ""
                if is_auth_error(err_text):
                    auth_error_texts.append(err_text.strip().splitlines()[-1])
                    auth_failed_collectors.append(coll)
```

- [ ] **Step 5: Верификация на боевом кабинете 1009**

У этого кабинета ключи Ozon сломаны по-настоящему — это лучший из возможных тестов.

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && \
export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas && \
PY=/opt/agents/data-presenter-agent/.venv/bin/python && \
psql -h localhost -U postgres -d saas -c "select shop_id, mp_code, auth_state, auth_fail_count from auth.shops where cabinet_id=1009" && \
$PY -m worker.orchestrator --cabinet 1009 --collectors ozon_catalog --run-kind manual; echo "exit=$?" && \
psql -h localhost -U postgres -d saas -c "select shop_id, auth_state, auth_fail_count, auth_last_error from auth.shops where cabinet_id=1009"
```

Expected после первого прогона: `auth_state = failing`, `auth_fail_count = 1`, в `auth_last_error` — текст про 403; `exit=0` (прогон больше не считается упавшим).

Повторить ту же команду ещё раз. Expected: `auth_state = paused`, `auth_fail_count = 2`.

Запустить третий раз. Expected в выводе: строка `ключи не работают, пауза (с …) — пропуск`, сборщик не запускался; в журнале появилась строка со статусом `skipped`:

```bash
psql -h localhost -U postgres -d saas -c "select collector, status, error from jobs.collector_runs where cabinet_id=1009 order by started_at desc limit 3"
```

- [ ] **Step 6: Проверка, что здоровый кабинет не задет**

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && \
export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas && \
/opt/agents/data-presenter-agent/.venv/bin/python -m worker.orchestrator --cabinet 1 --collectors wb_catalog --run-kind manual; echo "exit=$?"; \
psql -h localhost -U postgres -d saas -c "select shop_id, mp_code, auth_state, auth_fail_count from auth.shops where cabinet_id=1"
```

Expected: сбор отработал, `exit=0`, у магазинов кабинета 1 состояние `ok`, счётчик 0.

- [ ] **Step 7: Commit**

```bash
git add worker/orchestrator.py
git commit -m "feat(worker): магазин в паузе пропускается, отказ авторизации не роняет прогон"
```

---

### Task 4: Панель — баннер владельцу, сброс при смене ключей, блок на /health

**Files:**
- Modify: `app/cabinets/[id]/layout.js` (бэкап → `/opt/agentsDB/backups/cabinet-layout.js.bak-2026-08-07iso`)
- Modify: `app/api/cabinets/[id]/shops/route.js` (бэкап → `/opt/agentsDB/backups/shops-route.js.bak-2026-08-07iso`)
- Modify: `app/api/health/route.js` (бэкап → `/opt/agentsDB/backups/health-route.js.bak-2026-08-07iso`)
- Modify: `app/health/HealthPage.jsx` (бэкап → `/opt/agentsDB/backups/HealthPage.jsx.bak-2026-08-07iso`)

**Interfaces:**
- Consumes: колонки состояния из задачи 1.
- Produces: баннер в шапке кабинета; сброс состояния при сохранении ключей; поле `shops_auth` в ответе `/api/health` и блок на странице.

- [ ] **Step 1: Баннер в шапке кабинета**

В `app/cabinets/[id]/layout.js` после запроса кабинета (`const mem = await query(...)`) добавить:

```js
  // Магазины со сломанными ключами: данные по ним не собираются, и клиент
  // должен узнать об этом сам, а не по устаревшим цифрам в отчётах.
  const brokenShops = await query(
    `SELECT mp_code, shop_name, auth_state, auth_failed_at
       FROM auth.shops
      WHERE cabinet_id = $1 AND is_active = true AND auth_state <> 'ok'
      ORDER BY mp_code`,
    [cabinetId]
  );
```

и в список `banners` (он собирается там же) добавить, перед баннером подтверждения почты:

```js
  for (const s of brokenShops) {
    const mp = s.mp_code === "wb" ? "Wildberries" : s.mp_code === "ozon" ? "Ozon" : s.mp_code;
    const since = s.auth_failed_at
      ? ` — данные не обновляются с ${new Date(s.auth_failed_at).toLocaleDateString("ru-RU")}`
      : "";
    banners.push({
      tone: "neg",
      text: `${mp}: ключи не работают${since}.`,
      link: { href: `/settings?cabinet=${cabinetId}&tab=settings`, label: "Обновить ключи" },
    });
  }
```

- [ ] **Step 2: Сохранение ключей снимает паузу**

В `app/api/cabinets/[id]/shops/route.js` в обработчике `PUT`, там где формируется `sets` и выполняется `UPDATE auth.shops`, добавить сброс состояния — но только когда реально меняли креды:

```js
  // Новые ключи — повод дать магазину ещё один шанс немедленно, не дожидаясь
  // суточной контрольной попытки воркера.
  if (apiCredsEnc) {
    sets.push(`auth_state = 'ok'`);
    sets.push(`auth_fail_count = 0`);
    sets.push(`auth_last_error = NULL`);
    sets.push(`auth_notified_at = NULL`);
  }
```

(вставить рядом с существующим `sets.push('api_creds_enc = ...')`, внутри той же ветки условия.)

- [ ] **Step 3: Блок на /health**

В `app/api/health/route.js` рядом со сбором `billing` и `paymentsMismatch` добавить:

```js
  // Магазины со сломанными ключами — вместо ежедневных писем о падении воркера.
  const shopsAuth = await query(
    `SELECT s.shop_id, s.cabinet_id, c.display_name, s.mp_code, s.shop_name,
            s.auth_state, s.auth_fail_count, s.auth_failed_at, s.auth_last_error
       FROM auth.shops s
       JOIN auth.cabinets c ON c.cabinet_id = s.cabinet_id
      WHERE s.is_active = true AND s.auth_state <> 'ok'
      ORDER BY s.auth_failed_at DESC NULLS LAST`
  );
```

и включить в ответ поле `shops_auth: shopsAuth`.

В `app/health/HealthPage.jsx` после блока «Платежи с несошедшейся суммой» добавить:

```jsx
      {Array.isArray(data.shops_auth) && data.shops_auth.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", color: "#ff6b6b" }}>
            Магазины со сломанными ключами ({data.shops_auth.length})
          </h2>
          <div style={{ fontSize: 13 }}>
            {data.shops_auth.map((s) => (
              <div key={s.shop_id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                {s.display_name} · {s.mp_code} {s.shop_name ? `«${s.shop_name}»` : ""} ·{" "}
                {s.auth_state === "paused" ? "пауза" : "сбои"} с{" "}
                {s.auth_failed_at ? new Date(s.auth_failed_at).toLocaleDateString("ru-RU") : "—"}
                {s.auth_last_error ? ` · ${s.auth_last_error}` : ""}
              </div>
            ))}
          </div>
        </div>
      )}
```

- [ ] **Step 4: Верификация**

```bash
cd /opt/agents/saas && npm run build && (SAAS_YOOKASSA_MOCK=1 npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase4.mjs http://localhost:3210
node scripts/smoke-auth-phase1.mjs http://localhost:3210
```

Expected: оба ALL PASS. Дополнительно вручную: кабинет 1009 к этому моменту стоит на паузе (задача 3), поэтому его страница должна показывать баннер. Проверить рендер можно авторизованным запросом: создать временного наблюдателя в кабинете 1009, запросить `/cabinets/1009` и убедиться, что HTML содержит «ключи не работают»; тестового пользователя и членство удалить сразу (проверить нулём `select count(*) from auth.users where email like '%@smoke.test'`).

Убить процесс на 3210, проверить `ss -ltnp | grep 3210` дважды.

- [ ] **Step 5: Commit**

```bash
git add "app/cabinets/[id]/layout.js" "app/api/cabinets/[id]/shops/route.js" app/api/health/route.js app/health/HealthPage.jsx
git commit -m "feat(ui): баннер о сломанных ключах, сброс паузы при смене ключей, блок на /health"
```

---

### Task 5: Письмо владельцу кабинета

**Files:**
- Create: `scripts/notify-broken-keys.mjs`
- Create: `deploy/systemd/saas-notify-keys.service`, `deploy/systemd/saas-notify-keys.timer`

**Interfaces:**
- Consumes: `sendMail` из `lib/mailer.js`, колонки состояния из задачи 1.
- Produces: письмо владельцу кабинета один раз на эпизод; `auth.shops.auth_notified_at` проставляется после отправки.

- [ ] **Step 1: Скрипт**

`scripts/notify-broken-keys.mjs`:

```js
#!/usr/bin/env node
// scripts/notify-broken-keys.mjs — письмо владельцу кабинета о сломанных ключах.
// Раз в час: магазины в паузе, о которых ещё не писали. Одно письмо на эпизод —
// auth_notified_at сбрасывается только когда магазин снова заработал.
// Воркер писем не шлёт: SMTP настроен в панели (lib/mailer.js), дублировать
// его в Python не нужно.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { query } = await import('../lib/db.js');
const { sendMail } = await import('../lib/mailer.js');

const MP_NAME = { wb: 'Wildberries', ozon: 'Ozon' };
const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';

const rows = await query(
  `SELECT s.shop_id, s.mp_code, s.shop_name, s.auth_failed_at, s.auth_last_error,
          c.cabinet_id, c.display_name, u.email
     FROM auth.shops s
     JOIN auth.cabinets c ON c.cabinet_id = s.cabinet_id
     JOIN auth.users u ON u.user_id = c.owner_user_id
    WHERE s.is_active = true AND s.auth_state = 'paused' AND s.auth_notified_at IS NULL`
);

let sent = 0, failed = 0;
for (const r of rows) {
  const mp = MP_NAME[r.mp_code] || r.mp_code;
  const since = r.auth_failed_at ? new Date(r.auth_failed_at).toLocaleDateString('ru-RU') : '';
  const res = await sendMail({
    to: r.email,
    subject: `SySell: ${mp} — ключи не работают`,
    text: `Здравствуйте!\n\nПанель не может получить данные ${mp} по проекту «${r.display_name}»`
      + `${r.shop_name ? ` (магазин «${r.shop_name}»)` : ''}: маркетплейс отказывает в доступе`
      + `${since ? ` с ${since}` : ''}. Пока ключи не обновлены, отчёты по этому магазину не обновляются.\n\n`
      + `Обновить ключи: ${base}/settings?cabinet=${r.cabinet_id}&tab=settings\n\n`
      + `Что обычно помогает: выпустить новый токен в личном кабинете маркетплейса и`
      + ` проверить, что у него есть нужные права.\n\nПоследняя ошибка: ${r.auth_last_error || '—'}`,
  });
  if (res.ok) {
    await query(`UPDATE auth.shops SET auth_notified_at = now() WHERE shop_id = $1`, [r.shop_id]);
    sent++;
    console.log(`[notify-keys] письмо отправлено: кабинет ${r.cabinet_id}, магазин ${r.shop_id}`);
  } else {
    failed++;
    console.error(`[notify-keys] не отправлено (кабинет ${r.cabinet_id}): ${res.error}`);
  }
}
console.log(`[notify-keys] в паузе без уведомления: ${rows.length}, отправлено ${sent}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Юнит и таймер**

`deploy/systemd/saas-notify-keys.service`:

```ini
[Unit]
Description=SAAS — письма владельцам о сломанных ключах маркетплейсов
OnFailure=saas-failure@%n.service

[Service]
Type=oneshot
WorkingDirectory=/opt/agents/saas
Environment=TZ=Europe/Moscow
ExecStart=/usr/bin/node scripts/notify-broken-keys.mjs
User=root
```

`deploy/systemd/saas-notify-keys.timer`:

```ini
[Unit]
Description=SAAS — проверка сломанных ключей раз в час

[Timer]
OnCalendar=hourly
RandomizedDelaySec=600
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Проверка на кабинете 1009**

К этому моменту его магазин Ozon стоит на паузе (задача 3), письма о нём ещё не было. Почта в режиме «раковины», поэтому письмо ляжет файлом:

```bash
cd /opt/agents/saas && node scripts/notify-broken-keys.mjs
ls -t /tmp/saas-mail/ | head -3
cat /tmp/saas-mail/$(ls -t /tmp/saas-mail/ | head -1)
psql -h localhost -U postgres -d saas -c "select shop_id, auth_state, auth_notified_at from auth.shops where cabinet_id=1009"
```

Expected: строка `отправлено 1`; в файле — письмо владельцу кабинета 1009 с названием проекта и ссылкой; `auth_notified_at` проставлен.

Повторный запуск: `node scripts/notify-broken-keys.mjs` → `в паузе без уведомления: 0, отправлено 0` (второго письма нет).

- [ ] **Step 4: Commit**

```bash
git add scripts/notify-broken-keys.mjs deploy/systemd/saas-notify-keys.service deploy/systemd/saas-notify-keys.timer
git commit -m "feat(worker): письмо владельцу кабинета о сломанных ключах (одно на эпизод)"
```

---

### Task 6: Установка таймера, деплой, документация

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Установить таймер уведомлений**

```bash
cd /opt/agents/saas && cp deploy/systemd/saas-notify-keys.service deploy/systemd/saas-notify-keys.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now saas-notify-keys.timer && systemctl list-timers saas-notify-keys --no-pager | head -3
```

Expected: таймер в списке.

- [ ] **Step 2: Деплой панели и регресс**

```bash
cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 6 && systemctl is-active saas-web
node scripts/smoke-auth-phase4.mjs http://localhost:3200
node scripts/smoke-auth-phase3.mjs http://localhost:3200
node scripts/smoke-auth-phase2.mjs http://localhost:3200
node scripts/smoke-auth-phase1.mjs http://localhost:3200
node scripts/smoke-auth-phase0.mjs http://localhost:3200
SAAS_YOOKASSA_MOCK=1 node scripts/smoke-billing.mjs http://localhost:3200
node scripts/check-billing-lib.mjs
```

Expected: `active` и ALL PASS во всех проверках.

- [ ] **Step 3: Живой прогон воркера целиком**

```bash
systemctl start saas-worker.service
```

Дождаться завершения (`until ! systemctl is-active --quiet saas-worker.service; do sleep 10; done`), затем:

```bash
systemctl show saas-worker.service -p ExecMainStatus
psql -h localhost -U postgres -d saas -c "select cabinet_id, collector, status, error from jobs.collector_runs where started_at > now() - interval '20 minutes' and status <> 'ok' order by started_at"
```

Expected: `ExecMainStatus=0` — прогон больше не падает из-за кабинета 1009; в журнале по нему одна строка со статусом `skipped` и причиной `auth_paused`, вместо шести `failed`.

- [ ] **Step 4: Документация**

В `AGENTS.md` в раздел про воркер добавить:

```
- **Сломанные ключи магазина.** Отказ авторизации (401/403 или отсутствие
  кредов) считается проблемой клиента, а не сбоем сборки: после двух отказов
  подряд магазин переходит в `auth.shops.auth_state='paused'` и пропускается
  (строка `skipped`/`auth_paused` в `jobs.collector_runs`), прогон при этом
  остаётся зелёным. Раз в сутки — контрольная попытка; сохранение новых ключей
  снимает паузу сразу. Клиент видит красный баннер в шапке кабинета и получает
  письмо (таймер `saas-notify-keys`, одно письмо на эпизод). Владелец сервиса
  видит список на `/health`. Пороги: `SAAS_AUTH_FAIL_THRESHOLD` (2),
  `SAAS_AUTH_RETRY_HOURS` (24). Таймаут одного сборщика —
  `SAAS_COLLECTOR_TIMEOUT_SEC` (900, было 3600).
```

```bash
git add AGENTS.md
git commit -m "docs(worker): изоляция магазинов со сломанными ключами"
```

- [ ] **Step 5: Сообщить владельцу**

Кабинет 1009 встал на паузу, ежедневные письма о падении воркера прекратятся. Его владельцу ушло письмо — сейчас в «раковину», по-настоящему уйдёт после настройки SMTP. Чтобы вернуть кабинет в строй, владелец должен обновить ключи Ozon в настройках проекта; после сохранения сбор возобновится с ближайшего прогона.
