# AGENTS.md — карта SaaS-дашборда WB/Ozon (для старта сессии)

> **Этот файл автоматически загружается в контекст при старте каждой сессии.**
> Здесь — обзорная карта: что где лежит, как течёт сбор данных, где править.
> Детали — в комментариях внутри соответствующих файлов.

SaaS-аналитика для продавцов WB/Ozon. **Next.js 14** (App Router, порт 3200) +
**PostgreSQL** с row-level security (RLS) по `cabinet_id`. Мультитенант:
один инстанс → много клиентов, данные изолированы.

> ⚠️ **Кабинет для экспериментов = `cabinet #1` (ИП Матвеев, хозяин проекта).**
> Все тесты, пробы, отладочные правки, ручные проверки в БД — **только на #1**.
> Остальные активные кабинеты (`#1008` и т.д.) — **боевые кабинеты клиентов**:
> ничего не пишем, не гоняем воркер `--cabinet N`, не делаем upsert/DELETE в их
> данных без явного разрешения хозяина. Подробнее — в разделе «Состояние» внизу.

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
| `saas-stocks` | 08:00 | снимок остатков WB (`stocks-report/wb-warehouses`, с 2026-07-18 — старый `supplier/stocks` отключён WB, см. gotcha #11) + Ozon |
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
  **Список товаров `/unit` (с 2026-07-17)**: показывает **только active** — статус берётся
  из `tenant.item_status` через `statusMap()` из `lib/finItems.js`, с fallback `"active"`
  (как на странице «Себестоимость» `/items`). Отгрузки и продажи больше НЕ критерий
  попадания. `?includeInactive=1` в `/api/cabinets/[id]/unit/all` — показать и inactive.
  Правка чисто аддитивная (фильтр `.filter(r=>r.status==='active')` в конце computeWB/
  computeOzon, `app/api/cabinets/[id]/unit/all/route.js`). Для клиентов с пустым
  `item_status` (напр. #1008) — поведение не меняется (все → active по fallback).
  **Товары без продаж (с 2026-07-17, та же сессия):** в `computeWB` убрано требование
  `discount > 0` — теперь попадают модели с ценой, но без скидки (новые отгрузки, где WB
  отдаёт `wb_prices.discount=0`). Раньше условие было `price_seller>0 AND discount>0` →
  свеже-отгруженные без акции были невидны в юнитке. `calcWB` с `discount=0` корректен
  (`priceCabinet = priceSeller`).
  ⚠️ **Слепое пятно:** такие товары приходят БЕЗ себестоимости (`cost_overrides` пуст) →
  прибыль/маржа **завышены**. Чинится привязкой артикула на `/inventory` (создаёт override).
- **Налоги** (УСН/НДС): `lib/tax.js` (`normalizeTaxMode`). Хранятся per-shop
  в `auth.shops.tax_mode`.
- **Себестоимость закупки** (формулы «Себес товара», `/fin-purchases`,
  `computeExcel` в `app/api/cabinets/[id]/purchases/route.js`):
  `N=L×M, Q=O×P, R=Q−L, S=M×R, V=P×U, W=R×U+N, Z=W+(X+Y)×O, AA=Z/O`.
  **X и Y — обе «за единицу»** (с 2026-07-15): X=«Логист. до МСК/ед», Y=«Логист.
  МСК→ФФ/ед». Раньше код считал их «за партию» (без ×O) → AA занижался. Колонки
  БД: `logistics_rub_per_unit` (X), `logistics_rub` (Y) — имена не переименовывали.

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

### 🆕 Маршрут «Закупки → Склад/ФФ» (с 2026-07-15)

Рабочий процесс движения товара: партия закупки → завершить → остаток склада/ФФ →
привязка артикула МП → себестоимость течёт в расчёты.

**Таблицы (миграции 014, 015, 017):**
- `tenant.ff_inventory` — остатки склада/ФФ. Колонки: `cabinet_id, id, purchase_id`
  (ссылка-источник), `internal_name, qty, unit_cost` (себест. «до МП», ₽/ед), `category,
  platform, nm_id, product_id, sku_name, im_url, location_id` (ссылка на место),
  `completed_at, archived_at`. RLS. `location_type` оставлен как back-compat, но НЕ
  используется (тип берётся из места через `location_id`).
- `tenant.stock_ff_locations` — справочник мест хранения (переиспользована из старой
  ff-stock-модели). Колонки: `name, address, loc_type` ('stock'|'ff').
- `tenant.purchases` — добавлена колонка `archived BOOLEAN` (завершённые закупки скрыты
  из активных). Поле `location_type` в ff_inventory — back-compat (не трогать).

**Маршрут:**
1. На странице «Закупки» (`/fin-purchases`) — кнопка **«✓↧ склад»** в строке партии.
   → `POST /api/cabinets/[id]/purchases {action:"complete_to_stock", id}` копирует
   партию в `ff_inventory` (qty, unit_cost=AA, category) + ставит `purchases.archived=true`.
2. На странице «Остатки склад/ФФ» (`/inventory`) — позиция появляется. Можно:
   править qty/себест/категорию/имя inline, загрузить фото (data-URL, если нет артикула),
   выбрать место (`location_id`), привязать артикул МП.
3. **Привязка артикула** (`POST /api/cabinets/[id]/inventory {action:"link_sku"}`):
   выбираешь МП + nm_id/product_id → имя/фото подтягиваются из `wb_articles`/`ozon_products`
   + создаётся `cost_override` (effective_from = completed_at) → себестоимость **автоматически
   течёт в P&L, юнит-экономику, остатки на МП**.
4. Управление местами — кнопка «📍 Места» (`action:"locations"` op add/rename/delete).
5. Завершённые (archived) закупки скрыты из активных; чекбокс «архивные» показывает их.

**API `/api/cabinets/[id]/inventory`:** GET → `{items, totals, locations}`;
POST actions: `add` (ручная позиция), `link_sku`/`unlink_sku`, `update_qty`,
`update_field` (internal_name/category/unit_cost/im_url/location_id), `locations` (CRUD мест).

**Что НЕ ведётся:** авто-списание продажами (склад = накопитель приходов; списание —
будущая задача). Старая ломаная `/ff-stock` (snapshots-модель) не тронута, не используется.

**Удалено (миграция 016):** «Справочник товаров» — страница `/catalog`, API, `lib/catalogDb.js`,
таблицы `products_catalog` / `products_catalog_skus`. Привязка артикулов делается теперь
напрямую на остатках склада/ФФ. Бэкап кода: `/opt/agentsDB/backups/catalog_removed_*/`.

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

### ⚠️ Дополнительные грабли, найденные 2026-07-15

7. **D7 (Rules of Hooks):** `useMemo`/`useEffect` — ВСЕГДА ДО ранних `return` в
   клиентском компоненте. `if (loading) return ...; const x = useMemo(...)` ✗
   (число хуков меняется между рендерами → client-side exception). Решение:
   хуки в самом верху, данные с fallback (`data?.items || []`).
8. **D8 (ROUND в PG):** `ROUND(double_precision, 2)` НЕ существует в PG —
   `ROUND` принимает `numeric`. Решение: `ROUND((expr)::numeric, 2)`. Ловили на
   `/mp-stock` (`ROUND(qty*price, 2)` → ошибка). Проверка:
   `grep -rn 'ROUND([^)]*),' app/ | grep -v '::numeric'`.
9. **D9 (dangling `$N` в facet-запросах):** если API строит WHERE с `$1..$N` для
   основного запроса + переиспользует те же фрагменты для facet-запросов, но БЕЗ
   params → `there is no parameter $1`. Ловили на `/purchases`. Решение: единый
   `buildWhere(excludeTag)` с пересборкой `$N`+params для каждого запроса.
10. **D10 (action без id):** если POST-роут проверяет `if (!b.id) return error`
    ДО блока `action:"something"` (где id не нужен, напр. CRUD мест) → action
    всегда падает с «id required». action-блоки без id — ДО проверки id.
11. **Сборщик `wb_stocks` — миграция на новый endpoint (2026-07-18) + мягкая деградация:**
    старый endpoint `GET /api/v1/supplier/stocks` (statistics-api) **отключён WB** в конце
    июня/июле 2026 (release-notes #494/#431) — WB отдаёт на него `429` с телом
    `"This method is deprecated"`. Это НЕ rate-limit, а постоянное «метод устарел», поэтому
    любые retry бесполезны. Срез WB в БД замёрз на 2026-07-15, пока это не вскрылось при
    диагностике страницы `/stocks` (срез на 3 дня устарел).
    **Фикс:** миграция на новый endpoint `POST /api/analytics/v1/stocks-report/wb-warehouses`
    на хосте **`seller-analytics-api.wildberries.ru`** (модуль Analytics, не Supplier).
    Body: `{"isSupplyWarehouse": true, "isWBWarehouse": true}` (оба типа складов; без body →
    `400 "Request body is empty"`). Ответ: `{data:{items:[{nmId, chrtId, warehouseId,
    warehouseName, regionName, quantity, inWayToClient, inWayFromClient}]}}`.
    ⚠️ **Новый endpoint НЕ отдаёт `quantityFull`** — считаем сами:
    `quantity_full = quantity + inWayToClient + inWayFromClient`. Зато «в пути» теперь
    наполняется реальными значениями (старый endpoint в последние месяцы отдавал `inWay*=0`).
    **Мягкая деградация сохранена** (инцидент 2026-07-14): при недоступности WB API
    `wb_stocks`/`ozon_stocks` завершаются `exit 0`, снимок не пишется, но сервис не падает
    (чтобы ozon_stocks продолжал работать). Дополнительно `_fetch` теперь детектит
    `429 + detail:"deprecated"` в теле и сразу сдаётся, не loops'я retry'ями на мёртвый URL.
    Проверка: `python3 -c "import worker.collectors.wb_stocks as m; m._fetch=lambda:None; m.collect()"`.
    Сверка 2026-07-18 (cabinet #1): записано 150 строк, Σ qty=435, Σ qty_full=761
    (включая in_way_to=131, in_way_from=195). Формула quantity_full проверена.
12. **WB цена для остатков:** `wb_daily_metrics.price` НЕ наполняется сборщиком
    (пустая). Розничную цену WB брать из `wb_prices` (`price_seller × (1 − discount/100)`).
    Ловили на `/mp-stock` (сумма реализации WB = 0).
13. **D11 (pgp_sym_encrypt → text-колонка):** `pgp_sym_encrypt()` возвращает
    **бинарный `bytea`**. Колонки `api_creds_enc` — **`text`**. Если в Node-роуте
    написать `SELECT pgp_sym_encrypt($1,$2) AS enc` (без `::text`), node-pg получает
    **Buffer** и при записи обратно в text-колонку шлёт его бинарным параметром →
    PG валидирует сырые байты как UTF-8 → `invalid byte sequence ... 0xc3 0x0d`.
    Блокировало онбординг всех новых клиентов (cabinet #1 работал лишь потому,
    что `worker/_init_owner.py` шифрует SQL-side, где сервер сам кастует bytea→text
    в hex-форму `\xc30d...`). **Фикс:** всегда `pgp_sym_encrypt($1,$2)::text AS enc`
    — серверный cast даёт hex-строку, совместимую с text-колонкой И со стороной
    чтения `pgp_sym_decrypt(%s::bytea, %s)`. Round-trip идентичен формату cabinet #1,
    миграция НЕ нужна. Проверка: `grep -rn 'pgp_sym_encrypt' app/ lib/ | grep -v '::text'`
    → должно быть пусто. Латентно тот же баг был в `settings/route.js` (mpstats).
14. **D12 (путаница Ozon Seller Api-Key vs Performance Secret при вводе):** в поле
    «Api-Key» формы /settings клиент вставил 82-символьный **Performance
    Client-Secret** (префикс `Vsds-…`) вместо 36-символьного **Seller Api-Key**
    (UUID `xxxxxxxx-xxxx-…`). Форма и маппинг корректны (проверено round-trip и
    пересохранением на cabinet #1) — ошибка на стороне копирования/автозаполнения.
    Симптом: `Ozon API 400 [3]: Invalid Api-Key`. При новом онбординге Ozon стоит
    проверять длину/формат Api-Key (≠36 или начинается с `Vsds-` → предупреждение).
15. **D13 (тема/палитра — единый источник `lib/palette.js`, с 2026-07-16):** добавлена
    светлая/тёмная тема (next-themes, кнопка 🌙/☀️ в topbar). Палитра консолидирована:
    РАНЬШЕ ~30 страниц дублировали `const C = {...}` + hardcoded hex; ТЕПЕРЬ `C` и
    `soft()` импортируются из `lib/palette.js`, а значения — строки CSS-переменных
    (`C.surface = "var(--panel)"`), которые резолвит браузер при смене класса темы
    на `<html>`. Сами токены (`--bg`/`--panel`/... и алиасы `--surface`/`--ink`/...)
    лежат в `globals.css` в `:root,.dark{}` и `.light{}`.
    **Грабля (главная):** alpha-эффекты вида `${C.line}33` (бордеры, подсветки — было
    79 сайтов) **нельзя** заменить на `${C.line}` → `"var(--line)33"` = невалидный CSS,
    игнорируется. Решение — `color-mix(in srgb, var(--token) N%, transparent)` через
    helper `soft(token, pct)` из `lib/palette.js` (`${C.line}33` ≈ `${soft("line",20)}`).
    `color-mix` поддерживается в 2026 (Chrome 111+/FF 113+/Safari 16.4+). Проверка:
    `grep -rn 'var(--[a-z]*)[0-9A-F]\{2\}' app/ lib/` → должно быть пусто.
    **colorScheme:** нативные date/select-пикеры ранее хардкодились `colorScheme:"dark"`
    inline (~24 сайта) — теперь это `color-scheme` на корневых классах в `globals.css`
    (наследуется), inline-флаги удалены. `lib/theme.js` (тёмно-бирюзовая палитра) —
    **мёртвый код**, никем не импортируется, НЕ источник правды.
16. **D14 (НДС+УСН — выделение из цены, база УСН без НДС, фикс 2026-07-17):** реформа
    УСН+НДС 2025 (порог 60 млн ₽, ставки НДС 5% без вычетов / 7% с вычетами). WB/Ozon
    отдают выручку **с НДС** (сумма, что заплатил покупатель), поэтому корректно:
      • **НДС = revenue × vat/(100+vat)** — ВЫДЕЛЕНИЕ «изнутри» цены (для 5%: × 5/105;
        для 7%: × 7/107). НЕ `vat/100` (это начисление сверху — неверная модель базы).
      • **УСН = (revenue − НДС) × rate%** — от выручки **БЕЗ НДС** (поступивший НДС не
        признаётся доходом, ст. 248/346.15 НК РФ). Минимальный налог 1% — тоже от net.
      • **profit** должен вычитать **И УСН, И НДС** (`tax.total = usn + vat`).
    **Единый источник правды:** `lib/tax.js` (`calcVatTax` = выделение, `calcUsnTax`
    автоматически вычитает НДС из базы, `calcTotalTax().total` = УСН+НДС). Все агрегатные
    роуты используют `calcTotalTax(...).total` (НЕ `calcUsnTax` — он вернёт только УСН
    без НДС, profit будет завышен на сумму НДС).
    **Грабли (3 класса багов, все пофикшены 2026-07-17):**
    (a) **НДС не вычитался из profit** — раньше все роуты звали `calcUsnTax` (только УСН),
    `calcVatTax`/`calcTotalTax` были экспортированы, но мёртвые. Для cabinet #1 (vat=5)
    profit был завышен на ≈4.76% выручки (≈76 ₽ на каждый ₽ 1.6 млн). Фикс: 13 вызовов
    в 6 роутах (`overview`, `pnl`, `detail`, `rnp-summary`, `products-summary`, `unit`)
    переведены на `calcTotalTax(...).total`.
    (b) **УСН считался от выручки с НДС** — `calcUsnTax` раньше брал `revenue` как базу
    напрямую. Теперь он внутри вызывает `calcVatTax` и вычитает НДС. Backward-compatible
    для `vat=0` (база = revenue, поведение прежнее).
    (c) **`/unit/all` ломал дефолт `lib/unit.js`** — `taxRates()` передавал
    `vatRate = vat/100` (0.05), тогда как дефолт `TAX.VAT_RATE = 5/105` (модель выделения).
    Это инвертировало базу НДС/УСН при наличии shopTax. Фикс: `vatRate = vat/(100+vat)`
    (5 → 5/105, совпадает с дефолтом).
    (d) **detail per-day без расходов** (стр. 286 WB, 529 Ozon) — `calcUsnTax(taxMode, rev)`
    без третьего аргумента → для УСН Д−Р налог от полной выручки. Фикс: расходы дня
    добавлены (для WB — сумма day-компонентов, для Ozon — `max(0, rev − grossDay) + adDay`).
    (e) **P&L Ozon netProfit** — брался готовым из `order_costs.profit` БД (без вычета
    налога), тогда как WB вычитал. Теперь оба вычитают `tax` единообразно.
    **UI-лейблы:** раньше в 6 местах захардкожено «УСН 6%» / «НДС 5%» (OverviewClient,
    PnlPage, CalendarPage, DdsPage). Теперь Overview/P&L/Detail отдают `taxLabel` через
    `describeCombinedTaxMode({wb,ozon})` / `describeTaxMode` из `lib/tax.js` (pure,
    работает на клиенте); Calendar/DDS — нейтральный текст «УСН + НДС по режиму магазина».
    Проверки: `grep -rn 'calcUsnTax' app/api/ | grep -v '//'` → пусто (все на calcTotalTax);
    `grep -rn 'vat / 100\|vat/100' app/ lib/ | grep -v '//'` → пусто; `grep -rn 'УСН 6%\|НДС 5%'
    app/cabinets/ | grep -v 'option value'` → пусто.
    ⚠️ **Влияние:** для кабинетов с `vat=0` (большинство) цифры НЕ меняются. Для `vat≠0`
    (cabinet #1, новые с НДС) profit **уменьшается** на сумму НДС (≈4.76% выручки при 5%) —
    это исправление скрытого завышения, а не регрессия. Входной НДС от поставщиков НЕ
    учитывается (себестоимость cost_overrides считается чистой) — отдельная будущая задача.
    Бэкапы: `/opt/agentsDB/backups/vat_fix_20260717_192159/` (11 файлов).
    Источник: [ФНС — НДС при УСН](https://www.nalog.gov.ru/rn77/taxation/taxes/nds_usn/),
    [методичка ФНС](https://data.nalog.ru/html/sites/www.new.nalog.ru/files/about_fts/docs/15318056.pdf).

---

## 📍 Точка останова (2026-07-18 — мультисвязка артикулов + Отгрузки + Склады/индексы + фикс WB-сборщика)

**Сделано в сессии (4 доработки, все на боевой, сверены на cabinet #1):**

- ✅ **1. Мультисвязка артикулов на странице «Остатки склад/ФФ».** Раньше 1 позиция склада
  = 1 артикул МП (хранение прямо в 5 колонках `ff_inventory`). Теперь — таблица-связка
  `tenant.ff_inventory_skus` (миграция **023**): одна позиция ↔ много артикулов с разных МП
  (WB nm_id + Ozon product_id + дубли карточек). Primary (имя/фото строки) = первый по
  `created_at`. Контракт 2026-07-16 сохранён: `cost_overrides` НЕ трогается (привязка =
  только имя/фото для склада).
  - **Баг идемпотентности найден и починен в той же сессии:** обычный UNIQUE-индекс не
    ловит дубликаты, когда одна из колонок NULL (в PG `NULL != NULL`) — тот же WB-артикул
    можно было привязать много раз. Заменён на **два partial unique indexes** по платформе
    (`uq_ff_inventory_skus_wb` WHERE platform='wb', `_ozon` WHERE platform='ozon`).
    `ON CONFLICT DO NOTHING` (без указания колонок) корректно срабатывает по подходящему
    индексу. Бэкпорт: существующие привязки перенесены в новую таблицу.
  - Кнопка 📦 в строке /inventory → открывает новую форму отгрузки (см. п.2) с
    предзаполненной строкой.
  - UI: список бейджей в колонке «Артикул МП» (метка «осн.» для primary, ✕ отвязать
    каждый отдельно), модалка «+ ещё артикул».

- ✅ **2. Новая страница «Отгрузки» (`/shipments`).** Отгрузка = документ (№ поставки +
  дата + склад назначения + платформа) с составом из многих товаров. Миграция **024**:
  таблицы `tenant.ff_shipment_docs` (шапка) + `tenant.ff_shipment_lines` (строки). Старая
  `ff_shipments` (плоская, 1 строка = 1 товар) НЕ дропается — остаётся архивом; бэкпорт
  идемпотентен. Склад назначения = TEXT + datalist из собранных данных WB/Ozon
  (`SELECT DISTINCT warehouse`), без справочника.
  - API `/api/cabinets/[id]/shipments`: GET (документы с развёрнутыми `lines[]`) + POST
    `create`/`delete`. **Атомарно в одной транзакции `withTenant`**: списание остатков +
    INSERT doc + INSERT lines; при нехватке на любой строке — весь документ откатывается
    (проверено: `UPDATE … WHERE qty >= $1 RETURNING` → 0 строк → throw → ROLLBACK).
  - UI: таблица документов с раскрываемым составом, форма с многострочным составом
    («+ добавить товар», выбор из остатков с qty>0), предзаполнение из строки /inventory.
    `ShipmentFormModal` переиспользуется с обеих страниц.
  - История отгрузок переехала с /inventory на /shipments (на /inventory — ссылка
    «📋 Все отгрузки»).
  - Пункт меню «Отгрузки» в группе «Товары» (`layout.js`).

- ✅ **3. Страница «Склады и индексы» (`/stocks`) — реализация с нуля** (была заглушкой
  10 строк). 4 вкладки:
    • **Склады** — распределение остатков по складам WB/Ozon (%, стоимость, цветной бар).
    • **Индексы OOS** — дни до out-of-stock, оборачиваемость, статус
      (🔴out/🟠критично/🟡мало/🟢ок/⚪нет продаж).
    • **Динамика** — линейный график (recharts), 2 линии WB/Ozon.
    • **Финансы** — себест./реализация/маржа по складам.
  - Окно velocity (7/14/30/60 дней) выбирается на странице. Формула:
    `velocity = SUM(orders за N дней) / GREATEST(число дней с продажами, 1)` (устойчиво
    к провалам; NULL-заказы = 0). `days_to_oos = qty_full / velocity`.
  - `dead_capital` = Σ себест. товаров без продаж (KPI с подсветкой).
  - WB-динамика скрыта, если истории <7 дат (`wbTooShort=true`, предупреждение в UI).

- ✅ **4. Фикс WB-сборщика `wb_stocks.py` — миграция на новый endpoint.** Старый
  `GET /api/v1/supplier/stocks` отключён WB (429 + "deprecated", release-notes #494/#431).
  Срез WB в БД замёрз на 2026-07-15. Новый: `POST /api/analytics/v1/stocks-report/
  wb-warehouses` на хосте `seller-analytics-api.wildberries.ru`, body
  `{"isSupplyWarehouse":true,"isWBWarehouse":true}`. ⚠️ НЕ отдаёт `quantityFull` →
  считаем `quantity + inWayToClient + inWayFromClient`. Сверка: записано 150 строк,
  формула верна, «в пути» теперь наполняется реальными значениями (старый endpoint в
  последние месяцы отдавал `inWay*=0`). Gotcha #11 в AGENTS.md обновлена.

- ✅ **2 записи в «Что нового»** (shared.changelog, от 18 июля): «Несколько артикулов на
  одной позиции склада» (improvement ⚡) и «Новая страница Отгрузки» (feature ✨).
  Сайт «Склады и индексы» и фикс WB-сборщика в changelog не записывал — нет UI-фоновой
  заметимой пользователям фичи для первой, вторая — внутренний фикс. Если надо — добавлю.

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-18).
- Воркеры/таймеры — ✅ боевые. `wb_stocks` мигрирован, при следующем `saas-stocks.timer`
  (завтра 08:00) запишется свежий снимок WB в боевом режиме.
- `cabinet #1` — ✅ боевой, все сверки прошли, тестовые данные откачены. Остальные активные
  кабинеты (#1008 и новые) — **боевые клиентов, не трогать**.

**Бэкапы этой сессии** — `/opt/agentsDB/backups/*20260718*`:
- `inventory.route.js`, `purchases.route.js`, `InventoryPage.jsx` (мультисвязка)
- `layout.js`, `InventoryPage.jsx` (Отгрузки)
- `stocks.page.js` (Склады/индексы)
- `wb_stocks.py`, `AGENTS.md` (фикс WB + точка останова)
Новые файлы (миграции 023/024, shipments/, stocks/ UI, ff_inventory_skus.sql) — бэкапов не
имеют (созданы в сессии).

**Что НЕ закоммичено** (всё в working tree, решает хозяин):
- Мультисвязка (023 + route.js правки + UI) — отдельный коммит.
- Отгрузки (024 + новый роут + страница + интеграция с /inventory + layout.js).
- Склады/индексы (новый роут + страница + замена заглушки).
- Фикс `wb_stocks.py` + gotcha в AGENTS.md + расписание saas-stocks.
- 2 записи в changelog.

**Дальше (опц., не срочно):**
- Подождать ~4 дня накопления WB-истории (`saas-stocks` 1×/день) → график динамики WB на
  `/stocks` автоматически появится (правок кода не нужно).
- Расширить мультисвязку на автоматическое предложение артикулов (сейчас ввод руками).
- На странице «Отгрузки» — фильтр по дате/№ поставки/складу, пагинация (сейчас LIMIT 200).
- Ozon-аналог `ozon_stocks.py` формально не требовал миграции (endpoint жив), но при случае
  проверить, что Ozon тоже не в процессе депрекации.
- (Переносы) Валидация Ozon Api-Key в /settings (урок D12). `lib/theme.js` — мёртвый код.
  НДС-работа (урок D14) НЕ закоммичена (из предыдущих сессий).

---

## 📍 Точка останова (2026-07-17, вечер — кабинетные расходы WB)

**Сделано в сессии:**
- ✅ **Кабинетные расходы WB видны ежедневно + в «Сводке по прибыли»** (коммит `01451bd`).
  Раньше хранение/штрафы/подписки/продвижение WB не отражались нигде: raw-данные лежали
  в `wb_finance_report`, но таблица `wb_cabinet_costs` была пуста, а `/pnl` считал прибыль без них.
  - **Новый сборщик** `worker/collectors/wb_cabinet_costs.py` — чистый SQL-агрегатор
    `wb_finance_report → wb_cabinet_costs` по дням×типам (period=daily, заявка №28: дневной
    отчёт доступен на следующий день **без недельного лага**). Маппинг по
    `supplier_oper_name + bonus_type_name`: «Удержание» разделяется на
    `promotion/subscription/reviews/deduction_other` (gotcha #148 подтверждён боем —
    за 289 тыс. ₽ «удержаний» скрывались 4 разные услуги: Продвижение ~234к, Баллы за
    отзывы −43к (сторно-возврат), Подписка Джем 11к, утилизация 152₽). Возмещения и сторно
    отзывов — отдельные типы (`transport_compensation`, `pvz_compensation`, `reviews`).
    Идёт в `WB_COLLECTORS` после `wb_order_costs`, попадает в расписание `saas-worker` (4×/день).
  - **Починка бага карты таблиц** `lib/db.js`: добавлено `cabinet_costs → wb_cabinet_costs` /
    `ozon_cabinet_costs`. Без этого route `/cabinet-costs` SQL `FROM cabinet_costs` оставался
    голым именем (нет в карте `convertSql`) → молча падал в try/catch → WB-ветка всегда пуста.
  - **`/overview` фикс бага**: плитка «Хранение» читала `SUM(ABS(additional_payment))`, но WB
    кладёт суммы хранения в `storage_fee` → всегда 0. Заменено на `storage_fee`.
  - **`/pnl` расширение**: добавлены строки Продвижение WB / Подписки / Штрафы / Удержания
    прочие — вычитаются из чистой прибыли. «в т.ч. прочие доходы WB» (возмещения + сторно
    «Баллы за отзывы») — отдельная строка под чистой прибылью (приток, не входит в P&L-каскад).
    `grossProfit` не менялся (валовая маржа по SKU, без кабинетных расходов — контракт №27).
    Источник — прямо из `wb_finance_report`, по дате операции (при разбивке по неделям подписка
    попадает в неделю списания).
  - **Сверка (cabinet #1, 77 дней):** 8 типов расходов, все 8 совпали с raw до копейки
    (storage 15934, penalty 2880, promotion 234064, reviews −43515, subscription 11495,
    transport_compensation −22212, pvz_compensation −1525, deduction_other 152). netProfit
    упал с ~480к до **242к ₽** — реальная цифра с учётом всех списаний WB.
  - Бэкапы: `/opt/agentsDB/backups/{db.js,overview.route.js,orchestrator.py}.20260717_192101.bak`
    + `{pnl.route.js,PnlPage.jsx}.20260717_200008.bak`.
  - ⚠️ **Контракт №27 сохранён:** кабинетные расходы НЕ размазываются по марже SKU.
- ✅ **Граничный нюанс коммита:** `pnl/route.js` и `overview/route.js` содержат смесь моих
  правок кабинетных расходов и параллельной НДС-работы (урок D14, calcTotalTax/vat, см.
  предыдущую точку останова) в одних функциях — разделить нельзя. В коммите `01451bd` оба
  набора правок вместе. Остальная НДС-работа (detail/products-summary/rnp-summary/unit routes,
  fin-calendar, fin-dds, lib/tax.js) и untracked (support/whats-new/voice-expense/миграции 020-022)
  остались в working tree — не моя работа, не закоммичены.

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-17 ~20:00).
- Воркеры/таймеры — ✅ боевые. `wb_cabinet_costs` зарегистрирован, пойдёт в следующий прогон `saas-worker`.
- `cabinet #1` — ✅ боевой. Остальные активные кабинеты (#1008 и новые) — **боевые клиентов, не трогать**.

> ⚠️ **Кабинет для экспериментов = `cabinet #1` (ИП Матвеев, он же хозяин проекта).**
> Все тесты, пробы, отладочные правки и проверки — **только на #1**. Остальные активные
> кабинеты (`#1008` и любые новые) — **боевые кабинеты клиентов**, их не трогать:
> никаких пробных записей в `tenant.*`, отладочных прогонов воркера `--cabinet N`,
> ручных upsert/DELETE в их данных. Для проверки на живых данных клиента —
> запрашивать разрешение хозяина и всегда с бэкапом.

**Дальше:**
- (Опц.) **Расширить cabinet-costs на Ozon.** Сейчас в `/pnl` и `/cabinet-costs` Ozon-часть
  кабинетных расходов = 0 (источник `order_costs` их не даёт). Нужно найти Ozon API endpoint
  для подписок/штрафов и сделать сборщик → `ozon_cabinet_costs` (таблица и функция записи
  `upsert_cabinet_costs_many` для Ozon в `db_pg.py` уже готовы — проверить).
- (Опц.) **Premium Plus / кросс-докинг / недостача** — есть лейблы в `/cabinet-costs` LABELS,
  но эти источники НЕ приходят в `reportDetailByPeriod`. Нужен probe отдельного WB endpoint'а.
- (Перенос с 2026-07-16) Валидация Ozon Api-Key в /settings (урок D12).
- (Перенос с 2026-07-16) `lib/theme.js` — мёртвый код, можно удалить.
- НДС-работа (урок D14) не закоммичена — хозяин/другой агент должен закоммитить отдельно
  (detail/products-summary/rnp-summary/unit routes, fin-calendar, fin-dds, lib/tax.js).

---

## 📍 Точка останова (2026-07-17)

**Сделано в сессии:**
- ✅ **Юнит-экономика показывает только активные товары.** Раньше `/unit/all` собирал
  список из продаж/прайса (`wb_finance_report` ∪ `wb_prices`, Ozon — `orders` ∪
  `products`) — снятые с продаж товары мусорили в юнитке. Теперь статус `active|inactive`
  берётся из `tenant.item_status` (`statusMap()` из `lib/finItems.js`, fallback `"active"`)
  и фильтруется в `computeWB`/`computeOzon` (`app/api/cabinets/[id]/unit/all/route.js`).
  Query-парам `?includeInactive=1` возвращает прежнее поведение (для сверки/отладки).
  Бэкап: `unit_all.route.js.20260717_112406.bak`. Билд + рестарт `saas` сделаны.
  **Сверка (cabinet #1):** default → 81 item (17 WB + 64 Ozon, 0 inactive внутри ✅);
  `includeInactive=1` → 187 items (81 active + 106 inactive). Поведение клиентов с пустым
  `item_status` (напр. #1008) не изменилось — все активны по fallback.
- ✅ **В `computeWB` убрано требование `discount>0`** для товаров без продаж. Раньше
  новые модели с ценой, но без скидки (WB отдаёт `wb_prices.discount=0`) не попадали в
  юнитку. Теперь WB items 17 → **27** (+10 новых: экшн-камеры/видеорегистраторы nm_id
  1179xxxxxx–1181xxxxxx). ⚠️ Они пришли **без себестоимости** (`cost_overrides` пуст) →
  прибыль/маржа завышены. Чинится привязкой артикула на `/inventory`.
  Бэкап: `unit_all.route.js.20260717_113713.bak`. Билд + рестарт сделаны.
- ✅ **Памятка в AGENTS.md**: кабинет для экспериментов = `#1` (ИП Матвеев, хозяин).
  Остальные (#1008 и новые) — боевые клиентов, не трогать без разрешения. Вверху + внизу.
- ✅ **Корректный расчёт НДС + УСН (фикс 2026-07-17, урок D14).** Реформа УСН+НДС 2025:
  выручка WB/Ozon = сумма с НДС → НДС **выделяется** из цены (`vat/(100+vat)`, для 5%: ×5/105),
  УСН считается от выручки **без НДС** (ст. 248/346.15 НК РФ), profit вычитает И УСН, И НДС.
  Раньше `lib/tax.js` считал УСН от выручки с НДС, а НДС (`calcVatTax`) вообще не применялся
  в агрегатах → profit был завышен на сумму НДС (≈4.76% выручки при vat=5). Фикс:
  - **`lib/tax.js`** — `calcVatTax` = выделение; `calcUsnTax` автоматически вычитает НДС из
    базы (backward-compatible для vat=0); новый `describeCombinedTaxMode({wb,ozon})` для лейблов.
  - **6 роутов, 13 вызовов** (`overview`, `pnl`, `detail`, `rnp-summary`, `products-summary`,
    `unit`, `unit/all`) переведены с `calcUsnTax` → `calcTotalTax(...).total` (УСН+НДС).
  - **detail per-day** (стр. 286 WB, 529 Ozon) — добавлены дневные расходы (раньше `calcUsnTax`
    без 3-го аргумента → для УСН Д−Р налог от полной выручки).
  - **`/unit/all taxRates()`** — `vatRate = vat/(100+vat)` (раньше `vat/100` ломал дефолт `5/105`).
  - **P&L Ozon `netProfit`** — теперь вычитает налог (раньше брался из БД без вычета).
  - **UI-лейблы** (6 мест): захардкоженные «УСН 6%»/«НДС 5%» → динамические `taxLabel`
    (Overview/P&L/Detail) или нейтральный текст «по режиму магазина» (Calendar/DDS).
  Бэкапы: `/opt/agentsDB/backups/vat_fix_20260717_192159/` (11 файлов). Билд + рестарт `saas`.
  **Сверка (cabinet #1, WB+Ozon, 30д):** выручка ₽1.595M → НДС ₽75 956, УСН ₽91 147 (был ₽95 704
  от выручки с НДС), налог всего ₽167 103 (был ₽95 704), profit уменьшился на ₽75 956 (НДС).
  Скрининги AGENTS.md (D14) чисты. Не закоммичено.

---

## 📍 Точка останова (2026-07-16, вечер)

**Сделано в сессии:**
- ✅ **Переключатель тёмной/светлой темы** (next-themes + CSS-переменные). Кнопка 🌙/☀️ в
  topbar кабинета (`app/ThemeToggle.jsx`), дефолт — тёмная, выбор в localStorage.
  `next-themes@0.4.6` добавлен в deps. Билд + рестарт `saas` сделаны (HTTP 200 на :3200).
- ✅ **Палитра консолидирована** — единый источник `lib/palette.js` (`C` = строки
  `var(--token)`, helper `soft(token,pct)` для alpha через `color-mix`). Раньше ~30
  страниц дублировали `const C = {...}`. Все импортируют `{ C, soft }`.
- ✅ **79 alpha-сайтов** `${C.x}NN` → `${soft("x",N)}` (бордеры/подсветки) во всех
  клиентских страницах. Токены двух тем — в `globals.css` (`:root,.dark{}` и `.light{}`,
  включая алиасы `--surface`/`--ink`/`--line`/`--pos`/`--neg`/`--warn`/`--pink`).
- ✅ **Hardcoded hex** в `app/page.js`, `app/cabinets/page.js` → `var(...)`.
- ✅ **24 inline `colorScheme:"dark"`** удалены — нативные виджеты управляются корневым
  `color-scheme` в `globals.css` (наследуется в обе темы). Добавлен `suppressHydrationWarning`
  на `<html>`, `ThemeProvider` оборачивает children.
- ✅ **Все скрининги AGENTS.md** чисты (D3/D5/D11 + новый D13-чек `var(--x)NN`).

**Дальше:**
- **Не закоммичено.** В `git status`: ~34 изменённых файла + 3 новых (`ThemeProvider.jsx`,
  `ThemeToggle.jsx`, `lib/palette.js`). Коммитить или нет — решает хозяин.
- (Опц.) **Визуальная проверка светлой темы** на представительном: `/detail` (26 alpha-сайтов,
  самый тяжёлый), `/fin-calendar` (SVG-градиент `<stop stopColor="var(--accent)">` —
  единственное рисковое место для старых браузеров, в 2026 поддерживается). Если где-то
  контраст режет — точечная правка значений в `.light{}` блока globals.css.
- (Опц.) Кнопку темы можно добавить на landing/login/register/settings-хаб (сейчас только
  в topbar кабинета; тема всё равно применяется глобально через класс на `<html>`).
- (Перенос с 2026-07-15, всё ещё актуально) Валидация Ozon Api-Key в /settings (урок D12).
- `lib/theme.js` — мёртвый код (тёмно-бирюзовая палитра, никем не импортируется). Можно
  удалить отдельной задачей, если хочется чистоты.

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-16 ~19:05).
- Воркеры/таймеры — ✅ боевые, правок `.py` не было.
- `cabinet #1` — ✅ боевой. `cabinet #1008` — ✅ активен. `cabinet #1001/#1002` — provisioning.

> ⚠️ **Кабинет для экспериментов = `cabinet #1` (ИП Матвеев, он же хозяин проекта).**
> Все тесты, пробы, отладочные правки и проверки — **только на #1**. Остальные активные
> кабинеты (`#1008` и любые новые) — **боевые кабинеты клиентов**, их не трогать:
> никаких пробных записей в `tenant.*`, отладочных прогонов воркера `--cabinet N`,
> ручных upsert/DELETE в их данных. Для проверки на живых данных клиента —
> запрашивать разрешение хозяина и всегда с бэкапом.
- Бэкапы этой сессии — `/opt/agentsDB/backups/*20260716_18*` (29 пейдж-файлов) +
  `*colorscheme*20260716_1902*` (11) + `globals.css.20260716_185637.bak` + `*layout.js.20260716_190312.bak`.
