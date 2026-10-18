// lib/__tests__/cabinetNav.test.mjs — навигация кабинета (спека 2026-10-18-nav-sections):
// раздел сверху → пункт слева → вкладки над страницей; гард «каждая страница учтена».
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NAV, ALIASES, OUTSIDE, navForRole, resolveNav, firstHref, allHrefs } from "../cabinetNav.js";

const PAGES = new URL("../../app/cabinets/[id]/", import.meta.url).pathname;

test("каждая страница кабинета — в меню, в алиасах или вне разделов", () => {
  const known = new Set([...allHrefs(NAV), ...Object.keys(ALIASES), ...OUTSIDE]);
  const missing = readdirSync(PAGES)
    .filter((n) => statSync(join(PAGES, n)).isDirectory() && existsSync(join(PAGES, n, "page.js")))
    .map((n) => "/" + n)
    .filter((h) => !known.has(h));
  assert.deepEqual(missing, []);
});

test("href в меню уникальны и указывают на существующие страницы", () => {
  const hrefs = allHrefs(NAV);
  assert.equal(new Set(hrefs).size, hrefs.length);
  for (const h of hrefs) {
    const page = h === "" ? join(PAGES, "page.js") : join(PAGES, h.slice(1), "page.js");
    assert.ok(existsSync(page), `нет страницы ${h}`);
  }
  for (const [from, to] of Object.entries(ALIASES)) assert.ok(hrefs.includes(to), `алиас ${from} → ${to}`);
});

test("resolveNav: пункт, вкладка, корень, алиас, вне разделов", () => {
  assert.deepEqual(resolveNav("", NAV), { sectionKey: "analytics", itemKey: "home", tabHref: null });
  assert.deepEqual(resolveNav("/kpi", NAV), { sectionKey: "analytics", itemKey: "kpi", tabHref: null });
  assert.deepEqual(resolveNav("/timing", NAV), { sectionKey: "analytics", itemKey: "orders", tabHref: "/timing" });
  assert.deepEqual(resolveNav("/fin-calendar", NAV), { sectionKey: "finance", itemKey: "money", tabHref: "/fin-calendar" });
  assert.deepEqual(resolveNav("/detail", NAV), { sectionKey: "analytics", itemKey: "summary", tabHref: null });
  assert.deepEqual(resolveNav("/ff-stock", NAV), { sectionKey: "goods", itemKey: "stock", tabHref: "/inventory" });
  assert.deepEqual(resolveNav("/settings", NAV), { sectionKey: null, itemKey: null, tabHref: null });
  // префикс не путает соседние страницы: /orders ≠ /order-matrix
  assert.equal(resolveNav("/order-matrix", NAV).tabHref, "/order-matrix");
  assert.equal(resolveNav("/orders/123", NAV).tabHref, "/orders");
});

test("firstHref: раздел ведёт на первый пункт, пункт с вкладками — на первую вкладку", () => {
  const fin = NAV.find((s) => s.key === "finance");
  assert.equal(firstHref(fin), "/pnl");
  assert.equal(firstHref(fin.items.find((i) => i.key === "money")), "/fin-dds");
});

test("роли: viewer не видит Баланс и Премию, manager видит Премию, owner — всё", () => {
  const fin = (role) => navForRole(NAV, role).find((s) => s.key === "finance").items.map((i) => i.key);
  assert.ok(!fin("viewer").includes("balance") && !fin("viewer").includes("bonus"));
  assert.ok(fin("manager").includes("bonus") && !fin("manager").includes("balance"));
  assert.ok(fin("owner").includes("balance") && fin("owner").includes("bonus"));
});
