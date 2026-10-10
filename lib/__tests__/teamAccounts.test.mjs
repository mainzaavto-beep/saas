// lib/__tests__/teamAccounts.test.mjs — сотрудники, которых владелец создаёт сам (логин + пароль).
import test from "node:test";
import assert from "node:assert/strict";
import { validateNewMember, validatePassword, canOwnerSetPassword } from "../teamAccounts.js";

test("validateNewMember: нормализует логин, роль по умолчанию — менеджер", () => {
  const r = validateNewMember({ name: " Менеджер ВБ ", login: " WB@Sysell ", password: "secret123" });
  assert.deepEqual(r, { ok: true, value: { name: "Менеджер ВБ", login: "wb@sysell", password: "secret123", role: "manager" } });
});

test("validateNewMember: ошибки ввода", () => {
  assert.equal(validateNewMember({ name: "", login: "wb@sysell", password: "secret123" }).ok, false);
  assert.equal(validateNewMember({ name: "А", login: "wbsysell", password: "secret123" }).ok, false);
  assert.equal(validateNewMember({ name: "А", login: "wb @sysell", password: "secret123" }).ok, false);
  assert.equal(validateNewMember({ name: "А", login: "wb@sysell", password: "short" }).ok, false);
  assert.equal(validateNewMember({ name: "А", login: "wb@sysell", password: "secret123", role: "owner" }).ok, false);
  assert.equal(validateNewMember({ name: "А", login: "wb@sysell", password: "secret123", role: "viewer" }).value.role, "viewer");
});

test("validatePassword: минимум 8 символов, строка", () => {
  assert.equal(validatePassword("12345678"), null);
  assert.match(validatePassword("1234567"), /8/);
  assert.match(validatePassword(undefined), /8/);
});

test("canOwnerSetPassword: только сотрудник, состоящий лишь в этом кабинете и не владелец", () => {
  const cab = 1;
  assert.equal(canOwnerSetPassword({ cabinetId: cab, memberships: [{ cabinet_id: 1, role: "manager" }] }), true);
  assert.equal(canOwnerSetPassword({ cabinetId: cab, memberships: [{ cabinet_id: 1, role: "viewer" }] }), true);
  // Состоит ещё где-то — чужой аккаунт, менять пароль нельзя.
  assert.equal(canOwnerSetPassword({ cabinetId: cab, memberships: [{ cabinet_id: 1, role: "manager" }, { cabinet_id: 7, role: "owner" }] }), false);
  assert.equal(canOwnerSetPassword({ cabinetId: cab, memberships: [{ cabinet_id: 1, role: "owner" }] }), false);
  assert.equal(canOwnerSetPassword({ cabinetId: cab, memberships: [] }), false);
  assert.equal(canOwnerSetPassword({ cabinetId: cab, memberships: [{ cabinet_id: 2, role: "manager" }] }), false);
});
