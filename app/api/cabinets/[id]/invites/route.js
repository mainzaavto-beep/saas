// /api/cabinets/[id]/invites — управление приглашениями.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { getSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 🔒 owner: ответ содержит ТОКЕНЫ висящих приглашений — по ним любой залогиненный
// может вступить в кабинет с ролью из инвайта (см. /api/invite/[token]). Раньше
// список был доступен и viewer'у → наблюдатель мог поднять себе роль до менеджера.
export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await query(
    `SELECT token, role, email, created_by, accepted_by, accepted_at, expires_at, created_at
     FROM auth.invitations WHERE cabinet_id = $1 AND accepted_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC`,
    [cabinet.cabinet_id]
  );
  return NextResponse.json({ items: rows });
}, { requireRole: 'owner' });

export const POST = withCabinet(async (req, { cabinet }) => {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json();
  const role = b.role === "manager" ? "manager" : "viewer";
  const token = crypto.randomUUID();
  await query(
    `INSERT INTO auth.invitations (token, cabinet_id, role, email, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [token, cabinet.cabinet_id, role, b.email || null, session.user_id]
  );
  const inviteUrl = `${process.env.NEXT_PUBLIC_URL || "https://sysell.ru"}/invite/${token}`;
  return NextResponse.json({ ok: true, token, url: inviteUrl, role });
}, { requireRole: 'owner' });

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
  await query(`DELETE FROM auth.invitations WHERE token = $1 AND cabinet_id = $2`, [token, cabinet.cabinet_id]);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
