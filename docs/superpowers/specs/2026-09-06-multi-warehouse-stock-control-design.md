# Склады 2.0 — контроль остатков и отгрузок при многих ФФ и схемах FBO/FBS

Дата: 2026-09-06. Статус: утверждена владельцем (сессия 06.09), ждёт реализации по этапам.

## Цель

Владелец (и типовой клиент) работает по FBO и FBS на WB и Ozon с **несколькими
фулфилментами (ФФ) в разных городах**. Каждый ФФ — одновременно буфер для поставок на
FBO-склады маркетплейсов и FBS-склад продавца для своего региона. Нужен один раздел,
где утром видно:

1. сколько товара лежит в каждом месте — по своему учёту и по данным МП, и где они разошлись;
2. где товар кончается (по ФФ для FBS и по FBO-складам МП) и с какого ФФ его довезти;
3. что с поставками на FBO: отгружено → принято, и сколько недосчитались.

Решения владельца (06.09):

| Вопрос | Решение |
|---|---|
| Физика | Несколько ФФ по городам, каждый = буфер FBO + FBS-склад региона |
| Источник правды по ФФ | **Оба контура**: свой учёт в панели + снимок FBS-остатков с МП; расхождение = сигнал |
| Поставки FBO | Полный цикл: рекомендация → документ → факт приёмки |
| Привязка складов МП к ФФ | Руками, один раз, в справочнике мест; один склад МП → одно место |
| Ежедневный экран | Матрица «товар × место» + карточки мест |
| Модель учёта | **Журнал движений поверх текущих остатков** `ff_inventory` (вариант А) |
| Позиция своего склада | Может иметь **обе** привязки (`nm_id` и `product_id`) одновременно |

## Что уже есть (осмотр 06.09)

| Есть | Где | Пробел |
|---|---|---|
| Снимки FBO-остатков по складам МП | `tenant.wb_daily_stock` (stocks-report, `warehouse_id` есть), `tenant.ozon_daily_stock` (stock_on_warehouses) | FBS-остатки складов продавца не собираются (Ozon точно; WB — см. пробу в этапе 1) |
| Свой склад/ФФ | `tenant.ff_inventory` (партии с qty, unit_cost, location_id, одна привязка nm_id **или** product_id), `tenant.stock_ff_locations` (name, address, loc_type) | Нет журнала движений, нет авто-списания, места не связаны со складами МП |
| Отгрузки на МП | `tenant.ff_shipment_docs` + `ff_shipment_lines` (склад назначения текстом, списание при создании) | Нет статусов, нет связи с фактом приёмки, нет «откуда» |
| Поставки WB | `tenant.wb_supplies` (created/closed/scan/reject, destination_office_id) | Поставки Ozon на FBO не собираются |
| FBS-задания WB | `tenant.wb_fbs_tasks` (rid, supply_id, nm_id, статусы часовым опросом) | `warehouse_id` задания не сохраняется |
| FBS-постинги Ozon | `tenant.ozon_orders` (`scheme='fbs'`, `warehouse_id`) | Проверить заполненность `warehouse_id` у FBS |
| Рекомендации перемещений WB | `buildReallocRecommendations` в `stocks/route.js`, страница `/move` | Только склад WB → склад WB, ФФ как источник не учитывается |
| Справочники | `shared.wb_warehouses` (регион), `shared.ozon_clusters` | Нет складов продавца |

## Утверждённый подход

Журнал движений `stock_moves` поверх `ff_inventory.qty`; все изменения количества — через
одну функцию `applyMove()`; FBS-заказы списываются автоматически по привязке «склад продавца
на МП → место»; расхождение со снимком МП считается на лету; поставки FBO — рекомендация по
дефициту на складах МП с ближайшего ФФ, документ со статусами, связь с фактом приёмки из
`wb_supplies` / `ozon_supply_orders`. Витрина — новая страница `/warehouses` с тремя
вкладками: Матрица, Места, Поставки.

Отвергнуто: чистый леджер (переписывать `/inventory`, `/shipments`, закупки и мигрировать
остатки — недели до первой пользы); только снимки с МП без своего учёта (не даёт расхождения).

## 1. Справочник мест и склады продавца на МП

### 1.1 `tenant.stock_ff_locations` — новые колонки

| Колонка | Тип | Смысл |
|---|---|---|
| `wb_warehouse_id` | BIGINT NULL | склад продавца WB (marketplace-api `/api/v3/warehouses`) |
| `ozon_warehouse_id` | BIGINT NULL | склад продавца Ozon (`/v2/warehouse/list`, FBS-тип) |
| `city` | TEXT NULL | город места; используется для выбора ближайшего ФФ |
| `is_active` | BOOLEAN NOT NULL DEFAULT true | неактивные места не участвуют в рекомендациях |

Частичные уникальные индексы `(cabinet_id, wb_warehouse_id) WHERE wb_warehouse_id IS NOT NULL`
и аналогично для Ozon: один склад МП — не более одного места.

### 1.2 `tenant.mp_seller_warehouses` — справочник складов продавца

`cabinet_id, platform ('wb'|'ozon'), warehouse_id, name, kind, is_active, first_seen_at,
last_seen_at`; PK `(cabinet_id, platform, warehouse_id)`. RLS + политика `panel_local_ro_cab1`.
Заполняет сборщик `mp_seller_warehouses` (в `saas-references.timer`, Mon 06:00, и один раз при
онбординге). `kind` для Ozon — тип склада из ответа (fbs / rfbs / dbs), для WB — `deliveryType`.

Склад, который есть в справочнике, но не привязан ни к одному месту, показывается в
карточках мест как «не привязан» (красным).

### 1.3 Что не делаем

- Сопоставление FBO-складов МП с местами: FBO-склад не место продавца, остаётся в
  `*_daily_stock`. Для рекомендаций хватает `city` места и региона/кластера склада МП.
- Несколько магазинов одной площадки на одном ФФ (у места один `wb_warehouse_id` и один
  `ozon_warehouse_id`). Расширим, когда появится такой клиент.

## 2. Сбор данных (воркер)

### 2.1 `tenant.mp_fbs_daily_stock` — снимок FBS-остатков с МП

`cabinet_id, platform, warehouse_id, sku_key BIGINT, date, present INT, reserved INT,
updated_at`; PK `(cabinet_id, platform, warehouse_id, sku_key, date)`. `sku_key` = `nm_id` для
WB, `product_id` для Ozon. Пишется в `saas-stocks.timer` (08:00) рядом с FBO-снимками.
Ретеншн не режем: таблица маленькая (склады продавца × товары).

### 2.2 WB — проба в первый час этапа 1

Кандидаты, выбирается живой пробой на кабинете #1:

1. `stocks-report/wb-warehouses` с `isSupplyWarehouse:true` уже отдаёт склады продавца.
   Проверка: `warehouse_id` строк снимка ∩ id из `/api/v3/warehouses` ≠ ∅. Тогда сборщик
   `wb_stocks` только копирует строки складов продавца в `mp_fbs_daily_stock`
   (`present = quantity`, `reserved = NULL`), новых запросов к WB нет.
2. Иначе marketplace-api `POST /api/v3/stocks/{warehouseId}` со списком штрихкодов
   (`skus`). Штрихкоды: `wb_orders.barcode` (distinct по nm_id) + карточки из `wb_catalog`.
   Ответ `stocks[{sku, amount}]` → агрегируем по nm_id. Один запрос на склад, лимит
   1000 sku в теле — пагинируем.

**Результат пробы (06.09.2026):** выбран вариант 2 — marketplace-api по штрихкодам.
`stocks-report/wb-warehouses` с 01.09.2026 отдаёт одну строку «Склад WB»
(`warehouse_id=-999999`), WB скрыл разбивку по складам продавца — вариант 1 недоступен.
`POST /api/v3/stocks/{warehouseId}` работает; источником штрихкодов для запроса стала новая
таблица `tenant.wb_barcodes` (из карточек Content API `sizes[].skus`), а не
`wb_orders.barcode`. Сверка `SAAS_PROBE=verify`: Δ = 0 (113 строк, 9 складов продавца).

### 2.3 Ozon

`POST /v1/product/info/stocks-by-warehouse/fbs` с `sku[]` (`ozon_products.fbo_sku`; с 2024
sku единый для FBO/FBS). Ответ: `result[{sku, warehouse_id, warehouse_name, present,
reserved}]`. sku → product_id через `ozon_products`. Пачки по 100 sku (лимит эндпоинта
проверить пробой; при 400 — уменьшить).

**Проба 06.09.2026:** `/v1` отключён Ozon (400, code 9 «obsolete method») — сборщик переведён
на `POST /v2/product/info/stocks-by-warehouse/fbs` (тело `limit`/`cursor` + `sku[]`, ответ
`products`/`has_next`/`cursor`). Пачки по 100 sku с пагинацией по курсору. Сверка
`SAAS_PROBE=verify`: Δ = 0 (80 строк, 5 из 8 складов).

### 2.4 Мягкая деградация

Как у `wb_stocks`/`ozon_stocks`: API недоступен → снимок пропущен, exit 0, запись
`collector_runs` со статусом `partial` и причиной.

### 2.5 Дополнения в существующих данных

- `tenant.wb_fbs_tasks` + `warehouse_id BIGINT` (из `/v3/orders` поле `warehouseId`).
  Бэкфилл: сборщик `wb_fbs_tasks` пересобирает историю за окно (как при первичном сборе).
- Проверено 06.09: `warehouse_id` у FBS-постингов заполнен, правка не нужна; сторож —
  проверка 5 `check-warehouses-stage1.sql`.

### 2.6 `tenant.ozon_supply_orders` — поставки Ozon на FBO

Сборщик `ozon_supply_orders`: `/v3/supply-order/list` и `/v3/supply-order/get` (обязательные
`filter.states` и `sort_by`, курсор `last_id`) + `/v1/supply-order/bundle` (состав; только для
незавершённых заказов). Таблицы:

- `ozon_supply_orders`: `cabinet_id, order_id, number, state, created_at, timeslot_from,
  timeslot_to, dest_warehouse_id, dest_warehouse_name, updated_at`; PK `(cabinet_id, order_id)`.
- `ozon_supply_order_items`: `cabinet_id, order_id, sku, product_id, qty_declared,
  qty_accepted`; PK `(cabinet_id, order_id, sku)`.

Расписание — в основном прогоне рядом с `wb_supplies` (`MAIN_COLLECTORS` в
`worker/run_saas_collect.sh`). Регистрация сборщика: **и** `orchestrator.py`, **и**
`run_saas_collect.sh` (урок из памяти).
Аналог `wb_supplies`; собираем с этапа 1, чтобы к этапу 3 накопилась история.

**Проба 06.09.2026:** `/v2/supply-order/list` и `/v2/supply-order/get` отдают 404 — переведено
на `/v3/supply-order/list` и `/v3/supply-order/get` (обязательные `filter.states` 1..11 и
`sort_by`, курсор `last_id`, без top-level `warehouses[]`; склад назначения берётся из
`supplies[].storage_warehouse`). `/v1/supply-order/bundle` без изменений, тянется только для
незавершённых заказов (`TERMINAL_STATES`: `COMPLETED`/`CANCELLED`/`OVERDUE` с уже известным
составом пропускаются). Принятое количество (`qty_accepted`) в API не отдаётся ни на одном из
эндпоинтов — остаётся `NULL`, вводится руками из отчёта приёмки на этапе 3. Сверка с ЛК: панель
445 заказов всего, 14 за последние 90 дней; сверка с ЛК Ozon «Поставки → Заказы» — ждёт
владельца.

## 3. Свой учёт: журнал движений

### 3.1 Двойная привязка позиции

`ff_inventory.nm_id` и `product_id` могут быть заполнены одновременно. `link_sku` для второй
площадки дописывает вторую привязку и не трогает первую; `unlink_sku` принимает платформу.
`platform` остаётся для совместимости: у новой позиции = первая привязанная площадка.
`cost_override` создаётся для каждой привязки (как сейчас для одной).

### 3.2 `tenant.stock_moves`

| Колонка | Тип | Смысл |
|---|---|---|
| `cabinet_id`, `id` | BIGINT, BIGSERIAL | PK |
| `ff_inventory_id` | BIGINT NOT NULL | позиция |
| `location_id` | BIGINT NOT NULL | место на момент движения |
| `kind` | TEXT NOT NULL | `in` · `out_fbo` · `out_fbs` · `transfer_out` · `transfer_in` · `adjust` · `return_in` |
| `qty` | INTEGER NOT NULL | со знаком (приход +, списание −) |
| `src_kind` | TEXT NOT NULL | `purchase` · `ff_shipment_doc` · `wb_fbs_task` · `ozon_posting` · `transfer_doc` · `manual` · `wb_fbs_return` · `ozon_return` |
| `src_ref` | TEXT NOT NULL | id/rid/posting_number источника |
| `moved_at` | TIMESTAMPTZ NOT NULL | момент движения (для FBS — время статуса задания) |
| `note` | TEXT | комментарий (обязателен для `adjust`) |
| `created_by` | BIGINT NULL | user_id, NULL для воркера |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Уникальный индекс `(cabinet_id, src_kind, src_ref, kind)` — повторный прогон идемпотентен
(одно задание списывается один раз; отмена того же задания — отдельный `kind`).
RLS + `panel_local_ro_cab1`. Индексы по `(cabinet_id, ff_inventory_id)` и `(cabinet_id, moved_at)`.

### 3.3 `applyMove()` — единственная точка записи

`lib/stockLedger.js`:

```
applyMove(cid, { ffInventoryId, kind, qty, srcKind, srcRef, movedAt, note, userId })
  → в одной транзакции: INSERT stock_moves; UPDATE ff_inventory SET qty = qty + :qty
  → при qty < 0 после обновления — откат и ошибка 'insufficient' (кроме kind='adjust')
  → при конфликте уникальности источника — no-op, возвращает {duplicate:true}
applyTransfer(cid, { ffInventoryId, toLocationId, qty, docId, ... })
  → transfer_out у исходной позиции + transfer_in у позиции на месте назначения
    (ищется по (nm_id|product_id, location_id, unit_cost); нет — создаётся копия строки)
```

Все существующие правки переводятся на `applyMove`: `complete_to_stock` → `in`; создание
документа отгрузки → `out_fbo`; ручной `update_qty` → `adjust` с обязательным комментарием
(UI просит причину). Прямых `UPDATE ff_inventory SET qty` в коде не остаётся.

Воркер пишет движения на Python через ту же логику (`worker/stock_ledger.py`, тот же SQL, тот
же уникальный индекс) — правило «одна точка» соблюдается на уровне SQL-контракта, не языка.

**Начальное сальдо.** Миграция создаёт по одному движению `adjust` («начальное сальдо
06.09.2026», `src_kind='manual'`, `src_ref='opening:<id>'`) на каждую строку `ff_inventory`
с `qty ≠ 0`, чтобы сторож «qty = сальдо журнала» проходил с первого дня.

**Сторож в `/health`**: `ff_inventory.qty ≠ SUM(stock_moves.qty)` по позиции → строка в
списке проблем с количеством расхождений.

### 3.4 Авто-списание FBS — шаг воркера `fbs_writeoff`

Запускается после часового опроса статусов заданий WB (`wb_fbs_status`) и после сбора
постингов Ozon.

- **WB**: задание в `wb_fbs_tasks` со статусом «собрано / передано в доставку» (не «новое»,
  не «отменено») и без движения `out_fbs` → место по `warehouse_id` задания
  (`stock_ff_locations.wb_warehouse_id`) → позиция по `nm_id` на этом месте; несколько партий —
  FIFO по `completed_at` → `out_fbs −1`, `src_kind='wb_fbs_task'`, `src_ref=rid`.
- **Ozon**: FBS-постинг в статусе `awaiting_deliver` и дальше → место по `warehouse_id`
  (`ozon_warehouse_id`) → позиция по `product_id`, qty из строки постинга → `out_fbs`,
  `src_kind='ozon_posting'`, `src_ref=posting_number` (при нескольких товарах в постинге —
  `posting_number:sku`).
- **Отмена после списания** → `return_in` с тем же `src_ref` (уникальность по kind позволяет).
- **Возврат покупателем** (WB `wb_sales` возврат по srid, Ozon возвраты) → `return_in`,
  `src_kind='wb_fbs_return'|'ozon_return'`.
- **Нет места для склада МП / нет позиции на месте / позиций не хватает** → движение не
  создаётся, строка в `tenant.stock_move_gaps` (`cabinet_id, src_kind, src_ref, platform,
  warehouse_id, sku_key, qty, reason ('no_location'|'no_item'|'insufficient'),
  first_seen_at, resolved_at`). Повторный прогон закрывает gap (`resolved_at`), когда
  движение удалось создать. Это сигнал в карточке места.

### 3.5 Расхождение с МП

Считается на лету, не хранится: для (место, товар) `own_qty` = `SUM(ff_inventory.qty)` по
позициям с этой привязкой на этом месте против `present` из последнего снимка
`mp_fbs_daily_stock` по привязанному складу той площадки. Пара показывается отдельно для WB
и Ozon. Расхождение = `own_qty − present`; порог показа — любое ≠ 0.

### 3.6 Перемещение ФФ → ФФ

`tenant.ff_transfer_docs` (`cabinet_id, id, from_location_id, to_location_id, moved_at, note,
created_at, created_by`) + `ff_transfer_lines` (`doc_id, ff_inventory_id, qty`). Создание —
`applyTransfer` по строкам в одной транзакции; нехватка на любой строке — откат всего
документа (как в отгрузках). Без стадии «в пути» — перемещение мгновенное.

## 4. Поставки FBO: рекомендация → документ → факт

### 4.1 `buildSupplyPlan()` — `lib/supplyPlan.js`

Вход: кабинет, настройки (`target_days` = 30, `min_days` = 14, по умолчанию; хранятся в
настройках кабинета), сегодня. Логика дефицита переиспользует расчёт скорости и покрытия из
`buildReallocRecommendations` (выносится в `lib/stockCoverage.js`, `stocks/route.js`
переключается на него).

Для каждого товара × FBO-склад МП (WB по `wb_daily_stock` + `shared.wb_warehouses`, Ozon по
`ozon_daily_stock` + `shared.ozon_clusters`):

1. скорость = заказы за 28 дней по этому складу / 28 (`wb_orders.warehouse` /
   `ozon_orders.warehouse_id`);
2. покрытие = (остаток + в пути к складу) / скорость, дней;
3. покрытие < `min_days` → нужно `ceil(target_days × скорость − остаток − в пути)`,
   округление вверх до кратности упаковки (`ff_inventory.pack_qty`, новая колонка этапа 3,
   NULL = 1);
4. источник — активные места с `SUM(qty) > 0` по товару, отсортированные по близости:
   `city` места совпадает с регионом склада WB / кластером Ozon → 0, иначе 1;
   при нехватке на первом — второй; остаток «не покрыто» показывается явно;
5. группировка в черновики по паре (место → склад МП).

Скорость 0 → рекомендации нет. Склады МП, где нет остатка и нет продаж за 28 дней, не
рассматриваются.

### 4.2 `tenant.ff_shipment_docs` — расширение

| Колонка | Смысл |
|---|---|
| `location_id BIGINT` | откуда (место); у старых документов NULL |
| `dest_warehouse_id BIGINT` | склад МП по справочнику (`shared.wb_warehouses.id` / Ozon warehouse_id); `dest_warehouse` TEXT остаётся отображением |
| `status TEXT` | `draft` · `shipped` · `accepted` · `partial` · `rejected`; старые документы = `shipped` |
| `shipped_at TIMESTAMPTZ` | момент списания |
| `mp_supply_id TEXT` | `wb_supplies.supply_id` или `ozon_supply_orders.order_id` |

`ff_shipment_lines` + `qty_accepted INTEGER NULL`.

Списание с ФФ — при переходе `draft → shipped`, через `applyMove(kind='out_fbo',
src_kind='ff_shipment_doc', src_ref=doc_id:line_id)`. Удаление документа в статусе `shipped`
и выше запрещено; `draft` удаляется свободно. Откат `shipped` документа — только через
`adjust` с комментарием.

### 4.3 Связь с фактом

- **WB**: владелец создаёт поставку в кабинете WB; она появляется в `wb_supplies`. В документе —
  выбор из незакрытых `wb_supplies` (автоподсказка: ближайшая по `created_at` к `shipped_at` и
  `destination_office_id` = `dest_warehouse_id`). Стадии: `closed_at` → «передана»,
  `scan_dt` → `accepted`, `reject_dt` → `rejected`. Принятое количество по строкам WB через
  API не отдаёт — `qty_accepted` вводится руками из отчёта приёмки; пока не введено, статус
  `accepted` означает «приёмка прошла, расхождение не проверено».
- **Ozon**: выбор из `ozon_supply_orders` (автоподсказка по `dest_warehouse_id` и дате).
  Ozon API принятое количество не отдаёт (проверено 06.09 на `/v2`→`/v3/supply-order/list`+
  `get`, `/v1/supply-order/bundle`) — `qty_accepted` вводится руками из отчёта приёмки, как
  у WB; найдётся эндпоинт — автоматизируем.
- **Расхождение приёмки**: `SUM(qty_accepted) < SUM(qty)` → `partial`, разница по строкам в
  UI. Недостача **не** списывается повторно и **не** возвращается автоматически: владелец
  оформляет `adjust` с комментарием («потеря в поставке WB-GI-…») или оставляет как есть.

### 4.4 Что не делаем

Создание поставок в кабинетах МП через API (WB FBO — слоты и лимиты; Ozon supply-order create
требует таймслотов). Только рекомендация и учёт факта.

## 5. Витрина: страница `/warehouses`

Новый пункт «Склады» в меню «Товары». Старые «Остатки на МП», «Остатки склад/ФФ»,
«Перемещение», «Отгрузки» остаются в меню ниже до приёмки владельцем; после приёмки решаем,
что убрать. API: `app/api/cabinets/[id]/warehouses/route.js` (GET `?tab=matrix|places|supplies`,
POST действия). Расчёты — в `lib/warehousesMetrics.js`, роут тонкий.

### 5.1 Вкладка «Матрица»

Строки — товары: одна строка на физическую позицию (группировка `ff_inventory` по паре
`(nm_id, product_id)`; название и фото — по любой привязке). Колонки — группы мест:

- **каждый ФФ**: ячейка «свой / на МП / Δ» отдельно по WB и Ozon (если склад той площадки
  привязан); фон жёлтый при Δ ≠ 0, красный если покрытие по FBS-скорости места < `min_days`;
- **каждый FBO-склад МП** с остатком или продажами за 28 дней: остаток + в пути,
  покрытие в днях, красный ниже `min_days`;
- справа: итого по товару и «не разнесено» (открытые `stock_move_gaps`).

Фильтры: площадка, «только проблемные», поиск по названию/артикулу. Сортировка — `useSort`
как на `/stocks`. Таблица прокручивается внутри своего контейнера (`overflow-x:auto`),
первая колонка закреплена.

### 5.2 Вкладка «Места»

Карточка на каждое место (ФФ) и на каждый FBO-склад МП с остатком:

- ФФ: город/адрес, привязанные склады МП (или «не привязан» красным), позиций / единиц /
  стоимость по `unit_cost`, FBS-скорость и покрытие, список проблем (расхождения с МП,
  не разнесённые задания с причинами, товары с покрытием < `min_days`). Кнопки
  «Перемещение» (документ 3.6) и «Инвентаризация» (массовый `adjust`: таблица позиций с полем
  «факт», одна причина на всё). Настройки места (привязка, город, активность) — здесь же.
- FBO-склад МП: регион/кластер, позиций / единиц, покрытие, товары ниже минимума, открытые
  поставки в этот склад.

### 5.3 Вкладка «Поставки»

Верх — черновики `buildSupplyPlan` по группам «место → склад МП» с составом и кнопкой
«Создать документ» (создаёт `draft`; владелец правит состав и переводит в `shipped`).
Низ — документы со статусами, связью с фактом и расхождением по строкам; сюда переезжает
функциональность `/shipments` с расширением 4.2–4.3. Пороги `target_days` / `min_days` и
кратность упаковки — в настройках (кабинет и позиция).

### 5.4 Сигналы

Через `lib/opsAlerts.js` на главную и в брифинг:

- «N товаров с расхождением учёта и МП»;
- «M заданий FBS не разнесено» (открытые gaps);
- «K поставок ждут приёмки > 7 дней» (`shipped` без `accepted`);
- «товар X кончится на складе Y через Z дней» (покрытие < `min_days`, топ-5 по скорости).

## 6. Проверки и сторожа

По протоколу проверки панели (скрипты в `scripts/`, кабинет #1):

- **Этап 1**: снимок `mp_fbs_daily_stock` сверен с живым API кабинета #1 (Δ = 0 по всем
  складам); справочник складов продавца = список из `/api/v3/warehouses` и
  `/v2/warehouse/list`; `wb_fbs_tasks.warehouse_id` заполнен у 100 % заданий за 30 дней;
  `ozon_supply_orders` = список из ЛК за 90 дней.
- **Этап 2**: для каждой позиции `ff_inventory.qty = SUM(stock_moves.qty)`; за сутки число
  `out_fbs` = число заданий/постингов, перешедших в списываемый статус, минус открытые gaps;
  повторный прогон `fbs_writeoff` не создаёт движений (идемпотентность); нехватка на строке
  отгрузки откатывает документ целиком.
- **Этап 3**: рекомендации пересчитаны руками для 3 товаров (скорость, покрытие, qty,
  выбор ФФ); документ `shipped` списал ровно состав; связь с `wb_supplies` меняет статус при
  появлении `scan_dt`; `partial` при `qty_accepted < qty`.
- **Этап 4**: цифры матрицы = цифрам `/inventory`, `/mp-stock`, `/stocks` для одного товара;
  карточка места показывает те же gaps, что таблица `stock_move_gaps`; сигналы в брифинге
  совпадают с вкладкой.

Все новые tenant-таблицы получают политику `panel_local_ro_cab1`.

## 7. Этапы (каждый — свой план → реализация → шлюз → деплой)

1. **Данные**: миграции 1.1–1.2, 2.1, 2.5, 2.6; сборщики `mp_seller_warehouses`,
   FBS-остатки WB (по результату пробы) и Ozon, `ozon_supply_orders`; форма привязки
   складов в местах (минимальный UI в существующем «📍 Места» на `/inventory`).
2. **Учёт**: двойная привязка, `stock_moves`, `applyMove`/`applyTransfer`, перевод
   существующих правок, начальное сальдо, `fbs_writeoff` + gaps, перемещение ФФ→ФФ, сторож
   в `/health`.
3. **Поставки**: `lib/stockCoverage.js`, `buildSupplyPlan`, расширение документов,
   связь с фактом WB/Ozon, статусы.
4. **Витрина**: `/warehouses` (Матрица, Места, Поставки), сигналы, решение по старым
   страницам.

Этапы 1 и 2 можно вести параллельно только по данным (1) и модели (2); `fbs_writeoff`
зависит от `warehouse_id` в заданиях (1).

## Вне рамок (YAGNI)

- Создание поставок / обновление FBS-остатков на МП через API (запись в кабинеты МП).
- Несколько магазинов одной площадки на одном месте.
- Стадия «в пути» у перемещений ФФ→ФФ.
- Интеграция с API самих фулфилментов.
- Партионный учёт себестоимости при списании (FIFO по партиям только для выбора строки,
  себестоимость в P&L идёт по `cost_override` как сейчас).
- Авто-закрытие недостачи приёмки.
