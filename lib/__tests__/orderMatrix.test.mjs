// lib/__tests__/orderMatrix.test.mjs — «Матрица заказов» (14.10.2026).
import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderMatrix, emptyRowKeys, periodDates, skuKey } from "../orderMatrix.js";

const today = "2026-10-14";
const dates = periodDates(today, 3); // 11, 12, 13

test("periodDates: N полных дней по вчера, asc", () => {
  assert.deepEqual(dates, ["2026-10-11", "2026-10-12", "2026-10-13"]);
  assert.deepEqual(periodDates("2026-03-01", 2), ["2026-02-27", "2026-02-28"]);
});

const meta = [
  { platform: "wb", sku: 11, name: "Камера", imUrl: "u", article: "CAM-1" },
  { platform: "wb", sku: 12, name: "Пустой активный" },
  { platform: "wb", sku: 13, name: "Снятый без заказов" },
  { platform: "ozon", sku: 21, name: "Регистратор", article: "REG" },
  { platform: "ozon", sku: 22, name: "Снятый с заказами" },
];
const status = { "wb|13|0": "inactive", "ozon|0|22": "inactive" };
const counts = [
  { platform: "wb", sku: 11, date: "2026-10-11", total: 3, cancelled: 1 },
  { platform: "wb", sku: 11, date: "2026-10-13", total: 5, cancelled: 0 },
  { platform: "wb", sku: 11, date: today, total: 2, cancelled: 0 },
  { platform: "wb", sku: 11, date: "2026-10-01", total: 99, cancelled: 0 }, // вне окна
  { platform: "ozon", sku: 21, date: "2026-10-12", total: 4, cancelled: 2 },
  { platform: "ozon", sku: 22, date: "2026-10-12", total: 1, cancelled: 0 },
  { platform: "ozon", sku: 99, date: "2026-10-13", total: 1, cancelled: 0 }, // нет в справочнике
];

test("строки: заказы видны всегда, активные без заказов — да, inactive без заказов — нет", () => {
  const m = buildOrderMatrix({ dates, today, counts, meta, status });
  const keys = m.rows.map((r) => r.key);
  assert.deepEqual(keys, ["wb:11", "ozon:21", "ozon:22", "ozon:99", "wb:12"]);
  const r = m.rows[0];
  assert.equal(r.total, 8);
  assert.equal(r.cancelled, 1);
  assert.equal(r.todayQty, 2);
  assert.equal(r.max, 5);
  assert.deepEqual(r.days["2026-10-11"], { t: 3, c: 1 });
  assert.equal(r.article, "CAM-1");
  assert.equal(m.rows.find((x) => x.key === "ozon:22").inactive, true);
  assert.equal(m.rows.find((x) => x.key === "ozon:99").name, "Ozon 99");
});

test("итоги по дням и allTotal; сегодня не входит в период", () => {
  const m = buildOrderMatrix({ dates, today, counts, meta, status });
  assert.deepEqual(m.totals.byDay, { "2026-10-11": 3, "2026-10-12": 5, "2026-10-13": 6 });
  assert.equal(m.totals.total, 14);
  assert.equal(m.totals.allTotal, 14);
  assert.equal(m.totals.today, 2);
});

test("фильтр площадки", () => {
  const m = buildOrderMatrix({ dates, today, counts, meta, status, platform: "ozon" });
  assert.ok(m.rows.every((r) => r.platform === "ozon"));
  assert.equal(m.totals.allTotal, 6);
});

test("скрытые: прячутся, не входят в итоги, но входят в allTotal; showHidden возвращает с меткой", () => {
  const hidden = new Set([skuKey("wb", 11), skuKey("wb", 12)]);
  const m = buildOrderMatrix({ dates, today, counts, meta, status, hidden });
  assert.equal(m.hiddenCount, 2);
  assert.ok(!m.rows.some((r) => r.key === "wb:11" || r.key === "wb:12"));
  assert.equal(m.totals.total, 6);
  assert.equal(m.totals.today, 0);
  assert.equal(m.totals.allTotal, 14);
  const m2 = buildOrderMatrix({ dates, today, counts, meta, status, hidden, showHidden: true });
  assert.equal(m2.rows.find((r) => r.key === "wb:11").hidden, true);
  assert.equal(m2.totals.total, 6);
});

test("emptyRowKeys: только видимые нескрытые без заказов за период и сегодня", () => {
  const c2 = [...counts, { platform: "wb", sku: 12, date: today, total: 1, cancelled: 0 }];
  assert.deepEqual(emptyRowKeys(buildOrderMatrix({ dates, today, counts, meta, status })), [{ platform: "wb", sku: 12 }]);
  assert.deepEqual(emptyRowKeys(buildOrderMatrix({ dates, today, counts: c2, meta, status })), []);
});
