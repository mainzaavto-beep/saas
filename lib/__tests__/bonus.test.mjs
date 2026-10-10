// lib/__tests__/bonus.test.mjs — ядро премии менеджеров (спека 2026-10-08).
import test from "node:test";
import assert from "node:assert/strict";
import { computeBonus, monthWindow, isValidPeriod, resolveBonusViewer } from "../bonus.js";

const base = { salary: 40000, bonusPct: 0.04, threshold: 0.65, exclusions: [] };
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

test("контрольный пример листа KPI владельца: 146 667 ₽", () => {
  const r = computeBonus({ ...base, salesPlan: 10_000_000, profitPlan: 1_500_000, salesFact: 20_000_000, profitFact: 2_000_000 });
  assert.equal(r.status, "ok");
  near(r.indicators[0].pct, 2);
  near(r.indicators[1].pct, 1.3333);
  near(r.indicators[2].pct, 0.6667);
  near(r.avg, 1.3333);
  assert.equal(r.eligible, true);
  near(r.bonusBase, 80000);
  near(r.bonus, 106666.67);
  near(r.payout, 146666.67);
});

test("порог: один показатель ниже 65 % — бонус 0, оклад платится", () => {
  const r = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 100_000, salesFact: 640_000, profitFact: 100_000 });
  assert.equal(r.indicators[0].below, true);
  assert.equal(r.eligible, false);
  assert.equal(r.bonus, 0);
  assert.equal(r.payout, 40000);
});

test("план не задан или 0 — no_plan, бонус 0", () => {
  for (const p of [{ salesPlan: 0, profitPlan: 100 }, { salesPlan: 100, profitPlan: 0 }, { salesPlan: null, profitPlan: null }]) {
    const r = computeBonus({ ...base, ...p, salesFact: 500, profitFact: 50 });
    assert.equal(r.status, "no_plan");
    assert.equal(r.bonus, 0);
    assert.equal(r.payout, 40000);
  }
});

test("исключение артикула снимает факт и план вместе — % растёт", () => {
  const without = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 200_000, salesFact: 800_000, profitFact: 150_000 });
  const withEx = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 200_000, salesFact: 800_000, profitFact: 150_000,
    exclusions: [{ revenue: 50_000, profit: 5_000, salesPlanOff: 300_000, profitPlanOff: 60_000 }] });
  near(withEx.fact.sales, 750_000);
  near(withEx.plan.sales, 700_000);
  near(withEx.fact.profit, 145_000);
  near(withEx.plan.profit, 140_000);
  assert.ok(withEx.avg > without.avg);
});

test("отрицательная прибыль — бонус 0", () => {
  const r = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 100_000, salesFact: 1_000_000, profitFact: -10_000 });
  assert.equal(r.eligible, false);
  assert.equal(r.bonus, 0);
});

test("нулевые продажи — маржа факта 0, ниже порога", () => {
  const r = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 100_000, salesFact: 0, profitFact: 0 });
  assert.equal(r.fact.margin, 0);
  assert.equal(r.indicators[2].below, true);
  assert.equal(r.bonus, 0);
});

test("monthWindow: текущий месяц по вчера, прошлый целиком, будущий — null", () => {
  assert.deepEqual(monthWindow("2026-10", "2026-10-10"), { from: "2026-10-01", to: "2026-10-09" });
  assert.deepEqual(monthWindow("2026-09", "2026-10-10"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(monthWindow("2026-02", "2026-10-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(monthWindow("2026-10", "2026-10-01"), null);
  assert.equal(monthWindow("2026-11", "2026-10-10"), null);
});

test("isValidPeriod", () => {
  assert.equal(isValidPeriod("2026-10"), true);
  assert.equal(isValidPeriod("2026-13"), false);
  assert.equal(isValidPeriod("2026-1"), false);
  assert.equal(isValidPeriod(null), false);
});

test("resolveBonusViewer: менеджер видит только себя, чужой user_id игнорируется", () => {
  const employees = [{ user_id: 10 }, { user_id: 11 }];
  assert.deepEqual(resolveBonusViewer({ role: "manager", sessionUserId: 10, requestedUserId: 11, employees }), { mode: "self", userId: 10 });
  assert.deepEqual(resolveBonusViewer({ role: "manager", sessionUserId: 12, requestedUserId: null, employees }), { mode: "denied", userId: null });
  assert.deepEqual(resolveBonusViewer({ role: "viewer", sessionUserId: 10, requestedUserId: null, employees }), { mode: "denied", userId: null });
  assert.deepEqual(resolveBonusViewer({ role: "owner", sessionUserId: 1, requestedUserId: 11, employees }), { mode: "owner", userId: 11 });
  assert.deepEqual(resolveBonusViewer({ role: "owner", sessionUserId: 1, requestedUserId: null, employees }), { mode: "owner", userId: 10 });
  assert.deepEqual(resolveBonusViewer({ role: "owner", sessionUserId: 1, requestedUserId: 99, employees }), { mode: "owner", userId: 10 });
  assert.deepEqual(resolveBonusViewer({ role: "owner", sessionUserId: 1, requestedUserId: null, employees: [] }), { mode: "owner", userId: null });
});
