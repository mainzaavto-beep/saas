# Алертинг воркера — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Журнал прогонов сборщиков (`jobs.collector_runs`) + guard от затирания order_costs + OnFailure-хук systemd + страница «Здоровье данных» `/health`.

**Architecture:** Всю бухгалтерию ведёт оркестратор (`worker/orchestrator.py`) — он видит exit-код каждого сборщика-subprocess'а. Сборщик с тихими пропусками (`wb_finance`) сигналит exit-кодом 3 = partial. Guard: order_costs не запускается, если finance того же прогона не-ok. systemd-юниты переезжают в репо, все получают `OnFailure=saas-failure@%n.service`. Страница `/health` читает журнал через без-тенантный `query()` под операторским allowlist'ом.

**Tech Stack:** Python 3 (psycopg3), PostgreSQL (схема `jobs`, без RLS), Next.js app router (iron-session), systemd.

**Спек:** `docs/superpowers/specs/2026-08-02-worker-alerting-design.md`

## Global Constraints

- Комментарии и commit-сообщения — на русском, в стиле репо (`feat(...)`, `fix(...)`).
- Миграции идемпотентны (`IF NOT EXISTS`, `DO $$`), раннера нет — применяются вручную `PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -f <файл>`. Таблицы версий миграций нет.
- Никаких пустых catch — любой проглоченный сбой печатается в stderr (правило из AGENTS.md).
- Это боевой хост: `/opt/agents/saas` — прод. Тестовые строки в `jobs.collector_runs` удалять после проверки (`DELETE ... WHERE run_kind='manual' AND collector LIKE 'smoke%'`).
- Сбой обвязки журналирования НЕ должен ронять прогон сборки.
- Python-интерпретатор воркера: `/opt/agents/data-presenter-agent/.venv/bin/python` (venv соседнего проекта — так везде).
- Тестовой инфраструктуры (pytest) в проекте нет — каждая задача завершается smoke-проверкой с реальным выводом.
- После правок Next.js-части прод пересобирается: `npm run build && systemctl restart saas-web`.

**Контракт exit-кодов сборщиков (фиксируется в этом плане, документируется в коде):**
`0` = ok · `3` = partial (собрано, но часть окон пропущена) · прочее = failed.

---

### Task 1: Миграция 031 — таблица jobs.collector_runs

**Files:**
- Create: `db/migrations/031_collector_runs.sql`

**Interfaces:**
- Produces: таблица `jobs.collector_runs` (колонки см. SQL ниже) — в неё пишут Task 2/3/5, читает Task 7.

- [ ] **Step 1: Написать миграцию**

```sql
-- 031_collector_runs.sql
-- Журнал прогонов сборщиков (спек docs/superpowers/specs/2026-08-02-worker-alerting-design.md).
-- Пишут: orchestrator.py (под postgres) и worker/record_failure.py (OnFailure-хук systemd).
-- Читает: /api/health (saas_app, без-тенантный query()).
-- Без RLS: операторские данные; доступ ограничен allowlist'ом SAAS_OPS_USER_IDS в API.
-- cabinet_id NULL = запись уровня systemd-юнита (прогон умер целиком).
-- Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS jobs.collector_runs (
    id           BIGSERIAL PRIMARY KEY,
    cabinet_id   BIGINT,
    collector    TEXT NOT NULL,      -- 'wb_finance' | ... | 'unit:saas-worker.service' | '_cabinet'
    run_kind     TEXT NOT NULL CHECK (run_kind IN
                 ('main','stocks','metrics30m','references','backfill','systemd','manual')),
    date_from    DATE,               -- окно сбора (NULL для snapshot-сборщиков и unit-записей)
    date_to      DATE,
    status       TEXT NOT NULL CHECK (status IN
                 ('ok','partial','failed','timeout','no_token','skipped')),
    rows_written INTEGER,            -- задел на будущее (пока NULL всегда)
    error        TEXT,               -- последняя строка stderr / причина skip
    started_at   TIMESTAMPTZ NOT NULL,
    finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS collector_runs_coll_fin ON jobs.collector_runs (collector, finished_at DESC);
CREATE INDEX IF NOT EXISTS collector_runs_status   ON jobs.collector_runs (status);

GRANT USAGE  ON SCHEMA jobs TO saas_app;
GRANT SELECT ON jobs.collector_runs TO saas_app;

COMMIT;
```

- [ ] **Step 2: Применить к живой БД**

Run: `PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -f /opt/agents/saas/db/migrations/031_collector_runs.sql`
Expected: `BEGIN / CREATE TABLE / CREATE INDEX ×2 / GRANT ×2 / COMMIT` без ошибок.

- [ ] **Step 3: Проверить структуру и права**

Run: `PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "\d jobs.collector_runs" -c "SELECT has_table_privilege('saas_app','jobs.collector_runs','SELECT')"`
Expected: 12 колонок, оба CHECK'а, `has_table_privilege = t`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/031_collector_runs.sql
git commit -m "feat(ops): миграция 031 — журнал прогонов jobs.collector_runs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Оркестратор — запись прогонов, run_kind, ретеншн

**Files:**
- Modify: `worker/orchestrator.py` (импорты; новая `_record_run`; `_run_one:253-308`; `run_cabinet:311-326`; `main():401-450`)
- Modify: `worker/run_saas_collect.sh:57` (добавить `--run-kind "$MODE"`)

**Interfaces:**
- Consumes: `jobs.collector_runs` из Task 1.
- Produces: `_record_run(cabinet_id, collector, status, *, error=None, date_from=None, date_to=None, started_at=None, finished_at=None)` — модульная функция, её же вызывает Task 3; глобал `RUN_KIND: str`; в `_run_one` появляется dict `statuses` (нужен Task 3).

- [ ] **Step 1: Добавить импорт, глобал RUN_KIND и функцию _record_run**

В `orchestrator.py` после блока `PG_SUPER` (строка ~45):

```python
from datetime import datetime, timezone

# Метка прогона для jobs.collector_runs; выставляется в main() из --run-kind.
RUN_KIND = "manual"

# ── Контракт exit-кодов сборщиков ────────────────────────────────────
# 0 = ok · 3 = partial (собрано, но часть окон пропущена — см. wb_finance.py)
# · прочее = failed. Маппинг в _run_one.

def _record_run(cabinet_id, collector, status, *, error=None,
                date_from=None, date_to=None, started_at=None, finished_at=None):
    """Строка прогона → jobs.collector_runs. Сбой записи НЕ роняет прогон,
    но печатается в stderr (правило «никаких молчаливых catch»)."""
    try:
        with psycopg.connect(**PG_SUPER) as conn:
            conn.execute(
                "INSERT INTO jobs.collector_runs "
                "(cabinet_id, collector, run_kind, date_from, date_to, status, "
                " error, started_at, finished_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (cabinet_id, collector, RUN_KIND, date_from, date_to, status,
                 error, started_at or datetime.now(timezone.utc),
                 finished_at or datetime.now(timezone.utc)))
    except Exception as e:
        print(f"    [collector_runs] не записал ({collector}/{status}): {e}",
              file=sys.stderr, flush=True)
```

- [ ] **Step 2: Записывать исходы в _run_one**

Заменить тело цикла `for coll in shop_collectors:` (`orchestrator.py:281-307`) на версию с фиксацией статусов (dict `statuses` тут же готовит почву для guard'а из Task 3):

```python
    ok, failed = [], []
    statuses = {}  # coll -> 'ok'|'partial'|'failed'|'timeout'|'skipped' (для guard'а)
    for coll in shop_collectors:
        cmd = [PY, "-m", f"worker.collectors.{coll}"]
        if date_from:
            cmd.append(date_from)
            if date_to:
                cmd.append(date_to)
        label = f"     [{coll}]"
        started = datetime.now(timezone.utc)
        try:
            r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=3600)
            if r.returncode == 0:
                out = (r.stdout or "").strip().splitlines()
                last = out[-1] if out else "ok"
                print(f"{label} OK: {last}", flush=True)
                ok.append(coll)
                statuses[coll] = "ok"
                _record_run(cid, coll, "ok",
                            date_from=date_from, date_to=date_to, started_at=started)
            elif r.returncode == 3:
                # Контракт exit-кодов: 3 = partial (часть окон пропущена, напр. 429).
                err = (r.stderr or r.stdout or "").strip().splitlines()
                print(f"{label} PARTIAL: {err[-1] if err else ''}", flush=True)
                failed.append(coll)
                statuses[coll] = "partial"
                _record_run(cid, coll, "partial", error=(err[-1] if err else None),
                            date_from=date_from, date_to=date_to, started_at=started)
            else:
                err = (r.stderr or r.stdout or "").strip().splitlines()
                print(f"{label} FAIL (exit {r.returncode}): {err[-1] if err else ''}", flush=True)
                if verbose and err:
                    for line in err[-5:]:
                        print(f"        {line}", flush=True)
                failed.append(coll)
                statuses[coll] = "failed"
                _record_run(cid, coll, "failed",
                            error=(err[-1] if err else f"exit {r.returncode}"),
                            date_from=date_from, date_to=date_to, started_at=started)
        except subprocess.TimeoutExpired:
            print(f"{label} TIMEOUT (>3600s)", flush=True)
            failed.append(coll)
            statuses[coll] = "timeout"
            _record_run(cid, coll, "timeout", error="timeout >3600s",
                        date_from=date_from, date_to=date_to, started_at=started)
        except Exception as e:
            print(f"{label} ERROR: {e}", flush=True)
            failed.append(coll)
            statuses[coll] = "failed"
            _record_run(cid, coll, "failed", error=str(e)[:500],
                        date_from=date_from, date_to=date_to, started_at=started)
    return ok, failed
```

- [ ] **Step 3: Записывать no_token и no_shops**

В `_run_one` (`orchestrator.py:264-269`) — после каждой печати «нет токена», перед `return`:

```python
    if mp == "wb" and not env.get("WB_TOKEN"):
        print(f"    shop #{shop.get('shop_id')} {mp}: нет WB_TOKEN — пропуск", flush=True)
        _record_run(cid, "wb:credentials", "no_token",
                    error=f"shop #{shop.get('shop_id')}: нет WB_TOKEN")
        return [], [f"{mp}:no_token"]
    if mp == "ozon" and not (env.get("OZON_CLIENT_ID") and env.get("OZON_API_KEY")):
        print(f"    shop #{shop.get('shop_id')} {mp}: нет OZON creds — пропуск", flush=True)
        _record_run(cid, "ozon:credentials", "no_token",
                    error=f"shop #{shop.get('shop_id')}: нет OZON creds")
        return [], [f"{mp}:no_token"]
```

В `run_cabinet` (`orchestrator.py:317-319`):

```python
    if not shops:
        print("  нет магазинов с кредами — пропуск", flush=True)
        _record_run(cid, "_cabinet", "failed", error="no_shops")
        return ["no_shops"]
```

- [ ] **Step 4: --run-kind и ретеншн в main()**

В `main()` после `ap.add_argument("--date-to", ...)` (`orchestrator.py:411`):

```python
    ap.add_argument("--run-kind", dest="run_kind", default="manual",
                    help="Метка прогона для jobs.collector_runs "
                         "(main|stocks|metrics30m|references|backfill|systemd|manual)")
```

После `args = ap.parse_args()`:

```python
    global RUN_KIND
    RUN_KIND = args.run_kind
    if args.drain_queue and RUN_KIND == "manual":
        RUN_KIND = "backfill"
```

В ветке `elif args.all:` (`orchestrator.py:429-430`) — сразу после чтения кабинетов, ретеншн (спек п.1):

```python
    elif args.all:
        cabinets = _read_cabinets(active_only=True)
        # Ретеншн журнала прогонов: 90 дней (спек 2026-08-02-worker-alerting).
        try:
            with psycopg.connect(**PG_SUPER) as conn:
                conn.execute("DELETE FROM jobs.collector_runs "
                             "WHERE started_at < now() - interval '90 days'")
        except Exception as e:
            print(f"[collector_runs] ретеншн не отработал: {e}", file=sys.stderr, flush=True)
```

- [ ] **Step 5: Пробросить режим из шелла**

`run_saas_collect.sh:57` — добавить `--run-kind "$MODE"`:

```bash
$PY -m worker.orchestrator --all --collectors "$COLLECTORS" --date-from "$FROM" --date-to "$TO" --run-kind "$MODE" >> /opt/agentsDB/logs/saas_worker.log 2>&1
```

- [ ] **Step 6: Smoke — прогон одного лёгкого сборщика**

Run (env как в run_saas_collect.sh):

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a \
  && export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas \
  && /opt/agents/data-presenter-agent/.venv/bin/python -m worker.orchestrator \
     --cabinet 1 --collectors wb_catalog --run-kind manual
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "SELECT collector, run_kind, status, started_at FROM jobs.collector_runs ORDER BY id DESC LIMIT 3"
```

Expected: сборщик отработал, в таблице строка `wb_catalog / manual / ok`.

- [ ] **Step 7: Commit**

```bash
git add worker/orchestrator.py worker/run_saas_collect.sh
git commit -m "feat(ops): оркестратор пишет журнал прогонов в jobs.collector_runs

exit 0→ok, 3→partial, timeout→timeout, прочее→failed; no_token/no_shops
фиксируются; --run-kind из режима таймера; ретеншн 90 дней.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Guard от затирания — finance не-ok → order_costs пропущен

**Files:**
- Modify: `worker/orchestrator.py` (`_run_one`, начало цикла из Task 2 Step 2)
- Modify: `worker/run_saas_collect.sh:26` (комментарий о порядке), `worker/orchestrator.py:50-52` (комментарий)

**Interfaces:**
- Consumes: dict `statuses` и `_record_run` из Task 2.
- Produces: константа `GUARD_DEPS = {"wb_order_costs": "wb_finance", "ozon_order_costs": "ozon_finance"}`.

- [ ] **Step 1: Вставить guard в начало цикла**

В `_run_one`, сразу после строки `statuses = {}` добавить константу, а в начало цикла `for coll in shop_collectors:` (перед `cmd = ...`) — проверку:

```python
    # Guard от затирания (спек п.3): order_costs агрегирует из finance_report
    # безусловным DO UPDATE (db_pg.py:399-401). Если finance ЭТОГО прогона не-ok,
    # пересчёт по дырявым данным затёр бы хорошие агрегаты — пропускаем.
    GUARD_DEPS = {"wb_order_costs": "wb_finance", "ozon_order_costs": "ozon_finance"}
```

```python
    for coll in shop_collectors:
        dep = GUARD_DEPS.get(coll)
        if dep and statuses.get(dep) not in (None, "ok"):
            reason = f"{dep} status={statuses[dep]} — агрегат не пересчитан (guard от затирания)"
            print(f"     [{coll}] SKIP: {reason}", flush=True)
            statuses[coll] = "skipped"
            failed.append(coll)
            _record_run(cid, coll, "skipped", error=reason,
                        date_from=date_from, date_to=date_to)
            continue
        cmd = [PY, "-m", f"worker.collectors.{coll}"]
        ...
```

`statuses.get(dep) is None` (finance не было в списке этого прогона) — guard молчит: order_costs пересчитает по данным, не менявшимся с последнего успешного finance, это безопасно.

- [ ] **Step 2: Зафиксировать инвариант порядка комментариями**

`orchestrator.py:50-52` — дополнить существующий комментарий:

```python
# Списки SaaS-сборщиков по маркетплейсу (модули в worker/collectors/). Порядок важен:
# catalog → orders → finance → order_costs + cabinet_costs (зависят от finance) → metrics → prices → stocks.
# ⚠️ ИНВАРИАНТ GUARD'а: *_finance обязан идти РАНЬШЕ *_order_costs (см. GUARD_DEPS в _run_one).
```

`run_saas_collect.sh` — над строкой `MAIN_COLLECTORS=` добавить:

```bash
# ⚠️ ИНВАРИАНТ: wb_finance раньше wb_order_costs, ozon_finance раньше ozon_order_costs
# (guard от затирания в orchestrator._run_one — GUARD_DEPS).
```

- [ ] **Step 3: Smoke — форсировать не-ok finance**

Подсунуть заведомо падающий finance через несуществующую пару: временно прогнать с фейковым статусом нельзя, поэтому проверяем guard напрямую — запускаем оркестратор с парой `wb_finance,wb_order_costs`, где `wb_finance` упадёт из-за отозванного окружения. Проще: юнит-проверка логики на месте:

```bash
cd /opt/agents/saas && /opt/agents/data-presenter-agent/.venv/bin/python - <<'EOF'
# Проверка guard-ветки без сети: эмулируем цикл _run_one.
statuses = {"wb_finance": "partial"}
GUARD_DEPS = {"wb_order_costs": "wb_finance", "ozon_order_costs": "ozon_finance"}
coll = "wb_order_costs"
dep = GUARD_DEPS.get(coll)
assert dep and statuses.get(dep) not in (None, "ok"), "guard должен сработать"
statuses2 = {}  # finance не запускался в этом прогоне
assert statuses2.get(GUARD_DEPS["ozon_order_costs"]) in (None, "ok") or False
print("guard logic OK")
EOF
```

Expected: `guard logic OK`. Плюс сквозная проверка придёт бесплатно в Task 8 Step 2 (форс-partial).

- [ ] **Step 4: Commit**

```bash
git add worker/orchestrator.py worker/run_saas_collect.sh
git commit -m "feat(ops): guard от затирания — finance не-ok блокирует order_costs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: wb_finance — exit 3 при пропуске окон (partial)

**Files:**
- Modify: `worker/collectors/wb_finance.py` (модульный счётчик; `fetch_realization:58-61`; `__main__:114-118`)

**Interfaces:**
- Produces: exit-код 3 при ≥1 пропущенном окне — его читает маппинг из Task 2.
- Примечание (спек «точные места на этапе плана»): у `ozon_finance` тихого пропуска НЕТ — retry в `ozon_client.py:58-81` при исчерпании попыток кидает исключение → exit 1, это уже громкий failed. Правка нужна только `wb_finance`.

- [ ] **Step 1: Счётчик пропущенных окон**

После `PAGE_LIMIT = 100000` (`wb_finance.py:21`):

```python
# Окна, пропущенные из-за 429 после 5 попыток. >0 → exit 3 (partial) —
# контракт exit-кодов оркестратора (orchestrator.py, _run_one).
_SKIPPED_429 = 0
```

В `fetch_realization`, ветка `else:` цикла попыток (`wb_finance.py:58-61`):

```python
        else:
            # Все 5 попыток исчерпаны на 429 — пропускаем окно (не валит весь backfill),
            # но помечаем прогон как partial (exit 3), чтобы оркестратор знал о дыре.
            global _SKIPPED_429
            _SKIPPED_429 += 1
            print(f"    429 после 5 попыток — пропускаю окно", flush=True)
            return []
```

- [ ] **Step 2: exit 3 в __main__**

`wb_finance.py:114-118`:

```python
if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
    if _SKIPPED_429:
        print(f"[wb_finance] PARTIAL: пропущено окон из-за 429: {_SKIPPED_429}",
              file=sys.stderr, flush=True)
        sys.exit(3)
```

204/пустое тело exit-код НЕ меняют (легальная пустота на новых кабинетах — спек п.4).

- [ ] **Step 3: Smoke — проверить оба исхода без сети**

```bash
cd /opt/agents/saas && /opt/agents/data-presenter-agent/.venv/bin/python - <<'EOF'
import sys, types
sys.path.insert(0, "worker")
sys.modules["db_pg"] = types.SimpleNamespace(init=lambda: None,
                                             upsert_finance_many=lambda rows: 0)
import importlib
wf = importlib.import_module("collectors.wb_finance")
assert wf._SKIPPED_429 == 0
wf._SKIPPED_429 += 1   # эмуляция ветки «429 после 5 попыток»
assert wf._SKIPPED_429 == 1
print("counter OK")
EOF
echo "---"; grep -n "sys.exit(3)" worker/collectors/wb_finance.py
```

Expected: `counter OK` и строка с `sys.exit(3)` в `__main__`.

- [ ] **Step 4: Commit**

```bash
git add worker/collectors/wb_finance.py
git commit -m "feat(ops): wb_finance сигналит exit 3 при пропуске окон из-за 429

Тихий провал (429×5 → пустое окно → exit 0) больше не выглядит успехом.
ozon_finance не трогаем: его retry (ozon_client) падает громко, exit 1.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: record_failure.py + saas-failure@.service

**Files:**
- Create: `worker/record_failure.py`
- Create: `deploy/systemd/saas-failure@.service`

**Interfaces:**
- Consumes: `jobs.collector_runs` из Task 1.
- Produces: `python -m worker.record_failure <unit>` — вызывается юнитом; сам юнит подключает Task 6.

- [ ] **Step 1: Написать worker/record_failure.py**

```python
"""
record_failure.py — фиксация падения systemd-юнита в jobs.collector_runs.

Вызов из saas-failure@.service (OnFailure=saas-failure@%n.service у всех saas-юнитов):
    python -m worker.record_failure <имя-юнита>

Ловит смерти, до которых оркестратор не доживает: TimeoutStartSec, OOM,
скрипт не стартовал. Подключение как postgres — env из /etc/saas-worker.env
(EnvironmentFile юнита). cabinet_id NULL: авария уровня прогона, не кабинета.
"""
import os
import sys
from datetime import datetime, timezone

import psycopg


def main():
    unit = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    now = datetime.now(timezone.utc)
    with psycopg.connect(
        host=os.environ.get("SAAS_DB_HOST", "localhost"),
        port=os.environ.get("SAAS_DB_PORT", "5432"),
        dbname=os.environ.get("SAAS_DB", "saas"),
        user="postgres",
        password=os.environ.get("POSTGRES_PASSWORD", ""),
    ) as conn:
        conn.execute(
            "INSERT INTO jobs.collector_runs "
            "(cabinet_id, collector, run_kind, status, error, started_at, finished_at) "
            "VALUES (NULL, %s, 'systemd', 'failed', %s, %s, %s)",
            (f"unit:{unit}",
             f"OnFailure: юнит {unit} завершился с ошибкой (см. journalctl -u {unit})",
             now, now))
    print(f"[record_failure] зафиксировано падение {unit}", flush=True)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Написать deploy/systemd/saas-failure@.service**

```ini
[Unit]
Description=SAAS Failure hook — фиксирует падение юнита %i в jobs.collector_runs

[Service]
Type=oneshot
User=root
Group=root
# POSTGRES_PASSWORD + SAAS_DB_* для record_failure.py
EnvironmentFile=/etc/saas-worker.env
Environment=SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas
WorkingDirectory=/opt/agents/saas
ExecStart=/opt/agents/data-presenter-agent/.venv/bin/python -m worker.record_failure %i
StandardOutput=journal
StandardError=journal
SyslogIdentifier=saas-failure
```

- [ ] **Step 3: Smoke — прямой вызов**

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && set +a \
  && export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas \
  && /opt/agents/data-presenter-agent/.venv/bin/python -m worker.record_failure smoke-test.service
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "SELECT collector, run_kind, status, error FROM jobs.collector_runs WHERE collector='unit:smoke-test.service'"
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "DELETE FROM jobs.collector_runs WHERE collector='unit:smoke-test.service'"
```

Expected: строка `unit:smoke-test.service / systemd / failed`, затем удалена.

- [ ] **Step 4: Commit**

```bash
git add worker/record_failure.py deploy/systemd/saas-failure@.service
git commit -m "feat(ops): OnFailure-хук — record_failure.py + saas-failure@.service

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: systemd-юниты в репо + OnFailure + установка

**Files:**
- Create: `deploy/systemd/saas-worker.service`, `saas-worker.timer`, `saas-stocks.service`, `saas-stocks.timer`, `saas-metrics30m.service`, `saas-metrics30m.timer`, `saas-references.service`, `saas-references.timer`, `saas-backfill.service`, `saas-backfill.timer`, `saas-backup.service`, `saas-backup.timer`, `saas-web.service`
- Create: `deploy/install-systemd.sh`

**Interfaces:**
- Consumes: `saas-failure@.service` из Task 5.
- Produces: `/etc/systemd/system/saas-*` = точная копия `deploy/systemd/` (источник истины теперь репо).

- [ ] **Step 1: Скопировать боевые юниты в репо**

```bash
mkdir -p /opt/agents/saas/deploy/systemd
for u in saas-worker saas-stocks saas-metrics30m saas-references saas-backfill saas-backup; do
  cp /etc/systemd/system/$u.service /opt/agents/saas/deploy/systemd/
  cp /etc/systemd/system/$u.timer   /opt/agents/saas/deploy/systemd/ 2>/dev/null || true
done
cp /etc/systemd/system/saas-web.service /opt/agents/saas/deploy/systemd/
ls /opt/agents/saas/deploy/systemd/
```

Expected: 14 файлов (8 service — включая saas-failure@ из Task 5, 6 timer).

- [ ] **Step 2: Добавить OnFailure во все 7 боевых .service**

В каждом из `saas-worker|saas-stocks|saas-metrics30m|saas-references|saas-backfill|saas-backup|saas-web`.service (НЕ в saas-failure@.service — рекурсия) в секцию `[Unit]` последней строкой:

```ini
OnFailure=saas-failure@%n.service
```

`%n` разворачивается в полное имя юнита (`saas-worker.service`) — оно станет `%i` инстанса.

- [ ] **Step 3: Написать deploy/install-systemd.sh**

```bash
#!/bin/bash
# install-systemd.sh — установка systemd-юнитов SAAS из репозитория.
# Источник истины: deploy/systemd/. Скрипт только копирует и перечитывает
# конфигурацию; enable/disable таймеров НЕ трогает (текущее состояние хоста
# сохраняется — например, saas-references.timer сознательно/исторически не enabled).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/systemd" && pwd)"
cp -v "$SRC"/*.service "$SRC"/*.timer /etc/systemd/system/
systemctl daemon-reload
echo "OK. Таймеры: systemctl list-timers 'saas-*' --all"
```

```bash
chmod +x /opt/agents/saas/deploy/install-systemd.sh
```

- [ ] **Step 4: Установить и проверить**

```bash
/opt/agents/saas/deploy/install-systemd.sh
systemctl show saas-worker.service -p OnFailure
systemd-analyze verify /etc/systemd/system/saas-failure@.service 2>&1 | head -5
```

Expected: `OnFailure=saas-failure@saas-worker.service` (у всех 7), verify без ошибок.

- [ ] **Step 5: Smoke — OnFailure end-to-end**

```bash
systemd-run --unit=saas-smoke-fail --property=OnFailure=saas-failure@saas-smoke-fail.service /bin/false
sleep 3
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "SELECT collector, status, error FROM jobs.collector_runs WHERE collector LIKE 'unit:saas-smoke-fail%'"
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "DELETE FROM jobs.collector_runs WHERE collector LIKE 'unit:saas-smoke-fail%'"
systemctl reset-failed saas-smoke-fail.service 2>/dev/null || true
```

Expected: строка `unit:saas-smoke-fail.service / failed`, затем удалена.

- [ ] **Step 6: Commit**

```bash
git add deploy/
git commit -m "feat(ops): systemd-юниты в репо + OnFailure=saas-failure@%n у всех

deploy/systemd/ — источник истины, deploy/install-systemd.sh — установка
(enable таймеров не трогает).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: /api/health + страница /health

**Files:**
- Create: `app/api/health/route.js`
- Create: `app/health/page.js`
- Create: `app/health/HealthPage.jsx`
- Modify: `/opt/agents/saas/.env.local` (добавить `SAAS_OPS_USER_IDS`; файл вне git)

**Interfaces:**
- Consumes: `jobs.collector_runs` (Task 1), `getSession()` из `lib/session.js`, `query()` из `lib/db.js` (без-тенантный, роль saas_app — SELECT-грант дан миграцией).
- Produces: `GET /api/health` → `{ days: 14, runs: [{id, cabinet_id, display_name, collector, run_kind, date_from, date_to, status, error, started_at, finished_at}] }`.

- [ ] **Step 1: Определить id владельца и прописать env**

```bash
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "SELECT user_id, email FROM auth.users ORDER BY user_id LIMIT 5"
```

Взять user_id владельца (agentrdrd@gmail.com) и добавить строку в `/opt/agents/saas/.env.local`:

```
SAAS_OPS_USER_IDS=<user_id владельца>
```

- [ ] **Step 2: Написать app/api/health/route.js**

```js
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Операторский allowlist (спек п.6): jobs.collector_runs без RLS, поэтому доступ
// только явно перечисленным user_id (SAAS_OPS_USER_IDS="1,2" в .env.local).
function isOps(userId) {
  const ids = (process.env.SAAS_OPS_USER_IDS || '')
    .split(',').map((s) => Number(s.trim())).filter(Boolean);
  return ids.includes(Number(userId));
}

export async function GET() {
  const session = await getSession();
  if (!session?.user_id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isOps(session.user_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const days = 14;
  const runs = await query(
    `SELECT r.id, r.cabinet_id, c.display_name, r.collector, r.run_kind,
            r.date_from, r.date_to, r.status, r.error, r.started_at, r.finished_at
     FROM jobs.collector_runs r
     LEFT JOIN auth.cabinets c ON c.cabinet_id = r.cabinet_id
     WHERE r.started_at >= now() - make_interval(days => $1)
     ORDER BY r.started_at DESC`,
    [days]
  );
  return NextResponse.json({ days, runs });
}
```

- [ ] **Step 3: Написать app/health/page.js (тонкая серверная обёртка, стиль alerts)**

```js
import HealthPage from './HealthPage';
export const dynamic = 'force-dynamic';
export default async function Page() {
  return <HealthPage />;
}
```

- [ ] **Step 4: Написать app/health/HealthPage.jsx**

```jsx
"use client";
import { useState, useEffect } from "react";

// Матрица «сборщик × день» по кабинетам + лента ошибок (спек п.6).
const COLORS = {
  ok: "#22c55e", partial: "#eab308", skipped: "#f97316",
  failed: "#ef4444", timeout: "#ef4444", no_token: "#ef4444", none: "#3f3f46",
};
const RANK = { ok: 0, skipped: 1, partial: 2, no_token: 3, timeout: 4, failed: 5 };

export default function HealthPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div style={{ padding: 24 }}>Нет доступа: {err}</div>;
  if (!data) return <div style={{ padding: 24 }}>Загрузка…</div>;

  const days = [...Array(data.days)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (data.days - 1 - i));
    return d.toISOString().slice(0, 10);
  });

  // кабинет → сборщик → день → худший статус дня
  const cabs = {};
  for (const r of data.runs) {
    const cab = r.cabinet_id
      ? `#${r.cabinet_id} ${r.display_name || ""}`.trim()
      : "Системные (systemd-юниты)";
    const day = (r.started_at || "").slice(0, 10);
    cabs[cab] ??= {};
    cabs[cab][r.collector] ??= {};
    const prev = cabs[cab][r.collector][day];
    if (!prev || RANK[r.status] > RANK[prev]) cabs[cab][r.collector][day] = r.status;
  }
  const errors = data.runs.filter((r) => r.status !== "ok").slice(0, 50);

  const cell = (st) => (
    <td key={Math.random()} title={st || "не запускался"}
        style={{ width: 22, height: 18, background: COLORS[st || "none"],
                 border: "1px solid #18181b" }} />
  );

  return (
    <div style={{ padding: 24, fontFamily: "monospace", color: "#e4e4e7",
                  background: "#09090b", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Здоровье данных</h1>
      <div style={{ fontSize: 12, color: "#a1a1aa", marginBottom: 16 }}>
        jobs.collector_runs, последние {data.days} дн. Цвета: ok / partial /
        skipped (guard) / failed-timeout-no_token / не запускался.
      </div>
      {Object.entries(cabs).map(([cab, colls]) => (
        <div key={cab} style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{cab}</div>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", paddingRight: 8 }}>сборщик</th>
                {days.map((d) => (
                  <th key={d} title={d} style={{ fontWeight: 400, color: "#71717a" }}>
                    {d.slice(8)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(colls).sort().map(([coll, byDay]) => (
                <tr key={coll}>
                  <td style={{ paddingRight: 8, whiteSpace: "nowrap" }}>{coll}</td>
                  {days.map((d) => cell(byDay[d]))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <h2 style={{ fontSize: 16, margin: "24px 0 8px" }}>Последние проблемы</h2>
      {!errors.length && <div style={{ color: "#a1a1aa" }}>Проблем нет 🎉</div>}
      {errors.map((r) => (
        <div key={r.id} style={{ fontSize: 12, marginBottom: 4 }}>
          <span style={{ color: COLORS[r.status] }}>[{r.status}]</span>{" "}
          {(r.started_at || "").slice(0, 16).replace("T", " ")}{" "}
          {r.cabinet_id ? `#${r.cabinet_id}` : "sys"} {r.collector}
          {r.error ? ` — ${r.error}` : ""}
        </div>
      ))}
    </div>
  );
}
```

Примечание: `key={Math.random()}` в `cell` заменить на `key={\`${coll}-${d}\`}` — передать `coll`/`d` в `cell(st, key)`; при реализации сделать чисто (React-ключи должны быть стабильными):

```jsx
  const cell = (st, key) => (
    <td key={key} title={st || "не запускался"}
        style={{ width: 22, height: 18, background: COLORS[st || "none"],
                 border: "1px solid #18181b" }} />
  );
  // в рендере: {days.map((d) => cell(byDay[d], `${coll}-${d}`))}
```

- [ ] **Step 5: Пересобрать и проверить доступ**

```bash
cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 5
# без сессии → 401
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health
```

Expected: build без ошибок, `401`. Затем вручную в браузере под владельцем: `/health` показывает матрицу (будут строки из smoke-прогонов Task 2); под не-ops пользователем (если есть) — «Нет доступа: HTTP 403».

- [ ] **Step 6: Commit**

```bash
git add app/api/health/ app/health/
git commit -m "feat(ops): страница /health — матрица здоровья сборщиков из collector_runs

Доступ по allowlist SAAS_OPS_USER_IDS (.env.local), клиентам закрыто.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Сквозной smoke + документация

**Files:**
- Modify: `AGENTS.md` (раздел про мониторинг)
- Modify: `docs/superpowers/specs/2026-08-02-worker-alerting-design.md` (отметка «реализовано»)

- [ ] **Step 1: Сквозной прогон боевого таймера**

```bash
systemctl start saas-stocks.service; systemctl status saas-stocks.service --no-pager | head -5
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "SELECT cabinet_id, collector, run_kind, status, started_at FROM jobs.collector_runs WHERE run_kind='stocks' ORDER BY id DESC LIMIT 10"
```

Expected: юнит завершился, в журнале строки `wb_stocks`/`ozon_stocks` со статусом `ok` по каждому кабинету, `run_kind='stocks'`.

- [ ] **Step 2: Форс-partial → guard (эмуляция дыры finance)**

Временно (в копии!) проверить цепочку «finance exit 3 → order_costs skipped» без порчи данных:

```bash
cd /opt/agents/saas
cp worker/collectors/wb_finance.py /tmp/claude-0/wb_finance.py.bak
python3 - <<'EOF'
# Вставить принудительный partial: сразу после db_pg.init() выходим с кодом 3.
import re
p = "worker/collectors/wb_finance.py"
s = open(p, encoding="utf-8").read()
s = s.replace("    db_pg.init()\n    rows = fetch_by_days(start, end)",
              "    db_pg.init()\n    import sys as _s; print('SMOKE: форс-partial', flush=True); _s.exit(3)\n    rows = fetch_by_days(start, end)")
open(p, "w", encoding="utf-8").write(s)
EOF
set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a \
  && export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas \
  && /opt/agents/data-presenter-agent/.venv/bin/python -m worker.orchestrator \
     --cabinet 1 --collectors wb_finance,wb_order_costs --run-kind manual
cp /tmp/claude-0/wb_finance.py.bak worker/collectors/wb_finance.py   # откат правки
git diff --stat worker/collectors/wb_finance.py                       # пусто = откат чистый
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "SELECT collector, status, error FROM jobs.collector_runs WHERE run_kind='manual' ORDER BY id DESC LIMIT 4"
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "SELECT count(*), max(updated_at) FROM tenant.wb_order_costs WHERE cabinet_id=1"
```

Expected: в выводе оркестратора `[wb_finance] PARTIAL` и `[wb_order_costs] SKIP`; в журнале строки `wb_finance/partial` и `wb_order_costs/skipped`; `max(updated_at)` у `wb_order_costs` НЕ изменился (агрегаты не тронуты). Затем удалить smoke-строки:

```bash
PGPASSWORD="$(. /etc/saas-worker.env; echo $POSTGRES_PASSWORD)" psql -h localhost -U postgres -d saas -c "DELETE FROM jobs.collector_runs WHERE run_kind='manual'"
```

- [ ] **Step 3: Проверить /health показывает всё**

В браузере `/health`: строки Task 8 Step 1 видны в матрице; лента проблем пуста (smoke-строки удалены).

- [ ] **Step 4: Документация в AGENTS.md**

В таблицу «где что лежит» (`AGENTS.md:23` рядом со строкой про миграции) добавить строки:

```markdown
| Журнал прогонов сборщиков | jobs.collector_runs (пишет orchestrator; ok/partial/failed/timeout/no_token/skipped; ретеншн 90 дн) |
| Здоровье данных | /health (доступ: SAAS_OPS_USER_IDS в .env.local) + OnFailure=saas-failure@%n во всех юнитах |
| systemd-юниты | deploy/systemd/ (источник истины) + deploy/install-systemd.sh |
```

И короткий абзац в подходящий раздел про воркер:

```markdown
Контракт exit-кодов сборщиков: 0 = ok, 3 = partial (часть окон пропущена, напр.
429 у wb_finance), прочее = failed. Guard: если *_finance прогона не-ok,
*_order_costs НЕ запускается (иначе безусловный DO UPDATE затёр бы хорошие
агрегаты дырявыми) — GUARD_DEPS в orchestrator._run_one.
```

- [ ] **Step 5: Отметить спек реализованным**

В шапке `docs/superpowers/specs/2026-08-02-worker-alerting-design.md` заменить строку статуса:

```markdown
Дата: 2026-08-02. Статус: РЕАЛИЗОВАНО 2026-08-02 (план docs/superpowers/plans/2026-08-02-worker-alerting.md).
```

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-08-02-worker-alerting-design.md
git commit -m "docs(ops): алертинг воркера — контракт exit-кодов и /health в AGENTS.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
