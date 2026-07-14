# AGENTS.md — карта SaaS-дашборда WB/Ozon (для старта сессии)

> **Этот файл автоматически загружается в контекст при старте каждой сессии.**
> Здесь — обзорная карта: что где лежит, как течёт сбор данных, где править.
> Детали — в комментариях внутри соответствующих файлов.

SaaS-аналитика для продавцов WB/Ozon. **Next.js 14** (App Router, порт 3200) +
**PostgreSQL** с row-level security (RLS) по `cabinet_id`. Мультитенант:
один инстанс → много клиентов, данные изолированы.

## TL;DR — где что искать

| Нужно | Смотри |
|---|---|
| Добавить/изменить API-эндпоинт | `app/api/cabinets/[id]/<name>/route.js` |
| Страницу дашборда (UI) | `app/cabinets/[id]/<name>/page.js` + `*Page.jsx` |
| Схему БД / миграции | `db/migrations/0NN_*.sql` (пронумерованы, идемпотентны) |
| Слой расчёта метрик WB | `lib/wbMetrics.js` (единый источник правды по заказам/выручке/прибыли) |
| Слой расчёта метрик Ozon | `lib/ozonMetrics.js` |
| Юнит-экономику | `lib/unit.js` (calcWB / calcOzon, налоги в отдельных колонках) |
| Адаптер БД (PG + RLS) | `lib/db.js` (DatabaseSync, withTenant, query, tenantQuery) |
| Сборщики (тянут данные из API МП) | `worker/collectors/*.py` |
| Оркестратор воркера | `worker/orchestrator.py` |
| Запуск воркера (systemd) | `/etc/systemd/system/saas-*.service` + `worker/run_saas_*.sh` |

## Архитектура данных (главное — всё в PostgreSQL, никакого SQLite)

```
┌─────────────────────────────────────────────────────────────┐
│  API маркетплейсов (WB / Ozon)                              │
└───────────┬─────────────────────────────────────────────────┘
            │ Python-сборщики (worker/collectors/*.py)
            │ подключаются как saas_app, RLS по cabinet_id
            ▼
┌─────────────────────────────────────────────────────────────┐
│  PostgreSQL, схема tenant.*                                 │
│  wb_* (19 таблиц) и ozon_* (18 таблиц) — все с cabinet_id   │
│  в PK + RLS-политика «строка видна если cabinet_id = GUC»   │
└───────────┬─────────────────────────────────────────────────┘
            │ Next.js route (lib/db.js DatabaseSync поверх PG)
            │ withTenant(cid) → SET app.cabinet_id → RLS режет
            ▼
┌─────────────────────────────────────────────────────────────┤
│  Дашборд (React, порт 3200)                                 │
└─────────────────────────────────────────────────────────────┘
```

⚠️ **Ловушка, на которую наступали:** в `lib/` раньше лежали SQLite-файлы
из старого single-tenant проекта (`wb_data.db`, `fin_data.db`...) — они
**удалены**. Всё, что используется, идёт через `lib/db.js` (PostgreSQL).
Если видишь путь к `.db` файлу — это устаревший код, не активный.

## Схемы PostgreSQL

- `auth.*` — пользователи, кабинеты, memberships, shops, приглашения. **Без RLS**
  (изоляция через `WHERE cabinet_id` в запросах).
- `tenant.*` — клиентские данные (заказы, продажи, финансы, метрики, остатки,
  отзывы). **С RLS** по `app.cabinet_id`.
- `shared.*` — общие справочники (список МП).
- `jobs.*` — очередь сбора (`jobs.collect_jobs`: типы daily/resync/onboarding).

Ключевые таблицы tenancy: `auth.cabinets` (кабинет = проект, 1 кабинет → много
магазинов разных МП), `auth.shops` (магазин = 1 МП + 1 юрлицо, здесь лежат
**зашифрованные pgcrypto API-ключи** в `api_creds_enc`), `auth.memberships`
(user ↔ cabinet с ролью owner/manager/viewer).

## Как изолируется тенант (RLS)

1. Запрос приходит в API-роут `app/api/cabinets/[id]/...`.
2. `withCabinet` (`lib/withCabinet.js`) проверяет session + membership,
   затем вызывает `withTenant(cabinetId, fn)` (`lib/db.js`).
3. `withTenant`: `BEGIN` → `SELECT set_config('app.cabinet_id', $cid, true)` →
   выполняет handler → `COMMIT`. GUC `app.cabinet_id` живёт в транзакции.
4. RLS-политики на `tenant.*` (см. миграции 002/003): `USING (cabinet_id = current_setting('app.cabinet_id')::bigint)`.
5. `DatabaseSync('wb')` в коде роута — это **не** файл, а PG-адаптер: `'wb'` —
   просто флаг МП для маппинга имён таблиц (`orders` → `tenant.wb_orders`).
   Маппинг `?`→`$N` и таблиц делает `convertSql()` в `lib/db.js`.

## Сбор данных (воркер)

**Оркестратор** `worker/orchestrator.py` читает активные кабинеты из PG,
расшифровывает API-ключи из `auth.shops.api_creds_enc` (pgcrypto, ключ в env
`SAAS_CRED_MASTER_KEY`) и для каждого магазина запускает сборщики в отдельном
subprocess с env-инъекцией (`WB_TOKEN` / `OZON_*` + `WB_SaaS_CABINET_ID`).

**Три режима оркестратора:**
- `--all` — ежедневный сбор (вчера/сегодня) по всем active-кабинетам. Таймер `saas-worker` 4×/день.
- `--cabinet N [--date-from .. --date-to ..]` — один кабинет, для ручного backfill/теста.
- `--drain-queue` — прогон onboarding-jobs (backfill за 75 дней) из `jobs.collect_jobs`.
  Таймер `saas-backfill` 4×/день. Job создаётся при онбординге нового клиента.

**Сборщики** (`worker/collectors/wb_*.py`, `ozon_*.py`) пишут в `tenant.*` через
`worker/db_pg.py` (тот же паттерн RLS по `WB_SaaS_CABINET_ID`). Все upsert'ы
идемпотентны (`ON CONFLICT`). Порядок важен: catalog → orders → finance →
order_costs → metrics → prices → stocks (зависимости по FK).

## Боевое расписание (systemd, `/etc/systemd/system/`)

| Таймер | Когда | Что делает |
|---|---|---|
| `saas-worker` | 05:15, 09:00, 12:00, 17:00 | основной сбор 14 сборщиков (−2 дня..сегодня) |
| `saas-stocks` | 05:00 | снимок остатков |
| `saas-metrics30m` | каждые 30 мин | 30-мин снапшоты воронки WB |
| `saas-backfill` | 07:00, 10:30, 14:00, 19:00 | прогон очереди onboarding-jobs (75 дней) |
| `saas-backup` | 03:00 | дамп PG |

Логи: `/opt/agentsDB/logs/saas_worker.log`. Веб: `saas.service` (`next start -p 3200`).

## Онбординг нового клиента (поток)

1. `/onboarding` (фронт) → `POST /api/onboarding/start` с `marketplaces[]`.
2. Эндпоинт создаёт кабинет (`status='active'`, `marketplaces` заполнен) +
   в той же транзакции **job** `job_type='onboarding'` (`date_from=сегодня−75`,
   `status='queued'`) в `jobs.collect_jobs`.
3. Магазины добавляются `POST /api/cabinets/[id]/shops` — креды шифруются (pgcrypto) и
   кладутся в `auth.shops.api_creds_enc` (per-МП, per-юрлицо).
4. Таймер `saas-backfill` (4×/день: 07:00, 10:30, 14:00, 19:00) подхватывает queued-job
   (`orchestrator --drain-queue`), гоняет сборщики за 75 дней. Воркер читает креды из
   `auth.shops`, legacy-fallback на кабинетные creds (для cabinet #1).
5. После — ежедневный `saas-worker` (4×/день) тянет свежие данные.
6. Прокси НЕ нужен (сервер в РФ). Закладывать при 50+ клиентах.

## Конфигурация / env

- `.env.local` — DB-креды, `SAAS_SESSION_SECRET`, `SAAS_CRED_MASTER_KEY`,
  `SAAS_INVITE_CODE`.
- `/etc/saas-worker.env` + `/etc/collectors.env` — env для воркера (читают
  `run_saas_*.sh` и `run_orchestrator.py`): `POSTGRES_PASSWORD`,
  `SAAS_APP_DB_PASSWORD`, `SAAS_CRED_MASTER_KEY`.
- Алиас путей: `@/*` → `./*` (`jsconfig.json`). Импорты lib: `@/lib/db.js`.

## Где что считается (чтобы не разойтись в цифрах)

- **Метрики WB** (заказы/выручка/комиссия/прибыль): `lib/wbMetrics.js`.
  Канон: заказы = `COUNT(*) FROM orders WHERE is_cancel=0`; выручка =
  `SUM(retail_price_withdisc_rub)` из finance_report Продажа; комиссия =
  `commission_percent × retail_price_withdisc_rub / 100`.
- **Метрики Ozon**: `lib/ozonMetrics.js`.
- **Юнит-экономика** (маржа/ROI товара): `lib/unit.js` (`calcWB`, `calcOzon`).
  Формула СПП нетривиальна — править осторожно.
- **Налоги** (УСН/НДС): `lib/tax.js` (`normalizeTaxMode`). Хранятся per-shop
  в `auth.shops.tax_mode`.

### ⚠️ Себестоимость — ЕДИНЫЙ источник `tenant.cost_overrides` (с 2026-07-14)

**Раньше** было 2 таблицы (`wb_cogs`/`ozon_cogs` + `cost_overrides`) с расхождениями.
**Теперь** — только `tenant.cost_overrides`. `wb_cogs`/`ozon_cogs` оставлены в БД как
архив (откат: `/opt/agentsDB/backups/cogs_unify_20260714_200601.sql`), но **НЕ читаются кодом**.

Паттерн чтения себестоимости — LATERAL JOIN (актуальный override = последний с
`effective_from <= дата`):
```sql
LEFT JOIN LATERAL (
  SELECT cost FROM tenant.cost_overrides
  WHERE nm_id = X.nm_id AND platform = 'wb'            -- Ozon: product_id + 'ozon'
    AND effective_from <= COALESCE(substr(dateExpr,1,10)::date, current_date)
  ORDER BY effective_from DESC LIMIT 1
) co ON true
```
Хелперы: `WB_COST_JOIN(outAlias, skuExpr, dateExpr)` / `OZON_COST_JOIN(...)` в `lib/finItems.js`.
`order_costs.cost` (per-заказ) — пересчитан под override (миграция 013), для истории
использовать как есть.

## Правила работы с кодом

- **Миграции идемпотентны** (`CREATE ... IF NOT EXISTS`, `ON CONFLICT`). Новые —
  с номером `0NN_*.sql`, не трогают существующие.
- **Backup перед правкой** боевого файла — в `/opt/agentsDB/backups/` (правило
  экосистемы). Для новых файлов не нужно.
- **Не открывать `.db` файлы** — всё в PostgreSQL. Если нужно новое поле —
  миграция в `tenant.*` + сборщик пишет, либа читает.
- **После правок `.js` в `app/`/`lib/`** — ребилд + рестарт `saas.service`
  (`npm run build && systemctl restart saas`).
- **После правок сборщиков `.py`** — проверка: `python -m worker.orchestrator
  --cabinet N --collectors <name>`.

### ⚠️ Миграционная ловушка client-страниц (массовый баг, почищен 2026-07-14)

Страницы и роуты портированы из старого single-tenant дашборда (`data-presenter`),
где БД была **синхронным SQLite** и не было `cabinet-id`. Это порождало 6 классов
краш-багов. При добавлении/правке `.jsx`/`.js` в `app/cabinets/[id]/` ВСЕГДА проверяй:

1. **D1 (cabinetId):** компонент принимает `{ cabinetId }`:
   `function FooPage({ cabinetId })`, НЕ `function FooPage()`.
2. **D2 (URL без cabinet):** fetch к `/api/cabinets/${cabinetId}/endpoint`,
   НЕ `/api/endpoint` (кроме глобальных auth/profile/invite/onboarding).
3. **D3 (двойные кавычки):** `${cabinetId}` только в BACKTICKS.
   `fetch("/api/.../${cabinetId}/...")` ✗ (литеральный текст), `` fetch(`/...`) `` ✓.
4. **D4 (async без await):** SaaS-адаптер **асинхронный** (эталон был синхронным SQLite).
   `.all(...).map(...)` ✗ (Promise.map=TypeError) → `(await ...all(...)).map(...)` ✓.
   Вызов async-функции без `await` возвращает Promise → обращение к полю = undefined.
5. **D5 (SQLite-функции):** `datetime(dt,'+3 hours')`, `strftime`, `julianday` — НЕ
   существуют в PG. Замена: `(dt::timestamp + interval '3 hours')::text`.
6. **D6 (контракт фронт↔API):** фронт ждёт `totals.by_category`, API отдаёт `facets.categories`
   → `undefined.map()` = «a is not iterable». Сверяй имена полей.

**Скрининги:**
- `grep -rn 'fetch("[^"]*\${' app/cabinets/` → пусто (D3).
- `grep -rn 'JOIN cogs\|FROM cogs\|c\.cost' app/ lib/` → пусто (нет чтения cogs).
- `grep -rn 'datetime(' app/api/` → пусто (D5).
