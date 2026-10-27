// lib/__tests__/paymentCalendar.test.mjs — ядро платёжного календаря (15.10.2026).
import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryOf, monthGrid, summarize, weekSummary, expandRecurring, purchasePayments,
  wbPayoutWindows, ozPayoutWindows, readPayoutSettings, orderPayments,
} from "../paymentCalendar.js";
import { computeExcel } from "../purchaseCalc.js";

test("monthGrid: октябрь 2026 — с Пн 28.09 по Вс 01.11", () => {
  const g = monthGrid("2026-10");
  assert.equal(g.length, 5);
  assert.equal(g[0][0].date, "2026-09-28");
  assert.equal(g[0][0].inMonth, false);
  assert.equal(g[0][3].date, "2026-10-01");
  assert.equal(g[4][6].date, "2026-11-01");
  assert.ok(g.every((w) => w.length === 7));
});

test("monthGrid: февраль 2027 (Пн 1-го) — 4 недели", () => {
  const g = monthGrid("2027-02");
  assert.equal(g[0][0].date, "2027-02-01");
  assert.equal(g.length, 4);
});

test("categoryOf: старые категории ДДС маппятся", () => {
  assert.equal(categoryOf("Закупка"), "supplier");
  assert.equal(categoryOf("ЗП"), "salary");
  assert.equal(categoryOf("Налоги"), "tax");
  assert.equal(categoryOf("что-то своё"), "other");
  assert.equal(categoryOf(null), "other");
});

test("summarize: план/оплачено/осталось/просрочено", () => {
  const rows = [
    { amount: 100, status: "paid", date: "2026-10-01" },
    { amount: 50, status: "planned", date: "2026-10-10" },
    { amount: 30, status: "planned", date: "2026-10-20" },
  ];
  assert.deepEqual(summarize(rows, { today: "2026-10-15" }), { planned: 180, paid: 100, left: 80, overdue: 50 });
  assert.deepEqual(weekSummary(rows), { total: 180, left: 80 });
});

test("expandRecurring: monthly 31-го → последний день месяца", () => {
  const d = expandRecurring({ rule: "monthly", rule_day: 31, date_from: "2026-01-15" }, "2026-01-01", "2026-04-30");
  assert.deepEqual(d, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("expandRecurring: weekly по пятницам, date_to обрезает", () => {
  const d = expandRecurring({ rule: "weekly", rule_day: 5, date_from: "2026-10-01", date_to: "2026-10-20" }, "2026-10-01", "2026-12-31");
  assert.deepEqual(d, ["2026-10-02", "2026-10-09", "2026-10-16"]);
});

test("expandRecurring: every_n_days от date_from", () => {
  const d = expandRecurring({ rule: "every_n_days", every_n: 10, date_from: "2026-10-01" }, "2026-10-05", "2026-10-31");
  assert.deepEqual(d, ["2026-10-11", "2026-10-21", "2026-10-31"]);
});

const PUR = { id: 7, supplier_name: "Фабрика", prepay_yuan: 1000, prepay_rate: 12, qty: 100,
  unit_cost_yuan: 30, exchange_rate: 12.5, logistics_rub_per_unit: 20, logistics_rub: 5,
  order_dt: "2026-10-01", ship_dt: null, plan_ship_dt: "2026-10-20", delivery_dt: null,
  plan_arrival_dt: "2026-11-10", date: "2026-09-30" };

test("purchasePayments: 4 платежа, сумма = Z, даты с фолбэком на план", () => {
  const p = purchasePayments(PUR);
  assert.deepEqual(p.map((x) => [x.key, x.amount, x.date]), [
    ["prepay", 12000, "2026-10-01"],
    ["balance", 25000, "2026-10-20"],
    ["cargo", 2000, "2026-11-10"],
    ["ff", 500, "2026-11-10"],
  ]);
  assert.equal(p.reduce((s, x) => s + x.amount, 0), computeExcel(PUR).Z);
  assert.equal(p[0].ref, "purchase:7:prepay");
  assert.equal(p[0].article, "supplier");
  assert.equal(p[2].article, "cargo");
});

test("purchasePayments: нулевые не создаются, без дат — date партии", () => {
  const p = purchasePayments({ id: 8, qty: 10, unit_cost_yuan: 5, exchange_rate: 10, date: "2026-10-03" });
  assert.deepEqual(p.map((x) => [x.key, x.amount, x.date]), [["balance", 500, "2026-10-03"]]);
});

test("wbPayoutWindows: неделя Пн–Вс → среда следующей", () => {
  const w = wbPayoutWindows("2026-10-01", "2026-10-31", { weekday: 3 });
  const first = w.find((x) => x.winFrom === "2026-09-28");
  assert.deepEqual(first, { ref: "wb:2026-09-28", winFrom: "2026-09-28", winTo: "2026-10-04", payDate: "2026-10-07" });
  assert.ok(w.every((x) => x.payDate >= "2026-10-01" && x.payDate <= "2026-10-31"));
});

test("ozPayoutWindows: 1–15 → 20-е, 16–конец → 5-е следующего", () => {
  const w = ozPayoutWindows("2026-10-01", "2026-10-31", { day1: 20, day2: 5 });
  assert.deepEqual(w, [
    { ref: "ozon:2026-09-2", winFrom: "2026-09-16", winTo: "2026-09-30", payDate: "2026-10-05" },
    { ref: "ozon:2026-10-1", winFrom: "2026-10-01", winTo: "2026-10-15", payDate: "2026-10-20" },
  ]);
});

test("readPayoutSettings: дефолты и кламп", () => {
  assert.deepEqual(readPayoutSettings(null), { wb: { weekday: 3 }, ozon: { day1: 20, day2: 5 } });
  assert.deepEqual(readPayoutSettings({ payouts: { wb: { weekday: 9 }, ozon: { day1: 25 } } }),
    { wb: { weekday: 3 }, ozon: { day1: 25, day2: 5 } });
});

test("orderPayments: оплаты и логистика отправок, refs, статьи, даты", () => {
  const order = { id: 7, order_no: "A-1", order_dt: "2026-10-01", created_at: "2026-09-30" };
  const pays = [
    { id: 1, kind: "prepay", currency: "cny", amount: 4000, rate: 11.46, plan_date: "2026-10-02" },
    { id: 2, kind: "other", currency: "rub", amount: 700, rate: null, plan_date: null },
  ];
  const ships = [
    { id: 5, cargo_rub: 12000, ff_rub: 0, ship_dt: "2026-10-10", eta: "2026-10-25", arrived_dt: null },
  ];
  const r = orderPayments(order, pays, ships);
  assert.deepEqual(r.map((x) => [x.ref, x.article, x.amount, x.date]), [
    ["order:7:pay:1", "supplier", 45840, "2026-10-02"],
    ["order:7:pay:2", "cargo", 700, "2026-10-01"],
    ["order:7:ship:5:cargo", "cargo", 12000, "2026-10-25"],
  ]);
  assert.match(r[0].description, /Заказ A-1 · предоплата/);
});
