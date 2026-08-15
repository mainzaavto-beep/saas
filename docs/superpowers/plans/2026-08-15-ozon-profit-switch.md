# Переключение расчёта прибыли Ozon на источник начислений — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Прибыль Ozon в `tenant.ozon_order_costs` считается из `tenant.ozon_accruals` (все 14 типов операций вместо 6), история пересчитана целиком, панель не тронута.

**Architecture:** Сборщик `ozon_order_costs` переписывается на новый источник с сохранением контракта таблицы; недостающие позаказные типы попадают в `logistics` (её вычитают все формулы панели), NON_ITEM — в `tenant.ozon_cabinet_costs` (кроме продвижения — оно уже в `ad_spend`). Пересчёт идёт через теневую таблицу с документом дельты, подмена — только после одобрения владельцем. После переключения — еженедельные сторожа.

**Tech Stack:** Python-воркер, PostgreSQL + RLS, Node-скрипты сверок (`readonlyPgConfig`), systemd-timer.

**Spec:** `docs/superpowers/specs/2026-08-15-ozon-profit-switch-design.md` — раскладка колонок и инварианты там нормативны.

## Global Constraints

- Существующие потребители не изменяются: роуты панели (`app/api/**`), `lib/ozonMetrics.js`, старый сборщик `ozon_finance`, сборщик `ozon_accruals` — read-only для этого плана.
- Контракт таблицы `tenant.ozon_order_costs` (колонки, PK `(cabinet_id, posting_number)`, семантика `cost_value_retail` = полная цена ≡ `seller_price`) не меняется.
- **Инвариант:** `SUM(accrued) строк, попавших в order_costs` + `SUM(accrued) строк уровня кабинета` = `SUM(total_amount)` за период. **Согласованность компонент:** `cost_value_retail − |commission| − |logistics| − |acquiring| − |loyalty| = SUM(accrued строк отправления)` на каждом отправлении. Расхождения: счётчик + русский лог + exit 3, строки при этом пишутся.
- Незнакомый тип операции никогда не выбрасывается молча: позаказный → `logistics` + лог, кабинетный → `ozon_cabinet_costs` + лог.
- Кабинетные `cost_type` пишутся ТОЛЬКО с префиксом `accrual_` — чужие cost_type в `ozon_cabinet_costs` не затирать и не удалять.
- Время записи — `datetime.now(timezone.utc)`. Миграции идемпотентны (`IF NOT EXISTS`), следующий свободный номер — 041. Новые тенантные таблицы: RLS-политика для `saas_app` (образец `tenant.ozon_order_costs`) + политика `panel_local_ro_cab1` (`FOR SELECT TO panel_local_ro USING (cabinet_id = 1)`).
- БД читать `saas_ro`; миграции — `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f <файл>`; данные писать только сборщиком.
- API Ozon этому плану не нужен — все данные уже в БД. В API не ходить.
- Тексты логов, сверок и документов — по-русски. Правило: расхождение цифр = наш баг, пока не доказано обратное.
- Python: `/opt/agents/data-presenter-agent/.venv/bin/python`. Прогоны сборщика: `cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas && <venv-python> -m worker.orchestrator --cabinet <id> --collectors ozon_order_costs --date-from ... --date-to ... --run-kind manual`.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `worker/collectors/ozon_profit_map.py` (создать) | Классификатор: (category, type_id) → корзина (commission/logistics/acquiring/loyalty/cabinet/promo); признак возврата |
| `scripts/check-ozon-profit-map.py` (создать) | Проверка классификатора на фикстурах и полноты на живой БД |
| `db/migrations/041_ozon_order_costs_shadow.sql` (создать) | Теневая таблица `tenant.ozon_order_costs_shadow` |
| `worker/collectors/ozon_order_costs.py` (переписать) | Сборщик v2: из `ozon_accruals` → `order_costs` (+ `--target-table`) и NON_ITEM → `ozon_cabinet_costs` |
| `worker/db_pg.py` (правка) | `upsert_ozon_order_costs_many(rows, table=...)` — параметр целевой таблицы; функция записи кабинетных статей, если её нет |
| `scripts/check-ozon-profit-delta.mjs` (создать) | Помесячная дельта прибыли старая↔новая (по shadow) |
| `docs/ozon-profit-switch-delta.md` (создать) | Документ дельты для владельца (блокирующая точка) |
| `scripts/check-ozon-profit-invariant.mjs` (создать) | Сторож: инвариант сумм + продвижение↔ad_spend |
| systemd: `saas-ozon-recon.service/.timer` (создать) | Еженедельный запуск трёх сверок |

---

### Task 1: Классификатор типов операций

**Files:**
- Create: `worker/collectors/ozon_profit_map.py`
- Create: `scripts/check-ozon-profit-map.py`

**Interfaces:**
- Consumes: `shared.ozon_accrual_types` (type_id, name), фикстуры `scripts/fixtures/ozon-accruals/`, таблица «код → роль» из `docs/ozon-accrual-reconciliation.md` §5.
- Produces: `classify_row(category: str, type_id: int|None, has_unit: bool) -> tuple[str, bool]` — (корзина, known), корзина одна из `'commission'|'logistics'|'acquiring'|'loyalty'|'cabinet'|'promo'`; константы `RETURN_TYPE_IDS = {45, 59}`, `NONITEM_PROMO_TYPE_IDS`, `LOYALTY_TYPE_IDS`, `PER_ORDER_LOGISTICS_TYPE_IDS`, `KNOWN_CABINET_TYPE_IDS`. На них опираются задачи 3, 4, 6.

- [ ] **Шаг 1: Снять фактический перечень типов за год**

```sql
SELECT accrued_category, a.type_id, t.name,
       count(*) AS строк, round(sum(a.accrued)::numeric,2) AS сумма
  FROM tenant.ozon_accruals a
  LEFT JOIN shared.ozon_accrual_types t ON t.type_id = a.type_id
 GROUP BY 1,2,3 ORDER BY 1, 5;
```
(под `saas_ro`, оба кабинета). Каждую строку перечня классифицировать по смыслу имени и
таблице «код → роль» §5. Спорные — в отчёт задачи с обоснованием выбора.

- [ ] **Шаг 2: Написать падающую проверку**

`scripts/check-ozon-profit-map.py` (по образцу `scripts/check-ozon-accruals-parse.py`, фикстуры из репо, БД не нужна) проверяет:
- каждая строка каждой записи фикстуры получает ровно одну корзину, исключений нет;
- POSTING `type_id IS NULL` → `'commission'`-корзина (это commission-блок);
- ITEM type_id=1 → `'acquiring'`;
- NON_ITEM с type_id из перечня продвижения → `'promo'`, прочие NON_ITEM → `'cabinet'`;
- незнакомый выдуманный type_id (напр. 999999) с unit_number → `'logistics'`; без unit_number → `'cabinet'`;
- `RETURN_TYPE_IDS == {45, 59}`.

Run: `/opt/agents/data-presenter-agent/.venv/bin/python scripts/check-ozon-profit-map.py`
Expected: FAIL (модуля нет).

- [ ] **Шаг 3: Написать модуль**

```python
# worker/collectors/ozon_profit_map.py
"""Классификация строк начислений Ozon по корзинам расчёта прибыли.

Корзины позаказные (unit_number IS NOT NULL): commission, logistics,
acquiring, loyalty. Корзины уровня кабинета (unit_number IS NULL):
cabinet, promo. Незнакомое НЕ выбрасывается: позаказное -> logistics,
кабинетное -> cabinet (вызывающий код логирует по флагу known=False).
Перечни составлены по shared.ozon_accrual_types и разбору
docs/ozon-accrual-reconciliation.md за 2025-08..2026-08; при появлении
новых типов сторож (check-ozon-profit-invariant) не даст им потеряться.
"""

RETURN_TYPE_IDS = {45, 59}          # логистика возврата — маркер возвратного отправления

ACQUIRING_TYPE_IDS = {1}
LOYALTY_TYPE_IDS = set()            # заполняется по факту шага 1 (может остаться пустым)
NONITEM_PROMO_TYPE_IDS = {...}      # трафареты/вывод в топ/продвижение — из шага 1
PER_ORDER_LOGISTICS_TYPE_IDS = {...}  # 32, 29, 98 + прочие позаказные сервисы из шага 1


def classify_row(category, type_id, has_unit):
    """-> (bucket, known). bucket: commission|logistics|acquiring|loyalty|cabinet|promo."""
    if category == "POSTING" and type_id is None:
        return "commission", True
    if type_id in ACQUIRING_TYPE_IDS:
        return "acquiring", True
    if type_id in LOYALTY_TYPE_IDS:
        return "loyalty", True
    if not has_unit:
        if type_id in NONITEM_PROMO_TYPE_IDS:
            return "promo", True
        return "cabinet", type_id in KNOWN_CABINET_TYPE_IDS
    return "logistics", type_id in PER_ORDER_LOGISTICS_TYPE_IDS
```
(`KNOWN_CABINET_TYPE_IDS` — явный перечень встреченных кабинетных типов из шага 1.
Многоточия в плане — это места, которые заполняет ШАГ 1 этой же задачи конкретными
числами; в коммите многоточий быть не должно, проверка шага 2 это ловит.)

- [ ] **Шаг 4: Прогнать проверку** — Expected: PASS. Затем прогнать полноту на живой БД: расширить `check-ozon-profit-map.py` режимом `--live` (подключение через `psycopg2` с кредами из окружения воркера, читает перечень шага 1 и убеждается, что каждый встречающийся (category, type_id) классифицируется с known=True). Expected: 0 незнакомых.

- [ ] **Шаг 5: Коммит** — `git add worker/collectors/ozon_profit_map.py scripts/check-ozon-profit-map.py && git commit -m "feat(ozon): классификатор типов начислений для расчёта прибыли"`

---

### Task 2: Теневая таблица (миграция 041)

**Files:**
- Create: `db/migrations/041_ozon_order_costs_shadow.sql`

**Interfaces:**
- Produces: `tenant.ozon_order_costs_shadow` — точная копия структуры `tenant.ozon_order_costs`. На неё опираются задачи 3-5.

- [ ] **Шаг 1: Написать миграцию**

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS tenant.ozon_order_costs_shadow
  (LIKE tenant.ozon_order_costs INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
ALTER TABLE tenant.ozon_order_costs_shadow ENABLE ROW LEVEL SECURITY;
-- политики LIKE не копирует — создать обе по образцу ozon_order_costs
-- (tenant_iso_* для saas_app с current_setting('app.cabinet_id'), panel_local_ro_cab1),
-- обе через DO $$ IF NOT EXISTS (pg_policies) $$ — образец: db/migrations/040_ozon_accruals.sql.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.ozon_order_costs_shadow TO saas_app;
COMMIT;
```

- [ ] **Шаг 2: Применить и проверить** — `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f db/migrations/041_ozon_order_costs_shadow.sql`; затем `\d tenant.ozon_order_costs_shadow` (структура + обе политики), повторное применение чисто.

- [ ] **Шаг 3: Коммит** — `git commit -m "feat(ozon): теневая таблица для пересчёта прибыли"`

---

### Task 3: Сборщик v2

**Files:**
- Modify (переписать): `worker/collectors/ozon_order_costs.py`
- Modify: `worker/db_pg.py`
- Create: `scripts/check-ozon-profit-calc.py`

**Interfaces:**
- Consumes: `classify_row`/`RETURN_TYPE_IDS` из задачи 1; `tenant.ozon_accruals`; метаданные `tenant.ozon_orders` и себестоимость `tenant.cost_overrides` — тем же способом, что текущий сборщик (прочитать его ДО переписывания: как берутся product_id/size/qty/даты/self_buyout — эту логику сохранить); `upsert_ozon_order_costs_many` (db_pg.py:923).
- Produces: сборщик `ozon_order_costs` с параметром `--target-table` (default `tenant.ozon_order_costs`, допустимо `tenant.ozon_order_costs_shadow` — валидировать по белому списку из этих двух значений, НЕ подставлять произвольную строку в SQL); запись NON_ITEM-статей в `tenant.ozon_cabinet_costs` с `cost_type = 'accrual_<type_id>'`, `description` = имя типа из справочника.

- [ ] **Шаг 1: Прочитать текущий сборщик и db_pg-функции.** Зафиксировать в отчёте задачи: откуда берутся product_id/size/qty/order_dt/sale_dt/return_dt/self_buyout; как устроен `upsert_ozon_order_costs_many`; есть ли функция записи в `ozon_cabinet_costs` (grep `ozon_cabinet_costs` по worker/) — если нет, написать `upsert_ozon_cabinet_costs_many(rows)` по образцу соседних с ключом конфликта `(cabinet_id, cost_type, date)`.

- [ ] **Шаг 2: Падающая проверка расчёта**

`scripts/check-ozon-profit-calc.py` на репозиторных фикстурах (день 2026-08-05, 79 записей) проверяет функцию `build_order_costs(accrual_rows, meta, costs)` (чистая функция без БД):
- продающее отправление: `cost_value_retail == seller_price`, `commission == sale_commission`, логистические строки просуммированы в `logistics`, `is_return == 0`;
- возвратное отправление (в фикстуре есть типы 45/59): `is_return == 1`;
- нулевое отправление (sale_price=0, без commission-блока): `is_return == 0` — фикс эвристики ±835 ₽;
- ITEM-эквайринг попал в `acquiring` своего отправления;
- согласованность компонент на каждом отправлении: `cost_value_retail − |commission| − |logistics| − |acquiring| − |loyalty| == SUM(accrued)` (допуск 0,01);
- инвариант: сумма по order_costs-строкам + сумма cabinet/promo-строк == сумма `total_amount` всех записей (допуск 0,01);
- `profit == SUM(accrued) − cost` при заданном cost.

Run → Expected: FAIL (функции нет).

- [ ] **Шаг 3: Переписать сборщик.** Структура: `collect(...)` читает `ozon_accruals` за период (`date BETWEEN`), группирует по `unit_number` → `build_order_costs(...)` → пакетный upsert в `--target-table`; NON_ITEM: суммирует по (type_id, date), корзина `cabinet` → upsert в `ozon_cabinet_costs` (`cost_type='accrual_<type_id>'`), корзина `promo` → НЕ пишется (только счётчик в итоговой строке). Пересбор идемпотентен: перед вставкой DELETE строк пересобираемых `posting_number` (и `cost_type LIKE 'accrual_%'` за период — только своих!) в той же транзакции — образец `upsert_ozon_accruals_many` (db_pg.py:855-901). Счётчики нарушений инварианта/согласованности/незнакомых типов → русский лог + exit 3 по образцу `partial_exit_code` из `ozon_accruals.py`.

- [ ] **Шаг 4: Проверка** — `check-ozon-profit-calc.py` PASS; `check-ozon-profit-map.py` PASS (не сломан).

- [ ] **Шаг 5: Прогон одного дня в shadow** — оркестратором, кабинет 1, 2026-08-05, `--target-table tenant.ozon_order_costs_shadow` (проверить, как оркестратор передаёт доп-аргументы сборщику; если не умеет — запуск модуля напрямую тем же окружением). Сверка под `saas_ro`: сумма `profit+cost` строк shadow за день + кабинетные `accrual_%`-статьи за день + promo-счётчик из лога = 31 643,50 (известный `total_amount` дня).

- [ ] **Шаг 6: Коммит** — `git commit -m "feat(ozon): расчёт прибыли из начислений — сборщик v2"`

---

### Task 4: Теневой пересчёт года и документ дельты

**Files:**
- Create: `scripts/check-ozon-profit-delta.mjs`
- Create: `docs/ozon-profit-switch-delta.md`

**Interfaces:**
- Consumes: shadow-таблица, наполненная за всё покрытие начислений (оба кабинета); боевая `ozon_order_costs`.
- Produces: документ дельты — блокирующая точка владельца.

- [ ] **Шаг 1: Прогнать год в shadow** — оба кабинета (1, 1008), помесячными чанками (образец — задача 4 переезда начислений; API не используется, поэтому пауз не нужно, но следить за таймаутом `SAAS_COLLECTOR_TIMEOUT_SEC`). Кабинетные статьи `accrual_%` при этом наполняются в боевую `ozon_cabinet_costs` — это ок (их пока никто не читает).

- [ ] **Шаг 2: Скрипт дельты** (`readonlyPgConfig`, по образцу `scripts/check-ozon-accruals.mjs`): помесячно по кабинету: старая прибыль (`SUM(profit)` боевой), новая (`SUM(profit)` shadow), разница ₽/%, плюс контекст: сумма кабинетных `accrual_%`-статей месяца и promo-сумма (из `ozon_accruals` по перечню промо-типов) отдельными колонками. Вывод — все месяцы, включая сошедшиеся.

- [ ] **Шаг 3: Разложение дельты** — для 2-3 месяцев с наибольшей дельтой: сколько дало (а) включение новых позаказных типов (сумма `logistics` shadow − `logistics` боевой), (б) фикс возвратной эвристики (число отправлений, сменивших `is_return`, и их суммарная прибыль), (в) прочее (остаток). До рубля не требуется, но остаток «прочее» > 10% дельты месяца — разобрать глубже.

- [ ] **Шаг 4: Документ** `docs/ozon-profit-switch-delta.md`: таблицы шагов 2-3, вывод по-русски. Коммит: `git commit -m "docs(ozon): дельта прибыли старая/новая модель — на решение владельца"`.

- [ ] **Шаг 5: СТОП — одобрение владельца.** Дальше задачи 5-6 только после явного «да» владельца по документу дельты. Это требование спеки, не формальность.

---

### Task 5: Подмена и приёмка

**Files:**
- Create: `scripts/switch-ozon-profit.sql` (одноразовый, но в репо — это журнал операции)

**Interfaces:**
- Consumes: одобрение владельца (задача 4, шаг 5); shadow-таблица.
- Produces: боевая `ozon_order_costs` на новой модели; плановый прогон пишет по-новому.

- [ ] **Шаг 1: Снимок до подмены** — сохранить в отчёт задачи: `SELECT to_char(date_trunc('month', sale_dt::date),'YYYY-MM') m, cabinet_id, count(*), round(sum(profit)::numeric,2) FROM tenant.ozon_order_costs GROUP BY 1,2 ORDER BY 1,2;` (учесть, что sale_dt — text; NULL-даты отдельной строкой).

- [ ] **Шаг 2: Подмена одной транзакцией** (`scripts/switch-ozon-profit.sql`, применять админским psql — это операция владельца данных, зафиксировать вывод):

```sql
BEGIN;
DELETE FROM tenant.ozon_order_costs oc
 USING tenant.ozon_order_costs_shadow s
 WHERE oc.cabinet_id = s.cabinet_id AND oc.posting_number = s.posting_number;
-- плюс строки боевой таблицы за период покрытия shadow, которых в shadow нет
-- (отправления, исчезнувшие из нового источника): удалить по попаданию
-- sale_dt::date в [min(date), max(date)] покрытия shadow этого кабинета,
-- с выводом их числа и суммы profit ДО удаления (если сумма заметная — СТОП, разбор).
INSERT INTO tenant.ozon_order_costs SELECT * FROM tenant.ozon_order_costs_shadow;
COMMIT;
```

- [ ] **Шаг 3: Снимок после** — тот же запрос; помесячные суммы обязаны совпасть с колонкой «новая» из документа дельты. Затем `DROP TABLE tenant.ozon_order_costs_shadow;` (админом; миграция 041 идемпотентна — при повторном применении просто пересоздаст пустую).

- [ ] **Шаг 4: Приёмка июля против документов** — компоненты июля-2026 кабинета 1 из новой боевой таблицы против уже сверенных эталонов: `SUM(cost_value_retail)` продаж = 310 050,80 ₽ и возвратов = 30 777,42 ₽ (документ реализации, `sale_price`-эквивалент сверен до копейки — здесь используется `seller_price`-семантика, поэтому эталон = `seller_price`-суммы из БД начислений, сверенные в `docs/ozon-external-reconciliation-2026-08.md` §5); `SUM(|commission|)` = 235 977,80 ₽ (комиссия июля, подтверждена актом взаиморасчётов); `SUM(|acquiring|)` = сумма июльского детального отчёта по эквайрингу (эталон в `docs/ozon-external-reconciliation-expenses-2026-08.md`). Совпадение до копейки по revenue/commission, до 1 ₽ по компонентам услуг (внутримесячные округления по отправлениям).

- [ ] **Шаг 5: Плановый прогон** — убедиться, что в `worker/run_saas_collect.sh` `ozon_accruals` идёт РАНЬШЕ `ozon_order_costs` в `MAIN_COLLECTORS` (fix-wave переезда уже поставил так — проверить, не утверждать) и что `GUARD_DEPS`-механизм (см. комментарий в файле) не требует записи `ozon_accruals → ozon_order_costs`; если требует — добавить. Дождаться/запустить один плановый цикл и проверить `jobs.collector_runs`: `ozon_order_costs` со статусом ok.

- [ ] **Шаг 6: Коммит** — `git commit -m "feat(ozon): прибыль переключена на источник начислений"` (sql-скрипт + правка GUARD_DEPS, если была).

---

### Task 6: Сторожа и документация

**Files:**
- Create: `scripts/check-ozon-profit-invariant.mjs`
- Create: systemd-юниты `saas-ozon-recon.service` / `saas-ozon-recon.timer` (посмотреть, где лежат исходники юнитов `saas-billing-reconcile.*` — в репо или только в /etc/systemd/system — и повторить принятый способ установки)
- Modify: `docs/ozon-accrual-reconciliation.md` (короткий раздел «модель прибыли переключена»), карта доверия к данным (найти файл по названию в docs/)

**Interfaces:**
- Consumes: боевая таблица на новой модели; `NONITEM_PROMO_TYPE_IDS` из задачи 1.
- Produces: еженедельный таймер, гоняющий три сверки; обновлённые документы.

- [ ] **Шаг 1: Скрипт сторожа** (`readonlyPgConfig`; период — прошлая ISO-неделя; `--from/--to` для ручных прогонов):
  1) инвариант: `SUM(cost_value_retail − |commission| − |logistics| − |acquiring| − |loyalty|)` по order_costs недели + `SUM(amount)` `accrual_%`-статей недели + promo-сумма из `ozon_accruals` = `SUM(total_amount)` начислений недели, допуск 1 ₽;
  2) продвижение↔ad_spend: promo-сумма недели против `SUM(ad_spend)` (источник — тот же, что читает панель: `tenant.ozon_daily_efficiency.ad_spend` — проверить по `lib/ozonMetrics.js:ozAdSpend`), порог 100 ₽, настраивается `--promo-threshold`;
  вывод — обе проверки по обоим кабинетам, всегда все строки; любое нарушение → ненулевой exit.

- [ ] **Шаг 2: Таймер** — юниты по образцу `saas-billing-reconcile.timer` (`TZ=Europe/Moscow`, `OnCalendar=Mon 06:30`), service последовательно гоняет `check-ozon-accruals.mjs` (прошлый месяц), `check-ozon-profit-invariant.mjs`; ненулевой exit любого — фейл юнита (виден в systemd). Установить, `systemctl start` разово, проверить журнал.

- [ ] **Шаг 3: Документы** — в `docs/ozon-accrual-reconciliation.md` дописать раздел: модель прибыли переключена (дата, коммиты), формула, ссылки на дельту и сторожей; обновить карту доверия: прибыль Ozon — источник `ozon_accruals`, сверено с документами. Старый сборщик — сторож до решения владельца (~ноябрь 2026).

- [ ] **Шаг 4: Коммит** — `git commit -m "feat(ozon): еженедельные сторожа новой модели прибыли + документация"`

---

## Что в этот план НЕ входит

Унификация 8 инлайн-формул роутов; потребление `ozon_cabinet_costs` панелью; курсор `last_id`; отключение `ozon_finance` (решение владельца ~через 2-3 месяца); юнит-экономика (`lib/unit.js`).

## Проверка плана по спеке

| Требование спеки | Задача |
|---|---|
| Классификация всех типов, незнакомое не теряется | 1 (+3 счётчики) |
| Контракт таблицы сохранён, «прочее» → logistics | 3 |
| Фикс эвристики возвратов (45/59, нулевые отправления) | 1, 3 |
| Инвариант и согласованность компонент, exit 3 | 3 (Global Constraints) |
| NON_ITEM → cabinet_costs, promo не пишется | 3 |
| Теневой пересчёт всей истории, дельта владельцу ДО подмены | 4 |
| Атомарная подмена, откат возможен | 5 |
| Приёмка июля против документов | 5 |
| Сторожа еженедельно, порог 100 ₽ | 6 |
| Старый сборщик остаётся, роуты не тронуты | Global Constraints |
