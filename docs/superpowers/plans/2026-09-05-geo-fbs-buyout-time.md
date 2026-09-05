# FBS-отгрузки: время до покупателя — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Запрос владельца (05.09, дословно):** «там где фбс отгрузки еще бы время доставки до покупателя указать».

**Goal:** В секции «FBS-отгрузки» у каждой поставки — медиана дней от закрытия поставки до выкупа покупателем, плюс общая медиана в мини-KPI.

**Architecture:** Новая связка «поставка ↔ заказ»: лента FBS-заданий marketplace-api `/api/v3/orders` отдаёт `supplyId` + `rid`, и **rid = srid статистики** (проба 05.09: 201/223 совпали с `wb_orders.srid`, 91 уже в `wb_sales`). Мини-таблица `tenant.wb_fbs_tasks`, сборщик в main-тике, расширение `wbSuppliesOps` (JOIN к `wb_sales` по srid), колонка в UI.

**Tech Stack:** как этап 3.

## Global Constraints

- Всё как в плане этапа 3 (`2026-09-05-geo-fbs-ops.md`): русский, явный git add, прод=master, saas_ro/админ-psql, SWC вместо ESLint, деплой в финальной задаче, сторожа не подгонять.
- Семантика метрики: `buyoutDays` = `substr(s.sale_dt,1,10)::date − closed_at::date` по выкупам (`is_realization=1`) заказов поставки; поставке нужна ≥1 пара, иначе null («ещё едут»). Метрика включает лежание на ПВЗ до выкупа — подписать «до выкупа» (конвенция WB-прокси из §16).
- Проба 05.09 (не перепроверять): лента `/api/v3/orders?limit=1000&next=…&dateFrom=<unix>` отдаёт `rid`, `supplyId`, `createdAt`, `nmId`; за 30 дней 223 задания; пагинация курсором `next` (как /supplies).
- Контракт расширения `supplies.rows[]`: `+ buyoutMedianDays` (число|null), `+ buyoutN` (кол-во выкупов); агрегат `+ buyoutMedianDaysOverall` (число|null). Имена — единые для задач 1-3.

## Карта файлов

| Файл | Что происходит |
|---|---|
| `db/migrations/049_wb_fbs_tasks.sql` | таблица связки rid↔supply |
| `worker/collectors/wb_fbs_tasks.py` + `worker/db_pg.py` + `worker/orchestrator.py` + `worker/run_saas_collect.sh` | сборщик ленты FBS-заданий |
| `lib/geoMetrics.js` | `wbSuppliesOps` + buyout-поля |
| `scripts/check-geo-canon.mjs` | проверка 7 дополнена buyout-сверкой |
| `app/cabinets/[id]/geo/GeoPage.jsx` | колонка «До покупателя, дн» + KPI |
| `docs/metrics-contract.md` | §16.8 дополнение |

---

### Task 1: Миграция 049 + сборщик wb_fbs_tasks

**Files:**
- Create: `db/migrations/049_wb_fbs_tasks.sql`, `worker/collectors/wb_fbs_tasks.py`
- Modify: `worker/db_pg.py`, `worker/orchestrator.py` (WB_COLLECTORS), `worker/run_saas_collect.sh` (MAIN_COLLECTORS)

**Interfaces:**
- Produces: `tenant.wb_fbs_tasks(cabinet_id, rid PK, supply_id, created_at, nm_id)`; `db_pg.upsert_wb_fbs_tasks_many(rows)`; модуль `worker.collectors.wb_fbs_tasks` (`collect()` игнорирует аргументы дат, окно скользящее 30 дней).

- [ ] **Step 1: Миграция** (образец RLS/политик — 047 `wb_supplies`):

```sql
-- 049_wb_fbs_tasks.sql — связка FBS-задание ↔ поставка WB («время до покупателя»,
-- запрос владельца 05.09.2026). rid ленты /api/v3/orders == srid статистики
-- (проба 05.09: 201/223 совпали) — через него выкуп из wb_sales.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.wb_fbs_tasks (
    cabinet_id BIGINT NOT NULL,
    rid        TEXT   NOT NULL,   -- == wb_orders.srid / wb_sales.srid
    supply_id  TEXT,              -- WB-GI-…; NULL пока задание не в поставке
    created_at TIMESTAMPTZ,
    nm_id      BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, rid)
);
CREATE INDEX IF NOT EXISTS wb_fbs_tasks_supply_idx ON tenant.wb_fbs_tasks (cabinet_id, supply_id);

ALTER TABLE tenant.wb_fbs_tasks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='wb_fbs_tasks' AND policyname='tenant_iso_wb_fbs_tasks') THEN
        CREATE POLICY tenant_iso_wb_fbs_tasks ON tenant.wb_fbs_tasks
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='wb_fbs_tasks' AND policyname='panel_local_ro_cab1') THEN
        CREATE POLICY panel_local_ro_cab1 ON tenant.wb_fbs_tasks
        FOR SELECT TO panel_local_ro
        USING (cabinet_id = 1);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.wb_fbs_tasks TO saas_app;
GRANT SELECT ON tenant.wb_fbs_tasks TO panel_local_ro;

COMMIT;
```
Применить админ-psql, проверить `\d` и политики (2 шт).

- [ ] **Step 2: db_pg.py** — карта и upsert (рядом с `_WB_SUPPLIES_MAP`):

```python
_WB_FBS_TASKS_MAP = [
    ("rid", "rid"), ("supply_id", "supplyId"),
    ("created_at", "createdAt"), ("nm_id", "nmId"),
]


def upsert_wb_fbs_tasks_many(rows):
    """FBS-задания WB (marketplace-api /api/v3/orders): связка rid↔supply_id."""
    return _upsert_raw_multi_pk("wb_fbs_tasks", ["rid"], _WB_FBS_TASKS_MAP, rows)
```

- [ ] **Step 3: Сборщик** `worker/collectors/wb_fbs_tasks.py` — по образцу `wb_supplies.py` (тот же `_get` с ретраями, «ПРОПУСК (exit 0)» при недоступности, `##OBS` последней строкой):

```python
"""
SaaS-сборщик FBS-ЗАДАНИЙ WB → tenant.wb_fbs_tasks.

marketplace-api /api/v3/orders (лента сборочных заданий, курсор next):
rid (== srid статистики, проба 05.09.2026: 201/223) + supplyId. Нужен секции
«FBS-отгрузки» для метрики «время до покупателя» (закрытие поставки → выкуп).
Окно скользящее 30 дней (dateFrom unix), аргументы дат оркестратора
игнорируются. Upsert идемпотентен; supplyId дозаполняется при попадании
задания в поставку.
"""
import os
import sys
import time
from datetime import datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
ORDERS_URL = "https://marketplace-api.wildberries.ru/api/v3/orders"
PAGE_LIMIT = 1000
WINDOW_DAYS = 30
MAX_ATTEMPTS = 4


def _get(url):
    """GET с ретраями на 429/5xx; None при недоступности (не роняем прогон)."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(url, headers={"Authorization": WB_TOKEN}, timeout=60)
        except requests.RequestException as e:
            print(f"  сеть ({attempt}/{MAX_ATTEMPTS}): {e}", flush=True)
            time.sleep(2 * attempt)
            continue
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "10") or 10)
            print(f"  429, ждём {wait}с ({attempt}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(min(wait, 60))
            continue
        if resp.status_code >= 500:
            print(f"  {resp.status_code} ({attempt}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(2 * attempt)
            continue
        print(f"  ОШИБКА {resp.status_code}: {resp.text[:200]}", flush=True)
        return None
    return None


def collect():
    print(f"[wb_fbs_tasks] FBS-задания ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_fbs_tasks] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    db_pg.init()
    date_from = int(time.time()) - WINDOW_DAYS * 86400
    rows, nxt, pages = [], 0, 0
    while True:
        data = _get(f"{ORDERS_URL}?limit={PAGE_LIMIT}&next={nxt}&dateFrom={date_from}")
        if data is None:
            if not rows:
                print("[wb_fbs_tasks] ПРОПУСК: API недоступен (exit 0)", flush=True)
                return 0
            break
        page = data.get("orders") or []
        rows.extend(r for r in page if r.get("rid"))
        pages += 1
        nxt = data.get("next")
        if len(page) < PAGE_LIMIT or not nxt:
            break
        time.sleep(0.5)
    written = db_pg.upsert_wb_fbs_tasks_many(rows)
    print(f"[wb_fbs_tasks] страниц {pages}, заданий {len(rows)}, записано {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 4: Регистрация в двух местах** — `orchestrator.py` WB_COLLECTORS (после `"wb_supplies"`): `"wb_fbs_tasks",  # FBS-задания → связка rid↔поставка (время до покупателя)`; `run_saas_collect.sh` MAIN_COLLECTORS: `,wb_fbs_tasks` в конец.

- [ ] **Step 5: Смоук** — `set -a; . /etc/saas-worker.env; set +a; cd /opt/agents/saas && python3 -m worker.orchestrator --all --collectors wb_fbs_tasks`: exit 0; в БД `SELECT COUNT(*), COUNT(supply_id) FROM tenant.wb_fbs_tasks WHERE cabinet_id=1;` → ~220+, supply_id у большинства; сверка связки: `SELECT COUNT(*) FROM tenant.wb_fbs_tasks t JOIN tenant.wb_sales s ON s.cabinet_id=t.cabinet_id AND s.srid=t.rid WHERE t.cabinet_id=1 AND s.is_realization=1;` → ~90 (порядок пробы).

- [ ] **Step 6: Commit** — `git add db/migrations/049_wb_fbs_tasks.sql worker/collectors/wb_fbs_tasks.py worker/db_pg.py worker/orchestrator.py worker/run_saas_collect.sh`, «feat(worker): wb_fbs_tasks — связка FBS-задание↔поставка (время до покупателя)».

---

### Task 2: Канон buyout-метрики + сторож

**Files:**
- Modify: `lib/geoMetrics.js` (`wbSuppliesOps`), `scripts/check-geo-canon.mjs` (проверка 7)

**Interfaces:**
- Produces: `supplies.rows[].buyoutMedianDays|buyoutN`, `supplies.buyoutMedianDaysOverall` (контракт из Global Constraints).

- [ ] **Step 1: Расширить wbSuppliesOps** — вторым запросом buyout-пары и слить в rows по supplyId:

```js
  // Время до покупателя: закрытие поставки → выкуп (wb_sales по srid==rid).
  // Включает лежание на ПВЗ до выкупа — «до выкупа», как WB-прокси в §16.4.
  const buyoutRows = await db.prepare(`
    SELECT t.supply_id AS "supplyId",
           (substr(s.sale_dt,1,10)::date - w.closed_at::date) AS days
    FROM tenant.wb_fbs_tasks t
    JOIN tenant.wb_supplies w ON w.supply_id = t.supply_id
    JOIN sales s ON s.srid = t.rid AND s.is_realization = 1
    WHERE t.supply_id IS NOT NULL
      AND w.closed_at IS NOT NULL
      AND w.closed_at::date >= ?::date AND w.closed_at::date <= ?::date
      AND (substr(s.sale_dt,1,10)::date - w.closed_at::date) BETWEEN 0 AND 60
  `).all(from, to);
```
Группировка по supplyId на JS (та же квантиль-функция, что уже есть в файле): `buyoutMedianDays` (медиана days), `buyoutN`; поставкам без пар — null/0; `buyoutMedianDaysOverall` — медиана по ВСЕМ парам окна (не медиана медиан).
Внимание к шиму: `tenant.wb_fbs_tasks`/`tenant.wb_supplies` — явные пути (нет в маппинге), `sales` — через шим (wb_sales). Проверить, что convertSql не переписывает явные tenant-пути (конвенция файла).

- [ ] **Step 2: Сторож** — в проверку 7 добавить: `buyoutMedianDaysOverall` = независимый SQL с `percentile_cont` по тем же парам (nearest-rank поправку из бэклога здесь НЕ решаем — допуск 0.1 дн с тем же комментарием, что у медиан часов); `Σ buyoutN` = независимый COUNT пар.

- [ ] **Step 3: Смоук** — withTenant-скрипт: rows с buyoutMedianDays≠null > 0, overall в разумных пределах (2-8 дн — WB-прокси по срезу этапа 2 давал ~5-7 дн); `node scripts/check-geo-canon.mjs --cabinet 1` и `--cabinet 1008` → ALL PASS.

- [ ] **Step 4: Commit** — `git add lib/geoMetrics.js scripts/check-geo-canon.mjs`, «feat(geo): время до покупателя per поставку (buyoutMedianDays) + сверка сторожем».

---

### Task 3: UI + контракт + деплой

**Files:**
- Modify: `app/cabinets/[id]/geo/GeoPage.jsx`, `docs/metrics-contract.md` (§16.8)

- [ ] **Step 1: UI** — в SuppliesSection: колонка «До покупателя, дн» после «До СЦ, ч»: `buyoutMedianDays` (null → «ещё едут» C.faint, title «выкупов пока нет»; при buyoutN<3 — значение C.faint с title «мало выкупов (n=N)»); в мини-KPI строку добавить «· до покупателя Xд (медиана)» из `buyoutMedianDaysOverall`; подпись секции дополнить «„До покупателя“ — до выкупа (включает ПВЗ)». SWC-парсинг.
- [ ] **Step 2: Контракт** — §16.8 дополнить: определение buyoutDays (формула, окно 0..60, связка rid==srid с числами пробы 05.09), поля контракта, допуск сторожа.
- [ ] **Step 3: Деплой** — `npm run build && systemctl restart saas-web`, health 200/307; приёмка: `node scripts/check-geo-canon.mjs --cabinet 1` и `--cabinet 1008` → ALL PASS.
- [ ] **Step 4: Commit** — `git add "app/cabinets/[id]/geo/GeoPage.jsx" docs/metrics-contract.md`, «feat(geo-ui): время до покупателя в FBS-отгрузках».

## Вне рамок

- Ретро-история глубже 30 дней ленты (лента WB отдаёт задания ~90 дней — расширение окна, если владельцу понадобится история).
- Ozon FBS аналог — при возобновлении FBS-продаж Ozon.
