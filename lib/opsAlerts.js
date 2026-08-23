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
