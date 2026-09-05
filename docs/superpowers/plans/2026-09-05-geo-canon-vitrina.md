# География 2.0 — этап 2 «Канон + витрина»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Спека:** `docs/superpowers/specs/2026-08-28-geography-v2-design.md` (этап 2 из 3; этап 1 «Данные» задеплоен 29.08, коммиты 18c9834..ec166ce).

**Goal:** Вкладка «География» отвечает на вопросы владельца: куда везти сток (локальность), где FBS проигрывает FBO (скорость), — на каноне «одна цифра везде».

**Architecture:** Новый модуль `lib/geoMetrics.js` с чистыми SQL-функциями поверх `DatabaseSync`; расчёт локальности WB выносится из `/stocks` в lib и переиспользуется обеими вкладками; роут географии переписывается на канон (`lib/period.js`, `SUM(qty)`, честные продажи Ozon, prev-окно тем же кодом); UI перестраивается в 4 секции по конвенциям рестайла (Kpi-плашки Сводки, палитра `C`/`soft`). Сторона покупателя Ozon маппится на ФО статическим справочником (миграция 048, уже написана и сверена с данными).

**Tech Stack:** Next.js (app router), PostgreSQL (RLS + shared.*), recharts, канон-слой lib/*.js, смоук-сторожа scripts/*.mjs.

## Global Constraints

- Язык кода/комментариев/коммитов — русский; `git add` только явных файлов; в конце коммита «Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>».
- Прод = master в `/opt/agents/saas`. Миграция применяется до кода. Запись в БД — только `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas`; чтение — `psql "host=localhost dbname=saas user=saas_ro"`.
- «Одна цифра везде»: суммы Географии обязаны сходиться с каноном (сторож задачи 4); расхождение = наш баг, подгонка сторожа запрещена.
- Окна периодов — «по вчера»: `defaultPeriod(30)` из `lib/period.js`; prev-окно считается ТЕМ ЖЕ кодом стыком назад (паттерн `products-summary/route.js:117-129`), не копией формул.
- Штуки: WB = `COUNT(*)` (строка заказа = 1 шт), Ozon = `SUM(qty)`. Продажи Ozon — из `tenant.ozon_sales` (после этапа 1 честные), НЕ дубль заказов.
- Схема: WB — `warehouse_type` ('Склад WB'→fbo, 'Склад продавца'→fbs); Ozon — колонка `scheme`.
- Пустые гео-имена → литерал `'Не указан'`; незамапленные ФО → `'Не определено'` (не скрывать).
- UI: палитра только из `lib/palette.js` (`C`, `soft`, `SERIES`), карточки-«острова» `borderRadius: 10, background: C.surface, border: 1px solid ${C.line}` (канон SummaryPage), tabular-nums для цифр; WB-скорость подписывается «до выкупа (прокси)».
- `shared.*` в SQL роутов пишется полным путём — `convertSql` его не трогает (negative lookbehind, `lib/db.js:80-119`); все нужные GRANT'ы: `ozon_clusters` (047+фикс), `ru_geo_fo`/`ozon_cluster_fo` (048).
- pytest нет; каждая задача завершается смоук-проверкой с реальным выводом. Сторожа — `node scripts/*.mjs` по образцу `check-profit-canon.mjs` (канон через `withTenant`, эталон через `pg.Pool` под `saas_ro`).
- Деплой UI: `npm run build && systemctl restart saas-web` (только в финальной задаче, после сторожей).
- Формат ответа гео-API v2 (контракт между задачами 3, 5, 6 — менять только синхронно):

```js
{ period: {from,to}, prevPeriod: {from,to},
  kpi:     { localPct, speedWbDays, speedOzDays, fbsSharePct, scLagHours },
  prevKpi: { ...та же форма, за prevPeriod... },   // null-поля при пустом prev
  byRegion:    [{ name, ordersRub, ordersQty, salesRub, salesQty }],  // сортировка ordersRub+salesRub desc
  byWarehouse: [{ name, ordersRub, ordersQty, salesRub, salesQty }],
  locality: { wb:   { rows: [{ whCluster, buyerCluster, qty }], localPct, mappedPct },
              ozon: { rows: [{ whFo,      buyerFo,      qty }], localPct, mappedPct } },
  speed:    { wb: [{ okrug, scheme, medianDays, n }], ozon: [{ fo, medianDays, n }] },
  facets:   { brand: [{value,count}], group: [{value,count}], nm: [{id,label,count}] } }
```

## Карта файлов

| Файл | Что происходит |
|---|---|
| `db/migrations/048_geo_reference.sql` | ГОТОВА (написана при планировании, сверена с данными: 338 имён + 22 кластера) — применить |
| `lib/geoMetrics.js` | создать: весь гео-канон (сводки, локальность, скорость, лаг СЦ) |
| `app/api/cabinets/[id]/stocks/route.js:496-520` | заменить SQL шага 2 на вызов `wbSalesLocalityByWarehouse` из lib (бит-в-бит) |
| `app/api/cabinets/[id]/geography/route.js` | переписать на канон и формат v2 |
| `app/cabinets/[id]/geo/GeoPage.jsx` | перестроить: KPI, регионы, матрица локальности, скорость |
| `scripts/check-geo-canon.mjs` | создать: сторож «одна цифра везде» |
| `docs/metrics-contract.md` | дописать раздел «География» |

Факты из живых данных (05.09, не перепроверять): городов Ozon 568, сид 048 покрывает 93% заказов; `delivered_dt` есть у 70% FBO и **0% FBS** (рФБС возит сам, последней мили нет) → скорость Ozon считается только по FBO, для FBS честное «нет данных»; WB srid-join даёт пары для 87% продаж, среднее 4.8 дня; `wb_supplies` 118 поставок / 78 сканов.

---

### Task 0: sale_dt Ozon = дата доставки (жалоба владельца 05.09: «за вчера 0 продаж»)

**Files:**
- Modify: `worker/db_pg.py` (функция `update_ozon_delivered_dt`)
- Modify: `worker/collectors/ozon_sales.py` (только докстрока — честность семантики)

**Interfaces:**
- Consumes: механизм задачи 5 этапа 1 (`update_ozon_delivered_dt`, вызывается в конце `ozon_accruals.collect()`).
- Produces: `ozon_sales.sale_dt` = дата фактической выдачи (последняя миля) для delivered-строк; потребители (`substr(sale_dt,1,10)`) совместимы.

Причина: `sale_dt = in_process_at` (дата создания заказа) → продажа «доставлена 04.09» датируется днём заказа (01–03.09), и окно «вчера» по продажам Ozon всегда ≈ 0. Продажа должна датироваться выкупом — как у WB (`sale_dt` из statistics-api = дата продажи).

- [ ] **Step 1: Расширить `update_ozon_delivered_dt`** — после существующего UPDATE `ozon_orders` добавить второй UPDATE в той же функции (та же выборка `d`):

```python
    # Продажи датируем выкупом (жалоба 05.09.2026: «за вчера 0 продаж» — sale_dt
    # был датой создания заказа). Только delivered-строки; возвраты (cancelled)
    # остаются на своей дате. Формат TEXT 'YYYY-MM-DD' совместим с потребителями
    # (везде substr(sale_dt,1,10)). Σ revenue не меняется — только распределение
    # по дням (сторож в Step 3).
    sql_sales = f"""
        UPDATE tenant.ozon_sales s
           SET sale_dt = d.dt, updated_at = now()
          FROM (SELECT unit_number, MIN(date)::text AS dt
                  FROM tenant.ozon_accruals
                 WHERE type_id IN (28, 29, 30)
                   AND unit_number IS NOT NULL AND unit_number <> ''
                   {cond}
                 GROUP BY unit_number) d
         WHERE s.posting_number = d.unit_number
           AND s.is_return = 0
           AND substr(s.sale_dt, 1, 10) IS DISTINCT FROM d.dt
    """
```
Выполнить вторым `cur.execute` в той же транзакции; вернуть суммарный rowcount двух UPDATE (формат возврата не менять — один int). Докстроку функции дополнить.

- [ ] **Step 2: Докстрока ozon_sales.py** — дописать: «sale_dt при записи = in_process_at (предварительно); после каждого сбора начислений delivered-строки передатируются на день фактической выдачи (update_ozon_delivered_dt)».

- [ ] **Step 3: Бэкфилл + сторож сумм** (админ-psql, вся история, с контролем инварианта):

```bash
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas <<'SQL'
BEGIN;
CREATE TEMP TABLE _chk AS SELECT cabinet_id, ROUND(SUM(revenue)::numeric,2) rev, COUNT(*) n
  FROM tenant.ozon_sales GROUP BY 1;
UPDATE tenant.ozon_sales s SET sale_dt = d.dt, updated_at = now()
  FROM (SELECT cabinet_id, unit_number, MIN(date)::text AS dt FROM tenant.ozon_accruals
         WHERE type_id IN (28,29,30) AND unit_number IS NOT NULL AND unit_number <> ''
         GROUP BY 1,2) d
 WHERE s.cabinet_id = d.cabinet_id AND s.posting_number = d.unit_number
   AND s.is_return = 0 AND substr(s.sale_dt,1,10) IS DISTINCT FROM d.dt;
SELECT c.cabinet_id, c.rev AS rev_before, x.rev AS rev_after, c.n AS n_before, x.n AS n_after
  FROM _chk c JOIN (SELECT cabinet_id, ROUND(SUM(revenue)::numeric,2) rev, COUNT(*) n
                      FROM tenant.ozon_sales GROUP BY 1) x USING (cabinet_id);
COMMIT;
SQL
```
Expected: `UPDATE N` (сотни/тысячи), rev_before = rev_after и n_before = n_after у всех кабинетов бит-в-бит (иначе ROLLBACK руками и разбор — но UPDATE дат суммы менять не может).

- [ ] **Step 4: Смоук воркера** — `set -a; . /etc/saas-worker.env; set +a; cd /opt/agents/saas && python3 -m worker.orchestrator --all --collectors ozon_accruals --date-from 2026-09-02 --date-to 2026-09-04`: exit 0, в БД `SELECT COUNT(*) FROM tenant.ozon_sales WHERE cabinet_id=1 AND substr(sale_dt,1,10)='2026-09-04' AND is_return=0;` — больше нуля (вчерашние выдачи встали на вчера).

- [ ] **Step 5: Commit**

```bash
git add worker/db_pg.py worker/collectors/ozon_sales.py
git commit -m "fix(worker): sale_dt Ozon = дата фактической выдачи (последняя миля) — «за вчера 0 продаж» починено"
```

⚠️ Координация: файл `worker/collectors/ozon_accruals.py` этой задачей НЕ трогается (вызов уже есть с этапа 1), но задача стартует ТОЛЬКО после завершения фикс-волны 429 от 05.09 (она правит `ozon_accruals.py`/`db_pg`-соседний код) — контролёр следит за порядком.

---

### Task 1: Миграция 048 — справочники «город→ФО» и «кластер→ФО»

**Files:**
- Modify (уже создан, проверить и применить): `db/migrations/048_geo_reference.sql`

**Interfaces:**
- Produces: `shared.ru_geo_fo(name PK, fo)`, `shared.ozon_cluster_fo(cluster_name PK, fo)` — используются задачами 2–4.

- [ ] **Step 1: Прочитать файл целиком** (`db/migrations/048_geo_reference.sql`, ~230 строк) — он написан на этапе планирования и сверен скриптом с фактическим списком городов (все 338 имён с n≥2 замаплены, лишних нет). Проверить глазами структуру: две таблицы, идемпотентные `ON CONFLICT DO UPDATE`, GRANT'ы для saas_app/panel_local_ro/saas_ro.

- [ ] **Step 2: Применить**

Run: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f db/migrations/048_geo_reference.sql`
Expected: `BEGIN ... INSERT 0 338 ... INSERT 0 22 ... COMMIT` (числа: 338 городов, 22 кластера).

- [ ] **Step 3: Сверить покрытие на живых данных**

```bash
psql "host=localhost dbname=saas user=saas_ro" -X -c "
SELECT ROUND(100.0*COUNT(g.fo)/COUNT(*),1) AS mapped_pct_rows,
       ROUND(100.0*SUM(o.qty) FILTER (WHERE g.fo IS NOT NULL)/SUM(o.qty),1) AS mapped_pct_qty
FROM tenant.ozon_orders o LEFT JOIN shared.ru_geo_fo g ON g.name=o.region
WHERE o.region<>'';" -c "
SELECT COUNT(*) FROM shared.ozon_clusters oc LEFT JOIN shared.ozon_cluster_fo cf ON cf.cluster_name=oc.cluster_name WHERE cf.fo IS NULL;"
```
Expected: `mapped_pct_qty ≥ 90`; вторая проверка = 0 (все кластеры замаплены).

- [ ] **Step 4: Commit**

```bash
git add db/migrations/048_geo_reference.sql
git commit -m "feat(db): 048 — справочники локальности: город→ФО (338 имён, 93% заказов) и кластер Ozon→ФО"
```

---

### Task 2: lib/geoMetrics.js — гео-канон + вынос локальности WB из /stocks

**Files:**
- Create: `lib/geoMetrics.js`
- Modify: `app/api/cabinets/[id]/stocks/route.js:491-520` (шаг 2 `buildWarehouseEfficiency`)

**Interfaces:**
- Consumes: `DatabaseSync` из `@/lib/db.js` (шим `orders`/`sales` → таблицы МП, `shared.*` полным путём), справочники 026/047/048.
- Produces (все функции принимают `db` соответствующего МП и период `{from, to}` — `YYYY-MM-DD` включительно):
  - `wbGeoSummary(db, {from, to, scheme, nmId, brand, group, q})` → `{byRegion, byWarehouse}` (строки `{name, ordersRub, ordersQty, salesRub, salesQty}`)
  - `ozGeoSummary(db, {from, to, scheme, nmId, brand, group, q})` → то же
  - `wbSalesLocalityByWarehouse(db, {sinceDays})` → `[{warehouse, cluster, sales_qty, sales_rub, local_qty}]` — точный перенос шага 2 стоков
  - `wbOrdersLocalityMatrix(db, {from, to, scheme})` → `{rows: [{whCluster, buyerCluster, qty}], localPct, mappedPct}`
  - `ozOrdersLocalityMatrix(db, {from, to, scheme})` → `{rows: [{whFo, buyerFo, qty}], localPct, mappedPct}`
  - `wbSpeedByOkrug(db, {from, to})` → `[{okrug, scheme, medianDays, n}]`
  - `ozSpeedByFo(db, {from, to})` → `[{fo, medianDays, n}]`
  - `wbSupplyLagHours(db, {from, to})` → `{medianHours, n}`
  - `wbSpeedOverall(db, {from, to})` / `ozSpeedOverall(db, {from, to})` → `{medianDays, n}` (для KPI — та же выборка, без GROUP BY)
  - `wbFbsShare(db, {from, to})` / `ozFbsShare(db, {from, to})` → `{fbsQty, totalQty}`
  - `warehouseFuzzyLateral(col)` — SQL-фрагмент фаззи-мэтчинга имён складов (общий для sales/orders вариантов)

- [ ] **Step 1: Создать lib/geoMetrics.js — шапка и сводки**

```js
/**
 * lib/geoMetrics.js — канон вкладки «География» (спека 2026-08-28-geography-v2, §3).
 *
 * Правила:
 *  - штуки WB = COUNT(*) (строка заказа/продажи = 1 шт), Ozon = SUM(qty);
 *  - продажи Ozon из tenant.ozon_sales (после этапа 1 честные: реальный статус),
 *    выручка = SUM(revenue) — возвраты входят отрицательными;
 *  - схема: WB warehouse_type ('Склад WB'→fbo, 'Склад продавца'→fbs), Ozon scheme;
 *  - пустое гео-имя → 'Не указан', незамапленный ФО → 'Не определено';
 *  - скорость WB — ПРОКСИ «заказ → выкуп» по srid (даты доставки WB не отдаёт);
 *    скорость Ozon — точная order_dt → delivered_dt, только FBO (рФБС возит сам,
 *    последней мили в начислениях нет — delivered_dt пуст, поверено 05.09.2026);
 *  - shared.* пишется полным путём — convertSql его не переписывает.
 */
const EMPTY = "Не указан";
const UNMAPPED = "Не определено";

const WB_SCHEME_SQL = { fbo: "= 'Склад WB'", fbs: "= 'Склад продавца'" };

function wbSchemeCond(alias, scheme) {
  if (!scheme || scheme === "all") return "";
  return ` AND ${alias}.warehouse_type ${WB_SCHEME_SQL[scheme]}`;
}

function ozSchemeCond(alias, scheme) {
  if (!scheme || scheme === "all") return "";
  return ` AND ${alias}.scheme = '${scheme === "fbs" ? "fbs" : "fbo"}'`;
}
```

Дальше `wbGeoSummary`: четыре запроса (заказы/продажи × регион/склад) по образцу старого роута (`geography/route.js:72-129`), но с фиксами канона (решение плана, «одна цифра» со Сводкой — сторож задачи 4 сверяет РОВНО):
- заказы: `AND o.is_cancel = 0` (= `wbOrdersCount`; старая вкладка считала с отменами — это осознанное изменение, зафиксировать в контракте);
- продажи WB: `AND s.is_realization = 1` (только выкупы, S-строки; возвраты в гео-потоках не вычитаются);
- период через параметры `substr(o.order_dt,1,10) >= ? AND <= ?`, схема через `wbSchemeCond("o"|"s", scheme)`, прежние фильтры `nmId/brand/group/q` (4 LIKE) сохранить дословно. Сшивка заказов и продаж по имени:

```js
function zipGeo(orders, sales) {
  const m = new Map();
  for (const r of orders) m.set(r.name, { name: r.name, ordersRub: r.rub, ordersQty: r.qty, salesRub: 0, salesQty: 0 });
  for (const r of sales) {
    const row = m.get(r.name) || { name: r.name, ordersRub: 0, ordersQty: 0, salesRub: 0, salesQty: 0 };
    row.salesRub = r.rub; row.salesQty = r.qty;
    m.set(r.name, row);
  }
  return [...m.values()];
}
```

`ozGeoSummary` — заказы из `orders` с `AND o.is_cancel = 0` (`SUM(o.qty) qty, SUM(o.total) rub`, регион `COALESCE(NULLIF(o.region,''), 'Не указан')`, склад аналогично), продажи из `sales` с `AND s.is_return = 0` (только выкупы: `SUM(s.qty) qty, SUM(s.revenue) rub`) — у продаж нет гео-колонок, поэтому гео берётся JOIN-ом к заказу: `JOIN orders o ON o.posting_number = s.posting_number AND o.product_id = s.product_id` (гео постинга едино для заказа и продажи). Фильтры brand/group — через `LEFT JOIN products p` как в старом роуте.

- [ ] **Step 2: Вынос локальности WB (sales) и правка stocks**

В `geoMetrics.js`:

```js
/** Фаззи-мэтчинг имени склада WB на справочник shared.wb_warehouses.
 * Перенесён из stocks/route.js:496-520 (точный JOIN терял ~18% выручки:
 * «Самара (Новосемейкино)» vs «Новосемейкино»). ${col} — колонка имени склада. */
export function warehouseFuzzyLateral(col) {
  return `LEFT JOIN LATERAL (
    SELECT region FROM shared.wb_warehouses
    WHERE name = ${col}
       OR ${col} ILIKE '%' || name || '%'
       OR name ILIKE '%' || ${col} || '%'
    ORDER BY (name = ${col}) DESC, updated_at DESC
    LIMIT 1
  ) wh_l ON true`;
}

export function wbSalesLocalityByWarehouse(db, { sinceDays }) {
  /* Точный перенос шага 2 buildWarehouseEfficiency (stocks/route.js:496-520):
     та же семантика окна last_change_dt >= current_date - N, тот же двойной
     джойн rtc_ok/rtc_reg (СНГ-хвост), тот же LATERAL. Меняться может только
     синхронно со вкладкой «Склады». */
  return db.prepare(`
    SELECT s.warehouse_name AS warehouse,
           wh_l.region AS cluster,
           COUNT(*) AS "sales_qty",
           COALESCE(SUM(s.for_pay), 0) AS "sales_rub",
           COUNT(*) FILTER (
             WHERE COALESCE(rtc_ok.cluster, rtc_reg.cluster) = wh_l.region
           ) AS "local_qty"
    FROM sales s
    LEFT JOIN shared.region_to_cluster rtc_ok ON rtc_ok.region = s.okrug_name
    LEFT JOIN shared.region_to_cluster rtc_reg
      ON rtc_reg.region = s.region_name AND (s.okrug_name IS NULL OR s.okrug_name = '')
    ${warehouseFuzzyLateral("s.warehouse_name")}
    WHERE s.last_change_dt::date >= current_date - ?::int
      AND s.warehouse_name IS NOT NULL AND s.warehouse_name <> ''
    GROUP BY s.warehouse_name, wh_l.region
  `).all(sinceDays);
}
```

В `stocks/route.js`: импорт `import { wbSalesLocalityByWarehouse } from "@/lib/geoMetrics.js";`, тело шага 2 заменить на `const salesRows = wbSalesLocalityByWarehouse(db, { sinceDays: vel });` — переменные дальше используются как раньше. SQL-строку из роута удалить.

- [ ] **Step 3: Матрицы локальности по заказам**

```js
export function wbOrdersLocalityMatrix(db, { from, to, scheme } = {}) {
  const rows = db.prepare(`
    SELECT COALESCE(wh_l.region, '${UNMAPPED}') AS "whCluster",
           COALESCE(rtc_ok.cluster, rtc_reg.cluster, '${UNMAPPED}') AS "buyerCluster",
           COUNT(*) AS qty
    FROM orders o
    LEFT JOIN shared.region_to_cluster rtc_ok ON rtc_ok.region = o.okrug_name
    LEFT JOIN shared.region_to_cluster rtc_reg
      ON rtc_reg.region = o.region_name AND (o.okrug_name IS NULL OR o.okrug_name = '')
    ${warehouseFuzzyLateral("o.warehouse_name")}
    WHERE substr(o.order_dt,1,10) >= ? AND substr(o.order_dt,1,10) <= ?
      AND o.is_cancel = 0 AND o.warehouse_name <> ''${wbSchemeCond("o", scheme)}
    GROUP BY 1, 2
  `).all(from, to);
  return withLocalityTotals(rows, "whCluster", "buyerCluster");
}

export function ozOrdersLocalityMatrix(db, { from, to, scheme } = {}) {
  const rows = db.prepare(`
    SELECT COALESCE(cf.fo, '${UNMAPPED}') AS "whFo",
           COALESCE(g.fo, '${UNMAPPED}') AS "buyerFo",
           SUM(o.qty) AS qty
    FROM orders o
    LEFT JOIN shared.ozon_clusters oc ON oc.warehouse_id = o.warehouse_id
    LEFT JOIN shared.ozon_cluster_fo cf ON cf.cluster_name = oc.cluster_name
    LEFT JOIN shared.ru_geo_fo g ON g.name = o.region
    WHERE substr(o.order_dt,1,10) >= ? AND substr(o.order_dt,1,10) <= ?
      AND o.is_cancel = 0${ozSchemeCond("o", scheme)}
    GROUP BY 1, 2
  `).all(from, to);
  return withLocalityTotals(rows, "whFo", "buyerFo");
}

/** localPct: доля qty с совпадением сторон среди пар, где ОБЕ стороны определены;
 *  mappedPct: доля qty определённых пар среди всех. «Не определено» не прячем —
 *  оно уходит в матрицу отдельной строкой/колонкой. */
function withLocalityTotals(rows, whKey, buyerKey) {
  let total = 0, mapped = 0, local = 0;
  for (const r of rows) {
    const q = Number(r.qty) || 0;
    total += q;
    if (r[whKey] !== UNMAPPED && r[buyerKey] !== UNMAPPED) {
      mapped += q;
      if (r[whKey] === r[buyerKey]) local += q;
    }
  }
  const round1 = (x) => Math.round(x * 10) / 10;
  return { rows,
    localPct: mapped > 0 ? round1((local * 100) / mapped) : null,
    mappedPct: total > 0 ? round1((mapped * 100) / total) : null };
}
```

Заметка для ревьюера: у WB сопоставление на уровне 7 укрупнённых кластеров (Юг+СКФО слиты — так устроен `region_to_cluster`, см. 026), у Ozon — на уровне 8 ФО. Это осознанная асимметрия, в UI матрицы раздельные.

- [ ] **Step 4: Скорость и лаг СЦ**

```js
export function wbSpeedByOkrug(db, { from, to } = {}) {
  /* ПРОКСИ: заказ → выкуп (включает лежание на ПВЗ до выкупа). Окно по дате
     ВЫКУПА; выбросы >60 дней и отрицательные пары отсечены. Разрез по схеме
     склада заказа — «FBO vs FBS рядом» (спека §4.4). */
  return db.prepare(`
    SELECT COALESCE(NULLIF(s.okrug_name,''), '${EMPTY}') AS okrug,
           CASE WHEN o.warehouse_type = 'Склад продавца' THEN 'fbs' ELSE 'fbo' END AS scheme,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (substr(s.sale_dt,1,10)::date - substr(o.order_dt,1,10)::date)
           ) AS "medianDays",
           COUNT(*) AS n
    FROM sales s
    JOIN orders o ON o.srid = s.srid
    WHERE s.is_realization = 1
      AND substr(s.sale_dt,1,10) >= ? AND substr(s.sale_dt,1,10) <= ?
      AND (substr(s.sale_dt,1,10)::date - substr(o.order_dt,1,10)::date) BETWEEN 0 AND 60
    GROUP BY 1, 2
  `).all(from, to);
}

export function ozSpeedByFo(db, { from, to } = {}) {
  /* Точная скорость до выдачи: order_dt → delivered_dt (последняя миля из
     начислений, этап 1). Только FBO: у рФБС delivered_dt пуст (0/402 на 05.09). */
  return db.prepare(`
    SELECT COALESCE(g.fo, '${UNMAPPED}') AS fo,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (o.delivered_dt::date - substr(o.order_dt,1,10)::date)
           ) AS "medianDays",
           COUNT(*) AS n
    FROM orders o
    LEFT JOIN shared.ru_geo_fo g ON g.name = o.region
    WHERE o.delivered_dt IS NOT NULL
      AND o.delivered_dt >= ? AND o.delivered_dt <= ?
      AND (o.delivered_dt::date - substr(o.order_dt,1,10)::date) BETWEEN 0 AND 60
    GROUP BY 1
  `).all(from, to);
}

export function wbSpeedOverall(db, { from, to } = {}) {
  /* KPI-медиана по всей выборке (не среднее медиан по округам). */
  const r = db.prepare(`
    SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (substr(s.sale_dt,1,10)::date - substr(o.order_dt,1,10)::date)
           ) AS "medianDays", COUNT(*) AS n
    FROM sales s JOIN orders o ON o.srid = s.srid
    WHERE s.is_realization = 1
      AND substr(s.sale_dt,1,10) >= ? AND substr(s.sale_dt,1,10) <= ?
      AND (substr(s.sale_dt,1,10)::date - substr(o.order_dt,1,10)::date) BETWEEN 0 AND 60
  `).get(from, to);
  return { medianDays: r?.medianDays ?? null, n: r?.n ?? 0 };
}

export function ozSpeedOverall(db, { from, to } = {}) {
  const r = db.prepare(`
    SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (o.delivered_dt::date - substr(o.order_dt,1,10)::date)
           ) AS "medianDays", COUNT(*) AS n
    FROM orders o
    WHERE o.delivered_dt IS NOT NULL
      AND o.delivered_dt >= ? AND o.delivered_dt <= ?
      AND (o.delivered_dt::date - substr(o.order_dt,1,10)::date) BETWEEN 0 AND 60
  `).get(from, to);
  return { medianDays: r?.medianDays ?? null, n: r?.n ?? 0 };
}

export function wbFbsShare(db, { from, to } = {}) {
  const r = db.prepare(`
    SELECT COUNT(*) FILTER (WHERE warehouse_type = 'Склад продавца') AS "fbsQty",
           COUNT(*) AS "totalQty"
    FROM orders
    WHERE substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ? AND is_cancel = 0
  `).get(from, to);
  return { fbsQty: r?.fbsQty ?? 0, totalQty: r?.totalQty ?? 0 };
}

export function ozFbsShare(db, { from, to } = {}) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(qty) FILTER (WHERE scheme = 'fbs'), 0) AS "fbsQty",
           COALESCE(SUM(qty), 0) AS "totalQty"
    FROM orders
    WHERE substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ? AND is_cancel = 0
  `).get(from, to);
  return { fbsQty: r?.fbsQty ?? 0, totalQty: r?.totalQty ?? 0 };
}

export function wbSupplyLagHours(db, { from, to } = {}) {
  /* Лаг «закрыл поставку → принята на СЦ» по wb_supplies (закрытые в окне). */
  const r = db.prepare(`
    SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (scan_dt - closed_at)) / 3600.0
           ) AS "medianHours",
           COUNT(*) AS n
    FROM wb_supplies
    WHERE scan_dt IS NOT NULL AND closed_at IS NOT NULL
      AND closed_at::date >= ?::date AND closed_at::date <= ?::date
  `).get(from, to);
  return { medianHours: r?.medianHours ?? null, n: r?.n ?? 0 };
}
```

- [ ] **Step 5: Смоук lib-функций** (инлайн-скрипт с withTenant, кабинет 1, окно последних 30 дней по вчера)

```bash
cd /opt/agents/saas && node --input-type=module -e "
import { withTenant } from './lib/tenant.js';
import { DatabaseSync } from './lib/db.js';
import { defaultPeriod } from './lib/period.js';
import * as g from './lib/geoMetrics.js';
await withTenant(1, async () => {
  const wb = new DatabaseSync('wb'), oz = new DatabaseSync('ozon');
  const p = defaultPeriod(30);
  console.log('wbSummary regions:', g.wbGeoSummary(wb, p).byRegion.length);
  console.log('ozSummary regions:', g.ozGeoSummary(oz, p).byRegion.length);
  console.log('wbLocality:', JSON.stringify(g.wbOrdersLocalityMatrix(wb, p)).slice(0, 120));
  console.log('ozLocality:', JSON.stringify(g.ozOrdersLocalityMatrix(oz, p)).slice(0, 120));
  console.log('wbSpeed rows:', g.wbSpeedByOkrug(wb, p).length, 'ozSpeed rows:', g.ozSpeedByFo(oz, p).length);
  console.log('scLag:', g.wbSupplyLagHours(wb, p));
});
"
```
(Точный импорт withTenant сверить с `scripts/check-profit-canon.mjs` — там рабочий образец подключения канона.) Expected: ненулевые счётчики, `ozLocality.localPct` число, `mappedPct ≥ 85`.

- [ ] **Step 6: Смоук стоков — эффективность бит-в-бит**

Run: `curl -s "http://localhost:3000/api/cabinets/1/stocks?vel=7" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('warehouses:',j.efficiency.byWarehouse.length,'clusters:',j.efficiency.byCluster.length,'sample:',JSON.stringify(j.efficiency.byWarehouse[0]))})"`
(если веб не поднят локально — через `withTenant`-скрипт вызвать `buildWarehouseEfficiency` до/после правки и сравнить JSON). Expected: структура и числа не изменились относительно прод-ответа до правки (снять эталон ДО правки в файл scratchpad и сравнить `diff`).

- [ ] **Step 7: Commit**

```bash
git add lib/geoMetrics.js app/api/cabinets/[id]/stocks/route.js
git commit -m "feat(geo): lib/geoMetrics — гео-канон (сводки, локальность, скорость, лаг СЦ); локальность стоков вынесена в lib"
```

---

### Task 3: Гео-API v2

**Files:**
- Modify (переписать): `app/api/cabinets/[id]/geography/route.js`

**Interfaces:**
- Consumes: все функции Task 2, `defaultPeriod` из `lib/period.js`, `withCabinet`, `DatabaseSync`.
- Produces: формат ответа v2 из Global Constraints (потребляют задачи 5–6; сторож задачи 4 сверяет).

- [ ] **Step 1: Переписать роут**

Скелет (шапку-контракт с формой ответа — в комментарий файла, как в `orders/route.js:1-45`):

```js
export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mp = url.searchParams.get("mp") || "all";
  const scheme = url.searchParams.get("scheme") || "all";       // all | fbo | fbs
  const def = defaultPeriod(30);
  const from = url.searchParams.get("from") || def.from;
  const to = url.searchParams.get("to") || def.to;
  const filters = { scheme,
    nmId: url.searchParams.get("nm") || "", brand: url.searchParams.get("brand") || "",
    group: url.searchParams.get("group") || "", q: (url.searchParams.get("q") || "").trim() };

  // prev-окно ТЕМ ЖЕ кодом (паттерн products-summary:117-129)
  const N = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const prevTo = shiftDateUTC(from, -1);
  const prevFrom = shiftDateUTC(prevTo, -(N - 1));

  const cur = collectAll(mp, { from, to, ...filters });
  const prev = collectAll(mp, { from: prevFrom, to: prevTo, ...filters });

  return NextResponse.json({
    period: { from, to }, prevPeriod: { from: prevFrom, to: prevTo },
    kpi: cur.kpi, prevKpi: prev.kpi,
    byRegion: cur.byRegion, byWarehouse: cur.byWarehouse,
    locality: cur.locality, speed: cur.speed,
    facets: cur.facets,
  });
});
```

`collectAll(mp, opts)` — единственное место расчёта (и текущего, и prev):
- WB-часть (если mp∈{all,wb}): `wbGeoSummary`, `wbOrdersLocalityMatrix`, `wbSpeedByOkrug`, `wbSupplyLagHours`;
- Ozon-часть: `ozGeoSummary`, `ozOrdersLocalityMatrix`, `ozSpeedByFo`;
- `byRegion/byWarehouse` = `mergeByName(wb, ozon)` (перенести из старого роута), сортировка `ordersRub+salesRub` desc;
- KPI: 

```js
function buildKpi({ wbLoc, ozLoc, wbFast, ozFast, wbShare, ozShare, scLag }) {
  // Локальность: взвешенно по замапленным штукам обеих площадок (Σ local / Σ mapped
  // пересчитывается из rows матриц — та же формула, что в withLocalityTotals).
  const localPct = weightedLocalPct([wbLoc, ozLoc].filter(Boolean));
  const fbsQty = (wbShare?.fbsQty ?? 0) + (ozShare?.fbsQty ?? 0);
  const totalQty = (wbShare?.totalQty ?? 0) + (ozShare?.totalQty ?? 0);
  return {
    localPct,
    speedWbDays: wbFast?.medianDays ?? null,   // wbSpeedOverall (Task 2)
    speedOzDays: ozFast?.medianDays ?? null,   // ozSpeedOverall (Task 2)
    fbsSharePct: totalQty > 0 ? Math.round((fbsQty * 1000) / totalQty) / 10 : null,
    scLagHours: scLag?.medianHours ?? null,
  };
}

function weightedLocalPct(parts) {
  let local = 0, mapped = 0;
  for (const p of parts) for (const r of p.rows) {
    const q = Number(r.qty) || 0;
    const wh = r.whCluster ?? r.whFo, buyer = r.buyerCluster ?? r.buyerFo;
    if (wh !== "Не определено" && buyer !== "Не определено") {
      mapped += q;
      if (wh === buyer) local += q;
    }
  }
  return mapped > 0 ? Math.round((local * 1000) / mapped) / 10 : null;
}
```
- Фасеты: перенести `buildFacets` из старого роута, но ограничить окном (`substr(order_dt,1,10) BETWEEN from AND to`) — полный скан таблицы уходит; фасеты только для текущего окна (не prev).
- `mp=wb|ozon` — отсутствующая платформа в locality/speed отдаётся как `{ rows: [], localPct: null, mappedPct: null }` / `[]`.

- [ ] **Step 2: Смоук API** — Next-роут не импортируется в голом node, поэтому смоук повторяет `collectAll` на функциях geoMetrics (вынеси `collectAll` и `buildKpi` в сам роут-файл, а смоук пиши по образцу подключения из `scripts/check-profit-canon.mjs` — там рабочий `withTenant`+`DatabaseSync`). Скрипт (одноразовый, в scratchpad сессии, НЕ коммитить):

```js
// scratchpad/smoke-geo-api.mjs — прогон гео-канона в обоих режимах
import { withTenant } from "<путь как в check-profit-canon.mjs>";
import { DatabaseSync } from "../lib/db.js";
import { defaultPeriod } from "../lib/period.js";
import * as g from "../lib/geoMetrics.js";

for (const scheme of ["all", "fbs"]) {
  await withTenant(1, async () => {
    const wb = new DatabaseSync("wb"), oz = new DatabaseSync("ozon");
    const p = { ...defaultPeriod(30), scheme };
    const wbSum = g.wbGeoSummary(wb, p), ozSum = g.ozGeoSummary(oz, p);
    const wbLoc = g.wbOrdersLocalityMatrix(wb, p), ozLoc = g.ozOrdersLocalityMatrix(oz, p);
    console.log(`scheme=${scheme}: wbRegions=${wbSum.byRegion.length} ozRegions=${ozSum.byRegion.length}`,
      `wbLocal=${wbLoc.localPct}% (mapped ${wbLoc.mappedPct}%) ozLocal=${ozLoc.localPct}% (mapped ${ozLoc.mappedPct}%)`,
      `wbSpeed=${g.wbSpeedOverall(wb, p).medianDays} ozSpeed=${g.ozSpeedOverall(oz, p).medianDays}`,
      `scLag=${JSON.stringify(g.wbSupplyLagHours(wb, p))}`);
  });
}
```
Run: `node <scratchpad>/smoke-geo-api.mjs`
Expected: обе строки печатаются без исключений; числа не NaN; при `scheme=fbs` счётчики меньше, чем при all; `mappedPct ≥ 85` у Ozon.

- [ ] **Step 3: Commit**

```bash
git add app/api/cabinets/[id]/geography/route.js lib/geoMetrics.js
git commit -m "feat(geo): API v2 — канон, prev-окно, KPI, локальность, скорость, схема-фильтр"
```
(`lib/geoMetrics.js` в коммите — из-за добавленных в Step 1 `wbSpeedOverall/ozSpeedOverall/wbFbsShare/ozFbsShare`.)

---

### Task 4: Сторож «одна цифра везде» — scripts/check-geo-canon.mjs

**Files:**
- Create: `scripts/check-geo-canon.mjs`

**Interfaces:**
- Consumes: функции `lib/geoMetrics.js`, `pg.Pool` под `saas_ro` (образец: `scripts/check-profit-canon.mjs` — читать его шапку и подключение).

- [ ] **Step 1: Написать сторож** (структура по образцу `check-profit-canon.mjs`: канон через `withTenant`+`DatabaseSync`, эталон — независимый SQL под `saas_ro` с явным `cabinet_id`; параметры `--cabinet 1 --from ... --to ...`, дефолт — `defaultPeriod(30)`)

Проверки (все с допуском 0.01, FAIL → exit 1):
1. Σ `wbGeoSummary.byRegion.ordersQty` = SQL `SELECT COUNT(*) FROM tenant.wb_orders WHERE cabinet_id=$1 AND substr(order_dt,1,10) BETWEEN $2 AND $3` (и рубли = SUM(price_with_disc)).
2. То же для Ozon: Σ `ozGeoSummary.byRegion.ordersQty` = `SUM(qty)`, рубли = `SUM(total)`.
3. Σ по byRegion = Σ по byWarehouse (внутри каждой платформы, заказы и продажи).
4. Продажи Ozon: Σ `salesRub` = `SELECT SUM(revenue) FROM tenant.ozon_sales WHERE ... sale_dt BETWEEN ...` (честные продажи, не дубль заказов — регресс-ловушка на возврат старого бага).
5. Локальность: Σ qty матрицы WB (все ячейки) = COUNT незакансельных заказов WB окна с непустым складом; localPct пересчитан независимым SQL — совпадает.
6. Кросс-канонная: Σ `wbGeoSummary.byRegion.ordersQty` = `wbOrdersCount(db, {from, to})` из `lib/wbMetrics.js` РОВНО, и Σ `ozGeoSummary.byRegion.ordersQty` = `ozOrdersCount`-эквиваленту (`SUM(qty) WHERE is_cancel=0`). Сходится, потому что Task 2 сознательно считает заказы `is_cancel=0` — как канон Сводки (изменение против старой вкладки, зафиксировано в контракте Task 7).

- [ ] **Step 2: Прогнать**

Run: `node scripts/check-geo-canon.mjs --cabinet 1` затем `node scripts/check-geo-canon.mjs --cabinet 1008`
Expected: `ALL PASS` для обоих кабинетов. Любой FAIL — чинить канон/роут, не сторож.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-geo-canon.mjs
git commit -m "chore(scripts): сторож географии — одна цифра везде (сводки=канону, продажи Ozon честные, локальность сходится)"
```

---

### Task 5: UI — KPI-плашки и сводные графики (секции 1–2)

**Files:**
- Modify: `app/cabinets/[id]/geo/GeoPage.jsx`

**Interfaces:**
- Consumes: API v2 (форма из Global Constraints), `C`/`soft` из `@/lib/palette.js`.
- Produces: компоненты `KpiRow`, `Kpi`, `delta()` (локальные копии паттерна SummaryPage — в проекте нет общего kpi-компонента, копия по конвенции), сохранённые `ChartCard`/фильтры.

- [ ] **Step 1: Перестроить состояние и фильтры**

- Дефолт периода: убрать пресеты «от сегодня» (`:54-65`) — пресеты считают окно от `defaultPeriod`-вчера: `7 дней` = `defaultPeriod(7)`, `30 дней` = `defaultPeriod(30)` (скопировать функцию нельзя — она серверная; продублировать две строки вычисления от `Date.now()-864e5` с комментарием «по вчера, как lib/period.js»).
- Добавить фильтр схемы: `Seg` с opts `all|fbo|fbs` («Все схемы / FBO/FBW / FBS»), пробрасывается в qs `scheme=`.
- Тайтл-ярлыки вкладок оставить (`По округам`/`По городам`), дисклеймер `ozonNote` УДАЛИТЬ (продажи Ozon теперь честные) — вместо него однострочная подпись «Продажи Ozon — по дате выкупа, из начислений» в футере.

- [ ] **Step 2: KPI-ряд с дельтами**

Скопировать паттерн Сводки (`SummaryPage.jsx:835-855` Kpi, `:50-63` delta) в локальные компоненты файла:

```jsx
function delta(cur, prev, { pp = false } = {}) {
  if (cur == null || prev == null || !prev) return null;
  const d = pp ? cur - prev : ((cur - prev) / Math.abs(prev)) * 100;
  if (!isFinite(d) || Math.abs(d) < 0.05) return null;
  return { dir: d >= 0 ? "up" : "down", text: `${Math.abs(d).toFixed(1)}${pp ? " пп" : "%"}` };
}
```

Ряд: `gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10`, пять плашек:
1. «Локальность» — `kpi.localPct` %, дельта pp к `prevKpi.localPct`; цвет значения: ≥30 `C.pos`, ≥10 `C.warn`, иначе `C.neg` (пороги — конвенция стоков `locColor`).
2. «Скорость WB» — `kpi.speedWbDays` дн (`title`: «до выкупа — прокси, WB не отдаёт дату доставки»), дельта инвертирована (меньше = лучше: `dir` up при снижении → цвет `C.pos`; отдельный флаг `invert` в delta-вызове: передавать `delta(prev, cur)` с комментарием).
3. «Скорость Ozon» — `kpi.speedOzDays` дн («до выдачи, только FBO»).
4. «Доля FBS» — `kpi.fbsSharePct` %, дельта pp.
5. «Отгрузка на СЦ» — `kpi.scLagHours` ч (WB, медиана «закрыта→скан»).
`null` → прочерк «—» и подпись «копим данные» (`C.faint`).

- [ ] **Step 3: Секция регионов/складов** — существующие 4 `ChartCard` остаются (данные теперь из v2: `byRegion`/`byWarehouse` те же имена полей), карточку привести к канону острова (`borderRadius: 10`).

- [ ] **Step 4: Смоук-линт** (build — только в финальной задаче 7)

Run: `cd /opt/agents/saas && npx next lint --file app/cabinets/[id]/geo/GeoPage.jsx`
Expected: 0 errors (warnings допустимы, если были до правки).

- [ ] **Step 5: Commit**

```bash
git add app/cabinets/[id]/geo/GeoPage.jsx
git commit -m "feat(geo-ui): KPI-плашки с дельтами, фильтр схемы, окна по вчера, честные продажи Ozon"
```

---

### Task 6: UI — матрица локальности и скорость (секции 3–4)

**Files:**
- Modify: `app/cabinets/[id]/geo/GeoPage.jsx`

**Interfaces:**
- Consumes: `locality`, `speed` из API v2; `C`, `soft` из palette.

- [ ] **Step 1: Матрица локальности** — компонент `LocalityMatrix({ title, rows, whKey, buyerKey, localPct, mappedPct, note })`:

- Оси: строки = кластер/ФО склада, колонки = кластер/ФО покупателя (уникальные значения rows, «Не определено» последним). Ячейка: qty; фон-интенсивность `soft("accent", clamp(qty/max*60, 4, 60))`; диагональ (совпадение) — рамка `1px solid ${C.pos}`.
- Шапка: `title` + бейджи `лок. {localPct}%` (цвет по порогам 30/10) и `замаплено {mappedPct}%` (если <85 — `C.warn` с title «часть городов не распознана — хвост справочника 048»).
- Рендер: обычная `<table>` со `sticky` первой колонкой, шрифт 12, tabular-nums, горизонтальный скролл в контейнере.
- Две матрицы: WB (`whCluster`×`buyerCluster`, note «7 укрупнённых кластеров WB: Юг+Кавказ и Сибирь+ДВ слиты — так устроена карта WB») и Ozon (`whFo`×`buyerFo`). При mp-фильтре — только соответствующая. Пустые rows → остров с «Копим данные с 28.08 — вернитесь позже» (`C.faint`).

- [ ] **Step 2: Скорость** — компонент `SpeedTable`:

- WB: таблица округ × две колонки-схемы (fbo/fbs медианы из `speed.wb`, группировка по okrug на клиенте), разница fbs−fbo подсвечивается: >+1 дня `C.neg`, иначе `C.faint`; подпись «до выкупа (прокси): включает время на ПВЗ до выкупа».
- Ozon: таблица ФО × медиана (только FBO), подпись «до выдачи, по начислениям последней мили; FBS (рФБС) возится продавцом — данных о доставке нет».
- Строки с `n < 5` — значение серым `C.faint` с title «мало данных (n={n})».

- [ ] **Step 3: Смоук** — `npx next lint --file app/cabinets/[id]/geo/GeoPage.jsx`: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/cabinets/[id]/geo/GeoPage.jsx
git commit -m "feat(geo-ui): матрица локальности склад→покупатель и скорость FBO vs FBS"
```

---

### Task 7: Контракт, сборка, деплой, приёмка

**Files:**
- Modify: `docs/metrics-contract.md` (новый раздел «География»)

- [ ] **Step 1: Дописать контракт** — раздел «География» в `docs/metrics-contract.md` (после последнего раздела, стиль соседних): определения — заказы `is_cancel=0` (= канону Сводки), продажи Ozon из `ozon_sales` по реальному статусу, локальность (формула localPct/mappedPct, асимметрия WB-кластеры/Ozon-ФО), скорость WB-прокси vs Ozon-точная (только FBO), лаг СЦ; классы окон «по вчера»; ссылка на сторож `scripts/check-geo-canon.mjs`.

- [ ] **Step 2: Собрать и перезапустить веб**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 5 && curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health || curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/`
Expected: build без ошибок, HTTP 200.

- [ ] **Step 3: Приёмочные прогоны**

1. `node scripts/check-geo-canon.mjs --cabinet 1` и `--cabinet 1008` → ALL PASS.
2. `node scripts/check-profit-canon-cross.mjs` → PASS (регресс канона прибыли: география его не трогала, но stocks-правка Task 2 могла).
3. `psql ... -f scripts/check-geo-foundation.sql` → 4/4 ok (фундамент жив).
4. `curl -s "http://localhost:3000/api/cabinets/1/geography?mp=all" | head -c 400` — валидный JSON формата v2 (потребует cookie-авторизации — тогда через смоук-скрипт scratchpad из Task 3 повторно).

- [ ] **Step 4: Commit + отчёт владельцу**

```bash
git add docs/metrics-contract.md
git commit -m "docs(contract): раздел «География» — определения локальности, скорости, окон"
```
Финальное сообщение владельцу: что смотреть на вкладке, что значат KPI, где прокси/пробелы (FBS Ozon без скорости), просьба живой приёмки.

---

### Task 8: Честность «Сводки по товарам» (обещание владельцу 05.09)

**Files:**
- Modify: `app/api/cabinets/[id]/products-summary/route.js` (totals уже канонные — добавить разбивку нераспределённого)
- Modify: `app/cabinets/[id]/products-summary/*.jsx` (компонент страницы — точное имя найти на месте)

Контекст-инцидент: 05.09 владелец увидел в итогах «−16 663» при плюсовых строках — это была реклама Ozon кабинета, не разнесённая по товарам (per-SKU отчёт дозревает с лагом). Итог был прав, но анонимен. Правило: расхождение «итог ≠ Σ строк» никогда не молчит.

- [ ] **Step 1: API** — в ответ добавить `unallocated: { ads, cabinetCosts, note }`: `ads` = ads(кабинет) − Σ ads(товар) за окно (обе платформы суммарно), `cabinetCosts` = Σ cabinetCosts.amount, `note` = 'per-SKU реклама Ozon дозревает' если ozon_daily_sku_ad за последние 2 дня окна пуст при ненулевой ozon_daily_campaign_ad. Числа уже считаются внутри buildTotals-потока — только вынести в ответ, ничего не пересчитывать заново.
- [ ] **Step 2: UI** — под строкой «Итого» вторая строка: «Не разнесено по товарам: реклама X ₽ · кабинетные Y ₽» (+ значок ⚠ с note, цвет C.warn при note). Сумма строк товаров + нераспределённое = канонный итог — теперь это видно глазами.
- [ ] **Step 3: Смоук** — окно за вчера: `unallocated.ads` > 0 пока per-SKU пуст; после дособора вечером → около 0. Прогнать `node scripts/check-profit-canon.mjs --cabinet 1` (итоги не изменились — только представление).
- [ ] **Step 4: Commit** — `git add` двух файлов, сообщение по-русски.

---

## Вне рамок (бэклог этапа 3)

- Секция «FBS-отгрузки» (список поставок WB со стадиями и выбросами) — этап 3 по спеке.
- rFBS-даты доставки (delivery_date_begin), потолок offset 20000 fbs-пагинации, сервисные префиксы юнитов — бэклог этапа 1 (в памяти).
- Пополнение справочника 048 хвостом городов (n=1) — по сторожу mappedPct.
- Дозревание Ozon-прибыли в Сводке (бейдж «данные дозревают» на последних 2-3 днях) — отдельное улучшение после жалобы 05.09, обсудить с владельцем.
