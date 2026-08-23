// scripts/test-ops-alerts.mjs — фикстурный тест lib/opsAlerts.js (задача 4 плана
// «Наблюдаемость воркера»). Без БД — classifyRuns чистая функция.
// Run: node scripts/test-ops-alerts.mjs
import assert from 'node:assert/strict';
import { classifyRuns } from '../lib/opsAlerts.js';

const NOW = new Date('2026-08-22T12:00:00Z');
const HOUR = 3600 * 1000;
const ago = (h) => new Date(NOW.getTime() - h * HOUR).toISOString();
const minAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

let passed = 0;
const total = 16;
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

// (и) unit-fail + failed-строка сборщика через 5 мин → red, текст содержит
// «виновники:» и имя сборщика.
check('unit-fail + failed рядом → red с виновниками', () => {
  const rows = [
    { cabinet_id: null, collector: 'unit:wb-collector.service', run_kind: 'systemd', status: 'failed', started_at: ago(2) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: minAgo(115) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
  assert.match(alerts[0].text, /виновники:/);
  assert.match(alerts[0].text, /wb_orders/);
});

// (к) unit-fail + только partial рядом → yellow, текст содержит «троттлинг».
check('unit-fail + partial рядом → yellow троттлинг', () => {
  const rows = [
    { cabinet_id: null, collector: 'unit:wb-collector.service', run_kind: 'systemd', status: 'failed', started_at: ago(2) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'partial', started_at: minAgo(115) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'yellow');
  assert.match(alerts[0].text, /троттлинг/);
});

// (л) unit-fail без объясняющих (ближайший сбой сборщика в 2 часах от unit-фейла,
// вне окна ±30 мин) → red, текст БЕЗ «виновники:».
check('unit-fail без объясняющих → red без виновников', () => {
  const rows = [
    { cabinet_id: null, collector: 'unit:wb-collector.service', run_kind: 'systemd', status: 'failed', started_at: ago(2) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(4) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
  assert.doesNotMatch(alerts[0].text, /виновники:/);
});

// (м) failed×2, runs[0].started_at 15 часов назад → пусто (серия устарела,
// run_kind:'cron' не входит в SERIES_FRESH_BY_KIND → дефолтная граница 14 ч).
check('failed,failed 15ч назад → пусто (устарела)', () => {
  const rows = [
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(15) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(16) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 0);
});

// (н) failed×2 свежие (11ч/11.5ч, внутри границы) → red — регресс-защита,
// чтобы граница свежести не начала резать валидные свежие серии.
check('failed,failed 11ч назад → red (внутри границы)', () => {
  const rows = [
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(11) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: ago(11.5) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
});

// (о) failed×2, run_kind:'stocks', свежесть 20ч → red (переживает per-kind
// порог stocks=30ч, где дефолт 14ч уже погасил бы серию).
check('failed,failed stocks 20ч назад → red (переживает per-kind порог)', () => {
  const rows = [
    { cabinet_id: 1, collector: 'ozon_stocks', run_kind: 'stocks', status: 'failed', started_at: ago(20) },
    { cabinet_id: 1, collector: 'ozon_stocks', run_kind: 'stocks', status: 'failed', started_at: ago(21) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
});

// (п) failed×2, run_kind:'main', свежесть 15ч → пусто (main гаснет по
// собственному порогу 14ч — ночной разрыв 12ч15м + запас, а не по дефолту).
check('failed,failed main 15ч назад → пусто (гаснет по 14ч)', () => {
  const rows = [
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'main', status: 'failed', started_at: ago(15) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'main', status: 'failed', started_at: ago(16) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 0);
});

// (р) unit-fail + failed-строка сборщика за 45 мин ДО него (в пределах
// асимметричного окна −90/+5 мин) → red с «виновники:».
check('unit-fail + failed за 45мин до него → red с виновниками', () => {
  const rows = [
    { cabinet_id: null, collector: 'unit:wb-collector.service', run_kind: 'systemd', status: 'failed', started_at: ago(2) },
    { cabinet_id: 1, collector: 'wb_orders', run_kind: 'cron', status: 'failed', started_at: minAgo(165) },
  ];
  const alerts = classifyRuns(rows, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
  assert.match(alerts[0].text, /виновники:/);
});

console.log(`OK ${passed}/${total}`);
if (passed !== total) process.exit(1);
