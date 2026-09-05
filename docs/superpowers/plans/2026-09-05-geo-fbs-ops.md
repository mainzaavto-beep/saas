# География 2.0 — этап 3 «FBS-операционка»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Спека:** `docs/superpowers/specs/2026-08-28-geography-v2-design.md` (этап 3 из 3 — секция 5: «поставки WB со стадиями создана→закрыта→принята СЦ, выбросы подсвечены»; этапы 1-2 задеплоены).

**Goal:** Секция «FBS-отгрузки» на вкладке География: список поставок WB со стадиями и лагами, висящие без приёмки подсвечены.

**Architecture:** Одна новая канон-функция `wbSuppliesOps` в `lib/geoMetrics.js` (таблица `tenant.wb_supplies` этапа 1 уже наполняется main-тиком); поле `supplies` в ответе гео-API v2 (только WB, только текущее окно); секция 5 в `GeoPage.jsx` по конвенциям секций 3-4; одна новая проверка в стороже.

**Tech Stack:** как этап 2 (Next.js, PG, lib-канон, сторож mjs).

## Global Constraints

- Всё как в плане этапа 2 (`2026-09-05-geo-canon-vitrina.md`): русский язык, явный `git add`, прод=master, чтение saas_ro / запись PGPASSFILE-админ, ESLint нет → SWC-парсинг, деплой `npm run build && systemctl restart saas-web` только в финальной задаче, сторожа не подгонять.
- Границы этапа: только WB-поставки (Ozon FBS-отгрузка — в бэклог: 0 FBS-заказов Ozon за последний месяц); алерты-нотификации — вне рамок (SMTP не настроен, ждёт владельца) — «алертом» служит подсветка и счётчик в UI.
- Факты из живых данных (05.09, кабинет 1, не перепроверять): 120 поставок, 78 со сканом, **42 закрытых без scan_dt** (включая давние 27-28.08) — WB проставляет скан не для всех типов приёмки (есть `isPickupPointShipmentAllowed`); поэтому «висящей» считается ТОЛЬКО свежая поставка: `done AND scan_dt IS NULL AND closed_at > now()-14d AND closed_at < now()-3d` (старше 14 дней — считаем «без отметки», это исторический хвост, не тревога). Медианы: сборка 0.3ч, до СЦ 9.2ч, p90 27.3ч. `reject_dt` пока всегда NULL. Имя направления берётся из `name` поставки («Поставка Казань от …»), справочник офисов по `destination_office_id` НЕ заводим (YAGNI).
- Контракт поля `supplies` ответа гео-API (задачи 1-3 синхронно):

```js
supplies: {                      // null при mp=ozon или отсутствии WB у кабинета
  rows: [{ supplyId, name, createdAt, closedAt, scanDt, done,
           buildHours, scHours,            // null если стадия не наступила
           status }],                       // 'scanned' | 'stuck' | 'no_scan_old' | 'awaiting'
  medianBuildHours, medianScHours, p90ScHours,   // по окну; null при пустоте
  stuckCount, noScanOldCount, total }
```

## Карта файлов

| Файл | Что происходит |
|---|---|
| `lib/geoMetrics.js` | + `wbSuppliesOps(db, {from,to})` |
| `app/api/cabinets/[id]/geography/route.js` | + `supplies` в collectAll (только wantWb, не для kpiOnly) |
| `app/cabinets/[id]/geo/GeoPage.jsx` | + секция 5 `SuppliesSection` |
| `scripts/check-geo-canon.mjs` | + проверка 7 (Σ и медиана поставок против независимого SQL) |
| `docs/metrics-contract.md` | §16 дополнение «FBS-отгрузки» |

---

### Task 1: Канон wbSuppliesOps + сторож

**Files:**
- Modify: `lib/geoMetrics.js` (в конец, рядом с `wbSupplyLagHours`)
- Modify: `scripts/check-geo-canon.mjs` (новая проверка 7)

**Interfaces:**
- Consumes: `tenant.wb_supplies` (миграция 047), явный путь (таблицы нет в маппинге convertSql — как в `wbSupplyLagHours`).
- Produces: `wbSuppliesOps(db, {from, to})` → объект контракта `supplies` из Global Constraints.

- [ ] **Step 1: Функция в lib/geoMetrics.js**

```js
/** Порог «висящей» поставки: закрыта, скана нет, прошло 3-14 дней.
 * Старше 14 дней — «без отметки» (WB проставляет скан не для всех типов
 * приёмки, исторический хвост 42/120 на 05.09.2026 — это НЕ тревога). */
const SUPPLY_STUCK_MIN_DAYS = 3;
const SUPPLY_STUCK_MAX_DAYS = 14;

export async function wbSuppliesOps(db, { from, to } = {}) {
  const rows = await db.prepare(`
    SELECT supply_id AS "supplyId", name,
           created_at::text AS "createdAt", closed_at::text AS "closedAt",
           scan_dt::text AS "scanDt", done,
           ROUND((EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600.0)::numeric, 1) AS "buildHours",
           ROUND((EXTRACT(EPOCH FROM (scan_dt - closed_at)) / 3600.0)::numeric, 1) AS "scHours",
           CASE
             WHEN scan_dt IS NOT NULL THEN 'scanned'
             WHEN done AND closed_at < now() - interval '${SUPPLY_STUCK_MAX_DAYS} days' THEN 'no_scan_old'
             WHEN done AND closed_at < now() - interval '${SUPPLY_STUCK_MIN_DAYS} days' THEN 'stuck'
             ELSE 'awaiting'
           END AS status
    FROM tenant.wb_supplies
    WHERE closed_at IS NOT NULL
      AND closed_at::date >= ?::date AND closed_at::date <= ?::date
    ORDER BY closed_at DESC
  `).all(from, to);
  const scanned = rows.filter((r) => r.scHours != null).map((r) => Number(r.scHours)).sort((a, b) => a - b);
  const q = (p) => scanned.length ? scanned[Math.min(scanned.length - 1, Math.floor(p * (scanned.length - 1) + 0.5))] : null;
  const builds = rows.filter((r) => r.buildHours != null).map((r) => Number(r.buildHours)).sort((a, b) => a - b);
  const qb = (p) => builds.length ? builds[Math.min(builds.length - 1, Math.floor(p * (builds.length - 1) + 0.5))] : null;
  return {
    rows,
    medianBuildHours: qb(0.5), medianScHours: q(0.5), p90ScHours: q(0.9),
    stuckCount: rows.filter((r) => r.status === "stuck").length,
    noScanOldCount: rows.filter((r) => r.status === "no_scan_old").length,
    total: rows.length,
  };
}
```
(Медианы на JS по уже выбранным строкам — выборка мала (сотни), отдельный SQL не нужен; интервалы в SQL — из констант через шаблон, значения числовые константы файла, не пользовательский ввод.)

- [ ] **Step 2: Проверка 7 в сторож** — по образцу существующих: канон `wbSuppliesOps` через withTenant против независимого SQL под saas_ro: (а) `total` = `SELECT COUNT(*) FROM tenant.wb_supplies WHERE cabinet_id=$1 AND closed_at IS NOT NULL AND closed_at::date BETWEEN $2 AND $3`; (б) `medianScHours` = `percentile_cont(0.5)` тем же условием `scan_dt IS NOT NULL` (допуск 0.1 ч — JS-медиана против percentile_cont может дать полшага на чётных выборках, зафиксировать комментарием); (в) `stuckCount` = независимый COUNT с тем же CASE-условием. Кабинет без WB-данных в окне → все null/0 с обеих сторон = PASS.

- [ ] **Step 3: Смоук** — node-скрипт через withTenant (образец в стороже): вызвать `wbSuppliesOps(wb, defaultPeriod(30))`, напечатать total/медианы/stuck. Expected: total > 0, медианы близки к фактам (сборка ~0.3ч, СЦ ~9ч), stuckCount мал (свежие висящие), noScanOldCount — хвост. Затем `node scripts/check-geo-canon.mjs --cabinet 1` и `--cabinet 1008` → ALL PASS (включая новую проверку 7).

- [ ] **Step 4: Commit** — `git add lib/geoMetrics.js scripts/check-geo-canon.mjs`, «feat(geo): канон FBS-отгрузок — wbSuppliesOps + проверка 7 сторожа».

---

### Task 2: supplies в гео-API

**Files:**
- Modify: `app/api/cabinets/[id]/geography/route.js`

**Interfaces:**
- Consumes: `wbSuppliesOps` (Task 1), существующий `collectAll({wantWb, wantOz}, opts)`.
- Produces: поле `supplies` в ответе (контракт из Global Constraints), только при `wantWb` и только для текущего окна (`kpiOnly` его не считает); при `!wantWb` → `null`.

- [ ] **Step 1: Правка collectAll** — рядом с locality/speed: `const supplies = wantWb && !opts.kpiOnly ? await wbSuppliesOps(wbDb, { from, to }) : null;` и поле в возврате + в NextResponse. Обновить шапку-контракт файла (форма v2 + supplies).
- [ ] **Step 2: Смоук** — scratchpad-скрипт (как smoke-geo-api.mjs): mp=all → supplies.total>0; mp=ozon → supplies===null. SWC-парсинг файла.
- [ ] **Step 3: Commit** — «feat(geo): supplies в API v2 — поставки WB со стадиями».

---

### Task 3: UI секция 5 «FBS-отгрузки»

**Files:**
- Modify: `app/cabinets/[id]/geo/GeoPage.jsx`

**Interfaces:**
- Consumes: `data.supplies` контракта; палитра C/soft; конвенции секций 3-4 (остров, tabular-nums, пустые состояния).

- [ ] **Step 1: Компонент SuppliesSection({ supplies })** — под секцией скорости; при `supplies === null` не рендерится (mp=ozon); при `total === 0` — остров «Поставок в выбранном окне нет».
  - Мини-KPI-строка: «сборка Xч · до СЦ Yч (p90 Zч) · висят без приёмки N⚠ · без отметки (старые) M».
  - Таблица: Название | Создана | Закрыта | Принята СЦ | Сборка, ч | До СЦ, ч. Дата-колонки через substr(...,1,16) с заменой T на пробел; «Принята СЦ» для status≠scanned — бейдж: `stuck` → «нет приёмки, Nд» цветом C.neg (N = дней от closedAt), `no_scan_old` → «без отметки» C.faint, `awaiting` → «—» C.faint.
  - Подсветка scHours > p90ScHours → значение C.warn.
  - Примечание под таблицей (C.faint, 11px): «WB проставляет отметку приёмки не для всех типов сдачи (например, через ПВЗ) — «без отметки» не значит «потеряна»; тревога — только свежие поставки без приёмки 3-14 дней.»
- [ ] **Step 2: Смоук** — SWC-парсинг файла.
- [ ] **Step 3: Commit** — «feat(geo-ui): секция FBS-отгрузки — стадии поставок, висящие подсвечены».

---

### Task 4: Контракт, деплой, приёмка

**Files:**
- Modify: `docs/metrics-contract.md` (§16, подраздел «FBS-отгрузки»)

- [ ] **Step 1: Контракт** — дополнить §16: определения buildHours/scHours, статусы (scanned/stuck 3-14д/no_scan_old >14д/awaiting), факт «WB не всегда проставляет скан» с числами 42/120 от 05.09.2026, ссылки на wbSuppliesOps и проверку 7 сторожа; медиана JS против percentile_cont — допуск 0.1 ч.
- [ ] **Step 2: Деплой** — `npm run build && systemctl restart saas-web`; health `curl -s -o /dev/null -w "%{http_code}" http://localhost:3200/` → 200.
- [ ] **Step 3: Приёмка** — `node scripts/check-geo-canon.mjs --cabinet 1` и `--cabinet 1008` → ALL PASS; `psql saas_ro -f scripts/check-geo-foundation.sql` → 4/4.
- [ ] **Step 4: Commit + отчёт владельцу** — `git add docs/metrics-contract.md`; финальное сообщение: что смотреть, что значит «без отметки», просьба живой приёмки.

## Вне рамок (бэклог)

- Ozon FBS-отгрузка (лаг in_process→shipment_dt) — при возобновлении FBS-продаж Ozon.
- Почтовые/телеграм-алерты о висящих поставках — после настройки SMTP владельцем.
- Справочник СЦ по destination_office_id (имена офисов) — если name поставки перестанет хватать.
