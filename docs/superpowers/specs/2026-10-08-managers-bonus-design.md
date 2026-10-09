# Менеджеры площадок и раздел «Премия» — дизайн

Дата: 2026-10-08. Статус: согласован владельцем в диалоге, ждёт ревью спеки.

## 0. Задача

В кабинете будут два менеджера — по WB и по Ozon. Каждому нужен доступ ко всей
панели, кроме страницы «Баланс», и раздел, где считается его премия (у каждого
свой доступ: менеджер видит только себя). Модель премии — лист «KPI (копия)»
таблицы владельца (Google Sheets `1So05J1O…`), плюс порог 65 % из листа «KPI».

Две части, реализуются в этом порядке: (1) права менеджера, (2) раздел «Премия».

## 1. Права менеджера

**Факт на 2026-10-08:** в `auth.memberships` всех кабинетов только `owner` (5 строк),
ни одного `manager`/`viewer`. Переопределение смысла роли `manager` клиентов не
затрагивает.

**Решение:** переопределить роль `manager` (не флаги прав, не новая роль — YAGNI).

| Что | owner | manager | viewer |
|---|---|---|---|
| Чтение всех страниц, кроме «Баланса» | ✓ | ✓ | ✓ |
| «Баланс» (`/fin-balance`, `/api/cabinets/[id]/balance` GET/POST/DELETE) | ✓ | ✗ | ✗ |
| Запись в товары/себестоимость/склады/отгрузки (как сейчас) | ✓ | ✓ | ✗ |
| Запись в финансы: ДДС, закупки, план продаж + цели + утверждение, сопутствующие расходы, самовыкупы, план закупок | ✓ | ✓ (новое) | ✗ |
| Настройки и API-ключи (`settings`, `shops`), команда (`members`, `invites`), подписка (`billing/pay`) | ✓ | ✗ | ✗ |
| Премия | всё | только своя, чтение | ✗ |

Правки:
- `requireRole: 'owner'` → `'manager'` у записи в роутах `dds`, `purchases`, `plan`,
  `plan/targets`, `plan/approve`, `opex`, `self-buyouts`, `purchase-plan`.
- `balance` GET получает `requireRole: 'owner'` (сейчас GET открыт любому участнику).
- Меню (`app/cabinets/[id]/layout.js`): пункт «Баланс» только владельцу — layout
  дочитывает `m.role` в существующий запрос membership. `/fin-balance/page.js` для
  не-владельца — заглушка «Нет доступа» (сервер), API в любом случае 403.
- Комментарий-шапку `lib/withCabinet.js` про уровни ролей обновить.

Проверка: скрининг — `grep -rn "requireRole: *['\"]owner" app/api` даёт ровно
`balance`, `settings`, `shops`, `members`, `invites`, `billing/pay`; тест
`withCabinet`-уровня (manager → 403 на balance, 200 на dds POST; viewer → 403 на
dds POST и balance GET).

## 2. Премия: модель расчёта

Период — календарный месяц. Сотрудник в программе привязан к одной площадке.

**Факт** (канон, без своих формул — правило «одна цифра везде»):
- выручка и прибыль площадки за месяц — `wbProfitCabinet` / `ozProfitCabinet`
  (`.revenue`, `.profit`), те же функции, что «Сводка по прибыли» (`/pnl`).
  Продажи = выручка по выкупам (`revenue`, возвраты вычтены); прибыль — итоговая
  прибыль площадки после себестоимости, комиссий/логистики, рекламы, налогов
  (УСН+НДС) и кабинетных расходов. Зарплаты в неё не входят — это «до ФОТ».
- выручка и прибыль исключённых артикулов — `wbProfitProductBatch` /
  `ozProfitProductBatch` за тот же месяц (как «Сводка по товарам»).
- для текущего месяца окно — с 1-го по вчера включительно (как остальные окна
  панели); прошлые месяцы — целиком.

**Формула** (`lib/bonus.js`, чистые функции):

```
salesFact  = revenue_platform − Σ revenue(excluded)
profitFact = profit_platform  − Σ profit(excluded)
salesPlan  = sales_plan  − Σ sales_plan_off(excluded)
profitPlan = profit_plan − Σ profit_plan_off(excluded)
marginPlan = profitPlan / salesPlan;   marginFact = profitFact / salesFact

pSales = salesFact / salesPlan; pProfit = profitFact / profitPlan; pMargin = marginFact / marginPlan
avg = (pSales + pProfit + pMargin) / 3

bonusBase = bonus_pct × profitFact              # 4 % по умолчанию
eligible  = все три p ≥ threshold (0.65) И profitFact > 0
bonus     = eligible ? bonusBase × avg : 0
payout    = salary + bonus                      # оклад 40 000 по умолчанию
```

- Потолка нет (решение владельца).
- План не задан / `salesPlan ≤ 0` / `profitPlan ≤ 0` → статус `no_plan`, бонус 0,
  проценты не считаются, оклад показан.
- `salesFact ≤ 0` → маржа факта не определена → `pMargin = 0` → ниже порога.
- Кабинетные расходы не делятся по артикулам и целиком остаются на менеджере.
- Контрольный пример (лист владельца): план 10 000 000 / 1 500 000, факт
  20 000 000 / 2 000 000 → p = 2 / 1,333 / 0,667, avg 1,333, бонус 106 667, к
  оплате 146 667 ₽.

## 3. Данные (миграция `064_bonus.sql`)

Все таблицы в `tenant.*`, `cabinet_id` в PK, RLS-политика как у остальных
tenant-таблиц, плюс `panel_local_ro_cab1` (урок памяти). Маппинг имён в
`lib/db.js` не нужен — роут пишет полные имена через `tenantQuery`.

- `tenant.bonus_employees` — `cabinet_id, user_id, platform ('wb'|'ozon'),
  salary NUMERIC(14,2) DEFAULT 40000, bonus_pct NUMERIC(6,4) DEFAULT 0.04,
  threshold NUMERIC(6,4) DEFAULT 0.65, is_active BOOL DEFAULT true, created_at,
  updated_at`; PK `(cabinet_id, user_id)`. Пользователь обязан быть участником
  кабинета (проверка в роуте по `auth.memberships`).
- `tenant.bonus_plans` — `cabinet_id, user_id, period TEXT 'YYYY-MM',
  sales_plan NUMERIC(14,2), profit_plan NUMERIC(14,2), updated_at, updated_by`;
  PK `(cabinet_id, user_id, period)`.
- `tenant.bonus_exclusions` — `cabinet_id, id BIGSERIAL, user_id, period,
  sku_key BIGINT` (WB `nm_id` / Ozon `product_id` — по площадке сотрудника),
  `sales_plan_off NUMERIC(14,2) DEFAULT 0, profit_plan_off NUMERIC(14,2) DEFAULT 0,
  reason TEXT NOT NULL, created_by, created_at`; PK `(cabinet_id, id)`, UNIQUE
  `(cabinet_id, user_id, period, sku_key)`.
- `tenant.bonus_closings` — `cabinet_id, user_id, period, snapshot JSONB` (все
  входы: параметры, план, исключения с их фактом, факт площадки, результат),
  `closed_by, closed_at`; PK `(cabinet_id, user_id, period)`.

Закрытый месяц: план, исключения и расчёт берутся из `snapshot`; правка плана и
исключений этого месяца → 409. «Снять фиксацию» удаляет строку закрытия (только
владелец, подтверждение в UI). Параметры сотрудника (оклад/%/порог) в снимке
заморожены — их последующая правка закрытые месяцы не меняет.

## 4. API `/api/cabinets/[id]/bonus`

- `GET ?period=YYYY-MM[&user_id=N]`:
  - manager → всегда своя карточка; `user_id` из запроса игнорируется (берётся из
    сессии). Не в программе → 403 «Раздел недоступен».
  - owner → `{ employees: [...] }` (список для вкладок) + карточка выбранного
    (`user_id` или первый). Кандидаты для добавления — участники кабинета не из
    программы.
  - viewer → 403.
  - Карточка: `{ employee, period, status: 'live'|'closed'|'no_plan', closedAt,
    closedBy, plan, fact, exclusions[], indicators: [{key, plan, fact, pct, below}],
    avg, bonusBase, bonus, payout, eligible }`.
- `POST` (только owner, `requireRole: 'owner'`), `action`:
  `employee_upsert` (user_id, platform, salary, bonus_pct, threshold, is_active),
  `plan_set` (user_id, period, sales_plan, profit_plan),
  `exclusion_add` (user_id, period, sku_key, sales_plan_off, profit_plan_off,
  reason), `exclusion_delete` (id), `close` (user_id, period — пишет снимок из
  текущего живого расчёта), `reopen` (user_id, period).
  Проверка `action` до проверки id (урок D10). Закрытый месяц → 409 на
  `plan_set`/`exclusion_*`/`close`.
- Чтение факта: через `DatabaseSync('wb'|'ozon')` внутри транзакции
  `withCabinet`, запросы последовательно (без `Promise.all` — урок
  `lib/warehousesData.js`). Налоговый режим — `cabinet.shopTax[platform]`.

## 5. UI `/cabinets/[id]/bonus`

Пункт «Премия» в меню «Финансы» (после «Баланса»): виден владельцу и менеджеру в
программе. Для остальных пункт скрыт, страница показывает «Раздел недоступен».

- Выбор месяца (дефолт — текущий). У владельца — вкладки сотрудников
  «WB · Имя / Ozon · Имя» и кнопка «+ сотрудник».
- Таблица показателей: Продажи / Операционная прибыль / Маржа % × План / Факт /
  % выполнения; показатель ниже порога подсвечен `C.neg`, строка «Итого» —
  среднее.
- Блок «Расчёт»: оклад, бонусная часть (`bonus_pct` × прибыль), коэффициент
  (avg или «0 — показатель ниже 65 %»), **к оплате**. Пилл «предварительно» /
  «зафиксировано DD.MM, <кто>».
- Исключённые артикулы: товар (имя из каталога), его факт продаж/прибыли, снятый
  план, причина; у владельца «+ исключить» (выбор товара площадки) и ✕.
- У владельца: «Зафиксировать месяц», «Снять фиксацию» (confirm), «⚙ Параметры»
  (площадка, оклад, %, порог, активен), ввод плана месяца.
- Палитра — `lib/palette.js`, хуки до ранних `return` (D7), fetch в backticks (D3).

## 6. Проверка

- `lib/__tests__/bonus.test.mjs`: контрольный пример листа (146 667); порог (один
  показатель 0,64 → бонус 0); `no_plan`; исключение (факт и план снимаются вместе,
  % растёт); отрицательная прибыль; нулевые продажи.
- Тест доступа роута: manager видит только себя (чужой `user_id` → своя
  карточка), viewer → 403, POST manager → 403, закрытый месяц → 409.
- Смоук `scripts/smoke-bonus.mjs 1` (кабинет #1, только чтение): факт без
  исключений = `/pnl` за тот же месяц по площадке, Δ = 0.
- Права: скрининг из §1, ручная проверка менеджером-тестом на кабинете #1
  (тестовый пользователь, удаляется после).

## 7. Не делаем сейчас

Выплаты и запись в ДДС; квартальная/годовая премия; план по артикулам; шкала
коэффициентов из старого листа; потолок; письма менеджерам; несколько площадок
на одного сотрудника.
