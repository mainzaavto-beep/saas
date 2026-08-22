// scripts/test-ops-alerts.mjs — фикстурный тест lib/opsAlerts.js (задача 4 плана
// «Наблюдаемость воркера»). Без БД — classifyRuns чистая функция.
// Run: node scripts/test-ops-alerts.mjs
import assert from 'node:assert/strict';
import { classifyRuns } from '../lib/opsAlerts.js';

const NOW = new Date('2026-08-22T12:00:00Z');
const HOUR = 3600 * 1000;
const ago = (h) => new Date(NOW.getTime() - h * HOUR).toISOString();

let passed = 0;
const total = 8;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}  ${e.message}`);
  }
}

// (а) unit-fail 2 ч назад → red.
check('unit-fail 2ч назад → red', () => {
  const rows = [
    { cabinet_id: null, collector: 'unit:wb-collector.service', run_kind: 'systemd', status: 'failed', started_at: ago(2) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
  assert.match(alerts[0].text, /wb-collector\.service/);
});

// (б) unit-fail 30 ч назад → пусто (старше суток — вне окна).
check('unit-fail 30ч назад → пусто', () => {
  const rows = [
    { cabinet_id: null, collector: 'unit:wb-collector.service', run_kind: 'systemd', status: 'failed', started_at: ago(30) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 0);
});

// (в) failed, failed (2 тика подряд, DESC) → red.
check('failed,failed → red', () => {
  const rows = [
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(1) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(2) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
});

// (г) failed, ok, failed → пусто (последние два тика не оба failed).
check('failed,ok,failed → пусто', () => {
  const rows = [
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(1) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'ok', started_at: ago(2) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(3) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 0);
});

// (д) blocked, failed, failed → red (blocked не рвёт серию — исключён из выборки,
// оставшиеся два failed становятся соседними тиками).
check('blocked,failed,failed → red', () => {
  const rows = [
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'blocked', started_at: ago(1) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(2) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(3) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
});

// (е) partial×3 подряд → yellow.
check('partial×3 → yellow', () => {
  const rows = [
    { cabinet_id: 1, collector: 'ozon_orders', run_kind: 'cron', status: 'partial', started_at: ago(1) },
    { cabinet_id: 1, collector: 'ozon_orders', run_kind: 'cron', status: 'partial', started_at: ago(2) },
    { cabinet_id: 1, collector: 'ozon_orders', run_kind: 'cron', status: 'partial', started_at: ago(3) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'yellow');
});

// (ж) partial×2, ok → пусто (не набралось 3 подряд).
check('partial×2,ok → пусто', () => {
  const rows = [
    { cabinet_id: 1, collector: 'ozon_orders', run_kind: 'cron', status: 'partial', started_at: ago(1) },
    { cabinet_id: 1, collector: 'ozon_orders', run_kind: 'cron', status: 'partial', started_at: ago(2) },
    { cabinet_id: 1, collector: 'ozon_orders', run_kind: 'cron', status: 'ok', started_at: ago(3) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 0);
});

// (з) timeout, failed (2 тика подряд, DESC) → red — timeout считается сбоем
// наравне с failed, иначе стабильно падающий по таймауту сборщик никогда
// не даст серийный алерт.
check('timeout,failed → red', () => {
  const rows = [
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'timeout', started_at: ago(1) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(2) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
});

console.log(`OK ${passed}/${total}`);
if (passed !== total) process.exit(1);
