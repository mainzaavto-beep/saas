// lib/__tests__/roleGuards.test.mjs — гард прав (спека 2026-10-08 §1): requireRole 'owner'
// остаётся ровно у баланса, настроек, ключей, команды, оплаты и записи премии; «Баланс» GET — тоже owner.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../app/api/cabinets/[id]/", import.meta.url).pathname;
const OWNER_ONLY = new Set(["balance", "settings", "shops", "members", "invites", "billing/pay", "bonus"]);
const MANAGER_FIN = ["dds", "dds-refs", "purchases", "plan", "plan/targets", "plan/approve", "opex", "self-buyouts", "purchase-plan", "deliveries", "payment-calendar"];

function routes(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (n === "route.js") out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).replace(/\/route\.js$/, "");
const all = routes(ROOT).map((p) => ({ key: rel(p), src: readFileSync(p, "utf8") }));

test("requireRole 'owner' только у разрешённого списка", () => {
  const owners = all.filter((r) => /requireRole:\s*['"]owner['"]/.test(r.src)).map((r) => r.key).sort();
  for (const k of owners) assert.ok(OWNER_ONLY.has(k), `неожиданный owner-only роут: ${k}`);
});

test("финансовые роуты пишет менеджер", () => {
  for (const k of MANAGER_FIN) {
    const r = all.find((x) => x.key === k);
    assert.ok(r, `нет роута ${k}`);
    assert.ok(!/requireRole:\s*['"]owner['"]/.test(r.src), `${k} всё ещё owner`);
    assert.ok(/requireRole:\s*['"]manager['"]/.test(r.src), `${k} без requireRole manager`);
  }
});

test("«Баланс»: все экспортируемые методы owner-only, включая GET", () => {
  const src = all.find((x) => x.key === "balance").src;
  const methods = [...src.matchAll(/export const (GET|POST|PUT|DELETE|PATCH)\s*=/g)].length;
  const guards = [...src.matchAll(/requireRole:\s*['"]owner['"]/g)].length;
  assert.equal(guards, methods);
});

test("«Дашборд показателей»: смотреть и сохранять свой вид может любой член кабинета, user_id — из сессии", () => {
  const r = all.find((x) => x.key === "kpi");
  assert.ok(r, "нет роута kpi");
  assert.ok(!/requireRole/.test(r.src), "kpi: личный вид не должен требовать роль");
  assert.ok(/session\.user_id/.test(r.src), "kpi: user_id должен браться из сессии");
  assert.ok(!/body\.user_id|b\.user_id/.test(r.src), "kpi: user_id из тела запроса запрещён");
});
