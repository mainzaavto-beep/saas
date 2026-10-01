# Авторазбор падений сборщиков — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Таймер-сторож находит эпизоды падений сборщиков в `jobs.collector_runs`, запускает
headless `claude -p` с правами только на чтение, сохраняет структурированный диагноз в
`jobs.failure_triage`, шлёт письмо владельцу и показывает разборы на `/health`.

**Architecture:** Чистое ядро `worker/triage_core.py` (решения тика, разбор ответа, нарезка
лога — без БД/сети) + оболочка `worker/failure_triage.py` (PG под `postgres`, subprocess
`claude`, вызов node-скрипта писем). Письма — `scripts/notify-triage.mjs` на
`lib/triageMail.js` (чистое форматирование) и `lib/mailer.js`. Витрина — ключ `triage` в
`/api/health` и блок в `HealthPage.jsx`. Таймер `saas-triage` каждые 15 мин.

**Tech Stack:** Python 3 (venv `/opt/agents/data-presenter-agent/.venv`, psycopg 3),
Node 20 (`node:test`), Next.js 14, PostgreSQL, systemd, Claude Code CLI 2.1.284.

**Spec:** `docs/superpowers/specs/2026-09-30-failure-triage-design.md`

## Global Constraints

- Уровень автономии — **только диагноз**: Claude не меняет код, БД, юниты. `Edit`/`Write`/`NotebookEdit`/`Agent` запрещены, БД — только `saas_ro`.
- Модель — `sonnet`. Таймаут разбора — 1200 с. Зависший `running` — > 30 мин → `error`.
- Эпизод открывается после 2 падений подряд у пары «сборщик × кабинет», дальше тишина до `ok`. Лимит — 3 разбора за скользящие 24 ч, не больше 1 за тик.
- Падение = статус `failed` или `timeout` (в CHECK `collector_runs` есть оба; `timeout` — тоже падение, уточнение к спеке). `skipped`/`no_token` не учитываются, `partial` не открывает и не закрывает.
- Прогоны `run_kind='manual'` игнорируются целиком (ручные пробы на каб. 1 не должны порождать разборы; уточнение к спеке).
- `unit:saas-triage*` исключён всегда.
- Kill-switch: `SAAS_TRIAGE_ENABLED=0` → тик выходит 0 без действий.
- Запись в боевую БД руками — только через `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas`. Чтение — `psql -h localhost -U saas_ro -d saas`.
- Бэкап перед правкой существующего боевого файла — в `/opt/agentsDB/backups/<имя>.<YYYYMMDD_HHMMSS>.bak`.
- После правок `app/`/`lib/` — `npm run build && systemctl restart saas-web`. `next dev` в каталоге прода не запускать.
- `git add` — только явный список файлов задачи (урок памяти: широкий add заметал чужие файлы).
- Python для тестов и воркера: `/opt/agents/data-presenter-agent/.venv/bin/python` (ниже `$PY`).

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `db/migrations/060_failure_triage.sql` (новый) | таблица эпизодов, индекс уникальности, гранты |
| `worker/triage_core.py` (новый) | чистые функции: `plan_tick`, `pick_next`, `parse_claude_output`, `slice_worker_log`, `build_prompt` |
| `worker/triage_core_selftest.py` (новый) | селф-тест ядра без БД/сети/Claude |
| `worker/triage_prompt.md` (новый) | шаблон промпта с плейсхолдерами `{{…}}` |
| `worker/triage_schema.json` (новый) | JSON-схема ответа Claude |
| `worker/failure_triage.py` (новый) | оболочка тика: БД, контекст, запуск `claude`, запись итога, вызов писем |
| `lib/triageMail.js` (новый) | чистое форматирование письма |
| `lib/__tests__/triageMail.test.mjs` (новый) | тест форматирования |
| `scripts/notify-triage.mjs` (новый) | выборка неотправленных, отправка, `notified_at` |
| `app/api/health/route.js` (правка) | ключ `triage` |
| `app/health/HealthPage.jsx` (правка) | блок «Разборы падений» |
| `deploy/systemd/saas-triage.{service,timer}` (новые) | таймер 15 мин |
| `AGENTS.md` (правка) | раздел в «Сбор данных» + строка в «Боевое расписание» |

---

### Task 1: Проба CLI — песочница и форма ответа

Цель — до написания кода подтвердить на живом `claude`: (а) запрещённые действия отклоняются
в нашей конфигурации флагов; (б) где в JSON-конверте `--output-format json` лежит
структурированный ответ `--json-schema`. Результат пробы фиксируется в спеке; от него
зависит константа `STRUCTURED_KEY` в Task 3.

**Files:**
- Create: `worker/triage_schema.json`
- Modify: `docs/superpowers/specs/2026-09-30-failure-triage-design.md` (дописать §10 «Результаты пробы»)

**Interfaces:**
- Produces: `worker/triage_schema.json` (используется Task 4); факт «ключ конверта = `structured_output`» или иной (используется Task 3).

- [ ] **Step 1: Создать схему ответа**

`worker/triage_schema.json`:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "cause", "confidence", "evidence", "proposed_fix", "data_impact", "urgent"],
  "properties": {
    "summary": {"type": "string", "description": "2-3 строки: что сломалось и почему"},
    "cause": {"type": "string", "enum": ["mp_method_changed", "rate_limit", "auth", "our_bug", "data", "infra", "unknown"]},
    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    "evidence": {"type": "array", "items": {"type": "string"}, "description": "факты: файл:строка, строка лога, результат SQL"},
    "proposed_fix": {"type": "string"},
    "data_impact": {"type": "string", "description": "какие кабинеты/даты без данных, нужен ли бэкфилл"},
    "urgent": {"type": "boolean", "description": "теряются финансовые данные клиента прямо сейчас"}
  }
}
```

- [ ] **Step 2: Проба запретов**

Run (из `/opt/agents/saas`):
```bash
rm -f /tmp/triage_probe_x
echo 'Это проба песочницы. По очереди попробуй: 1) создать файл /tmp/triage_probe_x с текстом x инструментом Write; 2) выполнить bash: touch /tmp/triage_probe_x; 3) выполнить bash: psql -h localhost -U postgres -d saas -c "select 1"; 4) выполнить bash: rm -f /opt/agents/saas/README.md; 5) выполнить bash: psql -h localhost -U saas_ro -d saas -Atc "select 1". Для каждого шага сообщи: выполнено или отклонено. В поле summary перечисли итоги, cause=unknown, confidence=low, остальные поля — пустые строки/пустой список/false.' \
| claude -p --model sonnet --output-format json \
  --json-schema "$(cat worker/triage_schema.json)" \
  --setting-sources user --permission-mode default \
  --allowedTools Read Grep Glob WebFetch WebSearch \
    "Bash(psql -h localhost -U saas_ro:*)" "Bash(journalctl:*)" \
    "Bash(git log:*)" "Bash(git show:*)" "Bash(git diff:*)" \
    "Bash(grep:*)" "Bash(tail:*)" "Bash(head:*)" "Bash(wc:*)" "Bash(ls:*)" \
  --disallowedTools Edit Write NotebookEdit Agent \
    "Read(/root/.pgpass*)" "Read(/opt/agents/saas/.env.local)" "Read(/etc/saas-worker.env)" "Read(/etc/collectors.env)" \
  > /tmp/triage_probe.json; echo "exit=$?"
ls -la /tmp/triage_probe_x 2>&1; git -C /opt/agents/saas status --short README.md
$PY -c "import json;d=json.load(open('/tmp/triage_probe.json'));print(sorted(d.keys()));print(json.dumps(d.get('structured_output'),ensure_ascii=False)[:800]);print(str(d.get('result'))[:800])"
```
Expected: `exit=0`; `/tmp/triage_probe_x` — `No such file`; `README.md` не удалён (git status пуст);
в `structured_output.summary` шаги 1–4 «отклонено», шаг 5 «выполнено».

Если хоть один из шагов 1–4 выполнен — **СТОП**, задачу не продолжать, доложить: конфигурация
песочницы не держит, нужна правка флагов (например, `--settings` с явным `permissions.deny`)
и повтор пробы.

- [ ] **Step 3: Записать форму конверта**

Из вывода шага 2 — список ключей конверта. Если структурированный ответ лежит в
`structured_output` — Task 3 использует `STRUCTURED_KEY = "structured_output"` как есть.
Если в другом ключе — записать его имя, Task 3 подставит его в константу.

- [ ] **Step 4: Дописать спеку**

В конец `docs/superpowers/specs/2026-09-30-failure-triage-design.md`:
```markdown
## 10. Результаты пробы CLI (<дата>)

- Запреты: Write, `touch`, `psql -U postgres`, `rm` — отклонены; `psql -U saas_ro` — выполнен.
- Конверт `--output-format json`: ключи <список>; структурированный ответ — в `<ключ>`.
- К флагам §5 добавлены `Bash(head:*)`, `Bash(wc:*)` и запреты `Read` на файлы с паролями
  (`/root/.pgpass*`, `.env.local`, `/etc/saas-worker.env`, `/etc/collectors.env`).
- Уточнения при планировании: `timeout` = падение; `run_kind='manual'` игнорируется; эхо
  юнита — по `run_kind` сборщиков юнита в окне [−70; +5] мин от записи юнита (запись юнита
  делается в конце прогона, прогон длится до часа — окно ±10 мин из §4 не ловило эхо).
```

- [ ] **Step 5: Commit**

```bash
git add worker/triage_schema.json docs/superpowers/specs/2026-09-30-failure-triage-design.md
git commit -m "feat(triage): схема ответа разбора + результаты пробы песочницы claude -p"
```

---

### Task 2: Миграция `060_failure_triage.sql`

**Files:**
- Create: `db/migrations/060_failure_triage.sql`

**Interfaces:**
- Produces: таблица `jobs.failure_triage` с колонками `id, collector, cabinet_id, status, opened_at, last_failed_run_id, closed_at, started_at, finished_at, summary, cause, confidence, urgent, report_json, raw_output, notified_at`; уникальный индекс `failure_triage_open_uq ON (collector, (COALESCE(cabinet_id,0))) WHERE status <> 'closed'`.

- [ ] **Step 1: Написать миграцию**

```sql
-- 060_failure_triage.sql — эпизоды авторазбора падений сборщиков
-- (спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §3).
-- Пишет: worker/failure_triage.py (под postgres). Читает: /api/health и
-- scripts/notify-triage.mjs (saas_app; последний ещё ставит notified_at), saas_ro.
-- Без RLS: операторские данные, как jobs.collector_runs. Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS jobs.failure_triage (
    id                 BIGSERIAL PRIMARY KEY,
    collector          TEXT NOT NULL,          -- имя сборщика или 'unit:<юнит>'
    cabinet_id         BIGINT,                 -- NULL для unit:*
    status             TEXT NOT NULL CHECK (status IN ('queued','running','done','error','closed')),
    opened_at          TIMESTAMPTZ NOT NULL,   -- started_at первого падения серии
    last_failed_run_id BIGINT,
    closed_at          TIMESTAMPTZ,
    started_at         TIMESTAMPTZ,            -- начало разбора
    finished_at        TIMESTAMPTZ,
    summary            TEXT,
    cause              TEXT,
    confidence         TEXT,
    urgent             BOOLEAN,
    report_json        JSONB,
    raw_output         TEXT,
    notified_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS failure_triage_open_uq
    ON jobs.failure_triage (collector, (COALESCE(cabinet_id, 0)))
    WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS failure_triage_started ON jobs.failure_triage (started_at);

GRANT SELECT ON jobs.failure_triage TO saas_app;
GRANT UPDATE (notified_at) ON jobs.failure_triage TO saas_app;
GRANT SELECT ON jobs.failure_triage TO saas_ro;

COMMIT;
```

- [ ] **Step 2: Применить и проверить идемпотентность**

```bash
cd /opt/agents/saas
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/060_failure_triage.sql
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/060_failure_triage.sql
psql -h localhost -U saas_ro -d saas -Atc "select count(*) from jobs.failure_triage"
```
Expected: оба прогона `COMMIT` без ошибок; последний — `0`.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/060_failure_triage.sql
git commit -m "feat(triage): миграция 060 — jobs.failure_triage"
```

---

### Task 3: Ядро `worker/triage_core.py` + селф-тест

**Files:**
- Create: `worker/triage_core.py`
- Test: `worker/triage_core_selftest.py`

**Interfaces:**
- Consumes: значение `STRUCTURED_KEY` из Task 1, step 3.
- Produces:
  - `plan_tick(runs: list[dict], open_episodes: list[dict], now: datetime) -> dict` с ключами `open: list[dict(collector, cabinet_id, opened_at, last_failed_run_id)]`, `close: list[int]`, `bump: list[tuple[int,int]]`, `stale: list[int]`. Прогон: `id, collector, cabinet_id, run_kind, status, started_at` (aware datetime). Эпизод: `id, collector, cabinet_id, status, opened_at, started_at, last_failed_run_id`.
  - `pick_next(open_episodes: list[dict], started_24h: int) -> int | None`
  - `parse_claude_output(stdout: str, returncode: int) -> tuple[dict|None, str|None]`
  - `slice_worker_log(text: str, collector: str, at_msk: datetime, max_lines: int = 200) -> str` (`at_msk` — naive MSK)
  - `build_prompt(template: str, ctx: dict[str,str]) -> str`
  - константы `UNIT_KIND: dict[str,str]`, `KIND_UNIT: dict[str,str]`, `is_unit(collector) -> bool`

- [ ] **Step 1: Написать селф-тест (падающий)**

`worker/triage_core_selftest.py`:
```python
"""
Селф-тест ядра авторазбора падений (спека 2026-09-30-failure-triage-design.md §4–5).
Без БД, сети и Claude.
Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/triage_core_selftest.py
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import triage_core as m  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    print(("PASS — " if cond else "FAIL — ") + msg, flush=True)
    if not cond:
        failed += 1


NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
_id = [0]


def run(coll, cab, status, mins_ago, kind="main"):
    _id[0] += 1
    return {"id": _id[0], "collector": coll, "cabinet_id": cab, "run_kind": kind,
            "status": status, "started_at": NOW - timedelta(minutes=mins_ago)}


def ep(i, coll, cab, status="queued", last=None, started_mins_ago=None, opened_mins_ago=100):
    return {"id": i, "collector": coll, "cabinet_id": cab, "status": status,
            "opened_at": NOW - timedelta(minutes=opened_mins_ago),
            "started_at": None if started_mins_ago is None else NOW - timedelta(minutes=started_mins_ago),
            "last_failed_run_id": last}


# --- открытие ---
rs = [run("ozon_finance", 1, "ok", 600), run("ozon_finance", 1, "failed", 400), run("ozon_finance", 1, "failed", 200)]
p = m.plan_tick(rs, [], NOW)
check(len(p["open"]) == 1 and p["open"][0]["collector"] == "ozon_finance" and p["open"][0]["cabinet_id"] == 1,
      "два failed подряд открывают эпизод")
check(p["open"][0]["opened_at"] == rs[1]["started_at"], "opened_at = начало серии failed")
check(p["open"][0]["last_failed_run_id"] == rs[2]["id"], "last_failed_run_id = последний failed")

rs = [run("x", 1, "failed", 300), run("x", 1, "timeout", 100)]
check(len(m.plan_tick(rs, [], NOW)["open"]) == 1, "timeout считается падением")

rs = [run("x", 1, "failed", 300), run("x", 1, "ok", 200), run("x", 1, "failed", 100)]
check(m.plan_tick(rs, [], NOW)["open"] == [], "одно failed после ok — не эпизод")

rs = [run("x", 1, "failed", 300), run("x", 1, "skipped", 200), run("x", 1, "no_token", 150), run("x", 1, "failed", 100)]
check(len(m.plan_tick(rs, [], NOW)["open"]) == 1, "skipped/no_token между падениями не рвут серию")

rs = [run("x", 1, "failed", 300), run("x", 1, "partial", 100)]
check(m.plan_tick(rs, [], NOW)["open"] == [], "partial последним — не открывает")

rs = [run("x", 1, "failed", 300, kind="manual"), run("x", 1, "failed", 100, kind="manual")]
check(m.plan_tick(rs, [], NOW)["open"] == [], "manual-прогоны игнорируются")

rs = [run("x", 1, "failed", 300), run("x", 1, "failed", 100)]
p = m.plan_tick(rs, [ep(7, "x", 1, last=rs[1]["id"])], NOW)
check(p["open"] == [] and p["bump"] == [], "открытый эпизод не дублируется, bump не нужен")

rs = [run("x", 1, "failed", 300), run("x", 1, "failed", 100)]
p = m.plan_tick(rs, [ep(7, "x", 1, status="done", last=rs[0]["id"])], NOW)
check(p["bump"] == [(7, rs[1]["id"])], "новое падение двигает last_failed_run_id")

rs = [run("x", 1, "failed", 300), run("x", 1, "failed", 100), run("x", 2, "failed", 90)]
check([o["cabinet_id"] for o in m.plan_tick(rs, [], NOW)["open"]] == [1], "пары по кабинетам раздельны")

# --- закрытие ---
rs = [run("x", 1, "failed", 300), run("x", 1, "ok", 100)]
check(m.plan_tick(rs, [ep(7, "x", 1, status="done")], NOW)["close"] == [7], "ok закрывает эпизод")
check(m.plan_tick(rs, [ep(7, "x", 1, status="running", started_mins_ago=5)], NOW)["close"] == [],
      "running не закрывается (закроется следующим тиком)")
rs = [run("x", 1, "failed", 300), run("x", 1, "partial", 100)]
check(m.plan_tick(rs, [ep(7, "x", 1, status="done")], NOW)["close"] == [], "partial не закрывает")
check(m.plan_tick([], [ep(7, "x", 1, status="queued")], NOW)["close"] == [7],
      "эпизод без прогонов в окне закрывается")

# --- юниты ---
U = "unit:saas-worker.service"
rs = [run("ozon_finance", 1, "failed", 400), run(U, None, "failed", 380, kind="systemd"),
      run("ozon_finance", 1, "failed", 200), run(U, None, "failed", 180, kind="systemd")]
p = m.plan_tick(rs, [], NOW)
check([o["collector"] for o in p["open"]] == ["ozon_finance"], "эхо юнита (сборщик main упал в окне) не открывает")

rs = [run("ozon_metrics_30m", 1, "failed", 395, kind="metrics30m"), run(U, None, "failed", 380, kind="systemd"),
      run(U, None, "failed", 180, kind="systemd")]
opened = [o["collector"] for o in m.plan_tick(rs, [], NOW)["open"]]
check(U in opened, "падение сборщика ДРУГОГО юнита эхом не считается")

rs = [run(U, None, "failed", 600, kind="systemd"), run(U, None, "failed", 300, kind="systemd")]
p = m.plan_tick(rs, [], NOW)
check(len(p["open"]) == 1 and p["open"][0]["cabinet_id"] is None, "два одиночных падения юнита за сутки открывают")

rs = [run(U, None, "failed", 60 * 60, kind="systemd"), run(U, None, "failed", 60 * 30, kind="systemd")]
check(m.plan_tick(rs, [], NOW)["open"] == [], "падения юнита с разрывом > 24 ч — не серия")

rs = [run(U, None, "failed", 60 * 26, kind="systemd")]
check(m.plan_tick(rs, [ep(9, U, None, status="done", last=rs[0]["id"])], NOW)["close"] == [9],
      "юнит закрывается после 24 ч без новых падений")

R = "unit:saas-ozon-recon.service"
rs = [run("ozon_finance", 1, "failed", 305), run(R, None, "failed", 300, kind="systemd"),
      run(R, None, "failed", 100, kind="systemd")]
check(R in [o["collector"] for o in m.plan_tick(rs, [], NOW)["open"]],
      "юнит без своих сборщиков (recon) эхом не считается")

rs = [run("unit:saas-triage.service", None, "failed", 300, kind="systemd"),
      run("unit:saas-triage.service", None, "failed", 100, kind="systemd")]
check(m.plan_tick(rs, [], NOW)["open"] == [], "unit:saas-triage исключён")

# --- зависшие и выбор ---
p = m.plan_tick([], [ep(5, "x", 1, status="running", started_mins_ago=31)], NOW)
check(p["stale"] == [5], "running > 30 мин — stale")
p = m.plan_tick([run("x", 1, "failed", 10)], [ep(5, "x", 1, status="running", started_mins_ago=10)], NOW)
check(p["stale"] == [], "running 10 мин — не stale")

eps = [ep(1, "a", 1, opened_mins_ago=50), ep(2, "b", 1, opened_mins_ago=90), ep(3, "c", 1, status="done")]
check(m.pick_next(eps, 0) == 2, "берётся самый старый queued")
check(m.pick_next(eps, 3) is None, "лимит 3 за сутки")
check(m.pick_next(eps + [ep(4, "d", 1, status="running", started_mins_ago=1)], 0) is None, "не больше одного running")
check(m.pick_next([ep(3, "c", 1, status="done")], 0) is None, "нет queued — None")

# --- разбор ответа ---
GOOD = {"summary": "s", "cause": "mp_method_changed", "confidence": "high", "evidence": ["e"],
        "proposed_fix": "f", "data_impact": "d", "urgent": True}
env = {"type": "result", "is_error": False, "result": "", m.STRUCTURED_KEY: GOOD}
rep, err = m.parse_claude_output(json.dumps(env), 0)
check(rep == GOOD and err is None, "валидный конверт")
env2 = {"type": "result", "is_error": False, "result": json.dumps(GOOD)}
check(m.parse_claude_output(json.dumps(env2), 0)[0] == GOOD, "fallback: отчёт JSON-строкой в result")
check(m.parse_claude_output("garbage", 0)[0] is None, "битый JSON → ошибка")
check(m.parse_claude_output(json.dumps(env), 1)[0] is None, "ненулевой код → ошибка")
bad = dict(GOOD, cause="whatever")
check(m.parse_claude_output(json.dumps({"is_error": False, m.STRUCTURED_KEY: bad}), 0)[0] is None,
      "cause вне перечня → ошибка")
bad = {k: v for k, v in GOOD.items() if k != "urgent"}
check(m.parse_claude_output(json.dumps({"is_error": False, m.STRUCTURED_KEY: bad}), 0)[0] is None,
      "нет обязательного поля → ошибка")
check(m.parse_claude_output(json.dumps({"is_error": True, "result": "boom"}), 0)[0] is None, "is_error → ошибка")

# --- нарезка лога ---
LOG = "\n".join([
    "=== SaaS collect [main] Thu Oct  1 05:15:02 MSK 2026 — период 2026-09-29..2026-10-01 ===",
    "  -- shop #3 [ozon]: ['ozon_finance']",
    "     [ozon_finance] FAIL (exit 1): OLD",
    "EXIT=0",
    "=== SaaS collect [main] Thu Oct  1 09:00:05 MSK 2026 — период 2026-09-29..2026-10-01 ===",
    "     [wb_orders] ok",
    "     [ozon_finance] FAIL (exit 1): requests.exceptions.HTTPError: 404",
    "     Traceback line",
    "EXIT=0",
    "=== SaaS collect [main] Thu Oct  1 12:00:01 MSK 2026 — период x ===",
    "     [ozon_finance] FAIL (exit 1): FUTURE",
])
s = m.slice_worker_log(LOG, "ozon_finance", datetime(2026, 10, 1, 9, 20))
check("404" in s and "Traceback line" in s, "берётся блок прогона, в котором шло падение, с хвостом")
check("OLD" not in s and "FUTURE" not in s and "wb_orders" not in s, "чужие прогоны и сборщики отрезаны")
check(m.slice_worker_log("нет заголовков", "x", datetime(2026, 10, 1)) == "", "без заголовков — пусто")

# --- промпт ---
check(m.build_prompt("a {{x}} b {{y}} {x}", {"x": "1", "y": "{2}"}) == "a 1 b {2} {x}",
      "подстановка только {{key}}, фигурные скобки значений не ломают")

print(f"\nИтого провалов: {failed}")
sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /opt/agents/saas && $PY worker/triage_core_selftest.py`
Expected: `ModuleNotFoundError: No module named 'triage_core'`

- [ ] **Step 3: Написать ядро**

`worker/triage_core.py` (если Task 1 показал другой ключ конверта — подставить его в `STRUCTURED_KEY`):
```python
"""
triage_core.py — чистое ядро авторазбора падений сборщиков
(спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §4–5).

Без БД, сети и subprocess: оболочка worker/failure_triage.py подаёт выборки и
применяет решения. Селф-тест: worker/triage_core_selftest.py.
"""
import json
import re
from datetime import datetime, timedelta

FAIL = {"failed", "timeout"}
COUNTED = {"ok", "partial", "failed", "timeout"}   # skipped / no_token не учитываются
IGNORED_KINDS = {"manual"}                        # ручные пробы не порождают разборы
SELF_PREFIX = "unit:saas-triage"                  # разбор не разбирает себя

# Юнит → run_kind его сборщиков. Запись unit:* делает OnFailure в КОНЦЕ прогона,
# а прогон длится до часа, поэтому эхо ищется в окне [−70; +5] мин.
UNIT_KIND = {
    "unit:saas-worker.service": "main",
    "unit:saas-stocks.service": "stocks",
    "unit:saas-metrics30m.service": "metrics30m",
    "unit:saas-references.service": "references",
    "unit:saas-backfill.service": "backfill",
    "unit:saas-cabinet.service": "cabinet",
    "unit:saas-fbs-status.service": "fbsstatus",
    "unit:saas-sku-ad-night.service": "skuad",
}
KIND_UNIT = {v: k[len("unit:"):] for k, v in UNIT_KIND.items()}
ECHO_BEFORE = timedelta(minutes=70)
ECHO_AFTER = timedelta(minutes=5)
UNIT_QUIET = timedelta(hours=24)
STALE = timedelta(minutes=30)
DAILY_LIMIT = 3

STRUCTURED_KEY = "structured_output"   # ключ конверта claude -p --output-format json (проба Task 1)
CAUSES = {"mp_method_changed", "rate_limit", "auth", "our_bug", "data", "infra", "unknown"}
CONFIDENCE = {"high", "medium", "low"}
REQUIRED = {"summary": str, "cause": str, "confidence": str, "evidence": list,
            "proposed_fix": str, "data_impact": str, "urgent": bool}


def is_unit(collector):
    return collector.startswith("unit:")


def _desc(rs):
    return sorted(rs, key=lambda r: (r["started_at"], r["id"]), reverse=True)


def _is_echo(unit_run, collector_fails):
    kind = UNIT_KIND.get(unit_run["collector"])
    if kind is None:
        return False
    t = unit_run["started_at"]
    return any(r["run_kind"] == kind and t - ECHO_BEFORE <= r["started_at"] <= t + ECHO_AFTER
               for r in collector_fails)


def _new(key, opened_at, last_id):
    return {"collector": key[0], "cabinet_id": key[1], "opened_at": opened_at, "last_failed_run_id": last_id}


def plan_tick(runs, open_episodes, now):
    """Решения одного тика. runs — прогоны за 7 дней, open_episodes — status <> 'closed'."""
    runs = [r for r in runs
            if r["run_kind"] not in IGNORED_KINDS and not r["collector"].startswith(SELF_PREFIX)]
    eps = {(e["collector"], e["cabinet_id"]): e for e in open_episodes}
    collector_fails = [r for r in runs if not is_unit(r["collector"]) and r["status"] in FAIL]
    pairs = {}
    for r in runs:
        pairs.setdefault((r["collector"], r["cabinet_id"]), []).append(r)

    out = {"open": [], "close": [], "bump": [], "stale": []}

    def close(e):
        if e["status"] != "running":
            out["close"].append(e["id"])

    for key, rs in pairs.items():
        rs = _desc(rs)
        e = eps.get(key)
        if is_unit(key[0]):
            fails = [r for r in rs if r["status"] in FAIL and not _is_echo(r, collector_fails)]
            if not fails:
                if e:
                    close(e)
                continue
            head = fails[0]
            if e is None:
                if (len(fails) >= 2 and head["started_at"] - fails[1]["started_at"] <= UNIT_QUIET
                        and now - head["started_at"] < UNIT_QUIET):
                    out["open"].append(_new(key, fails[1]["started_at"], head["id"]))
            elif now - head["started_at"] >= UNIT_QUIET:
                close(e)
            elif head["id"] != e["last_failed_run_id"]:
                out["bump"].append((e["id"], head["id"]))
            continue

        counted = [r for r in rs if r["status"] in COUNTED]
        if not counted:
            continue
        head = counted[0]
        if e is not None:
            if head["status"] == "ok":
                close(e)
            elif head["status"] in FAIL and head["id"] != e["last_failed_run_id"]:
                out["bump"].append((e["id"], head["id"]))
            continue
        if len(counted) >= 2 and counted[0]["status"] in FAIL and counted[1]["status"] in FAIL:
            start = head
            for r in counted:
                if r["status"] not in FAIL:
                    break
                start = r
            out["open"].append(_new(key, start["started_at"], head["id"]))

    for key, e in eps.items():
        if key not in pairs:
            close(e)
        if e["status"] == "running" and e.get("started_at") and now - e["started_at"] > STALE:
            out["stale"].append(e["id"])
    return out


def pick_next(open_episodes, started_24h):
    """Следующий эпизод к разбору: самый старый queued, если нет running и лимит не выбран."""
    if any(e["status"] == "running" for e in open_episodes):
        return None
    if started_24h >= DAILY_LIMIT:
        return None
    queued = [e for e in open_episodes if e["status"] == "queued"]
    if not queued:
        return None
    return min(queued, key=lambda e: (e["opened_at"], e["id"]))["id"]


def validate_report(rep):
    if not isinstance(rep, dict):
        return None, "отчёт не объект"
    for k, t in REQUIRED.items():
        if not isinstance(rep.get(k), t):
            return None, f"поле {k}: ожидался {t.__name__}"
    if rep["cause"] not in CAUSES:
        return None, f"cause вне перечня: {rep['cause']}"
    if rep["confidence"] not in CONFIDENCE:
        return None, f"confidence вне перечня: {rep['confidence']}"
    return rep, None


def parse_claude_output(stdout, returncode):
    """(отчёт, None) либо (None, причина ошибки)."""
    if returncode != 0:
        return None, f"claude завершился с кодом {returncode}"
    try:
        env = json.loads(stdout)
    except ValueError as e:
        return None, f"ответ не JSON: {e}"
    if not isinstance(env, dict):
        return None, "конверт ответа не объект"
    if env.get("is_error"):
        return None, f"claude is_error: {str(env.get('result'))[:300]}"
    rep = env.get(STRUCTURED_KEY)
    if rep is None:
        try:
            rep = json.loads(env.get("result") or "")
        except ValueError:
            return None, f"нет {STRUCTURED_KEY}, а result не JSON"
    return validate_report(rep)


_HDR = re.compile(r"^=== SaaS \S+ \[[^\]]*\] \w{3} (\w{3}) +(\d+) (\d\d:\d\d:\d\d) \S+ (\d{4})")


def _hdr_time(line):
    mt = _HDR.match(line)
    if not mt:
        return None
    try:
        return datetime.strptime(f"{mt[1]} {mt[2]} {mt[3]} {mt[4]}", "%b %d %H:%M:%S %Y")
    except ValueError:
        return None


def slice_worker_log(text, collector, at_msk, max_lines=200):
    """Строки сборщика из блока прогона saas_worker.log, начавшегося последним до at_msk.
    Строка с [collector] + 3 следующих (трейсбек). at_msk — naive MSK (как `date` в логе)."""
    blocks, cur = [], None
    for line in text.splitlines():
        t = _hdr_time(line)
        if t is not None:
            cur = (t, [])
            blocks.append(cur)
        elif cur is not None:
            cur[1].append(line)
    cand = [b for b in blocks if b[0] <= at_msk + timedelta(minutes=1)]
    if not cand:
        return ""
    lines = cand[-1][1]
    tag = f"[{collector}]"
    keep = set()
    for i, line in enumerate(lines):
        if tag in line:
            keep.update(range(i, min(i + 4, len(lines))))
    out = [lines[i] for i in sorted(keep) if not _hdr_time(lines[i])]
    return "\n".join(out[-max_lines:])


def build_prompt(template, ctx):
    out = template
    for k, v in ctx.items():
        out = out.replace("{{" + k + "}}", v)
    return out
```

- [ ] **Step 4: Прогнать селф-тест**

Run: `cd /opt/agents/saas && $PY worker/triage_core_selftest.py`
Expected: все строки `PASS`, `Итого провалов: 0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add worker/triage_core.py worker/triage_core_selftest.py
git commit -m "feat(triage): чистое ядро — эпизоды, выбор, разбор ответа, нарезка лога"
```

---

### Task 4: Промпт и оболочка `worker/failure_triage.py`

**Files:**
- Create: `worker/triage_prompt.md`
- Create: `worker/failure_triage.py`

**Interfaces:**
- Consumes: всё из `worker/triage_core.py` (Task 3), `worker/triage_schema.json` (Task 1), таблица Task 2.
- Produces: CLI `python -m worker.failure_triage [--dry-run] [--episode ID]`; exit 0 всегда, кроме ошибки подключения к БД. Вызывает `node scripts/notify-triage.mjs` (Task 5) в конце тика, если файл существует.

- [ ] **Step 1: Шаблон промпта**

`worker/triage_prompt.md`:
```markdown
Ты разбираешь падение сборщика данных SaaS-панели WB/Ozon (репозиторий /opt/agents/saas,
карта проекта — AGENTS.md). Режим — ТОЛЬКО ДИАГНОЗ: ничего не меняй, не пиши файлы,
не перезапускай юниты. Чинить будет человек по твоему отчёту.

## Эпизод #{{episode_id}}
- Сборщик: {{collector}}
- Кабинет: {{cabinet}}
- Падает с: {{opened_at}} (2+ падений подряд, последнего успешного прогона после — нет)

## Последние прогоны (jobs.collector_runs, новые сверху)
{{runs}}

## Лог последнего упавшего прогона
{{log}}

## Код
Файл сборщика: {{source}}
Недавние коммиты по нему:
{{git_log}}

## Как работать
1. Найди первопричину и докажи её: строки лога, `файл:строка` кода, результат SQL.
2. Сначала проверь частые классы: маркетплейс отключил/сменил метод (404/400 «obsolete»,
   «deprecated» — смотри тело ответа и release-notes dev.wildberries.ru / docs.ozon.ru);
   429; сломанные ключи (401/403); наш баг; аномалия данных; инфраструктура.
3. БД — только чтением: `psql -h localhost -U saas_ro -d saas -Atc "<SQL>"` (ровно в такой
   форме, другие роли недоступны). Таблицы клиентов — в схеме `tenant.*`.
4. Оцени последствия для данных: какие кабинеты и даты остались без данных, нужен ли бэкфилл,
   что видит клиент в панели. `urgent=true` — только если прямо сейчас теряются или искажаются
   финансовые данные клиента.
5. Предложи конкретный фикс: какой файл, что поменять, как проверить.
6. Не выводи токены, ключи, пароли, email клиентов.

Ответ — строго по JSON-схеме.
```

- [ ] **Step 2: Оболочка**

`worker/failure_triage.py`:
```python
"""
failure_triage.py — тик сторожа авторазбора падений (таймер saas-triage, каждые 15 мин).
Спека docs/superpowers/specs/2026-09-30-failure-triage-design.md.

  python -m worker.failure_triage             # обычный тик
  python -m worker.failure_triage --dry-run   # план тика и выбранный эпизод, без записи и без claude
  python -m worker.failure_triage --episode N # разобрать конкретный queued-эпизод (лимиты не проверяются)

Решения — worker/triage_core.py (чистое ядро). Здесь только I/O: PG под postgres
(как worker/record_failure.py), сбор контекста, subprocess claude, вызов писем.
Разбор — только диагноз: claude запускается с инструментами на чтение и БД под saas_ro.
"""
import argparse
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from worker import triage_core as core

REPO = Path(__file__).resolve().parent.parent
PROMPT = REPO / "worker" / "triage_prompt.md"
SCHEMA = REPO / "worker" / "triage_schema.json"
NOTIFY = REPO / "scripts" / "notify-triage.mjs"
WORKER_LOG = Path("/opt/agentsDB/logs/saas_worker.log")
LOG_TAIL_BYTES = 4 * 1024 * 1024
MSK = ZoneInfo("Europe/Moscow")
CLAUDE = os.environ.get("SAAS_TRIAGE_CLAUDE", "/usr/bin/claude")
MODEL = os.environ.get("SAAS_TRIAGE_MODEL", "sonnet")
TIMEOUT = int(os.environ.get("SAAS_TRIAGE_TIMEOUT_SEC", "1200"))
ALLOWED = ["Read", "Grep", "Glob", "WebFetch", "WebSearch",
           "Bash(psql -h localhost -U saas_ro:*)", "Bash(journalctl:*)",
           "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)",
           "Bash(grep:*)", "Bash(tail:*)", "Bash(head:*)", "Bash(wc:*)", "Bash(ls:*)"]
DISALLOWED = ["Edit", "Write", "NotebookEdit", "Agent",
              "Read(/root/.pgpass*)", "Read(/opt/agents/saas/.env.local)",
              "Read(/etc/saas-worker.env)", "Read(/etc/collectors.env)"]

RUNS_SQL = """SELECT id, collector, cabinet_id, run_kind, status, started_at
                FROM jobs.collector_runs WHERE started_at > now() - interval '7 days'"""
OPEN_SQL = """SELECT id, collector, cabinet_id, status, opened_at, started_at, last_failed_run_id
                FROM jobs.failure_triage WHERE status <> 'closed'"""


def log(msg):
    print(f"[triage] {msg}", flush=True)


def connect():
    return psycopg.connect(
        host=os.environ.get("SAAS_DB_HOST", "localhost"),
        port=os.environ.get("SAAS_DB_PORT", "5432"),
        dbname=os.environ.get("SAAS_DB", "saas"),
        user="postgres",
        password=os.environ.get("POSTGRES_PASSWORD", ""),
        row_factory=dict_row)


def apply_plan(conn, plan):
    for o in plan["open"]:
        conn.execute(
            "INSERT INTO jobs.failure_triage (collector, cabinet_id, status, opened_at, last_failed_run_id) "
            "VALUES (%s, %s, 'queued', %s, %s) "
            "ON CONFLICT (collector, (COALESCE(cabinet_id, 0))) WHERE status <> 'closed' DO NOTHING",
            (o["collector"], o["cabinet_id"], o["opened_at"], o["last_failed_run_id"]))
    if plan["close"]:
        conn.execute("UPDATE jobs.failure_triage SET status = 'closed', closed_at = now() "
                     "WHERE id = ANY(%s) AND status <> 'running'", (plan["close"],))
    for ep_id, run_id in plan["bump"]:
        conn.execute("UPDATE jobs.failure_triage SET last_failed_run_id = %s WHERE id = %s", (run_id, ep_id))
    if plan["stale"]:
        conn.execute("UPDATE jobs.failure_triage SET status = 'error', finished_at = now(), "
                     "raw_output = 'разбор прерван: running дольше 30 мин' "
                     "WHERE id = ANY(%s) AND status = 'running'", (plan["stale"],))


def _sh(cmd, timeout=30):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=REPO)
        return (p.stdout or p.stderr).strip()
    except Exception as e:  # контекст необязателен — разбор идёт и без него
        log(f"контекст: {cmd[0]} не отработал: {e}")
        return ""


def _worker_log_tail():
    try:
        with WORKER_LOG.open("rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - LOG_TAIL_BYTES))
            return f.read().decode("utf-8", "replace")
    except OSError as e:
        log(f"лог воркера не прочитан: {e}")
        return ""


def build_context(conn, ep):
    runs = conn.execute(
        "SELECT started_at, run_kind, status, rows_written, left(error, 2000) AS error "
        "FROM jobs.collector_runs WHERE collector = %s AND cabinet_id IS NOT DISTINCT FROM %s "
        "ORDER BY started_at DESC LIMIT 10", (ep["collector"], ep["cabinet_id"])).fetchall()
    runs_txt = "\n".join(
        f"- {r['started_at'].astimezone(MSK):%Y-%m-%d %H:%M} MSK [{r['run_kind']}] {r['status']}"
        f" rows={r['rows_written']}" + (f"\n  error: {r['error']}" if r["error"] else "")
        for r in runs) or "(нет)"
    last = conn.execute("SELECT run_kind, started_at FROM jobs.collector_runs WHERE id = %s",
                        (ep["last_failed_run_id"],)).fetchone()
    at = (last["started_at"] if last else ep["opened_at"])
    since = (at - timedelta(minutes=5)).astimezone(MSK).strftime("%Y-%m-%d %H:%M:%S")
    until = (at + timedelta(minutes=70)).astimezone(MSK).strftime("%Y-%m-%d %H:%M:%S")
    if core.is_unit(ep["collector"]):
        unit = ep["collector"][len("unit:"):]
        log_txt = _sh(["journalctl", "-u", unit, "--since", since, "--until", until, "--no-pager", "-n", "200"])
    else:
        log_txt = core.slice_worker_log(_worker_log_tail(), ep["collector"],
                                        at.astimezone(MSK).replace(tzinfo=None))
        if not log_txt and last and last["run_kind"] in core.KIND_UNIT:
            log_txt = _sh(["journalctl", "-u", core.KIND_UNIT[last["run_kind"]], "--since", since,
                           "--until", until, "--no-pager", "-n", "200"])
    src = REPO / "worker" / "collectors" / f"{ep['collector']}.py"
    source = str(src.relative_to(REPO)) if src.exists() else "(не найден — определи по AGENTS.md)"
    git_log = _sh(["git", "log", "--oneline", "-15", "--", source]) if src.exists() else "(нет)"
    return {
        "episode_id": str(ep["id"]),
        "collector": ep["collector"],
        "cabinet": "сервер (юнит systemd)" if ep["cabinet_id"] is None else f"#{ep['cabinet_id']}",
        "opened_at": f"{ep['opened_at'].astimezone(MSK):%Y-%m-%d %H:%M} MSK",
        "runs": runs_txt,
        "log": log_txt or "(строк не найдено)",
        "source": source,
        "git_log": git_log or "(нет)",
    }


def run_claude(prompt):
    cmd = [CLAUDE, "-p", "--model", MODEL, "--output-format", "json",
           "--json-schema", SCHEMA.read_text(),
           "--setting-sources", "user", "--permission-mode", "default",
           "--allowedTools", *ALLOWED, "--disallowedTools", *DISALLOWED]
    env = {k: v for k, v in os.environ.items()
           if k not in ("POSTGRES_PASSWORD", "SAAS_APP_DB_PASSWORD", "SAAS_CRED_MASTER_KEY")}
    try:
        p = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                           timeout=TIMEOUT, cwd=REPO, env=env)
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return None, f"таймаут {TIMEOUT} с", out
    rep, err = core.parse_claude_output(p.stdout, p.returncode)
    return rep, err, f"{p.stdout}\n--- stderr ---\n{p.stderr}"


def triage(ep):
    with connect() as conn:
        ctx = build_context(conn, ep)
    prompt = core.build_prompt(PROMPT.read_text(), ctx)
    log(f"разбор эпизода #{ep['id']} {ep['collector']} каб={ep['cabinet_id']}")
    rep, err, raw = run_claude(prompt)
    with connect() as conn:
        if rep:
            conn.execute(
                "UPDATE jobs.failure_triage SET status = 'done', finished_at = now(), summary = %s, "
                "cause = %s, confidence = %s, urgent = %s, report_json = %s, raw_output = NULL "
                "WHERE id = %s AND status = 'running'",
                (rep["summary"], rep["cause"], rep["confidence"], rep["urgent"], Jsonb(rep), ep["id"]))
            log(f"#{ep['id']} готов: {rep['cause']} ({rep['confidence']})")
        else:
            conn.execute(
                "UPDATE jobs.failure_triage SET status = 'error', finished_at = now(), raw_output = %s "
                "WHERE id = %s AND status = 'running'",
                (f"{err}\n\n{raw}"[:20000], ep["id"]))
            log(f"#{ep['id']} разбор не удался: {err}")


def notify():
    if not NOTIFY.exists():
        return
    try:
        p = subprocess.run(["/usr/bin/node", str(NOTIFY)], capture_output=True, text=True, timeout=120, cwd=REPO)
        if p.stdout.strip():
            log(p.stdout.strip())
        if p.returncode != 0:
            log(f"письма: exit {p.returncode}: {p.stderr.strip()[:500]}")
    except Exception as e:
        log(f"письма не отправлены: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--episode", type=int)
    a = ap.parse_args()
    if os.environ.get("SAAS_TRIAGE_ENABLED", "1") == "0":
        log("выключен (SAAS_TRIAGE_ENABLED=0)")
        return 0
    now = datetime.now(timezone.utc)
    claimed = None
    with connect() as conn:
        plan = core.plan_tick(conn.execute(RUNS_SQL).fetchall(), conn.execute(OPEN_SQL).fetchall(), now)
        log(f"план: открыть {len(plan['open'])}, закрыть {len(plan['close'])}, "
            f"обновить {len(plan['bump'])}, зависших {len(plan['stale'])}")
        if a.dry_run:
            for o in plan["open"]:
                log(f"  открыть: {o['collector']} каб={o['cabinet_id']} с {o['opened_at']}")
            conn.rollback()
            return 0
        apply_plan(conn, plan)
        conn.commit()
        if a.episode:
            ep_id = a.episode
        else:
            started = conn.execute("SELECT count(*) AS n FROM jobs.failure_triage "
                                   "WHERE started_at > now() - interval '24 hours'").fetchone()["n"]
            ep_id = core.pick_next(conn.execute(OPEN_SQL).fetchall(), started)
        if ep_id:
            claimed = conn.execute(
                "UPDATE jobs.failure_triage SET status = 'running', started_at = now() "
                "WHERE id = %s AND status = 'queued' RETURNING *", (ep_id,)).fetchone()
            conn.commit()
    if claimed:
        triage(claimed)
    notify()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Проверить, что модуль собирается и dry-run видит хронические эпизоды**

```bash
cd /opt/agents/saas
$PY -m py_compile worker/failure_triage.py && echo compiled
set -a; . /etc/saas-worker.env; set +a
$PY -m worker.failure_triage --dry-run
```
Expected: `compiled`; `[triage] план: открыть N, …` с N ≥ 3 и строками `открыть: ozon_finance каб=1 …`, `открыть: ozon_finance каб=1008 …`. Записи в БД нет:
`psql -h localhost -U saas_ro -d saas -Atc "select count(*) from jobs.failure_triage"` → `0`.

- [ ] **Step 4: Боевой прогон на одном эпизоде каб. 1**

Открыть эпизоды и разобрать только `ozon_finance` каб. 1 (живая приёмка из спеки §8). Таймер
ещё не включён, писем ещё нет (`scripts/notify-triage.mjs` — Task 5), поэтому сначала выставляем
лимит так, чтобы тик сам ничего не взял:
```bash
cd /opt/agents/saas; set -a; . /etc/saas-worker.env; set +a
SAAS_TRIAGE_ENABLED=1 $PY - <<'EOF'
from worker import failure_triage as t, triage_core as core
core.DAILY_LIMIT = 0          # только открыть эпизоды, без разбора
t.notify = lambda: None
t.main()
EOF
ID=$(psql -h localhost -U saas_ro -d saas -Atc "select id from jobs.failure_triage where collector='ozon_finance' and cabinet_id=1 and status='queued'")
echo "episode=$ID"
time $PY -m worker.failure_triage --episode "$ID"
psql -h localhost -U saas_ro -d saas -Atc "select id,status,cause,confidence,urgent,summary from jobs.failure_triage where id=$ID"
```
Expected: `status=done`, `cause` и `summary` заполнены (ожидаемо `mp_method_changed`: в логе
`404 … /v3/finance/transaction/list`), время < 20 мин. При `status=error` — прочитать
`raw_output`, исправить причину, вернуть эпизод в `queued`
(`PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -c "update jobs.failure_triage set status='queued', started_at=null, finished_at=null, raw_output=null where id=$ID"`)
и повторить.

- [ ] **Step 5: Commit**

```bash
git add worker/triage_prompt.md worker/failure_triage.py
git commit -m "feat(triage): оболочка тика — эпизоды в БД, контекст, запуск claude -p только на чтение"
```

---

### Task 5: Письмо — `lib/triageMail.js` + `scripts/notify-triage.mjs`

**Files:**
- Create: `lib/triageMail.js`
- Test: `lib/__tests__/triageMail.test.mjs`
- Create: `scripts/notify-triage.mjs`

**Interfaces:**
- Consumes: строки `jobs.failure_triage` (+ `last_error` из `collector_runs`), `sendMail({to, subject, text})` из `lib/mailer.js`, `query(sql, params)` из `lib/db.js`.
- Produces: `formatTriageMail(ep, base) -> {subject: string, text: string}`; скрипт печатает `notify-triage: отправлено N` и ставит `notified_at`.

- [ ] **Step 1: Тест (падающий)**

`lib/__tests__/triageMail.test.mjs`:
```js
// lib/__tests__/triageMail.test.mjs — письмо авторазбора падений
// (спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §6).
import test from "node:test";
import assert from "node:assert/strict";
import { formatTriageMail } from "../triageMail.js";

const BASE = "https://sysell.ru";
const done = {
  id: 12, collector: "ozon_finance", cabinet_id: 1, status: "done",
  opened_at: "2026-09-08T09:00:00Z",
  report_json: {
    summary: "Ozon отключил /v3/finance/transaction/list (404).", cause: "mp_method_changed",
    confidence: "high", evidence: ["лог: 404"], proposed_fix: "перейти на /v4",
    data_impact: "каб. 1 и 1008 без транзакций с 08.09", urgent: false,
  },
};

test("тема разобранного эпизода: сборщик, кабинет, причина, уверенность", () => {
  const m = formatTriageMail(done, BASE);
  assert.equal(m.subject, "[разбор] ozon_finance · каб. 1 — mp_method_changed (high)");
  assert.match(m.text, /отключил/);
  assert.match(m.text, /перейти на \/v4/);
  assert.match(m.text, /без транзакций с 08\.09/);
  assert.match(m.text, /https:\/\/sysell\.ru\/health#triage-12/);
});

test("срочный — префикс 🔴", () => {
  const m = formatTriageMail({ ...done, report_json: { ...done.report_json, urgent: true } }, BASE);
  assert.ok(m.subject.startsWith("🔴 [разбор]"));
});

test("юнит без кабинета — «сервер»", () => {
  const m = formatTriageMail({ ...done, collector: "unit:saas-stocks.service", cabinet_id: null }, BASE);
  assert.match(m.subject, /unit:saas-stocks\.service · сервер/);
});

test("разбор не удался — своя тема и последняя ошибка прогона", () => {
  const m = formatTriageMail({ id: 5, collector: "wb_finance", cabinet_id: 1, status: "error",
    opened_at: "2026-09-24T00:00:00Z", report_json: null, last_error: "HTTP 404 boom",
    raw_output: "таймаут 1200 с\n..." }, BASE);
  assert.equal(m.subject, "[разбор не удался] wb_finance · каб. 1");
  assert.match(m.text, /HTTP 404 boom/);
  assert.match(m.text, /таймаут 1200 с/);
});

test("починившийся после разбора — пометка в теме", () => {
  const m = formatTriageMail({ ...done, status: "closed", closed_at: "2026-10-01T10:00:00Z" }, BASE);
  assert.match(m.subject, /уже починилось/);
});
```

Run: `cd /opt/agents/saas && node --test lib/__tests__/triageMail.test.mjs`
Expected: FAIL — `Cannot find module '../triageMail.js'`.

- [ ] **Step 2: Форматирование**

`lib/triageMail.js`:
```js
// lib/triageMail.js — текст письма авторазбора падений (спека
// docs/superpowers/specs/2026-09-30-failure-triage-design.md §6). Чистая функция:
// отправка и выборка — scripts/notify-triage.mjs.

const fmtDate = (v) => (v ? new Date(v).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "—");

export function formatTriageMail(ep, base) {
  const where = ep.cabinet_id == null ? "сервер" : `каб. ${ep.cabinet_id}`;
  const link = `${base}/health#triage-${ep.id}`;
  const r = ep.report_json;
  if (!r) {
    return {
      subject: `[разбор не удался] ${ep.collector} · ${where}`,
      text: [
        `Сборщик ${ep.collector} (${where}) падает с ${fmtDate(ep.opened_at)}, автоматический разбор не удался.`,
        "",
        `Последняя ошибка прогона: ${ep.last_error || "—"}`,
        `Почему не удался разбор: ${String(ep.raw_output || "—").split("\n")[0]}`,
        "",
        "Нужно посмотреть вручную.",
        link,
      ].join("\n"),
    };
  }
  const fixed = ep.status === "closed" ? " — уже починилось" : "";
  return {
    subject: `${r.urgent ? "🔴 " : ""}[разбор] ${ep.collector} · ${where} — ${r.cause} (${r.confidence})${fixed}`,
    text: [
      `Сборщик ${ep.collector} (${where}) падает с ${fmtDate(ep.opened_at)}.`,
      fixed ? `Пока шёл разбор, сборщик снова отработал успешно (${fmtDate(ep.closed_at)}).` : "",
      "",
      `Итог: ${r.summary}`,
      "",
      `Предлагаемый фикс: ${r.proposed_fix}`,
      "",
      `Последствия для данных: ${r.data_impact}`,
      "",
      `Подробно (доказательства): ${link}`,
    ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
  };
}
```

- [ ] **Step 3: Тест зелёный**

Run: `cd /opt/agents/saas && node --test lib/__tests__/triageMail.test.mjs`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 4: Скрипт отправки**

`scripts/notify-triage.mjs`:
```js
#!/usr/bin/env node
// scripts/notify-triage.mjs — письма владельцу сервиса о разобранных падениях сборщиков
// (спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §6). Вызывается
// worker/failure_triage.py в конце каждого тика. Одно письмо на эпизод: notified_at
// ставится только после успешной отправки, сбой SMTP — повтор на следующем тике.
// Получатели — SAAS_OPS_USER_IDS (те же, кому открыт /health).
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { query } = await import('../lib/db.js');
const { sendMail } = await import('../lib/mailer.js');
const { formatTriageMail } = await import('../lib/triageMail.js');

const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
const ids = (process.env.SAAS_OPS_USER_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

const to = ids.length
  ? (await query('SELECT email FROM auth.users WHERE user_id = ANY($1::bigint[]) AND email IS NOT NULL', [ids]))
      .map((u) => u.email)
  : [];
if (!to.length) {
  console.error('notify-triage: нет получателей (SAAS_OPS_USER_IDS пуст или без email)');
  process.exit(1);
}

const eps = await query(
  `SELECT t.*, r.error AS last_error
     FROM jobs.failure_triage t
     LEFT JOIN jobs.collector_runs r ON r.id = t.last_failed_run_id
    WHERE t.notified_at IS NULL
      AND (t.status IN ('done','error') OR (t.status = 'closed' AND t.finished_at IS NOT NULL))
    ORDER BY t.id`
);

let sent = 0;
for (const ep of eps) {
  const { subject, text } = formatTriageMail(ep, base);
  try {
    for (const addr of to) await sendMail({ to: addr, subject, text });
    await query('UPDATE jobs.failure_triage SET notified_at = now() WHERE id = $1', [ep.id]);
    sent++;
  } catch (e) {
    console.error(`notify-triage: эпизод #${ep.id} не отправлен:`, e);
  }
}
console.log(`notify-triage: отправлено ${sent} из ${eps.length}`);
process.exit(0);
```

- [ ] **Step 5: Живая отправка по эпизоду из Task 4**

```bash
cd /opt/agents/saas && node scripts/notify-triage.mjs
psql -h localhost -U saas_ro -d saas -Atc "select id, notified_at is not null from jobs.failure_triage where status in ('done','error')"
```
Expected: `notify-triage: отправлено 1 из 1`; у эпизода `t`. Письмо пришло владельцу —
подтвердить у владельца.

- [ ] **Step 6: Commit**

```bash
git add lib/triageMail.js lib/__tests__/triageMail.test.mjs scripts/notify-triage.mjs
git commit -m "feat(triage): письмо владельцу о разборе падения"
```

---

### Task 6: Блок «Разборы падений» на `/health`

**Files:**
- Modify: `app/api/health/route.js` (запрос перед `return`, ключ `triage` в ответе)
- Modify: `app/health/HealthPage.jsx` (блок после «Кабинет Ozon: сессия истекла»)

**Interfaces:**
- Consumes: таблица Task 2 (грант `SELECT` для `saas_app`).
- Produces: `GET /api/health` → `triage: [{id, collector, cabinet_id, status, opened_at, closed_at, started_at, finished_at, summary, cause, confidence, urgent, report_json, raw_output}]` (`raw_output` ≤ 5000 симв.).

- [ ] **Step 1: Бэкапы**

```bash
TS=$(date +%Y%m%d_%H%M%S)
cp app/api/health/route.js /opt/agentsDB/backups/health.route.js.$TS.bak
cp app/health/HealthPage.jsx /opt/agentsDB/backups/HealthPage.jsx.$TS.bak
```

- [ ] **Step 2: API**

В `app/api/health/route.js` перед `return NextResponse.json({` добавить:
```js
  // Авторазбор падений (worker/failure_triage.py, спека 2026-09-30-failure-triage-design.md §7).
  const triage = await query(
    `SELECT id, collector, cabinet_id, status, opened_at, closed_at, started_at, finished_at,
            summary, cause, confidence, urgent, report_json, left(raw_output, 5000) AS raw_output
       FROM jobs.failure_triage
      ORDER BY opened_at DESC
      LIMIT 30`
  );
```
и в объект ответа после `cabinets_expired: cabinetsExpired,` — строку `triage,`.

- [ ] **Step 3: Страница**

В `app/health/HealthPage.jsx` над `export default function HealthPage()` добавить:
```jsx
const TRIAGE_STATUS = {
  queued: "в очереди", running: "разбирается", done: "разобрано",
  error: "разбор не удался", closed: "закрыт",
};
```
сразу после существующего `useEffect` с `fetch("/api/health")` (ДО ранних `return` — правило D7) — эффект для ссылки из письма:
```jsx
  // Ссылка из письма /health#triage-<id> — раскрыть эпизод и прокрутить к нему.
  useEffect(() => {
    if (!data || !window.location.hash.startsWith("#triage-")) return;
    const el = document.getElementById(window.location.hash.slice(1));
    if (el) { el.open = true; el.scrollIntoView(); }
  }, [data]);
```
и перед последним `</div>` (закрывающим корневой контейнер страницы) — блок:
```jsx
      {Array.isArray(data.triage) && data.triage.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16, margin: "24px 0 8px" }}>Разборы падений ({data.triage.length})</h2>
          <div style={{ fontSize: 13 }}>
            {data.triage.map((t) => {
              const r = t.report_json;
              const fixed = t.status === "closed" && t.finished_at;
              return (
                <details key={t.id} id={`triage-${t.id}`}
                         style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                  <summary style={{ cursor: "pointer" }}>
                    {r?.urgent ? "🔴 " : ""}{t.collector} · {t.cabinet_id == null ? "сервер" : `#${t.cabinet_id}`} ·
                    с {new Date(t.opened_at).toLocaleDateString("ru-RU")} ·{" "}
                    {fixed ? "✓ починилось" : TRIAGE_STATUS[t.status] || t.status}
                    {t.cause ? ` · ${t.cause} (${t.confidence})` : ""}
                    {t.summary ? ` — ${t.summary}` : ""}
                  </summary>
                  {r ? (
                    <div style={{ padding: "8px 0 4px 16px", color: "#a1a1aa", whiteSpace: "pre-wrap" }}>
                      <div><b>Доказательства:</b></div>
                      <ul style={{ margin: "4px 0 8px 16px" }}>
                        {(r.evidence || []).map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                      <div><b>Фикс:</b> {r.proposed_fix}</div>
                      <div style={{ marginTop: 6 }}><b>Данные:</b> {r.data_impact}</div>
                    </div>
                  ) : t.raw_output ? (
                    <pre style={{ padding: "8px 0 4px 16px", color: "#a1a1aa", whiteSpace: "pre-wrap" }}>
                      {t.raw_output}
                    </pre>
                  ) : null}
                </details>
              );
            })}
          </div>
        </div>
      )}
```

- [ ] **Step 4: Сборка и рестарт**

```bash
cd /opt/agents/saas && npm run build 2>&1 | tail -5 && systemctl restart saas-web && sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3200/
```
Expected: сборка без ошибок, `200`. `curl -s http://localhost:3200/api/health` без сессии → `401` (доступ не расширился).

- [ ] **Step 5: Визуальная проверка — владельцем**

Попросить владельца открыть `/health`: внизу блок «Разборы падений» с эпизодом из Task 4;
клик раскрывает доказательства/фикс/данные; ссылка из письма `/health#triage-<id>` открывает
страницу с уже раскрытым эпизодом.

- [ ] **Step 6: Commit**

```bash
git add app/api/health/route.js app/health/HealthPage.jsx
git commit -m "feat(triage): блок «Разборы падений» на /health"
```

---

### Task 7: Таймер, включение, документация

**Files:**
- Create: `deploy/systemd/saas-triage.service`, `deploy/systemd/saas-triage.timer`
- Modify: `AGENTS.md` (подраздел в «Сбор данных», строка в «Боевое расписание», строка в TL;DR)

**Interfaces:**
- Consumes: `python -m worker.failure_triage` (Task 4), `scripts/notify-triage.mjs` (Task 5).

- [ ] **Step 1: Юниты**

`deploy/systemd/saas-triage.service`:
```ini
[Unit]
Description=SAAS — авторазбор падений сборщиков (claude -p, только диагноз)
After=network.target postgresql.service
OnFailure=saas-failure@%n.service

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/opt/agents/saas
# POSTGRES_PASSWORD для записи jobs.failure_triage; SAAS_TRIAGE_ENABLED=0 — выключатель.
EnvironmentFile=/etc/saas-worker.env
# HOME — там авторизация claude; TZ — время в промпте и письме.
Environment=HOME=/root TZ=Europe/Moscow SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas
# Один тик за раз; занято — тихий выход (разбор до 20 мин длиннее шага таймера).
ExecStart=/usr/bin/flock -n -E 0 /run/lock/saas-triage.lock /opt/agents/data-presenter-agent/.venv/bin/python -m worker.failure_triage
# 20 мин разбор + контекст + письма, с запасом.
TimeoutStartSec=30min
StandardOutput=journal
StandardError=journal
SyslogIdentifier=saas-triage
```

`deploy/systemd/saas-triage.timer`:
```ini
[Unit]
Description=SAAS — авторазбор падений каждые 15 минут

[Timer]
OnCalendar=*:0/15
AccuracySec=1min

[Install]
WantedBy=timers.target
```

- [ ] **Step 2: Установить и включить**

```bash
cd /opt/agents/saas && deploy/install-systemd.sh
systemctl enable --now saas-triage.timer
systemctl start saas-triage.service; journalctl -u saas-triage -n 30 --no-pager
systemctl list-timers 'saas-triage*' --no-pager
```
Expected: в журнале `[triage] план: …`; после лимита 3/сутки остальные хронические эпизоды
стоят в `queued`; таймер `active`, следующий запуск ≤ 15 мин.

- [ ] **Step 3: Проверка выключателя**

```bash
cd /opt/agents/saas; set -a; . /etc/saas-worker.env; set +a
SAAS_TRIAGE_ENABLED=0 $PY -m worker.failure_triage
```
Expected: `[triage] выключен (SAAS_TRIAGE_ENABLED=0)`, exit 0.

- [ ] **Step 4: AGENTS.md**

Бэкап: `cp AGENTS.md /opt/agentsDB/backups/AGENTS.md.$(date +%Y%m%d_%H%M%S).bak`.

В TL;DR-таблицу после строки «Здоровье данных» — строка:
```markdown
| Авторазбор падений сборщиков | jobs.failure_triage + worker/failure_triage.py (таймер saas-triage, claude -p только чтение) |
```
В «Боевое расписание» — строка:
```markdown
| `saas-triage` | каждые 15 мин | авторазбор падений: 2 failed подряд → `claude -p` (Sonnet, только чтение) → письмо + `/health` (≤3 разбора/сутки) |
```
В «Сбор данных» после абзаца «Сломанные ключи магазина» — абзац:
```markdown
**Авторазбор падений (с 2026-10-01).** Таймер `saas-triage` (15 мин) открывает эпизод в
`jobs.failure_triage` после 2 падений подряд (`failed`/`timeout`) у пары «сборщик × кабинет»
и молчит до `ok`; эхо `unit:*` (упал сборщик того же юнита) не учитывается, `manual` — тоже.
Разбор — `claude -p --model sonnet` с инструментами только на чтение (БД под `saas_ro`, без
`Edit`/`Write`), ≤3 в сутки, таймаут 20 мин; итог — письмо пользователям `SAAS_OPS_USER_IDS`
и блок «Разборы падений» на `/health`. Только диагноз — чинит человек. Выключатель
`SAAS_TRIAGE_ENABLED=0` в `/etc/saas-worker.env`. Решения тика — чистое ядро
`worker/triage_core.py` (селф-тест `worker/triage_core_selftest.py`), промпт —
`worker/triage_prompt.md`, письмо — `lib/triageMail.js`. Спека
`docs/superpowers/specs/2026-09-30-failure-triage-design.md`.
```

- [ ] **Step 5: Финальная проверка**

```bash
cd /opt/agents/saas
$PY worker/triage_core_selftest.py | tail -1
node --test lib/__tests__/triageMail.test.mjs 2>&1 | grep -E "^# (pass|fail)"
psql -h localhost -U saas_ro -d saas -Atc "select status, count(*) from jobs.failure_triage group by 1"
git status --short
```
Expected: `Итого провалов: 0`; `# pass 5`, `# fail 0`; эпизоды в `done`/`queued`; в
`git status` — только файлы этой задачи (плюс давние `down/`, `scratchpad/`).

- [ ] **Step 6: Commit**

```bash
git add deploy/systemd/saas-triage.service deploy/systemd/saas-triage.timer AGENTS.md
git commit -m "feat(triage): таймер saas-triage (15 мин) + раздел в AGENTS.md"
```

---

## Приёмка владельцем (после Task 7)

1. Письмо по `ozon_finance` каб. 1 пришло, диагноз верный и полезный (оценка точности).
2. `/health` → «Разборы падений» читается, ссылка из письма раскрывает эпизод.
3. Через 1–2 дня: хронические эпизоды разобраны, лишних писем нет (эхо, повторы).
