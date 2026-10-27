#!/usr/bin/env node
// scripts/smoke-purchase-orders.mjs — смоук закупок заказами (спека 2026-10-27). Только кабинет #1.
// Создаёт заказ по примеру спеки §2 → сверяет calc (курс, логистика, инвариант суммы) → строки ДДС →
// «✓ Прибыла» → отправка на /deliveries → приёмка с недостачей → удаляет за собой (заказ мягко, ДДС → archived).
// Запуск: node scripts/smoke-purchase-orders.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
if (CAB !== 1) { console.error('смоук пишет в БД — только кабинет #1'); process.exit(2); }
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail).slice(0, 400)}`); if (!cond) failed++; };
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

async function cookieFor(userId) {
  const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [userId]);
  const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version, active_cabinet_id: null, touched_at: Date.now() },
    { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
  return `saas_session=${encodeURIComponent(seal)}`;
}
const api = async (cookie, path, method = 'GET', body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const own = await cookieFor(owner_user_id);
let orderId = null;
try {
  const c = await api(own, 'purchase-orders', 'POST', { action: 'create', supplier: '__smoke purchase-orders', rate_cny: 11.9, order_dt: '2026-10-01' });
  check('create → id', c.status === 200 && c.data.id > 0, c);
  orderId = c.data.id;
  const P = (action, b) => api(own, 'purchase-orders', 'POST', { action, order_id: orderId, ...b });
  const cam = (await P('line_add', { label: 'камера', qty: 70, price_cny: 150, weight_kg: 0.3 })).data.id;
  const lin = (await P('line_add', { label: 'бельё', qty: 200, price_cny: 12.5, weight_kg: 0.1 })).data.id;
  await P('pay_add', { kind: 'prepay', amount: 4000, rate: 11.46, plan_date: '2026-10-02' });
  await P('pay_add', { kind: 'other', amount: 300, rate: 11.5 });
  const s1 = (await P('ship_add', { cargo_rub: 12000, ff_rub: 4000, lines: [{ line_id: cam, qty_shipped: 40 }, { line_id: lin, qty_shipped: 200 }] })).data.id;
  const over = await P('ship_add', { lines: [{ line_id: cam, qty_shipped: 31 }] });
  check('отправить больше заказанного → 400', over.status === 400, over);
  const s2 = (await P('ship_add', { cargo_rub: 5000 })).data.id; // по умолчанию — остаток 30 камер

  const v = (await api(own, `purchase-orders?id=${orderId}`)).data;
  const cl = v.calc.lines.find((l) => l.id === cam);
  check('эфф. курс', close(v.calc.rateEff, (4000 * 11.46 + 9000 * 11.9) / 13000, 1e-6), v.calc.rateEff);
  check('логистика камеры 157,14', close(cl.logisticsUnit, 11000 / 70), cl);
  const sum = v.calc.lines.reduce((s, l) => s + l.unitCost * l.qty, 0);
  check('инвариант суммы', close(sum, v.calc.goodsRub + v.calc.otherRub + v.calc.logisticsRub), { sum, calc: v.calc });
  check('ДДС: 2 оплаты + 3 строки логистики', v.dds.length === 5, v.dds);

  await P('ship_arrived', { id: s1 });
  const del = (await api(own, 'deliveries?status=waiting')).data;
  const it = del.items.find((x) => x.key === `s${s1}`);
  check('отправка на /deliveries', !!it && it.ordered === 240, del.items?.map((x) => x.key));
  const camLine = it.lines.find((l) => Number(l.line_id) === cam);
  await api(own, 'deliveries', 'POST', { action: 'ship_accept_line', shipment_id: s1, id: camLine.id, qty_accepted: 38 });
  const done = await api(own, 'deliveries', 'POST', { action: 'ship_done', shipment_id: s1 });
  check('ship_done', done.status === 200, done);
  const v2 = (await api(own, `purchase-orders?id=${orderId}`)).data;
  const cl2 = v2.calc.lines.find((l) => l.id === cam);
  check('недостача 2 шт, логистика не изменилась', cl2.shortage === 2 && close(cl2.logisticsUnit, 11000 / 70), cl2);
  const delAcc = await P('delete', {});
  check('нельзя удалить заказ с принятой отправкой', delAcc.status === 400, delAcc);
  const old = await api(own, 'purchases', 'POST', { supplier_name: 'x', qty: 1 });
  check('старые партии — 410', old.status === 410, old);
  void s2;
} finally {
  if (orderId) {
    // Уборка — от админа: снять приёмку и удалить тестовый заказ целиком (строки ДДС → archived).
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ host: 'localhost', user: 'postgres', database: 'saas' }); // пароль — PGPASSFILE=/root/.pgpass-admin
    await admin.connect();
    await admin.query(`UPDATE tenant.dds_movements SET status='archived' WHERE cabinet_id=$1 AND source_ref LIKE $2 AND status='planned'`, [CAB, `order:${orderId}:%`]);
    for (const t of ['purchase_shipment_lines']) await admin.query(`DELETE FROM tenant.${t} WHERE cabinet_id=$1 AND shipment_id IN (SELECT id FROM tenant.purchase_shipments WHERE cabinet_id=$1 AND order_id=$2)`, [CAB, orderId]);
    for (const t of ['purchase_shipments', 'purchase_order_payments', 'purchase_order_lines']) await admin.query(`DELETE FROM tenant.${t} WHERE cabinet_id=$1 AND order_id=$2`, [CAB, orderId]);
    await admin.query(`DELETE FROM tenant.purchase_orders WHERE cabinet_id=$1 AND id=$2`, [CAB, orderId]);
    await admin.end();
    console.log(`уборка: заказ ${orderId} удалён`);
  }
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
