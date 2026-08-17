# Ремонт данных прибыли Ozon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть четыре известных дефекта качества данных прибыли Ozon (ad_spend в дни без заказов; бездатные строки; SKU-пропуски; слепота сторожа к резолвленным номерам) и дать сторожу скользящее окно — с шлюзом владельца перед подменой истории.

**Architecture:** Точечные правки сборщиков (`ozon_efficiency`, `ozon_order_costs`) и сторожа с сохранением всех контрактов; аддитивная колонка `src_unit_number`; пересчёт истории через теневую таблицу с документом дельты и обязательным «да» владельца перед атомарной подменой.

**Tech Stack:** Python-воркер, PostgreSQL + RLS, Node-сверки (`readonlyPgConfig`), systemd.

**Spec:** `docs/superpowers/specs/2026-08-17-ozon-data-repair-design.md` — нормативна.

## Global Constraints

- Юнит собирается по ПОЛНОЙ истории строк начислений; lookback-пол 45 дней с концом «вчера» (`resolve_window`); DELETE-ключи = posting ∪ исходные unit_number — эти механизмы из прошлого плана НЕ ломать (регресс = Critical).
- Инвариант сумм и знаковая согласованность компонент сохраняются; после датировки строк с NULL в обеих датах быть не должно (сборщик проверяет); целевой разрыв инварианта за всю историю = 0 ₽ (допуск 1 ₽) — известные исключения исчезают.
- Контракт колонок панели не меняется; `src_unit_number` — аддитивно, роуты её не знают.
- Кабинетные `cost_type` только `accrual_%`; незнакомое не выбрасывается молча; `datetime.now(timezone.utc)`; миграции идемпотентны (следующий свободный номер — 042); тексты по-русски.
- БД читать `saas_ro`; данные писать только сборщиками; миграции и подмена — админским psql по скрипту из репо (`PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f <файл>`).
- API Ozon не нужен и запрещён — все данные уже в БД.
- Подмена истории — ТОЛЬКО после явного «да» владельца по документу дельты (шлюз в задаче 5). Починка ad_spend (задача 1) шлюза не требует — это не подмена модели, а восстановление потерянных строк рекламы из уже собранного источника.
- Правило проекта: расхождение цифр = наш баг, пока не доказано обратное.
- Python: `/opt/agents/data-presenter-agent/.venv/bin/python`; прогоны сборщиков оркестратором: `cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas && <venv-python> -m worker.orchestrator --cabinet <id> --collectors <имя> --date-from ... --date-to ... --run-kind manual`.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `worker/collectors/ozon_efficiency.py` (правка `_collect_ads`) | Upsert вместо UPDATE-only; ad_spend в дни без заказов |
| `db/migrations/042_ozon_order_costs_src_unit.sql` (создать) | Колонка `src_unit_number` |
| `worker/collectors/ozon_order_costs.py` (правка) | Датировка бездатных юнитов; строки без product_id; запись src_unit_number |
| `scripts/check-ozon-profit-calc.py` (расширить) | Синтетика: датировка, юнит без товара, src_unit_number |
| `scripts/check-ozon-profit-invariant.mjs` (правка) | detail-JOIN по src_unit_number; скользящее окно 4 недель |
| `docs/ozon-data-repair-delta.md` (создать) | Документ дельты для владельца (шлюз) |
| `scripts/switch-ozon-data-repair.sql` (создать) | Атомарная подмена (журнал операции) |
| `docs/ozon-accrual-reconciliation.md`, `docs/data-trust-map.md` (правка) | Семантика «дата первой операции», NULL product_id, статусы |

---

### Task 1: Починка ad_spend и бэкфилл

**Files:**
- Modify: `worker/collectors/ozon_efficiency.py` (функция `_collect_ads`)
- Test: расширение существующего механизма проверок (посмотреть, есть ли у ozon_efficiency проверки; если нет — проверка через контрольные SQL в отчёте)

**Interfaces:**
- Consumes: `tenant.ozon_daily_campaign_ad` (источник расходов по кампаниям, уже собирается), `tenant.ozon_daily_efficiency` (целевая таблица; прочитать `\d` и понять PK/колонки перед правкой).
- Produces: строки `ozon_daily_efficiency` существуют для каждого дня с рекламой, даже без заказов. На это опирается Check 3 сторожа.

- [ ] **Шаг 1: Прочитать текущий код и DDL.** `worker/collectors/ozon_efficiency.py::_collect_ads` (UPDATE-only паттерн, задокументирован в `docs/data-trust-map.md`), `\d tenant.ozon_daily_efficiency` под saas_ro. Зафиксировать в отчёте: PK, какие колонки пишет `_collect_sales`, какие `_collect_ads`.

- [ ] **Шаг 2: Написать падающую проверку.** Контрольный SQL (в отчёт + как проверка после фикса): дни, где `ozon_daily_campaign_ad` имеет расход, а `ozon_daily_efficiency` — нет строки или NULL ad_spend:

```sql
SELECT c.cabinet_id, c.date, round(sum(c.spend)::numeric,2) AS campaign_spend,
       e.ad_spend
  FROM tenant.ozon_daily_campaign_ad c
  LEFT JOIN tenant.ozon_daily_efficiency e
    ON e.cabinet_id = c.cabinet_id AND e.date = c.date
 GROUP BY 1,2,4
HAVING sum(c.spend) > 0 AND (e.ad_spend IS NULL OR e.ad_spend = 0)
 ORDER BY 1,2;
```
Ожидание ДО фикса: есть строки (минимум 2026-08-13 каб.1008, 1 507,95 ₽).

- [ ] **Шаг 3: Заменить UPDATE-only на upsert.** По образцу соседних upsert-функций в `db_pg.py` (`ON CONFLICT (<PK из шага 1>) DO UPDATE SET ad_spend = EXCLUDED.ad_spend, updated_at = ...`); прочие метрики новой строки — NULL (не нули: заказов в тот день не было, это честное отсутствие). Незатронутые колонки существующих строк не перетирать.

- [ ] **Шаг 4: Бэкфилл.** Прогнать `ozon_efficiency` за всё покрытие `ozon_daily_campaign_ad` (найти min(date) по кабинетам) оркестратором, оба кабинета. SQL шага 2 после — 0 строк. Контроль сумм: `SUM(e.ad_spend)` = `SUM(c.spend)` за период пересечения (допуск 0,01; если не сходится — разобраться, чей источник шире, зафиксировать).

- [ ] **Шаг 5: Диагностика WB (только факт, без починки).** Найти WB-аналог записи ad_spend (grep по `wb_daily_metrics`/`wb_daily_ad` в worker/collectors), проверить тем же SQL-паттерном, болеет ли UPDATE-only. Результат — в отчёт и (если болеет) строкой в `docs/data-trust-map.md` как известная проблема.

- [ ] **Шаг 6: Сторож Check 3.** `node scripts/check-ozon-profit-invariant.mjs` — Check 3 зелёный по обоим кабинетам.

- [ ] **Шаг 7: Коммит.** `git add worker/collectors/ozon_efficiency.py docs/data-trust-map.md && git commit -m "fix(ozon): ad_spend в дни без заказов — upsert вместо UPDATE-only + бэкфилл"`

---

### Task 2: Миграция 042 — src_unit_number

**Files:**
- Create: `db/migrations/042_ozon_order_costs_src_unit.sql`

**Interfaces:**
- Produces: колонка `tenant.ozon_order_costs.src_unit_number text` (NULL допустим до пересчёта). На неё опираются задачи 3-4.

- [ ] **Шаг 1: Миграция.**

```sql
BEGIN;
ALTER TABLE tenant.ozon_order_costs
  ADD COLUMN IF NOT EXISTS src_unit_number text;
COMMENT ON COLUMN tenant.ozon_order_costs.src_unit_number IS
  'Исходный unit_number начислений до резолва в posting_number заказа; для сторожа';
COMMIT;
```
Индекс НЕ создавать (спека: только если сторож замедлится — решается в задаче 4).

- [ ] **Шаг 2: Применить и проверить.** Админским psql; `\d` показывает колонку; повторное применение чисто; RLS-политики не задеты (политики уровня таблицы, новых не нужно — убедиться `\d`).

- [ ] **Шаг 3: Коммит.** `git commit -m "feat(ozon): колонка исходного номера отправления для сторожа"`

---

### Task 3: Сборщик — датировка, строки без товара, src_unit_number

**Files:**
- Modify: `worker/collectors/ozon_order_costs.py`, `worker/db_pg.py` (список колонок upsert)
- Test: `scripts/check-ozon-profit-calc.py` (расширить)

**Interfaces:**
- Consumes: колонка из задачи 2; `RETURN_TYPE_IDS`/`classify_row` из `ozon_profit_map.py`; существующие механизмы v2 (полная история юнита, resolve_window, DELETE-ключи, инвариант).
- Produces: строки order_costs всегда имеют дату (sale_dt или return_dt) и всегда пишутся (product_id может быть NULL); `src_unit_number` заполнен у всех строк. На это опираются задачи 4-6.

- [ ] **Шаг 1: Падающие проверки** (расширить `check-ozon-profit-calc.py`, TDD):
  - юнит без commission-блока, не возвратный → `sale_dt == min(date его строк)`, `return_dt IS NULL`;
  - юнит без commission-блока, помеченный возвратным (тип 45) → `return_dt == min(date)`, `sale_dt IS NULL`;
  - юнит с commission-блоком → даты как раньше (регресс-проверка: правило «первой операции» НЕ применяется);
  - юнит со sku, отсутствующим в каталоге и в заказах → строка ЕСТЬ, `product_id IS NULL`, деньги на месте;
  - `src_unit_number` == исходному unit_number у резолвленных и нерезолвленных;
  - инвариант: в результате build_order_costs нет строк с NULL в обеих датах.
  Run → FAIL (логики нет).

- [ ] **Шаг 2: Реализация.** В `build_order_costs`/`resolve_meta`: (а) датировка по правилу спеки (min(date) строк юнита; выбор колонки по признаку возвратности — та же логика, что ставит `is_return`); (б) убрать skip юнитов без product_id: сначала попытка через `tenant.ozon_orders` (posting_number → product_id — посмотреть, какие поля есть), затем `product_id = None`; счётчик «без товара» в итоговой строке (прежний счётчик `skipped_no_product` перестаёт расти — переименовать честно); (в) `src_unit_number` в каждую строку; `db_pg.py`: колонка в INSERT-список (обе функции-цели уже под белым списком таблиц).

- [ ] **Шаг 3: Проверки зелёные.** `check-ozon-profit-calc.py` (все, включая старые), `check-ozon-profit-map.py`.

- [ ] **Шаг 4: Прогон контрольного дня в боевую НЕ делать** — план идёт через тень (задача 5). Вместо этого: юнит-прогон build_order_costs на полной фикстуре с выводом сводки (сколько датировано, сколько без товара) — в отчёт.

- [ ] **Шаг 5: Коммит.** `git commit -m "feat(ozon): датировка бездатных юнитов, строки без товара, src_unit_number"`

---

### Task 4: Сторож — src_unit_number и скользящее окно

**Files:**
- Modify: `scripts/check-ozon-profit-invariant.mjs`
- Modify: `docs/ozon-accrual-reconciliation.md` §9 (описание сторожа)

**Interfaces:**
- Consumes: колонку src_unit_number (после пересчёта задачи 5 она заполнена; до пересчёта — NULL, JOIN обязан деградировать честно: COALESCE(src_unit_number, posting_number)).
- Produces: сторож на 4 закрытые ISO-недели. Задача 6 валидирует его зелёным.

- [ ] **Шаг 1: detail-JOIN.** `oc.src_unit_number = a.unit_number` → через `COALESCE(oc.src_unit_number, oc.posting_number)` (переходный период до пересчёта). Категория `no_row` после пересчёта обязана перестать ловить резолвленные юниты.

- [ ] **Шаг 2: Скользящее окно.** Цикл по 4 последним закрытым ISO-неделям; каждая неделя — свой блок вывода (все проверки, оба кабинета) и свой вклад в exit; `--weeks N` для ручных прогонов. Замерить время (`time node ...`); > 1 мин — оптимизировать запросы (один запрос на 4 недели с GROUP BY неделя вместо 4 запросов) — решить по факту замера.

- [ ] **Шаг 3: Разовый прогон.** До пересчёта задачи 5 допустимы известные красные (unresolved-доля прошлых недель может отличаться) — зафиксировать вывод в отчёт с объяснением каждой красной строки. Check 3 — зелёный (задача 1 сделана).

- [ ] **Шаг 4: Коммит.** `git commit -m "feat(ozon): сторож — скользящее окно 4 недель + src_unit_number"`

---

### Task 5: Тень, дельта, ШЛЮЗ владельца

**Files:**
- Create: `docs/ozon-data-repair-delta.md`

**Interfaces:**
- Consumes: миграция 041 (идемпотентна — пересоздаёт тень), сборщик задачи 3.
- Produces: одобрение владельца. Без него задача 6 не начинается.

- [ ] **Шаг 1: Тень.** Применить 041 (пересоздаст пустую `ozon_order_costs_shadow`); миграция 042-колонку в тени НЕ создаст (LIKE снят с боевой ДО 042? — проверить: 041 использует LIKE, применённый сейчас — унаследует колонку; убедиться `\d`). Прогнать оба кабинета единым диапазоном (2025-08-14..вчера) с `--target-table tenant.ozon_order_costs_shadow`.

- [ ] **Шаг 2: Сверки тени.** Инвариант всей истории: разрыв = 0 ₽ (±1 ₽) — SKU-пропуски исчезли; строк с NULL обеими датами — 0; `src_unit_number` заполнен у 100%; дублей PK нет.

- [ ] **Шаг 3: Документ дельты** `docs/ozon-data-repair-delta.md` (краткий, первая половина — нетехнарю): помесячно оба кабинета — прибыль была (боевая)/стала (тень)/разница; сколько денег обрело даты (по месяцам); сколько отправлений и ₽ добавилось в старые месяцы каб.1; годовой итог: изменение = ровно возвращённые SKU-пропуски (показать сверку). Коммит документа.

- [ ] **Шаг 4: СТОП.** Контроллер несёт документ владельцу. Задача 6 — только после «да».

---

### Task 6: Подмена и финальная валидация

**Files:**
- Create: `scripts/switch-ozon-data-repair.sql`

**Interfaces:**
- Consumes: «да» владельца (задача 5); тень.
- Produces: боевая таблица отремонтирована; сторож полностью зелёный.

- [ ] **Шаг 1: Подмена.** Скрипт по образцу `scripts/switch-ozon-profit.sql` (одна транзакция, предохранитель с числами удаляемых до удаления, DROP тени вне транзакции после сверки). Выполнить админским psql вне окна планового прогона; вывод — в отчёт.

- [ ] **Шаг 2: Снимок после = документ дельты** (помесячные суммы, оба кабинета, до копейки).

- [ ] **Шаг 3: Полная валидация сторожа.** `node scripts/check-ozon-profit-invariant.mjs` — ожидание: ВСЕ проверки зелёные по всем 4 неделям и обоим кабинетам (Check 1 остатки = 0±1 ₽ — упаковочные эффекты теперь внутри полной истории юнита; Check 2 доли упадут — датированные строки покинули unresolved; Check 3 зелёный). Любая красная строка — разобраться, не подгонять.

- [ ] **Шаг 4: Плановый цикл.** После ближайшего тика: `jobs.collector_runs` — ozon_efficiency/ozon_accruals/ozon_order_costs ok (или skipped при известном 403-паттерне 12:00 — легитимно); повторный тик не меняет суммы (идемпотентность с новой датировкой).

- [ ] **Шаг 5: Документация.** §9/§10 `docs/ozon-accrual-reconciliation.md` и `docs/data-trust-map.md`: семантика «дата первой операции», NULL product_id, ad_spend починен, сторож 4-недельный. Оговорку про −1,81 млн вне разрезов — снять/переписать (теперь видимы).

- [ ] **Шаг 6: Коммит.** `git commit -m "feat(ozon): ремонт данных прибыли — подмена выполнена, сторож полностью зелёный"`

---

## Что в этот план НЕ входит

Унификация формул прибыли; потребление `ozon_cabinet_costs` панелью; курсор `last_id`; починка WB ad_spend (только диагностика в задаче 1); 403-паттерн (наблюдение); отключение `ozon_finance`.

## Проверка плана по спеке

| Требование спеки | Задача |
|---|---|
| ad_spend upsert + бэкфилл + сверка сумм + WB-диагностика | 1 |
| Датировка «датой первой операции», выбор колонки по возвратности | 3 |
| Строки без товара (резолв через orders → NULL), разрыв инварианта → 0 | 3, 5 |
| src_unit_number аддитивно + переход сторожа | 2, 4 |
| Скользящее окно 4 недель | 4 |
| Тень → дельта → «да» владельца → подмена | 5, 6 |
| Контракты v2 не ломаются (полная история, lookback, DELETE-ключи) | Global Constraints, регресс-проверки задачи 3 |
| Сторож полностью зелёный в финале | 6 |
