# Алертинг воркера: completeness-маркеры + guard от затирания

Дата: 2026-08-02. Статус: дизайн утверждён владельцем (канал — только журнал/панель, без Telegram/email; guard от затирания включён в объём).

## Проблема

Аудит 2026-08-01 показал три слепые зоны в пайплайне сбора данных:

1. **Тихий провал с exit 0.** `worker/collectors/wb_finance.py:58-61`: после 5 неудачных попыток на 429 сборщик пропускает 7-дневное окно и возвращает `[]`, завершаясь успешно. Оркестратор считает прогон OK.
2. **Громкий провал, который никто не слышит.** Упавший сборщик даёт unit'у exit 1 (`orchestrator.py:447-450` → `run_saas_collect.sh:59-60`), systemd видит failed, но `OnFailure=` нет ни в одном из saas-юнитов. Юниты существуют только в `/etc/systemd/system/`, в репозитории их нет.
3. **Нет истории прогонов.** Таблицы «сборщик × дата × кабинет» не существует. `jobs.collect_jobs` заполняется только при онбординге; регулярные прогоны следов в БД не оставляют.

Следствие слепых зон — каскад порчи: `wb_order_costs` пересчитывает агрегаты из `tenant.wb_finance_report` и пишет их безусловным `ON CONFLICT DO UPDATE SET` всех 19 колонок (`db_pg.py:399-401`). При дыре в finance пересчитанные нули/огрызки затирают ранее корректные строки. У Ozon риск выше: `ozon_order_costs.py:41-50` агрегирует строго по окну дат, без «всей истории posting_id».

## Решение (вариант «оркестратор-центричный»)

Всю бухгалтерию прогонов ведёт оркестратор — он уже видит exit-код каждого сборщика и знает окно дат. Сборщики сообщают о частичности минимально — специальным exit-кодом.

### 1. Миграция `031_collector_runs.sql`

Таблица `jobs.collector_runs` (схема `jobs` уже есть; без RLS — операторские данные):

```sql
id           bigserial PRIMARY KEY,
cabinet_id   bigint,            -- NULL для записей уровня unit (OnFailure)
collector    text NOT NULL,     -- 'wb_finance' | ... | 'unit:saas-worker.service'
run_kind     text NOT NULL CHECK (run_kind IN
             ('main','stocks','metrics30m','references','backfill','systemd')),
date_from    date,
date_to      date,
status       text NOT NULL CHECK (status IN
             ('ok','partial','failed','timeout','no_token','skipped')),
rows_written integer,           -- задел на будущее, пока NULL
error        text,              -- последняя строка stderr / причина skip
started_at   timestamptz NOT NULL,
finished_at  timestamptz
```

Индексы: `(collector, finished_at DESC)`, `(status)`. Права `saas_app`: SELECT, INSERT.

Ретеншн: в начале прогона main оркестратор удаляет записи старше 90 дней (одна DELETE-строка, обёрнутая в try/except).

### 2. Оркестратор (`worker/orchestrator.py`)

После каждого `subprocess.run` — INSERT в `collector_runs`:

| Исход subprocess | status |
|---|---|
| exit 0 | `ok` |
| exit 3 | `partial` |
| TimeoutExpired | `timeout` |
| прочие exit-коды | `failed` (в `error` — последняя строка stderr) |
| нет токена | `no_token` |
| кабинет без shops | `failed`, error `no_shops` |

Запись обёрнута в try/except с печатью ошибки в stderr — сбой обвязки не роняет прогон и не глотается молча (правило «никаких пустых catch»).

### 3. Guard от затирания

Сборщики идут последовательно, поэтому guard живёт в оркестраторе:

- если `wb_finance` текущего прогона завершился не-`ok` → `wb_order_costs` **не запускается**; в `collector_runs` пишется `skipped` с причиной `wb_finance status=<...>`;
- аналогично `ozon_finance` → `ozon_order_costs`.

Агрегаты остаются вчерашними (честными), дыра видна на странице здоровья. Порядок пар в списках сборщиков (`run_saas_collect.sh:27`, `orchestrator.py:53-78`) обязан оставаться «finance раньше order_costs» — фиксируется комментарием в обоих местах.

### 4. Exit 3 («partial») в сборщиках

- `wb_finance.py`: при пропуске окна из-за 429 (после 5 неудач) взводится флаг; в конце `sys.exit(3)`.
- `ozon_finance.py`: аналогично для его механизма пропуска (точные места — на этапе плана).
- 204/пустое тело в `partial` **не** превращаем: на новых кабинетах пустота легальна, будут ложные тревоги. Вместо этого предупреждение в stderr (попадёт в `error` записи).

Контракт exit-кодов: 0 = ok, 3 = собрано с пропусками, прочее = fail. Зафиксировать комментарием в `orchestrator.py` рядом с маппингом.

### 5. systemd

- Юниты переезжают в репо: `deploy/systemd/*.service`, `*.timer` — копии боевых с правками.
- Скрипт `deploy/install-systemd.sh`: `cp` в `/etc/systemd/system/` + `systemctl daemon-reload` + enable таймеров.
- Новый шаблонный юнит `saas-failure@.service`: `ExecStart` → `python -m worker.record_failure %i`, который пишет в `collector_runs` строку `collector='unit:<имя>', run_kind='systemd', status='failed'`.
- Во все saas-юниты добавляется `OnFailure=saas-failure@%n.service` — ловит таймауты (TimeoutStartSec=1h у saas-worker), OOM и случаи, когда оркестратор не дожил до своей бухгалтерии.

### 6. Страница «Здоровье данных»

- `app/health/page.js` + `app/api/health/route.js` (читает `jobs.collector_runs`).
- Матрица «сборщик × последние 14 дней» по каждому кабинету: зелёный `ok`, жёлтый `partial`, красный `failed`/`timeout`, серый «не запускался»; отдельно — лента последних ошибок (текст `error`) и пометки «order_costs пропущен из-за finance».
- Доступ — только владельцу (роль в `auth.memberships`; точный механизм проверяется на этапе плана, fallback — явный список user id).

### 7. Проверка (smoke, тестовой инфраструктуры в проекте нет)

1. Форсированный exit 3 у сборщика → строка `partial` в `collector_runs`.
2. Убитый прогон (`systemctl kill`) → сработавший `OnFailure` → строка `unit:*`.
3. Прогон с недоступным finance → `wb_order_costs` со статусом `skipped`, строки в `tenant.wb_order_costs` не изменились.
4. Страница `/health` показывает всё перечисленное; доступ под не-владельцем закрыт.

## Вне объёма

- Внешние каналы (Telegram/email) — владелец выбрал «только журнал/панель».
- Детализация «каждое 7-дневное окно finance отдельной строкой» — доращивается поверх без ломки схемы.
- WHERE-guard внутри `_batch_upsert` («новое не хуже старого») — отдельная задача, если понадобится второй пояс защиты.
- `wb_cabinet_costs` / `ozon_prices` отсутствуют в `MAIN_COLLECTORS` (`run_saas_collect.sh:27`) — пункт 2 очереди, чинится там же, но отдельным заходом.
