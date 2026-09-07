// lib/__tests__/shipmentDocs.test.mjs — чистая часть документа отгрузки v2
// (спека «Склады 2.0» §4.2–4.3, этап 3 задача 5).
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveStatus, matchSupply, supplyFlags, effectiveStatus,
  createShipmentDoc, shipDoc, acceptDoc, WB_INCOME_REJECTED_STATUS_IDS,
} from "../shipmentDocs.js";

const L = (qty, acc) => ({ qty, qty_accepted: acc ?? null });

test("draft остаётся draft — даже если поставка уже закрыта", () => {
  assert.equal(deriveStatus({ status: "draft", lines: [L(10)], supply: null }), "draft");
  assert.equal(
    deriveStatus({ status: "draft", lines: [L(10, 10)], supply: { kind: "wb_income", closed: true, rejected: false } }),
    "draft"
  );
});

test("shipped без связи с поставкой остаётся shipped", () => {
  assert.equal(deriveStatus({ status: "shipped", lines: [L(10), L(5)], supply: null }), "shipped");
  // связь есть, но приёмка ещё не закрыта — тоже shipped
  assert.equal(
    deriveStatus({ status: "shipped", lines: [L(10)], supply: { kind: "ozon_supply_order", closed: false, rejected: false } }),
    "shipped"
  );
});

test("приёмка закрыта, количество не введено → accepted («расхождение не проверено»)", () => {
  assert.equal(
    deriveStatus({ status: "shipped", lines: [L(10), L(5)], supply: { kind: "wb_income", closed: true, rejected: false } }),
    "accepted"
  );
});

test("принято меньше отгруженного → partial", () => {
  assert.equal(
    deriveStatus({ status: "shipped", lines: [L(10, 10), L(5, 3)], supply: { kind: "wb_income", closed: true, rejected: false } }),
    "partial"
  );
  // без связи, но количество введено руками — тоже считается приёмкой
  assert.equal(deriveStatus({ status: "shipped", lines: [L(10, 9)], supply: null }), "partial");
});

test("принято столько же (или больше) → accepted", () => {
  assert.equal(
    deriveStatus({ status: "shipped", lines: [L(10, 10), L(5, 5)], supply: { kind: "wb_income", closed: true, rejected: false } }),
    "accepted"
  );
  assert.equal(deriveStatus({ status: "shipped", lines: [L(10, 12)], supply: null }), "accepted");
  // частично введённые количества приёмкой не считаются
  assert.equal(
    deriveStatus({ status: "shipped", lines: [L(10, 4), L(5)], supply: { kind: "wb_income", closed: false, rejected: false } }),
    "shipped"
  );
});

test("отклонённая поставка → rejected (важнее введённых количеств)", () => {
  assert.equal(
    deriveStatus({ status: "shipped", lines: [L(10)], supply: { kind: "wb_income", closed: false, rejected: true } }),
    "rejected"
  );
  assert.equal(
    deriveStatus({ status: "shipped", lines: [L(10, 10)], supply: { kind: "ozon_supply_order", closed: true, rejected: true } }),
    "rejected"
  );
});

test("supplyFlags: правило closed/rejected для WB и Ozon", () => {
  // WB отдаёт status = код (statusID), текстовых статусов больше нет: наблюдаются 1/3/5,
  // 5 — терминальный «принято». Закрыта = есть date_close; отклонена = код из набора
  // WB_INCOME_REJECTED_STATUS_IDS (сейчас пуст — кодов отклонения в живых данных не видели).
  assert.deepEqual(supplyFlags({ kind: "wb_income", date_close: "2026-08-26", status: "5" }), { kind: "wb_income", closed: true, rejected: false });
  assert.deepEqual(supplyFlags({ kind: "wb_income", date_close: null, status: "3" }), { kind: "wb_income", closed: false, rejected: false });
  assert.equal(WB_INCOME_REJECTED_STATUS_IDS.size, 0);   // пустой набор = никого не отклоняем
  try {   // код, добавленный в набор по факту, начинает означать «отклонена»
    WB_INCOME_REJECTED_STATUS_IDS.add("9");
    assert.deepEqual(supplyFlags({ kind: "wb_income", date_close: "2026-08-26", status: 9 }), { kind: "wb_income", closed: true, rejected: true });
  } finally { WB_INCOME_REJECTED_STATUS_IDS.delete("9"); }
  // Ozon: закрыта = COMPLETED; отклонена = CANCEL*/REJECT*; прочее (OVERDUE, DATA_FILLING) — ни то, ни другое
  assert.deepEqual(supplyFlags({ kind: "ozon_supply_order", state: "COMPLETED" }), { kind: "ozon_supply_order", closed: true, rejected: false });
  assert.deepEqual(supplyFlags({ kind: "ozon_supply_order", state: "CANCELLED" }), { kind: "ozon_supply_order", closed: false, rejected: true });
  assert.deepEqual(supplyFlags({ kind: "ozon_supply_order", state: "ORDER_REJECTED" }), { kind: "ozon_supply_order", closed: false, rejected: true });
  assert.deepEqual(supplyFlags({ kind: "ozon_supply_order", state: "OVERDUE" }), { kind: "ozon_supply_order", closed: false, rejected: false });
  assert.equal(supplyFlags(null), null);
});

test("matchSupply: ранжирование по складу (+2), дате ±3 дн (+1) и количеству ±10 % (+1)", () => {
  const doc = {
    shipped_at: "2026-09-01",
    dest_warehouse_id: 507,
    dest_warehouse: "Коледино",
    lines: [{ qty: 60 }, { qty: 40 }],  // Σ = 100
  };
  const candidates = [
    { id: "1", kind: "wb_income", date: "2026-09-02", warehouseKey: 507, warehouseName: "Коледино", qty: 98 },
    { id: "2", kind: "wb_income", date: "2026-09-10", warehouseKey: 507, warehouseName: "Коледино", qty: 20 },
    { id: "3", kind: "wb_income", date: "2026-09-01", warehouseKey: 999, warehouseName: "Казань", qty: 100 },
    { id: "4", kind: "wb_income", date: "2026-08-01", warehouseKey: 111, warehouseName: "Электросталь", qty: 5 },
  ];
  const ranked = matchSupply(doc, candidates);
  assert.deepEqual(ranked.map((c) => c.id), ["1", "3", "2", "4"]);  // 4; 2 (дата ближе); 2; 0
  assert.deepEqual(ranked.map((c) => c.score), [4, 2, 2, 0]);
  assert.equal(ranked[0].qty, 98);            // поля кандидата сохраняются
  assert.equal(candidates[0].score, undefined); // исходные объекты не мутируются
});

test("matchSupply: склад совпадает по имени (регистр/ё/подчёркивания) при отсутствии id", () => {
  const doc = { shipped_at: "2026-09-01", dest_warehouse: "казань_рфц новый", lines: [{ qty: 10 }] };
  const ranked = matchSupply(doc, [
    { id: "a", warehouseKey: 42, warehouseName: "КАЗАНЬ_РФЦ_НОВЫЙ", date: "2026-09-20", qty: 999 },
    { id: "b", warehouseKey: 43, warehouseName: "САРАТОВ_РФЦ", date: "2026-09-20", qty: 999 },
  ]);
  assert.deepEqual(ranked.map((c) => [c.id, c.score]), [["a", 2], ["b", 0]]);
  assert.deepEqual(matchSupply(doc, []), []);
});

test("effectiveStatus: витрина показывает статус по факту, а не по записанному", () => {
  // В БД лежит shipped, приёмка WB уже закрылась (date_close) — список обязан показать accepted
  const doc = { status: "shipped" };
  const supply = { kind: "wb_income", date_close: "2026-08-26", status: "5" };
  assert.equal(effectiveStatus(doc, [{ qty: 10 }], supply), "accepted");
  assert.equal(effectiveStatus(doc, [{ qty: 10, qty_accepted: 7 }], supply), "partial");
  assert.equal(effectiveStatus(doc, [{ qty: 10 }], null), "shipped");
  assert.equal(effectiveStatus({ status: "draft" }, [{ qty: 10 }], supply), "draft");
  // готовые флаги тоже принимаются (тот же ответ, что и от «сырой» поставки)
  assert.equal(effectiveStatus(doc, [{ qty: 10 }], { kind: "ozon_supply_order", closed: true, rejected: false }), "accepted");
});

// ── запись: поддельный tq (пишет SQL+параметры, отдаёт заготовленные строки) ──

function fakeTq(handlers) {
  const calls = [];
  const tq = async (sql, params = []) => {
    calls.push({ sql, params });
    for (const [re, rows] of handlers) {
      if (re.test(sql)) return typeof rows === "function" ? rows(sql, params) : rows;
    }
    return [];
  };
  tq.calls = calls;
  tq.sqls = () => calls.map((c) => c.sql);
  return tq;
}
const inserts = (tq) => tq.sqls().filter((s) => /INSERT INTO/i.test(s));

function fakeApplyMove() {
  const calls = [];
  const fn = async (m) => { calls.push(m); return { applied: true }; };
  fn.calls = calls;
  return fn;
}

const CREATE_OK = [
  [/FROM tenant\.ff_inventory/, [{ qty: 100 }]],
  [/INSERT INTO tenant\.ff_shipment_docs/, [{ id: 77 }]],
  [/INSERT INTO tenant\.ff_shipment_lines/, [{ id: 101, ff_inventory_id: 5, qty: 3 }, { id: 102, ff_inventory_id: 6, qty: 4 }]],
];
const CREATE_LINES = [{ ff_inventory_id: 5, qty: 3 }, { ff_inventory_id: 6, qty: 4 }];
const CREATE_ARGS = { platform: "wb", shipDt: "2026-09-07", lines: CREATE_LINES, userId: 42 };

test("create: не хватает остатка → ни одной записи в БД и 400", async () => {
  const tq = fakeTq([
    [/FROM tenant\.ff_inventory/, [{ qty: 1 }]],   // на складе 1 шт, просят 3
    [/INSERT INTO/, () => { throw new Error("не должно быть записи"); }],
  ]);
  const move = fakeApplyMove();
  const res = await createShipmentDoc(tq, { ...CREATE_ARGS, status: "shipped" }, { applyMove: move });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error, /недостаточно остатка/);
  assert.deepEqual(inserts(tq), []);              // предпроверка отработала ДО записи
  assert.equal(move.calls.length, 0);
});

test("create shipped: ровно одно движение out_fbo на строку со ссылкой doc:line", async () => {
  const tq = fakeTq(CREATE_OK);
  const move = fakeApplyMove();
  const res = await createShipmentDoc(tq, { ...CREATE_ARGS, status: "shipped" }, { applyMove: move });
  assert.deepEqual(res, { ok: true, id: 77, status: "shipped" });
  assert.equal(move.calls.length, 2);
  assert.deepEqual(move.calls.map((m) => [m.ffInventoryId, m.kind, m.qty, m.srcKind, m.srcRef, m.movedAt, m.userId]), [
    [5, "out_fbo", 3, "ff_shipment_doc", "77:101", "2026-09-07", 42],
    [6, "out_fbo", 4, "ff_shipment_doc", "77:102", "2026-09-07", 42],
  ]);
  assert.equal(inserts(tq).length, 2);            // документ + строки
});

test("create draft: списания нет, остаток даже не блокируется", async () => {
  const tq = fakeTq(CREATE_OK);
  const move = fakeApplyMove();
  const res = await createShipmentDoc(tq, { ...CREATE_ARGS, status: "draft" }, { applyMove: move });
  assert.deepEqual(res, { ok: true, id: 77, status: "draft" });
  assert.equal(move.calls.length, 0);
  assert.equal(tq.sqls().some((s) => /FOR UPDATE/.test(s)), false);
  assert.equal(inserts(tq).length, 2);
});

test("ship: черновик → отгружен, движения по строкам; повторно — 400 без записи", async () => {
  const docLines = [{ id: 101, ff_inventory_id: 5, qty: 3 }, { id: 102, ff_inventory_id: 6, qty: 4 }];
  const tq = fakeTq([
    [/SELECT id, ship_dt, status FROM tenant\.ff_shipment_docs/, [{ id: 77, ship_dt: "2026-09-07", status: "draft" }]],
    [/FROM tenant\.ff_shipment_lines/, docLines],
    [/FROM tenant\.ff_inventory/, [{ qty: 100 }]],
  ]);
  const move = fakeApplyMove();
  const res = await shipDoc(tq, { id: 77, userId: 42 }, { applyMove: move });
  assert.deepEqual(res, { ok: true, id: 77, status: "shipped" });
  assert.deepEqual(move.calls.map((m) => [m.kind, m.srcRef]), [["out_fbo", "77:101"], ["out_fbo", "77:102"]]);
  assert.equal(tq.sqls().filter((s) => /UPDATE tenant\.ff_shipment_docs/.test(s)).length, 1);

  const tq2 = fakeTq([
    [/SELECT id, ship_dt, status FROM tenant\.ff_shipment_docs/, [{ id: 77, ship_dt: "2026-09-07", status: "shipped" }]],
    [/UPDATE /, () => { throw new Error("не должно быть записи"); }],
  ]);
  const move2 = fakeApplyMove();
  const res2 = await shipDoc(tq2, { id: 77 }, { applyMove: move2 });
  assert.equal(res2.ok, false);
  assert.equal(res2.status, 400);
  assert.match(res2.error, /уже отгружен/);
  assert.equal(move2.calls.length, 0);
});

// ── acceptDoc: приёмка по строкам (фейковый tq, ревью раунд 1, 2026-09-07) ────

test("acceptDoc: qty_accepted > qty → 400 и ноль UPDATE", async () => {
  const tq = fakeTq([
    [/SELECT id, status, mp_supply_id, mp_supply_kind FROM tenant\.ff_shipment_docs/,
      [{ id: 77, status: "shipped", mp_supply_id: null, mp_supply_kind: null }]],
    [/SELECT id, qty FROM tenant\.ff_shipment_lines/, [{ id: 101, qty: 10 }]],
    [/UPDATE /, () => { throw new Error("не должно быть записи"); }],
  ]);
  const res = await acceptDoc(tq, { id: 77, accepted: [{ lineId: 101, qtyAccepted: 15 }] });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error, /принято 15 > отгружено 10/);
  assert.equal(tq.sqls().filter((s) => /UPDATE/i.test(s)).length, 0);
});

test("acceptDoc: черновик → 400 (приёмки без отгрузки не бывает)", async () => {
  const tq = fakeTq([
    [/SELECT id, status, mp_supply_id, mp_supply_kind FROM tenant\.ff_shipment_docs/,
      [{ id: 77, status: "draft", mp_supply_id: null, mp_supply_kind: null }]],
    [/UPDATE /, () => { throw new Error("не должно быть записи"); }],
  ]);
  const res = await acceptDoc(tq, { id: 77, accepted: [{ lineId: 101, qtyAccepted: 5 }] });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error, /черновик/);
  assert.equal(tq.sqls().filter((s) => /UPDATE/i.test(s)).length, 0);
});

test("acceptDoc: валидный ввод → UPDATE по каждой строке + один UPDATE статуса", async () => {
  const tq = fakeTq([
    [/SELECT id, status, mp_supply_id, mp_supply_kind FROM tenant\.ff_shipment_docs/,
      [{ id: 77, status: "shipped", mp_supply_id: null, mp_supply_kind: null }]],
    [/SELECT id, qty FROM tenant\.ff_shipment_lines/, [{ id: 101, qty: 10 }, { id: 102, qty: 5 }]],
    [/SELECT qty, qty_accepted FROM tenant\.ff_shipment_lines/,
      [{ qty: 10, qty_accepted: 10 }, { qty: 5, qty_accepted: 5 }]],
  ]);
  const res = await acceptDoc(tq, {
    id: 77, accepted: [{ lineId: 101, qtyAccepted: 10 }, { lineId: 102, qtyAccepted: 5 }],
  });
  assert.deepEqual(res, { ok: true, id: 77, status: "accepted" });
  assert.equal(tq.sqls().filter((s) => /UPDATE tenant\.ff_shipment_lines/.test(s)).length, 2);
  assert.equal(tq.sqls().filter((s) => /UPDATE tenant\.ff_shipment_docs/.test(s)).length, 1);
});
