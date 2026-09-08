import test from "node:test";
import assert from "node:assert/strict";
import { buildMatrix, positionKeyOf, buildPlaceCards, buildSignals, planInventoryAdjust } from "../warehousesMetrics.js";

const settings = { targetDays: 30, minDays: 14 };
const locations = [
  { id: 1, name: "ФФ Москва", city: "Москва", loc_type: "ff", is_active: true, wb_warehouse_id: 501, ozon_warehouse_id: 9001 },
  { id: 2, name: "ФФ Казань", city: "Казань", loc_type: "ff", is_active: true, wb_warehouse_id: null, ozon_warehouse_id: null },
  { id: 3, name: "Архив", city: null, loc_type: "stock", is_active: false, wb_warehouse_id: null, ozon_warehouse_id: null },
];
const positions = [
  { id: 11, internal_name: "Баклажан партия 1", qty: 10, unit_cost: 100, location_id: 1,
    skus: [{ platform: "wb", sku_key: 111, name: "Баклажан-цвет", im_url: "x" }, { platform: "ozon", sku_key: 222, name: "Баклажан", im_url: null }] },
  { id: 12, internal_name: "Баклажан партия 2", qty: 5, unit_cost: 100, location_id: 1,
    skus: [{ platform: "wb", sku_key: 111, name: "Баклажан-цвет", im_url: "x" }, { platform: "ozon", sku_key: 222, name: "Баклажан", im_url: null }] },
  { id: 13, internal_name: "Баклажан партия 3", qty: 7, unit_cost: 100, location_id: 2,
    skus: [{ platform: "wb", sku_key: 111, name: "Баклажан-цвет", im_url: "x" }] },
  { id: 14, internal_name: "Без артикула", qty: 3, unit_cost: 50, location_id: 2, skus: [] },
  { id: 15, internal_name: "Старое", qty: 0, unit_cost: 50, location_id: 3, skus: [] },
];
const fbsStock = [
  { platform: "wb", warehouse_id: 501, sku_key: 111, present: 12, reserved: 0 },
  { platform: "ozon", warehouse_id: 9001, sku_key: 222, present: 15, reserved: 1 },
];
const fbsVelocity = [
  { platform: "wb", warehouse_id: 501, sku_key: 111, orders_qty: 28 },   // 1/дн
  { platform: "ozon", warehouse_id: 9001, sku_key: 222, orders_qty: 56 }, // 2/дн
];
const fboTargets = [
  { platform: "wb", warehouseKey: 507, warehouseName: "Коледино", regionKey: null, skuKey: 111, itemName: "Баклажан-цвет",
    stock: 20, inTransit: 8, ordersQty: 56, days: 28 },
];
const gaps = [
  { id: 1, platform: "wb", warehouse_id: 501, sku_key: 111, qty: 2, reason: "no_location", src_kind: "wb_fbs_task", src_ref: "r1", first_seen_at: "2026-09-07T10:00:00Z" },
  { id: 2, platform: "ozon", warehouse_id: 9001, sku_key: 999, qty: 1, reason: "no_item", src_kind: "ozon_posting", src_ref: "p1", first_seen_at: "2026-09-07T10:00:00Z" },
];

test("positionKeyOf: пара артикулов, только один, без артикулов", () => {
  assert.equal(positionKeyOf(positions[0]), "111|222");
  assert.equal(positionKeyOf(positions[2]), "111|-");
  assert.equal(positionKeyOf(positions[3]), "pos:14");
});

test("buildMatrix: колонки — активные места, неактивное с нулём скрыто, FBO из targets", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  assert.deepEqual(m.columns.map((c) => c.key), ["ff:2", "ff:1", "fbo:wb:507"]);
  assert.equal(m.columns[1].wbBound, true);
  assert.equal(m.columns[0].wbBound, false);
});

test("buildMatrix: ячейка ФФ — own по двум партиям, Δ по WB и Ozon, скорость и покрытие", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const row = m.rows.find((r) => r.itemKey === "111|222");
  const c = row.cells["ff:1"];
  assert.equal(c.own, 15);
  assert.deepEqual(c.mp.wb, { present: 12, delta: 3 });
  assert.deepEqual(c.mp.ozon, { present: 15, delta: 0 });
  assert.equal(c.velocity, 3);            // 1 + 2 в день
  assert.equal(c.coverage, 5);            // 15 / 3
  assert.deepEqual(c.flags, { delta: true, low: true });
});

test("buildMatrix: компонента объединяет позиции по общему артикулу — positionIds, skuKeys, ячейка места без привязки", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  // Позиции 11,12 (111|222) и 13 (111|-) делят WB-артикул 111 — одна строка "111|222".
  const row = m.rows.find((r) => r.itemKey === "111|222");
  assert.deepEqual(row.positionIds, [11, 12, 13]);
  assert.deepEqual(row.skuKeys, { wb: [111], ozon: [222] });
  const c = row.cells["ff:2"];
  assert.equal(c.own, 7);
  assert.deepEqual(c.mp, { wb: null, ozon: null });
  assert.equal(c.velocity, 0);
  assert.equal(c.coverage, null);
  assert.deepEqual(c.flags, { delta: false, low: false });
});

test("buildMatrix: компонента через общий Ozon-артикул — skuKeys.wb из двух ключей, present суммируется", () => {
  const locs = [{ id: 1, name: "ФФ 1", city: "A", loc_type: "ff", is_active: true, wb_warehouse_id: 501, ozon_warehouse_id: 9001 }];
  const pos = [
    { id: 21, internal_name: "Товар А", qty: 6, unit_cost: 10, location_id: 1,
      skus: [{ platform: "wb", sku_key: 301, name: "Товар", im_url: null }, { platform: "ozon", sku_key: 401, name: "Товар", im_url: null }] },
    { id: 22, internal_name: "Товар Б", qty: 4, unit_cost: 10, location_id: 1,
      skus: [{ platform: "wb", sku_key: 302, name: "Товар", im_url: null }, { platform: "ozon", sku_key: 401, name: "Товар", im_url: null }] },
  ];
  const stock = [
    { platform: "wb", warehouse_id: 501, sku_key: 301, present: 5, reserved: 0 },
    { platform: "wb", warehouse_id: 501, sku_key: 302, present: 3, reserved: 0 },
  ];
  const m = buildMatrix({ settings, positions: pos, locations: locs, fbsStock: stock, fbsVelocity: [], fboTargets: [], gaps: [] });
  assert.equal(m.rows.length, 1);
  const row = m.rows[0];
  assert.deepEqual(row.skuKeys, { wb: [301, 302], ozon: [401] });
  assert.deepEqual(row.positionIds, [21, 22]);
  const c = row.cells["ff:1"];
  assert.equal(c.own, 10);
  assert.deepEqual(c.mp.wb, { present: 8, delta: 2 }); // 5 + 3 по обоим WB-артикулам
});

test("buildMatrix: FBO-ячейка и итоги строки, gaps по артикулу", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const row = m.rows.find((r) => r.itemKey === "111|222");
  assert.deepEqual(row.cells["fbo:wb:507"], { stock: 20, inTransit: 8, velocity: 2, coverage: 14, low: false });
  // own = 15 (ff:1, партии 11+12) + 7 (ff:2, партия 13) — все три позиции теперь одна строка.
  assert.deepEqual(row.totals, { own: 22, mp: 27, fbo: 28, gapsQty: 2, gapsCount: 1 });
  assert.equal(row.problem, true);
  const plain = m.rows.find((r) => r.itemKey === "pos:14");
  assert.equal(plain.name, "Без артикула");
  assert.deepEqual(plain.totals, { own: 3, mp: 0, fbo: 0, gapsQty: 0, gapsCount: 0 });
  assert.equal(plain.problem, false);
});

test("buildMatrix: проблемные строки первыми, затем по имени; пустой вход — пустая матрица", () => {
  const m = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  assert.equal(m.rows[0].problem, true);
  assert.equal(m.rows[m.rows.length - 1].problem, false);
  const e = buildMatrix({ settings, positions: [], locations: [], fbsStock: [], fbsVelocity: [], fboTargets: [], gaps: [] });
  assert.deepEqual(e, { columns: [], rows: [] });
});

test("buildMatrix: место с привязкой, но без снимка fbsStock → present:null, flags.delta false", () => {
  const locs = [{ id: 1, name: "ФФ 1", city: "A", loc_type: "ff", is_active: true, wb_warehouse_id: 502, ozon_warehouse_id: null }];
  const pos = [{ id: 1, internal_name: "Товар", qty: 4, unit_cost: 10, location_id: 1, skus: [{ platform: "wb", sku_key: 100, name: "Товар", im_url: null }] }];
  const m = buildMatrix({ settings, positions: pos, locations: locs, fbsStock: [], fbsVelocity: [], fboTargets: [], gaps: [] });
  const c = m.rows[0].cells["ff:1"];
  assert.equal(c.own, 4);
  assert.deepEqual(c.mp.wb, { present: null, delta: null });
  assert.deepEqual(c.flags, { delta: false, low: false });
});

test("buildMatrix: место с привязкой и снимком, но SKU не в нём → present:0, flags.delta true", () => {
  const locs = [{ id: 1, name: "ФФ 1", city: "A", loc_type: "ff", is_active: true, wb_warehouse_id: 501, ozon_warehouse_id: null }];
  const pos = [{ id: 2, internal_name: "Другой", qty: 5, unit_cost: 10, location_id: 1, skus: [{ platform: "wb", sku_key: 999, name: "Другой", im_url: null }] }];
  const stock = [{ platform: "wb", warehouse_id: 501, sku_key: 111, present: 10, reserved: 0 }];
  const m = buildMatrix({ settings, positions: pos, locations: locs, fbsStock: stock, fbsVelocity: [], fboTargets: [], gaps: [] });
  const c = m.rows[0].cells["ff:1"];
  assert.equal(c.own, 5);
  assert.deepEqual(c.mp.wb, { present: 0, delta: 5 });
  assert.deepEqual(c.flags, { delta: true, low: false });
});

test("buildMatrix: привязанное место со снимком, own=0 и present=0 — ячейки нет (подтверждённый ноль не шумит)", () => {
  const locs = [
    { id: 1, name: "ФФ А", city: "A", loc_type: "ff", is_active: true, wb_warehouse_id: 601, ozon_warehouse_id: null },
    { id: 2, name: "ФФ Б", city: "B", loc_type: "ff", is_active: true, wb_warehouse_id: 602, ozon_warehouse_id: null },
  ];
  const pos = [{ id: 41, internal_name: "Товар", qty: 5, unit_cost: 10, location_id: 1,
    skus: [{ platform: "wb", sku_key: 700, name: "Товар", im_url: null }] }];
  // Снимок по складу 602 есть (другой артикул), по нашему — подтверждённый ноль: own=0, present=0.
  const stock = [{ platform: "wb", warehouse_id: 602, sku_key: 999, present: 4, reserved: 0 }];
  const m = buildMatrix({ settings, positions: pos, locations: locs, fbsStock: stock, fbsVelocity: [], fboTargets: [], gaps: [] });
  const row = m.rows[0];
  assert.equal(row.cells["ff:2"], undefined, "own=0 и present=0 → ячейки быть не должно");
  assert.equal(row.cells["ff:1"].own, 5, "своё место с остатком — ячейка на месте");
});

test("buildMatrix + buildPlaceCards + buildSignals: own=0 на привязанном месте при present>0 на МП — реальное расхождение", () => {
  const locs = [
    { id: 1, name: "ФФ А", city: "A", loc_type: "ff", is_active: true, wb_warehouse_id: 601, ozon_warehouse_id: null },
    { id: 2, name: "ФФ Б", city: "B", loc_type: "ff", is_active: true, wb_warehouse_id: 602, ozon_warehouse_id: null },
  ];
  const pos = [{ id: 31, internal_name: "Товар", qty: 5, unit_cost: 10, location_id: 1,
    skus: [{ platform: "wb", sku_key: 700, name: "Товар", im_url: null }] }];
  const stock = [{ platform: "wb", warehouse_id: 602, sku_key: 700, present: 9, reserved: 0 }];

  const m = buildMatrix({ settings, positions: pos, locations: locs, fbsStock: stock, fbsVelocity: [], fboTargets: [], gaps: [] });
  const row = m.rows[0];
  const cB = row.cells["ff:2"];
  assert.ok(cB, "ячейка ff:2 создаётся из-за снимка на МП, хотя own=0 (позиции только на ff:1)");
  assert.equal(cB.own, 0);
  assert.deepEqual(cB.mp.wb, { present: 9, delta: -9 });
  assert.equal(cB.flags.delta, true);

  const { places } = buildPlaceCards({ settings, positions: pos, locations: locs, sellerWarehouses: [], fbsStock: stock, fbsVelocity: [], fboTargets: [], gaps: [], docs: [] });
  const placeB = places.find((p) => p.id === 2);
  assert.deepEqual(placeB.problems.discrepancies, [{ itemKey: row.itemKey, name: "Товар", platform: "wb", own: 0, present: 9, delta: -9 }]);

  const s = buildSignals({ matrix: m, gaps: [], docs: [], settings, now: new Date("2026-09-08T12:00:00Z") });
  const disc = s.find((x) => x.kind === "discrepancy");
  assert.equal(disc.count, 1);
});

test("buildPlaceCards + buildSignals: нет снимка по складу вовсе — не расхождение (delta=null не считается)", () => {
  const locs = [{ id: 1, name: "ФФ 1", city: "A", loc_type: "ff", is_active: true, wb_warehouse_id: 502, ozon_warehouse_id: null }];
  const pos = [{ id: 1, internal_name: "Товар", qty: 4, unit_cost: 10, location_id: 1, skus: [{ platform: "wb", sku_key: 100, name: "Товар", im_url: null }] }];
  const { places } = buildPlaceCards({ settings, positions: pos, locations: locs, sellerWarehouses: [], fbsStock: [], fbsVelocity: [], fboTargets: [], gaps: [], docs: [] });
  const p1 = places.find((p) => p.id === 1);
  assert.deepEqual(p1.problems.discrepancies, []);

  const matrix = buildMatrix({ settings, positions: pos, locations: locs, fbsStock: [], fbsVelocity: [], fboTargets: [], gaps: [] });
  const s = buildSignals({ matrix, gaps: [], docs: [], settings, now: new Date("2026-09-08T12:00:00Z") });
  assert.equal(s.find((x) => x.kind === "discrepancy"), undefined);
});

test("buildPlaceCards: unbound проверяется по всем locations, не только по колонкам матрицы", () => {
  const locs = [
    { id: 1, name: "ФФ Москва", city: "Москва", loc_type: "ff", is_active: true, wb_warehouse_id: 501, ozon_warehouse_id: null },
    { id: 5, name: "Неактивный склад", city: null, loc_type: "stock", is_active: false, wb_warehouse_id: null, ozon_warehouse_id: 9002 },
  ];
  const pos = [{ id: 1, internal_name: "Т", qty: 2, unit_cost: 10, location_id: 1, skus: [{ platform: "wb", sku_key: 100, name: "Т", im_url: null }] }];
  const sw = [{ platform: "ozon", warehouse_id: 9002, name: "Склад Ozon", kind: "fbs", is_active: true }];
  const { places } = buildPlaceCards({ settings, positions: pos, locations: locs, sellerWarehouses: sw, fbsStock: [], fbsVelocity: [], fboTargets: [], gaps: [], docs: [] });
  // Место 5 неактивно и без остатка — не попадает в matrix.columns, но склад 9002 к нему привязан.
  assert.equal(places.some((p) => p.unbound), false);
});

test("buildPlaceCards: FBO — low и агрегаты из одного источника, без задвоения при общем sku", () => {
  const locs = [{ id: 1, name: "ФФ А", city: "A", loc_type: "ff", is_active: true, wb_warehouse_id: 501, ozon_warehouse_id: null }];
  const pos = [
    { id: 41, internal_name: "Партия 1", qty: 3, unit_cost: 10, location_id: 1, skus: [{ platform: "wb", sku_key: 800, name: "Товар", im_url: null }] },
    { id: 42, internal_name: "Партия 2", qty: 2, unit_cost: 10, location_id: 1, skus: [{ platform: "wb", sku_key: 800, name: "Товар", im_url: null }] },
  ];
  const targets = [{ platform: "wb", warehouseKey: 700, warehouseName: "Электросталь", regionKey: null, skuKey: 800, itemName: "Товар",
    stock: 5, inTransit: 0, ordersQty: 28, days: 28 }]; // velocity=1, coverage=5 < minDays(14) → low
  const { fboWarehouses } = buildPlaceCards({ settings, positions: pos, locations: locs, sellerWarehouses: [], fbsStock: [], fbsVelocity: [], fboTargets: targets, gaps: [], docs: [] });
  assert.equal(fboWarehouses.length, 1);
  assert.equal(fboWarehouses[0].low.length, 1);
  assert.equal(fboWarehouses[0].units, 5);
  assert.equal(fboWarehouses[0].coverage, 5);

  const matrix = buildMatrix({ settings, positions: pos, locations: locs, fbsStock: [], fbsVelocity: [], fboTargets: targets, gaps: [] });
  const s = buildSignals({ matrix, gaps: [], docs: [], settings, now: new Date("2026-09-08T12:00:00Z") });
  assert.equal(s.find((x) => x.kind === "low_coverage").count, 1);
});

const sellerWarehouses = [
  { platform: "wb", warehouse_id: 501, name: "ФФ Москва (WB)", kind: "fbs", is_active: true },
  { platform: "ozon", warehouse_id: 9001, name: "ФФ Москва (Ozon)", kind: "fbs", is_active: true },
  { platform: "ozon", warehouse_id: 9002, name: "Уфа", kind: "fbs", is_active: true },
];
const docs = [
  { id: 1, platform: "wb", status: "shipped", shipped_at: "2026-08-20T10:00:00Z", ship_dt: "2026-08-20", dest_warehouse_id: 507, dest_warehouse: "Коледино" },
  { id: 2, platform: "wb", status: "shipped", shipped_at: "2026-09-07T10:00:00Z", ship_dt: "2026-09-07", dest_warehouse_id: 507, dest_warehouse: "Коледино" },
  { id: 3, platform: "wb", status: "accepted", shipped_at: "2026-08-01T10:00:00Z", ship_dt: "2026-08-01", dest_warehouse_id: 507, dest_warehouse: "Коледино" },
];
const now = new Date("2026-09-08T12:00:00Z");

test("buildPlaceCards: карточка места — привязки, единицы, стоимость, проблемы; непривязанный склад — отдельная запись", () => {
  const { places, fboWarehouses } = buildPlaceCards({ settings, positions, locations, sellerWarehouses, fbsStock, fbsVelocity, fboTargets, gaps, docs });
  const msk = places.find((p) => p.id === 1);
  assert.deepEqual(msk.bindings, { wb: { warehouse_id: 501, name: "ФФ Москва (WB)" }, ozon: { warehouse_id: 9001, name: "ФФ Москва (Ozon)" } });
  assert.equal(msk.positions, 2);
  assert.equal(msk.units, 15);
  assert.equal(msk.value, 1500);
  assert.equal(msk.velocity, 3);
  assert.equal(msk.coverage, 5);
  assert.deepEqual(msk.problems.discrepancies, [{ itemKey: "111|222", name: "Баклажан-цвет", platform: "wb", own: 15, present: 12, delta: 3 }]);
  assert.deepEqual(msk.problems.gaps.map((g) => g.id), [1, 2]);
  assert.deepEqual(msk.problems.low.map((l) => l.itemKey), ["111|222"]);
  const kzn = places.find((p) => p.id === 2);
  assert.deepEqual(kzn.bindings, { wb: null, ozon: null });
  assert.equal(kzn.units, 10);
  const ufa = places.find((p) => p.unbound);
  assert.equal(ufa.name, "Уфа");
  assert.equal(ufa.id, null);
  assert.equal(places.some((p) => p.id === 3), false); // неактивное место без остатка скрыто
  assert.equal(fboWarehouses.length, 1);
  assert.equal(fboWarehouses[0].name, "Коледино");
  assert.equal(fboWarehouses[0].units, 20);
  assert.equal(fboWarehouses[0].inTransit, 8);
  assert.equal(fboWarehouses[0].coverage, 14);
  assert.deepEqual(fboWarehouses[0].openDocs.map((d) => d.id), [1, 2]);
});

test("buildSignals: четыре сигнала с правильными счётчиками и уровнями", () => {
  const matrix = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const s = buildSignals({ matrix, gaps, docs, settings, now });
  const byKind = Object.fromEntries(s.map((x) => [x.kind, x]));
  assert.equal(byKind.discrepancy.count, 1);
  assert.equal(byKind.discrepancy.level, "warn");
  assert.equal(byKind.gaps.count, 2);
  assert.equal(byKind.gaps.level, "crit");
  assert.equal(byKind.waiting_accept.count, 1);         // только документ 1 (19 дней), не 2 и не accepted
  assert.deepEqual(byKind.waiting_accept.items.map((d) => d.id), [1]);
  assert.equal(byKind.low_coverage.count, 1);           // ФФ Москва: покрытие 5 < 14; FBO 14 — не ниже
  assert.match(byKind.low_coverage.items[0].text, /Баклажан-цвет.*ФФ Москва.*5 дн/);
  assert.equal(byKind.low_coverage.level, "crit");      // 5 < 14/2
});

test("buildSignals: без проблем — сигналы с count 0 не возвращаются", () => {
  const matrix = buildMatrix({ settings, positions: [], locations: [], fbsStock: [], fbsVelocity: [], fboTargets: [], gaps: [] });
  assert.deepEqual(buildSignals({ matrix, gaps: [], docs: [], settings, now }), []);
});

test("planInventoryAdjust: дельты только по изменившимся, ошибки до записи", () => {
  const current = [{ id: 11, qty: 10 }, { id: 12, qty: 5 }];
  assert.deepEqual(planInventoryAdjust(current, [{ ff_inventory_id: 12, qty_fact: 4 }, { ff_inventory_id: 11, qty_fact: 10 }]),
    { ok: true, moves: [{ id: 12, delta: -1 }] });
  assert.equal(planInventoryAdjust(current, [{ ff_inventory_id: 99, qty_fact: 1 }]).ok, false);
  assert.equal(planInventoryAdjust(current, [{ ff_inventory_id: 11, qty_fact: -1 }]).ok, false);
  assert.equal(planInventoryAdjust(current, [{ ff_inventory_id: 11, qty_fact: 1.5 }]).ok, false);
  assert.equal(planInventoryAdjust(current, [{ ff_inventory_id: 11, qty_fact: 1 }, { ff_inventory_id: 11, qty_fact: 2 }]).ok, false);
  assert.deepEqual(planInventoryAdjust(current, []), { ok: false, error: "нет строк" });
});
