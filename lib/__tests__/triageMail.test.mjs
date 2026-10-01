// lib/__tests__/triageMail.test.mjs — письмо авторазбора падений
// (спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §6).
import test from "node:test";
import assert from "node:assert/strict";
import { formatTriageMail } from "../triageMail.js";

const BASE = "https://sysell.ru";
const done = {
  id: 12, collector: "ozon_finance", cabinet_id: 1, status: "done",
  opened_at: "2026-09-08T09:00:00Z",
  report_json: {
    summary: "Ozon отключил /v3/finance/transaction/list (404).", cause: "mp_method_changed",
    confidence: "high", evidence: ["лог: 404"], proposed_fix: "перейти на /v4",
    data_impact: "каб. 1 и 1008 без транзакций с 08.09", urgent: false,
  },
};

test("тема разобранного эпизода: сборщик, кабинет, причина, уверенность", () => {
  const m = formatTriageMail(done, BASE);
  assert.equal(m.subject, "[разбор] ozon_finance · каб. 1 — mp_method_changed (high)");
  assert.match(m.text, /отключил/);
  assert.match(m.text, /перейти на \/v4/);
  assert.match(m.text, /без транзакций с 08\.09/);
  assert.match(m.text, /https:\/\/sysell\.ru\/health#triage-12/);
});

test("срочный — префикс 🔴", () => {
  const m = formatTriageMail({ ...done, report_json: { ...done.report_json, urgent: true } }, BASE);
  assert.ok(m.subject.startsWith("🔴 [разбор]"));
});

test("юнит без кабинета — «сервер»", () => {
  const m = formatTriageMail({ ...done, collector: "unit:saas-stocks.service", cabinet_id: null }, BASE);
  assert.match(m.subject, /unit:saas-stocks\.service · сервер/);
});

test("разбор не удался — своя тема и последняя ошибка прогона", () => {
  const m = formatTriageMail({ id: 5, collector: "wb_finance", cabinet_id: 1, status: "error",
    opened_at: "2026-09-24T00:00:00Z", report_json: null, last_error: "HTTP 404 boom",
    raw_output: "таймаут 1200 с\n..." }, BASE);
  assert.equal(m.subject, "[разбор не удался] wb_finance · каб. 1");
  assert.match(m.text, /HTTP 404 boom/);
  assert.match(m.text, /таймаут 1200 с/);
});

test("починившийся после разбора — пометка в теме", () => {
  const m = formatTriageMail({ ...done, status: "closed", closed_at: "2026-10-01T10:00:00Z" }, BASE);
  assert.match(m.subject, /уже починилось/);
});
