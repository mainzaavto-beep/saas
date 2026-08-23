// lib/opsAlerts.js — классификация алертов оператора по строкам jobs.collector_runs
// за 48 ч (окно задаёт вызывающий SQL в app/api/ops/alerts/route.js).
//
// Чистая функция: БД не трогает вовсе (ни импорта lib/db.js, ни query()) —
// требование спеки задачи 4 ради тестируемости фикстурами без БД
// (см. scripts/test-ops-alerts.mjs).
//
// rows: [{cabinet_id, collector, run_kind, status, started_at}] — ожидаются
// отсортированными по started_at DESC (как отдаёт SQL в роуте).
export function classifyRuns(rows, now = new Date()) {
  const alerts = [];
  const DAY = 24 * 3600 * 1000;
  // Окно сопоставления unit-фейла с прогонами сборщиков того же тика.
  // Юнит-фейл пишется В БД В КОНЦЕ тика (тик длится до ~27м14с по
  // наблюдениям в проде), поэтому объясняющий сбой сборщика всегда РАНЬШЕ
  // момента unit-фейла — окно асимметрично: 90 мин назад (3× наблюдаемого
  // максимума длительности тика, с запасом) и 5 мин вперёд (на дрожание
  // записи времени/часов).
  const EXPLAIN_BEFORE_MS = 90 * 60 * 1000;
  const EXPLAIN_AFTER_MS = 5 * 60 * 1000;
  // Границы свежести серий по run_kind САМОЙ СВЕЖЕЙ строки серии
  // (runs[0].run_kind): сборщик, не запускавшийся дольше своего цикла
  // (например, магазин ушёл в disabled), не должен висеть в алертах до
  // конца 48-часового окна выборки. Один порог на все run_kind ложно гасил
  // суточные/недельные сборщики и не переживал обычный ночной разрыв —
  // пороги разведены по фактическому циклу тика.
  const SERIES_FRESH_BY_KIND = {
    // main: ночной разрыв тиков (17:00→05:15 MSK) = 12ч15м + запас.
    main: 14 * 3600 * 1000,
    // metrics30m: тик раз в 30 мин — порог в 4 пропущенных тика подряд.
    metrics30m: 2 * 3600 * 1000,
    // stocks: тик раз в сутки — порог в сутки + запас на смещение расписания.
    stocks: 30 * 3600 * 1000,
    // references: тик раз в неделю (168 ч) — порог в неделю + запас.
    references: 192 * 3600 * 1000,
  };
  // Дефолт для неизвестных/отсутствующих run_kind — консервативно как main.
  const SERIES_FRESH_DEFAULT_MS = 14 * 3600 * 1000;
  // Юнит X запускает прогоны только СВОЕГО run_kind — виновников ищем
  // только среди них. Без этой привязки любой failed-прогон постороннего
  // кабинета, случайно попавший во временное окно (напр. saas-backfill.timer
  // тикает раз в 5 мин — кандидат почти всегда найдётся), ложно объявлялся
  // «виновником» падения совсем другого юнита.
  const UNIT_RUN_KIND = {
    'saas-worker.service': 'main',
    'saas-stocks.service': 'stocks',
    'saas-references.service': 'references',
    'saas-metrics30m.service': 'metrics30m',
    'saas-backfill.service': 'backfill',
  };

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
    const name = String(unit).slice(5);
    // Юнит без известного run_kind (saas-web, saas-ozon-recon и т.п. —
    // сборщиков не запускают) — объяснение не ищем вовсе, кандидатов нет
    // по определению.
    const kind = UNIT_RUN_KIND[name];
    const explain = kind ? failLike.filter((r) => {
      if (r.run_kind !== kind) return false;
      const t = new Date(r.started_at).getTime();
      return times.some((ut) => t >= ut - EXPLAIN_BEFORE_MS && t <= ut + EXPLAIN_AFTER_MS);
    }) : [];
    const hard = explain.filter((r) => r.status !== 'partial');
    const since = new Date(oldest.started_at).toLocaleString('ru-RU');
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
    // Граница свежести по run_kind самой свежей строки — серия без свежих
    // прогонов (относительно её собственного цикла) — устаревший шум.
    const freshMs = SERIES_FRESH_BY_KIND[runs[0].run_kind] ?? SERIES_FRESH_DEFAULT_MS;
    if (now - new Date(runs[0].started_at) > freshMs) continue;
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
