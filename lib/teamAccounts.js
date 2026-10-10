// lib/teamAccounts.js — сотрудники, которых владелец создаёт сам (2026-10-10).
// Владелец задаёт имя, логин и пароль и передаёт их сотруднику; приглашение по
// ссылке остаётся вторым путём. Логин — строка вида «что-то@что-то» (вход в панель
// по email, см. lib/auth.js); настоящая почта не обязательна (wb@sysell подходит),
// поэтому аккаунт сразу считается подтверждённым.
// Чистые функции, БД не трогают.

const ROLES = ["manager", "viewer"];
export const MIN_PASSWORD = 8;

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    return `Пароль минимум ${MIN_PASSWORD} символов`;
  }
  return null;
}

export function validateNewMember({ name, login, password, role } = {}) {
  const n = String(name || "").trim();
  const l = String(login || "").trim().toLowerCase();
  const r = role || "manager";
  if (!n) return { ok: false, error: "Укажите имя сотрудника" };
  if (!/^[^\s@]+@[^\s@]+$/.test(l)) return { ok: false, error: "Логин в виде имя@что-то, без пробелов (например wb@sysell)" };
  const pe = validatePassword(password);
  if (pe) return { ok: false, error: pe };
  if (!ROLES.includes(r)) return { ok: false, error: "Роль может быть «Менеджер» или «Наблюдатель»" };
  return { ok: true, value: { name: n, login: l, password, role: r } };
}

// Пароль сотруднику владелец меняет, только если аккаунт состоит лишь в его
// кабинете и не владелец там. Иначе владелец любого кабинета мог бы пригласить
// чужого пользователя, сменить ему пароль и войти в чужие кабинеты.
export function canOwnerSetPassword({ cabinetId, memberships }) {
  return memberships.length === 1
    && Number(memberships[0].cabinet_id) === Number(cabinetId)
    && memberships[0].role !== "owner";
}
