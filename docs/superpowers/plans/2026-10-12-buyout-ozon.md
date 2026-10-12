# Процент выкупа — Ozon (этап 2) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Точный когортный выкуп Ozon на странице `/buyout` (переключатель WB / Ozon / Все) и в «Сводке по товарам» — тот же расчёт, флаг legacy убрать.

**Architecture:** Ядро `lib/buyout.js` получает `classifyOzonPosting` и диспетчер по `row.platform`; ключ товара — `platform:nmId` (WB nm_id и Ozon product_id не сталкиваются). Данные Ozon — `ozon_orders` (когорта по дате заказа) + `ozon_order_costs.is_return` по отправлению (сборщик уже склеил формы номеров начислений). Роут и Сводка зовут общий загрузчик.

**Tech Stack:** Next.js 14, PostgreSQL (RLS, `tenantQuery` внутри `withCabinet`), `node:test`, recharts.

**Spec:** `docs/superpowers/specs/2026-10-11-buyout-page-design.md` (§8 «Ozon — следующий этап»); решения этапа 2 — в этом плане, раздел «Канон Ozon».

## Global Constraints

- Канон Ozon (утверждён владельцем 12.10.2026), ведро на отправление (`ozon_orders.posting_number`), проверки по порядку:
  - `self` — `ozon_order_costs.self_buyout = 1` (сейчас 0 строк, но правило симметрично WB);
  - `returned` — `status = 'delivered'` и `ozon_order_costs.is_return = 1` по отправлению;
  - `sold` — `status = 'delivered'` (в т.ч. без начисления продажи: скидки Ozon обнулили выплату — покупатель товар забрал);
  - `refused` — `status = 'cancelled'` и `ozon_order_costs.is_return = 1` (обратная логистика 45/59);
  - `cancelledPre` — `status = 'cancelled'`, нет `is_return = 1`, и `COALESCE(cancel_dt, last_change_dt)` старше `CANCEL_SETTLE_DAYS = 7` дней;
  - `pending` — всё остальное (`delivering`, `awaiting_deliver`, `awaiting_packaging`, свежая отмена).
- Формула и пороги общие с WB: `% = sold / (sold + refused + returned)`, `IMMATURE_SHARE = 0.05`, `MIN_RESOLVED = 20`, проценты 0..100 через `round2`.
- Ozon: размеров нет (`size = "0"`), строка = товар (`product_id`).
- Ключ товара в агрегатах — `platform + ":" + nmId`; в выдаче у item есть `platform: "wb" | "ozon"`.
- `asOf = todayMsk()`.
- Работаем и проверяем ТОЛЬКО кабинет #1. В БД не пишем.
- Пустой `catch {}` запрещён. `next dev` в /opt/agents/saas не запускать; после правок `app/`/`lib/` — `npm run build && systemctl restart saas-web`.
- Бэкап правленого боевого файла — `/opt/agentsDB/backups/<имя>.<YYYYMMDD_HHMMSS>.bak`. `git add` только явные пути. Коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Ядро — классификация Ozon и платформа в агрегатах

**Files:**
- Modify: `lib/buyout.js`
- Test: `lib/__tests__/buyout.test.mjs`

**Interfaces:**
- Produces:
  - Ozon-строка: `{ platform: "ozon", srid: string /*posting_number*/, nmId: number /*product_id*/, article: string|null /*offer_id*/, name: string|null, size: "0", orderDate: "YYYY-MM-DD", status: string, cancelAt: string|null, isReturn: boolean, selfBuyout: boolean }`.
  - WB-строка — как раньше, плюс необязательное `platform: "wb"` (отсутствие = WB).
  - `classifyOzonPosting(row, asOf) → bucket`; `classifyRow(row, asOf)` — диспетчер (`row.platform === "ozon"` → Ozon, иначе WB).
  - `aggregateBuyout(rows, asOf)` — items с полем `platform`, ключ группировки `platform:nmId`.
  - `weeklyBuyout(rows, asOf, { weeks = 13, nmId = null, platform = null })` — при `nmId` фильтр по паре (`platform ?? "wb"`, `nmId`).

- [ ] **Step 1: Падающие тесты** — добавить в конец `lib/__tests__/buyout.test.mjs` (импорт расширить на `classifyOzonPosting, classifyRow`):

```js
const oz = (o) => ({ platform: "ozon", srid: "p", nmId: 500, article: "CAM-1", name: "Камера", size: "0",
  orderDate: "2026-09-01", status: "delivered", cancelAt: null, isReturn: false, selfBuyout: false, ...o });

test("Ozon: доставлено — выкуп, доставлено+возврат — возврат, самовыкуп важнее", () => {
  assert.equal(classifyOzonPosting(oz({}), ASOF), "sold");
  assert.equal(classifyOzonPosting(oz({ isReturn: true }), ASOF), "returned");
  assert.equal(classifyOzonPosting(oz({ selfBuyout: true }), ASOF), "self");
});

test("Ozon: отмена с обратной логистикой — невыкуп; без неё — до отгрузки через 7 дней", () => {
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", isReturn: true }), ASOF), "refused");
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelAt: "2026-10-04T10:00:00" }), ASOF), "cancelledPre");
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelAt: "2026-10-05T10:00:00" }), ASOF), "pending");
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelAt: null }), ASOF), "pending");
});

test("Ozon: в доставке/ожидании — в пути", () => {
  for (const s of ["delivering", "awaiting_deliver", "awaiting_packaging"]) {
    assert.equal(classifyOzonPosting(oz({ status: s }), ASOF), "pending", s);
  }
});

test("classifyRow: диспетчер по платформе", () => {
  assert.equal(classifyRow(oz({ status: "cancelled", isReturn: true }), ASOF), "refused");
  assert.equal(classifyRow(row({ hasSale: true }), ASOF), "sold");
});

test("aggregateBuyout: WB nm 500 и Ozon product 500 — разные товары", () => {
  const rows = [row({ srid: "w1", nmId: 500, hasSale: true }), oz({ srid: "o1", nmId: 500, status: "cancelled", isReturn: true })];
  const { kpi, items } = aggregateBuyout(rows, ASOF);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.platform).sort(), ["ozon", "wb"]);
  assert.equal(items.find((i) => i.platform === "ozon").refused, 1);
  assert.equal(kpi.sold, 1);
  assert.equal(kpi.refused, 1);
  assert.deepEqual(items.find((i) => i.platform === "ozon").sizes, []);
});

test("weeklyBuyout: фильтр товара учитывает платформу", () => {
  const rows = [row({ srid: "w1", nmId: 500, orderDate: "2026-10-06", hasSale: true }),
    oz({ srid: "o1", nmId: 500, orderDate: "2026-10-06", status: "cancelled", isReturn: true })];
  const w = weeklyBuyout(rows, ASOF, { nmId: 500, platform: "ozon" });
  assert.equal(w.weeks[11].refused, 1);
  assert.equal(w.weeks[11].sold, 0);
  const wb = weeklyBuyout(rows, ASOF, { nmId: 500 });
  assert.equal(wb.weeks[11].sold, 1);
  assert.equal(wb.weeks[11].refused, 0);
});
```

- [ ] **Step 2: Запустить — падает.** `node --test lib/__tests__/buyout.test.mjs` → FAIL (`classifyOzonPosting` не экспортирован).

- [ ] **Step 3: Реализация** в `lib/buyout.js`:
  - сразу после `classifyWbOrder` добавить:

```js
// Ozon (этап 2, 12.10.2026): ведро на отправление. is_return из ozon_order_costs — сборщик уже
// склеил формы номеров начислений (base/suffix) и пометил обратную логистику 45/59 и сторно
// продажи. delivered без начисления продажи (скидки Ozon обнулили выплату) — всё равно выкуп.
const OZ_CANCELLED = "cancelled";
const OZ_DELIVERED = "delivered";
export function classifyOzonPosting(r, asOf) {
  if (r.selfBuyout) return "self";
  if (r.status === OZ_DELIVERED) return r.isReturn ? "returned" : "sold";
  if (r.status === OZ_CANCELLED) {
    if (r.isReturn) return "refused";
    const at = r.cancelAt ? Date.parse(String(r.cancelAt).slice(0, 10)) : NaN;
    if (Number.isFinite(at) && (Date.parse(asOf) - at) / DAY > CANCEL_SETTLE_DAYS) return "cancelledPre";
  }
  return "pending";
}

export function classifyRow(r, asOf) {
  return r.platform === "ozon" ? classifyOzonPosting(r, asOf) : classifyWbOrder(r, asOf);
}
```

  - в `aggregateBuyout`: `classifyWbOrder(r, asOf)` → `classifyRow(r, asOf)`; ключ Map — `const key = \`${r.platform || "wb"}:${r.nmId}\``; в объект item добавить `platform: r.platform || "wb"`; в выдаче items — `platform: it.platform` перед `nmId`.
  - в `weeklyBuyout`: сигнатура `{ weeks = 13, nmId = null, platform = null } = {}`; фильтр `if (nmId != null && (r.nmId !== nmId || (r.platform || "wb") !== (platform || "wb"))) continue;`; `classifyWbOrder` → `classifyRow`.
  - шапку файла поправить: «процент выкупа WB и Ozon когортно по дате заказа».

- [ ] **Step 4:** `node --test lib/__tests__/buyout.test.mjs` → PASS (все старые + 6 новых). `node --test lib/__tests__/*.test.mjs` → всё зелёное.

- [ ] **Step 5: Commit** `lib/buyout.js lib/__tests__/buyout.test.mjs` — `feat(buyout): классификация Ozon по отправлению, платформа в ключе товара`.

---

### Task 2: Данные Ozon и параметр площадки в API

**Files:**
- Modify: `lib/buyoutData.js`, `app/api/cabinets/[id]/buyout/route.js`

**Interfaces:**
- Consumes: `aggregateBuyout`, `weeklyBuyout(…, { nmId, platform })`, `todayMsk` (Task 1).
- Produces:
  - `loadOzonBuyoutRows(from, to) → Promise<OzonRow[]>`;
  - `loadBuyoutRows(platform: "wb"|"ozon"|"all", from, to)` — WB, Ozon или обе (строго последовательно);
  - `GET /buyout?platform=wb|ozon|all` (дефолт `all`) → `{ platform, from, to, asOf, kpi, items }` (поле `ozon: {legacy}` убрать); `?series=1&platform=…[&nm=]` — недели по площадке, при `nm` — товар этой площадки (для `all` с `nm` площадка обязательна: если `platform=all` и задан `nm`, вернуть 400 «укажите площадку товара»).

- [ ] **Step 1: `lib/buyoutData.js`** — WB-строкам добавить `platform: "wb"` в map; добавить:

```js
export async function loadOzonBuyoutRows(from, to) {
  const { tenantQuery } = await getDb();
  const rows = await tenantQuery(
    `WITH o AS (
       SELECT posting_number, product_id, offer_id, status, substr(order_dt::text, 1, 10) AS order_date,
              COALESCE(cancel_dt, last_change_dt)::text AS cancel_at
       FROM tenant.ozon_orders
       WHERE substr(order_dt::text, 1, 10) BETWEEN $1 AND $2
     ),
     c AS (
       SELECT posting_number, bool_or(is_return = 1) AS is_return, bool_or(self_buyout = 1) AS self_buyout
       FROM tenant.ozon_order_costs WHERE posting_number IN (SELECT posting_number FROM o) GROUP BY posting_number
     )
     SELECT o.posting_number, o.product_id, o.offer_id, o.status, o.order_date, o.cancel_at,
            p.name, COALESCE(c.is_return, false) AS is_return, COALESCE(c.self_buyout, false) AS self_buyout
     FROM o
     LEFT JOIN c ON c.posting_number = o.posting_number
     LEFT JOIN tenant.ozon_products p ON p.product_id = o.product_id`,
    [from, to]
  );
  return rows.map((r) => ({
    platform: "ozon",
    srid: r.posting_number,
    nmId: Number(r.product_id),
    article: r.offer_id || null,
    name: r.name || null,
    size: "0",
    orderDate: r.order_date,
    status: r.status,
    cancelAt: r.cancel_at || null,
    isReturn: r.is_return === true,
    selfBuyout: r.self_buyout === true,
  }));
}

export async function loadBuyoutRows(platform, from, to) {
  const out = [];
  if (platform !== "ozon") out.push(...(await loadWbBuyoutRows(from, to)));
  if (platform !== "wb") out.push(...(await loadOzonBuyoutRows(from, to)));
  return out;
}
```

  Перед этим проверить типы колонок (`psql -h localhost -U saas_ro -d saas -Atc "select column_name, data_type from information_schema.columns where table_schema='tenant' and table_name in ('ozon_orders','ozon_order_costs','ozon_products') and column_name in ('order_dt','cancel_dt','last_change_dt','is_return','self_buyout','product_id','name')"`) и, если `ozon_products` имеет PK по (cabinet_id, product_id) — джойн без размножения; иначе агрегировать name через подзапрос. Шапку файла поправить (WB и Ozon).

- [ ] **Step 2: Роут** — `platform` из `qp.get("platform")`, валидные `wb|ozon|all`, дефолт `all`; заменить `loadWbBuyoutRows` на `loadBuyoutRows(platform, …)`; в `series` передавать `{ nmId, platform: platform === "all" ? null : platform }` и 400 при `all` + `nm`; фильтр `q` без изменений; в ответе `platform` фактическое, `ozon: { legacy: true }` удалить. Шапку комментария поправить.

- [ ] **Step 3: Сверка с пробой (каб. #1, только чтение)** — скрипт в scratchpad, как Task 2 этапа 1 (через `withTenant(1, …)` из `lib/db.js`): `aggregateBuyout(await loadOzonBuyoutRows("2026-08-15","2026-09-15"), todayMsk()).kpi` → ожидаем `sold ≈ 1 817`, `returned ≈ 113`, `refused ≈ 315`, `cancelledPre + pending(отмены) ≈ 93`, `buyoutPct` ≈ 80–81. Вывод — в отчёт.

- [ ] **Step 4:** `npm run build && systemctl restart saas-web`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/api/cabinets/1/buyout?platform=ozon` → 401 (без сессии).

- [ ] **Step 5: Commit** `lib/buyoutData.js "app/api/cabinets/[id]/buyout/route.js"` — `feat(buyout): данные Ozon и параметр площадки в API`.

---

### Task 3: Страница — переключатель площадки

**Files:**
- Modify: `app/cabinets/[id]/buyout/BuyoutPage.jsx`, `app/cabinets/[id]/buyout/BuyoutChart.jsx`

**Interfaces:**
- Consumes: `GET /buyout?platform=…`, `?series=1&platform=…&nm=…` (Task 2); items с `platform`.

- [ ] **Step 1: BuyoutPage.jsx**
  - state `platform` (дефолт `"all"`), кнопки-сегменты «Все / Wildberries / Ozon» рядом с датами (стиль — как переключатель площадки в `app/cabinets/[id]/purchase-need/PurchaseNeedPage.jsx`); `platform` в URL fetch и в deps эффекта.
  - ключ строки, `open`-набор и `selected` — по `${it.platform}:${it.nmId}`; `selected = { platform, nmId, name }`.
  - в ячейке товара под названием — метка площадки («WB» / «Ozon») рядом с артикулом.
  - интро-текст: убрать «Wildberries.» в начале и фразу «Ozon — следующим этапом.»; добавить «Ozon: каждое отправление — выкуп (доставлено), возврат (доставлено и сторнировано), невыкуп (отменено с обратной логистикой) или отмена до отгрузки. Размеров у Ozon нет — каждый размер отдельный товар.»
  - при смене площадки сбрасывать `selected` и `open`.
  - в `BuyoutChart` передавать `platform` (для «Все» без выбранного товара — `all`; с выбранным — площадку товара).

- [ ] **Step 2: BuyoutChart.jsx** — проп `platform`; URL `series=1&platform=${platform}${nm}`; заголовок «— весь кабинет» → «— весь кабинет (WB+Ozon)» / «(WB)» / «(Ozon)» по `platform` при `nmId == null`; `platform` в deps эффекта.

- [ ] **Step 3:** скрининги (как в этапе 1): `grep -rn 'fetch("[^"]*\${' app/cabinets/[id]/buyout/`, `grep -rn 'var(--[a-z]*)[0-9A-F]\{2\}' app/cabinets/[id]/buyout/`, `grep -rn 'catch {}' app/cabinets/[id]/buyout/` → пусто. `npm run build && systemctl restart saas-web`.

- [ ] **Step 4: Commit** обоих файлов — `feat(buyout): переключатель площадки WB / Ozon / Все`.

---

### Task 4: «Сводка по товарам» — Ozon по канону; смоук; документация

**Files:**
- Modify: `app/api/cabinets/[id]/products-summary/route.js` (`collectOzon`, ~стр. 905–925; `aggTotals`), `app/cabinets/[id]/summary/SummaryPage.jsx` (~стр. 275–315, 452–460, 552, 592), `scripts/smoke-buyout.mjs`, `docs/metrics-contract.md` (§18.3), `AGENTS.md` (пункт «Процент выкупа»)

- [ ] **Step 1: route.js `collectOzon`** — по образцу `collectWB` (там `buyoutByNm` из `aggregateBuyout(await loadWbBuyoutRows(...))`): перед формированием `out` загрузить `const ozBuyoutByPid = new Map(aggregateBuyout(await loadOzonBuyoutRows(from, toEnd.slice(0, 10)), todayMsk()).items.map((b) => [b.nmId, b]));` (импорт `loadOzonBuyoutRows`); в item заменить legacy-тройку на `buyoutSold: ozBuyoutByPid.get(Number(nm))?.sold || 0, buyoutResolved: ozBuyoutByPid.get(Number(nm))?.resolved || 0` и удалить `buyoutLegacy` и комментарий про прежнюю формулу. Проверить, как в `collectOzon` называется ключ товара (`nm`/`r.nm`) и параметр конца окна. В WB-item удалить `buyoutLegacy: false`; в `aggTotals` удалить `buyoutLegacy` (поле и `if`).
- [ ] **Step 2: SummaryPage.jsx** — удалить `buyoutLegacy` из `ft` и всех трёх мест отображения (`*` и title); у ячейки строки оставить одну подсказку: «Заказы периода → выкуплено / (выкуплено + невыкуп + возвраты), см. «Процент выкупа»».
- [ ] **Step 3: smoke-buyout.mjs** — страницу брать с `platform=all` (ключ сравнения с Сводкой — `${platform}:${nmId}` ↔ `${it.platform}:${Number(it.nm)}`), Сводку — `platform=all` (default и `includeInactive=1`); добавить те же проверки для `platform=ozon` (страница) ↔ Сводка `platform=ozon`; проверка недель — для `platform=all`. Проверить, что у items Сводки есть поле `platform` (есть: `platform: "wb"`/`"ozon"` в collect*). Не ослаблять существующие проверки.
- [ ] **Step 4: Документация** — `docs/metrics-contract.md` §18.3 переписать: «Ozon — канон с 12.10.2026» с правилами вёдер из Global Constraints, источником (`ozon_orders.status` + `ozon_order_costs.is_return`) и пробой когорты 15.08–15.09 (выкуп 1 817 / возврат 113 / невыкуп 315 / отмена до отгрузки 93 → ≈81 %); убрать упоминания legacy в §18. `AGENTS.md`: в пункте «Процент выкупа» заменить «Ozon — прежняя формула с флагом buyoutLegacy до отдельного этапа» на «Ozon — по отправлениям (status + ozon_order_costs.is_return), переключатель площадки на странице».
- [ ] **Step 5: Проверки** — `node --test lib/__tests__/*.test.mjs`; `npm run build && systemctl restart saas-web`; `node scripts/smoke-buyout.mjs 1` → ALL PASS; `grep -rn "buyoutLegacy" app lib scripts` → пусто.
- [ ] **Step 6: Commit** перечисленных файлов — `feat(summary): выкуп Ozon по канону отправлений, legacy убран; смоук и документация`.
