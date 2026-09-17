# Юнит-экономика Ozon: модель уровня WB (спека)

Дата: 2026-09-17. Статус: согласована владельцем (решения по полям — 17.09.2026).

## 0. Зачем

WB-модель `calcWB` (`lib/unit.js`) в июне 2026 перебрана с владельцем по полям
(решения #22, #50, 2026-08-02: цена кабинета, СПП, цена сайта как база налогов,
выкуп в логистике, эквайринг отдельно). Ozon-модель `calcOzon` написана один раз по
контракту Google-таблицы (№14–18) и с тех пор получала только зеркальные заплатки
(факт логистики 26.08, брак 27.08, ставка УСН). Структурно она отстала:

| Поле | Сейчас | Проблема (кабинет 1, проверено 17.09) |
|---|---|---|
| Цена | средняя всех заказов за всю историю | отстаёт от текущей на 10–20 % («карта 64»: 1 482 vs 1 800 ₽) |
| Соинвест | `ozon_action_products.current_boost` | таблица пуста, сборщика нет → всегда 0 % |
| % выкупа | считается, но `calcOzon` не принимает | галочка «с % выкупа» на Ozon — no-op |
| Возвраты | нет | 346 возвратных шт, 72 тыс ₽ обратной логистики за 30 дн мимо модели |
| Комиссия | каталожная ставка × выручка без НДС | Ozon берёт от цены с НДС; факт по начислениям отличается от каталога |
| Эквайринг | «внутри комиссии» | в начислениях отдельная строка (~0,8 %) |
| База маржи | выручка без НДС | у WB — цена кабинета; строки площадок несопоставимы |

## 1. Решения владельца (17.09.2026)

1. **База цены** — цена продавца из каталога: `tenant.ozon_products.price`
   (= `marketing_seller_price`, обновляется ежедневно). Рядом справочно —
   средняя фактическая цена проданного за 30 дней из начислений.
2. **Выкуп и возвраты** — как у WB плюс факт возвратов: логистика на проданную
   штуку через % выкупа, обратная логистика из начислений.
3. **Комиссия и эквайринг** — факт из начислений за 30 дней по товару, база —
   цена продажи с НДС; эквайринг отдельной колонкой; fallback — каталог.
4. **Соинвест** — собирать из кабинета продавца нашим клиентом; соинвест =
   1 − цена для всех покупателей / цена продавца (**без** Ozon Карты). Цена с
   Ozon Картой хранится, но в таблице не показывается. Перед сборщиком — живая
   проба цифр и сверка с сайтом.
5. **Реклама** — константа 10 % (решение #14, паритет с WB).
6. **База маржи** — как у WB: прибыль / цена продавца.

## 2. Модель `calcOzon` (lib/unit.js)

Входы (доли 0..1, деньги в ₽):

| Ключ | Смысл | Авто-источник | В прикидке |
|---|---|---|---|
| `priceOzon` | цена продавца со скидкой (аналог `priceCabinet` WB) | `products.price` | да |
| `discount` | скидка прикидки (дефолт 0) | — | да |
| `boost` | соинвест Ozon | `ozon_daily_prices`, последний день | нет |
| `commissionRate` | комиссия | факт 30 дн / каталог | да |
| `acquiringRate` | эквайринг | факт 30 дн / среднее по кабинету | нет |
| `buyout` | % выкупа `b` | факт 30 дн | да (новое) |
| `logisticsFbo` | прямая логистика на попытку `F` | факт 30 дн / каталожный тариф | да |
| `returnLogistics` | обратная логистика на возврат `R` | факт 30 дн / среднее по кабинету | нет |
| `adsRate` | ДРР | 0.10 | да |
| `cost`, `purchase`, `defectRate`, `usnRate`, `vatRate` | как сейчас | как сейчас | как сейчас |

Формулы:

```
priceSell  = priceOzon × (1 − discount)          // цена продавца — база всего
priceBuyer = priceSell × (1 − boost)             // справочно; соинвест за счёт Ozon, из прибыли не вычитается
vat        = priceSell × vatRate
revNet     = priceSell − vat                     // база УСН
usn        = revNet × usnRate
commission = priceSell × commissionRate          // база с НДС — так считает Ozon
acquiring  = priceSell × acquiringRate
bSafe      = buyout > 0 ? buyout : 1
logistics  = (F + (1 − bSafe) × R) / bSafe        // на проданную штуку
ads        = priceSell × adsRate
profit     = priceSell − vat − usn − commission − acquiring − logistics − ads − cost
margin     = profit / priceSell
renta      = profit / cost
defectLoss = purchase × defectRate
profitWithDefect = profit − defectLoss
marginWithDefect = profitWithDefect / priceSell
```

**Тождество (проверка модели).** При фактических `F = Σлог(продано)/продано`,
`R = Σлог(возвраты)/возвраты`, `b = продано/(продано+возвраты)`:
`logistics = Σлогистики всех строк окна / продано` — ровно факт из начислений.
При галочке «с % выкупа» OFF подаётся `b = 1` → `logistics = F`.

Функция остаётся синхронной (урок 26.08). Выходные ключи: все входы +
`priceSell, priceBuyer, priceFact, vat, revNet, commission, acquiring,
logistics, logisticsFbo, returnLogistics, ads, usn, profit, margin, renta,
profitWithDefect, marginWithDefect, adsRate, boost`.

Что НЕ меняется: НДС/УСН (базы и ставки per-shop), брак-зеркало, ДРР
константа, `purchase = cost` по умолчанию.

## 3. Факты в роуте `unit/all` (`computeOzon`)

Окно — 30 дней по вчера (`defaultPeriod(30)`), источник —
`tenant.ozon_order_costs`, один batch-SQL `GROUP BY product_id`:

| Величина | Формула по окну |
|---|---|
| `sold` | `COUNT(*) FILTER (is_return = 0)` |
| `returns` | `COUNT(*) FILTER (is_return = 1)` |
| `F` | `SUM(logistics) FILTER (is_return = 0) / sold` |
| `R` | `SUM(logistics) FILTER (is_return = 1) / returns` |
| `b` | `sold / (sold + returns)` |
| `commissionRate` | `SUM(commission) FILTER (is_return = 0) / SUM(cost_value_retail) FILTER (is_return = 0)` |
| `acquiringRate` | `SUM(acquiring) FILTER (is_return = 0) / SUM(cost_value_retail) FILTER (is_return = 0)` |
| `priceFact` | `SUM(cost_value_retail) FILTER (is_return = 0) / SUM(qty) FILTER (is_return = 0)` |

Отмены до отгрузки в начислениях не появляются, ничего не стоят и в `b` не
входят (осознанно). Знаки: `logistics`, `commission`, `acquiring` берём по
модулю — в таблице они хранятся в конвенции площадки.

Fallback (товар без продаж в окне или без возвратов):

- `commissionRate` → `products.commission_pct / 100`; `F` → `products.logistics_fbo_tariff`;
  `b` → 1; строка `estimated: true` (как сейчас).
- `R` без возвратов у товара → среднее `R` по кабинету за окно; нет и его → 0.
- `acquiringRate` без продаж → среднее по кабинету за окно; нет → 0.015.
- `boost` без строки в `ozon_daily_prices` → `null` (UI показывает «—», не 0 %).

Товары без продаж вообще (draft-ветка) — та же логика через fallback.
Ручные override `tenant.unit_inputs` по-прежнему старше факта.

`avg_price` всех заказов за всю историю из `orders` больше не используется;
запрос к `orders` остаётся только для `orders_all`/`delivered` (для справки) —
или удаляется, если после правки нигде не читается.

## 4. Соинвест: сборщик `ozon_cabinet_prices`

**Таблица** `tenant.ozon_daily_prices` (миграция 059, RLS по образцу 058,
политика `panel_local_ro_cab1` как у соседних tenant-таблиц):

```
cabinet_id bigint, day date, product_id bigint,
seller_price numeric,     -- marketing_seller_price: цена продавца с его акциями
marketing_price numeric,  -- цена для всех покупателей с соинвестом Ozon
oa_price numeric,         -- цена с Ozon Картой (хранится, в юнитке не показывается)
updated_at timestamptz default now(),
PRIMARY KEY (cabinet_id, day, product_id)
```

**Источник** — кабинет продавца под нашим профилем (`worker/cabinet_client.py`),
два новых пути в `ALLOWED_PATHS` (только чтение):

- `POST /api/v1/products/list-by-filter` — уже в списке; даёт `item_id` +
  `part_item.offer_id` (страницы по 200, курсор);
- `POST /api/pricing-bff-service/v3/get-common-prices` — `{company_id,
  item_ids[≤100]}` → `items[].marketing_seller_price / marketing_price /
  marketing_oa_price` (парсер — по образцу `parse_common_prices` панели).

Связка с `product_id`: гипотеза — `item_id` кабинета = `product_id` Seller API;
проверяется пробой. Если нет — маппинг через `offer_id` ↔ `tenant.ozon_products`.

**Расписание** — таймер `saas-cabinet` (06:00/20:00): добавить в
`CABINET_COLLECTORS` в `worker/orchestrator.py` и `run_saas_collect.sh`, в
`SAAS_PAUSE_EXEMPT` (гейт кредов кабинета `needs_ozon_creds`, как у
`ozon_cabinet_search`). Пишет день `today` (снимок цен на момент сбора), второй
тик дня перезаписывает. Идемпотентно (`ON CONFLICT DO UPDATE`). Exit-коды и
маркер `CABINET_AUTH_EXPIRED` — как у соседей. `SAAS_PROBE=1` — печать
первых 5 товаров без записи.

**Соинвест в юнитке:** `boost = 1 − marketing_price / seller_price` по
последнему дню кабинета, только если обе цены > 0 и `marketing_price ≤
seller_price`; иначе `null`.

**Живая проба до сборщика** (после входа владельца в кабинет — сессия истекла
17.09 08:00 по обоим агентам): 5 товаров, три цены, сверка с тем, что владелец
видит на сайте («карта 64»: обычная цена и цена с Ozon Картой). Ожидание по
данным панели за 12–16.09: цена продавца ≈ начисление на штуку (1 700–1 820 vs
1 636–1 753 ₽), цена с Ozon Картой ≈ 890–980 ₽. Пробу фиксируем в спеке
(раздел 8) до написания сборщика.

## 5. UI (`UnitPage.jsx`, `COLUMNS_OZON`) и прикидки

Колонки Ozon (по порядку): Товар · Цена продавца (`priceOzon`) · Факт 30 дн
(`priceFact`, calc) · Скидка · Цена со скидкой (`priceSell`) · Соинвест
(`boost`) · Цена покупателя (`priceBuyer`) · НДС · Выручка без НДС · Комиссия %
· Комиссия ₽ · Эквайринг % · Эквайринг ₽ · % выкупа (`buyout`) · Логистика
прямая (`logisticsFbo`) · Возврат ₽ (`returnLogistics`) · Логистика на продажу
(`logistics`) · ДРР · Реклама ₽ · УСН · Себестоимость · ПРИБЫЛЬ · Маржа ·
Рентаб-сть · % брака · Прибыль с браком · Маржа с браком.

- `WHATIF_INPUTS.ozon` += `buyout` (`%`, max 100, asFraction). Серверный
  `ALLOWED_KEYS.ozon` += `buyout: {max: 1}`.
- `HIDDEN_WHEN_BUYOUT_OFF` += `returnLogistics` (при `b = 1` возврат не участвует);
  галочка «с % выкупа» на Ozon подаёт `buyout = 1`, как у WB — абзац контракта
  «no-op» снимается.
- `boost = null` → «—». `estimated` — как сейчас.
- Сохранённые прикидки `tenant.unit_whatif` с `priceOzon` остаются валидны
  (семантика «цена продавца» совместима с ручным вводом).
- Итоги `totals.ozon.avgMargin` — простое среднее, без изменений (§12 контракта).

## 6. Контракт (`docs/metrics-contract.md`)

- §11.4: формула Ozon заменяется на п.2; фиксируется база маржи = `priceSell`.
- §11.6: абзац «“с % выкупа” на Ozon — no-op» заменяется на описание `b`;
  `buyout` добавляется в whitelist Ozon.
- Новый подраздел про `tenant.ozon_daily_prices` и определение соинвеста
  (без Ozon Карты), карта доверия: снимок на момент сбора, лаг до тика, нет
  данных → `null`.

## 7. Проверка

1. **Тесты `calcOzon`** (node, `lib/unit.test.mjs` или существующий каркас):
   тождество п.2 на фактических `F/R/b`; `b = 1` → `logistics = F`; `boost =
   null` не ломает расчёт; `margin` от `priceSell`; идемпотентность на
   округлённых выходах (короткое замыкание `ProductRow` не нарушается).
2. **Смоук на кабинете 1**: три товара (в т.ч. «карта 64» и коврик с
   возвратами) — колонки факта из `unit/all` против ручного SQL по
   `ozon_order_costs`, Δ = 0; `logistics × sold` = Σлогистики окна.
3. **Проба цен кабинета** (п.4) — до сборщика; после первого боевого тика —
   строки за день = число товаров в продаже.
4. **Смоук-скрипты протокола панели** (`saas-verification-protocol`) —
   прогон без регрессий на WB-вкладке (WB не трогаем).
5. Excel-зеркало юнитки (`scratchpad/Юнит-экономика.xlsx`, 10.09) после
   правки устареет — перегенерация отдельной задачей после приёмки.

## 8. Результаты пробы цен (заполняется до сборщика)

_Ожидает входа владельца в кабинет._

## 9. Вне рамок

- Сборы Ozon (`services`) в модели — 0–1 ₽/шт, не добавляем.
- Реклама фактом по SKU — отдельно, сразу для обеих площадок.
- Панель ozon-panel: в `sync_log` при таймауте пишутся полные cookies сессии —
  почистить в панели, к SaaS не относится.
- Показ цены с Ozon Картой в юнитке (хранится в `oa_price`, включить по запросу).

## 10. Порядок работ (для плана)

A. Проба цен (после входа в кабинет) → миграция 059 → сборщик `ozon_cabinet_prices`
   → регистрация в таймере → первый боевой тик.
B. `calcOzon` + тесты → `computeOzon` факты → UI/whatif → контракт.
C. Смоуки, деплой, приёмка владельцем, запись в память.

A и B независимы; B не ждёт A (без строк в `ozon_daily_prices` соинвест = «—»).
