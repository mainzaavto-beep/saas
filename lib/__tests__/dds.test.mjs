// lib/__tests__/dds.test.mjs — ядро ДДС (17.10.2026, спека docs/superpowers/specs/2026-10-17-dds-design.md).
import test from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_ARTICLES, NO_ACCOUNT, articleKeyOf, editRules, validateDdsMovement, readDdsSettings, defaultAccountFor,
  balancesAt, periodColumns, buildReport, journalTotals, redactAccounts, redactReport,
} from "../dds.js";

const ACC = [
  { id: 1, name: "ВТБ (ИП)", kind: "bank_ip", opening_balance: 1000, opening_date: "2026-07-01", is_archived: false },
  { id: 2, name: "ВБ (ИП)", kind: "mp_wb", opening_balance: 0, opening_date: "2026-07-01", is_archived: false },
  { id: 3, name: "Старый", kind: "other", opening_balance: 0, opening_date: "2026-07-01", is_archived: true },
];
const ART = SYSTEM_ARTICLES.map((a) => ({ ...a, is_archived: false }));
const mv = (o) => ({ status: "paid", account_to_id: null, article_key: null, ...o });

test("SYSTEM_ARTICLES: уникальные ключи, 19 статей, ключи календаря на месте", () => {
  const keys = SYSTEM_ARTICLES.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 19);
  for (const k of ["supplier", "cargo", "ff", "tax", "salary", "rent", "subs", "ads", "mp", "other"]) assert.ok(keys.includes(k), k);
  assert.equal(SYSTEM_ARTICLES.find((a) => a.key === "mp").direction, "income");
  assert.equal(SYSTEM_ARTICLES.find((a) => a.key === "equipment").activity, "investing");
  assert.equal(SYSTEM_ARTICLES.find((a) => a.key === "owner_out").activity, "financing");
});

test("articleKeyOf: старые категории и выплаты (= правило миграции 072)", () => {
  assert.equal(articleKeyOf("Закупка", "expense"), "supplier");
  assert.equal(articleKeyOf("Поставщик", "expense"), "supplier");
  assert.equal(articleKeyOf("ЗП", "expense"), "salary");
  assert.equal(articleKeyOf("Налоги", "expense"), "tax");
  assert.equal(articleKeyOf("Возврат МП", "expense"), "other");
  assert.equal(articleKeyOf("Возврат МП", "income"), "mp");
  assert.equal(articleKeyOf("Прочее", "income"), "other_in");
  assert.equal(articleKeyOf(null, "expense"), "other");
  assert.equal(articleKeyOf("Выплата МП", "income", "wb", "mp_payout"), "mp_wb");
  assert.equal(articleKeyOf("Выплата МП", "income", "ozon", "mp_payout"), "mp_ozon");
});

test("editRules: матрица §3", () => {
  const m = editRules({ source_kind: "manual", type: "expense" });
  assert.deepEqual([m.amount, m.article, m.counterparty, m.date, m.account, m.comment, m.del], [true, true, true, true, true, true, true]);
  const r = editRules({ source_kind: "recurring", type: "expense" });
  assert.equal(r.amount && r.article && r.del, true);
  for (const k of ["purchase", "mp_payout"]) {
    const x = editRules({ source_kind: k, type: k === "purchase" ? "expense" : "income" });
    assert.deepEqual([x.amount, x.article, x.counterparty, x.date, x.account, x.comment, x.del], [false, false, false, true, true, true, false], k);
    assert.ok(x.why);
  }
  const t = editRules({ source_kind: "manual", type: "transfer" });
  assert.deepEqual([t.amount, t.article, t.date, t.account, t.del], [true, false, true, true, true]);
});

test("validateDdsMovement: поступление/списание/перевод", () => {
  const refs = { articles: ART, accounts: ACC };
  assert.equal(validateDdsMovement({ date: "2026-10-01", type: "expense", amount: 10, article_key: "rent", account_id: 1 }, refs), null);
  assert.match(validateDdsMovement({ date: "2026-10-01", type: "expense", amount: 10, article_key: "mp_wb" }, refs), /поступлений/);
  assert.match(validateDdsMovement({ date: "2026-10-01", type: "expense", amount: 0 }, refs), /больше 0/);
  assert.match(validateDdsMovement({ date: "1.10.2026", type: "expense", amount: 1 }, refs), /дата/);
  assert.match(validateDdsMovement({ date: "2026-10-01", type: "expense", amount: 1, account_id: 3 }, refs), /архив/);
  assert.equal(validateDdsMovement({ date: "2026-10-01", type: "expense", amount: 1, account_id: 3 }, refs, { allowArchived: [3] }), null);
  assert.match(validateDdsMovement({ date: "2026-10-01", type: "expense", amount: 1, account_id: 99 }, refs), /не найден/);
  assert.match(validateDdsMovement({ date: "2026-10-01", type: "expense", amount: 1, article_key: "nope" }, refs), /не найдена/);
  assert.match(validateDdsMovement({ date: "2026-10-01", type: "expense", amount: 1, account_to_id: 2 }, refs), /только у перевода/);
  assert.equal(validateDdsMovement({ date: "2026-10-01", type: "transfer", amount: 5, account_id: 2, account_to_id: 1 }, refs), null);
  assert.match(validateDdsMovement({ date: "2026-10-01", type: "transfer", amount: 5, account_id: 2 }, refs), /оба счёта/);
  assert.match(validateDdsMovement({ date: "2026-10-01", type: "transfer", amount: 5, account_id: 1, account_to_id: 1 }, refs), /совпадают/);
});

test("readDdsSettings / defaultAccountFor", () => {
  const s = readDdsSettings({ dds: { default_account_id: 1, payout_account: { wb: 2 } } });
  assert.deepEqual(s, { default_account_id: 1, payout_account: { wb: 2, ozon: null } });
  assert.equal(defaultAccountFor(s, { platform: "wb" }), 2);
  assert.equal(defaultAccountFor(s, { platform: "ozon" }), 1);
  assert.equal(defaultAccountFor(s, {}), 1);
  assert.deepEqual(readDdsSettings(null), { default_account_id: null, payout_account: { wb: null, ozon: null } });
  assert.equal(defaultAccountFor(readDdsSettings({ dds: { default_account_id: "x" } }), {}), null);
});

test("balancesAt: старт, переводы, до opening_date не считается, без счёта отдельно, planned не считается", () => {
  const ms = [
    mv({ date: "2026-06-20", type: "expense", amount: 500, account_id: 1 }),      // до старта счёта — не в остаток
    mv({ date: "2026-07-02", type: "income", amount: 300, account_id: 2 }),
    mv({ date: "2026-07-03", type: "transfer", amount: 200, account_id: 2, account_to_id: 1 }),
    mv({ date: "2026-07-04", type: "expense", amount: 50, account_id: null }),
    mv({ date: "2026-07-05", type: "expense", amount: 999, account_id: 1, status: "planned" }),
    mv({ date: "2026-07-10", type: "expense", amount: 100, account_id: 1 }),
  ];
  const b = balancesAt(ACC, ms, "2026-07-10"); // на начало 10.07 — операция 10.07 ещё не входит
  assert.equal(b.get(1), 1200);
  assert.equal(b.get(2), 100);
  assert.equal(b.get(NO_ACCOUNT), -50);
  assert.equal(balancesAt(ACC, ms, "2026-07-11").get(1), 1100);
  assert.equal(balancesAt(ACC, ms, "2026-06-30").get(1), 0); // счёт ещё не начался
  assert.equal(balancesAt(ACC, ms, "2026-07-01").get(1), 1000);
});

test("periodColumns: месяцы и недели, обрезка, partial", () => {
  const m = periodColumns("2026-08-15", "2026-10-17", "month", "2026-10-17");
  assert.deepEqual(m.map((c) => [c.key, c.from, c.to, c.partial]), [
    ["2026-08", "2026-08-15", "2026-08-31", false],
    ["2026-09", "2026-09-01", "2026-09-30", false],
    ["2026-10", "2026-10-01", "2026-10-17", true],
  ]);
  const w = periodColumns("2026-10-01", "2026-10-14", "week", "2026-10-30");
  assert.deepEqual(w.map((c) => [c.key, c.from, c.to]), [
    ["2026-09-28", "2026-10-01", "2026-10-04"],
    ["2026-10-05", "2026-10-05", "2026-10-11"],
    ["2026-10-12", "2026-10-12", "2026-10-14"],
  ]);
});

test("buildReport: группы, итоги, переводы вне статей, пустые скрыты, отрицательная выплата, остатки", () => {
  const ms = [
    mv({ date: "2026-08-05", type: "income", amount: 1000, account_id: 2, article_key: "mp_wb" }),
    mv({ date: "2026-08-20", type: "income", amount: -40, account_id: 2, article_key: "mp_ozon" }),
    mv({ date: "2026-08-10", type: "expense", amount: 300, account_id: 1, article_key: "supplier" }),
    mv({ date: "2026-09-10", type: "expense", amount: 200, account_id: 1, article_key: "owner_out" }),
    mv({ date: "2026-09-11", type: "transfer", amount: 500, account_id: 2, account_to_id: 1 }),
    mv({ date: "2026-09-12", type: "expense", amount: 70, account_id: 1, article_key: "rent", status: "planned" }),
  ];
  const r = buildReport({ articles: ART, accounts: ACC, movements: ms, from: "2026-08-01", to: "2026-09-30", grain: "month", today: "2026-10-17" });
  assert.deepEqual(r.columns.map((c) => c.key), ["2026-08", "2026-09"]);
  const op = r.groups.find((g) => g.activity === "operating");
  assert.deepEqual(op.income.map((x) => [x.key, x.cells, x.total]), [["mp_wb", [1000, 0], 1000], ["mp_ozon", [-40, 0], -40]]);
  assert.deepEqual(op.expense.map((x) => [x.key, x.cells]), [["supplier", [300, 0]]]); // rent — planned → скрыта
  assert.deepEqual(op.net, [660, 0]);
  assert.equal(r.groups.find((g) => g.activity === "investing"), undefined); // пустая группа не выводится
  const fin = r.groups.find((g) => g.activity === "financing");
  assert.deepEqual(fin.net, [0, -200]);
  assert.deepEqual(r.netFlow, [660, -200]);
  assert.deepEqual(r.netFlowTotal, 460);
  assert.deepEqual(r.opening, [1000, 1660]);   // 1000 (ВТБ) + 0 (ВБ) + 0 (архивный) на 01.08
  assert.deepEqual(r.closing, [1660, 1460]);
  assert.deepEqual(r.adjust, [0, 0]);          // начало + поток = конец
  assert.equal(r.closing[0], r.opening[1]);    // конец N = начало N+1
  const vtb = r.byAccount.find((a) => a.id === 1);
  assert.deepEqual(vtb.closing, [700, 1000]);  // 1000 − 300 ; 700 − 200 + 500
});

test("buildReport: старт счёта внутри колонки → «изменение вне статей»", () => {
  const acc = [{ id: 5, name: "Новый", kind: "cash", opening_balance: 250, opening_date: "2026-09-15", is_archived: false }];
  const r = buildReport({ articles: ART, accounts: acc, movements: [], from: "2026-09-01", to: "2026-09-30", grain: "month", today: "2026-10-17" });
  assert.deepEqual([r.opening[0], r.closing[0], r.netFlow[0], r.adjust[0]], [0, 250, 0, 250]);
});

test("journalTotals: переводы не входят, отрицательное поступление уменьшает", () => {
  assert.deepEqual(journalTotals([
    { type: "income", amount: 100 }, { type: "income", amount: -10 }, { type: "expense", amount: 30 }, { type: "transfer", amount: 999 },
  ]), { income: 90, expense: 30, net: 60 });
});

test("redact: не-владелец не видит остатков и стартов", () => {
  const pub = redactAccounts(ACC, false);
  assert.deepEqual(Object.keys(pub[0]).sort(), ["id", "is_archived", "kind", "name"]);
  assert.equal(redactAccounts(ACC, true)[0].opening_balance, 1000);
  const r = buildReport({ articles: ART, accounts: ACC, movements: [], from: "2026-08-01", to: "2026-08-31", grain: "month", today: "2026-10-17" });
  const x = redactReport(r, false);
  for (const k of ["opening", "closing", "adjust", "byAccount", "openingTotal", "closingTotal"]) assert.equal(x[k], undefined, k);
  assert.ok(Array.isArray(x.netFlow));
  assert.ok(Array.isArray(redactReport(r, true).opening));
});
