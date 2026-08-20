# Унификация формул прибыли (WB + Ozon) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Одна каноническая формула прибыли на площадку в `lib/*Metrics.js`; все страницы читают её; кабинетные расходы с русскими именами входят в P&L/Обзор; один период = одна цифра везде.

**Architecture:** Сначала канонический слой (две функции на площадку) с TDD-проверками против БД; затем снапшоты «было» через живые HTTP-вызовы роутов и документ шлюза; после «да» владельца — переключение роутов двумя волнами (кабинетные, товарные) с автопроверкой «агрегаты = канон»; финал — сторожевая перекрёстная проверка и приёмка против внешних документов.

**Tech Stack:** Node (lib/роуты Next.js), `readonlyPgConfig`/`DatabaseSync`, smoke-паттерн авторизованных HTTP-вызовов, systemd-сторож.

**Spec:** `docs/superpowers/specs/2026-08-20-profit-unification-design.md` — нормативна (решения владельца: кабинетные расходы только на P&L/Обзоре; юнит-эк. не трогать; шлюз обязателен).

## Global Constraints

- Сборщики и таблицы НЕ меняются — канон только читает существующее.
- Задачи 4-5 (переключение роутов) НЕ начинаются до «да» владельца по документу шлюза (задача 3). Нарушение шлюза = провал плана.
- Деплой панели только `npm run build && systemctl restart saas-web` (НИКОГДА `next dev` в прод-каталоге); после — `systemctl is-active` + чистый `journalctl`.
- БД читать `saas_ro` (BYPASSRLS → всегда явный `cabinet_id`); guard-предикаты только на nullable-полях (урок: INDF на NOT NULL ломает hash join, 200×).
- Методика налога — существующая (`calcTotalTax`-механизм), не менять.
- Сторож `check-ozon-profit-invariant.mjs` ALL PASS после каждой задачи (перезапуск в отчёт).
- Тексты по-русски. Расхождение цифр = наш баг, пока не доказано обратное.
- Технический ключ `accrual_<N>` не должен показываться сырым нигде после задачи 4.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `lib/ozonMetrics.js` (правка) | `ozProfitProduct`, `ozProfitCabinet`, `ozCabinetCostLabel` |
| `lib/wbMetrics.js` (правка) | `wbProfitProduct`, `wbProfitCabinet`, `wbCabinetCostLabel` |
| `scripts/check-profit-canon.mjs` (создать) | TDD-проверки канона против прямых SQL (обе площадки) |
| `scripts/profit-snapshot.mjs` (создать) | Снапшоты «было» (HTTP-роуты) и «станет» (канон), сравнение |
| `docs/profit-unification-delta.md` (создать) | Документ шлюза «страница × месяц: было/станет» |
| Роуты: `pnl`, `overview`, `detail`, `products-summary`, `rnp-summary`, `plan/fact`, `orders` (правка); `unit` (удалить) | Переход на канон |
| `scripts/check-profit-canon-cross.mjs` (создать) + `deploy/systemd/saas-ozon-recon.service` (правка) | Еженедельная перекрёстная проверка канона |
| `docs/data-trust-map.md`, `docs/ozon-accrual-reconciliation.md` (правка) | Статусы после унификации |

## Канонические сигнатуры (фиксированы для всех задач)

Зафиксировано по факту реализации задачи 1 (ревью 2026-08-20 — Important #2:
исходная запись ниже была написана ДО реализации и не учитывала, что `db`
(подключение) и `taxMode` — обязательные явные входы; правка плана
санкционирована контролёром как фиксация решения, не самоволие).

```js
// Обе функции каждой площадки. db — DatabaseSync (штатное подключение
// панели, ozonMetrics.js уже открыт внутри withTenant/withCabinet — все
// остальные функции файла тоже берут db первым параметром, канон не
// исключение). taxMode — нормализованный режим (normalizeTaxMode из
// lib/tax.js) — существующий вход calcTotalTax, не выводится из tenant-БД,
// поэтому явный параметр, а не поиск внутри функции. period = {cabinetId,
// from, to} (даты YYYY-MM-DD, включительно; cabinetId в SQL не участвует —
// RLS уже скопировала подключение на нужный кабинет, поле в контракте для
// внешних потребителей вроде check-скриптов).
ozProfitProduct(db, taxMode, period, productId = null) → {
  revenue, cogs, commission, logistics, acquiring, loyalty,
  returnLogistics,          // справочно: уже внутри logistics/commission выше
  ads,                       // при productId — 0 (Ozon не даёт пер-SKU расход рекламы, честно, не размазано)
  tax,                       // при productId — считается на выручке/расходах ЭТОГО товара (аддитивно под usn_income)
  profit,                   // товарная прибыль: SUM(order_costs.profit, БЕЗ фильтра is_return!) − ads − tax
}
ozProfitCabinet(db, taxMode, period) → { ...то же по кабинету,
  cabinetCosts: [{ costType, label, amount }],  // label — по-русски; amount — ЗНАКОВЫЙ, как в БД (< 0 = расход, > 0 = доход/возмещение)
  unknownCostTypes,          // счётчик статей, чей cost_type не резолвился в справочник (не молча)
  profit,                   // полная: profitProduct.profit + Σ cabinetCosts[].amount (ЗНАКОВАЯ сумма — см. ниже)
}
ozCabinetCostLabel(db, costType) → string  // accrual_<id> → имя из shared.ozon_accrual_types (рус., кэш словаря на процесс); незнакомый формат/id → «Прочее (<ключ>)», не сырым
// WB: wbProfitProduct / wbProfitCabinet / wbCabinetCostLabel — та же форма
// (задача 2 решает сама, нужен ли WB-аналогу db в wbCabinetCostLabel — если
// словарь статичный, без БД, сигнатура вправе быть короче).
```

**Правило знаковой суммы (ИСПРАВЛЕНО ревью задачи 1, fix-раунд, Important #1
— формулировка ниже была ошибкой контролёра в первой версии плана, не
implementer'а):** `ozProfitCabinet.profit = ozProfitProduct.profit +
Σ cabinetCosts[].amount` — сумма БЕРЁТСЯ СО ЗНАКОМ, как `amount` хранится в
`tenant.ozon_cabinet_costs`/`tenant.wb_cabinet_costs` (отрицательный =
расход, уменьшает прибыль; положительный = доход/возмещение, УВЕЛИЧИВАЕТ
прибыль). ~~Первая версия («− Σ|cabinetCosts|», модуль каждой статьи)~~ —
неверна: живая статья `accrual_62` (RfbsClientDeliveryCharge, «Перечисление
за доставку от покупателя», транзитный доход RFBS, кабинет 1 июль-2026:
+8 955 ₽) по модульной формуле ТОЖЕ вычиталась бы, занижая
`ozProfitCabinet.profit` на 2×её величину. Проверено на живых данных: у
кабинета 1008 та же ошибка дала бы занижение на 34 917,96 ₽ (две
положительные статьи, accrual_57 + accrual_62). `cabinetCosts[].amount` в
ответе остаётся ЗНАКОВЫМ (как в БД) — для отображения; знак используется И
для суммы, И для показа.

---

### Task 1: Канонический слой Ozon

**Files:**
- Modify: `lib/ozonMetrics.js`
- Create: `scripts/check-profit-canon.mjs` (Ozon-секция)

**Interfaces:**
- Consumes: `tenant.ozon_order_costs` (profit/компоненты), `ozon_daily_efficiency.ad_spend` (как `ozAdSpend` сейчас), `tenant.ozon_cabinet_costs`, `shared.ozon_accrual_types`, налог — существующим механизмом (найти `calcTotalTax`/аналог, использовать как есть).
- Produces: сигнатуры выше. На них опираются задачи 3-6.

- [ ] **Шаг 1: Прочитать текущие агрегаты** `lib/ozonMetrics.js` (`ozOrderCostsAggregate`, `ozOrderCostsByProduct`, `ozAdSpend`) и налоговый механизм — канон строится НА них, не дублируя SQL, где возможно.
- [ ] **Шаг 2: Падающие проверки** (`check-profit-canon.mjs`, `readonlyPgConfig`, явный cabinet_id): для июля-2026 каб.1 — `profitProduct.profit` = прямому SQL `SUM(profit) − ad_spend − налог` (посчитанному скриптом независимо); слагаемые аддитивны (revenue−cogs−commission−... сходится с profit до налога по знаковой формуле сборщика); `profitCabinet.profit` = product − Σ статей; `cabinetCosts` labels: ни один не содержит `accrual_` сырым; productId-фильтр работает (сумма по всем товарам = без фильтра, допуск 0,01). Run → FAIL.
- [ ] **Шаг 3: Реализация** (+ `ozCabinetCostLabel` со словарём из справочника; кэш словаря на процесс). Незнакомый cost_type — «Прочее (<ключ>)», счётчик в ответе (`unknownCostTypes`), не молча.
- [ ] **Шаг 4: Проверки зелёные** + сторож ALL PASS (гигиена).
- [ ] **Шаг 5: Коммит.** `git commit -m "feat(panel): канонические функции прибыли Ozon"`

---

### Task 2: Канонический слой WB

**Files:**
- Modify: `lib/wbMetrics.js`
- Modify: `scripts/check-profit-canon.mjs` (WB-секция)

**Interfaces:**
- Consumes: `tenant.wb_order_costs` (ppvz-модель profit), WB-рекламный источник (как читает панель сейчас — `wbAdTotal`/аналог, найти), `tenant.wb_cabinet_costs`, налог существующий.
- Produces: `wbProfitProduct`/`wbProfitCabinet`/`wbCabinetCostLabel` той же формы.

- [ ] **Шаг 1: Прочитать WB-агрегаты** (`wbFinancePeriod` и рекламу) — семантика profit у WB другая (комиссия внутри выручки), канон это НЕ меняет: слой «− ads − tax − cabinetCosts» одинаков.
- [ ] **Шаг 2: Падающие проверки** (симметрично задаче 1, июль-2026 каб.1 WB).
- [ ] **Шаг 3: Реализация. Шаг 4: зелёные + сторож. Шаг 5: Коммит** `"feat(panel): канонические функции прибыли WB"`.

---

### Task 3: Снапшоты «было/станет» и документ шлюза

**Files:**
- Create: `scripts/profit-snapshot.mjs`
- Create: `docs/profit-unification-delta.md`

**Interfaces:**
- Consumes: живые роуты (авторизованный HTTP на 127.0.0.1:3200 — паттерн логина взять из smoke-скриптов `scripts/smoke-auth-*.mjs`; читающие вызовы, тестовых записей не создавать), канон задач 1-2.
- Produces: документ шлюза. **Задачи 4-5 заблокированы до «да» владельца.**

- [ ] **Шаг 1: Снапшот «было».** Для каждого роута (pnl, overview, detail по 2-3 топ-товарам, products-summary, rnp-summary, plan/fact) × 4 полных месяца (апр–июл 2026) × кабинеты 1, 1008 × площадки — вызвать живой роут, извлечь итоговую прибыль и ключевые слагаемые, сохранить JSON в `.superpowers/`-workspace (не в репо).
- [ ] **Шаг 2: «Станет»** — те же разрезы каноном (profitCabinet для pnl/overview, profitProduct для товарных).
- [ ] **Шаг 3: Документ**: таблицы «страница × месяц: было / станет / Δ» по площадкам и кабинетам; каждый значимый сдвиг объяснён строкой (P&L: −реклама −лояльность −кабинетные; план/факт: факт-COGS; …). Несводимое расхождение (не объяснимое известными причинами) = находка, копать до объяснения — правило проекта.
- [ ] **Шаг 4: Коммит документа. СТОП** — контролёр несёт владельцу. Дальше только после «да».

---

### Task 4: Кабинетные страницы (P&L, Обзор) — после «да»

**Files:**
- Modify: `app/api/cabinets/[id]/pnl/route.js`, `app/api/cabinets/[id]/overview/route.js`

- [ ] **Шаг 1: pnl → profitCabinet** обеих площадок: свои SQL-агрегации прибыли заменяются вызовом канона; кабинетные статьи — строками с label (в т.ч. WB-аналог, где светились ключи); реклама и лояльность появляются в отчёте.
- [ ] **Шаг 2: overview → profitCabinet** (вместо компонентного пересчёта).
- [ ] **Шаг 3: Автопроверка**: HTTP-вызов обоих роутов за июль = канону до копейки (расширить profit-snapshot.mjs режимом `--verify`); grep ответов на `accrual_` — пусто.
- [ ] **Шаг 4: Деплой по протоколу; сторож ALL PASS. Шаг 5: Коммит** `"feat(panel): P&L и Обзор на каноне прибыли"`.

---

### Task 5: Товарные страницы и чистка — после «да»

**Files:**
- Modify: `detail`, `products-summary`, `rnp-summary`, `plan/fact`, `orders` роуты
- Delete: `app/api/cabinets/[id]/unit/route.js` (мёртвый; перепроверить отсутствие потребителей grep-ом по `app/**` прежде чем удалять)

- [ ] **Шаг 1: detail / products-summary / rnp-summary → profitProduct** (по товарам; returnLogistics остаётся справочной строкой из слагаемых канона).
- [ ] **Шаг 2: plan/fact**: факт-колонки → profitProduct (факт-COGS); плановые колонки не трогать.
- [ ] **Шаг 3: orders**: выравнивание подстановки cost с каноном (та же логика cost_overrides-на-дату); бонус (из хвоста витрины, тот же файл): честный NULL-guard — второй posting-level NOT EXISTS для oc-строк с NULL product_id (только на nullable-полях!).
- [ ] **Шаг 4: Удалить `/unit`** (после grep-подтверждения). 
- [ ] **Шаг 5: Автопроверка `--verify` всех пяти роутов** = канон до копейки; кросс-страничная сверка: pnl.profit (товарная часть) = products-summary.Σprofit = rnp.Σprofit за один период (допуск 0,01 — это и есть цель плана). Деплой; сторож ALL PASS.
- [ ] **Шаг 6: Коммит** `"feat(panel): товарные страницы на каноне прибыли; удалён мёртвый /unit"`.

---

### Task 6: Сторожевая перекрёстная проверка и приёмка

**Files:**
- Create: `scripts/check-profit-canon-cross.mjs`
- Modify: `deploy/systemd/saas-ozon-recon.service` (добавить вызов; копия в /etc идентична — diff)
- Modify: `docs/data-trust-map.md`, `docs/ozon-accrual-reconciliation.md`

- [ ] **Шаг 1: Скрипт**: за прошлую ISO-неделю profitCabinet обеих площадок = независимой SQL-сумме слагаемых (допуск 1 ₽); вывод все строки; ненулевой exit при расхождении.
- [ ] **Шаг 2: В service** (после существующих сверок); установка копированием, `systemctl daemon-reload`, разовый start — журнал зелёный целиком.
- [ ] **Шаг 3: Приёмка против документов**: прибыль июля-2026 Ozon каб.1 из канона раскладывается в слагаемые, согласованные со сверенными эталонами (`docs/ozon-external-reconciliation-*`: revenue/commission до копейки, услуги до 1 ₽); зафиксировать в отчёте.
- [ ] **Шаг 4: Документация**: data-trust-map — «прибыль: единая формула, N мест → 2 функции»; reconciliation §14 — итог унификации; поправить упоминания 8-формульной болезни.
- [ ] **Шаг 5: Коммит** `"feat(panel): перекрёстный сторож канона прибыли + документация"`.

---

## Что в этот план НЕ входит

Юнит-экономика; сборщики/таблицы; методика налога; курсор; наблюдаемость воркера; last_change_dt; ротация ключа; Sendsay.

## Проверка плана по спеке

| Требование спеки | Задача |
|---|---|
| Две канонические функции на площадку, слагаемые в ответе | 1, 2 |
| Русские имена статей, accrual_N нигде не сырой | 1, 4 (grep-проверка) |
| Кабинетные расходы только P&L/Обзор | 4 (товарные — 5, без cabinetCosts) |
| Шлюз «было/станет» до подмены | 3 (блокирует 4-5) |
| Один период = одна цифра (кросс-страничная сверка) | 5 шаг 5 |
| Приёмка против внешних документов | 6 |
| Сторож: перекрёстная проверка канона | 6 |
| Юнит-эк. и сборщики не тронуты | Global Constraints |
