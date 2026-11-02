#!/usr/bin/env node
// scripts/smoke-purchase-order-files.mjs — смоук документов заказа закупки (накладные карго/фабрик, миграция 076).
// Только кабинет #1. Владелец: загрузка → список → скачивание тех же байтов → inline-заголовок → запрет типа →
// удаление. Временный менеджер (заводится и удаляется админ-соединением): 403 на список/скачивание/загрузку,
// в карточке заказа нет supplier_contact, его правка шапки контакт не затирает.
// Запуск: PGPASSFILE=/root/.pgpass-admin node scripts/smoke-purchase-order-files.mjs [cabinetId=1] [baseUrl]
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

async function cookieFor(userId) {
  const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [userId]);
  const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version, active_cabinet_id: null, touched_at: Date.now() },
    { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
  return `saas_session=${encodeURIComponent(seal)}`;
}
const json = async (cookie, path, method = 'GET', body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const upload = async (cookie, orderId, name, bytes, kind = 'cargo') => {
  const fd = new FormData();
  fd.append('order_id', String(orderId)); fd.append('kind', kind); fd.append('file', new Blob([bytes]), name);
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/purchase-orders/files`, { method: 'POST', headers: { cookie }, body: fd });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const own = await cookieFor(owner_user_id);
const { default: pg } = await import('pg');
const admin = new pg.Client({ host: 'localhost', user: 'postgres', database: 'saas' });
await admin.connect();
let orderId = null, mgrId = null;
try {
  const [m] = (await admin.query(`INSERT INTO auth.users (email, password_hash, name, email_verified_at)
    VALUES ($1, 'x', '__smoke mgr', now()) RETURNING user_id`, [`__smoke_po_files_${Date.now()}@sysell`])).rows;
  mgrId = m.user_id;
  await admin.query(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'manager')`, [mgrId, CAB]);
  const mgr = await cookieFor(mgrId);

  const c = await json(own, 'purchase-orders', 'POST', { action: 'create', supplier: '__smoke po-files', supplier_contact: 'wechat smoke-123' });
  check('create → id', c.status === 200 && c.data.id > 0, c);
  orderId = c.data.id;

  const pdf = Buffer.from('%PDF-1.4\n% smoke накладная\n' + 'x'.repeat(5000));
  const up = await upload(own, orderId, 'Накладная карго №1.pdf', pdf);
  check('владелец: загрузка PDF', up.status === 200 && up.data.id > 0, up);
  const fileId = up.data.id;
  const xl = await upload(own, orderId, 'invoice.xlsx', Buffer.from('PK fake'), 'factory');
  check('владелец: загрузка xlsx (фабрика)', xl.status === 200, xl);
  check('html → 400', (await upload(own, orderId, 'x.html', Buffer.from('<script>'))).status === 400);
  check('svg → 400', (await upload(own, orderId, 'x.svg', Buffer.from('<svg/>'))).status === 400);
  check('чужой/несуществующий заказ → 404', (await upload(own, 999999999, 'a.pdf', pdf)).status === 404);

  const list = await json(own, `purchase-orders/files?order_id=${orderId}`);
  check('список: 2 файла, без байтов', list.status === 200 && list.data.files?.length === 2 && !('data' in list.data.files[0]), list);

  const dl = await fetch(`${BASE}/api/cabinets/${CAB}/purchase-orders/files?file_id=${fileId}`, { headers: { cookie: own } });
  const got = Buffer.from(await dl.arrayBuffer());
  check('скачивание: те же байты', dl.status === 200 && got.equals(pdf), { status: dl.status, len: got.length });
  check('скачивание: attachment + filename*', /^attachment; .*filename\*=UTF-8''/.test(dl.headers.get('content-disposition') || ''), dl.headers.get('content-disposition'));
  check('скачивание: nosniff + no-store', dl.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(dl.headers.get('cache-control') || ''));
  const inl = await fetch(`${BASE}/api/cabinets/${CAB}/purchase-orders/files?file_id=${fileId}&inline=1`, { headers: { cookie: own } });
  check('PDF inline=1 → inline', /^inline;/.test(inl.headers.get('content-disposition') || ''), inl.headers.get('content-disposition'));
  const xinl = await fetch(`${BASE}/api/cabinets/${CAB}/purchase-orders/files?file_id=${xl.data.id}&inline=1`, { headers: { cookie: own } });
  check('xlsx inline=1 → всё равно attachment', /^attachment;/.test(xinl.headers.get('content-disposition') || ''));

  // Менеджер.
  check('менеджер: список → 403', (await json(mgr, `purchase-orders/files?order_id=${orderId}`)).status === 403);
  const mdl = await fetch(`${BASE}/api/cabinets/${CAB}/purchase-orders/files?file_id=${fileId}`, { headers: { cookie: mgr } });
  check('менеджер: скачивание по прямой ссылке → 403', mdl.status === 403, mdl.status);
  check('менеджер: загрузка → 403', (await upload(mgr, orderId, 'a.pdf', pdf)).status === 403);
  check('менеджер: удаление → 403', (await json(mgr, `purchase-orders/files?file_id=${fileId}`, 'DELETE')).status === 403);
  const mv = await json(mgr, `purchase-orders?id=${orderId}`);
  check('менеджер: карточка заказа без supplier_contact', mv.status === 200 && !('supplier_contact' in mv.data.order) && !JSON.stringify(mv.data).includes('smoke-123'), mv.data.order);
  const mu = await json(mgr, 'purchase-orders', 'POST', { action: 'update', order_id: orderId, note: 'правка менеджера', supplier_contact: '' });
  check('менеджер: правка шапки → 200', mu.status === 200, mu);
  const ov = await json(own, `purchase-orders?id=${orderId}`);
  check('контакт после правки менеджера цел', ov.data.order?.supplier_contact === 'wechat smoke-123' && ov.data.order?.note === 'правка менеджера', ov.data.order);
  const ml = await json(mgr, 'purchase-orders');
  check('менеджер: список заказов без контакта', !JSON.stringify(ml.data).includes('smoke-123'));

  const del = await json(own, `purchase-orders/files?file_id=${fileId}`, 'DELETE');
  check('владелец: удаление', del.status === 200, del);
  const after = await json(own, `purchase-orders/files?order_id=${orderId}`);
  check('после удаления 1 файл', after.data.files?.length === 1, after);
  const gone = await fetch(`${BASE}/api/cabinets/${CAB}/purchase-orders/files?file_id=${fileId}`, { headers: { cookie: own } });
  check('удалённый файл → 404', gone.status === 404, gone.status);
} finally {
  if (orderId) {
    await admin.query(`DELETE FROM tenant.purchase_order_files WHERE cabinet_id=$1 AND order_id=$2`, [CAB, orderId]);
    await admin.query(`UPDATE tenant.dds_movements SET status='archived' WHERE cabinet_id=$1 AND source_ref LIKE $2`, [CAB, `order:${orderId}:%`]);
    await admin.query(`DELETE FROM tenant.purchase_orders WHERE cabinet_id=$1 AND id=$2`, [CAB, orderId]);
    console.log(`уборка: заказ ${orderId} удалён`);
  }
  if (mgrId) {
    await admin.query(`DELETE FROM auth.memberships WHERE user_id=$1`, [mgrId]);
    await admin.query(`DELETE FROM auth.users WHERE user_id=$1`, [mgrId]);
    console.log(`уборка: временный менеджер ${mgrId} удалён`);
  }
  await admin.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
