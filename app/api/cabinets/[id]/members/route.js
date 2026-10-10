// /api/cabinets/[id]/members — список сотрудников проекта.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { query, tenantQuery } from "@/lib/db.js";
import { hashPassword } from "@/lib/auth.js";
import { validateNewMember, validatePassword, canOwnerSetPassword } from "@/lib/teamAccounts.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await query(
    `SELECT u.user_id, u.email, u.name, u.first_name, u.last_name, u.phone,
            m.role, m.created_at AS joined_at
     FROM auth.memberships m
     JOIN auth.users u ON u.user_id = m.user_id
     WHERE m.cabinet_id = $1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.email`,
    [cabinet.cabinet_id]
  );
  // Контакты — только owner/manager; viewer видит состав команды без email/телефонов.
  const canSeeContacts = cabinet.role === 'owner' || cabinet.role === 'manager';
  const items = canSeeContacts ? rows : rows.map(r => ({ ...r, email: null, phone: null }));
  return NextResponse.json({ items });
});

// Смена роли сотрудника.
export const PUT = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  if (!b.user_id || !b.role) return NextResponse.json({ error: "Укажите сотрудника и роль" }, { status: 400 });
  if (!["manager", "viewer"].includes(b.role)) return NextResponse.json({ error: "Роль может быть «Менеджер» или «Наблюдатель»" }, { status: 400 });
  // Нельзя менять роль owner'а.
  const existing = await query(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [b.user_id, cabinet.cabinet_id]);
  if (!existing.length) return NextResponse.json({ error: "Этот пользователь не состоит в проекте" }, { status: 404 });
  if (existing[0].role === "owner") return NextResponse.json({ error: "Роль владельца проекта изменить нельзя" }, { status: 403 });
  await query(`UPDATE auth.memberships SET role = $1 WHERE user_id = $2 AND cabinet_id = $3`, [b.role, b.user_id, cabinet.cabinet_id]);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });

// Удаление сотрудника.
export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const userId = Number(url.searchParams.get("user_id"));
  if (!userId) return NextResponse.json({ error: "Не указан сотрудник" }, { status: 400 });
  // Нельзя удалить owner'а.
  const existing = await query(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [userId, cabinet.cabinet_id]);
  if (!existing.length) return NextResponse.json({ error: "Этот пользователь не состоит в проекте" }, { status: 404 });
  if (existing[0].role === "owner") return NextResponse.json({ error: "Владельца проекта удалить нельзя" }, { status: 403 });
  await query(`DELETE FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [userId, cabinet.cabinet_id]);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });

// Создание сотрудника владельцем: имя + логин + пароль (lib/teamAccounts.js).
// Пользователь и членство пишутся в транзакции withCabinet (tenantQuery — её клиент):
// сбой второй вставки не оставит «висящего» аккаунта. Аккаунт сразу подтверждён —
// логин может быть условным (wb@sysell), письма на него не дойдут.
export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json().catch((e) => { console.error("[members] POST: тело не JSON", e); return {}; });
  const v = validateNewMember(b);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const { name, login, password, role } = v.value;
  const taken = await tenantQuery(`SELECT 1 FROM auth.users WHERE lower(email) = $1`, [login]);
  if (taken.length) return NextResponse.json({ error: "Такой логин уже занят" }, { status: 409 });
  const [u] = await tenantQuery(
    `INSERT INTO auth.users (email, password_hash, name, email_verified_at)
     VALUES ($1, $2, $3, now()) RETURNING user_id`,
    [login, hashPassword(password), name]
  );
  await tenantQuery(
    `INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, $3)`,
    [u.user_id, cabinet.cabinet_id, role]
  );
  return NextResponse.json({ ok: true, user_id: Number(u.user_id) });
}, { requireRole: 'owner' });

// Смена пароля сотруднику владельцем. Только аккаунтам, состоящим лишь в этом
// кабинете (canOwnerSetPassword); все открытые входы сотрудника сбрасываются.
export const PATCH = withCabinet(async (req, { cabinet }) => {
  const b = await req.json().catch((e) => { console.error("[members] PATCH: тело не JSON", e); return {}; });
  const userId = Number(b.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return NextResponse.json({ error: "Не указан сотрудник" }, { status: 400 });
  const pe = validatePassword(b.password);
  if (pe) return NextResponse.json({ error: pe }, { status: 400 });
  const memberships = await tenantQuery(`SELECT cabinet_id, role FROM auth.memberships WHERE user_id = $1`, [userId]);
  if (!memberships.some((m) => Number(m.cabinet_id) === Number(cabinet.cabinet_id)))
    return NextResponse.json({ error: "Этот пользователь не состоит в проекте" }, { status: 404 });
  if (!canOwnerSetPassword({ cabinetId: cabinet.cabinet_id, memberships }))
    return NextResponse.json({ error: "Пароль этого пользователя менять нельзя: аккаунт состоит и в других проектах. Пусть сменит сам в профиле." }, { status: 403 });
  await tenantQuery(
    `UPDATE auth.users SET password_hash = $1, session_version = session_version + 1, updated_at = now() WHERE user_id = $2`,
    [hashPassword(b.password), userId]
  );
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
