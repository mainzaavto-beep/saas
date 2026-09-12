# Ozon: позиции по запросам и трафик из кабинета продавца — дизайн

Дата: 2026-09-12. Статус: на согласовании владельца.

## 1. Зачем

Официальные API Ozon не отдают две вещи, без которых детальная сводка неполна:

1. **Позиции товара по поисковым запросам** и сами запросы, по которым покупатели видят
   товар (спрос, переходы, заказы по каждому запросу).
2. **Разложение трафика** по товару и дню: показы в поиске и каталоге против показов
   всего, просмотры карточки, переходы в корзину из поиска и из карточки, конверсии,
   а также ДРР и дни в Трафаретах по каждому SKU.

Оба набора есть только во внутреннем API кабинета продавца (seller.ozon.ru), под живой
сессией владельца. Эта спека описывает сбор этих данных в панель и их витрину.

**Разделение с ozon-panel (решение владельца 12.09.2026):** эта панель снимает
*статистическую* позицию по запросам раз в день (данные кабинета «Запросы моих
товаров»). *Оперативную* позицию в живой выдаче («объяснитель», с конкурентами и
ставками) владелец делает в ozon-panel сам; найденные точки для неё вынесены в §9
справочно.

Тепловая карта по часам (показы, корзины, заказы, реклама) в панели уже есть на
«Заказах по времени» (режим «По 30 минут», миграция 057). Кабинет часовых данных не
отдаёт (`charts/v3` с `granularity=hours` возвращает одну точку на день, проверено
12.09), поэтому эта страница в объём не входит.

## 2. Объём

В объёме:

- клиент кабинета в воркере панели (Playwright, сохранённый профиль браузера);
- два сборщика: `ozon_cabinet_search` (запросы и позиции по SKU) и
  `ozon_cabinet_traffic` (разложение трафика и ДРР по SKU);
- миграция 058: три таблицы `tenant.*` и две колонки в `auth.shops`;
- страница «Поиск и запросы» (`/cabinets/[id]/search`) и её API;
- блок «Трафик по дням» на «Детальной сводке» товара Ozon;
- истёкшая сессия кабинета: изоляция по образцу «сломанных ключей»;
- селф-тесты парсеров и гард регистрации сборщиков.

Вне объёма (бэклог, §10): живая выдача с конкурентами, рыночная частотность по всему
Ozon, бустинг и разбивка цены из кабинета, XLS-отчёты кабинета.

## 3. Источники данных (проверено живыми вызовами 12.09.2026)

Все вызовы — POST/GET на `https://seller.ozon.ru/api/...` с заголовками
`x-o3-app-name: seller-ui`, `x-o3-language: ru`, `x-o3-company-id: <company_id>`,
`content-type: application/json` из persistent-контекста Chromium с профилем владельца.
Правила запуска браузера — §4.2.

### 3.1 Запросы по SKU — `GET /api/search-query-analytics/v2/get-search-query-analytics-details`

Параметры: `sellerId`, `sku`, `periodFrom`, `periodTo` (RFC3339, `2026-09-10T00:00:00Z`),
`pageNumber` (с нуля). Страница фиксированно 10 запросов, `itemsPerPage` игнорируется,
`totalNumberOfQueries`/`totalPagesCount` всегда 0 — листаем, пока `queries` не пуст
(за окном данных приходит `status: NO_DATA`).

Семантика окна: правая граница **исключающая**, день `d` = `[d, d+1)`. Проверено:
`2026-09-10 → 2026-09-11` даёт дневные цифры («карта памяти»: позиция 72, спрос 1191),
`2026-09-08 → 2026-09-10` — сумму двух дней (спрос 2314). Самый ранний день —
`minStatisticsTime` из `GET /v1/get-dates?seller_id=` (сейчас 2026-08-04). Лаг: утром
12.09 день 11.09 ещё `NO_DATA` (появляется в течение суток).

Поля строки `queries[]`: `query`, `position` (средняя позиция товара по запросу за
окно), `uniqueSearchUsers` (спрос: сколько уникальных покупателей вводили запрос и видели
товар), `uniqueViewUsers` (просмотры карточки по запросу), `queryCtr`, `uniqueClickUsers`,
`orderCount`, `gmv`, `currency`, `queryIndex` (сквозной номер по убыванию спроса),
`competitorSku` (в v2 всегда `"0"`).

### 3.2 Сводка по всем SKU — `POST /api/search-query-analytics/v2/get-seller-items-search-query-analytics`

Тело: `{"sellerId","periodFrom","periodTo","itemsPerPage":200,"pageNumber":0}`. Отдаёт
все SKU с данными за окно (12.09: 66 SKU за неделю, 59 за 2 дня): `sku`, `name`,
`article`, `category`, `position` (средняя позиция в поиске по всем запросам),
`uniqueSearchUsers`, `uniqueViewUsers`, `queryCtr`, `gmv`, `showcasesVisibility`
(`SHOWCASES_VISIBILITY_BO` = виден на большом Ozon). Окно — те же правила, что §3.1.

### 3.3 Трафик по SKU — `POST /api/site/seller-analytics/charts/v3/table/by_sku`

Тело (как шлёт кабинет на «Продажи моих товаров»; поле `sort` обязательно и только
одним объектом — найдено при внедрении 12.09: без него кабинет отвечает 400
«sort is required», список вместо объекта тоже отклоняется):

```json
{"current_period":{"date_from":"2026-09-10","date_to":"2026-09-10"},
 "filters":{"desc_type_ids":[],"category_3_ids":[],"category_2_ids":[]},
 "limit":"30","offset":"0",
 "sort":{"key":"ordered_units","order":"DESC"},
 "metrics":["revenue","search_position","total_views","search_views","pdp_views",
            "hits_search_to_cart","hits_pdp_to_cart","total_hits_to_cart",
            "conv_search_views_to_pdp","conv_pdp_views_to_cart","conv_hits_to_cart_to_order",
            "conv_views_to_order","ordered_units","delivered_units","cancelled_units",
            "returned_units","avg_price","drr","days_in_trafarets","days_in_promo",
            "last_stock","stockout_days"]}
```

Здесь окно **включающее** (`date_from = date_to = день`), страницы по 30 SKU
(`offset` растёт на 30, пока `items` не пуст). Ответ `items[].productInfo{sku,name,
article,sources}` и `items[].metrics{revenue, searchPosition, totalViews, searchViews,
pdpViews, hitsSearchToCart, hitsPdpToCart, totalHitsToCart, conv*, orderedUnits,
deliveredUnits, cancelledUnits, returnedUnits, avgPrice, priceIndex, drr,
daysInTrafarets, daysInPromo, lastStock, lastStockFbo, lastStockFbs, stockoutDays}`.
`previous_period` и `*Dynamics` не нужны — динамику считает панель. Доступность
метрик зависит от подписки (у кабинета #1 Premium Plus); отсутствующие ключи пишутся
как `NULL`, не как 0.

Средняя позиция по SKU за день есть и здесь (`searchPosition`), и в §3.2 (`position`).
Канон для витрины — §3.2 (тот же источник, что и запросы); `searchPosition` из §3.3
хранится рядом как справочная и сторожится сверкой (§7).

### 3.4 Соответствие SKU → товар панели

Все три источника отдают Ozon `sku`; товары панели ключуются `product_id`. Маппинг —
`tenant.ozon_products` (сборщик `ozon_catalog`, поле `sku`), как в `ozon_metrics_30m`.
Таблицы §5 хранят **и `sku`, и `product_id`** (`product_id` NULL, если SKU нет в
каталоге — например, архивный товар; такие строки не теряются, витрина показывает их с
именем из ответа кабинета).

## 4. Архитектура

### 4.1 Доступ к кабинету — свойство магазина

Миграция 058 добавляет в `auth.shops`:

- `cabinet_company_id TEXT` — company_id кабинета (для #1 — `1428518`);
- `cabinet_profile_dir TEXT` — путь к профилю Chromium на сервере
  (для #1 — `/opt/agents/ozon-panel/backend/.pw-profile`);
- `cabinet_state TEXT NOT NULL DEFAULT 'none'` с CHECK `('none','ok','expired')`,
  `cabinet_last_error TEXT`, `cabinet_failed_at TIMESTAMPTZ`, `cabinet_notified_at
  TIMESTAMPTZ`.

Секретов здесь нет: профиль — файлы на диске сервера, доступные только root. В git
пути не попадают — заполняются SQL-ом руками владельца (как тарифы `billing.plans`).

Оркестратор: сборщики кабинета (`CABINET_COLLECTORS = {"ozon_cabinet_search",
"ozon_cabinet_traffic"}`) запускаются только для магазинов с `mp_code='ozon'` и
непустым `cabinet_profile_dir`; остальным пишется строка `skipped` с заметкой
`no_cabinet` в `jobs.collector_runs` (как `no_token`). Через `_env_for_shop`
пробрасываются `OZON_CABINET_COMPANY_ID` и `OZON_CABINET_PROFILE_DIR` (не секреты,
явно, как `SAAS_PROBE`). API-ключи Seller API этим сборщикам не нужны, но `OZON_*`
уходят по общей ветке — не мешают.

### 4.2 Клиент кабинета — `worker/cabinet_client.py`

Свой модуль в воркере (вариант 1 из обсуждения; импорт из ozon-panel и HTTP-прокси
отвергнуты как связка двух репозиториев). Один класс `CabinetClient(company_id,
profile_dir)`:

- `launch_persistent_context(profile_dir, headless=False, args=["--disable-blink-
  features=AutomationControlled", "--window-position=-2400,-2400"])`; окружение
  процесса: `DISPLAY=:99`, без `HTTP_PROXY`/`HTTPS_PROXY` (Chromium падает на
  прокси с авторизацией). Всё это выставляет `run_saas_collect.sh` в режиме `cabinet`
  (§4.4), сборщик ничего не наследует из общего env.
- Один контекст на прогон сборщика, все вызовы через `ctx.request.get/post` с
  заголовками §3. Таймаут вызова 60 с, ретраи как в `ozon_client`: сеть/5xx —
  2→4→8→16 с; 429 — 5→10→20→40 с.
- Ошибки: `CabinetAuthError` на 401/403 и на редирект в форму входа (тело не JSON);
  `CabinetBusyError`, если профиль занят другим процессом (Chromium не стартует из-за
  `SingletonLock`); `CabinetError` на прочее.
- **Только чтение.** Клиент умеет только GET/POST на перечисленные в §3 точки; методов,
  меняющих кабинет, в нём нет, и любая правка, добавляющая их, должна пройти ревью
  владельца (гард §7: список разрешённых путей — константа, тест проверяет, что клиент
  ходит только по ней).
- Профиль не копируется и не выгружается никуда.

Playwright ставится в отдельный venv воркера `worker/.venv-cabinet` (`playwright==1.62.0`,
та же версия, что в ozon-panel; браузер общий — `~/.cache/ms-playwright/chromium-1234`,
`playwright install` не запускать, чтобы не менять браузер под профилем панели).
Интерпретатор `worker/.venv-cabinet/bin/python` использует только режим `cabinet` в
`run_saas_collect.sh`; остальные сборщики по-прежнему идут системным `python3`.
`.venv-cabinet` — в `.gitignore`; установка описана в `deploy/install-systemd.sh`.

### 4.3 Один процесс на профиль

Профиль одновременно может открывать только один процесс. Три рубежа:

1. **Расписание мимо ozon-panel.** Панель ozon-panel синхронизируется через профиль в
   07:00 (`sync_time` в её конфиге). Таймер `saas-cabinet` — 06:00 и 20:00 MSK, оба
   тика по бюджету укладываются до 06:45 (§4.5).
2. **Свой замок.** Режим `cabinet` в `run_saas_collect.sh` берёт `flock` на
   `/run/lock/saas-cabinet.lock` (ждёт до 10 мин, иначе выходит кодом 75, как в
   методике коллеги `testing-discipline`), чтобы ручной запуск и таймер не
   пересекались. Сборщики внутри режима идут последовательно.
3. **Профиль занят** (`CabinetBusyError`, например ручной вход владельца или сдвиг
   синка панели): сборщик ждёт 60 с, повторяет до 5 раз, затем выходит кодом 3
   (partial) с заметкой `cabinet_busy` — прогон жёлтый, не красный; следующий тик
   доберёт (окно 3 дня, §4.5).

### 4.4 Расписание и регистрация

- `worker/orchestrator.py`: `ozon_cabinet_search`, `ozon_cabinet_traffic` в
  `OZON_COLLECTORS` (после `ozon_catalog` — нужен маппинг SKU) и в
  `PAUSE_EXEMPT_COLLECTORS` (пауза по API-ключам их не касается — у них своя
  авторизация); `CABINET_COLLECTORS` и проверка профиля из §4.1.
- `worker/run_saas_collect.sh`: режим `cabinet` → `CABINET_COLLECTORS=
  "ozon_cabinet_search,ozon_cabinet_traffic"`, `DAYS_FROM=3`, `DAYS_TO=1`, env
  `DISPLAY=:99`, `unset HTTP_PROXY HTTPS_PROXY`, интерпретатор `.venv-cabinet`, flock.
- `deploy/systemd/saas-cabinet.service` + `.timer` (`OnCalendar=*-*-* 06,20:00:00`,
  `Persistent=true`, `TimeoutStartSec=40min`, `OnFailure=saas-failure@%n`).
- `jobs.collector_runs.run_kind` — добавить `'cabinet'` в CHECK (по образцу миграции
  050 для `skuad`).
- Урок из памяти проекта: регистрация сборщика = оркестратор **и**
  `run_saas_collect.sh` — гард §7 проверяет обе.

### 4.5 Окно сбора и бюджет

Каждый тик пересобирает дни `[сегодня−3, сегодня−1]`: лаг кабинета до суток, плюс
запас на пропущенный тик. Upsert идемпотентен, повтор — no-op. Бэкфилл истории с
`minStatisticsTime` (04.08) — разовый ручной прогон `--date-from 2026-08-04`.

Бюджет вызовов на кабинет #1 за тик (3 дня):

| Сборщик | Вызовов | Оценка времени |
|---|---|---|
| `ozon_cabinet_search`: сводка §3.2 — 1/день; запросы §3.1 — ~66 SKU × ~5 страниц | ~1 000 | ~8 мин при 0,5 с на вызов |
| `ozon_cabinet_traffic`: §3.3 — 3 страницы/день | ~10 | секунды |

Порядок внутри `ozon_cabinet_search`: сначала сводка §3.2 за день — она даёт список
SKU с данными; запросы §3.1 тянутся только по этим SKU (у остальных всё равно
`NO_DATA`). Если сводка за день пуста (`items=[]`) — день ещё не готов, сборщик
пишет заметку `day_not_ready:<дата>` и идёт к следующему дню, не трогая БД.

Сборщик не портит БД до похода в сеть: ответы за день копятся в памяти, затем одна
транзакция «удалить строки дня по SKU из ответа + вставить» (правило из
`ozon_metrics`, AGENTS.md). Чужие SKU дня не трогаются.

### 4.6 Истёкшая сессия — изоляция по образцу «сломанных ключей»

`CabinetAuthError` → сборщик выходит кодом 5 и печатает в stderr последней строкой
маркер `CABINET_AUTH_EXPIRED: <причина>` (новый контракт: «отказ авторизации
кабинета»; текущая детекция `is_auth_error` по тексту относится к API-ключам и
состояние `auth_state` не трогает — у кабинета своё поле). Оркестратор ставит `auth.shops.cabinet_state='expired'`,
`cabinet_last_error`, `cabinet_failed_at`; строка в `collector_runs` — `skipped` с
`cabinet_expired`; прогон остаётся зелёным. Пока `expired`, оркестратор пропускает
сборщики кабинета, но **раз в сутки (тик 06:00) пробует снова** — владелец мог войти
заново; успех возвращает `'ok'`.

Владелец видит:

- баннер в шапке кабинета (рядом с баннером ключей): «Сессия кабинета Ozon истекла:
  откройте вход в кабинет на вкладке «Сервер» панели panel.sysell.ru или выполните
  `python -m app.cabinet_login`, позиции и трафик не обновляются с <дата>»;
- письмо через существующий таймер `saas-notify-keys` (одно письмо на эпизод,
  `cabinet_notified_at`);
- строку на `/health`.

Сам агент/воркер **никогда не логинится**: код подтверждения приходит владельцу.

## 5. Схема (миграция 058)

Все таблицы — RLS `tenant_iso_*` для `saas_app` и `panel_local_ro_cab1` для
`panel_local_ro`, как в 057.

```sql
CREATE TABLE tenant.ozon_search_queries_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,          -- день [d, d+1) по кабинету
    query         TEXT   NOT NULL,
    product_id    BIGINT,                   -- из ozon_products по sku; NULL — нет в каталоге
    position      INTEGER,                  -- средняя позиция по запросу за день
    search_users  INTEGER,                  -- uniqueSearchUsers: спрос
    view_users    INTEGER,                  -- uniqueViewUsers
    ctr           DOUBLE PRECISION,         -- queryCtr, %
    click_users   INTEGER,                  -- uniqueClickUsers
    orders        INTEGER,                  -- orderCount
    gmv           DOUBLE PRECISION,         -- ₽
    query_index   INTEGER,                  -- порядок по спросу в ответе кабинета
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date, query)
);
CREATE INDEX ON tenant.ozon_search_queries_daily (cabinet_id, date);
CREATE INDEX ON tenant.ozon_search_queries_daily (cabinet_id, query, date);

CREATE TABLE tenant.ozon_sku_search_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,
    product_id    BIGINT,
    name          TEXT, article TEXT, category TEXT,   -- как отдал кабинет (для SKU вне каталога)
    position      INTEGER,                  -- средняя позиция в поиске по всем запросам
    search_users  INTEGER, view_users INTEGER, ctr DOUBLE PRECISION, gmv DOUBLE PRECISION,
    showcases_visibility TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date)
);

CREATE TABLE tenant.ozon_sku_traffic_daily (
    cabinet_id    BIGINT NOT NULL,
    sku           BIGINT NOT NULL,
    date          DATE   NOT NULL,
    product_id    BIGINT,
    total_views INTEGER, search_views INTEGER, pdp_views INTEGER,
    hits_search_to_cart INTEGER, hits_pdp_to_cart INTEGER, total_hits_to_cart INTEGER,
    conv_search_to_pdp DOUBLE PRECISION, conv_pdp_to_cart DOUBLE PRECISION,
    conv_cart_to_order DOUBLE PRECISION, conv_views_to_order DOUBLE PRECISION,
    ordered_units INTEGER, delivered_units INTEGER, cancelled_units INTEGER, returned_units INTEGER,
    revenue DOUBLE PRECISION, avg_price DOUBLE PRECISION, price_index TEXT,
    drr DOUBLE PRECISION,                   -- ДРР по SKU за день, % (кабинет)
    days_in_trafarets INTEGER, days_in_promo INTEGER,
    search_position INTEGER,                -- справочно; канон — ozon_sku_search_daily.position
    last_stock INTEGER, last_stock_fbo INTEGER, last_stock_fbs INTEGER, stockout_days INTEGER,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, sku, date)
);
```

Хранение: без ретеншна (история позиций — ценность сама по себе; ~1 млн строк в год
на кабинет #1 в `ozon_search_queries_daily`). Пересмотреть при 10+ кабинетах с
профилями.

Колонки `auth.shops` — §4.1; `jobs.collector_runs.run_kind` — §4.4.

## 6. Витрина

### 6.1 Страница «Поиск и запросы» — `/cabinets/[id]/search`

Только Ozon (переключатель МП не нужен; для WB позиций нет — страница честно пишет
«только Ozon»). Период — `PeriodPicker` с дефолтами «по вчера» (контракт окон). Если
у магазина нет профиля или `cabinet_state='expired'` — пустое состояние с текстом
из §4.6 вместо таблиц.

Два уровня:

1. **Список SKU** (`ozon_sku_search_daily`, агрегат за период): товар (имя и фото из
   `ozon_products`, иначе имя кабинета), средняя позиция за период и дельта к прошлому
   окну, спрос (Σ search_users), просмотры, CTR, GMV; спарклайн позиции по дням.
   Сортировка по спросу (дефолт), по позиции, по дельте. Поиск по имени/артикулу.
2. **Карточка SKU** (раскрывается в строке, `?sku=`): матрица **запрос × день** из
   `ozon_search_queries_daily`: ячейка — позиция, цвет по шкале позиций (1–10 зелёный
   … >100 серый; `NULL` = запроса в этот день не было — пусто, не 0). Слева у
   запроса — спрос за период, CTR, заказы. Строки отсортированы по спросу; фильтр
   «минимальный спрос» (дефолт 0) и чекбокс «только с заказами». Закрепление ключа
   владельцем — не в этом этапе (бэклог), сортировка по спросу покрывает «самые
   высокочастотные».

KPI сверху: средняя позиция по кабинету (взвешенная спросом), число запросов с
позицией ≤ 10 / ≤ 50, спрос всего, заказы из поиска — и дельты к прошлому окну.

Правило «одна цифра везде»: заказы/GMV из кабинетной статистики поиска — это заказы
*по запросам*, они **не** равны заказам панели (`ozon_orders`) и не подаются как
таковые: подписи «заказов по запросу», «GMV по запросу»; в `lib/ozonMetrics.js`
ничего не меняется. Расчёты страницы — в новом `lib/ozonSearch.js` (чистые функции,
селф-тест), роут `app/api/cabinets/[id]/search/route.js` только читает БД и зовёт их.

Меню кабинета: пункт «Поиск и запросы» после «Детальной сводки».

### 6.2 «Детальная сводка» товара Ozon — блок «Трафик по дням»

В `app/api/cabinets/[id]/detail/route.js` (ветка Ozon) — чтение
`ozon_sku_traffic_daily` по `product_id` за период, отдельным ключом ответа `traffic`
(существующие поля не меняются). В `DetailPage.jsx` — новая карточка после воронки:
таблица по дням: показы всего / в поиске и каталоге / просмотры карточки, в корзину
из поиска / из карточки / всего, конверсии, ДРР (кабинет), дни в Трафаретах, позиция.
Итог за период и дельты к прошлому окну. Пустой блок с подсказкой, если данных нет
(нет профиля, день не собран).

ДРР по SKU из кабинета показывается с подписью «ДРР по данным кабинета Ozon» и **не
подменяет** ДРР панели (реклама ÷ заказы, решение владельца 08.09, `docs/metrics-
contract.md` §15.3): формулы у Ozon свои, сверка — в §7, решение о канонизации —
после недели наблюдений.

## 7. Сторожа и тесты

По методике `testing-discipline` (скил коллеги, установлен в `~/.claude/skills`):

- **Парсеры — чистые функции с фикстурами.** `parse_query_details(json) → rows`,
  `parse_items_summary(json)`, `parse_traffic_page(json)` в модулях сборщиков; тесты
  `worker/collectors/ozon_cabinet_selftest.py` на записанных ответах кабинета из проб
  12.09 (обезличивать нечего: это данные владельца в его же репозитории; ответы с
  чужими SKU/продавцами не сохраняем). Без сети и БД, миллисекунды.
- **Гард регистрации:** тест проверяет, что оба сборщика есть в `OZON_COLLECTORS`,
  `PAUSE_EXEMPT_COLLECTORS`, в `CABINET_COLLECTORS` режима `cabinet` в
  `run_saas_collect.sh`, и что режим `cabinet` использует `.venv-cabinet`,
  `DISPLAY` и снимает прокси (проверка исполнением вырезанного блока скрипта, а не
  текстом — правило методики).
- **Гард «только чтение»:** тест, что `cabinet_client.py` ходит только по путям из
  константы `ALLOWED_PATHS`, и ни один из них не содержит `set|update|delete|enable|
  add|remove`.
- **Сторож данных** `scripts/check-ozon-cabinet.sql`: (1) за каждый собранный день
  SKU в `ozon_sku_search_daily` ⊆ SKU в `ozon_search_queries_daily` и наоборот;
  (2) `|ozon_sku_search_daily.position − ozon_sku_traffic_daily.search_position| ≤ 5`
  для 90 % SKU дня (два источника одной величины) — **при внедрении 12.09 переведена в
  справочную, не гейт**: два эндпоинта кабинета считают позицию по-разному, медиана |Δ| ≈ 10,
  порог не проходит ни в один день; (3) сумма `search_users` по
  запросам SKU ≥ `search_users` сводки × 0,8 (запросы покрывают сводку); (4) нет дней
  без строк внутри собранного диапазона. Прогоняется после бэкфилла и в чек-листе.
- **Сверка ДРР:** неделя наблюдений `drr` кабинета против ДРР панели по SKU
  (`ozon_daily_sku_ad`) — таблица расхождений в отчёте по итогам, решение владельца.

## 8. Порядок внедрения (для плана)

1. Миграция 058 + колонки shops + `run_kind`; заполнение профиля для #1 SQL-ом.
2. `worker/cabinet_client.py` + venv + селф-тест клиента (ретраи, классы ошибок,
   гард путей).
3. `ozon_cabinet_search` (парсеры + запись + селф-тест) → проба `SAAS_PROBE=1`,
   затем ручной прогон за 3 дня, сторож.
4. `ozon_cabinet_traffic` — то же.
5. Регистрация: оркестратор, `run_saas_collect.sh`, systemd, гард регистрации;
   `cabinet_state` и баннер/письмо/`/health`.
6. Бэкфилл с 04.08, сторож, сверка ДРР запущена.
7. `lib/ozonSearch.js` + API + страница «Поиск и запросы».
8. Блок трафика на «Детальной сводке».
9. AGENTS.md, `docs/metrics-contract.md` (новые метрики и их «карта доверия»),
   память.

## 9. Справочно для ozon-panel: живая выдача («объяснитель»)

Не в объёме этой панели; точки проверены 12.09 и нужны владельцу для оперативных
позиций в ozon-panel. Заголовки — как в §3, семейство `external/*` принимает camelCase.

- `POST /api/search-query-analytics/v1/external/available_locations`
  `{"sellerId","prefix":"Москва"}` → `matchingLocations[]{title, uuid, latitude,
  longitude, areaId}` (Москва: `uuid 0c5b2444-70a0-4932-980c-b4dc0d3f02b5`).
- `POST /api/search-query-analytics/v1/external/explanation`
  `{"sellerId","query","skus":["<sku>"],"uuid":"<location uuid>","applicationScope":
  "SCOPE_BIG_OZON"}` → `{"explainId","status":"COMPLETED"}`. Локация — `oneof`:
  либо `uuid`, либо `coordinates{title,areaId,latitude,longitude}`, но не оба.
- `POST /api/search-query-analytics/v2/external/explanation_by_id` — те же поля плюс
  `"pageNumber":"1","itemsPerPage":50,"onlyCurSellerItems":true|false` → `headers[]`
  (position, itemInfo, finalScore, promotionStatus, promotionCpcRate,
  promotionCpoRate, textRelevance, reviews, price, generalPopularity,
  salePromotions, deliveryPeriod, priceIndex), `items[]{sku, isCurSellerItem,
  isExactSku, foundWithQuery, isTraforetto, values[]}` (ячейки по порядку
  `headers`), `totalNumberOfItems` (108 для «карта памяти»), `totalPagesCount`,
  `expiredAt`. С `onlyCurSellerItems=true` — только наши SKU (позиция 144 у карты
  памяти в Москве утром 12.09).
- `POST /api/search-query-analytics/v1/external/explain_suggest`
  `{"sellerId","skus":["<sku>"],"filter":""}` → `top.queries[]{text, searchesCnt}` —
  топ запросов SKU за прошлую неделю (спрос — строка с пробелами: `"7 723"`).
- Рыночная частотность: `POST /api/site/searchteam/Stats/queries/search/v2`
  `{"text":"","limit":"50","offset":"0","sort_by":"count","sort_dir":"desc",
  "period":"days_7"}` → `data[]{query, count, ord, gmv, uniqSellers, dynamicsIn7,
  dynamicsIn28, …}`; `text` — поиск по подстроке.
- Средняя позиция по SKU за период: `POST /api/pricing-bff-service/v1/get-mean-
  search-position-by-skus` `{"company_id","skus":[…]}` → `sku_search_positions[]
  {sku, mean_position}`; по дням — `POST /api/site/seller-analytics/charts/v3`
  с `"metrics":["search_position_graph"]` (не больше 2 метрик за вызов), `skus`,
  `granularity:"days"`.

Семейство `cjm/*` (`get-top-queries-by-sku` и др.) требует `metric_type`, значения
enum в бандлах не найдены (`METRICS_TYPE_UNKNOWN`) — не использовать без разведки.

## 10. Бэклог

- Закрепление/скрытие ключей владельцем на странице «Поиск и запросы».
- Живая выдача в этой панели (если ozon-panel не закроет потребность).
- Рыночная частотность (`Stats/queries/search/v2`) для подбора *новых* ключей.
- Бустинг и разбивка цены из кабинета (`get-boosting-info`, `get-elastic-boosting-
  by-item-id`, `get-common-prices`) — сейчас частично собирает ozon-panel.
- Второй кабинет с профилем (#1008): нужен вход владельца того кабинета на этом
  сервере; архитектурно готово (§4.1).
