// lib/__tests__/costCalc.test.mjs — калькулятор себестоимости (спека 2026-10-22-cost-calculator-design.md).
import test from "node:test";
import assert from "node:assert/strict";
import { calcCost, parseCalcInput, CALC_FIELDS } from "../costCalc.js";

const EX = { qty: 100, weight_kg: 0.5, price_cny: 30, china_delivery_cny: 200,
  cargo_usd_per_kg: 3.5, ff_logistics_rub: 5000, rate_cny: 12, rate_usd: 90 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("calcCost: ручной пример", () => {
  const r = calcCost(EX);
  const by = Object.fromEntries(r.lines.map((l) => [l.key, l]));
  close(by.goods.rub, 36000);   // 30 ¥ × 100 × 12
  close(by.china.rub, 2400);    // 200 ¥ × 12
  close(by.cargo.rub, 15750);   // 0,5 кг × 100 × 3,5 $ × 90
  close(by.ff.rub, 5000);
  close(r.totalRub, 59150);
  close(r.unitRub, 591.5);
  close(r.weightTotal, 50);
  close(by.cargo.perUnit, 157.5);
  close(by.goods.share, 36000 / 59150);
  close(r.lines.reduce((s, l) => s + l.share, 0), 1);
});

test("calcCost: строки и пустое — нули, без количества за штуку нет", () => {
  const r = calcCost({ ...EX, qty: "" });
  assert.equal(r.unitRub, null);
  assert.ok(r.lines.every((l) => l.perUnit === null));
  close(r.totalRub, 2400 + 5000);           // товар и карго зависят от количества
  const s = calcCost({ ...Object.fromEntries(Object.entries(EX).map(([k, v]) => [k, String(v)])) });
  close(s.unitRub, 591.5);
  const z = calcCost({});
  assert.equal(z.totalRub, 0);
  assert.ok(z.lines.every((l) => l.share === null));
});

test("parseCalcInput: проверки", () => {
  assert.ok(parseCalcInput({ ...EX, name: "  " }).error);
  assert.ok(parseCalcInput({ ...EX, name: "x".repeat(201) }).error);
  assert.ok(parseCalcInput({ ...EX, name: "a", qty: -1 }).error);
  assert.ok(parseCalcInput({ ...EX, name: "a", rate_usd: "abc" }).error);
  const ok = parseCalcInput({ ...EX, name: " Плед ", price_cny: "", note: " к " });
  assert.equal(ok.value.name, "Плед");
  assert.equal(ok.value.note, "к");
  assert.equal(ok.value.price_cny, 0);
  for (const k of CALC_FIELDS) assert.equal(typeof ok.value[k], "number");
});
