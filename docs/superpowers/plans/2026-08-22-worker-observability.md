# Наблюдаемость воркера — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец видит падения воркера баннером в панели, клиент видит устаревание данных, журнал прогонов содержит фактические rows/окна, перманентно битые ключи перестают шуметь ложными `failed`.

**Architecture:** Миграция 044 (колонки eff-окна + статус `blocked` + состояние `disabled`) → маркер `##OBS` в сборщиках + парсер в оркестраторе → чистая функция классификации алертов + роут `/api/ops/alerts` + баннеры в layout → доработка `shop_auth`/`notify-broken-keys`/PUT-роута ключей.

**Tech Stack:** Python (worker), PostgreSQL, Next.js (SSR-layout, API-роуты), Node-скрипты.

**Спека:** `docs/superpowers/specs/2026-08-21-worker-observability-design.md` (одобрена владельцем, 8bc2499).

## Global Constraints

- Правки сборщиков/оркестратора = мгновенный деплой (плановые тики 05:15/09:00/12:00/17:00 MSK подхватят файл) — маркер `##OBS` аддитивен, человеческие строки вывода НЕ менять и НЕ удалять.
- Панель деплоится ТОЛЬКО `npm run build && systemctl restart saas-web`; НИКОГДА `next dev`.
- БД читать `saas_ro` (`psql -h localhost -U saas_ro -d saas`, BYPASSRLS → явный `WHERE cabinet_id`); запись — только миграция 044 (`PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`).
- Тексты баннеров/комментариев — по-русски. Клиентский баннер — без технических деталей.
- `jobs.collector_runs` — без RLS: доступ из панели только через ops-allowlist (`SAAS_OPS_USER_IDS`, паттерн `app/api/health/route.js:11-24`).
- Сторожа после каждой задачи: `node scripts/check-profit-canon.mjs` (кабинеты 1, 1008) и `node scripts/profit-snapshot.mjs --verify` — ALL PASS (эта работа не должна трогать цифры вообще).
- Живой критерий приёмки (спека): кабинет 1009 (магазин 5, `paused`, fail_count=15, ежедневно 6 ложных `failed`-строк: ozon_accruals/catalog/finance/metrics/orders/sales) — после внедрения ложные `failed` исчезают из журнала, магазин уходит в `disabled`.
- Расхождение цифр = наш баг (AGENTS.md).

---

### Task 1: Миграция 044 — eff-окно, статус blocked, состояние disabled

**Files:**
- Create: `db/migrations/044_observability.sql`

**Interfaces:**
- Produces: `jobs.collector_runs.eff_date_from/eff_date_to DATE`; CHECK `status` дополнен `'blocked'`; CHECK `auth.shops.auth_state` дополнен `'disabled'`.

- [ ] **Step 1: Узнать фактические имена CHECK-констрейнтов** (могут отличаться от авто-имён):

Run: `psql -h localhost -U saas_ro -d saas -Atc "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN ('jobs.collector_runs'::regclass,'auth.shops'::regclass) AND contype='c'"`

- [ ] **Step 2: Написать миграцию** (имена констрейнтов подставить из Step 1):

```sql
-- 044: наблюдаемость воркера (спека 2026-08-21, одобрена владельцем).
-- 1) eff_date_from/eff_date_to — ФАКТИЧЕСКОЕ окно прогона сборщика из
--    ##OBS-маркера stdout (date_from/date_to остаются CLI-окном «что просили»);
-- 2) статус 'blocked' в jobs.collector_runs — контрольные попытки паузы ключей
--    больше не пишутся как failed (шум, неотличимый от реальных сбоев);
-- 3) auth_state 'disabled' — перманентно битые ключи: после
--    SAAS_AUTH_DISABLE_AFTER суточных контрольных отказов попытки прекращаются.
-- Идемпотентна (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS + ADD).
BEGIN;

ALTER TABLE jobs.collector_runs ADD COLUMN IF NOT EXISTS eff_date_from DATE;
ALTER TABLE jobs.collector_runs ADD COLUMN IF NOT EXISTS eff_date_to DATE;

ALTER TABLE jobs.collector_runs DROP CONSTRAINT IF EXISTS collector_runs_status_check;
ALTER TABLE jobs.collector_runs ADD CONSTRAINT collector_runs_status_check
    CHECK (status IN ('ok','partial','failed','timeout','no_token','skipped','blocked'));

ALTER TABLE auth.shops DROP CONSTRAINT IF EXISTS shops_auth_state_check;
ALTER TABLE auth.shops ADD CONSTRAINT shops_auth_state_check
    CHECK (auth_state IN ('ok','failing','paused','disabled'));

COMMIT;
```

- [ ] **Step 3: Применить**: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f db/migrations/044_observability.sql` → COMMIT.

- [ ] **Step 4: Проверить** под saas_ro: обе новые колонки в `information_schema.columns`; `pg_get_constraintdef` обоих CHECK содержит `blocked`/`disabled`.

- [ ] **Step 5: Commit**: `git add db/migrations/044_observability.sql && git commit -m "feat(db): наблюдаемость — eff-окно прогона, статус blocked, состояние disabled (044)"`

---

### Task 2: Оркестратор — парсер ##OBS + запись rows/eff-окна (+2 пилотных сборщика)

**Files:**
- Modify: `worker/orchestrator.py` (`_record_run` :92-108; ветки классификации в `_run_one` :438-485)
- Modify: `worker/collectors/ozon_accruals.py` (финальная печать ~:327), `worker/collectors/wb_finance.py` (~:117)

**Interfaces:**
- Produces: стандарт маркера — строка stdout `##OBS rows=<N>` или `##OBS rows=<N> from=<YYYY-MM-DD> to=<YYYY-MM-DD>` (последний маркер в выводе побеждает); `_record_run(..., rows_written=None, eff_date_from=None, eff_date_to=None)`; отсутствие маркера → NULL-поля, НЕ ошибка.

- [ ] **Step 1: Парсер в orchestrator.py** (модульная функция рядом с `_record_run`; `import re` уже есть — проверить):

```python
_OBS_RE_ROWS = re.compile(r"\brows=(\d+)")
_OBS_RE_FROM = re.compile(r"\bfrom=(\d{4}-\d{2}-\d{2})")
_OBS_RE_TO = re.compile(r"\bto=(\d{4}-\d{2}-\d{2})")


def _parse_obs(stdout_text):
    """##OBS-маркер сборщика (спека наблюдаемости, компонент 3): последняя
    строка вида '##OBS rows=N [from=D to=D]' из stdout. Маркера нет (старый/
    сторонний сборщик) → (None, None, None) — это не ошибка."""
    rows = eff_from = eff_to = None
    for line in (stdout_text or "").splitlines():
        line = line.strip()
        if not line.startswith("##OBS"):
            continue
        m = _OBS_RE_ROWS.search(line)
        rows = int(m.group(1)) if m else None
        mf = _OBS_RE_FROM.search(line)
        mt = _OBS_RE_TO.search(line)
        eff_from = mf.group(1) if mf else None
        eff_to = mt.group(1) if mt else None
    return rows, eff_from, eff_to
```

- [ ] **Step 2: `_record_run`** — добавить именованные параметры `rows_written=None, eff_date_from=None, eff_date_to=None`, включить все три в INSERT (9 → 12 колонок). Сигнатуру вызовов БЕЗ этих параметров не трогать (default None).

- [ ] **Step 3: `_run_one`** — сразу после `r = subprocess.run(...)` (:438): `obs_rows, obs_from, obs_to = _parse_obs(r.stdout)`; передать их в `_record_run` веток ok (:445), partial (:453) и failed (:463) (у failed stdout тоже бывает с маркером — сборщик мог напечатать его до падения; это честные данные). В ветки timeout/skipped НЕ передавать.

- [ ] **Step 4: `_record_run` должен вернуть id** (`RETURNING id`, `cur.fetchone()`), возврат `None` при ошибке записи — понадобится задаче 6. Все существующие вызовы возврат игнорируют — совместимо.

- [ ] **Step 5: Пилотные маркеры.** `ozon_accruals.py` — рядом с финальной печатью (:327, там уже есть `дней N, строк N, записано N` и фактическое окно из `resolve_window`) добавить:
```python
print(f"##OBS rows={written} from={since_s} to={to_s}", flush=True)
```
(имена переменных взять по месту — фактические из кода вокруг :283-:327). `wb_finance.py` — аналогично у `:117` (`записано N строк`, окно `start,end`). Человеческие строки не трогать.

- [ ] **Step 6: Проверка**: `python3 -m py_compile worker/orchestrator.py worker/collectors/ozon_accruals.py worker/collectors/wb_finance.py`; юнит-прогон парсера: `python3 -c` с 4 кейсами (маркер с датами; только rows; нет маркера; два маркера — последний побеждает) через `assert`.

- [ ] **Step 7: Commit**: `git add -A && git commit -m "feat(worker): ##OBS-маркер — rows_written и фактическое окно в журнале прогонов"`

---

### Task 3: Маркер ##OBS во все сборщики с записью

**Files:** Modify (по таблице разведки — счётная строка уже есть, добавить маркер рядом; номер строки — ориентир, искать по тексту печати):

| Файл | Возле строки | rows из | from/to |
|---|---|---|---|
| ozon_catalog.py | :174 «записано N товаров» | тот же счётчик | нет (snapshot) |
| ozon_finance.py | :156 «операций N, записано N» | записано | since/to :82 |
| ozon_metrics.py | :80 «записано N метрик» | тот же | since/to :19 |
| ozon_order_costs.py | :1031 «отправлений N (записано N)…» | сумма обоих «записано» | окно resolve_window :739 |
| ozon_orders.py | :109 «отправлений N, записано N» | записано | окно resolve_window :46 |
| ozon_prices.py | :75 «записано N из N» | записано | нет |
| ozon_sales.py | :79 «…записано N» | записано | since/to из argv |
| ozon_sku_ad.py | :267 «записано строк N…» | записано строк | since_s/to_s |
| ozon_stocks.py | :66 «записано N строк» | тот же | нет |
| ozon_efficiency.py | :222 (счётной строки нет) | `n_sales` из collect() | since/to :209 |
| wb_ads.py | :205 «строк daily_ad: N» | тот же | start/end :162 |
| wb_cabinet_costs.py | :111 «записано N строк» | тот же | start/end :100 |
| wb_catalog.py | :81 «собрано N артикулов» | тот же | нет |
| wb_metrics.py | :105 «записано N метрик за {ds}» | тот же | from=to=ds |
| wb_metrics_30m.py | :127 «записано N снапшотов…» | записано | нет |
| wb_order_costs.py | :183 «записано N строк» | тот же | start/end :174 |
| wb_orders.py | :93 «orders +N, sales +N» | сумма обоих | start/end :60 |
| wb_prices.py | :106 «записано N цен» | тот же | нет |
| wb_references.py | :175/:202 | сумма складов+направлений | нет |
| wb_stocks.py | :184 «записано N строк» | тот же | нет |

- [ ] **Step 1:** В каждый файл — ровно одна строка `print(f"##OBS rows={...}" ...)` с from/to по таблице (формат дат `YYYY-MM-DD`; если переменная окна — datetime, взять `.strftime("%Y-%m-%d")`; если строка длиннее 10 символов — `[:10]`). Имена переменных сверять ПО МЕСТУ (таблица — ориентир, не копипаста). wb_jem не трогать (отключён).
- [ ] **Step 2:** `python3 -m py_compile worker/collectors/*.py` → чисто.
- [ ] **Step 3:** Дождаться/спровоцировать ближайший плановый тик НЕ нужно — проверка придёт в задаче 7 по журналу. Commit: `git add worker/collectors && git commit -m "feat(worker): ##OBS-маркер во всех сборщиках с записью"`

---

### Task 4: Операторский баннер — lib/opsAlerts.js + /api/ops/alerts + плашка

**Files:**
- Create: `lib/opsAlerts.js` (чистая функция классификации), `scripts/test-ops-alerts.mjs` (фикстурный тест), `app/api/ops/alerts/route.js`, `app/OpsAlertsBanner.jsx`
- Modify: `app/layout.js` (корневой — плашка поверх всех страниц), `app/cabinets/[id]/layout.js:172-174` (ложный комментарий)

**Interfaces:**
- Consumes: `isOps`-паттерн `app/api/health/route.js:11-24`; `jobs.collector_runs` (+ `blocked` из задачи 1).
- Produces: `classifyRuns(rows, now) -> [{level:'red'|'yellow', text}]`; GET `/api/ops/alerts` → `{alerts:[...]}` (401/403 как /health).

- [ ] **Step 1: `lib/opsAlerts.js`** — чистая функция, БЕЗ обращений к БД (тестируемость — требование спеки):

```js
// Классификация алертов оператора по строкам jobs.collector_runs за 48 ч.
// rows: [{cabinet_id, collector, run_kind, status, started_at}] — отсортированы
// по started_at DESC. Чистая функция: БД не трогает (тест — фикстурами).
export function classifyRuns(rows, now = new Date()) {
  const alerts = [];
  const DAY = 24 * 3600 * 1000;
  // 1) Падения юнитов (run_kind='systemd', collector='unit:…') свежее 24 ч — красный.
  const unitFails = rows.filter((r) => r.run_kind === 'systemd'
    && String(r.collector).startsWith('unit:')
    && now - new Date(r.started_at) < DAY);
  for (const u of [...new Map(unitFails.map((r) => [r.collector, r])).values()]) {
    alerts.push({ level: 'red',
      text: `Юнит ${String(u.collector).slice(5)} падает с ${new Date(u.started_at).toLocaleString('ru-RU')}` });
  }
  // 2/3) По (cabinet_id, collector): последние прогоны БЕЗ blocked/skipped/no_token.
  const byKey = new Map();
  for (const r of rows) {
    if (r.run_kind === 'systemd') continue;
    if (['blocked', 'skipped', 'no_token'].includes(r.status)) continue;
    const k = `${r.cabinet_id}|${r.collector}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r); // rows уже DESC — [0] самый свежий
  }
  for (const [k, runs] of byKey) {
    const [cab, coll] = k.split('|');
    if (runs.length >= 2 && runs[0].status === 'failed' && runs[1].status === 'failed') {
      const n = runs.findIndex((r) => r.status !== 'failed');
      alerts.push({ level: 'red',
        text: `${coll} кабинета ${cab} падает ${n === -1 ? runs.length : n} тика(ов) подряд` });
    } else if (runs.length >= 3 && runs.slice(0, 3).every((r) => r.status === 'partial')) {
      alerts.push({ level: 'yellow', text: `${coll} кабинета ${cab}: partial 3 тика подряд` });
    }
  }
  return alerts;
}
```

- [ ] **Step 2: Тест** `scripts/test-ops-alerts.mjs` — node с `assert`: фикстуры (а) unit-fail 2 ч назад → red; (б) unit-fail 30 ч назад → пусто; (в) failed,failed → red; (г) failed,ok,failed → пусто; (д) blocked,failed,failed → red (blocked не рвёт серию — исключён из выборки); (е) partial×3 → yellow; (ж) partial×2,ok → пусто. Run: `node scripts/test-ops-alerts.mjs` → «OK 7/7».

- [ ] **Step 3: Роут** `app/api/ops/alerts/route.js` — каркас (сессия/isOps/403) скопировать из `app/api/health/route.js:17-24`; SQL: `SELECT cabinet_id, collector, run_kind, status, started_at FROM jobs.collector_runs WHERE started_at > now() - interval '48 hours' ORDER BY started_at DESC` (лёгкий: индекс collector_runs_coll_fin); ответ `{alerts: classifyRuns(rows)}`.

- [ ] **Step 4: Плашка** `app/OpsAlertsBanner.jsx` — клиентский компонент: fetch `/api/ops/alerts`, при 401/403/сетевой ошибке рендерит null (обычный пользователь её не видит и не грузит: fetch делается всегда, но тело — только для ops; это приемлемо — роут лёгкий); alerts.length=0 → null; иначе фиксированная полоса сверху (красная при любом red, иначе жёлтая), тексты списком, по-русски. Подключить в корневой `app/layout.js` (посмотреть его структуру по месту; плашка должна жить и на /cabinets, и на /settings, и на /health).

- [ ] **Step 5: Ложный комментарий** `app/cabinets/[id]/layout.js:172-174`: строку «Владельцу алерт уже ушёл через systemd OnFailure — клиенту это знать не нужно.» заменить на «Владелец видит это операторским баннером (/api/ops/alerts); клиенту хватает жёлтого баннера устаревших данных.»

- [ ] **Step 6:** Деплоя в этой задаче нет (панельные файлы поедут одним build в задаче 7). Прогнать тест Step 2. Commit: `feat(panel): операторский баннер алертов воркера (allowlist)`

---

### Task 5: Клиентский баннер устаревших данных

**Files:**
- Modify: `app/cabinets/[id]/layout.js` (рядом с brokenShops :86-92 и :149-159)

**Interfaces:**
- Consumes: паттерн текста с датой :151-153; `jobs.collector_runs.status='ok'`.
- Produces: жёлтый баннер «Данные <МП> не обновлялись с <дата>» при последнем ok-прогоне ключевого сборщика старше порога.

- [ ] **Step 1:** Константы: `const STALE_HOURS = Number(process.env.SAAS_STALE_HOURS || 24);` и карта ключевых сборщиков `{ozon: ['ozon_accruals','ozon_orders'], wb: ['wb_finance','wb_orders']}` (финансы/заказы площадки — спека).
- [ ] **Step 2:** Для активных магазинов кабинета с `auth_state='ok'` (paused/disabled уже имеют свой баннер — не дублировать) — запрос: `SELECT collector, MAX(finished_at) AS last_ok FROM jobs.collector_runs WHERE cabinet_id=$1 AND status='ok' AND collector = ANY($2) GROUP BY collector`. Если по КАКОМУ-ТО ключевому сборщику площадки last_ok старше STALE_HOURS (или строк нет вовсе, а магазин активен дольше STALE_HOURS — по `created_at` магазина, если поле есть; иначе строк-нет = не показывать, онбординг ещё идёт) → `banners.push({tone:'warn', text: 'Данные <МП> не обновлялись с <дата last_ok по-русски>. Мы уже разбираемся.'})` — формат даты как :151-153. Без технических имён сборщиков в тексте.
- [ ] **Step 3:** Прогнать SQL руками под saas_ro для кабинетов 1 (свежие данные → баннера нет) и синтетически проверить ветку «старше 24 ч» (подставить в запрос `now() - interval '25 hours'`). Commit: `feat(panel): клиентский баннер устаревших данных площадки`

---

### Task 6: Перманентно битые ключи — disabled + blocked-журнал

**Files:**
- Modify: `worker/shop_auth.py` (:23-24 константы, :51-75 mark_failure, :91-107 should_skip), `worker/orchestrator.py` (:360-379 пауза; :445-485 запись статусов; :487-515 переклассификация), `scripts/notify-broken-keys.mjs` (:22-29, :40-45, текст письма), `app/api/cabinets/[id]/shops/route.js` (:228-242), `app/cabinets/[id]/layout.js` (:149-159 текст баннера ключей)

**Interfaces:**
- Consumes: миграция 044 (`disabled`, `blocked`); `_record_run` → id (задача 2).
- Produces: `SAAS_AUTH_DISABLE_AFTER` (дефолт 7); `should_skip` возвращает и причину; журнал контрольных попыток паузы = `blocked`.

- [ ] **Step 1: shop_auth.py**: `DISABLE_AFTER = int(os.environ.get("SAAS_AUTH_DISABLE_AFTER", "7"))`. В `mark_failure` CASE: если текущее `auth_state='paused'` и `auth_fail_count + 1 >= FAIL_THRESHOLD + DISABLE_AFTER` → `'disabled'` (докстрока: fail_count после паузы растёт ровно раз в сутки контрольной попыткой, поэтому порог = FAIL_THRESHOLD + N суточных отказов); при переходе в `disabled` также `auth_notified_at = NULL` (развязать «одно письмо на эпизод» для ВТОРОГО письма — об отключении). В `should_skip`: `auth_state == 'disabled'` → всегда True (никаких суточных попыток).
- [ ] **Step 2: orchestrator.py**: в блоке классификации ПОСЛЕ цикла (:487-515) — собрать id строк журнала (из `_record_run(...)`, задача 2 Step 4) для сборщиков, попавших в `blocked`/`auth_failed_collectors`, и одним UPDATE перевести их: `UPDATE jobs.collector_runs SET status='blocked' WHERE id = ANY(%s)` (соединение — как в `_record_run`, с тем же «не роняем прогон» try/except). Итог: в журнале `failed` = настоящий сбой; контрольная попытка паузы, упавшая по auth — `blocked`.
- [ ] **Step 3: notify-broken-keys.mjs**: выборка (:22-29) → `auth_state IN ('paused','disabled')`; текст письма для `disabled`: «Сбор данных остановлен — обновите ключи в настройках» (для paused — прежний «проверьте ключи»); механизм бронирования auth_notified_at не менять.
- [ ] **Step 4: PUT shops route (:228-242)**: в `credsFilled`-блок добавить `sets.push(\`auth_failed_at = NULL\`); sets.push(\`auth_last_attempt_at = NULL\`);` — выравнивание с python `mark_ok` (:84-85); это же — выход из `disabled` (auth_state='ok' там уже ставится).
- [ ] **Step 5: Баннер ключей layout.js (:149-159)**: различать тексты — `paused`: как сейчас; `disabled`: «<МП>: сбор остановлен — обновите ключи API» (tone neg).
- [ ] **Step 6:** `python3 -m py_compile worker/shop_auth.py worker/orchestrator.py`; `node --check scripts/notify-broken-keys.mjs`. Commit: `feat(worker): disabled-состояние битых ключей + blocked-журнал контрольных попыток`

---

### Task 7: Деплой, живая приёмка на 1009, доки

**Files:**
- Modify: `docs/metrics-contract.md` НЕ трогаем (не про цифры); при желании — короткий раздел в `docs/db-read-access.md` не нужен. Новых файлов нет.

- [ ] **Step 1: Деплой панели**: `npm run build && systemctl restart saas-web`; `systemctl is-active saas-web` → active.
- [ ] **Step 2: Приёмка ops-баннера**: `curl` нельзя (сессия) — проверить роут кодом теста: временно `node -e` с прямым вызовом `classifyRuns` на живой выборке из БД (saas_ro) — картина должна включать вчерашний OzonError 1009/1008, если серия ещё жива; плюс попросить владельца открыть панель (его user_id в SAAS_OPS_USER_IDS — проверить, что переменная заполнена в .env.local, если нет — сказать контролёру, чтобы согласовал с владельцем её заполнение).
- [ ] **Step 3: Приёмка ##OBS**: после ближайшего планового тика — `psql -h localhost -U saas_ro -d saas -Atc "SELECT collector, rows_written, eff_date_from::text, eff_date_to::text FROM jobs.collector_runs WHERE run_kind='main' AND started_at > now() - interval '2 hours' AND rows_written IS NOT NULL LIMIT 15"` → непустые rows/окна у сборщиков из задачи 3.
- [ ] **Step 4: Приёмка 1009**: после ближайшей суточной контрольной попытки (следующий тик, где `should_skip` даст False) магазин 5 обязан перейти `paused → disabled` (fail_count 15 ≥ 2+7), а строки её сборщиков в журнале — `blocked`, не `failed`. Проверка: `SELECT auth_state, auth_fail_count FROM auth.shops WHERE shop_id=5` и `SELECT status, count(*) FROM jobs.collector_runs WHERE cabinet_id=1009 AND started_at > <время тика> GROUP BY 1` → 0 новых `failed`. Если тик долго ждать — допустимо разово ускорить: `UPDATE auth.shops SET auth_last_attempt_at = now() - interval '25 hours' WHERE shop_id=5` (запись в БД руками — только с санкции владельца ЛИБО силами контролёра по стандартному протоколу идемпотентных операций; сама запись обратима и затрагивает только момент следующей попытки).
- [ ] **Step 5: Сторожа**: check-profit-canon (1, 1008), profit-snapshot --verify, check-ozon-sku-ad → ALL PASS (цифры не тронуты).
- [ ] **Step 6: Commit** (если были правки по ходу приёмки) + финальная запись в леджер.

---

## Self-review (выполнено при написании)

- Покрытие спеки: компонент 1 (баннер+роут+ложный комментарий) — Task 4; компонент 2 (клиентский баннер) — Task 5; компонент 3 (##OBS+rows+eff-окно, миграция) — Tasks 1-3; компонент 4 (disabled+blocked+notify+PUT-фикс) — Tasks 1, 6; приёмка 1009 — Task 7. «Что НЕ входит» спеки соблюдено (нет email-алертов оператору, нет бэкфилла rows, нет rework /health).
- Типы/имена согласованы: `eff_date_from/to DATE`; `##OBS rows= from= to=`; `blocked` в CHECK до использования (Task 1 раньше Task 6); `_record_run` возвращает id (Task 2) до использования (Task 6).
- Плейсхолдеров нет; таблица задачи 3 — конкретные файлы/строки/источники счётчиков с указанием сверять переменные по месту (номера строк в живом коде дрейфуют — это не пробел, а инструкция).
