# Выручка WB по цене со скидкой продавца — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выручка WB во всём каноне = сумма продаж по цене со скидкой продавца, маржа = прибыль ÷ эта выручка на всех страницах; «Заказано» в сводке без подтяжки; штуки и рубли сводки из одного источника.

**Architecture:** Новая колонка `wb_order_costs.cost_value_withdisc` (сборщик + бэкфилл кабинета 1) → канон `lib/wbMetrics.js` отдаёт `revenue/realized/payout/spp/commission(нетто)` при неизменном `rawProfit` → семь потребителей переключаются на новые поля, `wbRevenueGross` уходит → сторожа и контракт переписаны. Прибыль в рублях меняется только на разницу налога (база `realized`).

**Tech Stack:** Python (psycopg3) в `/opt/agents/data-presenter-agent/.venv/bin/python`; PostgreSQL 16; Next.js 14; node:test; `scripts/check-profit-canon.mjs` (читает через `saas_ro`, `PGPASSFILE`-не нужен).

**Spec:** `docs/superpowers/specs/2026-09-06-wb-revenue-by-price-design.md`

## Global Constraints

- Живые прогоны сборщиков и проверки БД — только кабинет #1. Чтение под `saas_ro` с `WHERE cabinet_id = 1`; миграции применяет контроллер (`PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`).
- Формы ответа канона общие для WB и Ozon (`lib/profitForms.js`): новое поле добавляется в обе площадки и в `ZERO_PROFIT`/`ZERO_RAW_AGG`.
- `rawProfit`, `cogs`, `logistics` не меняются ни в одной функции — сторож сравнивает с базовым снимком `scratchpad/wb-canon-baseline-2026-09-06.txt` бит-в-бит.
- Маржа везде = `profit / revenue × 100`. Никаких локальных формул выручки в роутах.
- Тесты: `node --test lib/__tests__/*.test.mjs`; `node scripts/check-profit-canon.mjs` (все проверки зелёные); `npm run build` только в задаче 4 и при деплое; `next dev` запрещён.
- `git add` только явным списком.

Команда одиночного прогона сборщика (`ORCH`):

```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && \
SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas \
/opt/agents/data-presenter-agent/.venv/bin/python -m worker.orchestrator \
  --cabinet 1 --collectors wb_order_costs --date-from 2026-05-01 --date-to 2026-09-06 --run-kind manual
```

## File Structure

| Файл | Ответственность |
|---|---|
| `db/migrations/053_wb_order_costs_withdisc.sql` | колонка `cost_value_withdisc` |
| `worker/collectors/wb_order_costs.py`, `worker/db_pg.py` | сбор колонки |
| `lib/wbMetrics.js`, `lib/profitForms.js`, `lib/ozonMetrics.js` | канон: новые поля, налоговая база, удаление `wbRevenueGross` |
| `lib/__tests__/wbDayProfit.test.mjs` | чистый тест композиции дня и налоговой базы |
| `app/api/cabinets/[id]/{pnl,overview,products-summary,rnp-summary,detail,plan/fact}/route.js`, `app/cabinets/[id]/{pnl/PnlPage.jsx,OverviewClient.jsx,summary/SummaryPage.jsx,detail/DetailPage.jsx}` | потребители |
| `scripts/check-profit-canon.mjs`, `scripts/check-profit-canon-cross.mjs`, `scripts/check-wb-revenue-switch.sql` | сторожа |
| `docs/metrics-contract.md`, `AGENTS.md`, `docs/superpowers/plans/2026-09-06-warehouses-stage2-ledger.md` | контракт; перенумерация миграции этапа 2 на 054 |

---

### Task 1: Колонка `cost_value_withdisc` — миграция, сборщик, бэкфилл кабинета 1

**Files:**
- Create: `db/migrations/053_wb_order_costs_withdisc.sql`
- Modify: `worker/collectors/wb_order_costs.py` (CTE `ops` и внешний SELECT), `worker/db_pg.py` (карта колонок `wb_order_costs`)

**Interfaces:**
- Produces: `tenant.wb_order_costs.cost_value_withdisc DOUBLE PRECISION` = Σ `retail_price_withdisc_rub` строк `supplier_oper_name IN ('Продажа','Возврат')` по srid, `0` при `is_return=1`.

- [ ] **Step 1: Миграция**

```sql
-- 053_wb_order_costs_withdisc.sql — выручка WB по цене со скидкой продавца
-- (спека docs/superpowers/specs/2026-09-06-wb-revenue-by-price-design.md).
-- Σ retail_price_withdisc_rub строк «Продажа» по srid; 0 на возвратах (как
-- cost_value_retail/cost_value_pay). Заполняет сборщик wb_order_costs; бэкфилл
-- кабинета 1 — прогон за всю историю (2026-05-01..). Идемпотентно.
BEGIN;
ALTER TABLE tenant.wb_order_costs ADD COLUMN IF NOT EXISTS cost_value_withdisc DOUBLE PRECISION;
COMMIT;
```

- [ ] **Step 2 (контроллер): применить**

`PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -q -f db/migrations/053_wb_order_costs_withdisc.sql` дважды без ошибок.

- [ ] **Step 3: Сборщик**

В CTE `ops` (`worker/collectors/wb_order_costs.py`, рядом с `cost_value_retail`) добавить:
```sql
        SUM(CASE WHEN f.supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(f.retail_price_withdisc_rub,0) ELSE 0 END) AS cost_value_withdisc,
```
Во внешнем SELECT рядом с `cost_value_retail`:
```sql
           CASE WHEN o.is_return = 1 THEN 0 ELSE o.cost_value_withdisc END AS cost_value_withdisc,
```
В `worker/db_pg.py` найти список колонок/карту, которой пишется `wb_order_costs` (`upsert_order_costs_many` → `_batch_upsert`/`_upsert_raw`; grep `cost_value_pay`), и добавить `cost_value_withdisc` рядом с `cost_value_pay`. Проверить, что python-часть сборщика, формирующая строки (`rows` → upsert), не отбрасывает неизвестные ключи.

- [ ] **Step 4: Бэкфилл кабинета 1 и сверка**

Run: `ORCH` (см. Global Constraints; окно 2026-05-01..2026-09-06). Затем:
```bash
psql -h localhost -U saas_ro -d saas -Atc "SELECT COUNT(*), COUNT(cost_value_withdisc), COUNT(*) FILTER (WHERE cost_value_withdisc IS NULL) FROM tenant.wb_order_costs WHERE cabinet_id=1;
SELECT COUNT(*) AS bad FROM tenant.wb_order_costs oc JOIN (SELECT srid, SUM(retail_price_withdisc_rub) s FROM tenant.wb_finance_report WHERE cabinet_id=1 AND supplier_oper_name='Продажа' GROUP BY 1) f ON f.srid=oc.srid WHERE oc.cabinet_id=1 AND oc.is_return=0 AND ABS(COALESCE(oc.cost_value_withdisc,0)-f.s) > 0.01;
SELECT ROUND(SUM(cost_value_withdisc)::numeric) FROM tenant.wb_order_costs WHERE cabinet_id=1 AND nm_id=1383643331 AND sale_dt>='2026-09-01' AND sale_dt<='2026-09-05T23:59:59'"
```
Expected: NULL = 0; `bad = 0`; последняя цифра = 25 515 (9 продаж: 2835×5 + 2693×4 по ленте продаж — если отчёт даёт другие копейки, записать фактическое число в отчёт задачи, оно пойдёт в приёмку).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/053_wb_order_costs_withdisc.sql worker/collectors/wb_order_costs.py worker/db_pg.py
git commit -m "feat(wb): cost_value_withdisc — выручка по цене со скидкой продавца в order_costs"
```

---

### Task 2: Канон `lib/wbMetrics.js` — новые поля, нетто-вознаграждение, налоговая база

**Files:**
- Modify: `lib/wbMetrics.js` (`wbRawProfitAggregate`, `wbRawProfitAggregateBatch`, `wbRawProfitByDay`, `wbRawProfitCabinetByDay`, `wbDayProfit`, `wbProfitProduct`, `wbProfitProductBatch`, `wbProfitCabinet`, удалить `wbRevenueGross`; шапка-докстрока), `lib/profitForms.js` (`ZERO_PROFIT`, `ZERO_RAW_AGG`), `lib/ozonMetrics.js` (поля симметрии)
- Create: `lib/__tests__/wbDayProfit.test.mjs`

**Interfaces:**
- Produces: во всех WB-агрегатах поля `revenue, realized, payout, spp, commission, commissionReport, acquiringReport, loyaltyReport, acquiring(=0), loyalty(=0), cogs, logistics, rawProfit, returnLogistics`; `export const WB_TAX_BASE = "realized"`; `wbProfitProduct/Batch/Cabinet` → `{ ...agg, ads, tax, profit, profitGross }` где `profitGross = revenue − spp − commission − cogs − logistics`; Ozon-агрегаты получают `spp: 0`, `realized: revenue`, `payout: revenue − commission − services − acquiring − loyalty`.

- [ ] **Step 1: Тест композиции дня**

```js
// lib/__tests__/wbDayProfit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { wbDayProfit, WB_TAX_BASE } from "../wbMetrics.js";

const agg = { revenue: 2835, realized: 1990, payout: 1437.12, spp: 845, commission: 552.88,
  cogs: 600, logistics: 80, rawProfit: 757.12, acquiring: 0, loyalty: 0 };

test("налоговая база — реализовано, УСН 6%", () => {
  assert.equal(WB_TAX_BASE, "realized");
  const p = wbDayProfit(agg, 50, { type: "usn_income", rate: 6, vat: 0 });
  // profit = rawProfit − ads − 6% × realized
  assert.equal(p, Math.round((757.12 - 50 - 1990 * 0.06) * 100) / 100);
});

test("УСН Д−Р: расходы включают нетто-вознаграждение WB", () => {
  const p = wbDayProfit(agg, 50, { type: "usn_income_expenses", rate: 15, vat: 0 });
  const base = 1990 - (600 + 80 + 50 + 552.88);
  assert.equal(p, Math.round((757.12 - 50 - base * 0.15) * 100) / 100);
});
```
(Если `calcTotalTax` ожидает нормализованный режим с другими именами полей — посмотреть `lib/tax.js` `normalizeTaxMode` и передавать `normalizeTaxMode({...})`; минимальную ставку/пол УСН Д−Р учесть, если он есть в `calcUsnTax`, подставив ожидаемое через ту же функцию.)

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test lib/__tests__/wbDayProfit.test.mjs` → падает (нет `WB_TAX_BASE`, база налога — `revenue`).

- [ ] **Step 3: Канон**

Единый SELECT-фрагмент для четырёх агрегатов (заменить в каждом список полей):
```sql
         COALESCE(SUM(cost_value_withdisc), 0) AS revenue,
         COALESCE(SUM(cost_value_retail), 0)   AS realized,
         COALESCE(SUM(cost_value_pay), 0)      AS payout,
         COALESCE(SUM(cost), 0) AS cogs,
         COALESCE(SUM(commission), 0) AS "commissionReport",
         COALESCE(SUM(acquiring), 0) AS "acquiringReport",
         COALESCE(SUM(logistics), 0) AS logistics,
         COALESCE(SUM(loyalty), 0) AS "loyaltyReport",
         COALESCE(SUM(profit), 0) AS "rawProfit",
         COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0) AS "retLogistics"
```
и общий маппер строки (одна функция `wbAggRow(r)`, используемая всеми четырьмя):
```js
function wbAggRow(r) {
  const revenue = round2(r?.revenue || 0), realized = round2(r?.realized || 0), payout = round2(r?.payout || 0);
  return {
    revenue, realized, payout,
    spp: round2(revenue - realized),
    commission: round2(realized - payout),           // нетто-вознаграждение WB — ВЫЧЕТ
    acquiring: 0, loyalty: 0,                        // у WB внутри commission (форма общая с Ozon)
    commissionReport: round2(r?.commissionReport || 0),
    acquiringReport: round2(r?.acquiringReport || 0),
    loyaltyReport: round2(r?.loyaltyReport || 0),
    cogs: round2(r?.cogs || 0), logistics: round2(r?.logistics || 0),
    rawProfit: round2(r?.rawProfit || 0), returnLogistics: round2(r?.retLogistics || 0),
  };
}
```
Налог: `export const WB_TAX_BASE = "realized";` и хелпер
```js
function wbTax(agg, ads, taxMode) {
  const base = WB_TAX_BASE === "revenue" ? agg.revenue : WB_TAX_BASE === "payout" ? agg.payout : agg.realized;
  const expenses = agg.cogs + agg.logistics + ads + (WB_TAX_BASE === "payout" ? 0 : agg.commission);
  return calcTotalTax(taxMode, base, expenses);
}
```
`wbDayProfit(agg, adDay, taxMode)` → `round2(agg.rawProfit - adDay - wbTax(agg, adDay, taxMode).total)`; `wbProfitProduct/Batch/Cabinet` — тот же `wbTax`, `profitGross = round2(agg.revenue - agg.spp - agg.commission - agg.cogs - agg.logistics)` (должно равняться `rawProfit`). Удалить `wbRevenueGross` целиком. Переписать докстроку шапки канона: revenue = цена со скидкой продавца, commission = нетто-вознаграждение (разложение отчёта не сходится — проба 06.09, 478 строк июля), налоговая база `WB_TAX_BASE`.

`lib/profitForms.js`: добавить `realized: 0, payout: 0, spp: 0` в оба нуля (порядок полей рядом с `revenue`).
`lib/ozonMetrics.js`: в мапперах агрегатов добавить `spp: 0, realized: revenue, payout: round2(revenue - commission - services - acquiring - loyalty)` (там, где эти поля уже посчитаны; `services` есть только у Ozon).

- [ ] **Step 4: Тест и импорт-проверка**

Run: `node --test lib/__tests__/wbDayProfit.test.mjs` → pass 2. `grep -rn "wbRevenueGross" lib app scripts` → упоминания только в роутах/скриптах, которые правятся в задачах 3–4 (список в отчёт).

- [ ] **Step 5: Commit**

```bash
git add lib/wbMetrics.js lib/profitForms.js lib/ozonMetrics.js lib/__tests__/wbDayProfit.test.mjs
git commit -m "feat(canon): выручка WB по цене со скидкой продавца, нетто-вознаграждение WB, налоговая база realized"
```

---

### Task 3: Потребители канона (API)

**Files:**
- Modify: `app/api/cabinets/[id]/pnl/route.js`, `app/api/cabinets/[id]/overview/route.js`, `app/api/cabinets/[id]/products-summary/route.js`, `app/api/cabinets/[id]/rnp-summary/route.js`, `app/api/cabinets/[id]/detail/route.js`, `app/api/cabinets/[id]/plan/fact/route.js`

**Interfaces:**
- Consumes: поля задачи 2.
- Produces: `/pnl` блоки и `total` получают `spp`, `realized`, `payout`; `forPay = c.payout`; `revenueGross` удалён из `mpBlock`, списка суммируемых полей и `total`; `/overview` — `k.netPay = c.payout` (для WB; у Ozon `payout` канона), `k.revenueGross` удалён; `/products-summary` WB: `sold = r.sold` (из `order_costs`, блок `fresh` из `sales` удалить вместе с `addStub` по `fresh`), `ordered = o.ordered || 0` (подтяжка удалена), `commission: f.commission` (нетто), добавить `spp: f.spp`, `payout: f.payout`; `/rnp-summary`, `/detail`, `/plan/fact` — используют `revenue` канона как сейчас; в `detail` `totals` добавить `spp/payout`.

- [ ] **Step 1: pnl**

`mpBlock(c, isWb, platform)` (параметр `revenueGross` убрать): `revenue: c.revenue, realized: c.realized, payout: c.payout, spp: c.spp, …, forPay: c.payout`. Из массива суммируемых полей удалить `"revenueGross"`, добавить `"realized", "payout", "spp"`. Удалить вызов `wbRevenueGross` и импорт. `total.margin` — как есть (`profit / revenue`).

- [ ] **Step 2: overview**

Удалить `k.revenueGross`/`wbRevenueGross`; `k.netPay = c.payout` (WB) — проверить, что сейчас `netPay` считается из `forPaySales − |forPayReturns|` (строка 64) по `wb_finance_report`; заменить на канон и удалить ставший ненужным SQL, если он больше нигде не используется. Для Ozon-ветки `netPay` = `c.payout`. Маржа — строка 155 без изменений.

- [ ] **Step 3: products-summary (WB-ветка)**

- Удалить блок «3а) СВЕЖИЕ продажи из sales» (`fresh`) и `addStub` по `fresh`; `sold = r.sold || 0`.
- `const ordered = o.ordered || 0;` — удалить `minOrdered`/`Math.max`; комментарий: «инвариант ordered ≥ sold верен за всё время, не внутри окна (продажи периода по заказам прошлого периода) — фикс 06.09».
- В `out.push` добавить `spp: f.spp, payout: f.payout, realized: f.realized`.
- Ozon-ветка: добавить те же поля из `f` (там `spp: 0`).
- Итоги (`t.*` около строки 230–262): просуммировать `spp`, `payout`, `realized`.

- [ ] **Step 4: rnp-summary, detail, plan/fact**

Grep `revenue`/`forPay`/`revenueGross` в каждом; убедиться, что выручка берётся из канона (`f.revenue`/`c.revenue`), локальных формул нет; в `detail` добавить в `totals` `spp`, `payout`, `realized` и в дневные строки — ничего (дневной `salesRub` уже по цене со скидкой из `wbFinanceByDay`). В `plan/fact` `revenue_fact` — канон.

- [ ] **Step 5: Проверка сборкой**

Run: `cd /opt/agents/saas && npm run build 2>&1 | tail -3` (JSX ещё не тронут, но роуты компилируются) — без ошибок. `grep -rn "revenueGross\|wbRevenueGross" app lib` → только в JSX (задача 4).

- [ ] **Step 6: Commit**

```bash
git add "app/api/cabinets/[id]/pnl/route.js" "app/api/cabinets/[id]/overview/route.js" "app/api/cabinets/[id]/products-summary/route.js" "app/api/cabinets/[id]/rnp-summary/route.js" "app/api/cabinets/[id]/detail/route.js" "app/api/cabinets/[id]/plan/fact/route.js"
git commit -m "feat(canon): потребители — выручка по цене, к перечислению из канона, сводка без подтяжки «Заказано»"
```

---

### Task 4: Потребители канона (UI)

**Files:**
- Modify: `app/cabinets/[id]/pnl/PnlPage.jsx`, `app/cabinets/[id]/OverviewClient.jsx`, `app/cabinets/[id]/summary/SummaryPage.jsx`, `app/cabinets/[id]/detail/DetailPage.jsx`

- [ ] **Step 1: PnlPage**

`buildRows(taxLabel, hasWb, hasServices)`: строки — «Выручка (продажи)» `revenue`; если `hasWb` — «Скидка WB (СПП)» `spp` (negate, sub, hint «разница между ценой со скидкой продавца и тем, что заплатил покупатель; WB компенсирует часть внутри вознаграждения»); «Себестоимость»; «Вознаграждение МП» `commission` (hint для WB: «нетто: комиссия + эквайринг − компенсации СПП; разложение по отчёту WB не сходится с выплатой»); далее как есть. Удалить строку «Выручка (валовая, WB)», `hasRevenueGross` и пояснение про неё (строка ~231). Карточка «К перечислению» = `total.forPay` (уже). В таблице по площадкам (строки ~280) добавить «Скидка WB (СПП)» и «К перечислению».

- [ ] **Step 2: OverviewClient**

KPI «К перечислению» = `kpi.netPay` (уже); убрать любые ссылки на `revenueGross`; подпись «Выручка (продажи)» оставить; в графике серия `netPay` без изменений.

- [ ] **Step 3: SummaryPage**

Колонки: «Продажи, ₽» → оставить подпись, добавить hint «по цене со скидкой продавца; штуки и рубли из финансовых строк WB (отстают на сутки)»; «Комиссия, ₽» → «Вознаграждение МП, ₽»; добавить колонку «СПП, ₽» (`spp`, только при наличии WB) после «Продажи, ₽» и «К перечислению, ₽» (`payout`) — обе скрыты по умолчанию, если в таблице есть механизм скрытия колонок, иначе добавить в конец денежного блока. Убедиться, что KPI «Выручка» сверху берёт `totals.salesRub`.

- [ ] **Step 4: DetailPage**

Колонки/KPI: «Выручка, ₽» без изменений; в блок итогов добавить «К перечислению ₽» (`t.payout`) и «СПП ₽» (`t.spp`) для WB.

- [ ] **Step 5: Сборка**

Run: `npm run build 2>&1 | tail -3` — без ошибок; `grep -rn "revenueGross" app` → пусто.

- [ ] **Step 6: Commit**

```bash
git add "app/cabinets/[id]/pnl/PnlPage.jsx" "app/cabinets/[id]/OverviewClient.jsx" "app/cabinets/[id]/summary/SummaryPage.jsx" "app/cabinets/[id]/detail/DetailPage.jsx"
git commit -m "feat(ui): СПП и «к перечислению» отдельными строками; вознаграждение МП; подсказки по источникам"
```

---

### Task 5: Сторожа

**Files:**
- Modify: `scripts/check-profit-canon.mjs`, `scripts/check-profit-canon-cross.mjs` (если ссылается на `revenueGross`/`cost_value_pay` как выручку)
- Create: `scripts/check-wb-revenue-switch.sql`

- [ ] **Step 1: `check-profit-canon.mjs` (WB-секция)**

Независимый SQL выручки → `SUM(cost_value_withdisc)`; добавить проверки: (а) `revenue − spp − commission = payout` (|Δ| ≤ 0.02) на кабинетном и товарном уровне за июль; (б) `profitGross = rawProfit` (|Δ| ≤ 0.02); (в) налог = `calcTotalTax(taxMode, realized, cogs+logistics+ads+commission).total`. Проверка 5 (Σ ads) и прочие — без изменений. Удалить использование `wbRevenueGross`, если есть.

- [ ] **Step 2: SQL-сторож переезда (сверка с базовым снимком)**

```sql
-- scripts/check-wb-revenue-switch.sql — после переезда выручки WB (06.09.2026):
-- rawProfit/cogs/logistics помесячно бит-в-бит с scratchpad-снимком «до»
-- (wb-canon-baseline-2026-09-06.txt), withdisc заполнен, тождества сходятся.
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-wb-revenue-switch.sql
SELECT substr(COALESCE(sale_dt,return_dt),1,7) AS m, COUNT(*) n,
       ROUND(SUM(cost_value_withdisc)::numeric,2) AS revenue,
       ROUND(SUM(cost_value_retail)::numeric,2) AS realized,
       ROUND(SUM(cost_value_pay)::numeric,2) AS payout,
       ROUND(SUM(cost)::numeric,2) AS cogs, ROUND(SUM(logistics)::numeric,2) AS logistics,
       ROUND(SUM(profit)::numeric,2) AS raw_profit,
       COUNT(*) FILTER (WHERE cost_value_withdisc IS NULL) AS null_withdisc,
       COUNT(*) FILTER (WHERE is_return=0 AND cost_value_withdisc < cost_value_retail - 0.01) AS withdisc_lt_realized
FROM tenant.wb_order_costs WHERE cabinet_id=1 GROUP BY 1 ORDER BY 1;
-- ok: null_withdisc=0 везде; withdisc_lt_realized=0 (цена со скидкой продавца ≥ реализовано);
-- payout/realized/cogs/logistics/raw_profit = снимок «до» (2026-05: 1412170.27/1524641.21/727842.00/111298.63/573029.64;
-- 2026-06: 894789.86/878716.46/483215.00/57679.05/353895.81; 2026-07: 796215.76/818305.82/387800.00/57208.38/351207.38;
-- 2026-08: 504154.17/597758.83/243450.00/28232.28/232471.89 — сентябрь растёт, не сравнивается).
```

- [ ] **Step 3: Прогнать**

Run: `node scripts/check-profit-canon.mjs` (все зелёные), `node scripts/check-profit-canon-cross.mjs`, `psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-wb-revenue-switch.sql` — сверить с числами в комментарии.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-profit-canon.mjs scripts/check-profit-canon-cross.mjs scripts/check-wb-revenue-switch.sql
git commit -m "test(canon): сторожа под выручку WB по цене — тождества, налоговая база, сверка со снимком"
```

---

### Task 6: Контракт метрик и документация

**Files:**
- Modify: `docs/metrics-contract.md` (§1.1, §1.2, §1.3, §2 WB, §9, §11 WB, §12, §13, §14), `AGENTS.md` (раздел «Где что считается» — короткая запись), `docs/superpowers/plans/2026-09-06-warehouses-stage2-ledger.md` (миграция `053_stock_ledger.sql` → `054_stock_ledger.sql` во всех упоминаниях)

- [ ] **Step 1: Контракт**

§1.1 → «Выручка канона (WB) = Σ `cost_value_withdisc` — цена со скидкой продавца (`retail_price_withdisc_rub`), решение владельца 06.09.2026»; новые поля `realized/payout/spp/commission(нетто)` с формулами и тождествами; «Проверено на данных» — числа за июль из сторожа задачи 5. §1.2 — дневные ряды теперь согласованы с каноном (та же цена). §1.3 — пометить закрытым. §2 (WB) — «Вознаграждение WB нетто = realized − payout; отчётные commission/acquiring/loyalty справочные; разложение не сходится (478/478 строк июля)». §9 — база WB `WB_TAX_BASE = realized`, расходы Д−Р включают нетто-вознаграждение; переключение константой. §11 WB — profit не изменился структурно, изменился на разницу налога. §12 — маржа от валовой выручки на обеих площадках. §13 — «Заказано» без подтяжки (фикс 06.09, причина). §14 — «Продано» в сводке из `wb_order_costs` (единый источник с деньгами, лаг ≤ 1 сутки), лента `sales` больше не используется.

- [ ] **Step 2: AGENTS.md** — в «Где что считается» добавить 3 строки: выручка WB по цене со скидкой продавца (06.09), нетто-вознаграждение, `WB_TAX_BASE`.

- [ ] **Step 3: Перенумерация** миграции этапа 2 в плане `2026-09-06-warehouses-stage2-ledger.md`: `053_stock_ledger.sql` → `054_stock_ledger.sql` (заголовок задачи 1, шаги 1–3, таблица File Structure, AGENTS-фрагмент задачи 9).

- [ ] **Step 4: Commit**

```bash
git add docs/metrics-contract.md AGENTS.md docs/superpowers/plans/2026-09-06-warehouses-stage2-ledger.md
git commit -m "docs(contract): выручка WB по цене со скидкой продавца, нетто-вознаграждение, налоговая база; «Заказано» без подтяжки"
```

---

### Task 7 (контроллер): деплой и приёмка

- [ ] `npm run build && systemctl restart saas-web`, `systemctl is-active saas-web`.
- [ ] Владелец на кабинете 1, период 01–05.09, фильтр WB: «Баклажан-цвет» продано 9 / продажи = число из задачи 1 шаг 4 (≈ 25 515 ₽); «Видеорегистратор дешёвый ребристый» заказано 1 / 3 445 ₽, продано 5; `/pnl` за июль: Выручка 1 359 744 ₽ (порядок), СПП, К перечислению 796 215,76 ₽ (как в снимке), прибыль = прежняя − разница налога.

## Self-review

**Покрытие спеки:** модель (колонка, поля, тождества, налоговая база) → задачи 1–2; потребители → 3–4; сторожа → 5; контракт → 6; приёмка → 7. Ozon-симметрия формы → задача 2. Удаление `wbRevenueGross` → задачи 2–4. Штуки из одного источника и «Заказано» без подтяжки → задача 3.

**Плейсхолдеры:** нет; числа приёмки берутся из задачи 1 шаг 4.

**Согласованность имён:** `revenue/realized/payout/spp/commission/commissionReport/acquiringReport/loyaltyReport/WB_TAX_BASE/wbTax/wbAggRow` (2) ← 3, 4, 5; `forPay = c.payout` (3) ← PnlPage (4); `sold`/`ordered` (3) ← контракт §13/14 (6).
