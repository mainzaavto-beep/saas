#!/usr/bin/env node
// scripts/smoke-deliveries.mjs — смоук «Доставлено на склад» (15.10.2026). Проверяет:
//   1) GET отвечает 200; партий = архивных неудалённых партий в БД; totals.waiting+done+legacy = всего;
//   2) accepted каждой партии = Σ qty_accepted её строк в БД;
//   3) нет закрытых партий без строк;
//   4) catalog=1 отвечает 200;
//   5) (только кабинет #1, обратимо) line_add → line_update → line_delete на ждущей партии,
//      закрытую партию нельзя править (если такая есть); если ждущих партий нет — проба
//      пропускается с пометкой SKIP, данные не меняются.
//   6) архив «до 16.10» (миграция 071): status=legacy отдаёт только legacy-партии; правка
//      (line_add) на legacy-партии отклоняется 400 без изменения данных.
// Аутентификация — sealed-cookie, как scripts/smoke-order-matrix.mjs.
// Запуск: node scripts/smoke-deliveries.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query, withTenant, tenantQuery } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
const tq = (sql, params = []) => withTenant(CAB, () => tenantQuery(sql, params));

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  if (!cond) failed++;
};
const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [owner_user_id]);
const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version,
  active_cabinet_id: null, touched_at: Date.now() }, { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
const cookie = `saas_session=${encodeURIComponent(seal)}`;
const get = async (path) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { headers: { cookie } });
  return { status: r.status, data: await r.json() };
};
const post = async (body) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/deliveries`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

const all = await get('deliveries?status=all');
check('GET deliveries 200', all.status === 200, all.data);
const items = all.data.items || [];
const totals = all.data.totals || {};
const legacyResp = await get('deliveries?status=legacy');
check('GET status=legacy 200', legacyResp.status === 200, legacyResp.data);
const legacyItems = legacyResp.data.items || [];
const full = [...items, ...legacyItems];

const [{ n }] = await tq('SELECT count(*)::int AS n FROM tenant.purchases WHERE archived AND deleted_at IS NULL');
check('партий = архивных в БД (all + legacy)', full.length === n, { api: full.length, db: n });
check('totals.waiting+done+legacy = всего', (totals.waiting + totals.done + totals.legacy) === n, { totals, db: n });
check('status=all исключает архив «до 16.10»', items.every((it) => it.status !== 'legacy') && items.length === totals.waiting + totals.done, { count: items.length, totals });
check('status=legacy отдаёт только архивные', legacyItems.length === totals.legacy && legacyItems.every((it) => it.status === 'legacy'), { count: legacyItems.length, totals });

const sums = await tq('SELECT purchase_id, sum(qty_accepted)::int AS s FROM tenant.purchase_receipt_lines GROUP BY 1');
const sumBy = Object.fromEntries(sums.map((r) => [Number(r.purchase_id), r.s]));
const badSum = full.filter((it) => it.accepted !== (sumBy[it.id] || 0));
check('accepted = Σ строк', !badSum.length, badSum.map((i) => i.id));
check('нет закрытых без строк', !full.some((it) => it.status === 'done' && !it.lines.length));
const cat = await get('deliveries?catalog=1&q=ка');
check('catalog 200', cat.status === 200 && Array.isArray(cat.data.catalog), cat.data);

if (CAB === 1) {
  const w = items.find((it) => it.status === 'waiting');
  if (w) {
    const add = await post({ action: 'line_add', purchase_id: w.id, label: 'smoke-тест', qty_accepted: 1, note: 'smoke' });
    check('line_add', add.status === 200 && add.data.line?.id, add.data);
    const id = add.data.line?.id;
    const upd = await post({ action: 'line_update', id, qty_accepted: 2 });
    check('line_update', upd.status === 200 && upd.data.line?.qty_accepted === 2, upd.data);
    const neg = await post({ action: 'line_update', id, qty_accepted: -1 });
    check('отрицательное → 400', neg.status === 400, neg.data);
    const del = await post({ action: 'line_delete', id });
    check('line_delete', del.status === 200, del.data);
  } else console.log('SKIP  нет ждущих партий для обратимой проверки');
  const d = items.find((it) => it.status === 'done' && it.lines.length);
  if (d) {
    const r = await post({ action: 'line_update', id: d.lines[0].id, qty_accepted: d.lines[0].qty_accepted });
    check('закрытую партию править нельзя', r.status === 400, r.data);
  } else console.log('SKIP  нет закрытых партий');
  if (legacyItems.length) {
    const li = legacyItems[0];
    const r = await post({ action: 'line_add', purchase_id: li.id, label: 'smoke-тест-legacy', qty_accepted: 1 });
    check('архивную партию (до 16.10) нельзя править', r.status === 400, r.data);
  } else console.log('SKIP  нет legacy-партий для проверки архива');
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
