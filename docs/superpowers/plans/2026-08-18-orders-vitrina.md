# Витрина заказов — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Статусы заказов Ozon перестают замерзать (45-дневное окно + бэкфилл), WB «в пути» показывает нули, /orders защищён от дублей, 60 аномальных отправлений разобраны до механизма.

**Architecture:** Точечные правки сборщика заказов и роута витрины; прибыль (`ozon_order_costs`) не трогается; одна задача-расследование. Шлюз владельца не требуется.

**Tech Stack:** Python-воркер, Ozon Seller API (read-only), Next.js роут, Node/Python проверки.

**Spec:** `docs/superpowers/specs/2026-08-18-orders-vitrina-design.md` — нормативна.

## Global Constraints

- API Ozon только чтение; ≥1 с между запросами/страницами пагинации; `NO_PROXY`; `datetime.now(timezone.utc)`.
- `tenant.ozon_order_costs` и её сборщик НЕ изменяются (кроме отдельного решения контролёра по итогам задачи 3, если найдётся баг разбора).
- Правки сборщика/роута = мгновенный деплой: плановый тик подхватит `ozon_orders.py` сразу после коммита; роут — после `npm run build && systemctl restart saas-web` (протокол: НИКОГДА `next dev` в каталоге прода).
- Сторож `check-ozon-profit-invariant.mjs` обязан остаться ALL PASS 8/8 после всех правок (перезапуск в каждой задаче, трогающей данные/роут — фиксировать в отчёте).
- БД читать `saas_ro`; писать только сборщиками. Тексты по-русски. Расхождение цифр = наш баг, пока не доказано обратное.
- Python: `/opt/agents/data-presenter-agent/.venv/bin/python`; прогоны: `cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas && <venv-python> -m worker.orchestrator --cabinet <id> --collectors ozon_orders --date-from ... --date-to ... --run-kind manual` (если классификатор заблокирует прогон — команду текстом контролёру).

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `worker/collectors/ozon_orders.py` (правка) | Lookback-пол 45 дней (конец — сегодня), пауза между страницами |
| `app/api/cabinets/[id]/orders/route.js` (правка) | WB pending profit=0; NOT EXISTS через IS NOT DISTINCT FROM |
| `scripts/check-ozon-profit-calc.py` или соседний (правка/создать) | Проверка окна статусов (юнит-логика дат) |
| `docs/ozon-accrual-reconciliation.md` (правка) | Итог разбора 60 отправлений (§ новый) |
| `scripts/check-ozon-profit-invariant.mjs` (правка, только если задача 3 решит) | Видимая строка-счётчик класса аномалий |

---

### Task 1: Размораживание статусов ozon_orders

**Files:**
- Modify: `worker/collectors/ozon_orders.py`
- Test: юнит-проверка вычисления окна (рядом с существующими проверками; выбрать место по образцу `check-ozon-profit-calc.py` — отдельный небольшой `scripts/check-ozon-orders-window.py` допустим)

**Interfaces:**
- Consumes: паттерн `resolve_window` (`worker/collectors/ozon_accruals.py:169-243`; MIN_LOOKBACK_DAYS=45, но конец окна — СЕГОДНЯ, не вчера: статус сегодняшнего заказа нужен). Прочитать текущий `ozon_orders.py::collect` и `OzonClient.iter_postings` ДО правки: как передаются since/to, как пагинация, есть ли пауза.
- Produces: каждый плановый прогон освежает статусы всех отправлений за 45 дней. На это опирается приёмка задачи и /orders.

- [ ] **Шаг 1: Падающая проверка окна.** Юнит-тест функции окна (аналог `resolve_window`, но `d_to = сегодня`): узкое окно −2..0 расширяется до 45 дней; явный широкий бэкфилл (90 дней) не сужается. Run → FAIL.

- [ ] **Шаг 2: Реализация.** Пол 45 дней в `collect()` (импортировать/адаптировать `resolve_window` — НЕ копипастить, если можно параметризовать конец окна; иначе локальная функция с явной ссылкой на образец). Убедиться: пауза ≥1 с между страницами пагинации есть (если нет — добавить по образцу `REQUEST_PAUSE_SEC` из `ozon_accruals.py`).

- [ ] **Шаг 3: Проверки зелёные.** Новая + существующие (`check-ozon-profit-calc.py` 108/108 не задет — файл другой, но прогнать для гигиены).

- [ ] **Шаг 4: Бэкфилл 90 дней.** Оба кабинета (1, 1008; 1009 не трогать — ключи paused), оркестратором, `--date-from` = сегодня−90. Перед этим проверить SQL: есть ли in-transit строки старше 90 дней (`SELECT count(*) FROM tenant.ozon_orders WHERE status IN ('delivering','awaiting_packaging','awaiting_deliver') AND substr(order_dt,1,10) < <сегодня−90>`); есть → расширить бэкфилл до их min(order_dt).

- [ ] **Шаг 5: Приёмка.** SQL: строки «`ozon_order_costs.sale_dt` есть И commission ≠ 0 И `ozon_orders.status` in-transit» → ~0 (остаток — только заказы, завершившиеся сегодня-вчера; показать выборку). 497 замёрзших → статусы обновлены (посчитать до/после). Сторож ALL PASS 8/8. Ближайший плановый тик: `jobs.collector_runs` ozon_orders ok, время прогона не выросло критично (пагинация 45 дней ≈ считанные страницы; замерить).

- [ ] **Шаг 6: Коммит.** `git commit -m "fix(ozon): статусы заказов размораживаются — окно 45 дней вместо вечной заморозки"`

---

### Task 2: Роут /orders — WB-нули и guard

**Files:**
- Modify: `app/api/cabinets/[id]/orders/route.js`

**Interfaces:**
- Consumes: решение владельца «нули для WB в пути»; Ozon-образец (pending profit=0 уже реализован).
- Produces: единое поведение площадок; NOT EXISTS устойчив к NULL product_id.

- [ ] **Шаг 1: WB pending profit=0.** Строка `-COALESCE(co.cost, 0) AS profit` в WB pending-запросе → `0 AS profit` (найти точное место; в Ozon-ветке аналогичная правка уже сделана — сверить симметрию, включая комментарий по-русски почему).

- [ ] **Шаг 2: Guard NOT EXISTS.** Оба NOT EXISTS Ozon-ветки: `oc.product_id = o.product_id` → `oc.product_id IS NOT DISTINCT FROM o.product_id`; плюс тот же анализ для WB-ветки NOT EXISTS (если там сравнение по nullable-полю — та же правка; если нет — зафиксировать почему не нужна).

- [ ] **Шаг 3: SQL-симуляция обоих запросов** (под saas_ro, до деплоя): WB pending строки — profit 0; Ozon: дублей нет; synthetic-проверка guard: временно смоделировать NULL product_id в подзапросе симуляции (не в данных!) — дубль не возникает.

- [ ] **Шаг 4: Деплой.** `npm run build && systemctl restart saas-web`; `systemctl is-active saas-web`; `journalctl -u saas-web --since "-5 min"` чист.

- [ ] **Шаг 5: Коммит.** `git commit -m "fix(panel): WB в пути — нули вместо минус-себестоимости; guard NOT EXISTS от NULL product_id"`

---

### Task 3: Разбор 60 аномальных отправлений

**Files:**
- Modify: `docs/ozon-accrual-reconciliation.md` (новый раздел с разбором)
- Modify (только если решение = сторожевой счётчик): `scripts/check-ozon-profit-invariant.mjs`

**Interfaces:**
- Consumes: список аномалий воспроизводим SQL-ем: `|cost_value_retail − commission − logistics − acquiring − loyalty − (profit + cost)| > 0.01` по `tenant.ozon_order_costs` (компонентная формула vs profit из sum_accrued); фикстуры и прошлые разборы (`docs/ozon-accrual-reconciliation.md` §2/§5) — образец метода.
- Produces: объяснение механизма до рубля на 3-5 примерах + решение (баг → эскалация контролёру с оценкой влияния, НЕ чинить самовольно; свойство данных → документация + видимая строка в стороже).

- [ ] **Шаг 1: Снять текущий список.** SQL выше, оба кабинета (ожидаемо ~60, число могло сдвинуться после пересборок — зафиксировать актуальное). Группировка: по месяцам, по знаку расхождения, по наличию склейки (src_unit_number ≠ posting_number).

- [ ] **Шаг 2: Разбор 3-5 представителей.** Для каждого: все строки начислений юнита/семьи (SQL к `ozon_accruals`), пройти разбор руками по правилам классификатора (`ozon_profit_map.classify_row`), найти, где компонентная раскладка теряет/двоит против sum_accrued. Расхождение объяснить до рубля.

- [ ] **Шаг 3: Вердикт и действие.** Баг разбора → отчёт контролёру со списком затронутых сумм (СТОП, без самовольной правки сборщика). Свойство данных → раздел в документации (механизм, примеры, почему profit верен) + строка-счётчик класса в выводе сторожа (число+сумма, всегда печатается; порог — только если класс растёт, решение обосновать данными).

- [ ] **Шаг 4: Проверки.** Сторож ALL PASS 8/8 (с новой строкой, если добавлена); существующие чек-скрипты зелёные.

- [ ] **Шаг 5: Коммит.** `git commit -m "docs(ozon): разбор аномалии компонентной раскладки — механизм и сторожевой счётчик"`

---

## Что в этот план НЕ входит

Пересборки/подмены прибыли; унификация формул; курсор `last_id`; 403-паттерн; ротация мастер-ключа (ждёт владельца); Sendsay-активация (ждёт владельца).

## Проверка плана по спеке

| Требование спеки | Задача |
|---|---|
| Окно 45 дней, конец — сегодня; пауза пагинации | 1 |
| Бэкфилл 90 дней + расширение при старых in-transit | 1 |
| Приёмка: завершённые не висят «в пути» | 1 |
| WB-нули | 2 |
| Guard IS NOT DISTINCT FROM | 2 |
| Разбор 60 до рубля, «замолчать нельзя» | 3 |
| Прибыль не трогается; сторож 8/8 после всего | Global Constraints |
