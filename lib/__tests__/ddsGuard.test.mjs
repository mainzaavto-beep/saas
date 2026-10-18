// lib/__tests__/ddsGuard.test.mjs — гарды ДДС (17.10.2026, спека docs/superpowers/specs/2026-10-17-dds-design.md §3, §7).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { editRules } from "../dds.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");
function walk(dir, out = []) {
  for (const n of readdirSync(join(ROOT, dir))) {
    if (n === "node_modules" || n === ".next" || n === "__tests__") continue;
    const p = join(dir, n);
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else if (/\.(m?js|jsx)$/.test(n)) out.push(p);
  }
  return out;
}
const SRC = [...walk("app"), ...walk("lib"), ...walk("scripts")];

test("запись в dds_movements — только lib/paymentCalendarData.js", () => {
  // разовый бэкфилл платежей партий (15.10.2026), уже выполнен
  const ALLOWED = new Set(["lib/paymentCalendarData.js", "scripts/backfill-purchase-payments.mjs"]);
  const re = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+tenant\.dds_movements/i;
  const bad = SRC.filter((p) => !ALLOWED.has(p) && re.test(read(p)));
  assert.deepEqual(bad, []);
});

test("postToDds удалён", () => {
  assert.deepEqual(SRC.filter((p) => /postToDds/.test(read(p))), []);
});

test("матрица правил правки §3", () => {
  const cell = (k, t) => { const r = editRules({ source_kind: k, type: t }); return [r.amount, r.article, r.date, r.account, r.comment, r.del]; };
  assert.deepEqual(cell("manual", "expense"), [true, true, true, true, true, true]);
  assert.deepEqual(cell("recurring", "expense"), [true, true, true, true, true, true]);
  assert.deepEqual(cell("purchase", "expense"), [false, false, true, true, true, false]);
  assert.deepEqual(cell("mp_payout", "income"), [false, false, true, true, true, false]);
  assert.deepEqual(cell("manual", "transfer"), [true, false, true, true, true, true]);
});

test("слой записи применяет editRules и validateDdsMovement", () => {
  const src = read("lib/paymentCalendarData.js");
  assert.match(src, /editRules\(/);
  assert.match(src, /validateDdsMovement\(/);
  assert.doesNotMatch(src, /catch\s*(\(\w*\))?\s*\{\s*\}/);
});

test("fix round 1: updateMovement фолбэчит на category, unmarkPaid не снимает перевод", () => {
  const src = read("lib/paymentCalendarData.js");
  assert.match(src, /articleKeyOf\(b\.category,\s*cur\.type\)/);
  const unmark = src.slice(src.indexOf("export async function unmarkPaid"), src.indexOf("export async function archiveMovement"));
  assert.match(unmark, /type/);
  assert.match(unmark, /transfer/);
});

test("роуты ДДС: срез по роли и без инлайн-записи", () => {
  const dds = read("app/api/cabinets/[id]/dds/route.js");
  assert.match(dds, /redactReport\(/);
  assert.match(dds, /isOwner/);
  const refs = read("app/api/cabinets/[id]/dds-refs/route.js");
  assert.match(refs, /redactAccounts\(/);
  for (const a of ["account_save", "account_archive", "settings_save"]) assert.match(refs, new RegExp(a));
  assert.match(refs, /role\s*!==\s*["']owner["']/);
});

test("D3: нет fetch(\"…${\") на страницах ДДС/календаря", () => {
  for (const p of SRC.filter((x) => /app\/cabinets\/\[id\]\/fin-(dds|calendar|income)\//.test(x))) {
    assert.doesNotMatch(read(p), /fetch\("[^"]*\$\{/, p);
  }
});

test("финальное ревью 17.10.2026: updateMovement не пишет сырой NULL в article_key, other/other_in не скрыть", () => {
  const paymentCalendarData = read("lib/paymentCalendarData.js");
  assert.match(paymentCalendarData, /articleKeyOf\(null,\s*cur\.type\)/);
  const ddsData = read("lib/ddsData.js");
  assert.match(ddsData, /archiveArticle/);
  const archiveArticleSrc = ddsData.slice(ddsData.indexOf("export async function archiveArticle"), ddsData.indexOf("const KINDS"));
  assert.match(archiveArticleSrc, /["']other["']/);
  assert.match(archiveArticleSrc, /["']other_in["']/);
});

test("партии «Архив до 16.10» не пересоздают платежи (решение владельца 18.10.2026)", () => {
  assert.match(read("lib/paymentCalendarData.js"), /if \(p\?\.legacy_at\) return/);
});
