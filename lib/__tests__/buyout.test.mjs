// lib/__tests__/buyout.test.mjs — процент выкупа WB когортно по дате заказа
// (спека docs/superpowers/specs/2026-10-11-buyout-page-design.md).
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWbOrder, buyoutStats, aggregateBuyout, weeklyBuyout, weekStart, sortSizes,
  CANCEL_SETTLE_DAYS, MIN_RESOLVED,
} from "../buyout.js";

const ASOF = "2026-10-12";
const base = { srid: "x", nmId: 1, article: "A1", name: "Бюстгальтер", size: "M", orderDate: "2026-09-01",
  isCancel: false, cancelAt: null, hasSale: false, hasReturn: false, refusedLogistics: false, selfBuyout: false };
const row = (o) => ({ ...base, ...o });

test("порядок вёдер: самовыкуп важнее всего, возврат важнее продажи", () => {
  assert.equal(classifyWbOrder(row({ selfBuyout: true, hasSale: true }), ASOF), "self");
  assert.equal(classifyWbOrder(row({ hasSale: true, hasReturn: true }), ASOF), "returned");
  assert.equal(classifyWbOrder(row({ hasSale: true }), ASOF), "sold");
  assert.equal(classifyWbOrder(row({ isCancel: true, refusedLogistics: true }), ASOF), "refused");
});

test("отмена без логистики: старше 7 дней — до отгрузки, моложе или ровно 7 — в пути", () => {
  assert.equal(CANCEL_SETTLE_DAYS, 7);
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: "2026-10-04T00:00:00" }), ASOF), "cancelledPre");
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: "2026-10-05T00:00:00" }), ASOF), "pending");
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: null }), ASOF), "pending");
});

test("заказ без развязки — в пути", () => {
  assert.equal(classifyWbOrder(row({}), ASOF), "pending");
});

test("buyoutStats: знаменатель без в-пути и отмен до отгрузки; null при нуле", () => {
  const s = buyoutStats({ ordered: 10, self: 1, returned: 1, sold: 3, refused: 4, cancelledPre: 1, pending: 0 });
  assert.equal(s.resolved, 8);
  assert.equal(s.buyoutPct, 37.5);
  assert.equal(s.immature, false);
  assert.equal(s.lowSample, true);
  const z = buyoutStats({ ordered: 2, self: 0, returned: 0, sold: 0, refused: 0, cancelledPre: 0, pending: 2 });
  assert.equal(z.buyoutPct, null);
  assert.equal(z.pendingShare, 1);
  assert.equal(z.immature, true);
});

test("lowSample снимается с MIN_RESOLVED доехавших; immature при доле в пути > 5 %", () => {
  const s = buyoutStats({ ordered: 22, self: 0, returned: 0, sold: MIN_RESOLVED, refused: 0, cancelledPre: 0, pending: 2 });
  assert.equal(s.lowSample, false);
  assert.equal(s.immature, true); // 2/22 ≈ 9 %
});

test("aggregateBuyout: размеры суммируются в товар, товары — в KPI", () => {
  const rows = [
    row({ srid: "1", size: "S", hasSale: true }),
    row({ srid: "2", size: "S", isCancel: true, refusedLogistics: true }),
    row({ srid: "3", size: "M", hasSale: true }),
    row({ srid: "4", size: "M", hasSale: true, hasReturn: true }),
    row({ srid: "5", nmId: 2, size: "0", hasSale: true }),
  ];
  const { kpi, items } = aggregateBuyout(rows, ASOF);
  assert.equal(kpi.ordered, 5);
  assert.equal(kpi.sold, 3);
  assert.equal(kpi.resolved, 5);
  assert.equal(kpi.buyoutPct, 60);
  const bra = items.find((i) => i.nmId === 1);
  assert.equal(bra.ordered, 4);
  assert.deepEqual(bra.sizes.map((s) => s.size), ["S", "M"]);
  assert.equal(bra.sizes[0].buyoutPct, 50);
  assert.equal(bra.sizes[1].returned, 1);
  for (const k of ["ordered", "sold", "refused", "returned", "pending", "cancelledPre", "self"]) {
    assert.equal(bra.sizes.reduce((a, s) => a + s[k], 0), bra[k], k);
  }
  assert.deepEqual(items.find((i) => i.nmId === 2).sizes, []);
});

test("sortSizes: буквенные по росту, числовые по числе, прочие в конце", () => {
  assert.deepEqual(sortSizes(["XL", "S", "M", "XS", "L"]), ["XS", "S", "M", "L", "XL"]);
  assert.deepEqual(sortSizes(["75B", "70A", "80C"]), ["70A", "75B", "80C"]);
  assert.deepEqual(sortSizes(["M", "ONE", "S"]), ["S", "M", "ONE"]);
});

test("weekStart — понедельник", () => {
  assert.equal(weekStart("2026-10-12"), "2026-10-12"); // понедельник
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // воскресенье
  assert.equal(weekStart("2026-10-08"), "2026-10-05");
});

test("weeklyBuyout: 13 недель подряд с пустыми, размеры по неделям, фильтр товара", () => {
  const rows = [
    row({ srid: "1", orderDate: "2026-10-06", size: "S", hasSale: true }),
    row({ srid: "2", orderDate: "2026-10-07", size: "M", isCancel: true, refusedLogistics: true }),
    row({ srid: "3", orderDate: "2026-09-29", nmId: 2, size: "0", hasSale: true }),
  ];
  const all = weeklyBuyout(rows, ASOF);
  assert.equal(all.weeks.length, 13);
  assert.equal(all.weeks[12].week, "2026-10-12");
  assert.equal(all.weeks[11].week, "2026-10-05");
  assert.equal(all.weeks[11].resolved, 2);
  assert.equal(all.weeks[10].sold, 1);
  assert.equal(all.weeks[0].ordered, 0);
  const one = weeklyBuyout(rows, ASOF, { nmId: 1 });
  assert.equal(one.weeks[10].ordered, 0);
  assert.deepEqual(one.sizeList, ["S", "M"]);
  assert.equal(one.weeks[11].sizes.S.buyoutPct, 100);
  assert.equal(one.weeks[11].sizes.M.buyoutPct, 0);
});
