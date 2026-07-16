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
| `saas-stocks` | 08:00 | снимок остатков (с 05:00 с 2026-07-15: WB рано утром уходит в 429 и отдаёт неполные склады) |
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
11. **Сборщик `wb_stocks` и rate-limit (инцидент 2026-07-14):** endpoint
    `supplier/stocks` WB уходит в жёсткий 429, особенно рано утром. Раньше
    `RuntimeError` после 5 попыток валил весь `saas-stocks.service` (вместе с
    успешным ozon). Теперь `wb_stocks`/`ozon_stocks` при недоступности WB API
    завершаются `exit 0` с предупреждением (мягкая деградация). Проверка фолла:
    `python3 -c "import worker.collectors.wb_stocks as m; m._fetch=lambda:None; m.collect()"`.
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
- Бэкапы этой сессии — `/opt/agentsDB/backups/*20260716_18*` (29 пейдж-файлов) +
  `*colorscheme*20260716_1902*` (11) + `globals.css.20260716_185637.bak` + `*layout.js.20260716_190312.bak`.
