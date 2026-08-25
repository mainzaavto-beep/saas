# Статья «Сборы Ozon» (services) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Позаказные сервисные операции Ozon (FirstCustomerReview и ещё 8 типов + все неизвестные позаказные) выходят из «Логистики» в отдельную статью `services` — по всей цепочке: БД → сборщик → бэкфилл истории → канон → роуты → UI → сторожа → эталон. Прибыль нигде не меняется.

**Architecture:** Новая колонка `services` в `tenant.ozon_order_costs`; бакет `services` в classify_row (копилка неизвестных позаказных переезжает из logistics в services); слагаемое services во всех трёх Ozon-агрегатах канона и в expenses/profitGross; полный бэкфилл со сверкой «logistics_old = logistics_new + services_new, profit бит-в-бит».

**Tech Stack:** SQL-миграция, Python (worker), Node/ESM (lib, роуты, чек-скрипты), React (UI).

**Спека:** `docs/superpowers/specs/2026-08-25-ozon-services-line-design.md` (d1eefcc).

## Global Constraints

- ПРИБЫЛЬ НЕ МЕНЯЕТСЯ: profit каждой строки БД, скаляр/batch/day канона, snapshot profit-строки — бит-в-бит до и после. Меняется только раскладка расходов (services выделяется из logistics) — налоговая база та же (services и раньше сидели внутри logistics).
- Задача 2 (бэкфилл) начинается ТОЛЬКО после применения миграции 045 (гейт контролёра, §Task 2).
- После задач 3-5: `node scripts/check-profit-canon.mjs --cabinet 1`, `--cabinet 1008` — ALL PASS. `profit-snapshot.mjs --verify`: с задачи 2 до задачи 5 РАСКЛАДОЧНЫЕ Ozon-поля (logistics и производные) дают ОЖИДАЕМЫЙ FAIL (эталон старый), а profit-строки обязаны быть PASS — в каждом отчёте фиксировать оба факта дословным выводом; полный ALL PASS возвращается в задаче 5 после перегенерации эталона.
- WB не трогается (lib/wbMetrics.js, wb-ветки роутов, WB-воркеры).
- Деплой панели только в задаче 4. Тексты по-русски. БД: чтение saas_ro; запись — только воркером (бэкфилл) и миграцией (гейт).
- В отчётах реализаторов — дословный вывод команд, не пересказ.

---

### Task 1: Миграция 045 + сборщик (бакет services)

**Files:**
- Create: `db/migrations/045_ozon_order_costs_services.sql`
- Modify: `worker/collectors/ozon_profit_map.py` (:64-88 списки, :120-137 classify_row)
- Modify: `worker/collectors/ozon_order_costs.py` (аккумуляторы :371-392, comps :611, dict :628-640, возвратная ветка — найти по форме, докстроки)

**Interfaces:**
- Produces: колонка `services NUMERIC NOT NULL DEFAULT 0`; `classify_row -> bucket ∈ {commission, services, logistics, acquiring, loyalty, cabinet, promo}`; строка order_costs с полем `services`; инвариант строки `profit = cost_value_retail − cost − commission − services − logistics − acquiring − loyalty` (задачи 2-4 опираются).

- [ ] **Step 1: Миграция** — файл целиком:

```sql
-- 045: статья «Сборы Ozon» — позаказные сервисные операции (FirstCustomerReview,
-- рассрочка, упаковка, размещение, утилизация и пр.) выходят из logistics
-- в отдельную колонку. Прибыль строк не меняется — только раскладка.
-- Спека: docs/superpowers/specs/2026-08-25-ozon-services-line-design.md
ALTER TABLE tenant.ozon_order_costs ADD COLUMN services NUMERIC NOT NULL DEFAULT 0;
```

- [ ] **Step 2: ozon_profit_map.py** — из `PER_ORDER_LOGISTICS_TYPE_IDS` перенести 9 ITEM-типов в новый набор (объявить над ним, с комментарием в стиле соседних):

```python
# ITEM-типы позаказных СЕРВИСОВ (не перевозка): статья «Сборы Ozon».
# До волны services (2026-08-25) жили в PER_ORDER_LOGISTICS_TYPE_IDS —
# маскировались под логистику (находка владельца: FirstCustomerReview
# 1 813 ₽ выглядел «космической логистикой» отправления 50588097-1427-1).
PER_ORDER_SERVICE_TYPE_IDS = {
    74,   # StarsMembership — звёздные товары
    22,   # Installment — рассрочка
    71,   # SellerReturns — вывоз товара со склада силами Ozon
    116,  # FirstCustomerReview — сбор первых отзывов
    79,   # TemporaryPlacementsAgent — временное размещение товара партнёрами
    15,   # Disposal — утилизация
    78,   # TemporaryPlacement — краткосрочное размещение возврата FBS
    39,   # PackingFee — упаковка товара партнёрами
    38,   # PackageCost — обеспечение материалами для упаковки товара
}
```

В `PER_ORDER_LOGISTICS_TYPE_IDS` остаются 11 POSTING-типов (32, 29, 98, 45, 59, 16, 17, 30, 9, 40, 6); комментарий набора обновить: «строго перевозка/обработка отправлений и возвратов; сервисы и незнакомые позаказные типы — PER_ORDER_SERVICE_TYPE_IDS/services». `classify_row` (докстроку bucket-списка дополнить `services`):

```python
    if type_id in PER_ORDER_SERVICE_TYPE_IDS:
        return "services", True
    if type_id in PER_ORDER_LOGISTICS_TYPE_IDS:
        return "logistics", True
    # Незнакомый позаказный тип: копилка «прочие сборы» (до волны services —
    # logistics). Незнакомое по-прежнему не теряется, но логистика больше
    # не пухнет от чужих операций.
    return "services", False
```

(Заменяет прежнюю последнюю строку `return "logistics", type_id in PER_ORDER_LOGISTICS_TYPE_IDS`.)

- [ ] **Step 3: ozon_order_costs.py** — симметрично существующим бакетам, по месту:
  - рядом с `logistics_raw = 0.0` → `services_raw = 0.0`; в цикле classify_row ветка `elif bucket == "services": services_raw += _num(r.get("accrued"))` ПЕРЕД else-веткой logistics (комментарий else-ветки обновить — незнакомые теперь не сюда);
  - рядом с `logistics_sum = round(-logistics_raw, 2)` → `services_sum = round(-services_raw, 2)`;
  - comps: `cost_value_retail - commission_sum - services_sum - logistics_sum - acquiring_sum - loyalty_sum`;
  - в возвращаемый dict: `"services": round(services_sum, 2),` рядом с logistics;
  - ВОЗВРАТНАЯ ветка (build возвратной строки — найти по записи dict с is_return=1): тот же services-аккумулятор симметрично (возвратные типы 45/59/9/40/6 — в logistics, как были; сервисные в возвратных корзинах редки, но обрабатываются одинаково);
  - INSERT/UPDATE SQL сборщика: колонка services (найти все места записи строк);
  - докстроки модуля, упоминающие состав logistics/«прочее» (:389-392, шапка :51-77) — актуализировать.
- [ ] **Step 4:** `python3 -m py_compile worker/collectors/ozon_profit_map.py worker/collectors/ozon_order_costs.py`; юнит-прогон классификатора: `python3 -c` на 5 типов (116→services/True, 32→logistics/True, 999→services/False, 1→acquiring, NON_ITEM 10→cabinet) — вывод в отчёт.
- [ ] **Step 5: Commit**: `feat(ozon): бакет services в сборщике + миграция 045 — сборы отдельно от логистики`

---

### Task 2: ГЕЙТ миграции + бэкфилл + сверка

**Files:**
- Create: scratchpad pre/post-скрипты сверки (НЕ коммитить)
- Create: `/opt/agents/saas/.superpowers/sdd/2026-08-25-ozon-services-line/backfill-report.md` (отчёт-сверка)

- [ ] **Step 1: ГЕЙТ (контролёр, не субагент):** применить миграцию 045 к боевой БД (владелец руками `! psql ...` или контролёр через PGPASSFILE=/root/.pgpass-admin с явного согласия владельца в чате). До применения задача стоит.
- [ ] **Step 2: Pre-снимок** (saas_ro, оба кабинета): `SELECT cabinet_id, substr(COALESCE(sale_dt, return_dt),1,7) AS m, COUNT(*), SUM(logistics), SUM(profit) FROM tenant.ozon_order_costs GROUP BY 1,2 ORDER BY 1,2` — в отчёт.
- [ ] **Step 3: Бэкфилл** — широкий прогон сборщика ozon_order_costs по ВСЕЙ истории обеих кабин тем же механизмом, что бэкфилл 2026-08-21 (посмотреть в docs/ozon-data-repair-delta.md / шапке сборщика, как задаётся широкое окно — env/аргументы run_saas_collect.sh или прямой вызов модуля); лог прогона (счётчики строк, unknown_types) — в отчёт.
- [ ] **Step 4: Post-сверка** — тот же SELECT + `SUM(services)`; критерий по КАЖДОЙ строке (кабинет × месяц): `SUM(logistics_new) + SUM(services_new) = SUM(logistics_old)` (допуск 0,01 ₽ на месяц), `SUM(profit_new) = SUM(profit_old)` бит-в-бит, `COUNT(*)` равен. Плюс топ-5 отправлений по services с расшифровкой типов (глазами: 50588097-1427-1 → services ≈ 1812,92, logistics ≈ 130,42). Любое расхождение = СТОП, BLOCKED (не подгонять).
- [ ] **Step 5:** `profit-snapshot.mjs --verify`: зафиксировать дословно — profit-строки PASS, раскладочные Ozon-поля FAIL (ожидаемо, эталон старый; список упавших полей в отчёт).
- [ ] **Step 6:** Отчёт-сверка в backfill-report.md (по-русски, таблица месяцев — владельцу). Коммитов нет (код не менялся).

---

### Task 3: Канон (lib) + сторожа

**Files:**
- Modify: `lib/ozonMetrics.js` (`ozRawProfitAggregate`, `ozRawProfitAggregateBatch`, `ozRawProfitByDay`, `ozProfitProduct`, `ozProfitProductBatch`, `ozDayProfit`)
- Modify: `lib/profitForms.js` (обе формы), `lib/wbMetrics.js` НЕ трогать
- Modify: `scripts/check-profit-canon.mjs` (Ozon-секция: независимые SQL состава, BATCH_SCALAR_FIELDS)

**Interfaces:**
- Produces: agg-формы Ozon с полем `services`; `expenses = cogs + commission + services + logistics + acquiring + loyalty + ads`; `profitGross = revenue − cogs − commission − services − logistics − acquiring − loyalty`; `ZERO_PROFIT`/`ZERO_RAW_AGG` + `services: 0` (задача 4 опирается).

- [ ] **Step 1:** Три агрегата: `COALESCE(SUM(services), 0) AS services` в SELECT (в batch и by-day — те же места, где остальные слагаемые), `services: round2(r.services || 0)` в маппинг. Скаляр `ozProfitProduct`: services в agg-чтение, в expenses и в profitGross (формулы выше — БУКВАЛЬНО). Batch: то же построчно (инвариант №6!). `ozDayProfit`: `agg.services` в expenses дня. rawProfit из БД уже учитывает services — строку profit не менять.
- [ ] **Step 2:** `lib/profitForms.js`: `services: 0` в обе формы; комментарий: поле Ozon-специфично, у WB всегда 0 — безвредно. Попутное закрытие долга волны 3: два инлайн-фолбэка в `ozProfitProductBatch`/`wbProfitProductBatch` перевести на `ZERO_RAW_AGG` (импорт уже есть или добавить) — контракт-пометку «НЕ ЗАКРЫТО» снять в задаче 5.
- [ ] **Step 3:** `check-profit-canon.mjs` Ozon-секция: в независимых SQL проверок состава расходов (№1-5 — найти места, где перечислены commission/logistics/acquiring/loyalty) добавить services тем же образом; `BATCH_SCALAR_FIELDS` + `'services'`. WB-секцию не трогать.
- [ ] **Step 4:** `node --check` трёх файлов; check-profit-canon оба кабинета — ALL PASS; snapshot verify — profit PASS / раскладка FAIL (дословно в отчёт).
- [ ] **Step 5: Commit**: `feat(canon): services в Ozon-каноне — агрегаты, expenses, profitGross, №6`

---

### Task 4: Роуты + UI + деплой

**Files:**
- Modify: `app/api/cabinets/[id]/pnl/route.js` (Ozon mpBlock-раскладка), `app/api/cabinets/[id]/products-summary/route.js` (Ozon-ветка ответа), `app/api/cabinets/[id]/detail/route.js` (Ozon totals + дневная строка), `app/api/cabinets/[id]/rnp-summary/route.js` (Ozon-ветка)
- Modify: UI-рендеры этих экранов (найти по строке «Логистика» в Ozon-контексте: PnlPage, products-summary страница, DetailPage matrix rows, rnp)

- [ ] **Step 1:** Каждый роут: поле `services` наружу рядом с logistics (читается из канон-форм задачи 3; existing поля не переименовывать). В detail — и в периодные totals, и в дневной ряд (строка-таблица), источником `f.services` / `raw.services`.
- [ ] **Step 2:** UI: строка «Сборы Ozon» под «Логистикой» в Ozon-разрезах (тот же компонент-паттерн строки, токены; тултип/подпись: «отзывы, рассрочка, упаковка, размещение, утилизация и прочие позаказные сборы Ozon»). WB-разрезы без изменений.
- [ ] **Step 3:** Сторожа (canon оба кабинета ALL PASS; snapshot profit PASS/раскладка FAIL — дословно). `npm run build && systemctl restart saas-web` (блокировка прав → контролёр). После рестарта — повторно сторожа + глазами приёмка спеки: detail 50588097-1427-1 «Логистика ≈ 130 ₽, Сборы ≈ 1 813 ₽» (скрин/JSON в отчёт).
- [ ] **Step 4: Commit**: `feat(panel): статья «Сборы Ozon» во всех разрезах — сборы больше не маскируются под логистику`

---

### Task 5: Эталон + контракт

**Files:**
- Modify: снапшот-эталон (файл, который читает profit-snapshot.mjs --verify — найти путь в шапке скрипта), `docs/metrics-contract.md`

- [ ] **Step 1:** Доказательство перед перегенерацией: текущий `profit-snapshot.mjs --verify` — ВСЕ profit-строки PASS (дословный вывод в отчёт; если хоть одна FAIL — СТОП, BLOCKED).
- [ ] **Step 2:** Перегенерация эталона штатным механизмом скрипта (прогон записи); сразу `--verify` — ALL PASS полностью. Дельта-справка в отчёт: какие поля эталона изменились (только раскладочные Ozon), profit-поля — без изменений.
- [ ] **Step 3:** Контракт: статья services (состав 9 типов + копилка неизвестных, инвариант строки, «прибыль не менялась»), снять пометку «НЕ ЗАКРЫТО» про инлайн-фолбэки, упомянуть services в §11.5-формах.
- [ ] **Step 4:** Финальные сторожа (canon оба + verify) — ALL PASS. Commit: `feat(canon): эталон и контракт со статьёй services — раскладка честная, прибыль неизменна`

---

### Task 6: Финализация

- [ ] Финальное ревью ветки (whole-branch, fable) — по процессу SDD, с триажем deferred-миноров леджера.

---

## Self-review (выполнено при написании)

- Покрытие спеки: §1→T1, §2→T1, §5→T2, §3→T3, §4→T4, §6→T3/T5, §7→порядок T1-T5. Гейт миграции — T2 Step 1 (контролёр).
- Инварианты согласованы: comps в сборщике, инвариант строки, expenses/profitGross канона — одна и та же вставка services; profit нигде не пересчитывается.
- Плейсхолдеров нет; точные типы/наборы даны; места «найти по форме» снабжены признаками поиска.
- Snapshot: ожидаемый FAIL раскладки между T2 и T5 закреплён в Global Constraints (не даст ревьюерам счесть багом).
