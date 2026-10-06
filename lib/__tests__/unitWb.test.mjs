// lib/__tests__/unitWb.test.mjs — логистика WB в юнитке по факту отчёта реализации
// (F прямая на проданную + R на невыкуп × (1 − b)/b, зеркало Ozon-модели).
import test from "node:test";
import assert from "node:assert/strict";
import { calcWB, COLUMNS_WB } from "../unit.js";

const base = {
  priceSeller: 2000, discount: 0.5, spp: 0.2, commissionRate: 0.25,
  adsRate: 0.1, cost: 300, defectRate: 0, usnRate: 0.06, vatRate: 5 / 105,
};

test("тождество: при фактических F, R, b логистика = Σлогистики окна / продано", () => {
  // продано 80, невыкупов 86; Σлог(продажи) = 7360 → F = 92; Σлог(невыкупы) = 12384 → R = 144
  const r = calcWB({ ...base, logisticsFbo: 92, returnLogistics: 144, buyout: 80 / 166 });
  assert.equal(r.logistics, Math.round(((7360 + 12384) / 80) * 100) / 100);
});

test("галочка «с % выкупа» OFF (b = 1) → логистика = F", () => {
  const r = calcWB({ ...base, logisticsFbo: 92, returnLogistics: 144, buyout: 1 });
  assert.equal(r.logistics, 92);
});

test("ручная прямая логистика двигает прибыль рубль в рубль", () => {
  const a = calcWB({ ...base, logisticsFbo: 92, returnLogistics: 144, buyout: 0.5 });
  const b = calcWB({ ...base, logisticsFbo: 192, returnLogistics: 144, buyout: 0.5 });
  assert.equal(Math.round((a.profit - b.profit) * 100) / 100, 100);
});

test("без факта логистики — прежняя формула от литража (оценка)", () => {
  const r = calcWB({ ...base, buyout: 0.8 });
  assert.equal(r.logistics, Math.round((50 / 0.8) * 1.6 * 100) / 100);
});

test("returnLogistics не задан при факте F → невыкуп 0", () => {
  const r = calcWB({ ...base, logisticsFbo: 92, buyout: 0.5 });
  assert.equal(r.logistics, 92);
});

test("колонки: прямая логистика — вход, невыкуп и логистика на продажу — расчётные", () => {
  const by = Object.fromEntries(COLUMNS_WB.map((c) => [c.key, c]));
  assert.equal(by.logisticsFbo?.kind, "input");
  assert.equal(by.returnLogistics?.kind, "calc");
  assert.equal(by.logistics?.kind, "calc");
});
