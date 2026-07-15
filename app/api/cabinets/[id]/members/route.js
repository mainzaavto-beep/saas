// /api/cabinets/[id]/members — список сотрудников проекта.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { query } from "@/lib/db.js";

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
  return NextResponse.json({ items: rows });
});

// Смена роли сотрудника.
export const PUT = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  if (!b.user_id || !b.role) return NextResponse.json({ error: "user_id + role required" }, { status: 400 });
  if (!["manager", "viewer"].includes(b.role)) return NextResponse.json({ error: "role must be manager|viewer" }, { status: 400 });
  // Нельзя менять роль owner'а.
  const existing = await query(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [b.user_id, cabinet.cabinet_id]);
  if (!existing.length) return NextResponse.json({ error: "not a member" }, { status: 404 });
  if (existing[0].role === "owner") return NextResponse.json({ error: "cannot change owner role" }, { status: 403 });
  await query(`UPDATE auth.memberships SET role = $1 WHERE user_id = $2 AND cabinet_id = $3`, [b.role, b.user_id, cabinet.cabinet_id]);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });

// Удаление сотрудника.
export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const userId = Number(url.searchParams.get("user_id"));
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  // Нельзя удалить owner'а.
  const existing = await query(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [userId, cabinet.cabinet_id]);
  if (!existing.length) return NextResponse.json({ error: "not a member" }, { status: 404 });
  if (existing[0].role === "owner") return NextResponse.json({ error: "cannot remove owner" }, { status: 403 });
  await query(`DELETE FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [userId, cabinet.cabinet_id]);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
