# Качество операторских алертов + хвосты пагинации — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Красный цвет операторского баннера снова означает «настоящий сбой»: юнит-алерты объяснимы (виновники по именам, троттлинг — жёлтый), мёртвые серии гаснут за 12 часов; плюс три хвоста пагинации.

**Architecture:** Переписывание `classifyRuns` (чистая функция, полный код ниже) + 5 новых фикстур; мелкие правки worker; деплой панели с живой проверкой.

**Tech Stack:** Node (lib, тест), Python (worker-хвосты).

**Спека:** `docs/superpowers/specs/2026-08-23-alert-quality-design.md` (9191ba5).

## Global Constraints

- `classifyRuns` остаётся чистой функцией без БД; вся логика на переданных rows (DESC по started_at).
- Семантика exit-кодов сборщиков не меняется (partial = exit 3, окно не записано — неприкосновенно).
- Деплой панели только в задаче 3; worker-правки = мгновенный деплой (аддитивные).
- Сторожа после деплоя: check-profit-canon (кабинеты 1, 1008), profit-snapshot --verify — ALL PASS.
- Тексты по-русски.

---

### Task 1: classifyRuns v2 + фикстуры

**Files:**
- Modify: `lib/opsAlerts.js` (полная замена тела функции; текущий файл 57 строк)
- Modify: `scripts/test-ops-alerts.mjs` (+5 фикстур, итог «OK 13/13»)

- [ ] **Step 1: Новый lib/opsAlerts.js** (шапка-комментарий файла сохраняется и дополняется; заменить `classifyRuns` целиком):

```js
export function classifyRuns(rows, now = new Date()) {
  const alerts = [];
  const DAY = 24 * 3600 * 1000;
  // Окно сопоставления unit-фейла с прогонами сборщиков того же тика.
  const EXPLAIN_MS = 30 * 60 * 1000;
  // Граница свежести серий: сборщик, не запускавшийся дольше (например,
  // магазин ушёл в disabled), не должен висеть в алертах до конца
  // 48-часового окна выборки. 12 ч = два плановых тика с запасом.
  const SERIES_FRESH_MS = 12 * 3600 * 1000;

  // Прогоны-сбои сборщиков — кандидаты в «виновники» юнит-фейлов.
  const failLike = rows.filter((r) => r.run_kind !== 'systemd'
    && ['failed', 'timeout', 'partial'].includes(r.status));
  const nameOf = (list) => {
    const uniq = [...new Set(list.map((r) => `${r.collector} каб.${r.cabinet_id}`))];
    return uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? ` и ещё ${uniq.length - 3}` : '');
  };

  // 1) Падения systemd-юнитов свежее 24 ч. Группируем по юниту: текст
  // показывает НАЧАЛО серии (самое старое вхождение), виновников ищем
  // около ЛЮБОГО вхождения (±30 мин) — свежие падения тоже объяснимы.
  const unitRows = rows.filter((r) => r.run_kind === 'systemd'
    && String(r.collector).startsWith('unit:')
    && now - new Date(r.started_at) < DAY);
  const byUnit = new Map();
  for (const r of unitRows) {
    if (!byUnit.has(r.collector)) byUnit.set(r.collector, []);
    byUnit.get(r.collector).push(r);
  }
  for (const [unit, occ] of byUnit) {
    const oldest = occ[occ.length - 1]; // rows DESC → последний = старейший
    const times = occ.map((r) => new Date(r.started_at).getTime());
    const explain = failLike.filter((r) => {
      const t = new Date(r.started_at).getTime();
      return times.some((ut) => Math.abs(ut - t) <= EXPLAIN_MS);
    });
    const hard = explain.filter((r) => r.status !== 'partial');
    const since = new Date(oldest.started_at).toLocaleString('ru-RU');
    const name = String(unit).slice(5);
    if (hard.length) {
      alerts.push({ level: 'red',
        text: `Юнит ${name} падает с ${since} (виновники: ${nameOf(hard)})` });
    } else if (explain.length) {
      alerts.push({ level: 'yellow',
        text: `Тик ${name} завершился с partial (${nameOf(explain)} — обычно троттлинг МП)` });
    } else {
      alerts.push({ level: 'red', text: `Юнит ${name} падает с ${since}` });
    }
  }

  // 2/3) Серии по (cabinet_id, collector). blocked/skipped/no_token —
  // намеренная пауза, исключаем целиком (не рвут и не маскируют серию).
  const byKey = new Map();
  for (const r of rows) {
    if (r.run_kind === 'systemd') continue;
    if (['blocked', 'skipped', 'no_token'].includes(r.status)) continue;
    const k = `${r.cabinet_id}|${r.collector}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r); // rows DESC → [0] самый свежий
  }
  const isFail = (s) => s === 'failed' || s === 'timeout';
  for (const [k, runs] of byKey) {
    // Граница свежести: серия без свежих прогонов — устаревший шум.
    if (now - new Date(runs[0].started_at) > SERIES_FRESH_MS) continue;
    const [cab, coll] = k.split('|');
    if (runs.length >= 2 && isFail(runs[0].status) && isFail(runs[1].status)) {
      const n = runs.findIndex((r) => !isFail(r.status));
      alerts.push({ level: 'red',
        text: `${coll} кабинета ${cab} падает ${n === -1 ? runs.length : n} тика(ов) подряд` });
    } else if (runs.length >= 3 && runs.slice(0, 3).every((r) => r.status === 'partial')) {
      alerts.push({ level: 'yellow', text: `${coll} кабинета ${cab}: partial 3 тика подряд` });
    }
  }
  return alerts;
}
```
Комментарий про Map-дедуп из старой версии (:14-19) заменяется комментарием из кода выше (группировка byUnit). ⚠️ Существующие 8 фикстур должны пройти БЕЗ правок ожиданий, кроме кейсов, где старый текст юнит-алерта теперь дополняется виновниками ИЛИ серия попадает под границу свежести: перед правкой прогнать старый тест на новом коде и КАЖДОЕ упавшее ожидание пересмотреть осознанно (в отчёт — список кейсов, чьи ожидания изменились и почему; молча подгонять нельзя).

- [ ] **Step 2: +5 фикстур** в `scripts/test-ops-alerts.mjs` (все существующие фикстуры используют «свежие» started_at? проверить: если старые кейсы серий имеют started_at старше 12 ч от `now` фикстуры — они начнут гаснуть; выставить им свежие времена явно):
  - (и) unit-fail + failed-строка сборщика через 5 мин → red, текст содержит «виновники:» и имя;
  - (к) unit-fail + только partial рядом → yellow, текст содержит «троттлинг»;
  - (л) unit-fail без объясняющих (ближайший сбой сборщика в 2 часах) → red, текст БЕЗ «виновники:»;
  - (м) failed×2, runs[0].started_at 13 часов назад → пусто;
  - (н) failed×2 свежие → red (регресс-защита границы).
Итог: `node scripts/test-ops-alerts.mjs` → «OK 13/13».

- [ ] **Step 3:** Commit: `feat(panel): объяснимые юнит-алерты и граница свежести серий`

---

### Task 2: Хвосты пагинации (worker)

**Files:**
- Modify: `scripts/test-ozon-accruals-pagination.py` (+кейс 5), `worker/collectors/ozon_client.py` (литерал паузы), `worker/collectors/ozon_accruals.py` (:36-41 докстрока)

- [ ] **Step 1:** Кейс 5 в тест: monkeypatch `oc.ACCRUAL_MAX_PAGES = 3`, фейковые страницы с уникальными last_id (p1→p2→p3→p4...) — на 3-й странице RuntimeError с текстом «потолок». Осторожно: `accrual_by_day` читает константу как `oc.ACCRUAL_MAX_PAGES` или локально? Проверить по коду — если модульная переменная читается через глобальное имя внутри метода, monkeypatch модуля сработает; итог «OK 5/5».
- [ ] **Step 2:** `time.sleep(1.0)` в `accrual_by_day` → `time.sleep(REQUEST_PAUSE_SEC)` (константа в том же модуле; сверить фактическое имя grep-ом).
- [ ] **Step 3:** Докстрока `ozon_accruals.py:36-41`: буллет про пагинацию вынести из-под «Один сторож» (структурная косметика, содержание не менять).
- [ ] **Step 4:** `python3 -m py_compile` обоих + `python3 scripts/test-ozon-accruals-pagination.py` → OK 5/5. Commit: `chore(worker): хвосты пагинации — тест потолка, константа паузы, докстрока`

---

### Task 3: Деплой + живая проверка

- [ ] **Step 1:** `npm run build && systemctl restart saas-web` → active. (Если рестарт заблокируют права субагента — доложить контролёру, он рестартует сам; это уже случалось.)
- [ ] **Step 2:** Живой прогон classifyRuns на выборке 48 ч (node-скрипт с подключением как в check-скриптах, saas_ro): вывод алертов ДО (по git show старой версии) и ПОСЛЕ — таблицей в отчёт. Ожидание: partial-объяснимые юнит-алерты стали жёлтыми с виновниками; серии 1009 (без свежих прогонов после disabled) погашены; настоящие failed — красные с именами.
- [ ] **Step 3:** Сторожа: check-profit-canon (1, 1008), profit-snapshot --verify → ALL PASS.
- [ ] **Step 4:** Отчёт; коммитов нет.

---

## Self-review (выполнено при написании)

- Покрытие спеки: компонент 1 (T1 Step 1 unit-логика), 2 (граница свежести), 3 (фикстуры), 4 (T2). «Не входит» соблюдено (OnFailure/exit-коды не тронуты).
- Совместимость: partial-строки теперь нужны для объяснения юнитов — в выборку byKey они по-прежнему попадают (partial не в списке исключений), unit-сопоставление идёт по failLike из ПОЛНОГО rows; SQL роута не меняется (уже отдаёт все статусы).
- Ловушка отмечена: старые фикстуры с датами старше 12 ч — шаг требует явной ревизии ожиданий, не молчаливой подгонки.
