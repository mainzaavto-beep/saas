// lib/__tests__/shipmentDocs.test.mjs — чистая часть документа отгрузки v2
// (спека «Склады 2.0» §4.2–4.3, этап 3 задача 5).
import test from "node:test";
import assert from "node:assert/strict";
import { deriveStatus, matchSupply, supplyFlags } from "../shipmentDocs.js";

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
  // WB: закрыта = есть date_close; отклонена = в статусе «отклон»/«отмен» (ё→е, регистр не важен)
  assert.deepEqual(supplyFlags({ kind: "wb_income", date_close: "2026-09-03", status: "Принято" }), { kind: "wb_income", closed: true, rejected: false });
  assert.deepEqual(supplyFlags({ kind: "wb_income", date_close: null, status: "В пути" }), { kind: "wb_income", closed: false, rejected: false });
  assert.deepEqual(supplyFlags({ kind: "wb_income", date_close: "2026-09-03", status: "Отклонено" }), { kind: "wb_income", closed: false, rejected: true });
  assert.deepEqual(supplyFlags({ kind: "wb_income", date_close: null, status: "Отменена продавцом" }), { kind: "wb_income", closed: false, rejected: true });
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
