# Расшифровка «Сборов Ozon» в карточке товара — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В карточке товара (дет-сводке) тултипы отвечают «за что сборы»: раскладка по типам на периодном итоге строки «Сборы Ozon» и на каждой дневной ячейке. Числа не меняются — только объяснение.

**Architecture:** Роут detail (Ozon-ветка) отдаёт `servicesBreakdown` (период + по дням) одним SQL по accruals×order_costs с датировкой ДНЁМ ОТПРАВЛЕНИЯ; классификация services-строк — JS-зеркало наборов ozon_profit_map.py в новом lib-модуле; инвариант «Σ раскладки = oc.services» держит приёмочный скрипт.

**Tech Stack:** Node/ESM (lib, роут), React (тултипы DetailPage).

**Спека:** `docs/superpowers/specs/2026-08-25-services-breakdown-design.md` (973619c).

## Global Constraints

- Числа сумм НЕ меняются — только новые аддитивные поля ответа и тултипы. Инвариант: Σ period-раскладки = периодный итог `services`; Σ раскладки дня = дневная ячейка `services` (допуск 0,01 ₽) — доказывается приёмочным скриптом на ≥3 товарах со сборами, FAIL = СТОП.
- ⚠️ Датировка раскладки — `substr(COALESCE(oc.sale_dt, oc.return_dt),1,10)` (день отправления), НЕ `a.date` (день операции) — иначе тултип дня не сойдётся с ячейкой (ячейка из order_costs by-day).
- JS-наборы типов зеркалят worker/collectors/ozon_profit_map.py с коммент-ссылкой в обе стороны (в py-файл — встречный коммент «зеркало в lib/ozonServiceTypes.js»); дрейф ловится инвариантом приёмки.
- Только Ozon-ветка detail; WB и агрегатные экраны (Сводка/P&L) не трогаются.
- Сторожа после каждой задачи: `node scripts/check-profit-canon.mjs --cabinet 1`, `--cabinet 1008`, `node scripts/profit-snapshot.mjs --verify` — ALL PASS; дословный вывод в отчётах.
- Деплой только в задаче 2. Тексты по-русски.

---

### Task 1: lib-словарь + servicesBreakdown в роуте

**Files:**
- Create: `lib/ozonServiceTypes.js`
- Modify: `app/api/cabinets/[id]/detail/route.js` (Ozon-ветка, рядом с загрузкой дневного ряда)

**Interfaces:**
- Produces: `SERVICE_TYPE_LABELS: {116:'Сбор первых отзывов', 74:'Звёздные товары', 22:'Рассрочка', 71:'Вывоз со склада', 15:'Утилизация', 78:'Временное размещение возврата', 79:'Временное размещение партнёрами', 39:'Упаковка партнёрами', 38:'Упаковочные материалы'}`; `serviceLabel(typeId) -> string` (неизвестный → `Прочие сборы (тип N)`); `NON_SERVICE_PER_ORDER_SETS` — зеркала LOGISTICS/ACQUIRING/LOYALTY-наборов из ozon_profit_map.py; ответ detail: `servicesBreakdown: {period: [{typeId, label, ops, sum}], byDay: {'YYYY-MM-DD': [{typeId, label, sum}]}}` (сортировка period по sum desc). Задача 2 использует.

- [ ] **Step 1: lib/ozonServiceTypes.js** — подписи из комментариев ozon_profit_map.py (сверить ПО МЕСТУ, включая точные наборы ACQUIRING_TYPE_IDS/LOYALTY_TYPE_IDS/PER_ORDER_LOGISTICS_TYPE_IDS — их значения переносятся, не выдумываются); функция-классификатор:

```js
// Позаказная accrual-строка относится к «Сборам Ozon», если это не
// commission-блок (POSTING, type_id IS NULL), не эквайринг, не лояльность
// и не перевозка — та же логика, что classify_row в ozon_profit_map.py
// (двустороннее зеркало, см. встречный коммент там). Дрейф наборов ловит
// приёмочный инвариант Σ(раскладки) = oc.services.
export function isServiceRow(category, typeId) { ... по наборам выше ... }
```

- [ ] **Step 2: SQL в detail** (один запрос на период, рядом с дневным рядом):

```sql
SELECT a.type_id, substr(COALESCE(oc.sale_dt, oc.return_dt),1,10) AS d,
       a.accrued_category, COUNT(*) AS ops, COALESCE(SUM(-a.accrued),0) AS sum
FROM order_costs oc
JOIN ozon_accruals a ON a.unit_number = oc.src_unit_number
WHERE oc.product_id = ?
  AND substr(COALESCE(oc.sale_dt, oc.return_dt),1,10) >= ? AND <= ?
GROUP BY a.type_id, d, a.accrued_category
```

(точные имена таблиц — как их видит db-шим этого роута; фильтрация `isServiceRow` — в JS по строкам результата). Сборка `period`/`byDay`, округление round2, нулевые типы не включать.

- [ ] **Step 3: приёмочный скрипт** в scratchpad (НЕ коммитить): для 3 товаров кабинета 1 со сборами (найти SQL-ом) сравнить Σ period-раскладки с канон-`services` за период и Σ byDay[d] с `ozRawProfitByDay(...).get(d).services` подённо — |Δ| ≤ 0,01 везде; вывод в отчёт. Плюс встречный коммент-зеркало в ozon_profit_map.py (одна строка, py-файл).
- [ ] **Step 4:** `node --check`; сторожа (3 команды) ALL PASS.
- [ ] **Step 5: Commit**: `feat(detail): servicesBreakdown — раскладка сборов по типам, период и по дням`

---

### Task 2: Тултипы UI + деплой + приёмка

**Files:**
- Modify: `app/cabinets/[id]/detail/DetailPage.jsx` (строка «Сборы Ozon» в matrix: итоговая ячейка + дневные ячейки)

- [ ] **Step 1:** Тултип итога: многострочный title по `servicesBreakdown.period` — «Сбор первых отзывов — 4 993,46 ₽ (3)\n…»; тултип дневной ячейки: по `byDay[date]`; ячейки/итог без сборов — без тултипа. Существующий hint/title-паттерн строк DetailPage, никаких новых компонентов/цветов.
- [ ] **Step 2:** Сторожа ALL PASS → `npm run build && systemctl restart saas-web` → сторожа повторно.
- [ ] **Step 3: Приёмка:** артикул 4191173246 — тултип итога = «Сбор первых отзывов 4 993,46 ₽ (3)» + «Временное размещение партнёрами 21,00 ₽ (1)» (данные могли дособраться — если суммы сдвинулись, сверить с живым SQL и зафиксировать); инвариант скрипта задачи 1 повторить на пост-деплойном коде. JSON/числа в отчёт.
- [ ] **Step 4: Commit**: `feat(detail): тултипы расшифровки сборов — итог и дневные ячейки`

---

### Task 3: Контракт + финализация

- [ ] Контракт: `docs/metrics-contract.md` — абзац в разделе services: раскладка в detail (источник accruals, датировка днём отправления, JS-зеркало наборов, инвариант Σ=services, «Прочие сборы (тип N)» для незнакомых). Commit: `docs(contract): расшифровка сборов в detail — источник, датировка, инвариант`
- [ ] Финальное ревью ветки (whole-branch, fable) — по процессу SDD; в диспатч включить: проверку зеркала наборов против ozon_profit_map.py и датировочного инварианта.

---

## Self-review (выполнено при написании)

- Покрытие спеки: данные §→T1; UI §→T2; приёмка §→T1 Step 3 + T2 Step 3; не-в-скоупе соблюдено.
- Датировочный нюанс (день отправления, не операции) — в GC и в SQL Step 2.
- Дубль классификации (py↔js) — осознан, замечен в обоих файлах комментами, застрахован инвариантом приёмки.
- Плейсхолдер в isServiceRow — намеренная инструкция «перенести наборы по месту» (значения ACQUIRING/LOYALTY-наборов в плане не даны, чтобы не зафиксировать устаревшие: источник — py-файл на момент реализации).
