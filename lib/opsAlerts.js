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

  // 1) Падения systemd-юнитов (collector='unit:…') свежее 24 ч — красный.
  // Дедуп по collector через Map — rows уже DESC, поэтому первое вхождение
  // на юнит — самое свежее (u.started_at в тексте — время самого свежего сбоя).
  const unitFails = rows.filter((r) => r.run_kind === 'systemd'
    && String(r.collector).startsWith('unit:')
    && now - new Date(r.started_at) < DAY);
  for (const u of [...new Map(unitFails.map((r) => [r.collector, r])).values()]) {
    alerts.push({
      level: 'red',
      text: `Юнит ${String(u.collector).slice(5)} падает с ${new Date(u.started_at).toLocaleString('ru-RU')}`,
    });
  }

  // 2/3) По (cabinet_id, collector): серии подряд идущих прогонов.
  // 'blocked'/'skipped'/'no_token' — намеренная пауза сборщика (сломанные
  // ключи и т.п.), а не сбой воркера — исключаем из выборки целиком, чтобы
  // они не рвали и не маскировали серию failed/partial соседних тиков.
  const byKey = new Map();
  for (const r of rows) {
    if (r.run_kind === 'systemd') continue;
    if (['blocked', 'skipped', 'no_token'].includes(r.status)) continue;
    const k = `${r.cabinet_id}|${r.collector}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r); // rows уже DESC → [0] самый свежий
  }
  for (const [k, runs] of byKey) {
    const [cab, coll] = k.split('|');
    if (runs.length >= 2 && runs[0].status === 'failed' && runs[1].status === 'failed') {
      const n = runs.findIndex((r) => r.status !== 'failed');
      alerts.push({
        level: 'red',
        text: `${coll} кабинета ${cab} падает ${n === -1 ? runs.length : n} тика(ов) подряд`,
      });
    } else if (runs.length >= 3 && runs.slice(0, 3).every((r) => r.status === 'partial')) {
      alerts.push({ level: 'yellow', text: `${coll} кабинета ${cab}: partial 3 тика подряд` });
    }
  }
  return alerts;
}
