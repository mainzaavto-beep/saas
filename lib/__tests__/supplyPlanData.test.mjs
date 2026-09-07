// lib/__tests__/supplyPlanData.test.mjs — чистая часть адаптера плана поставок
// (спека «Склады 2.0» §4.1, этап 3, хвост задачи 4, ревью раунд 1, 2026-09-07).
import test from "node:test";
import assert from "node:assert/strict";
import { regionKeysFor, assignPositions } from "../supplyPlanData.js";
import { clampDays } from "../supplyDays.js";

test("clampDays: границы 1..365, нечисло → dflt", () => {
  assert.equal(clampDays(0, 30), 1);
  assert.equal(clampDays(-5, 30), 1);
  assert.equal(clampDays(400, 30), 365);
  assert.equal(clampDays(365, 30), 365);
  assert.equal(clampDays(1, 30), 1);
  assert.equal(clampDays(undefined, 30), 30);
  assert.equal(clampDays(null, 14), 1);   // Number(null)=0 — конечное число, зажимается к 1, а не к dflt
  assert.equal(clampDays("abc", 14), 14); // NaN — не конечное число → dflt
  assert.equal(clampDays(15.6, 30), 16); // округление
});

test("regionKeysFor: город из карты CITY_TO_REGIONS", () => {
  assert.deepEqual(regionKeysFor("Москва", []), ["Центральный", "Москва, МО и Дальние регионы"]);
  assert.deepEqual(regionKeysFor("казань", []), ["Приволжский"]);
  // регистр/ё нормализуются
  assert.deepEqual(regionKeysFor("Ростов-на-Дону", []), ["Южный и Северо-Кавказский", "Ростов"]);
});

test("regionKeysFor: город не в карте, но имя входит в название кластера Ozon", () => {
  assert.deepEqual(regionKeysFor("Хабаровск", ["Хабаровск", "Владивосток"]), ["Хабаровск"]);
  // карта + кластер одновременно — объединяются без дублей
  const keys = regionKeysFor("Москва", ["Москва, МО и Дальние регионы", "Санкт-Петербург и СЗО"]);
  assert.deepEqual(keys, ["Центральный", "Москва, МО и Дальние регионы"]);
});

test("regionKeysFor: неизвестный город без совпадающих кластеров → []", () => {
  assert.deepEqual(regionKeysFor("Тьмутаракань", ["Хабаровск"]), []);
  assert.deepEqual(regionKeysFor("", ["Москва"]), []);
  assert.deepEqual(regionKeysFor(null, []), []);
});

// ── assignPositions: разбор group.lines[].qty на конкретные позиции ff_inventory ──

test("assignPositions: одна позиция не выдаётся дважды между двумя группами Ozon", () => {
  // Один источник (locationId=10) с двумя позициями ff_inventory на товар ozon:1,
  // но ДВЕ группы назначения (разные warehouseKey — как в plan для двух складов
  // FBO одного товара с общим ФФ-источником).
  const sources = {
    "ozon:1": [{
      locationId: 10, city: "Москва", regionKeys: [], available: 8,
      positions: [{ ffInventoryId: 501, qty: 5 }, { ffInventoryId: 502, qty: 3 }],
    }],
  };
  const groups = [
    { locationId: 10, platform: "ozon", warehouseKey: "wA", warehouseName: "Склад А",
      lines: [{ itemId: "ozon:1", itemName: "Товар", skuKey: "1", need: 5, qty: 5 }] },
    { locationId: 10, platform: "ozon", warehouseKey: "wB", warehouseName: "Склад Б",
      lines: [{ itemId: "ozon:1", itemName: "Товар", skuKey: "1", need: 3, qty: 3 }] },
  ];
  const enriched = assignPositions(sources, groups, { 10: "Москва, ФФ-1" });

  assert.equal(enriched.length, 2);
  assert.equal(enriched[0].locationName, "Москва, ФФ-1");
  const posA = enriched[0].lines[0].positions;
  const posB = enriched[1].lines[0].positions;
  // группа А выбирает первую позицию целиком (5 из 5)
  assert.deepEqual(posA, [{ ffInventoryId: 501, qty: 5 }]);
  // группа Б получает остаток — вторую позицию (502), НЕ повторяет 501
  assert.deepEqual(posB, [{ ffInventoryId: 502, qty: 3 }]);
  // суммарно позиции не пересекаются и не превышают доступное (8)
  const totalQty = [...posA, ...posB].reduce((s, p) => s + p.qty, 0);
  assert.equal(totalQty, 8);
  const usedIds = [...posA, ...posB].map((p) => p.ffInventoryId);
  assert.equal(new Set(usedIds).size, usedIds.length); // без повторов
});

test("assignPositions: availByKey подставляется даже если позиций не хватило на всё qty", () => {
  const sources = {
    "wb:9": [{ locationId: 1, city: null, regionKeys: [], available: 2, positions: [{ ffInventoryId: 1, qty: 2 }] }],
  };
  const groups = [
    { locationId: 1, platform: "wb", warehouseKey: "wb", warehouseName: "WB",
      lines: [{ itemId: "wb:9", itemName: "Т", skuKey: "9", need: 10, qty: 10 }] },
  ];
  const [g] = assignPositions(sources, groups, {});
  assert.equal(g.lines[0].available, 2);
  assert.deepEqual(g.lines[0].positions, [{ ffInventoryId: 1, qty: 2 }]); // выдано сколько было
});

test("assignPositions: пустые sources/groups не падают", () => {
  assert.deepEqual(assignPositions({}, [], {}), []);
  assert.deepEqual(assignPositions(undefined, undefined, undefined), []);
});
