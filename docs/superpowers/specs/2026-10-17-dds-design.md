# ДДС — журнал факта и отчёт о движении денег (спека, 17.10.2026)

Часть 3 модуля «Финансы и закупки» (после «Доставлено на склад» и «Платёжного календаря»). Решения
владельца — по итогам брейншторма 16–17.10.2026.

## 1. Цель и рамки

Страница `/fin-dds` превращается из сломанной формы ввода в классический ДДС:
- **журнал фактических операций** (только `status='paid'`) по счетам и статьям;
- **отчёт ДДС** «статьи × месяцы» с остатком на начало/конец, по трём видам деятельности
  (операционная / инвестиционная / финансовая).

Таблица денег остаётся одна — `tenant.dds_movements` (миграция 070): календарь и план поступлений —
её плановые строки, ДДС — фактические.

**Что сейчас сломано (причина переделки):**
- плитки KPI читают `totals.income_total`/`count`, API отдаёт `income`/`expense` → всегда 0 (D6);
- «⚡ Черновик из источников» мёртв — API не отдаёт `sources`;
- итоги смешивают `planned` и `paid`;
- роут правит/архивирует строки календаря (`purchase`/`mp_payout`/`recurring`) в обход их правил;
- `BalancePage`/`OpexPage` пишут в ДДС через `postToDds` с пустым `cabinetId` (`/api/cabinets//dds`) —
  никогда не работало, а работая — давало бы двойной счёт.

**Не делаем сейчас:** выгрузка в Excel; бюджет и план-факт; автоматический факт выплат WB/Ozon из API
(отдельная задача после пробы — решение владельца «вариант 3»: сейчас отметка «Получено», потом
автоматизация); импорт банковских выписок; удаление устаревших колонок `dds_movements`.

## 2. Данные (миграция 072, идемпотентна)

### 2.1 `tenant.dds_accounts` — справочник счетов
| колонка | тип | смысл |
|---|---|---|
| `cabinet_id, id` | PK | |
| `name` | TEXT NOT NULL | «ВТБ р/с ИП» |
| `kind` | TEXT CHECK in (`bank_ip`,`card_person`,`cash`,`mp_wb`,`mp_ozon`,`other`) | тип |
| `opening_balance` | NUMERIC(14,2) NOT NULL DEFAULT 0 | остаток на начало дня `opening_date` |
| `opening_date` | DATE NOT NULL | с этой даты счёт учитывается |
| `sort` | INT | порядок |
| `is_archived` | BOOL DEFAULT false | |
| `created_at, updated_at` | TIMESTAMPTZ | |

RLS + `panel_local_ro_cab1`, гранты `saas_app`, как у `dds_recurring` (070).

Стартовое наполнение — **только каб. #1**, отдельным SQL-блоком миграции (идемпотентно, если у кабинета
ещё нет счетов): из последнего снимка `tenant.balance_accounts` (`as_of_date` максимальная): каждая
пара `subject × account_name` → счёт (`subject='ip'` → `bank_ip`, `'person'` → `card_person`; «ВБ» →
`mp_wb`, «Озон банк» → `bank_ip`), `opening_balance = amount`, `opening_date = as_of_date`. Владелец
правит суммы и дату на приёмке. Другие кабинеты счетов не получают (заводят сами).

### 2.2 `tenant.dds_articles` — справочник статей
| колонка | тип | смысл |
|---|---|---|
| `cabinet_id, key` | PK | `key` латиницей, неизменяемый; свои — `u_<n>` |
| `label` | TEXT NOT NULL | |
| `direction` | TEXT CHECK in (`income`,`expense`) | |
| `activity` | TEXT CHECK in (`operating`,`investing`,`financing`) | |
| `color` | TEXT | токен палитры `lib/palette.js` |
| `sort` | INT | |
| `is_system` | BOOL | системные не удаляются, только переименование/скрытие |
| `is_archived` | BOOL | скрытая — не предлагается в формах, в отчёте остаётся при наличии строк |

Системные статьи заводятся **лениво** для любого кабинета (`ensureArticles()` в слое данных при первом
чтении, `INSERT … ON CONFLICT DO NOTHING`) — набор в коде (`SYSTEM_ARTICLES`, `lib/dds.js`):

| key | label | direction | activity | color |
|---|---|---|---|---|
| `mp_wb` | Выплата WB | income | operating | pos |
| `mp_ozon` | Выплата Ozon | income | operating | blue |
| `mp` | Выплата МП (прочее) | income | operating | pos |
| `supplier_refund` | Возврат от поставщика | income | operating | accent |
| `other_in` | Прочие поступления | income | operating | line |
| `supplier` | Поставщик | expense | operating | pink |
| `cargo` | Карго/логистика | expense | operating | blue |
| `ff` | Фулфилмент | expense | operating | accent |
| `tax` | Налоги | expense | operating | warn |
| `salary` | Зарплата | expense | operating | accent2 |
| `rent` | Аренда | expense | operating | muted |
| `subs` | Подписки | expense | operating | faint |
| `ads` | Реклама | expense | operating | neg |
| `other` | Прочее | expense | operating | line |
| `equipment` | Оборудование | expense | investing | muted |
| `owner_in` | Ввод собственника | income | financing | accent2 |
| `loan_in` | Займ получен | income | financing | warn |
| `owner_out` | Вывод собственнику | expense | financing | accent2 |
| `loan_out` | Погашение займа | expense | financing | warn |

Ключи `supplier…other`, `mp` — те же, что `CATEGORIES` календаря (`lib/paymentCalendar.js`), цвета
сохраняются.

### 2.3 `tenant.dds_movements` — новые колонки
- `account_id BIGINT` — счёт (у перевода — откуда);
- `account_to_id BIGINT` — счёт назначения, только у перевода;
- `article_key TEXT` — статья;
- `type` дополняется значением `transfer` (CHECK `type IN ('income','expense','transfer')`).

CHECK `dds_movements_transfer_chk`:
`(type='transfer' AND article_key IS NULL AND account_id IS NOT NULL AND account_to_id IS NOT NULL AND account_id <> account_to_id)
 OR (type<>'transfer' AND account_to_id IS NULL)`.

Перенос (в миграции, идемпотентно, `WHERE article_key IS NULL`): `category` → `article_key` по правилу
`categoryOf` (`Закупка`→`supplier`, `ЗП`→`salary`, `Возврат МП`→`mp`, метки `CATEGORIES`→их ключи, иначе
`other`); у `source_kind='mp_payout'` — `mp_wb`/`mp_ozon` по `platform`; доходные строки с неизвестной
меткой → `other_in`. `account_from/account_to` у каб. #1 пусты — не переносятся.

Устаревшие колонки `category, income_type, account_from, account_to, source, platform, nm_id` остаются;
код их больше не читает (кроме `platform` у выплат МП, которую пишет `receivePayout`) — пометка в
комментарии миграции, удаление отдельной задачей. `category` больше не пишется новыми строками.

### 2.4 Настройки кабинета
`auth.cabinets.settings.dds = { default_account_id, payout_account: { wb, ozon } }` — правит владелец на
подвкладке «Счета».

### 2.5 Определения
- **Факт** — `status='paid'`. `planned` и `archived` в журнал и отчёт ДДС не входят.
- **Остаток счёта на начало дня D** = `opening_balance` + Σ(income) − Σ(expense) − Σ(transfer с
  него) + Σ(transfer на него) по фактическим строкам с `opening_date ≤ date < D`. Строки раньше
  `opening_date` в остаток не входят; в журнале помечаются «до старта счёта».
- **Счёт не указан** — фактические строки с `account_id IS NULL` — отдельная строка остатков
  (стартовый остаток 0), не прячется.
- Отрицательная выплата Ozon (окно с удержаниями больше начислений) — поступление со знаком минус,
  уменьшает статью «Выплата Ozon».
- Сальдо всех статей за период = изменение суммы всех остатков (включая «Счёт не указан») за период —
  переводы на сумму не влияют.

## 3. Правила записи

Все изменения `dds_movements` — только через `lib/paymentCalendarData.js` (расширяется), роут ДДС своего
SQL на запись не имеет.

| источник | сумма | статья, контрагент | дата | счёт, комментарий | удалить |
|---|---|---|---|---|---|
| `manual` | ✓ | ✓ | ✓ | ✓ | ✓ (архив) |
| `recurring` | ✓ (строка отвязывается от шаблона → `manual`, `source_ref` сохраняется) | ✓ (то же) | ✓ | ✓ | ✓ |
| `purchase` | ✗ (в партии) | ✗ | ✓ (`date_locked`) | ✓ | ✗ (вместе с партией) |
| `mp_payout` | ✗ (снять «получено» → отметить заново) | ✗ | ✓ (`date_locked`) | ✓ | ✗ (снятие отметки) |
| `transfer` (`manual`) | ✓ | — | ✓ | оба счёта ✓ | ✓ |

- Изменение счёта/комментария — разрешено у любого источника и не меняет `source_kind`.
- `createMovement` принимает `account_id`, `article_key`, `type='transfer'` + `account_to_id`;
  статья должна существовать и совпадать по направлению с `type`; счёт — не архивный.
- `markPaid(id, amount, accountId?)`, `receivePayout(…, accountId?)`: без счёта — подстановка из
  настроек (`payout_account[platform]` для выплат, иначе `default_account_id`; нет настройки — NULL).
- Новое действие `assign_account({ids[], account_id})` — массовое назначение счёта фактическим строкам.
- **Убирается запись в обход:** `postToDds` и кнопки «в ДДС» в `BalancePage.jsx` (корректировка баланса —
  не движение денег) и `OpexPage.jsx` (регулярные расходы — повторами календаря).
- **Старые данные:** 2 плановые «Налоги» июля остаются плановыми (видны в календаре просроченными);
  архивный мусор не трогаем.

**Роли.** Операции/переводы — запись `manager`+, чтение все. Статьи — добавлять/переименовывать/скрывать
`manager`+. Счета (справочник, стартовые остатки, настройки) и любые суммы остатков — только `owner`:
API не отдаёт `opening_balance`/остатки/строки «на начало/конец» другим ролям; менеджер получает только
`{id, name, kind}` счетов для выбора.

## 4. API

`/api/cabinets/[id]/dds` (переписывается):
- `GET ?view=journal&from&to&account&article&type&source&q&page` → `{items[], total, totals:{income,
  expense, net}, endBalance? (owner), noAccountCount, canEdit, isOwner, accounts[], articles[]}`; 100
  строк на страницу, итоги — по всему фильтру.
- `GET ?view=report&from&to&grain=month|week&byAccount=1` → `{columns[], groups[{activity, income[],
  expense[], net}], netFlow[], opening? [], closing? [], byAccount? []}` (поля с `?` — только owner).
- `POST {action}`: `create`, `update`, `delete`, `assign_account` — через слой записи; `requireRole:
  'manager'`.

`/api/cabinets/[id]/dds-refs`:
- `GET` → счета (по роли), статьи, настройки (owner).
- `POST {action}`: `article_save`/`article_archive` (`manager`+); `account_save`/`account_archive`/
  `settings_save` (`owner`). Счёт с операциями не удаляется — только архив.

Календарь (`/payment-calendar`): `categories` в ответе — из справочника (`key,label,color,direction`);
`mark_paid`/`receive_payout` принимают `account_id`.

## 5. Экраны

`/fin-dds`: сверху `FinanceMoneyTabs`, внутри подвкладки **Операции · Отчёт · Счета (owner) · Статьи**
(`?tab=`).

**Операции.** `PeriodPicker` (дефолт месяц по вчера); фильтры счёт / статья / вид / источник / поиск.
Плитки: Поступления, Списания, Сальдо, «Остаток на конец» (owner). Таблица: дата · счёт · статья
(цветная метка) · контрагент · комментарий · сумма (+ зелёная / − красная / перевод серым «А → Б») ·
значок источника (📦 партия — ссылка на «Закупки», WB/Ozon, ↻ повтор) · ✎ 🗑 (запрещённое — неактивно с
подсказкой). «+ Операция» — модалка: Поступление / Списание / Перевод, дата (сегодня), сумма, счёт
(дефолт), статья своего направления, контрагент, комментарий. Плашка «N операций без счёта →
назначить» с массовым выбором. Пагинация по 100.

**Отчёт.** Колонки — месяцы (дефолт последние 6 по текущий) + «Итого»; переключатель «по неделям».
Строки: Остаток на начало (owner); группы Операционная / Инвестиционная / Финансовая — поступления по
статьям, выбытия по статьям, сальдо группы (сворачиваются, пустые статьи скрыты); Чистый денежный
поток; Остаток на конец (owner); разрез «по счетам» (owner, включая «Счёт не указан»). Клик по ячейке →
«Операции» с фильтром статья × период. Текущий месяц — по сегодня, пометка «месяц идёт».

**Счета (owner).** Имя · тип · стартовый остаток на дату · текущий остаток · архив; добавить/править/
архивировать; настройки счёта по умолчанию и счетов выплат WB/Ozon.

**Статьи.** Три группы × поступления/выбытия; добавить, переименовать, цвет, скрыть; системные — с замком.

**Календарь / План поступлений.** Статьи и цвета — из справочника; у «оплачено»/«получено» —
необязательный выбор счёта.

Палитра — `lib/palette.js`; правила D1–D7 (cabinetId, backticks, await, хуки до return).

## 6. Код

- `lib/dds.js` — чистое ядро: `SYSTEM_ARTICLES`, `balancesAt`, `buildReport`, `journalTotals`,
  `editRules(source_kind)` (матрица §3), `redactForRole`.
- `lib/ddsData.js` — чтение (журнал, отчёт, справочники, `ensureArticles`).
- `lib/paymentCalendarData.js` — запись (расширение), `lib/paymentCalendar.js` — `CATEGORIES` заменяется
  справочником (константа остаётся только как источник `SYSTEM_ARTICLES`, без дубля).

## 7. Проверки

- `lib/__tests__/dds.test.mjs`: остатки (старт, до `opening_date`, переводы), инвариант «сальдо статей =
  Δ остатков», planned/archived исключены, отрицательная выплата, месяцы/недели, «Итого» = Σ колонок,
  пустые статьи скрыты, «Счёт не указан».
- `lib/__tests__/ddsGuard.test.mjs`: запись в `dds_movements` только в `paymentCalendarData.js`; нет
  `postToDds`; матрица §3 поячеечно; ответ для manager/viewer без остатков; D3.
- `scripts/smoke-dds.mjs 1` (чтение): журнал месяца = колонка отчёта; конец N = начало N+1; Σ остатков
  на сегодня = Σ стартов + Σ движения; оплаченные расходы месяца в календаре = выбытия отчёта; у каждой
  `paid` есть `article_key` либо это перевод.
- Остаются зелёными: `paymentCalendar*.test.mjs`, `smoke-payment-calendar.mjs 1`, `roleGuards.test.mjs`.

## 8. Приёмка владельцем

1. Поставить реальные стартовые остатки счетов на выбранную дату.
2. Назначить счёт 39 оплатам партий (плашка «без счёта»).
3. Сверить «остаток на сегодня» с банком.
