# Юнит-экономика Ozon: модель уровня WB — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переписать Ozon-модель юнит-экономики под структуру WB: цена продавца из каталога, выкуп и возвраты в логистике, факт комиссии/эквайринга из начислений, соинвест из кабинета продавца, маржа от цены продавца.

**Architecture:** Чистая модель `calcOzon` в `lib/unit.js` (синхронная, без БД) + факты за 30 дней по вчера одним batch-SQL в `computeOzon` роута `unit/all` + новый кабинетный сборщик `ozon_cabinet_prices` (Playwright-клиент, только чтение) в существующую таблицу `tenant.ozon_prices`. UI и whitelist прикидок дополняются полем `buyout`. Контракт метрик обновляется.

**Tech Stack:** Next.js (app router, `runtime=nodejs`), PostgreSQL (RLS, `tenant.*`), `node:test` для lib, Python 3 worker (`worker/collectors/*.py`, `db_pg.py`, `cabinet_client.py` на Playwright), systemd-таймер `saas-cabinet`.

**Spec:** `docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md`

## Global Constraints

- Язык кода-комментариев, коммитов, доков — русский (как в репо).
- `calcOzon` остаётся **синхронной** функцией (урок 26.08: `ProductRow.useMemo` зовёт её без await).
- Окно фактов — `defaultPeriod(30)` из `lib/period.js` (30 дней по вчера).
- WB-ветка (`calcWB`, `computeWB`, `COLUMNS_WB`, `COMPACT.wb`) **не трогается**.
- Кабинетный клиент ходит только по `ALLOWED_PATHS`; новые пути — только чтение (`cabinet_client_selftest.py` проверяет отсутствие слов `set/update/delete/enable/add/remove` в пути).
- Регистрация сборщика = **и** `worker/orchestrator.py`, **и** `worker/run_saas_collect.sh` (урок 15.08).
- Запись в боевую БД (миграция) — только `PGPASSFILE=/root/.pgpass-admin psql -U postgres -d saas`. Чтение — под `saas_ro` (`psql -h localhost -U saas_ro -d saas`).
- `git add` — только явный список файлов (урок 26.08). Коммиты заканчиваются:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3
  ```
- Не гонять `next dev` в `/opt/agents/saas`. Деплой панели: `npm run build && systemctl restart saas-web`.
- Python сборщиков: `/opt/agents/data-presenter-agent/.venv/bin/python` (селф-тесты без сети), кабинетный режим — `/opt/agents/saas/worker/.venv-cabinet/bin/python` с `DISPLAY=:99`.

---

## Карта файлов

| Файл | Роль | Задача |
|---|---|---|
| `lib/unit.js` | `calcOzon` (новая модель), `COLUMNS_OZON` | 1 |
| `lib/__tests__/unitOzon.test.mjs` (новый) | тесты модели, тождество логистики | 1 |
| `app/api/cabinets/[id]/unit/whatif/route.js` | `ALLOWED_KEYS.ozon += buyout` | 2 |
| `app/cabinets/[id]/unit/UnitPage.jsx` | `WHATIF_INPUTS.ozon`, `COMPACT.ozon`, `HIDDEN_WHEN_BUYOUT_OFF`, подсказка «оценка» | 2 |
| `app/api/cabinets/[id]/unit/all/route.js` | `computeOzon`: факты 30 дн, соинвест из `ozon_prices` | 3 |
| `scripts/check-unit-ozon.mjs` (новый) | сторож: факты роута против SQL, тождество логистики | 3 |
| `db/migrations/059_ozon_prices_cabinet.sql` (новый) | `marketing_oa_price`, `source` | 4 |
| `worker/db_pg.py` | `upsert_ozon_cabinet_prices_many` | 4 |
| `worker/cabinet_client.py` | `ALLOWED_PATHS += get-common-prices` | 5 |
| `worker/collectors/ozon_cabinet_prices.py` (новый) | сборщик трёх цен из кабинета | 6 |
| `worker/collectors/ozon_cabinet_selftest.py` | селф-тест парсера цен | 6 |
| `worker/orchestrator.py`, `worker/run_saas_collect.sh` | регистрация сборщика | 6 |
| `docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md` §8 | результаты пробы | 7 |
| `docs/metrics-contract.md` §11.4, §11.6, новый §11.7 | контракт | 8 |

Задачи 1→2→3 последовательны (модель → UI → факты). Задачи 4→5→6→7 (сборщик) независимы от 1–3 и могут идти параллельно. Задача 8 после 3 и 6. Задача 9 — финал.

---

### Task 1: Модель `calcOzon` и колонки

**Files:**
- Modify: `lib/unit.js` (блок `COLUMNS_OZON` ~:72-95 и функция `calcOzon` ~:250-330)
- Create: `lib/__tests__/unitOzon.test.mjs`

**Interfaces:**
- Produces: `calcOzon(input) → object` с ключами входов + `priceSell, priceBuyer, priceFact, vat, revNet, commission, acquiring, logistics, logisticsFbo, returnLogistics, ads, usn, profit, margin, renta, profitWithDefect, marginWithDefect, adsRate, boost`. Новые входы: `acquiringRate` (доля), `buyout` (доля), `returnLogistics` (₽ на возврат), `priceFact` (₽, справочно, сквозной), `boost` может быть `null`.
- `COLUMNS_OZON` — массив `{key,label,kind,unit,fmt,tip}`; порядок ключей: `name, priceOzon, priceFact, discount, priceSell, boost, priceBuyer, vat, revNet, commissionRate, commission, acquiringRate, acquiring, buyout, logisticsFbo, returnLogistics, logistics, adsRate, ads, usn, cost, profit, margin, renta, defectRate, profitWithDefect, marginWithDefect`.

- [ ] **Step 1: Написать падающие тесты**

Создать `lib/__tests__/unitOzon.test.mjs`:

```js
// lib/__tests__/unitOzon.test.mjs — Ozon-модель юнит-экономики уровня WB
// (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §2).
import test from "node:test";
import assert from "node:assert/strict";
import { calcOzon, COLUMNS_OZON } from "../unit.js";

const base = {
  priceOzon: 1800, discount: 0, boost: 0.3,
  commissionRate: 0.47, acquiringRate: 0.008,
  buyout: 10 / 12, logisticsFbo: 100, returnLogistics: 150,
  adsRate: 0.1, cost: 500, defectRate: 0,
  usnRate: 0.06, vatRate: 5 / 105,
};

test("тождество логистики: при фактических F, R, b логистика = Σлогистики окна / продано", () => {
  // окно: продано 10, невыкупов 2; Σлог(продано) = 1000 → F = 100; Σлог(невыкупы) = 300 → R = 150; b = 10/12
  const r = calcOzon(base);
  assert.equal(r.logistics, 130); // (1000 + 300) / 10
});

test("галочка «с % выкупа» OFF (b = 1) → логистика = F", () => {
  const r = calcOzon({ ...base, buyout: 1 });
  assert.equal(r.logistics, 100);
});

test("buyout не задан → как b = 1 (без деления на ноль)", () => {
  const r = calcOzon({ ...base, buyout: undefined });
  assert.equal(r.logistics, 100);
});

test("комиссия, эквайринг, реклама — от цены продавца с НДС; УСН — от выручки без НДС", () => {
  const r = calcOzon({ ...base, discount: 0.1 }); // priceSell = 1620
  assert.equal(r.priceSell, 1620);
  assert.equal(r.commission, 761.4);          // 1620 × 0.47
  assert.equal(r.acquiring, 12.96);           // 1620 × 0.008
  assert.equal(r.ads, 162);                   // 1620 × 0.10
  assert.equal(r.vat, Math.round(1620 * 5 / 105 * 100) / 100);
  assert.equal(r.usn, Math.round((1620 - 1620 * 5 / 105) * 0.06 * 100) / 100);
});

test("прибыль и маржа: маржа от priceSell, как у WB", () => {
  const r = calcOzon(base);
  const vat = 1800 * 5 / 105;
  const usn = (1800 - vat) * 0.06;
  const expected = 1800 - vat - usn - 1800 * 0.47 - 1800 * 0.008 - 130 - 180 - 500;
  assert.equal(r.profit, Math.round(expected * 100) / 100);
  assert.equal(r.margin, Math.round((expected / 1800) * 10000) / 10000);
});

test("соинвест: priceBuyer = priceSell × (1 − boost); boost = null → priceBuyer = null, расчёт не ломается", () => {
  assert.equal(calcOzon(base).priceBuyer, 1260);
  const r = calcOzon({ ...base, boost: null });
  assert.equal(r.boost, null);
  assert.equal(r.priceBuyer, null);
  assert.ok(Number.isFinite(r.profit));
});

test("брак — зеркало WB, маржа с браком от priceSell", () => {
  const r = calcOzon({ ...base, defectRate: 0.1 });
  assert.equal(r.profitWithDefect, Math.round((r.profit - 50) * 100) / 100);
  assert.equal(r.marginWithDefect, Math.round((r.profitWithDefect / 1800) * 10000) / 10000);
});

test("идемпотентность: повторный прогон на округлённых выходах не меняет прибыль", () => {
  const r1 = calcOzon(base);
  const r2 = calcOzon(r1);
  assert.equal(r2.profit, r1.profit);
});

test("COLUMNS_OZON содержит новые колонки в нужном порядке", () => {
  const keys = COLUMNS_OZON.map((c) => c.key);
  const want = ["priceOzon", "priceFact", "boost", "priceBuyer", "acquiringRate", "acquiring", "buyout", "logisticsFbo", "returnLogistics", "logistics", "margin"];
  for (const k of want) assert.ok(keys.includes(k), `нет колонки ${k}`);
  assert.ok(keys.indexOf("buyout") < keys.indexOf("logisticsFbo"));
  assert.ok(keys.indexOf("returnLogistics") < keys.indexOf("logistics"));
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /opt/agents/saas && node --test lib/__tests__/unitOzon.test.mjs`
Expected: FAIL (в текущей модели `logistics` нет в выходе, `acquiring` нет, `priceBuyer` при null-boost = 0 и т.д.).

- [ ] **Step 3: Переписать `COLUMNS_OZON`**

Заменить весь массив `COLUMNS_OZON` в `lib/unit.js` на:

```js
export const COLUMNS_OZON = [
  { key: "name", label: "Товар", kind: "input", align: "left" },
  { key: "priceOzon", label: "Цена продавца", kind: "input", unit: "₽", tip: "Цена продавца со скидкой (products.price = marketing_seller_price, каталог Ozon, обновляется ежедневно). Аналог «цены со скидкой» WB — база всего расчёта" },
  { key: "priceFact", label: "Факт 30 дн", kind: "calc", unit: "₽", tip: "Справочно: средняя цена проданной штуки по начислениям за 30 дней по вчера (cost_value_retail / qty)" },
  { key: "discount", label: "Скидка", kind: "input", unit: "%", fmt: "pct", tip: "скидка прикидки поверх цены продавца; по умолчанию 0" },
  { key: "priceSell", label: "Цена со скидкой", kind: "calc", unit: "₽", tip: "цена продавца × (1 − скидка) — база НДС, УСН, комиссии, эквайринга, рекламы и маржи" },
  { key: "boost", label: "Соинвест", kind: "calc", unit: "%", fmt: "pct", tip: "Скидка за счёт Ozon для всех покупателей (без Ozon Карты) = 1 − цена для всех / цена продавца. Источник: снимок кабинета продавца (tenant.ozon_prices, source=cabinet), последний день. Из прибыли НЕ вычитается. Нет снимка — «—»" },
  { key: "priceBuyer", label: "Цена покупателя", kind: "calc", unit: "₽", tip: "цена со скидкой × (1 − соинвест) — что видит покупатель без Ozon Карты; продавец получает цену со скидкой" },
  { key: "vat", label: "НДС 5%", kind: "tax", unit: "₽", tip: "цена со скидкой × 5/105" },
  { key: "revNet", label: "Выручка без НДС", kind: "calc", unit: "₽", tip: "цена со скидкой − НДС (база УСН)" },
  { key: "commissionRate", label: "Комиссия", kind: "input", unit: "%", fmt: "pct", tip: "Факт: Σкомиссии / Σцены проданного за 30 дней по начислениям; нет продаж — каталожная ставка категории (⚙ оценка)" },
  { key: "commission", label: "Комиссия ₽", kind: "calc", unit: "₽", tip: "цена со скидкой × комиссия (база с НДС — так считает Ozon)" },
  { key: "acquiringRate", label: "Эквайринг", kind: "input", unit: "%", fmt: "pct", tip: "Факт: Σэквайринга / Σцены проданного за 30 дней; нет продаж — среднее по кабинету, иначе 1,5 %" },
  { key: "acquiring", label: "Эквайринг ₽", kind: "calc", unit: "₽", tip: "цена со скидкой × эквайринг" },
  { key: "buyout", label: "% выкупа", kind: "input", unit: "%", fmt: "pct", tip: "продано / (продано + невыкупы) за 30 дней по начислениям; отмены до отгрузки ничего не стоят и не входят" },
  { key: "logisticsFbo", label: "Логистика прямая", kind: "input", unit: "₽", tip: "F — прямая логистика на проданную штуку: Σлогистики проданных / продано за 30 дней; нет продаж — каталожный тариф (⚙ оценка)" },
  { key: "returnLogistics", label: "Невыкуп ₽", kind: "calc", unit: "₽", tip: "R — логистика одной невыкупленной штуки (строки возврата в начислениях: цена 0, только логистика): Σ / невыкупы за 30 дней; нет невыкупов у товара — среднее по кабинету" },
  { key: "logistics", label: "Логистика на продажу", kind: "calc", unit: "₽", tip: "F + R × (1 − выкуп) / выкуп — логистика на одну проданную штуку с учётом невыкупов; при фактах равна Σлогистики окна / продано" },
  { key: "adsRate", label: "ДРР", kind: "input", unit: "%", fmt: "pct", tip: "ставка рекламы; дефолт 10% (если не задано), редактируется inline" },
  { key: "ads", label: "Реклама ₽", kind: "calc", unit: "₽", tip: "цена со скидкой × ДРР" },
  { key: "usn", label: "УСН 6%", kind: "tax", unit: "₽", tip: "выручка без НДС × ставка" },
  { key: "cost", label: "Себестоимость", kind: "input", unit: "₽" },
  { key: "profit", label: "ПРИБЫЛЬ", kind: "kpi", unit: "₽", tip: "цена со скидкой − НДС − УСН − комиссия − эквайринг − логистика на продажу − реклама − себест." },
  { key: "margin", label: "Маржа", kind: "kpi", unit: "%", fmt: "pct", tip: "ПРИБЫЛЬ / цена со скидкой (как у WB)" },
  { key: "renta", label: "Рентаб-сть", kind: "kpi", unit: "%", fmt: "pct", tip: "ПРИБЫЛЬ / себестоимость" },
  { key: "defectRate", label: "% брака", kind: "input", unit: "%", fmt: "pct" },
  { key: "profitWithDefect", label: "Прибыль с браком", kind: "calc", unit: "₽", tip: "ПРИБЫЛЬ − закупочная × %брака" },
  { key: "marginWithDefect", label: "Маржа с браком", kind: "calc", unit: "%", fmt: "pct", tip: "Прибыль с браком / цена со скидкой" },
];
```

- [ ] **Step 4: Переписать `calcOzon`**

Заменить функцию `calcOzon` (и её докблок) в `lib/unit.js` на:

```js
// =====================================================================
//  calcOzon — расчёт юнит-экономики Ozon (FBO), модель уровня WB
//  (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §2,
//  решения владельца 17.09.2026).
//
//   • priceOzon — цена продавца со скидкой (products.price = marketing_seller_price),
//     аналог priceCabinet WB. База НДС/УСН/комиссии/эквайринга/рекламы/маржи.
//   • boost — соинвест Ozon (без Ozon Карты) из снимков кабинета; за счёт
//     площадки, из прибыли НЕ вычитается; null = снимка нет → priceBuyer null.
//   • commissionRate/acquiringRate — факт из начислений (роут), база — цена с НДС.
//   • Логистика на проданную штуку: F + R × (1 − b) / b, где F — прямая на
//     проданную штуку, R — логистика одного невыкупа (строка is_return=1:
//     цена 0, только логистика, парной продажи нет), b — % выкупа. F на b НЕ
//     делится (в отличие от WB): логистика неудачных попыток целиком в R.
//     При фактических F/R/b тождественно Σлогистики окна / продано. b = 1 → F.
//   • ДРР = константа 10% (решение #14), adsRate перекрывает.
//   • Синхронная (урок 26.08) — UnitPage зовёт её в useMemo без await.
// =====================================================================
export function calcOzon(input) {
  const i = { ...input };
  const priceOzon = num(i.priceOzon);
  const discount = frac(i.discount);
  const boost = i.boost == null ? null : frac(i.boost);
  const commissionRate = frac(i.commissionRate);
  const acquiringRate = frac(i.acquiringRate);
  const buyout = frac(i.buyout); // b; 0/пусто → как 1 (без деления на ноль)
  const logisticsFbo = num(i.logisticsFbo); // F, ₽ на проданную штуку
  const returnLogistics = num(i.returnLogistics); // R, ₽ на один невыкуп
  const adsRate = i.adsRate != null ? frac(i.adsRate) : 0.1;
  const cost = num(i.cost);
  const purchase = i.purchase != null ? num(i.purchase) : cost;
  const defectRate = frac(i.defectRate);
  const usnRateOz = i.usnRate != null ? frac(i.usnRate) : TAX.USN_RATE;
  const vatRateOz = i.vatRate != null ? frac(i.vatRate) : TAX.VAT_RATE;

  const priceSell = priceOzon * (1 - discount);
  const priceBuyer = boost == null ? null : priceSell * (1 - boost);
  const vat = priceSell * vatRateOz;
  const revNet = priceSell - vat;
  const usn = revNet * usnRateOz;
  const commission = priceSell * commissionRate;
  const acquiring = priceSell * acquiringRate;
  const bSafe = buyout > 0 ? buyout : 1;
  const logistics = logisticsFbo + returnLogistics * (1 - bSafe) / bSafe;
  const ads = priceSell * adsRate;

  const profit = priceSell - vat - usn - commission - acquiring - logistics - ads - cost;
  const margin = priceSell > 0 ? profit / priceSell : 0;
  const renta = cost > 0 ? profit / cost : 0;
  const defectLoss = purchase * defectRate;
  const profitWithDefect = profit - defectLoss;
  const marginWithDefect = priceSell > 0 ? profitWithDefect / priceSell : 0;

  return {
    ...i,
    adsRate: round4(adsRate),
    boost: boost == null ? null : round4(boost),
    buyout: round4(bSafe),
    acquiringRate: round4(acquiringRate),
    priceSell: round2(priceSell),
    priceBuyer: priceBuyer == null ? null : round2(priceBuyer),
    priceFact: i.priceFact == null ? null : round2(num(i.priceFact)),
    vat: round2(vat),
    revNet: round2(revNet),
    commission: round2(commission),
    acquiring: round2(acquiring),
    logisticsFbo: round2(logisticsFbo),
    returnLogistics: round2(returnLogistics),
    logistics: round2(logistics),
    ads: round2(ads),
    usn: round2(usn),
    profit: round2(profit),
    margin: round4(margin),
    renta: round4(renta),
    profitWithDefect: round2(profitWithDefect),
    marginWithDefect: round4(marginWithDefect),
  };
}
```

Внимание: в старом коде `discount` применялся к `priceOzon` так же — семантика `priceSell` не меняется, меняются базы комиссии/рекламы/маржи и появляется логистика с выкупом.

- [ ] **Step 5: Прогнать тесты — зелёные; прогнать остальные lib-тесты**

Run: `cd /opt/agents/saas && node --test lib/__tests__/unitOzon.test.mjs && node --test lib/__tests__/`
Expected: все PASS.

- [ ] **Step 6: Коммит**

```bash
cd /opt/agents/saas
git add lib/unit.js lib/__tests__/unitOzon.test.mjs
git commit -m "feat(unit): Ozon-модель уровня WB — цена продавца, выкуп и невыкупы в логистике, комиссия/эквайринг от цены с НДС, маржа от цены продавца

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3"
```

---

### Task 2: Прикидки и UI — поле `buyout` на Ozon

**Files:**
- Modify: `app/api/cabinets/[id]/unit/whatif/route.js` (`ALLOWED_KEYS.ozon`, ~:40-48)
- Modify: `app/cabinets/[id]/unit/UnitPage.jsx` (`COMPACT.ozon` ~:31; `WHATIF_INPUTS.ozon` ~:47-55; `HIDDEN_WHEN_BUYOUT_OFF` ~:64; подсказка «оценка» ~:531-533)

**Interfaces:**
- Consumes: `COLUMNS_OZON` и `calcOzon` из Task 1 (ключи `buyout`, `returnLogistics`, `logistics`, `acquiringRate`, `priceFact`).
- Produces: сервер принимает `inputs.buyout` (доля, max 1) для `platform: "ozon"`; клиент шлёт `buyout` как долю (asFraction).

- [ ] **Step 1: Сервер — whitelist**

В `ALLOWED_KEYS.ozon` (`whatif/route.js`) добавить строку после `commissionRate`:

```js
    buyout: { max: 1 }, // % выкупа — вход модели с 17.09.2026 (спека 2026-09-17-ozon-unit-model): галочка «с % выкупа» на Ozon больше не no-op
```

- [ ] **Step 2: Клиент — WHATIF_INPUTS, COMPACT, HIDDEN**

В `UnitPage.jsx`:

`WHATIF_INPUTS.ozon` — вставить после `commissionRate`:
```js
    { key: "buyout", label: "% выкупа", unit: "%", max: 100, asFraction: true },
```

`COMPACT.ozon` заменить на:
```js
  ozon: ["name", "priceOzon", "priceFact", "priceSell", "boost", "priceBuyer", "commissionRate", "commission", "acquiring", "buyout", "logisticsFbo", "returnLogistics", "logistics", "ads", "usn", "cost", "profit", "margin", "defectRate", "profitWithDefect", "marginWithDefect"],
```

`HIDDEN_WHEN_BUYOUT_OFF` заменить на:
```js
const HIDDEN_WHEN_BUYOUT_OFF = new Set(["buyout", "returnLogistics"]); // Ozon: при b = 1 невыкуп в модели не участвует
```

Подсказку бейджа «⚙ оценка» для Ozon (строка ~533) заменить на:
```js
                            : "Нет проданных штук за последние 30 дней: комиссия — каталожная ставка, логистика — каталожный тариф, эквайринг и невыкуп — средние по кабинету."}
```

Комментарий над `HIDDEN_WHEN_BUYOUT_OFF`/`COMPACT` при необходимости дополнить одной строкой: «17.09.2026 — buyout стал входом Ozon-модели (спека 2026-09-17-ozon-unit-model)».

- [ ] **Step 3: Проверить, что ничего не сломано в сборке линтом**

Run: `cd /opt/agents/saas && npx next lint --dir app/cabinets/[id]/unit --dir app/api/cabinets/[id]/unit`
Expected: без ошибок (предупреждения, которые были раньше, допустимы).

- [ ] **Step 4: Коммит**

```bash
cd /opt/agents/saas
git add "app/api/cabinets/[id]/unit/whatif/route.js" "app/cabinets/[id]/unit/UnitPage.jsx"
git commit -m "feat(unit): % выкупа в прикидке Ozon, новые колонки в компактном наборе, возврат прячется при выкупе OFF

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3"
```

---

### Task 3: Факты 30 дней в `computeOzon` + соинвест из `ozon_prices` + сторож

**Files:**
- Modify: `app/api/cabinets/[id]/unit/all/route.js` (`autoOzon` ~:110-118; `computeOzon` ~:282-400)
- Create: `scripts/check-unit-ozon.mjs`

**Interfaces:**
- Consumes: `calcOzon` (Task 1), `defaultPeriod(30)` из `lib/period.js`, `tenant.ozon_prices` с колонками `source`, `marketing_seller_price`, `marketing_price` (Task 4; до миграции запрос по `source` упадёт — см. Step 3, обёрнуто в try/catch с `boost = null`).
- Produces: элементы `items[]` платформы `ozon` с полями модели Task 1 плюс `estimated`, `draft`, `status`, `article`, `category`, `im_url`.

- [ ] **Step 1: Переписать `autoOzon`**

Заменить функцию `autoOzon` на:

```js
// Авто-входы Ozon: цена продавца из каталога (products.price = marketing_seller_price,
// решение владельца 17.09.2026), каталожные ставки — только как fallback (факт
// из начислений подмешивается в computeOzon поверх).
function autoOzon(p, cost) {
  const productPrice = p?.price != null && Number.isFinite(p.price) && p.price > 0 ? p.price : 0;
  const commissionRate = p?.commission_pct != null && Number.isFinite(p.commission_pct) ? p.commission_pct / 100 : null;
  return { priceOzon: productPrice, commissionRate, logisticsFbo: p?.logistics_fbo_tariff ?? null, cost: cost ?? null };
}
```

- [ ] **Step 2: Переписать `computeOzon`**

Заменить функцию `computeOzon` целиком на:

```js
// ---------- Ozon ----------
// Модель уровня WB (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §3):
// факты за 30 дней ПО ВЧЕРА из начислений (order_costs) одним batch-SQL —
// комиссия/эквайринг (доли от цены), прямая логистика F на проданную штуку,
// логистика невыкупа R на одну невыкупленную (is_return=1: цена 0, парной
// продажи нет), % выкупа b = продано/(продано+невыкупы), справочная
// средняя цена проданного. Соинвест — из снимков кабинета tenant.ozon_prices
// (source='cabinet'), последний день; нет снимка → null («—», не 0%).
async function computeOzon(rates = {}, { includeInactive = false } = {}) {
  const db = new DatabaseSync("ozon", { readOnly: true });
  const products = {};
  for (const r of await db.prepare(
    `SELECT product_id, offer_id, name, category, brand,
            commission_pct, logistics_fbo_tariff, price, im_url
     FROM products`
  ).all()) products[r.product_id] = r;

  const cogs = {};
  for (const r of await db.prepare(
    `SELECT DISTINCT ON (product_id) product_id, cost FROM tenant.cost_overrides
     WHERE platform = 'ozon' AND effective_from <= current_date
     ORDER BY product_id, effective_from DESC`
  ).all()) cogs[r.product_id] = r.cost > 0 ? r.cost : null;
  const manual = await loadManual("ozon");
  const stat = await statusMap();

  // Факты окна. ABS(SUM(...)) — суммы в конвенции площадки, модель ждёт положительные ₽.
  const { from: winFrom, to: winTo } = defaultPeriod(30);
  const facts = {};
  let totRet = 0, totReturns = 0, totAcq = 0, totRetail = 0;
  for (const r of await db.prepare(
    `SELECT product_id,
        COALESCE(SUM(qty) FILTER (WHERE is_return = 0), 0)            AS sold,
        COALESCE(SUM(qty) FILTER (WHERE is_return = 1), 0)            AS returns,
        ABS(COALESCE(SUM(logistics) FILTER (WHERE is_return = 0), 0)) AS log_fwd,
        ABS(COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0)) AS log_ret,
        ABS(COALESCE(SUM(commission) FILTER (WHERE is_return = 0), 0)) AS comm_sum,
        ABS(COALESCE(SUM(acquiring) FILTER (WHERE is_return = 0), 0))  AS acq_sum,
        COALESCE(SUM(cost_value_retail) FILTER (WHERE is_return = 0), 0) AS retail_sum
      FROM order_costs
      WHERE product_id IS NOT NULL
        AND substr(COALESCE(sale_dt, return_dt), 1, 10) >= ?
        AND substr(COALESCE(sale_dt, return_dt), 1, 10) <= ?
      GROUP BY product_id`
  ).all(winFrom, winTo)) {
    facts[r.product_id] = r;
    totRet += r.log_ret; totReturns += r.returns; totAcq += r.acq_sum; totRetail += r.retail_sum;
  }
  const cabinetR = totReturns > 0 ? totRet / totReturns : 0;
  const cabinetAcq = totRetail > 0 ? totAcq / totRetail : 0.015;

  // Соинвест из снимков кабинета (миграция 059: source='cabinet'). До миграции /
  // без снимков — null у всех.
  const boostByPid = {};
  try {
    for (const r of await db.prepare(
      `SELECT product_id, marketing_seller_price AS sp, marketing_price AS mp
       FROM ozon_prices
       WHERE source = 'cabinet'
         AND date = (SELECT MAX(date) FROM ozon_prices WHERE source = 'cabinet')`
    ).all()) {
      if (r.sp > 0 && r.mp > 0 && r.mp <= r.sp) boostByPid[r.product_id] = 1 - r.mp / r.sp;
    }
  } catch {}

  // Факт-входы одного товара поверх каталожных; null там, где факта нет.
  function factInputs(pid) {
    const f = facts[pid];
    if (!f || !(f.sold > 0)) return null;
    return {
      commissionRate: f.retail_sum > 0 ? f.comm_sum / f.retail_sum : null,
      acquiringRate: f.retail_sum > 0 ? f.acq_sum / f.retail_sum : null,
      logisticsFbo: f.log_fwd / f.sold,
      returnLogistics: f.returns > 0 ? f.log_ret / f.returns : cabinetR,
      buyout: f.sold / (f.sold + f.returns),
      priceFact: f.retail_sum / f.sold,
    };
  }

  const result = [];
  for (const [pidKey, p] of Object.entries(products)) {
    const pid = Number(pidKey);
    const fact = factInputs(pid);
    const input = {
      ...autoOzon(p, cogs[pid]),
      acquiringRate: cabinetAcq,
      returnLogistics: cabinetR,
      buyout: 1,
      ...(fact ? Object.fromEntries(Object.entries(fact).filter(([, v]) => v != null)) : {}),
      boost: boostByPid[pid] ?? null,
      ...manual[String(pid)], // ручной override (unit_inputs) — старше факта
      sku: String(pid), name: p.name || p.offer_id || String(pid), ...rates,
    };
    const r = calcOzon(input);
    r.platform = "ozon";
    r.article = p.offer_id || String(pid);
    r.category = p.category || null;
    if (p.im_url) r.im_url = p.im_url;
    r.draft = !input.priceOzon;
    r.status = stat[`ozon|0|${pid}`] || "active";
    r.sold30 = fact ? facts[pid].sold : 0;
    // «⚙ оценка» — факта за окно нет (комиссия/логистика каталожные, эквайринг/невыкуп — по кабинету).
    if (!fact && manual[String(pid)]?.logisticsFbo == null) r.estimated = true;
    result.push(r);
  }
  return includeInactive ? result : result.filter((r) => r.status === "active");
}
```

Убедиться, что `calcOzon` в файле импортирован без `await` (он синхронный; `await` на не-Promise безвреден, но лишний — убрать). Запрос к `orders` (`orderRows`) удаляется вместе со старым кодом — он больше нигде в файле не читается (проверить `grep -n orderRows`).

- [ ] **Step 3: Сторож `scripts/check-unit-ozon.mjs`**

Создать файл:

```js
#!/usr/bin/env node
// scripts/check-unit-ozon.mjs — сторож Ozon-модели юнитки (спека
// docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §7.2).
// Без HTTP: считает факты окна тем же SQL, что computeOzon, гонит их через
// calcOzon и проверяет тождество logistics × sold = Σлогистики окна (Δ < 1 коп.)
// на всех товарах кабинета с продажами. Читает под saas_ro.
// Запуск: node scripts/check-unit-ozon.mjs [cabinet_id=1]
import pg from "pg";
import { readonlyPgConfig } from "./lib/pgpass.mjs";
import { calcOzon } from "../lib/unit.js";
import { defaultPeriod } from "../lib/period.js";

const cabinetId = Number(process.argv[2] || 1);
const { from, to } = defaultPeriod(30);
const client = new pg.Client(readonlyPgConfig());
await client.connect();
const { rows } = await client.query(
  `SELECT product_id,
      COALESCE(SUM(qty) FILTER (WHERE is_return = 0), 0)            AS sold,
      COALESCE(SUM(qty) FILTER (WHERE is_return = 1), 0)            AS returns,
      ABS(COALESCE(SUM(logistics) FILTER (WHERE is_return = 0), 0)) AS log_fwd,
      ABS(COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0)) AS log_ret,
      ABS(COALESCE(SUM(commission) FILTER (WHERE is_return = 0), 0)) AS comm_sum,
      ABS(COALESCE(SUM(acquiring) FILTER (WHERE is_return = 0), 0))  AS acq_sum,
      COALESCE(SUM(cost_value_retail) FILTER (WHERE is_return = 0), 0) AS retail_sum
   FROM tenant.ozon_order_costs
   WHERE cabinet_id = $1 AND product_id IS NOT NULL
     AND substr(COALESCE(sale_dt, return_dt), 1, 10) BETWEEN $2 AND $3
   GROUP BY product_id`, [cabinetId, from, to]);
await client.end();

let pass = 0, fail = 0;
for (const r of rows) {
  const f = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  if (!(f.sold > 0)) continue;
  const R = f.returns > 0 ? f.log_ret / f.returns : 0;
  const out = calcOzon({
    priceOzon: f.retail_sum / f.sold,
    commissionRate: f.comm_sum / f.retail_sum, acquiringRate: f.acq_sum / f.retail_sum,
    logisticsFbo: f.log_fwd / f.sold, returnLogistics: R, buyout: f.sold / (f.sold + f.returns),
  });
  const want = (f.log_fwd + f.log_ret) / f.sold;
  const ok = Math.abs(out.logistics - want) < 0.01
    && Math.abs(out.commission * f.sold - f.comm_sum) < 0.01 * f.sold + 0.01;
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL product ${f.product_id}: logistics ${out.logistics} vs ${want.toFixed(2)}; commission ${out.commission * f.sold} vs ${f.comm_sum}`);
}
console.log(`окно ${from}..${to}, кабинет ${cabinetId}: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
```

Run: `cd /opt/agents/saas && node scripts/check-unit-ozon.mjs 1`
Expected: `PASS N, FAIL 0` (N ≈ число товаров с продажами за окно, ~40).

- [ ] **Step 4: Ручная сверка трёх товаров (спека §7.2)**

Под `saas_ro` для кабинета 1 взять «карта 64» и два коврика с невыкупами и посчитать руками `F`, `R`, `b`, `commissionRate` по тому же SQL, что в Step 2 (подставить `product_id`). Записать в блокнот прогона: `product_id | sold | returns | F | R | b | comm% | acq%`. Эти числа сравнить с ответом роута после деплоя (Task 9, Step 3). Здесь — только зафиксировать.

- [ ] **Step 5: Коммит**

```bash
cd /opt/agents/saas
git add "app/api/cabinets/[id]/unit/all/route.js" scripts/check-unit-ozon.mjs
git commit -m "feat(unit): факты Ozon за 30 дней из начислений (комиссия, эквайринг, F/R/выкуп, факт-цена), соинвест из снимков кабинета, сторож check-unit-ozon

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3"
```

---

### Task 4: Миграция 059 и upsert цен кабинета

**Files:**
- Create: `db/migrations/059_ozon_prices_cabinet.sql`
- Modify: `worker/db_pg.py` (после `upsert_ozon_prices_many` ~:633)

**Interfaces:**
- Produces: колонки `tenant.ozon_prices.marketing_oa_price DOUBLE PRECISION`, `tenant.ozon_prices.source TEXT NOT NULL DEFAULT 'seller_api'`; функция `db_pg.upsert_ozon_cabinet_prices_many(rows) → int`, `rows: [{product_id, date, marketing_seller_price, marketing_price, marketing_oa_price}]` (source проставляется функцией).

- [ ] **Step 1: Миграция**

Создать `db/migrations/059_ozon_prices_cabinet.sql`:

```sql
-- 059_ozon_prices_cabinet.sql — три цены из кабинета продавца в tenant.ozon_prices
-- (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §4).
-- Seller API не отдаёт цену витрины (постскриптум спеки 2026-08-02), поэтому
-- соинвест берём из кабинета: сборщик ozon_cabinet_prices пишет source='cabinet'.
-- Старые строки (Seller API, 02.08.2026) остаются с source='seller_api'. Идемпотентно.
BEGIN;
ALTER TABLE tenant.ozon_prices ADD COLUMN IF NOT EXISTS marketing_oa_price DOUBLE PRECISION; -- цена с Ozon Картой
ALTER TABLE tenant.ozon_prices ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'seller_api';
ALTER TABLE tenant.ozon_prices DROP CONSTRAINT IF EXISTS ozon_prices_source_check;
ALTER TABLE tenant.ozon_prices ADD CONSTRAINT ozon_prices_source_check CHECK (source IN ('seller_api','cabinet'));
CREATE INDEX IF NOT EXISTS ozon_prices_source_date_idx ON tenant.ozon_prices (cabinet_id, source, date);
COMMIT;
```

- [ ] **Step 2: Применить миграцию и проверить**

Run:
```bash
PGPASSFILE=/root/.pgpass-admin psql -U postgres -h localhost -d saas -f /opt/agents/saas/db/migrations/059_ozon_prices_cabinet.sql
psql -h localhost -U saas_ro -d saas -Atc "select column_name, data_type, column_default from information_schema.columns where table_schema='tenant' and table_name='ozon_prices' and column_name in ('marketing_oa_price','source')"
```
Expected: две строки; `source` с дефолтом `'seller_api'`.

- [ ] **Step 3: Функция upsert в `db_pg.py`**

После `upsert_ozon_prices_many` добавить:

```python
_OZON_CABINET_PRICES_COLS = ["product_id", "date", "marketing_seller_price",
                             "marketing_price", "marketing_oa_price", "source"]


def upsert_ozon_cabinet_prices_many(rows):
    """Три цены из кабинета продавца → tenant.ozon_prices, source='cabinet'
    (миграция 059, спека 2026-09-17-ozon-unit-model §4). Обновляет ТОЛЬКО свои
    колонки — price/old_price/min_price Seller-API-снимка не трогает.
    PK (cabinet_id, product_id, date): второй тик дня перезаписывает."""
    return _batch_upsert("ozon_prices", ["product_id", "date"], _OZON_CABINET_PRICES_COLS,
                         [{**r, "source": "cabinet"} for r in rows])
```

- [ ] **Step 4: Синтаксис**

Run: `cd /opt/agents/saas && /opt/agents/data-presenter-agent/.venv/bin/python -m py_compile worker/db_pg.py && echo OK`
Expected: `OK`.

- [ ] **Step 5: Коммит**

```bash
cd /opt/agents/saas
git add db/migrations/059_ozon_prices_cabinet.sql worker/db_pg.py
git commit -m "feat(db): миграция 059 — цена с Ozon Картой и source в ozon_prices; upsert цен кабинета

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3"
```

---

### Task 5: Белый список кабинетного клиента

**Files:**
- Modify: `worker/cabinet_client.py` (`ALLOWED_PATHS` ~:31-37)
- Test: `worker/cabinet_client_selftest.py` (существующий, менять не нужно)

**Interfaces:**
- Produces: `CabinetClient.post("/api/pricing-bff-service/v3/get-common-prices", {...})` разрешён.

- [ ] **Step 1: Добавить путь**

В кортеж `ALLOWED_PATHS` добавить строку:

```python
    "/api/pricing-bff-service/v3/get-common-prices",                               # три цены (соинвест), ozon_cabinet_prices
```

- [ ] **Step 2: Селф-тест клиента**

Run: `cd /opt/agents/saas && /opt/agents/data-presenter-agent/.venv/bin/python worker/cabinet_client_selftest.py`
Expected: все `PASS`, включая `путь только чтение: /api/pricing-bff-service/v3/get-common-prices`.

- [ ] **Step 3: Коммит**

```bash
cd /opt/agents/saas
git add worker/cabinet_client.py
git commit -m "feat(cabinet): get-common-prices в белом списке клиента (только чтение)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3"
```

---

### Task 6: Сборщик `ozon_cabinet_prices` + селф-тест + регистрация

**Files:**
- Create: `worker/collectors/ozon_cabinet_prices.py`
- Modify: `worker/collectors/ozon_cabinet_selftest.py` (добавить блок в конец перед итогом)
- Modify: `worker/orchestrator.py` (`OZON_COLLECTORS` ~:222-224; `CABINET_COLLECTORS` :229; дефолт `SAAS_PAUSE_EXEMPT` :87)
- Modify: `worker/run_saas_collect.sh` (`CABINET_COLLECTORS` :88)

**Interfaces:**
- Consumes: `cc.from_env()`, `client.post(path, payload)`, исключения `cc.CabinetBusyError / CabinetAuthError / CabinetError`, `db_pg.upsert_ozon_cabinet_prices_many(rows)` (Task 4), `db_pg.query(sql, params)`.
- Produces: модуль с `collect(date_from, date_to) → int` (argv как у соседей; даты игнорируются — снимок на сегодня), `parse_common_prices(resp, id2pid) → list[dict]`, `parse_list_page(resp) → dict[str, str]` (item_id → offer_id). Exit: 0 ok · 3 профиль занят · 5 сессия истекла · 1 прочее.

- [ ] **Step 1: Селф-тест парсера (падающий)**

В `worker/collectors/ozon_cabinet_selftest.py` перед строкой с итогом (`print(f"... failed ...")` / `sys.exit`) добавить:

```python
# ── цены кабинета (get-common-prices) → ozon_cabinet_prices ──
import ozon_cabinet_prices as cp  # noqa: E402
LIST_RESP = {"products": [
    {"item_id": "5393596117", "part_item": {"offer_id": "карта 64"}},
    {"item_id": "4192317618", "part_item": {"offer_id": "Серый квадрат 90*210"}},
    {"item_id": "999", "part_item": {}},                     # без offer_id — пропуск
], "cursor": "abc"}
check("list-by-filter: item_id → offer_id", cp.parse_list_page(LIST_RESP) == {"5393596117": "карта 64", "4192317618": "Серый квадрат 90*210"}, cp.parse_list_page(LIST_RESP))

PRICES_RESP = {"items": [
    {"item_id": "5393596117", "marketing_seller_price": "1800", "marketing_price": "1260", "marketing_oa_price": "887"},
    {"item_id": "4192317618", "marketing_seller_price": "2550", "marketing_price": None, "marketing_oa_price": "1366"},
    {"item_id": "777", "marketing_seller_price": "10"},        # нет в каталоге — пропуск
    {"item_id": "4192317618", "marketing_seller_price": "0"},  # нули → строка без цен не пишется
]}
ID2PID = {"5393596117": 5393596117, "4192317618": 4192317618}
rows = cp.parse_common_prices(PRICES_RESP, ID2PID, "2026-09-17")
check("common-prices: три цены", rows[0] == {"product_id": 5393596117, "date": "2026-09-17",
      "marketing_seller_price": 1800.0, "marketing_price": 1260.0, "marketing_oa_price": 887.0}, rows[0])
check("common-prices: marketing_price None сохраняется как None", rows[1]["marketing_price"] is None and rows[1]["marketing_oa_price"] == 1366.0, rows[1])
check("common-prices: чужой item и нулевые цены пропущены", len(rows) == 2, rows)
```

Run: `cd /opt/agents/saas && WB_SaaS_CABINET_ID=1 /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_cabinet_selftest.py`
Expected: падает на `import ozon_cabinet_prices` (ModuleNotFoundError).

- [ ] **Step 2: Сборщик**

Создать `worker/collectors/ozon_cabinet_prices.py`:

```python
"""
SaaS-сборщик ТРЁХ ЦЕН Ozon из кабинета продавца → tenant.ozon_prices (source='cabinet').
Цель — СОИНВЕСТ (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §4):
  marketing_seller_price — цена продавца с его акциями (то, что он получает);
  marketing_price        — цена для всех покупателей с соинвестом Ozon;
  marketing_oa_price     — цена с Ozon Картой.
Соинвест % = 1 − marketing_price / marketing_seller_price (считает роут unit/all).
Seller API этих цен не отдаёт (постскриптум спеки 2026-08-02) — только кабинет.
Два вызова: список товаров в продаже (list-by-filter, курсор, по 200) → item_id ↔
offer_id; цены батчами по 100 (get-common-prices). item_id кабинета = product_id
Seller API (проверено пробой 17.09.2026 — см. спеку §8); связка через
offer_id ↔ tenant.ozon_products как страховка.
Снимок на СЕГОДНЯ (argv-даты принимаются для совместимости с таймером и игнорируются);
второй тик дня перезаписывает. Идемпотентно.
Exit: 0 ok · 3 профиль занят · 5 сессия кабинета истекла (маркер CABINET_AUTH_EXPIRED)
· 1 прочее. SAAS_PROBE=1 — напечатать первые 5 товаров и НЕ писать.
Селф-тест парсеров: ozon_cabinet_selftest.py.
"""
import os
import sys
from datetime import date, datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg  # noqa: E402
import cabinet_client as cc  # noqa: E402

P_LIST = "/api/v1/products/list-by-filter"
P_PRICES = "/api/pricing-bff-service/v3/get-common-prices"
LIST_PAGE = 200
PRICE_BATCH = 100
BUSY_RETRIES, BUSY_WAIT = 5, 60


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def parse_list_page(resp):
    """products[] → {item_id: offer_id}; строки без offer_id пропускаются."""
    out = {}
    for pr in resp.get("products") or []:
        offer = (pr.get("part_item") or {}).get("offer_id")
        iid = pr.get("item_id")
        if iid is not None and offer:
            out[str(iid)] = offer
    return out


def parse_common_prices(resp, id2pid, day):
    """items[] → строки ozon_prices. Только товары из id2pid; строка без единой
    цены > 0 не пишется (нули кабинета — не цены)."""
    rows = []
    for it in resp.get("items") or []:
        pid = id2pid.get(str(it.get("item_id")))
        if pid is None:
            continue
        sp, mp, oa = _num(it.get("marketing_seller_price")), _num(it.get("marketing_price")), _num(it.get("marketing_oa_price"))
        if sp is None and mp is None and oa is None:
            continue
        rows.append({"product_id": pid, "date": day, "marketing_seller_price": sp,
                     "marketing_price": mp, "marketing_oa_price": oa})
    return rows


def fetch_id2offer(client, company_id):
    id2offer, cursor = {}, ""
    for _ in range(100):  # предохранитель: 100 × 200 = 20 000 товаров
        resp = client.post(P_LIST, {
            "company_id": company_id,
            "filters": {"search": "", "categories": [], "flags": []},
            "aggregate": {"parts": ["PART_ITEM"], "human_texts": True},
            "return_total_items": True, "visibility": "IN_SALE",
            "sort_by": "SORT_BY_CREATED_AT", "sort_dir": "SORT_DIRECTION_DESC",
            "limit": LIST_PAGE, "cursor": cursor})
        page = parse_list_page(resp)
        id2offer.update(page)
        new_cursor = resp.get("cursor") or ""
        if not page or not new_cursor or new_cursor == cursor:
            break
        cursor = new_cursor
    return id2offer


def fetch_prices(client, company_id, item_ids, id2pid, day):
    rows = []
    for i in range(0, len(item_ids), PRICE_BATCH):
        resp = client.post(P_PRICES, {"company_id": company_id, "item_ids": item_ids[i:i + PRICE_BATCH]})
        rows += parse_common_prices(resp, id2pid, day)
    return rows


def _id2pid(id2offer):
    """item_id → product_id: прямое совпадение с каталогом, иначе через offer_id."""
    offer2pid = {r["offer_id"]: int(r["product_id"]) for r in db_pg.query(
        "SELECT product_id, offer_id FROM tenant.ozon_products WHERE offer_id IS NOT NULL")}
    pids = set(offer2pid.values())
    out = {}
    for iid, offer in id2offer.items():
        if iid.isdigit() and int(iid) in pids:
            out[iid] = int(iid)
        elif offer in offer2pid:
            out[iid] = offer2pid[offer]
    return out


def _obs(n, day):
    print(f"##OBS rows={n} from={day} to={day}", flush=True)


def collect(date_from=None, date_to=None):
    probe = bool(os.environ.get("SAAS_PROBE"))
    company_id = os.environ.get("OZON_CABINET_COMPANY_ID", "")
    day = date.today().isoformat()
    db_pg.init()
    print(f"[ozon_cabinet_prices] снимок трёх цен кабинета на {day}", flush=True)
    for attempt in range(1, BUSY_RETRIES + 1):
        try:
            with cc.from_env() as client:
                id2offer = fetch_id2offer(client, company_id)
                id2pid = _id2pid(id2offer)
                missing = len(id2offer) - len(id2pid)
                print(f"  в продаже {len(id2offer)}, в каталоге {len(id2pid)}"
                      + (f", не связано {missing}" if missing else ""), flush=True)
                rows = fetch_prices(client, company_id, list(id2pid), id2pid, day)
                if probe:
                    for r in rows[:5]:
                        print(f"  PROBE {id2offer.get(str(r['product_id']), r['product_id'])}: {r}", flush=True)
                    _obs(0, day)
                    return 0
                if id2pid and not rows:
                    print("[ozon_cabinet_prices] FAIL: товары есть, цен нет", file=sys.stderr, flush=True)
                    _obs(0, day)
                    return 1
                n = db_pg.upsert_ozon_cabinet_prices_many(rows)
                print(f"[ozon_cabinet_prices] записано {n} товаров", flush=True)
                _obs(n, day)
                return 0
        except cc.CabinetBusyError as e:
            print(f"  профиль занят ({attempt}/{BUSY_RETRIES}): {e}", flush=True)
            if attempt == BUSY_RETRIES:
                print("cabinet_busy: профиль занят, тик пропущен", file=sys.stderr, flush=True)
                _obs(0, day)
                return 3
            cc.SLEEP(BUSY_WAIT)
        except cc.CabinetAuthError as e:
            print(f"CABINET_AUTH_EXPIRED: {e}", file=sys.stderr, flush=True)
            _obs(0, day)
            return 5
        except cc.CabinetError as e:
            print(f"cabinet_error: {e}", file=sys.stderr, flush=True)
            _obs(0, day)
            return 1
    return 3


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    yday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    df = sys.argv[1] if len(sys.argv) > 1 else yday
    dt = sys.argv[2] if len(sys.argv) > 2 else df
    sys.exit(collect(df, dt))
```

- [ ] **Step 3: Селф-тест зелёный**

Run: `cd /opt/agents/saas && WB_SaaS_CABINET_ID=1 /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_cabinet_selftest.py`
Expected: все `PASS` (старые + 4 новых).

- [ ] **Step 4: Регистрация**

`worker/orchestrator.py`:
- в `OZON_COLLECTORS` после `"ozon_cabinet_traffic", ...` добавить
  `"ozon_cabinet_prices",   # кабинет продавца: три цены → соинвест (миграция 059, тот же таймер)`
- `CABINET_COLLECTORS = ["ozon_cabinet_search", "ozon_cabinet_traffic", "ozon_cabinet_prices"]`
- дефолт `SAAS_PAUSE_EXEMPT`: `"ozon_efficiency,ozon_cabinet_search,ozon_cabinet_traffic,ozon_cabinet_prices"`.

`worker/run_saas_collect.sh`: `CABINET_COLLECTORS="ozon_cabinet_search,ozon_cabinet_traffic,ozon_cabinet_prices"`.

Проверить, нет ли `SAAS_PAUSE_EXEMPT` в `/etc/saas-worker.env` / `/etc/collectors.env` (`grep -n SAAS_PAUSE_EXEMPT /etc/saas-worker.env /etc/collectors.env`): если задан — дописать `ozon_cabinet_prices` и туда (файл вне git, правка руками, сказать владельцу).

- [ ] **Step 5: Селф-тест оркестратора и синтаксис**

Run:
```bash
cd /opt/agents/saas && /opt/agents/data-presenter-agent/.venv/bin/python -m py_compile worker/orchestrator.py worker/collectors/ozon_cabinet_prices.py && /opt/agents/data-presenter-agent/.venv/bin/python worker/orchestrator_selftest.py && bash -n worker/run_saas_collect.sh && echo OK
```
Expected: селф-тест `PASS`, в конце `OK`.

- [ ] **Step 6: Коммит**

```bash
cd /opt/agents/saas
git add worker/collectors/ozon_cabinet_prices.py worker/collectors/ozon_cabinet_selftest.py worker/orchestrator.py worker/run_saas_collect.sh
git commit -m "feat(worker): сборщик ozon_cabinet_prices — три цены из кабинета продавца (соинвест), таймер saas-cabinet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3"
```

---

### Task 7: Живая проба и первый боевой тик (после входа владельца в кабинет)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md` §8

**Interfaces:**
- Consumes: сборщик Task 6; `auth.shops.cabinet_state` кабинета 1 = `ok` (после `python -m app.cabinet_login` владельцем в ozon-panel — тот же профиль `/opt/agents/ozon-panel/backend/.pw-profile`).

- [ ] **Step 1: Убедиться, что сессия жива**

Run: `psql -h localhost -U saas_ro -d saas -Atc "select cabinet_state, cabinet_last_error from auth.shops where cabinet_id=1 and cabinet_profile_dir is not null"`
Expected: `ok|`. Если `expired` — остановиться и попросить владельца войти (панель → «Открыть вход в кабинет Ozon»). Дальше не идти.

- [ ] **Step 2: Проба без записи**

Run (профиль общий с панелью — не в 07:00–08:40, когда идёт её синк, и не в 06:00/20:00 нашего таймера):
```bash
cd /opt/agents/saas && SAAS_PROBE=1 DISPLAY=:99 flock -w 600 /run/lock/saas-cabinet.lock \
  /opt/agents/saas/worker/.venv-cabinet/bin/python -m worker.orchestrator --cabinet 1 --collectors ozon_cabinet_prices --verbose
```
Expected: строки `PROBE карта 64: {...marketing_seller_price, marketing_price, marketing_oa_price}` для 5 товаров, exit 0. Если `не связано N` > 0 — гипотеза `item_id = product_id` не подтвердилась, смотреть связку через offer_id (она есть).

- [ ] **Step 3: Сверка с сайтом и записать §8**

Сравнить «карту 64»: `marketing_seller_price` ≈ `tenant.ozon_products.price` и начисление на штуку за вчера (`psql … select round((sum(cost_value_retail)/sum(qty))::numeric) from tenant.ozon_order_costs where cabinet_id=1 and product_id=5393596117 and is_return=0 and substr(sale_dt,1,10)=(current_date-1)::text`); `marketing_oa_price` ≈ цена с Ozon Картой, которую назвал владелец; `marketing_price` ≈ обычная цена на сайте. В §8 спеки записать таблицу `товар | продавца | для всех | с Ozon Картой | сайт (владелец) | начисление` и вывод: «цены совпадают / расходятся на …». Если `marketing_price` пустой у всех — соинвест считать нельзя, зафиксировать и остановиться до решения владельца.

- [ ] **Step 4: Первый боевой тик и проверка**

Run:
```bash
cd /opt/agents/saas && DISPLAY=:99 flock -w 600 /run/lock/saas-cabinet.lock \
  /opt/agents/saas/worker/.venv-cabinet/bin/python -m worker.orchestrator --cabinet 1 --collectors ozon_cabinet_prices
psql -h localhost -U saas_ro -d saas -Atc "select date, count(*), count(marketing_price), round(avg(1 - marketing_price/marketing_seller_price)::numeric,3) from tenant.ozon_prices where cabinet_id=1 and source='cabinet' group by 1 order by 1 desc limit 3"
```
Expected: строка за сегодня, `count` ≈ числу товаров в продаже (~125), средний соинвест в разумных пределах (0,2–0,5 по данным панели).

- [ ] **Step 5: Коммит §8**

```bash
cd /opt/agents/saas
git add docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md
git commit -m "docs(spec): юнитка Ozon — результаты живой пробы цен кабинета (§8)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3"
```

---

### Task 8: Контракт метрик

**Files:**
- Modify: `docs/metrics-contract.md` (§11.4 ~:1502-1520; §11.6 абзац «ЯВНО: “с % выкупа” на Ozon — no-op» ~:1846-1852; новый §11.7 перед `## 12.`)

- [ ] **Step 1: §11.4 — формула Ozon**

Заменить строку `**Формула Ozon.** ... lib/unit.js:280` на:

```markdown
**Формула Ozon (с 2026-09-17, спека 2026-09-17-ozon-unit-model-design.md).**
`profit = priceSell − vat − usn − commission − acquiring − logistics − ads − cost`, где
`priceSell = priceOzon × (1 − discount)` — цена продавца (`products.price` =
`marketing_seller_price`), база НДС/комиссии/эквайринга/рекламы/маржи;
`commission = priceSell × commissionRate`, `acquiring = priceSell × acquiringRate`
(ставки — факт из `ozon_order_costs` за 30 дней по вчера, доли от
`cost_value_retail`; fallback — каталог / среднее по кабинету);
`logistics = F + R × (1 − b) / b` — F прямая логистика на проданную штуку, R логистика невыкупа
(строка `is_return=1`: цена 0, парной продажи нет), b = продано/(продано+невыкупы),
все из начислений за то же окно; F на b не делится — логистика неудачных попыток целиком в R;
`margin = profit / priceSell` (как у WB — `profit / priceCabinet`). Соинвест
`boost` — справочный (§11.7), из прибыли не вычитается. `lib/unit.js`, `calcOzon`.
Тождество: при фактических F/R/b `logistics = Σлогистики окна / продано` —
сторож `scripts/check-unit-ozon.mjs`.
```

- [ ] **Step 2: §11.6 — снять «no-op»**

Абзац, начинающийся с `**ЯВНО: «с % выкупа» на Ozon — no-op, это осознанно, не баг.**`, заменить на:

```markdown
**«С % выкупа» на Ozon работает с 2026-09-17.** `buyout` — вход `calcOzon`
(§11.4) и ключ whitelist `ALLOWED_KEYS.ozon` (`max = 1`). OFF → `buyout = 1`
→ `logistics = F` (логистика невыкупов не участвует, колонка «Невыкуп ₽»
прячется вместе с «% выкупа»). До 17.09 галочка на Ozon была no-op по
конструкции — модель не принимала `buyout`.
```

- [ ] **Step 3: §11.7 — соинвест и снимки кабинета**

Перед `## 12. Маржа` добавить:

```markdown
### 11.7 Соинвест Ozon из кабинета продавца (`tenant.ozon_prices`, `source='cabinet'`, миграция 059, 2026-09-17)

**Источник.** Сборщик `ozon_cabinet_prices` (таймер `saas-cabinet`, 06:00/20:00)
снимает через кабинетный клиент три цены на день: `marketing_seller_price`
(продавца, с его акциями), `marketing_price` (для всех покупателей, с
соинвестом Ozon), `marketing_oa_price` (с Ozon Картой). Seller API цены витрины
не отдаёт (спека 2026-08-02, постскриптум) — старые строки `source='seller_api'`
с пустым `marketing_price` соинвест не дают.

**Определение.** `boost = 1 − marketing_price / marketing_seller_price` по
последнему дню `source='cabinet'`, только если обе цены > 0 и
`marketing_price ≤ marketing_seller_price`; иначе `null` («—», не 0 % — правило
о финансах). Скидка Ozon Карты в соинвест НЕ входит (решение владельца
17.09.2026); `marketing_oa_price` хранится справочно.

**Карта доверия.** Снимок на момент тика (не история дня); лаг — до 14 часов;
истёкшая сессия кабинета → строк нет → `null` у всех; чужие кабинеты без
профиля — всегда `null`. Из прибыли не вычитается: продавец получает
`marketing_seller_price` (сверено с начислениями на «карте 64», спека §8).
```

- [ ] **Step 4: Коммит**

```bash
cd /opt/agents/saas
git add docs/metrics-contract.md
git commit -m "docs(contract): §11.4 формула Ozon уровня WB, §11.6 выкуп на Ozon работает, §11.7 соинвест из кабинета

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3"
```

---

### Task 9: Сборка, деплой, смоуки, память

**Files:**
- Memory: `/root/.claude/projects/-opt-agents-saas/memory/ozon-unit-model-done.md` (новый) + строка в `MEMORY.md`

- [ ] **Step 1: Тесты и сторожа до сборки**

Run:
```bash
cd /opt/agents/saas && node --test lib/__tests__/ && node scripts/check-unit-ozon.mjs 1 && node scripts/check-profit-canon.mjs 2>&1 | tail -3
```
Expected: lib-тесты PASS; сторож юнитки `FAIL 0`; канон прибыли без регрессий (юнитка канон не трогает — просто контроль).

- [ ] **Step 2: Сборка и рестарт**

Run: `cd /opt/agents/saas && npm run build 2>&1 | tail -5 && systemctl restart saas-web && sleep 3 && systemctl is-active saas-web`
Expected: сборка без ошибок, `active`.

- [ ] **Step 3: Смоук роута на кабинете 1**

Взять cookie сессии панели так же, как в `scripts/smoke-auth-phase*.mjs` (логин владельца), либо через `curl` с существующим cookie владельца; запросить `GET /api/cabinets/1/unit/all` и сверить у трёх товаров из Task 3 Step 4 поля `commissionRate, acquiringRate, logisticsFbo, returnLogistics, buyout, priceFact, boost` с записанными руками числами — Δ = 0 (округление до 4 знаков у долей, до копейки у ₽). `boost` — число у товаров, у которых есть снимок кабинета, иначе `null`. У товаров без продаж — `estimated: true`.

- [ ] **Step 4: Визуальная проверка**

Открыть `/cabinets/1/unit`, вкладка Ozon: колонки по спеке §5; галочка «с % выкупа» меняет «Логистика на продажу» и прячет «% выкупа»/«Невыкуп ₽»; «Соинвест» — проценты или «—»; прикидка с изменённым «% выкупа» сохраняется (F5 не теряет). WB-вкладка выглядит как до правок.

- [ ] **Step 5: Память и итог владельцу**

Создать память `ozon-unit-model-done.md` (type: project): что сделано, дата, решения владельца по 6 полям, тождество логистики, где сторож, что ждёт владельца (визуальная приёмка, сверка соинвеста с сайтом, перегенерация Excel-зеркала), ловушки (общий профиль с панелью, сессия истекает, `source='cabinet'`). Добавить строку в `MEMORY.md`. Написать владельцу короткий отчёт: что изменилось в цифрах у 2–3 товаров (прибыль/маржа до и после) и что проверить.

---

## Самопроверка плана

- Спека §1 (6 решений) → Task 1 (цена, комиссия/эквайринг, выкуп/невыкупы, реклама, маржа), Task 3 (факты), Task 4–7 (соинвест).
- §2 формулы и тождество → Task 1 Step 4 + тесты Step 1; сторож Task 3 Step 3.
- §3 факты и fallback → Task 3 Step 2 (`factInputs`, `cabinetR`, `cabinetAcq`, `estimated`).
- §4 таблица/сборщик/белый список/расписание/проба → Task 4, 5, 6, 7.
- §5 UI/whitelist → Task 2.
- §6 контракт → Task 8. §7 проверка → Task 1, 3, 9. §8 проба → Task 7. §9 вне рамок — не планируется.
- Имена сквозные: `acquiringRate`, `returnLogistics`, `buyout`, `priceFact`, `boost` (Task 1 ↔ 2 ↔ 3); `upsert_ozon_cabinet_prices_many` (Task 4 ↔ 6); `parse_list_page`/`parse_common_prices(resp, id2pid, day)` (Task 6 селф-тест ↔ код); путь `get-common-prices` (Task 5 ↔ 6).
